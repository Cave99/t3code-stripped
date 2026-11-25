import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadCheckpointSummaries, relativeFolderPath } from "./threadCheckpoints.ts";

const threadId = ThreadId.make("thread:checkpoints");
const runId = RunId.make("run:1");
const capturedAt = DateTime.makeUnsafe("2026-11-20T00:00:00.000Z");

const scope = (id: string, cwd: string, repository?: { label: string }) => ({
  id: CheckpointScopeId.make(id),
  threadId,
  runId,
  nodeId: NodeId.make("node:1"),
  parentScopeId: repository === undefined ? null : CheckpointScopeId.make("root"),
  providerThreadId: null,
  kind: repository === undefined ? ("root_run" as const) : ("manual" as const),
  ordinalWithinParent: repository === undefined ? 0 : 1,
  advancesAppRunCount: repository === undefined,
  cwd,
  ...(repository === undefined ? {} : { label: repository.label, repositoryPath: cwd }),
  createdAt: capturedAt,
});

const checkpoint = (input: {
  scopeId: string;
  ordinal: number;
  appRunOrdinal: number | null;
  runId: RunId | null;
  status?: "ready" | "missing";
  files?: ReadonlyArray<string>;
}) => ({
  id: CheckpointId.make(`${input.scopeId}:${input.ordinal}`),
  threadId,
  scopeId: CheckpointScopeId.make(input.scopeId),
  runId: input.runId,
  nodeId: NodeId.make("node:1"),
  parentCheckpointId: null,
  ordinalWithinScope: input.ordinal,
  appRunOrdinal: input.appRunOrdinal,
  ref: CheckpointRef.make(`refs/t3/${input.scopeId}/${input.ordinal}`),
  status: input.status ?? ("ready" as const),
  files: (input.files ?? []).map((path) => ({
    path,
    kind: "modified",
    additions: 1,
    deletions: 0,
  })),
  capturedAt,
});

describe("deriveThreadCheckpointSummaries", () => {
  it("adds each changed repository's files to the turn, named from the thread folder", () => {
    const projection = {
      checkpointScopes: [
        scope("root", "/work/shop"),
        scope("api", "/work/shop/api", { label: "api" }),
        scope("shared", "/work/shared", { label: "shared" }),
      ],
      checkpoints: [
        // The plain project folder has no snapshot of its own.
        checkpoint({ scopeId: "root", ordinal: 1, appRunOrdinal: 1, runId, status: "missing" }),
        // A repository's baseline is never a turn of its own.
        checkpoint({ scopeId: "api", ordinal: 0, appRunOrdinal: null, runId: null }),
        checkpoint({ scopeId: "api", ordinal: 1, appRunOrdinal: null, runId, files: ["a.ts"] }),
        checkpoint({ scopeId: "shared", ordinal: 1, appRunOrdinal: null, runId, files: ["b.ts"] }),
      ],
      messages: [],
    } as unknown as OrchestrationV2ThreadProjection;

    const [summary, ...rest] = deriveThreadCheckpointSummaries(projection);
    expect(rest).toEqual([]);
    expect(summary?.status).toBe("missing");
    expect(summary?.files.map((file) => file.path)).toEqual(["api/a.ts", "../shared/b.ts"]);
    expect(summary?.repositories?.map((repository) => repository.name)).toEqual(["api", "shared"]);
  });

  it("leaves a single-folder thread's turns as they were", () => {
    const projection = {
      checkpointScopes: [scope("root", "/work/app")],
      checkpoints: [
        checkpoint({ scopeId: "root", ordinal: 1, appRunOrdinal: 1, runId, files: ["x.ts"] }),
      ],
      messages: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const [summary] = deriveThreadCheckpointSummaries(projection);
    expect(summary?.files.map((file) => file.path)).toEqual(["x.ts"]);
    expect(summary).not.toHaveProperty("repositories");
  });
});

describe("relativeFolderPath", () => {
  it("walks up from the thread folder where it has to", () => {
    expect(relativeFolderPath("/work/shop", "/work/shop/packages/ui")).toBe("packages/ui");
    expect(relativeFolderPath("/work/shop", "/work/shared")).toBe("../shared");
    expect(relativeFolderPath("C:\\work\\shop", "C:\\work\\shop\\api")).toBe("api");
  });
});
