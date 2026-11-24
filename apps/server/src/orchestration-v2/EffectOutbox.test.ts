import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const threadId = ThreadId.make("thread:effect-outbox");
const runId = RunId.make("run:effect-outbox");
const captureEffect = {
  id: "effect:checkpoint.capture:run:effect-outbox",
  commandId: CommandId.make("command:effect:checkpoint.capture:run:effect-outbox"),
  threadId,
  request: {
    type: "checkpoint.capture" as const,
    runId,
    scopeId: CheckpointScopeId.make("scope:effect-outbox"),
  },
};
const startEffect = {
  id: "effect:effect-outbox:start",
  commandId: CommandId.make("command:effect-outbox:start"),
  threadId,
  request: { type: "provider-turn.start" as const, runId: RunId.make("run:next") },
};

const outboxLayer = () =>
  Layer.fresh(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistenceMemory)));

// A run completes before its capture, so the next turn's start is enqueued while capture runs.
it.effect("keeps a next turn enqueued during capture behind that capture", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* outbox.enqueue([captureEffect]);
    const claimed = yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 60_000 });
    assert.equal(Option.getOrThrow(claimed).id, captureEffect.id);

    yield* outbox.enqueue([startEffect]);
    const blocked = yield* outbox.claimNext({ workerId: "second", leaseDurationMs: 60_000 });
    assert.isTrue(Option.isNone(blocked));

    yield* outbox.succeed({ effectId: captureEffect.id, workerId: "worker" });
    const next = yield* outbox.claimNext({ workerId: "second", leaseDurationMs: 60_000 });
    assert.equal(Option.getOrThrow(next).id, startEffect.id);
  }).pipe(Effect.provide(outboxLayer())),
);

it.effect("awaitSettled resolves when the effect settles and at once when it is not pending", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    // Nothing enqueued under this id: nothing to wait for.
    yield* outbox.awaitSettled("effect:missing");

    yield* outbox.enqueue([captureEffect]);
    yield* outbox.claimNext({ workerId: "worker", leaseDurationMs: 60_000 });
    const waiting = yield* Effect.forkChild(outbox.awaitSettled(captureEffect.id), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    assert.isUndefined(waiting.pollUnsafe());

    yield* outbox.fail({ effectId: captureEffect.id, workerId: "worker", error: "boom" });
    yield* Fiber.join(waiting);
    yield* outbox.awaitSettled(captureEffect.id);
  }).pipe(Effect.provide(outboxLayer())),
);
