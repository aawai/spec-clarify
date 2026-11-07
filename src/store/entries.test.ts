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
    assert.deepEqual(await stateOf(entries), { status: "open", awaitingReply: false });
    assert.ok((await entries.add({ ...clarification({ userId: users.a }), kind: "comment" })).ok);
    assert.deepEqual(await stateOf(entries), { status: "open", awaitingReply: true });

    const answer = await entries.add(clarification({ userId: users.a }));
    assert.ok(answer.ok);
    assert.deepEqual(await stateOf(entries), { status: "clarified", awaitingReply: false });
    assert.deepEqual(await stateOf(entries, "d2"), { status: "stale", awaitingReply: false });

    assert.ok((await entries.add({ ...clarification({ userId: users.b }), kind: "comment" })).ok);
    assert.deepEqual(await stateOf(entries), { status: "clarified", awaitingReply: true });
  });
});
