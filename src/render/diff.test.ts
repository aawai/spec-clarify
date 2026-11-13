import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, diffStats, formatUnifiedDiff, renderDiffHtml } from "./diff.js";

test("diffStats counts added and removed lines accurately", () => {
  assert.deepEqual(diffStats("a\nb\nc", "a\nb\nc"), { changed: false, added: 0, removed: 0 });
  assert.deepEqual(diffStats("a\nb\nc", "a\nB\nc\nd"), { changed: true, added: 2, removed: 1 });
  assert.deepEqual(diffStats(undefined, "x\ny"), { changed: true, added: 2, removed: 0 });
});

test("diffLines assigns dual line numbers across edits", () => {
  const lines = diffLines("line1\nline2\nline3", "line1\nline2b\nline3\nline4");
  assert.deepEqual(lines, [
    { type: "equal", oldLine: 1, newLine: 1, text: "line1" },
    { type: "del", oldLine: 2, text: "line2" },
    { type: "add", newLine: 2, text: "line2b" },
    { type: "equal", oldLine: 3, newLine: 3, text: "line3" },
    { type: "add", newLine: 4, text: "line4" },
  ]);
});

test("renderDiffHtml renders inline word/char diffs, escapes HTML, and folds long unchanged spans", () => {
  const oldDoc = [
    ...Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行内容`),
    "输错 5 次锁定 <script>alert(1)</script>",
    ...Array.from({ length: 10 }, (_, i) => `末尾 ${i + 1} 行`),
  ].join("\n");
  const newDoc = [
    ...Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行内容`),
    "输错 3 次锁定 <script>alert(1)</script>",
    ...Array.from({ length: 10 }, (_, i) => `末尾 ${i + 1} 行`),
  ].join("\n");

  const html = renderDiffHtml(oldDoc, newDoc);
  assert.match(html, /<del>5<\/del>/);
  assert.match(html, /<ins>3<\/ins>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<details class="diff__fold">/);
  // Dual line numbers on changed line (13 -> 13)
  assert.match(html, /<span class="diff__num">13<\/span><span class="diff__num"><\/span>/);
  assert.match(html, /<span class="diff__num"><\/span><span class="diff__num">13<\/span>/);
});

test("formatUnifiedDiff renders standard hunks with context and handles added/unchanged docs", () => {
  assert.equal(formatUnifiedDiff("a\nb", "a\nb"), "");
  assert.equal(
    formatUnifiedDiff(undefined, "line1\nline2", { newLabel: "v1/added.md" }),
    "--- /dev/null\n+++ v1/added.md\n@@ -0,0 +1,2 @@\n+line1\n+line2\n",
  );
  const oldDoc = Array.from({ length: 15 }, (_, i) => `row ${i + 1}`).join("\n");
  const newDoc = oldDoc.replace("row 2", "row 2b").replace("row 14", "row 14b");
  const patch = formatUnifiedDiff(oldDoc, newDoc, {
    oldLabel: "baseline/spec.md",
    newLabel: "v1/spec.md",
    contextLines: 1,
  });
  assert.match(patch, /^--- baseline\/spec\.md\n\+\+\+ v1\/spec\.md\n@@ -1,3 \+1,3 @@/m);
  assert.match(patch, /@@ -13,3 \+13,3 @@/);
  assert.match(patch, /-row 2\n\+row 2b/);
  assert.match(patch, /-row 14\n\+row 14b/);
});
