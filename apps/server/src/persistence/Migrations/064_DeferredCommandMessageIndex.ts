import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DEFERRED_COMMAND_MESSAGE_CONDITION } from "../../orchestration-v2/deferredCommandMessage.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A turn start finds a long thread's few /compact prompts without reading every message.
  // ProjectionStore.getTurnStartContext must spell the same predicate.
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_deferred_command_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE ${DEFERRED_COMMAND_MESSAGE_CONDITION}
  `);
});
