/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  type CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
  type ThreadTurnRepositoryDiff,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  checkpointRefForScopeOrdinal,
  nestedScopePaths,
} from "../orchestration-v2/CheckpointService.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "./Diffs.ts";

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;
const REPOSITORY_DIFF_CONCURRENCY = 6;
// The thread's tracked repositories add patches only until their total reaches this size.
const REPOSITORY_DIFF_MAX_TOTAL_BYTES = 10_000_000;

/** Splits files into pathspec lists that each fit on one git command line. Renames keep both paths together. */
function batchFilePaths(files: ReadonlyArray<TurnDiffFileSummary>) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    // Each pathspec also carries a `:(top,literal)` prefix and a separator.
    const size = paths.reduce((total, path) => total + path.length + 16, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
  repositories?: ReadonlyArray<ThreadTurnRepositoryDiff>,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
    ...(repositories === undefined ? {} : { repositories }),
  };
}

type ContextCheckpoint = ProjectionCheckpointContext["checkpoints"][number];

/**
 * A repository's checkpoints for a turn range. Only turns that changed it are recorded, each with
 * the baseline before it, so the range runs from its first record to its last one inside the
 * range. None when no turn in the range changed it.
 */
export function repositoryDiffRange(
  checkpoints: ReadonlyArray<ContextCheckpoint>,
  range: { readonly fromTurnCount: number; readonly toTurnCount: number },
): { readonly from: ContextCheckpoint; readonly to: ContextCheckpoint } | undefined {
  const ready = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.status === "ready" &&
        checkpoint.ordinalWithinScope >= range.fromTurnCount &&
        checkpoint.ordinalWithinScope <= range.toTurnCount,
    )
    .toSorted((left, right) => left.ordinalWithinScope - right.ordinalWithinScope);
  const from = ready[0];
  const to = ready.at(-1);
  return from === undefined || to === undefined || from === to ? undefined : { from, to };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  interface Comparison {
    readonly cwd: string;
    readonly fromCheckpointRef: CheckpointRef;
    readonly toCheckpointRef: CheckpointRef;
    readonly fallbackFromToHead: false;
    readonly ignoreWhitespace: boolean;
    readonly excludePaths?: ReadonlyArray<string>;
  }

  // Leave out files that a pull, merge, or rebase brought in, matching the turn's file summary.
  // Filtering is optional: when it cannot run, the complete diff still loads.
  const patchBetween = Effect.fn("CheckpointDiffQuery.patchBetween")(function* (
    comparison: Comparison,
  ) {
    const authoredPaths = yield* checkpointStore
      .listAuthoredPaths(comparison)
      .pipe(Effect.orElseSucceed(() => null));
    const files =
      authoredPaths === null
        ? []
        : yield* checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
            Effect.map(parseTurnDiffFilesFromNumstat),
            Effect.orElseSucceed(() => []),
          );
    const retainedFiles = files.filter((file) => !isGitImport(file, authoredPaths));
    // Select retained paths before generating a patch, so imported bulk cannot exhaust its output limit.
    return retainedFiles.length === files.length
      ? yield* checkpointStore
          .diffCheckpoints(comparison)
          .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"))
      : (yield* Effect.forEach(
          batchFilePaths(retainedFiles),
          (filePaths) =>
            checkpointStore
              .diffCheckpoints({ ...comparison, filePaths })
              .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints")),
          { concurrency: 4 },
        )).join("");
  });

  // Most tracked repositories are untouched in a turn. A numstat finds the few that changed
  // before any patch is built.
  const repositoryDiffs = Effect.fn("CheckpointDiffQuery.repositoryDiffs")(function* (input: {
    readonly projection: ProjectionCheckpointContext;
    readonly threadCwd: string;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
    readonly ignoreWhitespace: boolean;
    readonly nested: ReadonlyMap<string, ReadonlyArray<string>>;
  }) {
    const changed = yield* Effect.forEach(
      input.projection.checkpointScopes.filter((scope) => typeof scope.repositoryPath === "string"),
      (scope) => {
        const range = repositoryDiffRange(
          input.projection.checkpoints.filter((checkpoint) => checkpoint.scopeId === scope.id),
          input,
        );
        if (range === undefined) return Effect.succeed([]);
        const excludePaths = input.nested.get(scope.id);
        const comparison: Comparison = {
          cwd: scope.cwd,
          fromCheckpointRef: range.from.ref,
          toCheckpointRef: range.to.ref,
          fallbackFromToHead: false,
          ignoreWhitespace: input.ignoreWhitespace,
          ...(excludePaths === undefined ? {} : { excludePaths }),
        };
        return checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
          Effect.map((numstat) => (numstat === "" ? [] : [{ scope, comparison }])),
          Effect.catch((cause) =>
            Effect.logWarning("checkpoint repository diff unavailable", {
              scopeId: scope.id,
              cause: String(cause),
            }).pipe(Effect.as([])),
          ),
        );
      },
      { concurrency: REPOSITORY_DIFF_CONCURRENCY },
    );
    const repositories: Array<ThreadTurnRepositoryDiff> = [];
    let totalBytes = 0;
    for (const { scope, comparison } of changed.flat()) {
      if (totalBytes >= REPOSITORY_DIFF_MAX_TOTAL_BYTES) break;
      const diff = yield* patchBetween(comparison).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("checkpoint repository diff unavailable", {
            scopeId: scope.id,
            cause: String(cause),
          }).pipe(Effect.as("")),
        ),
      );
      if (diff === "") continue;
      totalBytes += Buffer.byteLength(diff);
      repositories.push({
        name: scope.label ?? path.basename(scope.cwd),
        repositoryPath: scope.repositoryPath ?? scope.cwd,
        relativePath: path.relative(input.threadCwd, scope.cwd).split(path.sep).join("/"),
        diff,
      });
    }
    return repositories;
  });

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
        Effect.mapError(
          () =>
            new CheckpointThreadNotFoundError({
              operation,
              threadId: input.threadId,
            }),
        ),
        Effect.withSpan("checkpoint.turnDiff.lookupContext"),
      );
      const completedRunIds = new Set(
        projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
      );
      const hasRepositories = projection.checkpointScopes.some(
        (scope) => typeof scope.repositoryPath === "string",
      );
      // A thread folder that is not a Git repository records missing checkpoints; its turns still
      // exist, for the repositories inside it and as an empty patch while none of them changed.
      const turnCheckpoints = projection.checkpoints.filter(
        (checkpoint) =>
          (checkpoint.status === "ready" || (hasRepositories && checkpoint.status === "missing")) &&
          checkpoint.appRunOrdinal !== null &&
          checkpoint.runId !== null &&
          completedRunIds.has(checkpoint.runId),
      );
      const readyCheckpoints = turnCheckpoints.filter(
        (checkpoint) => checkpoint.status === "ready",
      );
      const maxTurnCount = turnCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const toCheckpoint = turnCheckpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
      );
      if (toCheckpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const toScope = projection.checkpointScopes.find(
        (scope) => scope.id === toCheckpoint.scopeId,
      );
      if (toScope === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      const nested = hasRepositories
        ? yield* nestedScopePaths([
            toScope,
            // A folder that became a repository after the range still belongs to the thread's patch.
            ...projection.checkpointScopes.filter(
              (scope) =>
                typeof scope.repositoryPath === "string" &&
                projection.checkpoints.some(
                  (checkpoint) =>
                    checkpoint.scopeId === scope.id &&
                    checkpoint.ordinalWithinScope <= input.toTurnCount,
                ),
            ),
          ]).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          )
        : undefined;
      const withRepositories = Effect.fnUntraced(function* (diff: string) {
        const repositories =
          nested === undefined
            ? undefined
            : yield* repositoryDiffs({
                projection,
                threadCwd: toScope.cwd,
                fromTurnCount: input.fromTurnCount,
                toTurnCount: input.toTurnCount,
                ignoreWhitespace,
                nested,
              });
        const turnDiff = buildTurnDiffResult(input, diff, repositories);
        if (!isTurnDiffResult(turnDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return turnDiff;
      });
      if (toCheckpoint.status === "missing") return yield* withRepositories("");

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? (() => {
              // The root scope is shared by every run in this thread. Its
              // runId tracks the latest owner, while ordinal zero stays the baseline.
              const firstScope = projection.checkpointScopes.find(
                (scope) => scope.kind === "root_run",
              );
              return firstScope === undefined
                ? undefined
                : checkpointRefForScopeOrdinal({
                    scopeId: firstScope.id,
                    ordinalWithinScope: 0,
                  });
            })()
          : readyCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount)
              ?.ref;
      if (fromCheckpointRef === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const excludePaths = nested?.get(toScope.id);
      const diff = yield* patchBetween({
        cwd: toScope.cwd,
        fromCheckpointRef,
        toCheckpointRef: toCheckpoint.ref,
        fallbackFromToHead: false,
        ignoreWhitespace,
        ...(excludePaths === undefined ? {} : { excludePaths }),
      });
      return yield* withRepositories(diff);
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
