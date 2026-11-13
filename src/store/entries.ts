import { isRole, type Role } from "./users.js";
import type { Client, Row } from "@libsql/client";

export type EntryKind = "clarification" | "comment";

export const ENTRY_LABELS: Record<EntryKind, string> = {
  clarification: "澄清",
  comment: "评论",
};

export type ResolutionAction = "applied" | "reopened";

export const RESOLUTION_LABELS: Record<ResolutionAction, string> = {
  applied: "已落地",
  reopened: "重新打开",
};

export interface Resolution {
  id: number;
  itemId: string;
  clarificationId: number;
  action: ResolutionAction;
  actor: string;
  note: string;
  createdAt: string;
}

export interface NewResolution {
  itemId: string;
  action: ResolutionAction;
  actor: string;
  note?: string;
  /** Optional optimistic check: must match the item's current latest clarification ID. */
  clarificationId?: number;
}

export type ResolveResult =
  | { ok: true; resolution: Resolution }
  | { ok: false; reason: "no_clarification" }
  | { ok: false; reason: "stale_clarification"; latest: Entry };

export interface Entry {
  id: number;
  itemId: string;
  kind: EntryKind;
  author: { id: number; username: string; displayName: string; role: Role };
  body: string;
  /** Digest of the item text the author was looking at. */
  itemDigest: string;
  createdAt: string;
}

export interface NewEntry {
  itemId: string;
  kind: EntryKind;
  userId: number;
  body: string;
  itemDigest: string;
  /** For clarifications: ID of the latest clarification the author saw (0 if none). */
  baseClarificationId?: number;
}

export type AddResult = { ok: true; entry: Entry } | { ok: false; latest: Entry };

export interface ItemActivity {
  latestClarification?: Entry;
  /** ID of the latest comment, to tell whether a question came in after the last clarification. */
  latestCommentId?: number;
  latestResolution?: Resolution;
  entryCount: number;
  lastActivity: string;
}

const SELECT = `SELECT entries.*, users.username, users.display_name, users.role
  FROM entries JOIN users ON users.id = entries.user_id`;

function toEntry(row: Row): Entry {
  const kind = String(row.kind);
  if (kind !== "clarification" && kind !== "comment") throw new Error(`Unknown entry kind ${kind}`);
  const role = String(row.role);
  if (!isRole(role)) throw new Error(`Unknown role ${role}`);
  return {
    id: Number(row.id),
    itemId: String(row.item_id),
    kind,
    author: {
      id: Number(row.user_id),
      username: String(row.username),
      displayName: String(row.display_name),
      role,
    },
    body: String(row.body),
    itemDigest: String(row.item_digest),
    createdAt: String(row.created_at),
  };
}
function toResolution(row: Row): Resolution {
  const action = String(row.action);
  if (action !== "applied" && action !== "reopened") {
    throw new Error(`Unknown resolution action ${action}`);
  }
  return {
    id: Number(row.id),
    itemId: String(row.item_id),
    clarificationId: Number(row.clarification_id),
    action,
    actor: String(row.actor),
    note: String(row.note),
    createdAt: String(row.created_at),
  };
}

/**
 * Append-only clarification log. An item's current answer is its latest clarification; a new
 * clarification must name the one it replaces, so two people answering at once cannot silently
 * bury each other's answer.
 */
export class EntryStore {
  constructor(private readonly client: Client) {}

  async add(entry: NewEntry, now = new Date()): Promise<AddResult> {
    const tx = await this.client.transaction("write");
    try {
      if (entry.kind === "clarification") {
        const latest = await tx.execute({
          sql: `${SELECT} WHERE entries.item_id = ? AND entries.kind = 'clarification'
                ORDER BY entries.id DESC LIMIT 1`,
          args: [entry.itemId],
        });
        const row = latest.rows[0];
        if (row && Number(row.id) !== entry.baseClarificationId) {
          await tx.rollback();
          return { ok: false, latest: toEntry(row) };
        }
      }
      const inserted = await tx.execute({
        sql: `INSERT INTO entries (item_id, kind, user_id, body, item_digest, created_at)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [
          entry.itemId,
          entry.kind,
          entry.userId,
          entry.body,
          entry.itemDigest,
          now.toISOString(),
        ],
      });
      const id = inserted.rows[0]?.id;
      const row = (await tx.execute({ sql: `${SELECT} WHERE entries.id = ?`, args: [id ?? null] }))
        .rows[0];
      await tx.commit();
      if (!row) throw new Error("INSERT returned no row");
      return { ok: true, entry: toEntry(row) };
    } finally {
      tx.close();
    }
  }

  async entriesFor(itemId: string): Promise<Entry[]> {
    const result = await this.client.execute({
      sql: `${SELECT} WHERE entries.item_id = ? ORDER BY entries.id`,
      args: [itemId],
    });
    return result.rows.map(toEntry);
  }

  async all(): Promise<Entry[]> {
    const result = await this.client.execute(`${SELECT} ORDER BY entries.item_id, entries.id`);
    return result.rows.map(toEntry);
  }
  async resolve(input: NewResolution, now = new Date()): Promise<ResolveResult> {
    const tx = await this.client.transaction("write");
    try {
      const latest = await tx.execute({
        sql: `${SELECT} WHERE entries.item_id = ? AND entries.kind = 'clarification'
              ORDER BY entries.id DESC LIMIT 1`,
        args: [input.itemId],
      });
      const latestRow = latest.rows[0];
      if (!latestRow) {
        await tx.rollback();
        return { ok: false, reason: "no_clarification" };
      }
      const clarificationId = Number(latestRow.id);
      if (input.clarificationId !== undefined && input.clarificationId !== clarificationId) {
        await tx.rollback();
        return { ok: false, reason: "stale_clarification", latest: toEntry(latestRow) };
      }
      const inserted = await tx.execute({
        sql: `INSERT INTO resolutions (item_id, clarification_id, action, actor, note, created_at)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [
          input.itemId,
          clarificationId,
          input.action,
          input.actor.trim() || "cli",
          input.note?.trim() ?? "",
          now.toISOString(),
        ],
      });
      const row = inserted.rows[0];
      await tx.commit();
      if (!row) throw new Error("INSERT returned no row");
      return { ok: true, resolution: toResolution(row) };
    } finally {
      tx.close();
    }
  }

  async resolutionsFor(itemId: string): Promise<Resolution[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM resolutions WHERE item_id = ? ORDER BY id`,
      args: [itemId],
    });
    return result.rows.map(toResolution);
  }

  async allResolutions(): Promise<Resolution[]> {
    const result = await this.client.execute(`SELECT * FROM resolutions ORDER BY item_id, id`);
    return result.rows.map(toResolution);
  }

  async activity(): Promise<Map<string, ItemActivity>> {
    const [summary, clarifications, resolutions] = await Promise.all([
      this.client
        .execute(`SELECT item_id, COUNT(*) AS entry_count, MAX(created_at) AS last_activity,
          MAX(CASE WHEN kind = 'comment' THEN id END) AS latest_comment_id
        FROM entries GROUP BY item_id`),
      this.client.execute(`${SELECT} WHERE entries.id IN (
          SELECT MAX(id) FROM entries WHERE kind = 'clarification' GROUP BY item_id)`),
      this.client.execute(`SELECT * FROM resolutions WHERE id IN (
          SELECT MAX(id) FROM resolutions GROUP BY item_id)`),
    ]);
    const latest = new Map(clarifications.rows.map((row) => [String(row.item_id), toEntry(row)]));
    const latestResolutions = new Map(
      resolutions.rows.map((row) => [String(row.item_id), toResolution(row)]),
    );
    return new Map(
      summary.rows.map((row) => {
        const itemId = String(row.item_id);
        const commentId = row.latest_comment_id;
        return [
          itemId,
          {
            latestClarification: latest.get(itemId),
            latestCommentId: commentId === null ? undefined : Number(commentId),
            latestResolution: latestResolutions.get(itemId),
            entryCount: Number(row.entry_count),
            lastActivity: String(row.last_activity),
          },
        ];
      }),
    );
  }
}
