// SQLite's trim needs the characters JavaScript's String.prototype.trim removes spelled out.
export const JAVASCRIPT_TRIM_WHITESPACE = " \t\n\r\v\f                 　﻿";

/**
 * A user message that is a `/compact` command, whose turn defers context to the next one. The
 * partial index of migration 64 is only used when a read spells this text the same way.
 */
export const DEFERRED_COMMAND_MESSAGE_CONDITION = `role = 'user' AND lower(trim(json_extract(payload_json, '$.text'), '${JAVASCRIPT_TRIM_WHITESPACE}')) = '/compact'`;
