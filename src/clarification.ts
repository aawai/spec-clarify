import type { ReviewItem } from "./review/model.js";
import type { ItemActivity } from "./store/entries.js";

/**
 * - `open`: no clarification yet.
 * - `clarified`: the latest clarification was given on the current item text.
 * - `stale`: the item changed after its latest clarification and needs another look.
 */
export type ItemStatus = "open" | "clarified" | "stale";

export const STATUS_LABELS: Record<ItemStatus, string> = {
  open: "未澄清",
  clarified: "已澄清",
  stale: "需复核",
};

export const STATUSES = Object.keys(STATUS_LABELS) as ItemStatus[];

export interface ItemState {
  status: ItemStatus;
  /** A comment arrived after the latest clarification (or before any), so someone awaits an answer. */
  awaitingReply: boolean;
}

export function itemState(
  item: Pick<ReviewItem, "digest">,
  activity: ItemActivity | undefined,
): ItemState {
  const clarification = activity?.latestClarification;
  const status: ItemStatus = !clarification
    ? "open"
    : clarification.itemDigest === item.digest
      ? "clarified"
      : "stale";
  const awaitingReply =
    activity?.latestCommentId !== undefined && activity.latestCommentId > (clarification?.id ?? 0);
  return { status, awaitingReply };
}
