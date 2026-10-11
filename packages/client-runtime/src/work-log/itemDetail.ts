import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// NOTE: upstream's `work-log/itemDetail` module is larger (tool value
// formatting, `turnItemHasDetail`, image helpers). Only the revision key is
// ported here; port the rest with the expanded-tool-row work if needed.
const LIVE_TURN_ITEM_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

/**
 * Cache key for a fetched item. A running item keeps one key, so an open row
 * fetches once while it streams and again when it finishes, not on every update.
 */
export function turnItemDetailRevision(item: OrchestrationV2TurnItem): string {
  return LIVE_TURN_ITEM_STATUSES.has(item.status) ? "live" : DateTime.formatIso(item.updatedAt);
}
