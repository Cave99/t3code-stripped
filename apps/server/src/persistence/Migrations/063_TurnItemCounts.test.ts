import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("063_TurnItemCounts", (it) => {
  it.effect("backfills existing items and keeps counts exact through every write", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      const insert = (id: string, runId: string | null) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (${id}, 'thread:a', ${runId}, 1, 'user_message', 'completed', '', '{}')
      `;
      yield* insert("item:1", "run:1");
      yield* insert("item:2", "run:1");
      yield* insert("item:3", null);
      yield* runMigrations({ toMigrationInclusive: 63 });

      const counts = () => sql<{ readonly run_key: string; readonly item_count: number }>`
        SELECT run_key, item_count FROM orchestration_v2_projection_turn_item_counts
        WHERE thread_id = 'thread:a' ORDER BY run_key
      `;
      assert.deepEqual(yield* counts(), [
        { run_key: "", item_count: 1 },
        { run_key: "run:1", item_count: 2 },
      ]);

      yield* insert("item:4", "run:2");
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = 'run:2' WHERE turn_item_id = 'item:1'`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = 'failed' WHERE turn_item_id = 'item:2'`;
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item:3'`;
      assert.deepEqual(yield* counts(), [
        { run_key: "run:1", item_count: 1 },
        { run_key: "run:2", item_count: 2 },
      ]);
    }),
  );
});
