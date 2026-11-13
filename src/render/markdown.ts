import MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type Token from "markdown-it/lib/token.mjs";
import type { DocRef } from "./excerpt.js";

export interface RefTarget {
  path: string;
  lineCount: number;
  /** Optional display name; reference parsing and URLs continue to use the path. */
  title?: string;
  /** Revision metadata when `path` points to a revision file rather than a baseline document. */
  revision?: { id: string; basePath: string };
}

export interface RefEnv {
  /** Document that bare `:行号` references resolve to until an explicit `file.md:` appears. */
  defaultDocument?: string;
  /** Resolves a document name from the review text; unresolved references stay plain text. */
  resolve(name: string): RefTarget | undefined;
  /** When set, every reference that became a link is appended here, in text order. */
  refs?: DocRef[];
}

/**
 * Matches:
 * 1. Line references: `文件:行号`, `图@文件:行号`, `@/文件:行号`, `:行号` and `、`-continued lists.
 * 2. Bare document references: `文件.md` or `@/文件.md` without line numbers.
 * The look-behind keeps clock times (`18:04:38`), URLs and e-mail addresses from matching.
 */
const REF =
  /(?<![A-Za-z0-9_:/.@-])(?:(\p{L}{1,4}@)?(?:(@\/)?((?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.md))?:(\d+(?:[–-]\d+)?(?:、\d+(?:[–-]\d+)?)*)|(@\/)?((?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.md)(?![A-Za-z0-9_./-]|:\d))/gu;

export function docHref(path: string, start?: number, end = start, rev?: string): string {
  const params = new URLSearchParams({ path });
  if (rev) params.set("rev", rev);
  if (start !== undefined) {
    params.set("line", String(start));
    params.set("end", String(end));
  }
  return `/docs/view?${params}${start === undefined ? "" : "#hl"}`;
}

function pushText(state: StateCore, out: Token[], content: string) {
  if (!content) return;
  const token = new state.Token("text", "", 0);
  token.content = content;
  out.push(token);
}

/**
 * Text directly before a file name (e.g. `见login.md`) is matched as part of it, so the longest
 * suffix that names a known document wins; the rest stays text.
 */
function splitFile(token: string, env: RefEnv): { lead: string; file: string } {
  for (let start = 0; start < token.length; start++) {
    if (start > 0 && !/^[\p{L}\p{N}_]/u.test(token.slice(start))) continue;
    const candidate = token.slice(start);
    if (env.resolve(candidate)) return { lead: token.slice(0, start), file: candidate };
  }
  return { lead: "", file: token };
}

function linkRefs(state: StateCore) {
  // markdown-it types `env` as `any`; this renderer is always called with a RefEnv.
  const env: RefEnv = state.env;
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    // `；`/`;` closes a clause; within a clause a bare `:行号` follows the last explicit file.
    let currentFile = env.defaultDocument;
    let linkDepth = 0;
    const children: Token[] = [];
    for (const child of block.children) {
      if (child.type === "link_open") {
        linkDepth++;
        children.push(child);
        continue;
      }
      if (child.type === "link_close") {
        linkDepth = Math.max(0, linkDepth - 1);
        children.push(child);
        continue;
      }
      if (child.type !== "text" || linkDepth > 0) {
        children.push(child);
        continue;
      }
      let cursor = 0;
      for (const match of child.content.matchAll(REF)) {
        const before = child.content.slice(cursor, match.index);
        if (/[；;]/.test(before)) currentFile = env.defaultDocument;
        pushText(state, children, before);
        cursor = match.index + match[0].length;

        const [, matchedLabel = "", atSlash = "", rawFile, list, bareAtSlash = "", bareFile] =
          match;
        if (bareFile !== undefined) {
          const { lead, file } = bareAtSlash
            ? { lead: "", file: bareFile }
            : splitFile(bareFile, env);
          const target = env.resolve(file);
          if (!target) {
            pushText(state, children, match[0]);
            continue;
          }
          pushText(state, children, lead);
          currentFile = file;
          const open = new state.Token("link_open", "a", 1);
          open.attrSet(
            "href",
            target.revision
              ? docHref(target.revision.basePath, undefined, undefined, target.revision.id)
              : docHref(target.path),
          );
          open.attrSet("class", "ref");
          children.push(open);
          pushText(state, children, target.title ?? target.path);
          children.push(new state.Token("link_close", "a", -1));
          continue;
        }

        if (atSlash && !rawFile) {
          pushText(state, children, match[0]);
          continue;
        }
        const { lead, file } = rawFile
          ? atSlash
            ? { lead: "", file: rawFile }
            : splitFile(rawFile, env)
          : { lead: "", file: undefined };
        // A `<label>@` prefix only belongs to the reference when it directly precedes the file.
        const label = lead ? "" : matchedLabel;
        pushText(state, children, lead ? matchedLabel + lead : "");
        if (file) currentFile = file;
        const target = currentFile ? env.resolve(currentFile) : undefined;
        const prefix = `${label}${file ?? ""}:`;
        (list ?? "").split("、").forEach((range, position) => {
          if (position > 0) pushText(state, children, "、");
          const text = position === 0 ? `${prefix}${range}` : range;
          const [start = 0, end = start] = range.split(/[–-]/).map(Number);
          if (!target || start < 1 || end < start || end > target.lineCount) {
            pushText(state, children, position === 0 && !lead ? `${atSlash}${text}` : text);
            return;
          }
          const open = new state.Token("link_open", "a", 1);
          env.refs?.push({ path: target.path, start, end });
          open.attrSet(
            "href",
            target.revision
              ? docHref(target.revision.basePath, start, end, target.revision.id)
              : docHref(target.path, start, end),
          );
          open.attrSet("class", "ref");
          children.push(open);
          let display =
            position === 0 && file ? text : `${position === 0 ? label : ""}${target.path}:${range}`;
          if (target.title) display = `${position === 0 ? label : ""}${target.title}:${range}`;
          pushText(state, children, display);
          children.push(new state.Token("link_close", "a", -1));
        });
      }
      pushText(state, children, child.content.slice(cursor));
    }
    block.children = children;
  }
}

/** Review text: no raw HTML; line and document references become links into the document viewer. */
export function createReviewRenderer(options?: { breaks?: boolean }) {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: options?.breaks ?? false });
  md.core.ruler.push("doc_refs", linkRefs);
  return md;
}

export interface Highlight {
  start: number;
  end: number;
}

/**
 * Tags every block with its 1-based source line and highlights the innermost blocks that overlap
 * the requested range; the first highlighted block receives `id="hl"` for fragment navigation.
 */
function annotateLines(state: StateCore) {
  // markdown-it types `env` as `any`; this renderer is called with `{ highlight? }`.
  const { highlight }: { highlight?: Highlight } = state.env;
  const stack: { token: Token; marked: boolean }[] = [];
  let anchored = false;
  for (const token of state.tokens) {
    if (token.nesting === -1) {
      stack.pop();
      continue;
    }
    let marked = false;
    if (token.map && token.type !== "inline") {
      const [from, to] = token.map;
      token.attrSet("data-line", String(from + 1));
      // Tight-list paragraphs render no element of their own, so the list item keeps the mark.
      marked =
        !token.hidden && Boolean(highlight && from < highlight.end && to > highlight.start - 1);
    }
    if (marked) {
      for (const ancestor of stack) {
        if (!ancestor.marked) continue;
        ancestor.marked = false;
        ancestor.token.attrSet("class", "");
      }
      token.attrSet("class", "hl");
    }
    if (token.nesting === 1) stack.push({ token, marked });
  }
  for (const token of state.tokens) {
    if (token.attrGet("class") === "")
      token.attrs = token.attrs?.filter(([name]) => name !== "class") ?? null;
    if (anchored || token.attrGet("class") !== "hl") continue;
    token.attrSet("id", "hl");
    anchored = true;
  }
}

/**
 * Source documents with line annotations. Raw HTML is rendered only for trusted documents; HTML
 * blocks are wrapped so they can carry line attributes too.
 */
export function createDocumentRenderer(options: { trustHtml: boolean }) {
  const md = new MarkdownIt({ html: options.trustHtml, linkify: false });
  md.core.ruler.push("line_annotations", annotateLines);
  md.renderer.rules.html_block = (tokens, index, _options, _env, self) => {
    const token = tokens[index];
    if (!token) return "";
    return `<div${self.renderAttrs(token)}>${token.content}</div>\n`;
  };
  return md;
}
