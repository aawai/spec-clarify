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
    await run({ app: createApp({ config, entries, users }), writeReview, entries });
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
    assert.match(excerpt, /specs\/login\.md/);
    const lines = [
      ...excerpt.matchAll(/<div class="excerpt__line( is-hit)?"[^>]*>([\s\S]*?)<\/div>/g),
    ].map(([, hit, row = ""]) => `${hit ? "*" : " "}${row.replace(/<[^>]+>/g, "").trim()}`);
    assert.deepEqual(lines, [" 1# 登录", " 2", "*3输错 5 次锁定。", " 4"]);

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
    assert.equal(submitted.headers.get("Location"), "/items/A2?status=open");
    assert.equal((await entries.entriesFor("A1")).length, 1);

    const last = await formValues(app, pm, "A3");
    const atEnd = await post(app, pm, "/items/A3/clarifications?status=open", {
      body: "需要",
      digest: last.digest,
      base: "0",
      after: "next",
    });
    assert.match(atEnd.headers.get("Location") ?? "", /^\/items\/A3\?status=open#entry-\d+$/);
  });
});
