import { createHash } from "node:crypto";

export interface ReviewGroup {
  /** Stable key used in URLs and filters; unique across all review documents of a project. */
  key: string;
  /** Path of the review document the group comes from, relative to the project root. */
  source: string;
  /** Full title, used in breadcrumbs, item lists and the export. */
  title: string;
  /** Short label shown in the navigation under `section`. */
  label: string;
  /** Navigation heading the group is listed under. */
  section: string;
  /** Document that bare `:行号` references in this group resolve to. */
  defaultDocument?: string;
}

export interface ReviewField {
  label: string;
  /** Inline Markdown. */
  value: string;
}

export interface ReviewItem {
  /** Author-assigned and stable; clarification records are keyed by it. */
  id: string;
  group: ReviewGroup;
  title: string;
  severity?: string;
  fields: ReviewField[];
  /** Block Markdown. */
  body?: string;
  /** IDs of other items this item names; only IDs that exist in the project are kept. */
  related: string[];
  /** Overrides the group's default document for bare line references. */
  defaultDocument?: string;
  /** 1-based line range of the item in its review document (`group.source`). */
  line: number;
  endLine: number;
  /** Changes whenever the item's content changes; whitespace and table alignment do not count. */
  digest: string;
}

export interface Review {
  groups: ReviewGroup[];
  items: ReviewItem[];
}

/** What an adapter extracts; IDs of related items and digests are resolved by `buildReview`. */
export interface ItemDraft extends Omit<ReviewItem, "related" | "digest"> {
  /** Free text that may name other items, e.g. a "related" column. */
  relatedText: string[];
}

/** Output of an adapter for one review document. */
export interface ParsedReview {
  groups: ReviewGroup[];
  drafts: ItemDraft[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function digestOf(draft: ItemDraft): string {
  const content = JSON.stringify([
    normalize(draft.title),
    normalize(draft.severity ?? ""),
    draft.fields.map((field) => [normalize(field.label), normalize(field.value)]),
    normalize(draft.body ?? ""),
    // Bare `:行号` references in the item point into this document.
    draft.defaultDocument ?? "",
  ]);
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Merges the review documents of a project. Item IDs must be unique across all of them, because
 * clarification records are keyed by ID alone; related items may live in any document.
 */
export function buildReview(parts: ParsedReview[]): Review {
  const groups = parts.flatMap((part) => part.groups);
  const drafts = parts.flatMap((part) => part.drafts);
  const known = new Map<string, ItemDraft>();
  for (const draft of drafts) {
    const previous = known.get(draft.id);
    if (previous) {
      throw new Error(
        `Duplicate item ID ${draft.id}: ${previous.group.source}:${previous.line} and ${draft.group.source}:${draft.line}`,
      );
    }
    known.set(draft.id, draft);
  }
  const groupKeys = new Set<string>();
  for (const group of groups) {
    if (groupKeys.has(group.key)) throw new Error(`Duplicate group ${group.key}`);
    groupKeys.add(group.key);
  }
  const items = drafts.map(({ relatedText, ...draft }): ReviewItem => {
    const related = new Set<string>();
    for (const token of relatedText.join(" ").split(/[^\p{L}\p{N}_-]+/u)) {
      if (token !== draft.id && known.has(token)) related.add(token);
    }
    return { ...draft, related: [...related], digest: digestOf({ ...draft, relatedText }) };
  });
  return { groups, items };
}

/** Splits a Markdown table row, keeping escaped pipes (`\|`) inside their cell. */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\" && body[i + 1] === "|") {
      current += "\\|";
      i++;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function isDelimiterRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}
