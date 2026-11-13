import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { hashPassword } from "../auth.js";
import { loadProjectConfig } from "../project.js";
import { openDatabase } from "../store/database.js";
import { EntryStore } from "../store/entries.js";
import { UserStore } from "../store/users.js";
import { createApp } from "./app.js";

const REVIEW = `# 审核

## 登录

### A1 锁定时长
- 文档：specs/login.md

:3 未写锁定时长。

### A2 会话续期

### A3 退出日志
`;

const ORIGIN = "http://localhost";

async function withSite(
  run: (site: {
    app: ReturnType<typeof createApp>;
    writeReview: (source: string) => Promise<void>;
    writeDocument: (name: string, source: string) => Promise<void>;
    entries: EntryStore;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-"));
  await mkdir(join(dir, "specs"));
  await writeFile(join(dir, "specs/login.md"), "# 登录\n\n输错 5 次锁定。\n");
  const writeReview = (source: string) => writeFile(join(dir, "review.md"), source);
  await writeReview(REVIEW);
  await writeFile(
    join(dir, "spec-clarify.config.json"),
    JSON.stringify({
      documents: ["specs/*.md"],
      reviews: [{ path: "review.md" }],
      database: "db.sqlite",
      severities: ["高", "低"],
    }),
  );
  const config = await loadProjectConfig(join(dir, "spec-clarify.config.json"));
  const client = await openDatabase(config.databasePath);
  try {
    const users = new UserStore(client);
    const passwordHash = await hashPassword("password-1");
    await users.create({ username: "pm", displayName: "产品", role: "product", passwordHash });
    await users.create({ username: "dev", displayName: "开发", role: "engineer", passwordHash });
    const entries = new EntryStore(client);
    await run({
      app: createApp({ config, entries, users }),
      writeReview,
      writeDocument: (name, source) => writeFile(join(dir, "specs", name), source),
      entries,
    });
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function signIn(app: ReturnType<typeof createApp>, username: string): Promise<string> {
  const response = await app.request("/login", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: "password-1", next: "/" }),
  });
  assert.equal(response.status, 303);
  const cookie = /spec_clarify_session=[^;]+/.exec(response.headers.get("Set-Cookie") ?? "")?.[0];
  assert.ok(cookie);
  return cookie;
}

function post(
  app: ReturnType<typeof createApp>,
  cookie: string,
  path: string,
  form: Record<string, string>,
) {
  return app.request(path, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
}

async function formValues(app: ReturnType<typeof createApp>, cookie: string, id: string) {
  const page = await (await app.request(`/items/${id}`, { headers: { Cookie: cookie } })).text();
  return {
    digest: /name="digest" value="([^"]+)"/.exec(page)?.[1] ?? "",
    base: /name="base" value="([^"]+)"/.exec(page)?.[1],
  };
}

test("document links show titles while retaining their path and line targets", async () => {
  await withSite(async ({ app }) => {
    const cookie = await signIn(app, "pm");
    const detail = await (await app.request("/items/A1", { headers: { Cookie: cookie } })).text();
    assert.match(detail, /review\.md&amp;line=5&amp;end=8#hl"[^>]*>\s*审核 第 5 行/);
    assert.match(detail, /specs%2Flogin\.md&amp;line=3&amp;end=3#hl" class="ref">登录:3/);
    assert.match(detail, /href="\/docs\/view\?path=specs%2Flogin\.md"\s*>登录<\/a\s*>/);
    const list = await (await app.request("/", { headers: { Cookie: cookie } })).text();
    assert.match(list, /href="\/docs\/view\?path=review\.md"\s*>审核<\/a\s*>/);
  });
});

test("duplicate and missing document titles retain paths to distinguish references", async () => {
  await withSite(async ({ app, writeDocument, writeReview }) => {
    await writeDocument("other.md", "# 登录\n\n另一份文档\n");
    await writeDocument("untitled.md", "无标题\n");
    await writeReview(REVIEW.replace(":3 未写锁定时长。", "login.md:3、other.md:3、untitled.md:1"));
    const cookie = await signIn(app, "pm");
    const page = await (await app.request("/items/A1", { headers: { Cookie: cookie } })).text();
    assert.match(page, /登录（specs\/login\.md）:3/);
    assert.match(page, /登录（specs\/other\.md）:3/);
    assert.match(page, /specs\/untitled\.md:1/);
  });
});

test("pages require signing in and return to the requested page afterwards", async () => {
  await withSite(async ({ app }) => {
    const response = await app.request("/items/A1?status=open");
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("Location"), "/login?next=%2Fitems%2FA1%3Fstatus%3Dopen");

    const wrong = await app.request("/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "pm", password: "nope", next: "//evil.example" }),
    });
    assert.equal(wrong.status, 401);
    assert.doesNotMatch(await wrong.text(), /evil\.example/);
  });
});

test("a form posted from another origin is refused with 403", async () => {
  await withSite(async ({ app }) => {
    const response = await app.request("/login", {
      method: "POST",
      headers: {
        Origin: "http://evil.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ username: "pm", password: "password-1", next: "/" }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Set-Cookie"), null);
  });
});

test("clarifying while browsing 未澄清 keeps the filter and pages on to the next open item", async () => {
  await withSite(async ({ app }) => {
    const pm = await signIn(app, "pm");
    const { digest } = await formValues(app, pm, "A1");
    const submitted = await post(app, pm, "/items/A1/clarifications?status=open", {
      body: "锁定 30 分钟",
      digest,
      base: "0",
    });
    assert.equal(submitted.status, 303);
    const location = submitted.headers.get("Location") ?? "";
    assert.match(location, /^\/items\/A1\?status=open#entry-\d+$/);

    const after = await (
      await app.request(location.replace(/#.*$/, ""), { headers: { Cookie: pm } })
    ).text();
    assert.match(after, /href="\/items\/A2\?status=open"/);
    assert.match(after, /不在筛选结果中/);
  });
});

test("engineers can ask follow-up questions but cannot clarify", async () => {
  await withSite(async ({ app, entries }) => {
    const dev = await signIn(app, "dev");
    const { digest, base } = await formValues(app, dev, "A1");
    assert.equal(base, undefined, "engineers get no clarification form");

    const denied = await post(app, dev, "/items/A1/clarifications", {
      body: "结论",
      digest,
      base: "0",
    });
    assert.equal(denied.status, 403);
    const asked = await post(app, dev, "/items/A1/comments", { body: "解锁要记日志吗？", digest });
    assert.equal(asked.status, 303);

    const list = await (
      await app.request("/?status=awaiting", { headers: { Cookie: dev } })
    ).text();
    assert.match(list, /href="\/items\/A1\?status=awaiting"/);
    assert.deepEqual(
      (await entries.entriesFor("A1")).map((entry) => [entry.kind, entry.author.displayName]),
      [["comment", "开发"]],
    );
  });
});

test("an unreadable review blocks every page and submission until it is fixed", async () => {
  await withSite(async ({ app, writeReview, entries }) => {
    const pm = await signIn(app, "pm");
    const { digest } = await formValues(app, pm, "A1");
    await writeReview(REVIEW.replace("### A2", "### A1"));

    const page = await app.request("/items/A1", { headers: { Cookie: pm } });
    assert.equal(page.status, 503);
    assert.match(await page.text(), /Duplicate item ID A1/);
    const submitted = await post(app, pm, "/items/A1/clarifications", {
      body: "结论",
      digest,
      base: "0",
    });
    assert.equal(submitted.status, 503);
    assert.equal((await app.request("/export.md", { headers: { Cookie: pm } })).status, 503);
    assert.deepEqual(await entries.entriesFor("A1"), []);

    await writeReview(REVIEW);
    assert.equal((await app.request("/items/A1", { headers: { Cookie: pm } })).status, 200);
  });
});

test("a clarification against an edited item is refused, and removed items keep their record", async () => {
  await withSite(async ({ app, writeReview }) => {
    const pm = await signIn(app, "pm");
    const { digest } = await formValues(app, pm, "A3");
    assert.equal(
      (await post(app, pm, "/items/A3/clarifications", { body: "需要", digest, base: "0" })).status,
      303,
    );

    const before = await formValues(app, pm, "A1");
    await writeReview(REVIEW.replace("未写锁定时长", "未写锁定时长与解锁方式"));
    const stale = await post(app, pm, "/items/A1/clarifications", {
      body: "30 分钟",
      digest: before.digest,
      base: "0",
    });
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /30 分钟<\/textarea>/);

    await writeReview(REVIEW.replace("### A3 退出日志\n", ""));
    const exported = await (await app.request("/export.md", { headers: { Cookie: pm } })).text();
    assert.match(exported, /## 已从审核文档移除的条目\n\n### A3\n\n- .* 产品 澄清：\n {2}> 需要/);
  });
});

test("pages are sent gzip-compressed to browsers that accept it", async () => {
  await withSite(async ({ app }) => {
    const pm = await signIn(app, "pm");
    const response = await app.request("/", {
      headers: { Cookie: pm, "Accept-Encoding": "gzip, deflate, br" },
    });
    assert.equal(response.headers.get("Content-Encoding"), "gzip");
    const page = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
    assert.match(page, /A1/);

    const plain = await app.request("/", { headers: { Cookie: pm } });
    assert.equal(plain.headers.get("Content-Encoding"), null);
  });
});

test("an item page shows the referenced source lines with their context", async () => {
  await withSite(async ({ app }) => {
    const pm = await signIn(app, "pm");
    const page = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    const excerpt = /<section[^>]*id="sources"[\s\S]*?<\/section>/.exec(page)?.[0] ?? "";
    const lines = [
      ...excerpt.matchAll(/<div class="excerpt__line( is-hit)?"[^>]*>([\s\S]*?)<\/div>/g),
    ].map(([, hit, row = ""]) => `${hit ? "*" : " "}${row.replace(/<[^>]+>/g, "").trim()}`);
    assert.ok(lines.includes("*3输错 5 次锁定。"));
    assert.ok(lines.some((line) => line.includes("1登录")));

    const plain = await (await app.request("/items/A2", { headers: { Cookie: pm } })).text();
    assert.doesNotMatch(plain, /id="sources"/);
  });
});

test("提交并下一条 records the clarification and moves on to the next item in the filter", async () => {
  await withSite(async ({ app, entries }) => {
    const pm = await signIn(app, "pm");
    const { digest } = await formValues(app, pm, "A1");
    const submitted = await post(app, pm, "/items/A1/clarifications?status=open", {
      body: "锁定 30 分钟",
      digest,
      base: "0",
      after: "next",
    });
    assert.equal(submitted.status, 303);
    const location = submitted.headers.get("Location") ?? "";
    assert.match(location, /^\/items\/A2\?status=open&receipt=/);
    const dev = await signIn(app, "dev");
    const otherSession = await (await app.request(location, { headers: { Cookie: dev } })).text();
    assert.doesNotMatch(otherSession, /澄清已保存/);
    const receipt = await (await app.request(location, { headers: { Cookie: pm } })).text();
    assert.match(receipt, /澄清已保存/);
    assert.match(receipt, /href="\/items\/A1\?status=open#entry-\d+"/);
    const replay = await (await app.request(location, { headers: { Cookie: pm } })).text();
    assert.doesNotMatch(replay, /澄清已保存/);
    const forged = await (
      await app.request("/items/A2?status=open&receipt=fake", { headers: { Cookie: pm } })
    ).text();
    assert.doesNotMatch(forged, /澄清已保存/);
    assert.equal((await entries.entriesFor("A1")).length, 1);

    const last = await formValues(app, pm, "A3");
    const atEnd = await post(app, pm, "/items/A3/clarifications?status=open", {
      body: "需要",
      digest: last.digest,
      base: "0",
      after: "next",
    });
    const endLocation = atEnd.headers.get("Location") ?? "";
    assert.match(endLocation, /^\/items\/A3\?status=open&receipt=/);
    const endPage = await (await app.request(endLocation, { headers: { Cookie: pm } })).text();
    assert.match(endPage, /当前筛选中没有下一条/);
  });
});

test("product queue is a deduplicated pending union ordered by configured severity", async () => {
  await withSite(async ({ app, writeReview }) => {
    const review = REVIEW.replace("### A1 锁定时长", "### A1 锁定时长\n- 严重度：低").replace(
      "### A2 会话续期",
      "### A2 会话续期\n- 严重度：高",
    );
    await writeReview(review);
    const pm = await signIn(app, "pm");
    const dev = await signIn(app, "dev");
    const a1 = await formValues(app, pm, "A1");
    const a3 = await formValues(app, pm, "A3");
    await post(app, pm, "/items/A1/clarifications", {
      body: "已解决",
      digest: a1.digest,
      base: "0",
    });
    await post(app, pm, "/items/A3/clarifications", {
      body: "旧结论",
      digest: a3.digest,
      base: "0",
    });
    await post(app, dev, "/items/A1/comments", { body: "仍有疑问", digest: a1.digest });
    await writeReview(review.replace("### A3 退出日志", "### A3 退出日志变更"));

    const list = await (await app.request("/", { headers: { Cookie: pm } })).text();
    const ids = [...list.matchAll(/class="item-link" href="\/items\/(A\d)\?status=pending"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(ids, ["A2", "A1", "A3"]);
    assert.match(list, /href="\/\?status=all"/);
    assert.match(list, /name="status" value="pending"/);
    const all = await (await app.request("/?status=all", { headers: { Cookie: pm } })).text();
    assert.deepEqual(
      [...all.matchAll(/href="\/items\/(A\d)\?status=all"/g)].map((m) => m[1]),
      ["A1", "A2", "A3"],
    );
    const page = await (
      await app.request("/items/A2?status=pending", { headers: { Cookie: pm } })
    ).text();
    assert.match(page, /href="\/items\/A1\?status=pending"/);
    const values = await formValues(app, pm, "A2");
    const submitted = await post(app, pm, "/items/A2/clarifications?status=pending", {
      body: "续期结论",
      digest: values.digest,
      base: "0",
      after: "next",
    });
    assert.match(submitted.headers.get("Location") ?? "", /^\/items\/A1\?status=pending&receipt=/);
  });
});

test("detail forms follow roles and conflicts reopen the update with its draft", async () => {
  await withSite(async ({ app }) => {
    const pm = await signIn(app, "pm");
    const dev = await signIn(app, "dev");
    const initial = await formValues(app, pm, "A1");
    await post(app, pm, "/items/A1/clarifications", {
      body: "第一版",
      digest: initial.digest,
      base: "0",
    });
    const product = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    assert.match(product, /<details[^>]*>\s*<summary class="section-title">更新澄清/);
    assert.match(product, /<details[^>]*>\s*<summary class="section-title">评论 \/ 追问/);
    const engineer = await (await app.request("/items/A1", { headers: { Cookie: dev } })).text();
    assert.match(engineer, /<details[^>]*\sopen\s*>\s*<summary class="section-title">评论 \/ 追问/);
    const conflict = await post(app, pm, "/items/A1/clarifications", {
      body: "我的草稿",
      digest: initial.digest,
      base: "0",
    });
    assert.equal(conflict.status, 409);
    const page = await conflict.text();
    assert.match(page, /<details[^>]*\sopen\s*>\s*<summary class="section-title">更新澄清/);
    assert.match(page, /我的草稿<\/textarea>/);
    assert.match(page, /第一版/);
  });
});

test("docs list, diff viewer, excerpt diff shortcuts, and entry body ref links work under strict CSP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-rev-"));
  await mkdir(join(dir, "specs/v1"), { recursive: true });
  await mkdir(join(dir, "specs/v2"), { recursive: true });
  await writeFile(join(dir, "specs/login.md"), "# 登录\n\n输错 5 次锁定。\n第 4 行\n");
  await writeFile(join(dir, "specs/area.md"), "# 区域\n\n未改变。\n");
  await writeFile(
    join(dir, "specs/v1/login.md"),
    "# 登录\n\n输错 3 次锁定。\n第 4 行\n新增第 5 行\n",
  );
  await writeFile(
    join(dir, "specs/v2/login.md"),
    "# 登录\n\n输错 3 次锁定 15 分钟。\n第 4 行\n新增第 5 行\n",
  );
  await writeFile(join(dir, "review.md"), REVIEW);
  await writeFile(
    join(dir, "spec-clarify.config.json"),
    JSON.stringify({
      documents: ["specs/**/*.md"],
      revisions: [
        { id: "v1", label: "V1", dir: "specs/v1" },
        { id: "v2", label: "V2", dir: "specs/v2" },
      ],
      reviews: [{ path: "review.md" }],
      database: "db.sqlite",
    }),
  );
  const config = await loadProjectConfig(join(dir, "spec-clarify.config.json"));
  const client = await openDatabase(config.databasePath);
  try {
    const users = new UserStore(client);
    const passwordHash = await hashPassword("password-1");
    await users.create({ username: "pm", displayName: "产品", role: "product", passwordHash });
    const app = createApp({ config, entries: new EntryStore(client), users });
    const pm = await signIn(app, "pm");

    // /docs aggregates logical documents and shows diff stats chips
    const docsRes = await app.request("/docs", { headers: { Cookie: pm } });
    assert.equal(docsRes.status, 200);
    const docsHtml = await docsRes.text();
    assert.match(docsHtml, /V1 · \+2 \/ -1/);
    assert.match(docsHtml, /V2 · \+1 \/ -1/);
    assert.equal(docsHtml.match(/specs\/login\.md/g)?.length, 1);
    assert.doesNotMatch(docsHtml, /specs\/v1\/login\.md/);

    // /docs/view diff mode for V1 and V2 (V2 diffs against V1)
    const v1DiffRes = await app.request("/docs/view?path=specs/login.md&rev=v1&mode=diff", {
      headers: { Cookie: pm },
    });
    assert.equal(v1DiffRes.status, 200);
    assert.match(v1DiffRes.headers.get("Content-Security-Policy") ?? "", /script-src 'none'/);
    const v1DiffHtml = await v1DiffRes.text();
    assert.match(v1DiffHtml, /<del>5<\/del>/);
    assert.match(v1DiffHtml, /<ins>3<\/ins>/);

    const v2DiffHtml = await (
      await app.request("/docs/view?path=specs/login.md&rev=v2&mode=diff", {
        headers: { Cookie: pm },
      })
    ).text();
    assert.match(v2DiffHtml, /对比上一修订版（V1）→ V2/);
    assert.match(v2DiffHtml, /<ins> 15 分钟<\/ins>/);

    // Unchanged document in V1 shows notice
    const areaV1Html = await (
      await app.request("/docs/view?path=specs/area.md&rev=v1", { headers: { Cookie: pm } })
    ).text();
    assert.match(areaV1Html, /V1 未修改此文档（当前显示基线内容）/);

    // Unknown revision returns 404
    const missingRev = await app.request("/docs/view?path=specs/login.md&rev=v99", {
      headers: { Cookie: pm },
    });
    assert.equal(missingRev.status, 404);

    // Item page: excerpt header links to V1 diff, and clarification body links doc refs without raw HTML
    const { digest } = await formValues(app, pm, "A1");
    await post(app, pm, "/items/A1/clarifications", {
      body: "请参见 @/specs/v1/login.md 与 login.md:3 <script>x</script>",
      digest,
      base: "0",
    });
    const itemHtml = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    assert.match(
      itemHtml,
      /href="\/docs\/view\?path=specs%2Flogin\.md&amp;rev=v1&amp;mode=diff"[^>]*>查看 V1 增量变动<\/a\s*>/,
    );
    assert.match(
      itemHtml,
      /href="\/docs\/view\?path=specs%2Flogin\.md&amp;rev=v1" class="ref">登录（V1）<\/a>/,
    );
    assert.match(
      itemHtml,
      /href="\/docs\/view\?path=specs%2Flogin\.md&amp;line=3&amp;end=3#hl" class="ref">登录:3<\/a>/,
    );
    assert.doesNotMatch(itemHtml, /<script>x<\/script>/);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("default view omits filter-reset chrome, empty pending queue links to all, and comments auto-open history", async () => {
  await withSite(async ({ app }) => {
    const pm = await signIn(app, "pm");
    const dev = await signIn(app, "dev");

    const pmHome = await (await app.request("/", { headers: { Cookie: pm } })).text();
    assert.doesNotMatch(pmHome, /清除筛选/);
    const devHome = await (await app.request("/", { headers: { Cookie: dev } })).text();
    assert.doesNotMatch(devHome, /清除筛选/);

    const defaultDetail = await (
      await app.request("/items/A1?status=pending", { headers: { Cookie: pm } })
    ).text();
    assert.doesNotMatch(defaultDetail, /澄清条目（筛选结果）/);

    const filteredList = await (
      await app.request("/?status=all", { headers: { Cookie: pm } })
    ).text();
    assert.match(filteredList, /清除筛选/);
    const filteredDetail = await (
      await app.request("/items/A1?status=all", { headers: { Cookie: pm } })
    ).text();
    assert.match(filteredDetail, /澄清条目（筛选结果）/);

    // One clarification without comments keeps 处理记录 collapsed; adding a comment opens it.
    const a1 = await formValues(app, pm, "A1");
    await post(app, pm, "/items/A1/clarifications", {
      body: "15 分钟",
      digest: a1.digest,
      base: "0",
    });
    const clarified = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    assert.match(
      clarified,
      /<details[^>]*class="card card--default card--padded"[^>]*>\s*<summary class="section-title">处理记录（1）/,
    );
    assert.doesNotMatch(
      clarified,
      /<details[^>]*\sopen\s*>\s*<summary class="section-title">处理记录（1）/,
    );

    await post(app, dev, "/items/A1/comments", { body: "需记日志吗？", digest: a1.digest });
    const commented = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    assert.match(
      commented,
      /<details[^>]*\sopen\s*>\s*<summary class="section-title">处理记录（2）/,
    );

    // Reply to A1 and clarify A2/A3 so product's pending queue becomes empty.
    const a1Updated = await formValues(app, pm, "A1");
    await post(app, pm, "/items/A1/clarifications", {
      body: "15 分钟，记日志",
      digest: a1Updated.digest,
      base: a1Updated.base ?? "0",
    });
    for (const id of ["A2", "A3"]) {
      const values = await formValues(app, pm, id);
      await post(app, pm, `/items/${id}/clarifications`, {
        body: "已明确",
        digest: values.digest,
        base: values.base ?? "0",
      });
    }
    const emptyPending = await (await app.request("/", { headers: { Cookie: pm } })).text();
    assert.match(emptyPending, /当前没有待处理的条目/);
    assert.match(emptyPending, /href="\/\?status=all"[^>]*>查看全部条目/);
  });
});

test("shell brand mark, login heading hierarchy, and item-head title-first order render cleanly", async () => {
  await withSite(async ({ app }) => {
    const loginHtml = await (await app.request("/login")).text();
    assert.match(loginHtml, /<span class="brand__mark"[^>]*>SC<\/span>/);
    assert.match(loginHtml, /<p class="login-head__site">[^<]+<\/p>\s*<h1>登录<\/h1>/);

    const pm = await signIn(app, "pm");
    const detail = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    assert.match(
      detail,
      /<header class="item-head">\s*<h1>锁定时长<\/h1>\s*<div class="item-head__meta">/,
    );
    const headMeta = /<div class="item-head__meta">([\s\S]*?)<\/div>/.exec(detail)?.[1] ?? "";
    assert.doesNotMatch(headMeta, /审核 · 登录/);
  });
});

test("list keeps stable columns across status tabs, shows pending context, and paginates 100+ items", async () => {
  await withSite(async ({ app, writeReview }) => {
    const lines = ["# 审核", "", "## 批量组"];
    for (let i = 1; i <= 125; i++) {
      lines.push(`### B${String(i).padStart(3, "0")} 条目 ${i}`);
    }
    await writeReview(`${lines.join("\n")}\n`);
    const pm = await signIn(app, "pm");

    // Stable table headers even when zero entries exist, and group-nav retains progress bar in pending view
    const page1 = await (await app.request("/", { headers: { Cookie: pm } })).text();
    assert.match(page1, /<th class="table__column col-num">记录<\/th>/);
    assert.match(page1, /<th class="table__column col-time">最近更新<\/th>/);
    assert.match(page1, /<td class="table__cell col-num">\s*—\s*<\/td>/);
    assert.match(page1, /group-nav__badge[^>]*>待 125<\/span\s*>/);
    assert.match(page1, /class="group-nav__count"[^>]*>0\/125<\/span\s*>/);
    assert.match(page1, /第 1–50 条，共 125 条/);
    assert.match(page1, /href="\/items\/B001\?status=pending"/);
    assert.doesNotMatch(page1, /href="\/items\/B051\?status=pending"/);
    assert.match(page1, /accesskey="q"/);
    assert.match(page1, /accesskey="n"/);
    assert.match(page1, /href="\/export\.md"\s+title="[^"]*不受当前筛选影响/);

    // Switching to page 2 carries page=2 to detail links and breadcrumb return links
    const page2 = await (
      await app.request("/?status=all&page=2", { headers: { Cookie: pm } })
    ).text();
    assert.match(page2, /第 51–100 条，共 125 条/);
    assert.match(page2, /href="\/items\/B051\?status=all&amp;page=2"/);
    assert.doesNotMatch(page2, /href="\/items\/B001\?status=all/);
    // Filter links (status tabs & group nav) reset back to page 1 (omit page=2)
    assert.match(page2, /href="\/\?status=open"/);
    assert.doesNotMatch(page2, /href="\/\?status=open&amp;page=2"/);

    // Detail breadcrumbs preserve page=2 back to the list
    const detailFromPage2 = await (
      await app.request("/items/B051?status=all&page=2", { headers: { Cookie: pm } })
    ).text();
    assert.match(detailFromPage2, /href="\/\?status=all&amp;page=2"/);
    assert.match(detailFromPage2, /accesskey="p"/);
    assert.match(detailFromPage2, /accesskey="n"/);
    assert.match(detailFromPage2, /accesskey="s"/);

    // Boundary page numbers: invalid/zero falls back to 1 keeping other filters; overflow clamps to last page
    const invalidPage = await (
      await app.request("/?status=all&page=abc", { headers: { Cookie: pm } })
    ).text();
    assert.match(invalidPage, /第 1–50 条，共 125 条/);
    assert.match(invalidPage, /href="\/items\/B001\?status=all"/);

    const zeroPage = await (
      await app.request("/?status=all&page=0", { headers: { Cookie: pm } })
    ).text();
    assert.match(zeroPage, /第 1–50 条，共 125 条/);

    const overflowPage = await (
      await app.request("/?status=all&page=999", { headers: { Cookie: pm } })
    ).text();
    assert.match(overflowPage, /第 101–125 条，共 125 条/);
    assert.match(overflowPage, /href="\/items\/B125\?status=all&amp;page=3"/);
  });
});

test("detail scaffolding supports permanent initial panel, prefill=1, 409 latest summary, role chips, and deduplicated single history", async () => {
  await withSite(async ({ app }) => {
    const pm = await signIn(app, "pm");
    const dev = await signIn(app, "dev");

    // Initial clarification panel is a permanent <section> (no <details>), with Markdown hint & mobile jump links
    const initialPage = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    assert.match(
      initialPage,
      /<section id="clarify" class="card card--default card--padded">\s*<h2 class="section-title">提交澄清<\/h2>/,
    );
    assert.match(initialPage, /支持 Markdown 与 <code>文件:行号<\/code>/);
    assert.match(initialPage, /class="mobile-jump"[\s\S]*href="#clarify"[\s\S]*href="#comment"/);

    const a1 = await formValues(app, pm, "A1");
    await post(app, pm, "/items/A1/clarifications", {
      body: "已定稿：输错 5 次锁定 15 分钟。",
      digest: a1.digest,
      base: "0",
    });

    // After 1 clarification: conclusion & history carry role chip; default textarea stays empty; single history avoids repeating full prose
    const clarified = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    assert.match(
      clarified,
      /class="conclusion__meta"[\s\S]*?chip--role"[^>]*>\s*产品\s*<\/span\s*>/,
    );
    assert.match(clarified, /class="entry__meta"[\s\S]*?chip--role"[^>]*>\s*产品\s*<\/span\s*>/);
    assert.match(
      clarified,
      /仅此 1 条澄清记录，完整正文见「<a href="#current-clarification">当前澄清<\/a>」/,
    );
    assert.doesNotMatch(clarified, /已定稿：输错 5 次锁定 15 分钟。<\/textarea>/);
    assert.match(
      clarified,
      /href="\/items\/A1\?status=pending&amp;prefill=1#clarify"[^>]*>载入上一版正文/,
    );

    // ?prefill=1 opens update <details> and loads previous clarification body
    const prefilled = await (
      await app.request("/items/A1?status=pending&prefill=1", { headers: { Cookie: pm } })
    ).text();
    assert.match(prefilled, /<details[^>]*id="clarify"[^>]*\sopen\s*>/);
    assert.match(prefilled, />\s*已定稿：输错 5 次锁定 15 分钟。<\/textarea>/);

    // 409 conflict includes latest clarification excerpt inside the danger alert and preserves draft
    const conflict = await post(app, pm, "/items/A1/clarifications", {
      body: "我的并发草稿",
      digest: a1.digest,
      base: "0",
    });
    assert.equal(conflict.status, 409);
    const conflictHtml = await conflict.text();
    assert.match(conflictHtml, /class="conflict-latest__label">\s*产品（产品）的最新澄清摘要：/);
    assert.match(
      conflictHtml,
      /class="prose conflict-latest__body">[\s\S]*已定稿：输错 5 次锁定 15 分钟。/,
    );
    assert.match(conflictHtml, /我的并发草稿<\/textarea>/);

    // Engineer comment adds role chip and opens history with full prose
    await post(app, dev, "/items/A1/comments", { body: "需发短信通知吗？", digest: a1.digest });
    const withComment = await (await app.request("/items/A1", { headers: { Cookie: pm } })).text();
    assert.match(withComment, /class="entry__meta"[\s\S]*?chip--role"[^>]*>\s*工程\s*<\/span\s*>/);
    assert.doesNotMatch(withComment, /仅此 1 条澄清记录/);
  });
});
