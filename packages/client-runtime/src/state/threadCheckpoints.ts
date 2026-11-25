import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type CheckpointFile = OrchestrationV2ThreadProjection["checkpoints"][number]["files"][number];

/** A tracked repository a turn changed, named from the thread's folder. */
export interface TurnRepositoryChanges {
  readonly name: string;
  /** The repository folder from the thread's folder, `/`-separated; may start with `../`. */
  readonly relativePath: string;
  readonly files: ReadonlyArray<CheckpointFile>;
}

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  /**
   * Every file the turn changed: the thread folder's own, then each tracked repository's, named
   * from the thread's folder so the same path in two repositories stays two files.
   */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  /** Tracked repositories this turn changed; set only when there are any. */
  readonly repositories?: ReadonlyArray<TurnRepositoryChanges>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

/** Scopes that hold a tracked repository's checkpoints; they are never a rewind target. */
export function repositoryCheckpointScopeIds(
  scopes: ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "id" | "repositoryPath">>,
): ReadonlySet<CheckpointScopeId> {
  return new Set(
    scopes.flatMap((scope) => (typeof scope.repositoryPath === "string" ? [scope.id] : [])),
  );
}

/** `to` from `from`, both absolute, `/`-separated in the result. */
export function relativeFolderPath(from: string, to: string): string {
  const split = (value: string) => value.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const fromSegments = split(from);
  const toSegments = split(to);
  let shared = 0;
  while (
    shared < fromSegments.length &&
    shared < toSegments.length &&
    fromSegments[shared] === toSegments[shared]
  ) {
    shared += 1;
  }
  return [...fromSegments.slice(shared).map(() => ".."), ...toSegments.slice(shared)].join("/");
}

/** Per run, the tracked repositories it changed, in scope order. */
function deriveTurnRepositoryChanges(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "checkpointScopes">,
): ReadonlyMap<RunId, ReadonlyArray<TurnRepositoryChanges>> {
  const repositoryScopes = projection.checkpointScopes.filter(
    (scope) => typeof scope.repositoryPath === "string",
  );
  if (repositoryScopes.length === 0) return new Map();
  const rootCwd = projection.checkpointScopes.find((scope) => scope.kind === "root_run")?.cwd;
  const scopesById = new Map(repositoryScopes.map((scope) => [scope.id, scope]));
  const byRun = new Map<RunId, Array<TurnRepositoryChanges>>();
  for (const checkpoint of projection.checkpoints) {
    const scope = scopesById.get(checkpoint.scopeId);
    if (scope === undefined || checkpoint.runId === null || checkpoint.status !== "ready") continue;
    if (checkpoint.files.length === 0) continue;
    const changes = byRun.get(checkpoint.runId) ?? [];
    changes.push({
      name: scope.label ?? scope.cwd.split(/[\\/]/).at(-1) ?? scope.cwd,
      relativePath: rootCwd === undefined ? scope.cwd : relativeFolderPath(rootCwd, scope.cwd),
      files: checkpoint.files,
    });
    byRun.set(checkpoint.runId, changes);
  }
  return byRun;
}

/** Derives the checkpoint/diff rows needed by review UIs from native V2 entities. */
export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  const repositoriesByRun = deriveTurnRepositoryChanges(projection);
  const repositoryScopeIds = repositoryCheckpointScopeIds(projection.checkpointScopes);
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    if (repositoryScopeIds.has(checkpoint.scopeId)) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    const repositories = repositoriesByRun.get(checkpoint.runId);
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files:
          repositories === undefined
            ? checkpoint.files
            : [
                ...checkpoint.files,
                ...repositories.flatMap((repository) =>
                  repository.files.map((file) => ({
                    ...file,
                    path:
                      repository.relativePath === ""
                        ? file.path
                        : `${repository.relativePath}/${file.path}`,
                  })),
                ),
              ],
        ...(repositories === undefined ? {} : { repositories }),
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}
