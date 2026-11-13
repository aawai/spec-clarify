import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { itemState } from "../clarification.js";
import { openDatabase } from "./database.js";
import { EntryStore, type NewEntry } from "./entries.js";
import { UserStore } from "./users.js";

async function withStore(
  run: (entries: EntryStore, userIds: { a: number; b: number }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "spec-clarify-"));
  const client = await openDatabase(join(dir, "db.sqlite"));
  try {
    const users = new UserStore(client);
    const a = await users.create({
      username: "a",
      displayName: "产品 A",
      role: "product",
      passwordHash: "x",
    });
    const b = await users.create({
      username: "b",
      displayName: "产品 B",
      role: "product",
      passwordHash: "x",
    });
    await run(new EntryStore(client), { a: a.id, b: b.id });
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const clarification = (overrides: Partial<NewEntry>): NewEntry => ({
  itemId: "C1",
  kind: "clarification",
  userId: 0,
  body: "以登录文档为准",
  itemDigest: "d1",
  baseClarificationId: 0,
  ...overrides,
});

const stateOf = async (entries: EntryStore, digest = "d1") =>
  itemState({ digest }, (await entries.activity()).get("C1"));

test("a clarification based on an outdated answer is rejected and reports the newer one", async () => {
  await withStore(async (entries, users) => {
    const first = await entries.add(clarification({ userId: users.a }));
    assert.ok(first.ok);

    const concurrent = await entries.add(clarification({ userId: users.b, body: "另一结论" }));
    assert.equal(concurrent.ok, false);
    assert.equal(concurrent.ok ? undefined : concurrent.latest.author.displayName, "产品 A");

    const followUp = await entries.add(
      clarification({ userId: users.b, body: "补充", baseClarificationId: first.entry.id }),
    );
    assert.ok(followUp.ok);
    assert.equal((await entries.activity()).get("C1")?.latestClarification?.body, "补充");
  });
});

test("comments never conflict; a comment after the latest clarification awaits a reply", async () => {
  await withStore(async (entries, users) => {
    assert.deepEqual(await stateOf(entries), {
      status: "open",
      awaitingReply: false,
      applied: false,
    });
    assert.ok((await entries.add({ ...clarification({ userId: users.a }), kind: "comment" })).ok);
    assert.deepEqual(await stateOf(entries), {
      status: "open",
      awaitingReply: true,
      applied: false,
    });

    const answer = await entries.add(clarification({ userId: users.a }));
    assert.ok(answer.ok);
    assert.deepEqual(await stateOf(entries), {
      status: "clarified",
      awaitingReply: false,
      applied: false,
    });
    assert.deepEqual(await stateOf(entries, "d2"), {
      status: "stale",
      awaitingReply: false,
      applied: false,
    });

    assert.ok((await entries.add({ ...clarification({ userId: users.b }), kind: "comment" })).ok);
    assert.deepEqual(await stateOf(entries), {
      status: "clarified",
      awaitingReply: true,
      applied: false,
    });
  });
});

test("resolutions track applied clarifications, reject stale IDs, and clear on newer clarifications or stale items", async () => {
  await withStore(async (entries, users) => {
    const before = await entries.resolve({ itemId: "C1", action: "applied", actor: "ai" });
    assert.deepEqual(before, { ok: false, reason: "no_clarification" });

    const first = await entries.add(clarification({ userId: users.a }));
    assert.ok(first.ok);

    const applied = await entries.resolve({
      itemId: "C1",
      action: "applied",
      actor: "claude",
      note: "已更新 specs/login.md",
      clarificationId: first.entry.id,
    });
    assert.ok(applied.ok);
    assert.equal(applied.resolution.clarificationId, first.entry.id);
    assert.equal((await stateOf(entries)).applied, true);
    assert.equal((await stateOf(entries, "d2")).applied, false);

    const reopened = await entries.resolve({
      itemId: "C1",
      action: "reopened",
      actor: "dev",
      note: "需要回滚",
    });
    assert.ok(reopened.ok);
    assert.equal((await stateOf(entries)).applied, false);

    const reapplied = await entries.resolve({ itemId: "C1", action: "applied", actor: "ai" });
    assert.ok(reapplied.ok);
    assert.equal((await stateOf(entries)).applied, true);

    const second = await entries.add(
      clarification({ userId: users.b, body: "补充要求", baseClarificationId: first.entry.id }),
    );
    assert.ok(second.ok);
    assert.equal((await stateOf(entries)).applied, false);

    const staleAck = await entries.resolve({
      itemId: "C1",
      action: "applied",
      actor: "ai",
      clarificationId: first.entry.id,
    });
    assert.equal(staleAck.ok, false);
    if (!staleAck.ok && staleAck.reason === "stale_clarification") {
      assert.equal(staleAck.latest.id, second.entry.id);
    } else {
      assert.fail("Expected stale_clarification");
    }
  });
});
