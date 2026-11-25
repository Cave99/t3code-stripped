import { assert, it, vi } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/t3/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        ordinalWithinScope: 2,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function makeLayer(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  readonly authoredPaths?: ReadonlySet<string>;
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
          listAuthoredPaths: () => Effect.succeed(input.authoredPaths ?? null),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()), diffCheckpoints });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("leaves Git imports out of large turn diffs", () => {
  const ownPaths = Array.from({ length: 1_000 }, (_, index) => `src/module-${index}/file.ts`);
  const diffCheckpoints = vi.fn((input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed(
      input.format === "numstat"
        ? [...ownPaths, "upstream.ts"].map((path) => `1\t0\t${path}\0`).join("")
        : (input.filePaths ?? ["all"]).join("\n"),
    ),
  );
  const layer = makeLayer({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints,
    authoredPaths: new Set(ownPaths),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    const patchPaths = diffCheckpoints.mock.calls
      .map(([call]) => call)
      .filter((call) => call.format !== "numstat")
      .map((call) => call.filePaths ?? ["all"]);
    assert.isAbove(patchPaths.length, 1);
    assert.sameMembers(patchPaths.flat(), ownPaths);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = makeLayer({
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointThreadNotFoundError);
    assert.deepEqual(
      { operation: error.operation, threadId: error.threadId },
      { operation: "CheckpointDiffQuery.getTurnDiff", threadId },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed unavailable-range error contract", () => {
  const layer = makeLayer({ projection: Effect.succeed(makeProjection()) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 3 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 3, availableTurnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: projection.checkpointScopes.map((scope) => ({
        ...scope,
        kind: "tool" as const,
      })),
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 0 },
    );
  }).pipe(Effect.provide(layer));
});

const repositoryFixture = (name: string, cwd: string, ordinals: ReadonlyArray<number>) => {
  const id = CheckpointScopeId.make(`scope:checkpoint-diff-v2:${name}`);
  return {
    scope: {
      id,
      runId: firstRunId,
      kind: "manual" as const,
      cwd,
      label: name,
      repositoryPath: cwd,
    },
    checkpoints: ordinals.map((ordinalWithinScope) => ({
      scopeId: id,
      runId: ordinalWithinScope === 2 ? secondRunId : null,
      ordinalWithinScope,
      appRunOrdinal: null,
      status: "ready" as const,
      ref: CheckpointRef.make(`refs/t3/test/${name}/${ordinalWithinScope}`),
    })),
  };
};

it.effect("adds a patch for each tracked repository that changed in the range", () => {
  const projection = makeProjection();
  const sibling = repositoryFixture("shared", "/work/shared", [1, 2]);
  // Nothing before the range's end, so there is no patch to make.
  const nested = repositoryFixture("ui", "/work/app/packages/ui", [2]);
  // Became a repository after the range, so the thread's own patch still covers its folder.
  const later = repositoryFixture("later", "/work/app/packages/later", [3]);
  const diffCheckpoints = vi.fn((input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed(input.format === "numstat" ? "1\t0\tfile.ts\0" : `patch of ${input.cwd}`),
  );
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: [
        ...projection.checkpointScopes.map((scope) => ({ ...scope, cwd: "/work/app" })),
        sibling.scope,
        nested.scope,
        later.scope,
      ],
      checkpoints: [
        ...projection.checkpoints,
        ...sibling.checkpoints,
        ...nested.checkpoints,
        ...later.checkpoints,
      ],
    }),
    diffCheckpoints,
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 });
    assert.deepEqual(result.repositories, [
      {
        name: "shared",
        repositoryPath: "/work/shared",
        relativePath: "../shared",
        diff: "patch of /work/shared",
      },
    ]);
    // The thread's own patch leaves the folder of the repository inside it alone.
    assert.strictEqual(result.diff, "patch of /work/app");
    assert.deepEqual(
      diffCheckpoints.mock.calls.find(([input]) => input.cwd === "/work/app")?.[0].excludePaths,
      ["packages/ui"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("answers a turn in a plain folder with an empty patch and its repositories", () => {
  const projection = makeProjection();
  const sibling = repositoryFixture("shared", "/work/shared", [1, 2]);
  const layer = makeLayer({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: [...projection.checkpointScopes, sibling.scope],
      checkpoints: [
        ...projection.checkpoints.map((checkpoint) => ({
          ...checkpoint,
          status: "missing" as const,
        })),
        ...sibling.checkpoints,
      ],
    }),
    diffCheckpoints: (input) =>
      Effect.succeed(input.format === "numstat" ? "1\t0\tfile.ts\0" : `patch of ${input.cwd}`),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.strictEqual(result.diff, "");
    assert.deepEqual(
      result.repositories?.map((repository) => repository.diff),
      ["patch of /work/shared"],
    );
  }).pipe(Effect.provide(layer));
});
