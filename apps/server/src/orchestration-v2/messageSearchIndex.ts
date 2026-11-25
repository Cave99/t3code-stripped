import type * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The messages search indexes: finished, and either written by the user or
 * answered by an agent. User-role notices that agents or the system wrote
 * stay out, and so do subagent threads, which search never shows.
 * Migration 58's triggers, its backfill, and the scan all use it; `row` names
 * the message row (a table alias, or `new` in a trigger).
 */
export const indexedMessageCondition = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(`
  ${row}.streaming = 0
  AND (
    ${row}.role = 'assistant'
    OR (
      ${row}.role = 'user'
      AND COALESCE(json_extract(${row}.payload_json, '$.createdBy'), 'user') = 'user'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads AS subagent_threads
    WHERE subagent_threads.thread_id = ${row}.thread_id
      AND json_extract(subagent_threads.payload_json, '$.lineage.relationshipToParent') = 'subagent'
  )
`);

// Curly apostrophes straight, as search folds a query, since some keyboards
// type "’" and others type "'".
const foldApostrophes = (text: string) => `replace(replace(${text}, '’', ''''), '‘', '''')`;

/** A message's text as it reads, for thread search. */
export const messageSearchText = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(`json_extract(${row}.payload_json, '$.text')`);

/** What the index stores for a message, so a scan matches the folded query as the index does. */
export const foldedMessageSearchText = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(foldApostrophes(`json_extract(${row}.payload_json, '$.text')`));
