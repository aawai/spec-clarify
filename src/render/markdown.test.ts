import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocumentRenderer, createReviewRenderer, type RefEnv } from "./markdown.js";

const documents = new Map([
  ["prd/login.md", 200],
  ["prd/account.md", 300],
  ["规格/任务.md", 50],
  ["a/dup.md", 10],
  ["b/dup.md", 10],
]);
const resolve: RefEnv["resolve"] = (name) => {
  const exact = documents.get(name);
  if (exact) return { path: name, lineCount: exact };
  const matches = [...documents].filter(([path]) => path.endsWith(`/${name}`));
  const [match] = matches;
  return matches.length === 1 && match ? { path: match[0], lineCount: match[1] } : undefined;
};
const md = createReviewRenderer();
const links = (text: string, defaultDocument?: string) =>
  [
    ...md
      .renderInline(text, { defaultDocument, resolve })
      .matchAll(/<a href="([^"]+)" class="ref">([^<]+)<\/a>/g),
  ].map(([, href = "", label]) => {
    const params = new URL(href.replaceAll("&amp;", "&"), "http://x").searchParams;
    return `${label} -> ${params.get("path")}:${params.get("line")}-${params.get("end")}`;
  });

test("bare line references follow the last explicit file until a ；-clause ends", () => {
  assert.deepEqual(links(":7；account.md:110、:222；图@:23", "prd/login.md"), [
    ":7 -> prd/login.md:7-7",
    "account.md:110 -> prd/account.md:110-110",
    ":222 -> prd/account.md:222-222",
    "图@:23 -> prd/login.md:23-23",
  ]);
});

test("、-continued numbers and ranges link to the same file", () => {
  assert.deepEqual(links("图@:50–74、120", "prd/account.md"), [
    "图@:50–74 -> prd/account.md:50-74",
    "120 -> prd/account.md:120-120",
  ]);
});

test("resolves paths, non-ASCII names and file names written right after other text", () => {
  assert.deepEqual(links("见规格/任务.md:3，另见login.md:4"), [
    "规格/任务.md:3 -> 规格/任务.md:3-3",
    "login.md:4 -> prd/login.md:4-4",
  ]);
});

test("leaves clock times, URLs, ambiguous or unknown files and out-of-range lines as text", () => {
  assert.deepEqual(links("创建于 2026-11-04 18:04:38", "prd/login.md"), []);
  assert.deepEqual(links("http://host:8080/x", "prd/login.md"), []);
  assert.deepEqual(links("dup.md:3、other.md:3、login.md:999"), []);
  assert.deepEqual(links(":12 无默认文件"), []);
  assert.deepEqual(links("`login.md:5`"), []);
});

test("highlights the innermost blocks of the requested lines and anchors the first", () => {
  const source = "# 标题\n\n- 第一项\n- 第二项\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const renderer = createDocumentRenderer({ trustHtml: false });
  const rendered = renderer.render(source, { highlight: { start: 4, end: 4 } });
  assert.match(rendered, /<li data-line="4" class="hl" id="hl">/);
  assert.doesNotMatch(rendered, /<ul[^>]*class="hl"/);
  assert.equal(rendered.match(/class="hl"/g)?.length, 1);
  const row = renderer.render(source, { highlight: { start: 8, end: 8 } });
  assert.match(row, /<tr data-line="8" class="hl" id="hl">/);
});

test("raw HTML in documents is rendered only when the documents are trusted", () => {
  const source = '<font color="red">红</font>\n\n<img src="x" onerror="alert(1)">\n';
  assert.doesNotMatch(
    createDocumentRenderer({ trustHtml: false }).render(source, {}),
    /<img|<font/,
  );
  assert.match(
    createDocumentRenderer({ trustHtml: true }).render(source, {}),
    /<font color="red">/,
  );
});
