import type { ProjectTrackedFolder, WorkspaceScannedFolder } from "@t3tools/contracts";
import { fileBasename, isAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";

/** Relative to the project folder when inside it, absolute otherwise. */
export function trackedFolderDisplayPath(path: string, workspaceRoot: string): string {
  const relative = workspaceRelativeFilePath(path, workspaceRoot);
  return relative === null || relative === "." ? path : relative;
}

/** The folder a picked absolute path adds, named after its last segment. */
export function trackedFolderFromPath(rawPath: string): ProjectTrackedFolder | null {
  const path = rawPath.trim().replace(/(?<=.)[\\/]+$/, "");
  if (path.length === 0 || !isAbsolutePath(path)) return null;
  // `ProjectTrackedFolder.name` takes at most 128 characters.
  const name = fileBasename(path).slice(0, 128).trim();
  return name.length === 0 ? null : { path, name };
}

/**
 * Folders a project's `.code-workspace` file lists that the project does not cover yet. The
 * server finds repositories inside the project folder itself; a listed folder outside it is only
 * offered, since adding it lets agents work somewhere new.
 */
export function suggestedTrackedFolders(
  tracked: ReadonlyArray<ProjectTrackedFolder>,
  scanned: ReadonlyArray<WorkspaceScannedFolder>,
): ReadonlyArray<ProjectTrackedFolder> {
  const seen = new Set(tracked.map((folder) => folder.path));
  return scanned.flatMap((folder) => {
    if (folder.source !== "code-workspace" || seen.has(folder.path)) return [];
    seen.add(folder.path);
    // The project schema caps a name's length.
    return [{ path: folder.path, name: folder.name.slice(0, 128).trim() || folder.path }];
  });
}
