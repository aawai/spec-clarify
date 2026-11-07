import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdownReview } from "./markdown.js";

const SOURCE = `# 审核

前言不是条目。

## 登录

### L1 锁定时长未定义
- 严重度：高
- 文档：specs/login.md
- 相关：L2、X9
- 建议：补充时长

:7 只写了次数。

- 正文里的列表：不是元数据

### L2 会话续期

\`\`\`md
### 代码块里的标题不是条目
\`\`\`

## 任务

### T1 删除确认
`;

test("every ### heading under a ## group becomes an item with its metadata and body", () => {
  const { groups, items } = parseMarkdownReview(SOURCE);
  assert.deepEqual(
    groups.map((group) => group.title),
    ["登录", "任务"],
  );
  assert.deepEqual(
    items.map((item) => [item.id, item.group.title, item.title]),
    [
      ["L1", "登录", "锁定时长未定义"],
      ["L2", "登录", "会话续期"],
      ["T1", "任务", "删除确认"],
    ],
  );
  const [l1, l2] = items;
  assert.equal(l1?.severity, "高");
  assert.equal(l1?.defaultDocument, "specs/login.md");
  assert.deepEqual(l1?.fields, [{ label: "建议", value: "补充时长" }]);
  assert.equal(l1?.body, ":7 只写了次数。\n\n- 正文里的列表：不是元数据");
  assert.equal(l1?.line, 7);
  assert.equal(l1?.endLine, 15);
  // Only IDs that exist are kept as related items.
  assert.deepEqual(l1?.related, ["L2"]);
  assert.match(l2?.body ?? "", /代码块里的标题不是条目/);
});

test("rejects item headings without an ID, items outside a group and duplicate IDs", () => {
  assert.throws(
    () => parseMarkdownReview("## 组\n\n### 没有编号的标题\n"),
    /Line 3: item headings must read/,
  );
  assert.throws(() => parseMarkdownReview("### A1 无分组\n"), /outside of a "##" group/);
  assert.throws(
    () => parseMarkdownReview("## 组\n\n### A1 一\n\n### A1 二\n"),
    /Duplicate item ID A1 at line 5/,
  );
});

test("reformatting whitespace keeps the digest; changing the content does not", () => {
  const [before] = parseMarkdownReview(SOURCE).items;
  const [spaced] = parseMarkdownReview(
    SOURCE.replace("- 建议：补充时长", "- 建议：   补充时长  "),
  ).items;
  const [edited] = parseMarkdownReview(SOURCE.replace("补充时长", "补充时长与解锁方式")).items;
  assert.equal(spaced?.digest, before?.digest);
  assert.notEqual(edited?.digest, before?.digest);
});
