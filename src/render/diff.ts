export interface DiffStats {
  changed: boolean;
  added: number;
  removed: number;
}

export interface DiffLine {
  type: "equal" | "del" | "add";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface InlineSegment {
  type: "equal" | "del" | "add";
  text: string;
}

const CONTEXT_LINES = 3;
const MIN_FOLD_LINES = 3;

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Myers O(ND) shortest edit script over arbitrary string sequences. */
function myersDiff(a: readonly string[], b: readonly string[]): ("equal" | "del" | "add")[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array.from({ length: m }, () => "add");
  if (m === 0) return Array.from({ length: n }, () => "del");

  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        const ops: ("equal" | "del" | "add")[] = [];
        let bx = n;
        let by = m;
        for (let step = d; step > 0; step--) {
          const prev = trace[step]!;
          const bk = bx - by;
          const prevK =
            bk === -step || (bk !== step && prev[offset + bk - 1]! < prev[offset + bk + 1]!)
              ? bk + 1
              : bk - 1;
          const prevX = prev[offset + prevK]!;
          const prevY = prevX - prevK;
          while (bx > prevX && by > prevY) {
            ops.push("equal");
            bx--;
            by--;
          }
          if (bx === prevX) {
            ops.push("add");
            by--;
          } else {
            ops.push("del");
            bx--;
          }
        }
        while (bx > 0 && by > 0) {
          ops.push("equal");
          bx--;
          by--;
        }
        return ops.reverse();
      }
    }
    v = next;
  }
  return [];
}

/**
 * Computes line-by-line diff between `oldSource` (or `undefined` for newly added files) and
 * `newSource`, trimming matching outer lines before running Myers diff.
 */
export function diffLines(oldSource: string | undefined, newSource: string): DiffLine[] {
  const newLines = splitLines(newSource);
  if (oldSource === undefined) {
    return newLines.map((text, index) => ({ type: "add", newLine: index + 1, text }));
  }
  const oldLines = splitLines(oldSource);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    out.push({ type: "equal", oldLine: i + 1, newLine: i + 1, text: oldLines[i]! });
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  const ops = myersDiff(midOld, midNew);
  let oldIdx = prefix;
  let newIdx = prefix;
  for (const op of ops) {
    if (op === "equal") {
      out.push({
        type: "equal",
        oldLine: oldIdx + 1,
        newLine: newIdx + 1,
        text: oldLines[oldIdx]!,
      });
      oldIdx++;
      newIdx++;
    } else if (op === "del") {
      out.push({ type: "del", oldLine: oldIdx + 1, text: oldLines[oldIdx]! });
      oldIdx++;
    } else {
      out.push({ type: "add", newLine: newIdx + 1, text: newLines[newIdx]! });
      newIdx++;
    }
  }

  for (let i = 0; i < suffix; i++) {
    const oi = oldLines.length - suffix + i;
    const ni = newLines.length - suffix + i;
    out.push({ type: "equal", oldLine: oi + 1, newLine: ni + 1, text: oldLines[oi]! });
  }
  return out;
}

export function diffStats(oldSource: string | undefined, newSource: string): DiffStats {
  if (oldSource === newSource) return { changed: false, added: 0, removed: 0 };
  if (oldSource === undefined) {
    return { changed: true, added: splitLines(newSource).length, removed: 0 };
  }
  const lines = diffLines(oldSource, newSource);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { changed: added > 0 || removed > 0, added, removed };
}

function mergeSegments(segments: InlineSegment[]): InlineSegment[] {
  const merged: InlineSegment[] = [];
  for (const seg of segments) {
    const prev = merged.at(-1);
    if (prev && prev.type === seg.type) {
      prev.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

function diffInlinePair(
  oldText: string,
  newText: string,
): { oldSegs: InlineSegment[]; newSegs: InlineSegment[] } | undefined {
  const a = oldText.match(/[A-Za-z0-9_]+|\s+|./gu) ?? [];
  const b = newText.match(/[A-Za-z0-9_]+|\s+|./gu) ?? [];
  // Skip inline diff on very long lines to keep rendering bounded.
  if (a.length + b.length > 800) return undefined;
  const ops = myersDiff(a, b);
  let ai = 0;
  let bi = 0;
  let equalNonSpace = 0;
  const oldSegs: InlineSegment[] = [];
  const newSegs: InlineSegment[] = [];
  for (const op of ops) {
    if (op === "equal") {
      const tok = a[ai]!;
      if (tok.trim()) equalNonSpace++;
      oldSegs.push({ type: "equal", text: tok });
      newSegs.push({ type: "equal", text: tok });
      ai++;
      bi++;
    } else if (op === "del") {
      oldSegs.push({ type: "del", text: a[ai]! });
      ai++;
    } else {
      newSegs.push({ type: "add", text: b[bi]! });
      bi++;
    }
  }
  if (equalNonSpace === 0) return undefined;
  return { oldSegs: mergeSegments(oldSegs), newSegs: mergeSegments(newSegs) };
}

function renderInlineSegments(segments: InlineSegment[] | undefined, fallback: string): string {
  if (!segments) return escapeHtml(fallback);
  return segments
    .map((seg) => {
      const escaped = escapeHtml(seg.text);
      if (seg.type === "del") return `<del>${escaped}</del>`;
      if (seg.type === "add") return `<ins>${escaped}</ins>`;
      return escaped;
    })
    .join("");
}

function renderRow(line: DiffLine, inlineSegments?: InlineSegment[]): string {
  const oldNum = line.oldLine !== undefined ? String(line.oldLine) : "";
  const newNum = line.newLine !== undefined ? String(line.newLine) : "";
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  const body = renderInlineSegments(inlineSegments, line.text);
  return `<div class="diff__row diff__row--${line.type}"><span class="diff__num">${oldNum}</span><span class="diff__num">${newNum}</span><span class="diff__sign" aria-hidden="true">${marker}</span><span class="diff__code">${body || " "}</span></div>`;
}

/**
 * Renders a pure-HTML unified diff with dual line numbers, word/character inline highlights on
 * paired edits, and native `<details>` folds for long unchanged regions.
 */
export function renderDiffHtml(oldSource: string | undefined, newSource: string): string {
  const lines = diffLines(oldSource, newSource);
  const hasChange = lines.some((line) => line.type !== "equal");
  if (!hasChange) {
    return `<p class="muted">与对比版本内容一致，无增量变更。</p>`;
  }

  // Pair adjacent del + add blocks for inline highlights.
  const inlineMap = new Map<number, InlineSegment[]>();
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.type !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]!.type === "del") i++;
    const addStart = i;
    while (i < lines.length && lines[i]!.type === "add") i++;
    const paired = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < paired; k++) {
      const result = diffInlinePair(lines[delStart + k]!.text, lines[addStart + k]!.text);
      if (!result) continue;
      inlineMap.set(delStart + k, result.oldSegs);
      inlineMap.set(addStart + k, result.newSegs);
    }
  }

  // Mark lines visible in hunks (changed lines +/- CONTEXT_LINES).
  const visible = Array.from({ length: lines.length }, () => false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type === "equal") continue;
    const from = Math.max(0, i - CONTEXT_LINES);
    const to = Math.min(lines.length - 1, i + CONTEXT_LINES);
    for (let j = from; j <= to; j++) visible[j] = true;
  }

  const chunks: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (visible[i]) {
      chunks.push(renderRow(lines[i]!, inlineMap.get(i)));
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && !visible[i]) i++;
    const hidden = lines.slice(start, i);
    if (hidden.length < MIN_FOLD_LINES) {
      for (let j = start; j < i; j++) {
        chunks.push(renderRow(lines[j]!));
      }
      continue;
    }
    const firstNew = hidden[0]!.newLine;
    const lastNew = hidden.at(-1)!.newLine;
    const rangeLabel =
      firstNew !== undefined && lastNew !== undefined ? `第 ${firstNew}–${lastNew} 行` : "";
    chunks.push(
      `<details class="diff-Hunk-expand"><summary class="diff__expand">展开未变更的 ${hidden.length} 行${rangeLabel ? `（${rangeLabel}）` : ""}</summary><div class="diff__folded">${hidden.map((line) => renderRow(line)).join("")}</div></details>`,
    );
  }

  return `<div class="diff" role="region" aria-label="增量 Diff">${chunks.join("")}</div>`;
}
