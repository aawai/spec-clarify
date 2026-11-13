import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hashPassword } from "../auth.js";
import { loadProjectConfig, type ProjectConfig } from "../project.js";
import { openDatabase } from "../store/database.js";
import { EntryStore } from "../store/entries.js";
import { UserStore } from "../store/users.js";
import { createApp } from "../web/app.js";
import { createMcpServer, runStdioMcpServer } from "./server.js";

const REVIEW_SOURCE = `# 审核

## 登录

### L1 锁定时长未定义
- 严重度：高
- 文档：specs/login.md
- 相关：L2
- 建议：补充锁定时长

:3 规定输错 5 次锁定，但未写锁定多久。

### L2 会话续期
- 严重度：低
- 文档：specs/login.md

:4 有效期 7 天。
`;

interface Fixture {
  dir: string;
  config: ProjectConfig;
  entries: EntryStore;
  users: UserStore;
  pmId: number;
  devId: number;
}

async function withFixture(run: (fx: Fixture) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-mcp-"));
  try {
    await mkdir(join(dir, "specs/v1"), { recursive: true });
    await mkdir(join(dir, "specs/v2"), { recursive: true });
    await writeFile(
      join(dir, "specs/login.md"),
      "# 登录\n\n第 2 行\n输错 5 次锁定。\n有效期 7 天。\n",
    );
    await writeFile(join(dir, "specs/unchanged.md"), "# 保持不变\n\n基线正文。\n");
    await writeFile(
      join(dir, "specs/v1/login.md"),
      "# 登录\n\n第 2 行\n输错 3 次锁定 15 分钟。\n有效期 7 天。\n",
    );
    await writeFile(join(dir, "specs/v2/added.md"), "# 新增文档\n\nV2 新增内容。\n");
    await writeFile(join(dir, "review.md"), REVIEW_SOURCE);
    await writeFile(
      join(dir, "spec-clarify.config.json"),
      JSON.stringify({
        title: "MCP 测试项目",
        documents: ["specs/**/*.md"],
        revisions: [
          { id: "v1", label: "V1", dir: "specs/v1" },
          { id: "v2", label: "V2", dir: "specs/v2" },
        ],
        reviews: [{ path: "review.md" }],
        severities: ["高", "低"],
        database: "data/spec-clarify.db",
      }),
    );

    const config = await loadProjectConfig(join(dir, "spec-clarify.config.json"));
    const client = await openDatabase(config.databasePath);
    try {
      const users = new UserStore(client);
      const passwordHash = await hashPassword("password-1");
      const pm = await users.create({
        username: "pm",
        displayName: "产品",
        role: "product",
        passwordHash,
      });
      const dev = await users.create({
        username: "dev",
        displayName: "工程",
        role: "engineer",
        passwordHash,
      });
      const entries = new EntryStore(client);
      await run({ dir, config, entries, users, pmId: pm.id, devId: dev.id });
    } finally {
      client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseToolJson<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return JSON.parse(first.text ?? "") as T;
}

test("MCP tools expose filtered clarifications, item excerpts, revision status, inherited docs and unified diffs", async () => {
  await withFixture(async ({ dir, config, entries, pmId, devId }) => {
    // Clarify L1 against current digest, then add a comment on L2, and leave a stale clarification on removed item X9.
    const l1Body = REVIEW_SOURCE;
    assert.ok(l1Body);
    const server = createMcpServer({ config, entries });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // Seed L1 clarification with exact digest read from get_item
      const initialL1 = parseToolJson<{ digest: string }>(
        (await client.callTool({ name: "get_item", arguments: { id: "L1" } })) as {
          content: Array<{ type: string; text?: string }>;
        },
      );
      await entries.add({
        itemId: "L1",
        kind: "clarification",
        userId: pmId,
        body: "锁定 15 分钟，管理员可提前解锁。",
        itemDigest: initialL1.digest,
        baseClarificationId: 0,
      });
      await entries.add({
        itemId: "L2",
        kind: "comment",
        userId: devId,
        body: "是否需要滑动续期？",
        itemDigest: "unused",
      });
      await entries.add({
        itemId: "X9",
        kind: "clarification",
        userId: pmId,
        body: "历史已移除条目的结论。",
        itemDigest: "old-digest",
        baseClarificationId: 0,
      });

      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((t) => t.name),
        ["list_items", "get_item", "list_documents", "get_document", "diff_document"],
      );

      // 1. list_items filtering
      const clarified = parseToolJson<{
        summary: { total: number; clarified: number; open: number; awaitingReply: number };
        items: Array<{
          id: string;
          status: string;
          latestClarification?: { body: string };
          body?: string;
        }>;
      }>(
        (await client.callTool({
          name: "list_items",
          arguments: { status: "clarified" },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(clarified.summary.total, 2);
      assert.equal(clarified.summary.clarified, 1);
      assert.equal(clarified.summary.open, 1);
      assert.equal(clarified.summary.awaitingReply, 1);
      assert.equal(clarified.items.length, 1);
      assert.equal(clarified.items[0]?.id, "L1");
      assert.equal(
        clarified.items[0]?.latestClarification?.body,
        "锁定 15 分钟，管理员可提前解锁。",
      );
      assert.equal(clarified.items[0]?.body, undefined);

      // 2. get_item with excerpts and backlinks
      const l2 = parseToolJson<{
        id: string;
        awaitingReply: boolean;
        backlinks: Array<{ id: string }>;
        excerpts: Array<{ path: string; windows: Array<{ lines: Array<{ hit: boolean }> }> }>;
      }>(
        (await client.callTool({ name: "get_item", arguments: { id: "L2" } })) as {
          content: Array<{ type: string; text?: string }>;
        },
      );
      assert.equal(l2.awaitingReply, true);
      assert.deepEqual(
        l2.backlinks.map((b) => b.id),
        ["L1"],
      );
      assert.equal(l2.excerpts[0]?.path, "specs/login.md");
      assert.ok(l2.excerpts[0]?.windows[0]?.lines.some((line) => line.hit));

      // Removed item keeps history
      const removed = parseToolJson<{
        removedFromReview?: boolean;
        entries: Array<{ body: string }>;
      }>(
        (await client.callTool({ name: "get_item", arguments: { id: "X9" } })) as {
          content: Array<{ type: string; text?: string }>;
        },
      );
      assert.equal(removed.removedFromReview, true);
      assert.equal(removed.entries[0]?.body, "历史已移除条目的结论。");

      // 3. list_documents with rev + changedOnly
      const v1Changed = parseToolJson<{
        documents: Array<{ path: string; statusInRevision?: string }>;
      }>(
        (await client.callTool({
          name: "list_documents",
          arguments: { rev: "v1", changedOnly: true },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.deepEqual(v1Changed.documents, [
        {
          path: "specs/login.md",
          title: "登录",
          lineCount: 6,
          isReview: false,
          revisions: [
            {
              id: "v1",
              label: "V1",
              path: "specs/v1/login.md",
              changed: true,
              added: 1,
              removed: 1,
            },
          ],
          statusInRevision: "modified",
        },
      ]);

      // 4. get_document inherits v1 content when viewing v2 of login.md
      const inheritedDoc = parseToolJson<{
        revision: { id: string; inherited: boolean; inheritedFrom?: string; sourcePath: string };
        content: string;
      }>(
        (await client.callTool({
          name: "get_document",
          arguments: { path: "login.md", rev: "v2", startLine: 3, endLine: 4 },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(inheritedDoc.revision.id, "v2");
      assert.equal(inheritedDoc.revision.inherited, true);
      assert.equal(inheritedDoc.revision.inheritedFrom, "v1");
      assert.equal(inheritedDoc.revision.sourcePath, "specs/v1/login.md");
      assert.match(inheritedDoc.content, /3 \| 第 2 行\n4 \| 输错 3 次锁定 15 分钟。/);

      // 5. diff_document
      const v1Diff = parseToolJson<{
        changed: boolean;
        stats: { added: number; removed: number };
        unifiedDiff: string;
      }>(
        (await client.callTool({
          name: "diff_document",
          arguments: { path: "specs/login.md", rev: "v1" },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(v1Diff.changed, true);
      assert.deepEqual(v1Diff.stats, { changed: true, added: 1, removed: 1 });
      assert.match(v1Diff.unifiedDiff, /-输错 5 次锁定。\n\+输错 3 次锁定 15 分钟。/);

      const v2UnchangedDiff = parseToolJson<{ changed: boolean; note?: string }>(
        (await client.callTool({
          name: "diff_document",
          arguments: { path: "specs/login.md", rev: "v2" },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(v2UnchangedDiff.changed, false);
      assert.match(v2UnchangedDiff.note ?? "", /未修改/);

      const v2AddedDiff = parseToolJson<{ changed: boolean; unifiedDiff: string }>(
        (await client.callTool({
          name: "diff_document",
          arguments: { path: "specs/v2/added.md", rev: "v2" },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(v2AddedDiff.changed, true);
      assert.match(v2AddedDiff.unifiedDiff, /^--- \/dev\/null\n\+\+\+ specs\/v2\/added\.md/m);

      // Unknown item & SourceError surface as isError: true
      const missingItem = await client.callTool({ name: "get_item", arguments: { id: "NOPE" } });
      assert.equal(missingItem.isError, true);

      await writeFile(join(dir, "review.md"), "## 坏掉的组\n\n### 没有编号\n");
      const broken = await client.callTool({ name: "list_items", arguments: {} });
      assert.equal(broken.isError, true);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

test("stdio MCP server handles JSON-RPC initialize, tool call, and EOF shutdown", async () => {
  await withFixture(async ({ config, entries }) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const { promise: gotResponse, resolve: resolveGotResponse } = Promise.withResolvers<void>();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes('"id":2')) resolveGotResponse();
    });

    const running = runStdioMcpServer({ config, entries }, { stdin, stdout });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "stdio-test", version: "1.0.0" },
        },
      })}\n`,
    );
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_documents", arguments: { changedOnly: true } },
      })}\n`,
    );

    await gotResponse;
    stdin.end();
    await running;
    assert.match(output, /"id":1/);
    assert.match(output, /specs\/login\.md/);
    assert.match(output, /specs\/v2\/added\.md/);
  });
});

test("HTTP /mcp endpoint enforces Bearer auth, bypasses web CSRF/cookie guard, and works with StreamableHTTPClientTransport", async () => {
  await withFixture(async ({ config, entries, users }) => {
    // Disabled when mcpToken is not configured (falls through to web guards).
    const disabledApp = createApp({ config, entries, users });
    const disabledGet = await disabledApp.request("/mcp");
    assert.equal(disabledGet.status, 303);
    const disabledPost = await disabledApp.request("/mcp", { method: "POST" });
    assert.equal(disabledPost.status, 403);
    const token = "secret-mcp-token-123";
    const app = createApp({ config, entries, users, mcpToken: token });

    // Missing or wrong Bearer token -> 401
    const unauth = await app.request("/mcp", { method: "POST" });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("www-authenticate"), "Bearer");

    const wrong = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(wrong.status, 401);

    // GET /mcp -> 405 Method Not Allowed
    const getRes = await app.request("/mcp", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.status, 405);

    // Full MCP client over StreamableHTTPClientTransport + cross-origin header (verifies CSRF bypass on Bearer endpoint)
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://remote-mcp-client.example",
        },
      },
      fetch: async (input, init) =>
        app.request(input instanceof Request ? input : new Request(input, init)),
    });
    const client = new Client({ name: "http-test-client", version: "1.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 5);
      const doc = parseToolJson<{ path: string; content: string }>(
        (await client.callTool({
          name: "get_document",
          arguments: { path: "specs/login.md", rev: "v1" },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(doc.path, "specs/login.md");
      assert.match(doc.content, /输错 3 次锁定 15 分钟。/);
    } finally {
      await client.close();
    }
  });
});

test("MCP applied filtering, afterClarificationId cursor, and opt-in resolve_items workflow", async () => {
  await withFixture(async ({ config, entries, users, pmId }) => {
    const token = "secret-mcp-write-token";
    const app = createApp({ config, entries, users, mcpToken: token, mcpWrite: true });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) =>
        app.request(input instanceof Request ? input : new Request(input, init)),
    });
    const client = new Client({ name: "write-client", version: "1.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some((t) => t.name === "resolve_items"));

      const l1 = parseToolJson<{ digest: string }>(
        (await client.callTool({ name: "get_item", arguments: { id: "L1" } })) as {
          content: Array<{ type: string; text?: string }>;
        },
      );
      const l2 = parseToolJson<{ digest: string }>(
        (await client.callTool({ name: "get_item", arguments: { id: "L2" } })) as {
          content: Array<{ type: string; text?: string }>;
        },
      );
      const c1 = await entries.add({
        itemId: "L1",
        kind: "clarification",
        userId: pmId,
        body: "第一批 L1 结论",
        itemDigest: l1.digest,
        baseClarificationId: 0,
      });
      const c2 = await entries.add({
        itemId: "L2",
        kind: "clarification",
        userId: pmId,
        body: "第一批 L2 结论",
        itemDigest: l2.digest,
        baseClarificationId: 0,
      });
      assert.ok(c1.ok && c2.ok);

      // Mark only L1 applied; L2 stays unapplied
      const resolved = parseToolJson<{
        succeeded: number;
        failed: number;
        results: Array<{ id: string; ok: boolean }>;
      }>(
        (await client.callTool({
          name: "resolve_items",
          arguments: {
            items: [{ id: "L1", clarificationId: c1.entry.id, note: "已更新 login.md" }],
            actor: "claude",
          },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(resolved.succeeded, 1);
      assert.equal(resolved.failed, 0);

      const pendingApply = parseToolJson<{
        summary: { clarified: number; applied: number; unappliedClarified: number };
        items: Array<{ id: string; applied: boolean }>;
      }>(
        (await client.callTool({
          name: "list_items",
          arguments: { status: "clarified", applied: false },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(pendingApply.summary.clarified, 2);
      assert.equal(pendingApply.summary.applied, 1);
      assert.equal(pendingApply.summary.unappliedClarified, 1);
      assert.deepEqual(
        pendingApply.items.map((i) => i.id),
        ["L2"],
      );

      // afterClarificationId cursor returns only items clarified after c1
      const afterC1 = parseToolJson<{ items: Array<{ id: string }> }>(
        (await client.callTool({
          name: "list_items",
          arguments: { afterClarificationId: c1.entry.id },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.deepEqual(
        afterC1.items.map((i) => i.id),
        ["L2"],
      );

      // Newer clarification on L1 automatically makes L1 unapplied again, and stale ack is rejected
      const c1New = await entries.add({
        itemId: "L1",
        kind: "clarification",
        userId: pmId,
        body: "第二批补充 L1",
        itemDigest: l1.digest,
        baseClarificationId: c1.entry.id,
      });
      assert.ok(c1New.ok);

      const conflict = parseToolJson<{
        succeeded: number;
        failed: number;
        results: Array<{ id: string; ok: boolean; reason?: string }>;
      }>(
        (await client.callTool({
          name: "resolve_items",
          arguments: {
            items: [{ id: "L1", clarificationId: c1.entry.id }],
          },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.equal(conflict.failed, 1);
      assert.equal(conflict.results[0]?.reason, "stale_clarification");

      const unappliedAfterBatch2 = parseToolJson<{ items: Array<{ id: string }> }>(
        (await client.callTool({
          name: "list_items",
          arguments: { status: "clarified", applied: false },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      assert.deepEqual(
        unappliedAfterBatch2.items.map((i) => i.id),
        ["L1", "L2"],
      );
    } finally {
      await client.close();
    }
  });
});
