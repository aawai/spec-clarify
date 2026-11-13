import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProjectConfig, loadWorkspace, SourceError } from "./project.js";

async function withProject(
  files: Record<string, string>,
  config: object,
  run: (configPath: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    await writeFile(join(dir, "spec-clarify.config.json"), JSON.stringify(config));
    await run(join(dir, "spec-clarify.config.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LOGIN_REVIEW = "# 登录审核\n\n## 问题\n\n### L1 锁定时长\n\n- 相关：T1\n";
const TASK_REVIEW = "# 任务审核\n\n## 问题\n\n### T1 删除确认\n";

test("several review documents form one site with separate groups and cross-document links", async () => {
  await withProject(
    { "reviews/login.md": LOGIN_REVIEW, "reviews/tasks.md": TASK_REVIEW },
    { reviews: [{ path: "reviews/login.md" }, { path: "./reviews/tasks.md", title: "任务" }] },
    async (configPath) => {
      const { review, reviews } = await loadWorkspace(await loadProjectConfig(configPath));
      assert.deepEqual(
        reviews.map((doc) => [doc.path, doc.title]),
        [
          ["reviews/login.md", "登录审核"],
          ["reviews/tasks.md", "任务"],
        ],
      );
      // Groups with the same heading stay apart and are listed under their document.
      assert.deepEqual(
        review.groups.map((group) => [group.source, group.title, group.section]),
        [
          ["reviews/login.md", "登录审核 · 问题", "登录审核"],
          ["reviews/tasks.md", "任务 · 问题", "任务"],
        ],
      );
      assert.notEqual(review.groups[0]?.key, review.groups[1]?.key);
      const [l1, t1] = review.items;
      assert.equal(t1?.group.source, "reviews/tasks.md");
      assert.equal(t1?.line, 5);
      assert.deepEqual(l1?.related, ["T1"]);
    },
  );
});

test("an item ID used in two review documents stops the site and names both places", async () => {
  await withProject(
    { "a.md": LOGIN_REVIEW, "b.md": LOGIN_REVIEW.replace("锁定时长", "另一个问题") },
    { reviews: [{ path: "a.md" }, { path: "b.md" }] },
    async (configPath) => {
      await assert.rejects(
        loadWorkspace(await loadProjectConfig(configPath)),
        (error) =>
          error instanceof SourceError &&
          error.message === "Duplicate item ID L1: a.md:5 and b.md:5",
      );
    },
  );
});

test("rejects a review listed twice or outside the project", async () => {
  await withProject(
    { "a.md": LOGIN_REVIEW },
    { reviews: [{ path: "a.md" }, { path: "./a.md" }] },
    (path) => assert.rejects(loadProjectConfig(path), /review a\.md is listed twice/),
  );
  await withProject({ "a.md": LOGIN_REVIEW }, { reviews: [{ path: "../a.md" }] }, (path) =>
    assert.rejects(loadProjectConfig(path), /lies outside the project/),
  );
});

test("revisions pair onto baseline docs, exclude rev dirs from baseline glob, and keep short names anchored to baseline", async () => {
  await withProject(
    {
      "reviews/login.md": LOGIN_REVIEW,
      "prd/account.md": "# 账号\n\n第 1 条\n第 2 条\n",
      "prd/area.md": "# 区域\n\n保持不变\n",
      "prd/v1/account.md": "# 账号\n\n第 1 条（改）\n第 2 条\n第 3 条\n",
      "prd/v1/added.md": "# 新增文档\n\n内容\n",
      "prd/v2/account.md": "# 账号\n\n第 1 条（改）\n第 2 条（V2）\n第 3 条\n",
    },
    {
      documents: ["prd/**/*.md"],
      revisions: [
        { id: "v1", label: "V1", dir: "prd/v1" },
        { id: "v2", label: "V2", dir: "prd/v2" },
      ],
      reviews: [{ path: "reviews/login.md" }],
    },
    async (configPath) => {
      const workspace = await loadWorkspace(await loadProjectConfig(configPath));
      assert.deepEqual(
        workspace.documents.map((doc) => doc.path),
        ["prd/account.md", "prd/area.md", "prd/v1/added.md", "reviews/login.md"],
      );
      const account = workspace.resolve("account.md");
      assert.equal(account?.path, "prd/account.md");
      assert.equal(account?.revisions?.length, 2);
      assert.deepEqual(account?.revisions?.[0]?.stats, { added: 2, removed: 1 });
      assert.equal(account?.revisions?.[0]?.baseId, undefined);
      // v2 diffs against v1 (not baseline)
      assert.deepEqual(account?.revisions?.[1]?.stats, { added: 1, removed: 1 });
      assert.equal(account?.revisions?.[1]?.baseId, "v1");

      const v1View = workspace.resolve("prd/v1/account.md");
      assert.equal(v1View?.path, "prd/v1/account.md");
      assert.deepEqual(v1View?.revision, { id: "v1", label: "V1", basePath: "prd/account.md" });
      assert.equal(workspace.resolve("v1/account.md")?.path, "prd/v1/account.md");

      // Newly added revision-only doc is resolvable by path, not short basename
      assert.equal(workspace.resolve("prd/v1/added.md")?.addedInRevision, "v1");
      assert.equal(workspace.resolve("added.md"), undefined);
    },
  );
});

test("rejects invalid revision configs and missing revision directories", async () => {
  await withProject(
    { "a.md": LOGIN_REVIEW },
    {
      revisions: [{ id: "v1", label: "V1", dir: "../outside" }],
      reviews: [{ path: "a.md" }],
    },
    (path) => assert.rejects(loadProjectConfig(path), /outside the project/),
  );
  await withProject(
    { "a.md": LOGIN_REVIEW },
    {
      revisions: [
        { id: "v1", label: "V1", dir: "prd/v1" },
        { id: "v1", label: "V1-dup", dir: "prd/v2" },
      ],
      reviews: [{ path: "a.md" }],
    },
    (path) => assert.rejects(loadProjectConfig(path), /duplicated/),
  );
  await withProject(
    { "reviews/a.md": LOGIN_REVIEW },
    {
      revisions: [{ id: "v1", label: "V1", dir: "reviews" }],
      reviews: [{ path: "reviews/a.md" }],
    },
    (path) => assert.rejects(loadProjectConfig(path), /overlaps review/),
  );
  await withProject(
    { "a.md": LOGIN_REVIEW },
    {
      revisions: [{ id: "v1", label: "V1", dir: "prd/v1" }],
      reviews: [{ path: "a.md" }],
    },
    async (path) => {
      const config = await loadProjectConfig(path);
      await assert.rejects(
        loadWorkspace(config),
        (err) => err instanceof SourceError && /prd\/v1/.test(err.message),
      );
    },
  );
});
