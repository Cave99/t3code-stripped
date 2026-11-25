import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Opening a thread reads its live nodes and attempts. These hold only the live rows, so a long
  // thread's finished history is not fetched to check its status. ProjectionStore's window read
  // names both indexes and must filter on the same status lists.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_live_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_run_attempts_live_idx
    ON orchestration_v2_projection_run_attempts(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting')
  `;
});
