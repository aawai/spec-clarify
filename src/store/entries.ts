import { isRole, type Role } from "./users.js";
import type { Client, Row } from "@libsql/client";

export type EntryKind = "clarification" | "comment";

export const ENTRY_LABELS: Record<EntryKind, string> = {
  clarification: "澄清",
  comment: "评论",
};

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

  async activity(): Promise<Map<string, ItemActivity>> {
    const [summary, clarifications] = await Promise.all([
      this.client
        .execute(`SELECT item_id, COUNT(*) AS entry_count, MAX(created_at) AS last_activity,
          MAX(CASE WHEN kind = 'comment' THEN id END) AS latest_comment_id
        FROM entries GROUP BY item_id`),
      this.client.execute(`${SELECT} WHERE entries.id IN (
          SELECT MAX(id) FROM entries WHERE kind = 'clarification' GROUP BY item_id)`),
    ]);
    const latest = new Map(clarifications.rows.map((row) => [String(row.item_id), toEntry(row)]));
    return new Map(
      summary.rows.map((row) => {
        const itemId = String(row.item_id);
        const commentId = row.latest_comment_id;
        return [
          itemId,
          {
            latestClarification: latest.get(itemId),
            latestCommentId: commentId === null ? undefined : Number(commentId),
            entryCount: Number(row.entry_count),
            lastActivity: String(row.last_activity),
          },
        ];
      }),
    );
  }
}
