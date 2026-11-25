import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every command reads its thread's nodes without the settled leaves. This index lets that read
  // seek the nodes it keeps instead of fetching each finished tool call to drop it. The
  // omitSettledLeafNodes read in ProjectionStore must spell this expression the same way.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_settled_leaf_idx
    ON orchestration_v2_projection_nodes(
      thread_id,
      (kind IN ('tool_call', 'assistant_message', 'reasoning')
        AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        AND run_id IS NOT NULL)
    )
  `;
});
