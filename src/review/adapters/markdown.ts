import { z } from "zod";
import { buildReview, type ItemDraft, type Review, type ReviewGroup } from "../model.js";

/**
 * Default review format:
 *
 * ```md
 * ## 分组标题
 *
 * ### ID 条目标题
 * - 严重度：高
 * - 文档：specs/login.md
 * - 相关：A2、B1
 * - 其他字段：值
 *
 * 正文 Markdown……
 * ```
 *
 * Every `###` heading inside a `##` group is one item and must start with its ID. The metadata
 * list is optional and must directly follow the heading; the body runs to the next `##`/`###`.
 */
export const markdownOptions = z.object({}).strict();

const ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const META = /^- ([^:：\n]{1,20})[:：]\s*(.*)$/;
const SEVERITY_LABELS = new Set(["严重度", "severity"]);
const DOCUMENT_LABELS = new Set(["文档", "document"]);
const RELATED_LABELS = new Set(["相关", "related"]);

export function parseMarkdownReview(source: string): Review {
  const lines = source.split("\n");
  const groups: ReviewGroup[] = [];
  const drafts: ItemDraft[] = [];
  let group: ReviewGroup | undefined;
  let item: { draft: ItemDraft; start: number; metaDone: boolean; body: string[] } | undefined;
  let fence: string | undefined;

  const closeItem = () => {
    if (!item) return;
    const body = item.body.join("\n").trim();
    drafts.push({ ...item.draft, body: body || undefined });
    item = undefined;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fenceMark = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark && (!fence || fenceMark.startsWith(fence))) {
      fence = fence ? undefined : fenceMark;
    }
    const heading = fence || fenceMark ? undefined : /^(#{2,3}) (.+)$/.exec(line);

    if (heading?.[1] === "##") {
      closeItem();
      const title = heading[2]?.trim() ?? "";
      if (groups.some((existing) => existing.key === title)) {
        throw new Error(`Line ${index + 1}: duplicate group "${title}"`);
      }
      group = { key: title, title, label: title, section: "分组" };
      groups.push(group);
      continue;
    }
    if (heading?.[1] === "###") {
      closeItem();
      if (!group) throw new Error(`Line ${index + 1}: item heading outside of a "##" group`);
      const [id = "", ...titleParts] = (heading[2] ?? "").trim().split(/\s+/);
      if (!ITEM_ID.test(id) || titleParts.length === 0) {
        throw new Error(
          `Line ${index + 1}: item headings must read "### <ID> <标题>" with an ID such as A1 or login-3`,
        );
      }
      item = {
        draft: {
          id,
          group,
          title: titleParts.join(" "),
          fields: [],
          relatedText: [],
          line: index + 1,
          endLine: index + 1,
        },
        start: index,
        metaDone: false,
        body: [],
      };
      continue;
    }
    if (!item) continue;

    const meta = item.metaDone ? undefined : META.exec(line);
    if (meta) {
      const label = meta[1]?.trim() ?? "";
      const value = meta[2]?.trim() ?? "";
      const key = label.toLowerCase();
      if (SEVERITY_LABELS.has(key)) item.draft.severity = value || undefined;
      else if (DOCUMENT_LABELS.has(key)) item.draft.defaultDocument = value || undefined;
      else if (RELATED_LABELS.has(key)) item.draft.relatedText.push(value);
      else item.draft.fields.push({ label, value });
      item.draft.endLine = index + 1;
      continue;
    }
    // Blank lines between the heading and the metadata list are allowed; the first blank line
    // after metadata, or any other line, starts the body.
    if (!item.metaDone && !line.trim() && item.draft.endLine === item.draft.line) continue;
    item.metaDone = true;
    item.body.push(line);
    if (line.trim()) item.draft.endLine = index + 1;
  }
  closeItem();
  return buildReview(groups, drafts);
}
