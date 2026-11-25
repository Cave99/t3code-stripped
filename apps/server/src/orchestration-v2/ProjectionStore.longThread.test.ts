import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Reads that run on every open, send and sidebar refresh must not grow with a long
// thread's finished history. These tests seed one and check what SQLite walks.

const TestLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;
const TOOLS_PER_RUN = 3;

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

const queryPlan = (statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`);
    return rows.map((row) => row.detail);
  });

/**
 * Seeds a thread of `runs` turns. Each turn has a user message, TOOLS_PER_RUN tool calls
 * and an assistant answer, as items, nodes and messages. The last run is left running
 * with one finished and one running tool call when `lastRunActive` is set.
 */
const seedLongThread = Effect.fn("seedLongThread")(function* (input: {
  readonly suffix: string;
  readonly runs: number;
  readonly lastRunActive?: boolean;
}) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${input.suffix}`);
  let sequence = 0;
  const eventId = () => EventId.make(`event:${input.suffix}:${sequence++}`);
  yield* store.apply({
    id: eventId(),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${input.suffix}`),
      title: "Long thread",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  let itemOrdinal = 0;
  for (let ordinal = 1; ordinal <= input.runs; ordinal++) {
    const active = input.lastRunActive === true && ordinal === input.runs;
    const runId = RunId.make(`run:${input.suffix}:${ordinal}`);
    const rootNodeId = NodeId.make(`node:${input.suffix}:${ordinal}:root`);
    const userMessageId = MessageId.make(`message:${input.suffix}:${ordinal}:user`);
    const assistantMessageId = MessageId.make(`message:${input.suffix}:${ordinal}:assistant`);
    const base = { threadId, runId, driver, occurredAt: now } as const;
    yield* store.apply({
      ...base,
      id: eventId(),
      type: "run.created",
      nodeId: rootNodeId,
      providerInstanceId,
      payload: {
        id: runId,
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId,
        rootNodeId,
        activeAttemptId: null,
        status: active ? "running" : "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: active ? null : now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const node = (
      id: NodeId,
      kind: "root_turn" | "tool_call" | "assistant_message",
      running = false,
    ) =>
      store.apply({
        ...base,
        id: eventId(),
        type: "node.updated",
        nodeId: id,
        payload: {
          id,
          threadId,
          runId,
          parentNodeId: kind === "root_turn" ? null : rootNodeId,
          rootNodeId,
          kind,
          status: running ? "running" : "completed",
          countsForRun: kind === "root_turn",
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: running ? null : now,
        },
      });
    const itemBase = (id: string, nodeId: NodeId) => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ++itemOrdinal,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    yield* node(rootNodeId, "root_turn", active);
    for (const [id, role, text] of [
      [userMessageId, "user", `prompt ${ordinal}`],
      [assistantMessageId, "assistant", `answer ${ordinal}`],
    ] as const) {
      yield* store.apply({
        ...base,
        id: eventId(),
        type: "message.updated",
        nodeId: rootNodeId,
        payload: {
          createdBy: role === "user" ? "user" : "agent",
          creationSource: role === "user" ? "web" : "provider",
          id,
          threadId,
          runId,
          nodeId: rootNodeId,
          role,
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    yield* store.apply({
      ...base,
      id: eventId(),
      type: "turn-item.updated",
      nodeId: rootNodeId,
      payload: {
        ...itemBase(`item:${input.suffix}:${ordinal}:user`, rootNodeId),
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId: userMessageId,
        inputIntent: "turn_start",
        text: `prompt ${ordinal}`,
        attachments: [],
      },
    });
    for (let tool = 0; tool < TOOLS_PER_RUN; tool++) {
      const toolNodeId = NodeId.make(`node:${input.suffix}:${ordinal}:tool:${tool}`);
      yield* node(toolNodeId, "tool_call", active && tool === TOOLS_PER_RUN - 1);
      yield* store.apply({
        ...base,
        id: eventId(),
        type: "turn-item.updated",
        nodeId: toolNodeId,
        payload: {
          ...itemBase(`item:${input.suffix}:${ordinal}:tool:${tool}`, toolNodeId),
          type: "command_execution",
          input: "ls",
          output: "x".repeat(256),
          exitCode: 0,
        },
      });
    }
    const assistantNodeId = NodeId.make(`node:${input.suffix}:${ordinal}:assistant`);
    yield* node(assistantNodeId, "assistant_message");
    yield* store.apply({
      ...base,
      id: eventId(),
      type: "turn-item.updated",
      nodeId: assistantNodeId,
      payload: {
        ...itemBase(`item:${input.suffix}:${ordinal}:assistant`, assistantNodeId),
        type: "assistant_message",
        messageId: assistantMessageId,
        text: `answer ${ordinal}`,
        streaming: false,
      },
    });
  }
  return threadId;
});

const commandNodes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const { nodes } = yield* store.getThreadRecords(threadId, ["nodes"], {
      omitSettledLeafNodes: true,
    });
    return nodes.map((node) => String(node.id)).toSorted();
  });

const expectedCommandNodes = (suffix: string, runs: number) =>
  [
    ...Array.from({ length: runs }, (_, index) => `node:${suffix}:${index + 1}:root`),
    // The running run keeps its finished leaves: stopping it still ends them.
    ...Array.from({ length: TOOLS_PER_RUN }, (_, tool) => `node:${suffix}:${runs}:tool:${tool}`),
    `node:${suffix}:${runs}:assistant`,
  ].toSorted();

it.effect("memory command reads skip settled leaf nodes of finished runs", () =>
  Effect.gen(function* () {
    const threadId = yield* seedLongThread({
      suffix: "memory-leaves",
      runs: 4,
      lastRunActive: true,
    });
    assert.deepEqual(yield* commandNodes(threadId), expectedCommandNodes("memory-leaves", 4));
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.layer(TestLayer)("ProjectionStoreV2 long threads", (it) => {
  it.effect("command reads seek a long thread's live nodes, not its settled leaves", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const runs = 40;
      const threadId = yield* seedLongThread({ suffix: "sql-leaves", runs, lastRunActive: true });

      const { statements, tracer } = traceSqlStatements();
      const kept = yield* commandNodes(threadId).pipe(Effect.withTracer(tracer));
      assert.deepEqual(kept, expectedCommandNodes("sql-leaves", runs));
      const all = yield* store.getThreadRecords(threadId, ["nodes"]);
      assert.lengthOf(all.nodes, runs * (TOOLS_PER_RUN + 2));

      const nodeRead = statements.find((statement) =>
        statement.includes("FROM orchestration_v2_projection_nodes AS node"),
      );
      assert.isDefined(nodeRead);
      const plan = yield* queryPlan(nodeRead!);
      assert.isTrue(
        plan.some((detail) =>
          detail.includes("orchestration_v2_projection_nodes_settled_leaf_idx"),
        ),
        plan.join("\n"),
      );
    }),
  );
});
