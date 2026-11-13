import { itemState, STATUS_LABELS, STATUSES } from "./clarification.js";
import type { Review } from "./review/model.js";
import {
  ENTRY_LABELS,
  RESOLUTION_LABELS,
  type Entry,
  type ItemActivity,
  type Resolution,
} from "./store/entries.js";

function tableCell(text: string): string {
  return text.replace(/\r?\n/g, "<br>").replace(/(?<!\\)\|/g, "\\|");
}

const TIME_FORMAT = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" });

/** `YYYY-MM-DD HH:mm` in the server's time zone (`TZ`), shared by the site and the export. */
export function formatTime(iso: string): string {
  return TIME_FORMAT.format(new Date(iso));
}

export interface ExportInput {
  title: string;
  /** Paths of the review documents the items come from. */
  sources: string[];
  review: Review;
  /** Every entry, in ID order per item. */
  entries: Entry[];
  activity: Map<string, ItemActivity>;
  resolutions?: Resolution[];
  generatedAt: Date;
}

/**
 * Clarification record: a status summary per group, a table of every item with its current
 * clarification, then the full history of every item that has entries.
 */
export function renderExport(input: ExportInput): string {
  const { review, activity } = input;
  const byItem = new Map<string, Entry[]>();
  for (const entry of input.entries) {
    byItem.set(entry.itemId, [...(byItem.get(entry.itemId) ?? []), entry]);
  }
  const resolutionsByItem = new Map<string, Resolution[]>();
  for (const res of input.resolutions ?? []) {
    resolutionsByItem.set(res.itemId, [...(resolutionsByItem.get(res.itemId) ?? []), res]);
  }
  const state = (id: string) => {
    const item = review.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Unknown item ${id}`);
    return itemState(item, activity.get(id));
  };

  const out: string[] = [
    `# ${input.title} 澄清记录`,
    "",
    `> 本文件依据审核文档（${input.sources.map((source) => `\`${source}\``).join("、")}）与系统记录生成，导出时间：${formatTime(input.generatedAt.toISOString())}。条目描述以审核文档为准，以下汇总各方澄清结论与讨论历史。`,
    "",
    "## 汇总",
    "",
    `| 分组 | 条目数 | ${STATUSES.map((status) => STATUS_LABELS[status]).join(" | ")} | 待回复 |`,
    `| --- | --- | ${STATUSES.map(() => "---").join(" | ")} | --- |`,
  ];
  for (const group of review.groups) {
    const items = review.items.filter((item) => item.group === group);
    const states = items.map((item) => state(item.id));
    const counts = STATUSES.map((status) => states.filter((s) => s.status === status).length);
    const awaiting = states.filter((s) => s.awaitingReply).length;
    out.push(
      `| ${tableCell(group.title)} | ${items.length} | ${counts.join(" | ")} | ${awaiting} |`,
    );
  }

  for (const group of review.groups) {
    const items = review.items.filter((item) => item.group === group);
    out.push(
      "",
      `## ${group.title}`,
      "",
      "| 编号 | 标题 | 状态 | 当前澄清 | 澄清人 / 时间 |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const item of items) {
      const { status, awaitingReply, applied } = state(item.id);
      const clarification = activity.get(item.id)?.latestClarification;
      out.push(
        `| ${item.id} | ${tableCell(item.title)} | ${STATUS_LABELS[status]}${awaitingReply ? "（待回复）" : ""}${applied ? "（已落地）" : ""} | ${tableCell(
          clarification?.body ?? "",
        )} | ${
          clarification
            ? `${tableCell(clarification.author.displayName)} / ${formatTime(clarification.createdAt)}`
            : ""
        } |`,
      );
    }
    for (const item of items) {
      const history = byItem.get(item.id);
      const itemResolutions = resolutionsByItem.get(item.id);
      if (!history && !itemResolutions) continue;
      out.push("", `### ${item.id} ${item.title.replace(/\r?\n/g, " ")}`, "");
      for (const entry of history ?? []) {
        const stale = entry.itemDigest === item.digest ? "" : "（基于历史版本）";
        const quoted = entry.body.split(/\r?\n/).map((line) => `  > ${line}`);
        out.push(
          `- ${formatTime(entry.createdAt)} ${entry.author.displayName} ${ENTRY_LABELS[entry.kind]}${stale}：`,
          ...quoted,
        );
      }
      for (const res of itemResolutions ?? []) {
        const noteSuffix = res.note ? `：${res.note}` : "";
        out.push(
          `- ${formatTime(res.createdAt)} ${res.actor} ${RESOLUTION_LABELS[res.action]}（针对澄清 #${res.clarificationId}）${noteSuffix}`,
        );
      }
    }
  }

  // Records are never dropped: items removed from the review keep their history here.
  const known = new Set(review.items.map((item) => item.id));
  const orphaned = [...byItem.keys()].filter((id) => !known.has(id)).sort();
  if (orphaned.length) out.push("", "## 已从审核文档移除的条目");
  for (const id of orphaned) {
    out.push("", `### ${id}`, "");
    for (const entry of byItem.get(id) ?? []) {
      const quoted = entry.body.split(/\r?\n/).map((line) => `  > ${line}`);
      out.push(
        `- ${formatTime(entry.createdAt)} ${entry.author.displayName} ${ENTRY_LABELS[entry.kind]}：`,
        ...quoted,
      );
    }
  }
  return `${out.join("\n")}\n`;
}
