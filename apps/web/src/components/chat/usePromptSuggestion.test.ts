import {
  MessageId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { offeredPromptSuggestion, promptSuggestionToAccept } from "./usePromptSuggestion";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const run = (
  id: RunId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  started = true,
): OrchestrationV2Run => ({
  id,
  threadId: ThreadId.make("thread-1"),
  ordinal,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: started ? now : null,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});
const summary = (value: OrchestrationV2Run) => ({
  runId: value.id,
  status: value.status,
  requestedAt: null,
  startedAt: value.startedAt === null ? null : "2026-06-20T00:00:00.000Z",
  completedAt: "2026-06-20T00:00:00.000Z",
  assistantMessageId: null,
});

describe("offeredPromptSuggestion", () => {
  it("offers a suggestion only while its run is the latest completed run", () => {
    const turn = run(RunId.make("run-1"), 1, "completed");
    const suggestion = { runId: turn.id, text: "run the tests" };
    expect(offeredPromptSuggestion(suggestion, summary(turn), [turn])).toBe(suggestion);

    const failed = run(RunId.make("run-1"), 1, "failed");
    expect(offeredPromptSuggestion(suggestion, summary(failed), [failed])).toBeNull();

    const next = run(RunId.make("run-2"), 2, "running");
    expect(offeredPromptSuggestion(suggestion, summary(next), [turn, next])).toBeNull();
    expect(offeredPromptSuggestion(null, summary(turn), [turn])).toBeNull();
  });

  it("offers the finished turn's suggestion after a queued message was promoted to Steer", () => {
    const turn = run(RunId.make("run-1"), 1, "completed");
    const steered = run(RunId.make("run-2"), 2, "cancelled", false);
    const suggestion = { runId: turn.id, text: "run the tests" };

    expect(offeredPromptSuggestion(suggestion, summary(steered), [turn, steered])).toBe(suggestion);

    // A later run that did start still replaces the earlier turn's suggestion.
    const stopped = run(RunId.make("run-2"), 2, "cancelled");
    expect(offeredPromptSuggestion(suggestion, summary(stopped), [turn, stopped])).toBeNull();

    // Several never-started runs in a row still fall back to the turn that ran.
    const removed = run(RunId.make("run-3"), 3, "cancelled", false);
    expect(offeredPromptSuggestion(suggestion, summary(removed), [turn, steered, removed])).toBe(
      suggestion,
    );

    // A newer turn that completed behind the cancelled run owns the suggestion slot.
    const newer = run(RunId.make("run-2"), 2, "completed");
    expect(
      offeredPromptSuggestion(suggestion, summary(removed), [turn, newer, removed]),
    ).toBeNull();

    // Cached detail that predates the shell's cancelled run cannot vouch for what ran in between.
    const unseen = run(RunId.make("run-3"), 3, "cancelled", false);
    expect(offeredPromptSuggestion(suggestion, summary(unseen), [turn])).toBeNull();
  });
});

describe("promptSuggestionToAccept", () => {
  it("accepts only into an empty draft", () => {
    expect(promptSuggestionToAccept("run the tests", "")).toBe("run the tests");
    expect(promptSuggestionToAccept("run the tests", "x")).toBeNull();
    expect(promptSuggestionToAccept(null, "")).toBeNull();
  });
});
