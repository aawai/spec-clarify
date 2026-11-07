import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExcerpts, type Excerpt } from "./excerpt.js";

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `第 ${index + 1} 行`).join("\n");
const sources = new Map([
  ["a.md", lines(100)],
  ["b.md", lines(20)],
]);
const source = (path: string) => sources.get(path);

/** Each window as `start-end` with hit line numbers, e.g. `7-13 hits 10`. */
const shape = (excerpts: Excerpt[]) =>
  excerpts.map(({ path, windows }) => ({
    path,
    windows: windows.map(
      (window) =>
        `${window.start}-${window.end} hits ${window.lines
          .filter((line) => line.hit)
          .map((line) => line.number)
          .join(",")}`,
    ),
  }));

test("documents keep the order of their first reference and nearby ranges share a window", () => {
  const excerpts = buildExcerpts(
    [
      { path: "b.md", start: 15, end: 15 },
      { path: "a.md", start: 10, end: 10 },
      { path: "a.md", start: 60, end: 61 },
      { path: "a.md", start: 14, end: 14 },
      { path: "b.md", start: 15, end: 15 },
    ],
    source,
  );
  assert.deepEqual(shape(excerpts), [
    { path: "b.md", windows: ["12-18 hits 15"] },
    { path: "a.md", windows: ["7-17 hits 10,14", "57-64 hits 60,61"] },
  ]);
  assert.equal(excerpts[1]?.windows[0]?.lines[3]?.text, "第 10 行");
});

test("context stops at the start and end of the document", () => {
  assert.deepEqual(
    shape(
      buildExcerpts(
        [
          { path: "b.md", start: 1, end: 1 },
          { path: "b.md", start: 20, end: 20 },
        ],
        source,
      ),
    ),
    [{ path: "b.md", windows: ["1-4 hits 1", "17-20 hits 20"] }],
  );
});

test("a long referenced range keeps both of its ends and leaves out the middle", () => {
  const [excerpt] = buildExcerpts([{ path: "a.md", start: 5, end: 90 }], source);
  const windows = excerpt?.windows ?? [];
  assert.deepEqual(
    windows.map((window) => [window.start, window.end, window.lines.length]),
    [
      [2, 21, 20],
      [74, 93, 20],
    ],
  );
  const hits = windows.flatMap((window) => window.lines.filter((line) => line.hit));
  assert.equal(hits.at(0)?.number, 5);
  assert.equal(hits.at(-1)?.number, 90);
});

test("references to unknown documents are skipped", () => {
  assert.deepEqual(buildExcerpts([{ path: "gone.md", start: 1, end: 1 }], source), []);
});
