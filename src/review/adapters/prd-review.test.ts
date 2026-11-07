import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import { buildReview } from "../model.js";
import { parsePrdReview as parseDocument, type prdReviewOptions } from "./prd-review.js";

const parsePrdReview = (source: string, adapterOptions: z.infer<typeof prdReviewOptions>) =>
  buildReview([parseDocument(source, "prd-review.md", adapterOptions)]);

const options = { modules: { "login.md": "L" } };

const FIXTURE = `# PRD 审核报告

## 2. 直接矛盾

| # | 矛盾 | 位置 |
| --- | --- | --- |
| C1 | 两份文档对锁定次数说法不同 | login.md:5 |

## 4. 未定义的共享规则

### G1 账号来源

账号由谁创建未定义。

- 第一个管理员如何产生。

## 附录 A：分模块审核明细

### A.1 login.md

#### 问题清单

| ID | 维度 | 严重度 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- | --- |
| L01 | 清晰性 | 低 | :9 | 按钮“关闭\\|”多了竖线 | 删除 |

#### 图中独有的规则

| # | 图片 | 规则 |
| --- | --- | --- |
| 1 | 图@:3 | 图中先判断锁定 |
| 2 | 图@:4 | 图中不记日志 |

#### 图文冲突

| # | 图片 | 正文 | 冲突 | 相关条目 |
| --- | --- | --- | --- | --- |
| 1 | 图@:3 | :5 | 提示不一致 | L01、C1 |

#### 需产品决策的问题

1. 锁定多久？（L01）
2. 是否需要验证码？（L01、C1）
`;

test("tables, G sections and questions become items numbered by the module prefix", () => {
  const { groups, items } = parsePrdReview(FIXTURE, options);
  assert.deepEqual(
    items.map((item) => item.id),
    ["C1", "G1", "L01", "L-F1", "L-F2", "L-X1", "L-Q1", "L-Q2"],
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.section, group.defaultDocument]),
    [
      ["prd-review.md#contradiction", "跨模块", undefined],
      ["prd-review.md#shared-rule", "跨模块", undefined],
      ["prd-review.md#login.md/issue", "login.md", "login.md"],
      ["prd-review.md#login.md/figure-rule", "login.md", "login.md"],
      ["prd-review.md#login.md/figure-conflict", "login.md", "login.md"],
      ["prd-review.md#login.md/question", "login.md", "login.md"],
    ],
  );
  const l01 = items.find((item) => item.id === "L01");
  assert.equal(l01?.title, "按钮“关闭\\|”多了竖线");
  assert.equal(l01?.severity, "低");
  assert.equal(
    items.find((item) => item.id === "G1")?.body,
    "账号由谁创建未定义。\n\n- 第一个管理员如何产生。",
  );
  assert.deepEqual(items.find((item) => item.id === "L-X1")?.related, ["L01", "C1"]);
  assert.deepEqual(items.find((item) => item.id === "L-Q2")?.related, ["L01", "C1"]);
});

test("figure-rule numbers come from the # column, so inserting a row does not renumber others", () => {
  const inserted = FIXTURE.replace(
    "| 1 | 图@:3 | 图中先判断锁定 |",
    "| 3 | 图@:2 | 新增的规则 |\n| 1 | 图@:3 | 图中先判断锁定 |",
  );
  const items = parsePrdReview(inserted, options).items;
  assert.equal(items.find((item) => item.id === "L-F1")?.title, "图中先判断锁定");
  assert.equal(items.find((item) => item.id === "L-F3")?.title, "新增的规则");
});

test("re-aligning a table row keeps the item's digest", () => {
  const before = parsePrdReview(FIXTURE, options).items.find((item) => item.id === "L-F1");
  const after = parsePrdReview(
    FIXTURE.replace("| 1 | 图@:3 | 图中先判断锁定 |", "|  1  |  图@:3  |  图中先判断锁定    |"),
    options,
  ).items.find((item) => item.id === "L-F1");
  assert.equal(after?.digest, before?.digest);
});

test("rejects tables that cannot yield stable IDs or titles, and unknown modules", () => {
  assert.throws(
    () => parsePrdReview(FIXTURE.replace("| # | 图片 | 规则 |", "| 图片 | 规则 |"), options),
    /lacks the # column/,
  );
  assert.throws(
    () => parsePrdReview(FIXTURE.replace("| # | 图片 | 规则 |", "| # | 图片 | 说明 |"), options),
    /lacks the 规则 column/,
  );
  assert.throws(() => parsePrdReview(FIXTURE, { modules: {} }), /module login.md has no ID prefix/);
  assert.throws(
    () => parsePrdReview(FIXTURE.replace("| L01 |", "| C1 |"), options),
    /Duplicate item ID C1/,
  );
});
