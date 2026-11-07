import MarkdownIt from "markdown-it";

/** A resolved, in-range line reference from review text (`文件:行号`). */
export interface DocRef {
  path: string;
  start: number;
  end: number;
}

export interface ExcerptLine {
  /** 1-based line number in the source document. */
  number: number;
  text: string;
  /** Whether a reference points at this line, as opposed to surrounding context. */
  hit: boolean;
}

export interface ExcerptWindow {
  start: number;
  end: number;
  lines: ExcerptLine[];
}

export interface Excerpt {
  path: string;
  windows: ExcerptWindow[];
}

/** Lines of context shown above and below each referenced range. */
const CONTEXT_LINES = 3;
/**
 * Keeps a reference to a whole section from turning the item page into the document: a longer
 * window shows only its first and last `MAX_WINDOW_LINES / 2` lines, so both ends of the
 * referenced range stay visible and the middle is left to the document view.
 */
const MAX_WINDOW_LINES = 40;

const markdown = new MarkdownIt({ html: true });

/**
 * Source lines around every reference, one excerpt per document in order of first reference.
 * Ranges whose context overlaps or touches share a window, so each line is shown once.
 */
export function buildExcerpts(
  refs: readonly DocRef[],
  source: (path: string) => string | undefined,
): Excerpt[] {
  const byPath = new Map<string, DocRef[]>();
  for (const ref of refs) byPath.set(ref.path, [...(byPath.get(ref.path) ?? []), ref]);

  const excerpts: Excerpt[] = [];
  for (const [path, docRefs] of byPath) {
    const text = source(path);
    if (text === undefined) continue;
    const lines = text.split("\n");
    // Use parsed headings rather than a line-only regex so fenced and indented code stays intact.
    const headingLines = new Set<number>();
    const verbatimLines = new Set<number>();
    for (const token of markdown.parse(text, {})) {
      if (!token.map) continue;
      if (token.type === "heading_open" && token.markup.startsWith("#")) {
        headingLines.add(token.map[0] + 1);
      } else if (
        token.type === "fence" ||
        token.type === "code_block" ||
        token.type === "html_block"
      ) {
        for (let line = token.map[0] + 1; line <= token.map[1]; line++) verbatimLines.add(line);
      }
    }
    const hits = new Set<number>();
    const spans: { start: number; end: number }[] = [];
    for (const ref of [...docRefs].sort((a, b) => a.start - b.start)) {
      for (let line = ref.start; line <= ref.end; line++) hits.add(line);
      const start = Math.max(1, ref.start - CONTEXT_LINES);
      const end = Math.min(lines.length, ref.end + CONTEXT_LINES);
      const last = spans.at(-1);
      if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
      else spans.push({ start, end });
    }
    const window = (start: number, end: number): ExcerptWindow => {
      const excerptLines = lines.slice(start - 1, end).map((line, index) => {
        const number = start + index;
        return {
          number,
          text: headingLines.has(number)
            ? line.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, "").replace(/[ \t]+#+[ \t]*$/, "")
            : line,
          hit: hits.has(number),
        };
      });
      // Keep referenced blank lines, but suppress redundant and edge-only context whitespace.
      const compact = excerptLines.filter((line, index) => {
        if (line.hit || line.text.trim() || verbatimLines.has(line.number)) return true;
        if (index === 0 || index === excerptLines.length - 1) return false;
        return Boolean(excerptLines[index - 1]?.text.trim());
      });
      return { start, end, lines: compact };
    };
    const half = MAX_WINDOW_LINES / 2;
    excerpts.push({
      path,
      windows: spans.flatMap(({ start, end }) =>
        end - start + 1 > MAX_WINDOW_LINES
          ? [window(start, start + half - 1), window(end - half + 1, end)]
          : [window(start, end)],
      ),
    });
  }
  return excerpts;
}
