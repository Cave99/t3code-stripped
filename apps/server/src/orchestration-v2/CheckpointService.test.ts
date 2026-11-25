import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessExitError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import * as WorkspaceFoldersTestkit from "../workspace/WorkspaceFolders.testkit.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const testLayer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          WorkspaceFoldersTestkit.layerNoFoldersWithPlatform,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect(
  "asks Git about a tracked repository once a turn and snapshots it only when changed",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:repositories"),
        threadId: ThreadId.make("thread:repositories"),
        runId: RunId.make("run:repositories:1"),
        nodeId: NodeId.make("node:repositories:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:repositories"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/wrapper",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const thread = { projectId: ProjectId.make("project:repositories"), worktreePath: null };
      const repositories = Array.from({ length: 30 }, (_, index) => `/wrapper/repo-${index}`);
      const [slowRepository, changedRepository] = [repositories[7]!, repositories[3]!];
      const unreadableRepository = repositories[5]!;
      const startHead = "a".repeat(40);
      const heads = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (call: string) => Ref.update(calls, (current) => [...current, call]);
      const slow = yield* Ref.make(true);
      const slowStarted = yield* Deferred.make<void>();
      const othersSeen = yield* Deferred.make<void>();
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            NodeServices.layer,
            Layer.mock(WorkspaceFolders.WorkspaceFolders)({
              forThread: () =>
                Effect.succeed({
                  folders: [
                    ...repositories.map((path) => ({ name: path, path, isGitRepository: true })),
                    { name: "notes", path: "/wrapper/notes", isGitRepository: false },
                  ],
                  extraRoots: [],
                }),
            }),
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: (cwd) => record(`probe ${cwd}`).pipe(Effect.as(cwd !== "/wrapper")),
              resolveCleanHead: (cwd) =>
                Effect.gen(function* () {
                  // One repository is too slow for the turn to wait on.
                  if (cwd === slowRepository && (yield* Ref.get(slow))) {
                    yield* Deferred.succeed(slowStarted, undefined);
                    yield* Effect.sleep("1 minute");
                  }
                  yield* record(`status ${cwd}`);
                  if (
                    (yield* Ref.get(calls)).filter((call) => call.startsWith("status")).length ===
                    repositories.length - 1
                  ) {
                    yield* Deferred.succeed(othersSeen, undefined);
                  }
                  return (yield* Ref.get(heads)).get(cwd) ?? startHead;
                }),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureHeadCheckpoint: ({ cwd, head, checkpointRef }) =>
                record(`snapshot ${cwd} at ${head[0]}`).pipe(
                  Effect.andThen(
                    Ref.update(refs, (current) => new Set([...current, checkpointRef])),
                  ),
                ),
              diffCheckpoints: ({ cwd }) =>
                cwd === unreadableRepository
                  ? Effect.fail(
                      new VcsProcessExitError({
                        operation: "test.diff",
                        command: "git",
                        cwd,
                        exitCode: 128,
                        detail: "fatal: unable to read tree",
                      }),
                    )
                  : Effect.succeed("1\t0\tfile.ts\0"),
              listAuthoredPaths: () => Effect.succeed(null),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const scopes = yield* checkpoints.repositoryScopes({ rootScope: scope, ...thread });
        // The plain folder gets no scope, and each scope is known by the tracked folder.
        assert.deepEqual(
          scopes.map((repository) => repository.cwd),
          repositories,
        );
        assert.deepEqual(
          scopes.map((repository) => repository.repositoryPath),
          repositories,
        );
        assert.isTrue(scopes.every((repository) => repository.parentScopeId === scope.id));
        const captureAll = (ordinalWithinScope: number) =>
          Effect.forEach(scopes, (repository) =>
            checkpoints.captureRepository({
              scope: repository,
              runId: scope.runId!,
              nodeId: scope.nodeId,
              ordinalWithinScope,
              capturedAt: scope.createdAt,
              baselineRecorded: false,
            }),
          );

        // Every baseline shares the turn's budget; the slow repository is left without one.
        const firstTurn = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 0, thread })
          .pipe(Effect.forkChild);
        yield* Deferred.await(slowStarted);
        yield* Deferred.await(othersSeen);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(firstTurn);
        yield* Ref.set(slow, false);

        // A turn that changes nothing writes nothing and records nothing.
        assert.isTrue((yield* captureAll(1)).every(Option.isNone));
        assert.isFalse((yield* Ref.get(calls)).some((call) => call.startsWith("snapshot")));

        // The next turn starts from what each repository's last run ended with, so only the
        // thread's own folder is read.
        yield* Ref.set(calls, []);
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1, thread });
        assert.deepEqual(yield* Ref.get(calls), ["probe /wrapper"]);

        // The turn commits in two repositories: each baseline is snapshotted from where it started.
        // One of them cannot list what changed, which is not the same as nothing having changed.
        yield* Ref.set(
          heads,
          new Map([
            [changedRepository, "b".repeat(40)],
            [unreadableRepository, "b".repeat(40)],
          ]),
        );
        yield* Ref.set(calls, []);
        const recorded = (yield* captureAll(2)).flatMap(Option.toArray);
        assert.deepEqual(
          recorded.map(({ baseline, checkpoint }) => ({
            cwd: scopes.find((repository) => repository.id === checkpoint.scopeId)?.cwd,
            baseline: baseline?.ordinalWithinScope,
            ordinal: checkpoint.ordinalWithinScope,
            files: checkpoint.files.map((file) => file.path),
          })),
          [
            { cwd: changedRepository, baseline: 1, ordinal: 2, files: ["file.ts"] },
            { cwd: unreadableRepository, baseline: 1, ordinal: 2, files: [] },
          ],
        );
        assert.deepEqual(
          (yield* Ref.get(calls)).filter((call) => call.startsWith("snapshot")),
          [changedRepository, unreadableRepository].flatMap((cwd) => [
            `snapshot ${cwd} at a`,
            `snapshot ${cwd} at b`,
          ]),
        );
        assert.lengthOf(
          (yield* Ref.get(calls)).filter((call) => call.startsWith("status")),
          repositories.length,
        );
      }).pipe(Effect.provide(layerTest));
    }),
);
