import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectTrackedFolder,
  type WorkspaceFolderState,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  suggestedTrackedFolders,
  trackedFolderDisplayPath,
  trackedFolderFromPath,
} from "./trackedFolders.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const NO_TRACKED_FOLDERS: ReadonlyArray<ProjectTrackedFolder> = [];

const FOLDER_STATE_LABELS: Record<WorkspaceFolderState, string> = {
  git: "Git repository",
  plain: "Folder",
  missing: "Missing",
};

/** Tracked folder paths belong to one checkout's machine, so each checkout has its own list. */
export function ProjectRepositoriesSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  if (members.length === 0) return null;
  return (
    <SettingsSection id="project-repositories" title="Repositories">
      {members.map((member) => (
        <CheckoutRepositories
          key={member.physicalProjectKey}
          member={member}
          showEnvironment={members.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function CheckoutRepositories({
  member,
  showEnvironment,
}: {
  member: SidebarProjectGroupMember;
  showEnvironment: boolean;
}) {
  const environmentId = member.environmentId;
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const isConnected = environment?.connection.phase === "connected";
  const tracked = member.trackedFolders ?? NO_TRACKED_FOLDERS;
  // Read from disk: the project's own copy of the list can be a moment behind a clone.
  const listQuery = useEnvironmentQuery(
    isConnected
      ? filesystemEnvironment.listFolders({ environmentId, input: { projectId: member.id } })
      : null,
  );
  const folders: ReadonlyArray<ProjectTrackedFolder & { state?: WorkspaceFolderState }> =
    listQuery.data?.folders ?? tracked;
  // Only a workspace file's folders are offered: the rest is found without asking.
  const scanQuery = useEnvironmentQuery(
    isConnected
      ? filesystemEnvironment.scanFolders({
          environmentId,
          input: { workspaceRoot: member.workspaceRoot },
        })
      : null,
  );
  const suggested = suggestedTrackedFolders(folders, scanQuery.data?.folders ?? []);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [isSaving, setIsSaving] = useState(false);
  // A save builds on the listed folders, so it waits for the list that follows the last one.
  const disabled = !isConnected || isSaving || listQuery.isPending;

  // One folder in or out: the server applies it to its own list, which another client may have
  // changed since this one was read.
  const save = async (
    change: { readonly track: ProjectTrackedFolder } | { readonly untrack: string },
    failureTitle: string,
  ) => {
    setIsSaving(true);
    const result = await updateProject({
      environmentId,
      input: {
        projectId: member.id,
        ...("track" in change
          ? { trackFolders: [{ path: change.track.path, name: change.track.name }] }
          : { untrackFolders: [change.untrack] }),
      },
    });
    setIsSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }
    listQuery.refresh();
  };

  const addFolder = async () => {
    const picked = await readLocalApi()
      ?.dialogs.pickFolder({ initialPath: member.workspaceRoot })
      .catch(() => null);
    const folder = picked == null ? null : trackedFolderFromPath(picked);
    if (folder !== null) await save({ track: folder }, "Failed to add folder");
  };

  return (
    <>
      <SettingsRow
        title={showEnvironment ? (member.environmentLabel ?? "Environment") : "Folders"}
        description={member.workspaceRoot}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || folders.length >= PROJECT_TRACKED_FOLDERS_MAX}
            onClick={() => void addFolder()}
          >
            <PlusIcon className="size-3.5" />
            Add folder
          </Button>
        }
      />
      {folders.length === 0 ? (
        <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
          Repositories inside this folder are part of the project as soon as they are there. Add a
          folder to bring in one from somewhere else.
        </p>
      ) : (
        folders.map((folder) => (
          <SettingsRow
            key={folder.path}
            className="py-2"
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{folder.name}</span>
                {folder.state ? (
                  <Badge size="sm" variant={folder.state === "missing" ? "warning" : "outline"}>
                    {FOLDER_STATE_LABELS[folder.state]}
                  </Badge>
                ) : null}
              </span>
            }
            description={
              <code className="block max-w-full truncate font-mono">
                {trackedFolderDisplayPath(folder.path, member.workspaceRoot)}
              </code>
            }
            control={
              // A repository inside the project folder is there for as long as it is on disk.
              folder.discovered === true ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Remove ${folder.name} from the project`}
                  onClick={() => void save({ untrack: folder.path }, "Failed to remove folder")}
                >
                  Remove
                </Button>
              )
            }
          />
        ))
      )}
      {suggested.map((folder) => (
        <SettingsRow
          key={folder.path}
          className="py-2"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-muted-foreground">{folder.name}</span>
              <Badge size="sm" variant="outline">
                In workspace file
              </Badge>
            </span>
          }
          description={
            <code className="block max-w-full truncate font-mono">
              {trackedFolderDisplayPath(folder.path, member.workspaceRoot)}
            </code>
          }
          control={
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              aria-label={`Add ${folder.name} to the project`}
              onClick={() => void save({ track: folder }, "Failed to add folder")}
            >
              Add
            </Button>
          }
        />
      ))}
      {listQuery.error ? (
        <p role="alert" className="px-3 py-2 text-xs text-warning-foreground sm:px-4">
          {listQuery.error}
        </p>
      ) : null}
    </>
  );
}
