import {
  PROJECT_TRACKED_FOLDERS_MAX,
  type ProjectId,
  type ProjectTrackedFolder,
  type WorkspaceFolder,
  WorkspaceFoldersError,
  type WorkspaceListFoldersInput,
  type WorkspaceListFoldersResult,
  type WorkspaceScanFoldersInput,
  type WorkspaceScanFoldersResult,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { expandHomePathWith } from "../pathExpansion.ts";

/** Whether `candidate` is `root` or a path below it. */
export const isWithinRoot = (path: Path.Path, candidate: string, root: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

const splitsSurrogatePair = (text: string, offset: number) => {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
};

/** A tracked folder a thread works in, besides its own cwd. */
export interface ThreadFolder {
  readonly name: string;
  readonly path: string;
  readonly isGitRepository: boolean;
}

export interface ThreadWorkspace {
  readonly folders: ReadonlyArray<ThreadFolder>;
  /** Paths of the folders outside the thread's cwd, which an agent needs granted to reach. */
  readonly extraRoots: ReadonlyArray<string>;
}

const EMPTY_WORKSPACE: ThreadWorkspace = { folders: [], extraRoots: [] };

export class WorkspaceFolders extends Context.Service<
  WorkspaceFolders,
  {
    /**
     * The tracked folders a thread reaches. One in a worktree reaches none, since the project's
     * other checkouts are shared with every thread.
     */
    readonly forThread: (input: {
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
    }) => Effect.Effect<ThreadWorkspace, WorkspaceFoldersError>;
    readonly list: (
      input: WorkspaceListFoldersInput,
    ) => Effect.Effect<WorkspaceListFoldersResult, WorkspaceFoldersError>;
    readonly scan: (
      input: WorkspaceScanFoldersInput,
    ) => Effect.Effect<WorkspaceScanFoldersResult, WorkspaceFoldersError>;
  }
>()("t3/workspace/WorkspaceFolders") {}

const DETECTION_CONCURRENCY = 8;
// What `ProjectTrackedFolder.name` allows.
const FOLDER_NAME_MAX = 128;
const boundedName = (name: string) => {
  const trimmed = name.trimStart();
  const end = splitsSurrogatePair(trimmed, FOLDER_NAME_MAX) ? FOLDER_NAME_MAX - 1 : FOLDER_NAME_MAX;
  return trimmed.slice(0, end).trimEnd();
};
const CODE_WORKSPACE_EXTENSION = ".code-workspace";

const decodeCodeWorkspace = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      folders: Schema.optional(
        Schema.Array(
          Schema.Struct({
            path: Schema.optional(Schema.String),
            name: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

/** Submodule paths a `.gitmodules` file declares, relative to its folder with `/` separators. */
export const parseGitmodulesPaths = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/).flatMap((line) => {
    const value = /^\s*path\s*=\s*(.*?)\s*$/.exec(line)?.[1];
    if (value === undefined) return [];
    const normalized = value.replaceAll('"', "").replaceAll("\\", "/").replace(/\/+$/, "");
    return normalized === "" ? [] : [normalized];
  });

// Built once per operation: the probes share the caller's file system and path services.
const folderProbes = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  // Sandboxes and containment checks work on what a path resolves to, not on a symlink's name.
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));

  // A repository is a folder with its own `.git`; a folder deeper inside one is plain files.
  // Untraced: it runs once per folder inside the calling operation's span.
  const classify = Effect.fnUntraced(function* (
    folder: ProjectTrackedFolder,
  ): Effect.fn.Return<WorkspaceFolder> {
    if (yield* exists(path.join(folder.path, ".git"))) return { ...folder, state: "git" };
    return { ...folder, state: (yield* exists(folder.path)) ? "plain" : "missing" };
  });

  // A linked worktree and a submodule keep `.git` as a file; both follow another repository.
  const ownsHistory = (folder: string) =>
    fileSystem.stat(path.join(folder, ".git")).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const childFolders = (folder: string) =>
    fileSystem.readDirectory(folder).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.map((names) =>
        names
          .filter((name) => !name.startsWith(".") && name !== "node_modules")
          .toSorted()
          .map((name) => path.join(folder, name)),
      ),
    );

  return { exists, realPath, classify, ownsHistory, childFolders };
});

const readCodeWorkspaceFolders = Effect.fn("WorkspaceFolders.readCodeWorkspaceFolders")(function* (
  root: string,
  fileName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const document = yield* fileSystem
    .readFileString(path.join(root, fileName))
    .pipe(Effect.flatMap(decodeCodeWorkspace), Effect.option);
  if (Option.isNone(document)) return null;
  return (document.value.folders ?? []).flatMap((folder) => {
    const folderPath = folder.path?.trim();
    if (folderPath === undefined || folderPath === "") return [];
    const resolved = path.resolve(root, folderPath);
    return [
      {
        path: resolved,
        name: boundedName(folder.name?.trim() ?? "") || boundedName(path.basename(resolved)),
      },
    ];
  });
});

/**
 * Finds the repositories under `workspaceRoot` and the folders its `.code-workspace` file lists.
 */
const scanFolders = Effect.fn("WorkspaceFolders.scan")(function* (
  input: WorkspaceScanFoldersInput,
  limit: number = PROJECT_TRACKED_FOLDERS_MAX,
): Effect.fn.Return<
  WorkspaceScanFoldersResult,
  WorkspaceFoldersError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { exists, realPath, classify, ownsHistory, childFolders } = yield* folderProbes;
  const root = path.resolve(expandHomePathWith(input.workspaceRoot.trim(), path));
  const names = (yield* fileSystem
    .readDirectory(root)
    .pipe(
      Effect.mapError(
        () => new WorkspaceFoldersError({ operation: "scan", detail: `Could not read ${root}.` }),
      ),
    )).toSorted();
  const codeWorkspaceFile = names.find((name) => name.endsWith(CODE_WORKSPACE_EXTENSION)) ?? null;
  const listed =
    codeWorkspaceFile === null ? null : yield* readCodeWorkspaceFolders(root, codeWorkspaceFile);
  // A worktree of another repository is that repository's, so only folders with their own
  // history are offered. A plain child is looked into once: wrappers keep repositories under
  // folders such as `src` or `packages`.
  const children = yield* Effect.forEach(
    names.filter((name) => !name.startsWith(".") && name !== "node_modules"),
    (name) => {
      const folderPath = path.join(root, name);
      return Effect.gen(function* () {
        if (yield* ownsHistory(folderPath)) return [{ path: folderPath, name: boundedName(name) }];
        if (yield* exists(path.join(folderPath, ".git"))) return [];
        const nested = yield* Effect.filter(yield* childFolders(folderPath), ownsHistory, {
          concurrency: DETECTION_CONCURRENCY,
        });
        return nested.map((nestedPath) => ({
          path: nestedPath,
          name: boundedName(path.basename(nestedPath)),
        }));
      });
    },
    { concurrency: DETECTION_CONCURRENCY },
  );
  const submodules = new Set(
    parseGitmodulesPaths(
      yield* fileSystem
        .readFileString(path.join(root, ".gitmodules"))
        .pipe(Effect.orElseSucceed(() => "")),
    ),
  );
  const realRoot = yield* realPath(root);
  const resolved = yield* Effect.forEach(
    [
      ...(listed ?? []).map((folder) => ({ ...folder, source: "code-workspace" as const })),
      ...children.flat().map((folder) => ({ ...folder, source: "child" as const })),
    ],
    (folder) => realPath(folder.path).pipe(Effect.map((real) => ({ folder, real }))),
    { concurrency: DETECTION_CONCURRENCY },
  );
  const seen = new Set<string>();
  const candidates = resolved.flatMap(({ folder, real }) => {
    // The scanned folder and its parents are never tracked, however a symlink names them.
    if (seen.has(real) || isWithinRoot(path, realRoot, real)) return [];
    seen.add(real);
    // Submodules follow their parent repository.
    return submodules.has(path.relative(root, folder.path).split(path.sep).join("/"))
      ? []
      : [folder];
  });
  // Capped after the missing ones are dropped: dead entries must not hide the folders that exist.
  const folders = yield* Effect.forEach(
    candidates,
    (folder) =>
      classify(folder).pipe(
        Effect.map((classified) =>
          classified.state === "missing"
            ? []
            : [{ ...folder, isGitRepository: classified.state === "git" }],
        ),
      ),
    { concurrency: DETECTION_CONCURRENCY },
  );
  return {
    workspaceRoot: root,
    isGitRepository: yield* exists(path.join(root, ".git")),
    codeWorkspaceFile:
      listed === null || codeWorkspaceFile === null ? null : path.join(root, codeWorkspaceFile),
    folders: folders.flat().slice(0, limit),
  };
});

/**
 * The repositories inside a project folder, read from disk: the ones a scan finds there, less
 * those the project's `t3.json` leaves out. A folder outside it is never found this way, since
 * tracking one grants agents a place they could not reach before.
 */
export const discoverFolders = Effect.fn("WorkspaceFolders.discover")(function* (
  workspaceRoot: string,
): Effect.fn.Return<ReadonlyArray<ProjectTrackedFolder>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { realPath, ownsHistory } = yield* folderProbes;
  const root = path.resolve(expandHomePathWith(workspaceRoot.trim(), path));
  const ignored = (
    parseT3ProjectFile(
      yield* fileSystem
        .readFileString(path.join(root, T3_PROJECT_FILE_NAME))
        .pipe(Effect.orElseSucceed(() => "")),
    )?.ignoreRepositories ?? []
  ).map((entry) => path.resolve(root, entry));
  // Everything the scan could find would be dropped, so skip the walk.
  if (ignored.some((entry) => isWithinRoot(path, root, entry))) return [];
  // Uncapped: the folders outside the project are dropped below, and must not use up the room.
  const scan = yield* scanFolders({ workspaceRoot }, Number.POSITIVE_INFINITY).pipe(Effect.option);
  if (Option.isNone(scan)) return [];
  const realRoot = yield* realPath(root);
  const inside = yield* Effect.filter(
    scan.value.folders.filter(
      (folder) =>
        folder.isGitRepository &&
        !ignored.some((entry) => folder.path === entry || isWithinRoot(path, folder.path, entry)),
    ),
    // A link to a repository elsewhere is not inside the project, whatever its name says, and a
    // worktree a workspace file lists follows another repository.
    (folder) =>
      Effect.all([realPath(folder.path), ownsHistory(folder.path)]).pipe(
        Effect.map(
          ([real, owns]) => owns && real !== realRoot && isWithinRoot(path, real, realRoot),
        ),
      ),
    { concurrency: DETECTION_CONCURRENCY },
  );
  return inside.map((folder) => ({ path: folder.path, name: folder.name, discovered: true }));
});

/**
 * The found repositories, then the folders someone added. Someone chose the added ones, so the
 * found ones give way when both do not fit.
 */
export const mergeProjectFolders = (
  discovered: ReadonlyArray<ProjectTrackedFolder>,
  trackedFolders: ReadonlyArray<ProjectTrackedFolder>,
): ReadonlyArray<ProjectTrackedFolder> => {
  const found = new Set(discovered.map((folder) => folder.path));
  const added = trackedFolders
    .filter((folder) => folder.discovered !== true && !found.has(folder.path))
    .slice(0, PROJECT_TRACKED_FOLDERS_MAX);
  return [...discovered.slice(0, PROJECT_TRACKED_FOLDERS_MAX - added.length), ...added];
};

/**
 * Every folder a project works in besides its own: the repositories found inside it now, then
 * the folders someone added. Read from disk each time, so a clone or a removal shows at once.
 */
export const projectFolders = Effect.fn("WorkspaceFolders.projectFolders")(function* (project: {
  readonly workspaceRoot: string;
  readonly trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
}): Effect.fn.Return<
  ReadonlyArray<ProjectTrackedFolder>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  return mergeProjectFolders(yield* discoverFolders(project.workspaceRoot), project.trackedFolders);
});

/** Whether two tracked lists name the same folders in the same order. */
export const sameProjectFolders = (
  left: ReadonlyArray<ProjectTrackedFolder>,
  right: ReadonlyArray<ProjectTrackedFolder>,
) =>
  left.length === right.length &&
  left.every((folder, index) => {
    const other = right[index]!;
    return (
      folder.path === other.path &&
      folder.name === other.name &&
      (folder.discovered === true) === (other.discovered === true)
    );
  });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const { realPath, classify } = yield* folderProbes;

  const readProject = Effect.fn("WorkspaceFolders.readProject")(function* (projectId: ProjectId) {
    const row = yield* projects
      .get(projectId)
      .pipe(
        Effect.mapError(
          () => new WorkspaceFoldersError({ operation: "list", detail: "Failed to read project." }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new WorkspaceFoldersError({
        operation: "list",
        detail: `Project ${projectId} was not found.`,
      });
    }
    return row.value;
  });

  const classifyAll = (folders: ReadonlyArray<ProjectTrackedFolder>) =>
    Effect.forEach(folders, classify, { concurrency: DETECTION_CONCURRENCY });
  const foldersOf = (project: {
    readonly workspaceRoot: string;
    readonly trackedFolders: ReadonlyArray<ProjectTrackedFolder>;
  }) =>
    projectFolders(project).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const forThread: WorkspaceFolders["Service"]["forThread"] = Effect.fn(
    "WorkspaceFolders.forThread",
  )(function* (input) {
    if (input.worktreePath !== null) return EMPTY_WORKSPACE;
    const project = yield* readProject(input.projectId);
    const tracked = yield* foldersOf(project);
    if (tracked.length === 0) return EMPTY_WORKSPACE;
    const folders = (yield* classifyAll(tracked)).flatMap((folder) =>
      folder.state === "missing"
        ? []
        : [{ name: folder.name, path: folder.path, isGitRepository: folder.state === "git" }],
    );
    const projectRoot = yield* realPath(project.workspaceRoot);
    // Both spellings are granted: agents are told the stored path, sandboxes check the real one.
    const outside = yield* Effect.forEach(
      folders,
      (folder) =>
        realPath(folder.path).pipe(
          Effect.map((real) => (isWithinRoot(path, real, projectRoot) ? [] : [folder.path, real])),
        ),
      { concurrency: DETECTION_CONCURRENCY },
    );
    return { folders, extraRoots: [...new Set(outside.flat())] };
  });

  const list: WorkspaceFolders["Service"]["list"] = Effect.fn("WorkspaceFolders.list")(
    function* (input) {
      const project = yield* readProject(input.projectId);
      return { folders: yield* classifyAll(yield* foldersOf(project)) };
    },
  );

  const scan: WorkspaceFolders["Service"]["scan"] = (input) =>
    scanFolders(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return WorkspaceFolders.of({ forThread, list, scan });
});

export const layer = Layer.effect(WorkspaceFolders, make);
