import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const payloadJson = (text: string, createdBy: string | undefined) =>
  JSON.stringify({ text, createdBy });

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("058_ThreadMessageSearch", (it) => {
  it.effect("backfills what users wrote and agents answered, then follows writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      const insert = (
        id: string,
        role: string,
        streaming: number,
        text: string,
        createdBy: string | undefined = role === "user" ? "user" : "agent",
      ) => sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
        )
        VALUES (
          ${id}, 'thread-1', NULL, NULL, ${role}, ${streaming},
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ${payloadJson(text, createdBy)}
        )
      `;
      yield* insert("user", "user", 0, "needle from the user");
      yield* insert("assistant", "assistant", 0, "needle from the agent");
      yield* insert("streaming", "assistant", 1, "needle still streaming");
      yield* insert("system", "system", 0, "needle in a system prompt");
      yield* insert("notice", "user", 0, "needle in a pull request update", "agent");
      // Older rows carry no author; they were the user's.
      yield* insert("legacy", "user", 0, "needle from before authors", undefined);

      yield* runMigrations();

      const indexed = (phrase = "needle") =>
        sql<{ readonly messageId: string }>`
          SELECT messages.message_id AS "messageId"
          FROM orchestration_v2_message_search AS search
          INNER JOIN orchestration_v2_projection_messages AS messages
            ON messages.rowid = search.rowid
          WHERE orchestration_v2_message_search MATCH ${`"${phrase}"`}
          ORDER BY messages.message_id
        `.pipe(Effect.map((rows) => rows.map((row) => row.messageId)));
      assert.deepEqual(yield* indexed(), ["assistant", "legacy", "user"]);

      // A streamed message joins once it finishes.
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET streaming = 0, payload_json = ${payloadJson("needle finished", "agent")}
        WHERE message_id = 'streaming'
      `;
      assert.deepEqual(yield* indexed(), ["assistant", "legacy", "streaming", "user"]);

      // Curly apostrophes are stored straight, as search folds a query.
      yield* insert("apostrophe", "user", 0, "it’s a needle");
      assert.deepEqual(yield* indexed("it's"), ["apostrophe"]);

      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'user'`;
      assert.deepEqual(yield* indexed(), ["apostrophe", "assistant", "legacy", "streaming"]);
    }),
  );
});
