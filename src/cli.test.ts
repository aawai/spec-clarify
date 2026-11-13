import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { hashPassword } from "./auth.js";
import { loadProjectConfig, loadWorkspace } from "./project.js";
import { openDatabase } from "./store/database.js";
import { EntryStore } from "./store/entries.js";
import { UserStore } from "./store/users.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = resolve("src/cli.ts");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const TSX_ARGS = ["--import", TSX_LOADER, CLI_PATH];

test("skill path and skill install work without a spec-clarify.config.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-cli-"));
  try {
    const { stdout: skillPath } = await execFileAsync(
      process.execPath,
      [...TSX_ARGS, "skill", "path"],
      {
        cwd: dir,
      },
    );
    assert.equal(skillPath.trim(), resolve("skills/spec-clarify-review"));

    // Default target (.agents/skills/spec-clarify-review)
    await execFileAsync(process.execPath, [...TSX_ARGS, "skill", "install"], { cwd: dir });
    const installedDefault = await readFile(
      join(dir, ".agents/skills/spec-clarify-review/SKILL.md"),
      "utf8",
    );
    const source = await readFile(resolve("skills/spec-clarify-review/SKILL.md"), "utf8");
    assert.equal(installedDefault, source);

    // Custom target
    await execFileAsync(
      process.execPath,
      [...TSX_ARGS, "skill", "install", "--target", ".claude/skills/spec-clarify-review"],
      { cwd: dir },
    );
    const installedCustom = await readFile(
      join(dir, ".claude/skills/spec-clarify-review/SKILL.md"),
      "utf8",
    );
    assert.equal(installedCustom, source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mcp --print-config outputs .mcp.json snippet without needing config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-cli-"));
  try {
    const { stdout: defaultJson } = await execFileAsync(
      process.execPath,
      [...TSX_ARGS, "mcp", "--print-config"],
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(defaultJson), {
      mcpServers: {
        "spec-clarify": {
          command: "npx",
          args: ["spec-clarify", "mcp"],
        },
      },
    });

    const { stdout: customJson } = await execFileAsync(
      process.execPath,
      [...TSX_ARGS, "mcp", "--print-config", "-c", "docs/spec-clarify.config.json"],
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(customJson), {
      mcpServers: {
        "spec-clarify": {
          command: "npx",
          args: ["spec-clarify", "mcp", "-c", "docs/spec-clarify.config.json"],
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mcp --write --print-config includes --write flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-cli-"));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [...TSX_ARGS, "mcp", "--write", "--print-config"],
      { cwd: dir },
    );
    assert.deepEqual(JSON.parse(stdout), {
      mcpServers: {
        "spec-clarify": {
          command: "npx",
          args: ["spec-clarify", "mcp", "--write"],
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ack and reopen commands update resolution state, enforce --clarification, and show in export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-cli-"));
  try {
    await mkdir(join(dir, "specs"), { recursive: true });
    await writeFile(join(dir, "specs/login.md"), "# 登录\n\n内容。\n");
    await writeFile(
      join(dir, "review.md"),
      "# 审核\n\n## 登录\n\n### L1 锁定时长\n- 文档：specs/login.md\n\n:3 需补充。\n",
    );
    await writeFile(
      join(dir, "spec-clarify.config.json"),
      JSON.stringify({
        title: "CLI 测试",
        documents: ["specs/*.md"],
        reviews: [{ path: "review.md" }],
        database: "data/db.sqlite",
      }),
    );
    const client = await openDatabase(join(dir, "data/db.sqlite"));
    let clarificationId = 0;
    try {
      const users = new UserStore(client);
      const pm = await users.create({
        username: "pm",
        displayName: "产品",
        role: "product",
        passwordHash: await hashPassword("password-1"),
      });
      const entries = new EntryStore(client);
      const config = await loadProjectConfig(join(dir, "spec-clarify.config.json"));
      const ws = await loadWorkspace(config);
      const added = await entries.add({
        itemId: "L1",
        kind: "clarification",
        userId: pm.id,
        body: "锁定 15 分钟",
        itemDigest: ws.review.items[0]!.digest,
        baseClarificationId: 0,
      });
      assert.ok(added.ok);
      clarificationId = added.entry.id;
    } finally {
      client.close();
    }

    // Wrong --clarification fails with exit code 1
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [...TSX_ARGS, "ack", "L1", "--clarification", String(clarificationId + 99)],
        { cwd: dir },
      ),
    );

    const acked = await execFileAsync(
      process.execPath,
      [
        ...TSX_ARGS,
        "ack",
        "L1",
        "--clarification",
        String(clarificationId),
        "--by",
        "codex",
        "--note",
        "已写入 specs/login.md",
      ],
      { cwd: dir },
    );
    assert.match(acked.stdout, /L1 已标记为已落地/);

    const exportedApplied = await execFileAsync(process.execPath, [...TSX_ARGS, "export"], {
      cwd: dir,
    });
    assert.match(exportedApplied.stdout, /已澄清（已落地）/);
    assert.match(exportedApplied.stdout, /codex 已落地（针对澄清 #\d+）：已写入 specs\/login\.md/);

    const reopened = await execFileAsync(
      process.execPath,
      [...TSX_ARGS, "reopen", "L1", "--by", "dev", "--note", "待补充测试"],
      { cwd: dir },
    );
    assert.match(reopened.stdout, /L1 已重新打开/);

    const exportedReopened = await execFileAsync(process.execPath, [...TSX_ARGS, "export"], {
      cwd: dir,
    });
    assert.doesNotMatch(exportedReopened.stdout, /已澄清（已落地）/);
    assert.match(exportedReopened.stdout, /dev 重新打开（针对澄清 #\d+）：待补充测试/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
