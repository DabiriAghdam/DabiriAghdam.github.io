import assert from "node:assert/strict";
import { test } from "node:test";
import { importAuditMessages, listAuditMessages } from "../lib/audit.js";

// These exercise the D1-less fallback store, which is the same code path the worker
// uses when DB is unbound, so the restore logic is covered without standing up D1.
test("restores an exported backup and stays safe to run twice", async () => {
  // The natural way to use a backup is to import it, decide it did not fix the thing,
  // and import it again. That must not double every message, so rows carry their
  // original id and a second import is a no-op.
  const backup = {
    exportedAt: "2026-08-20T10:00:00.000Z",
    messages: [
      { id: 41, session_id: "s1", role: "user", content: "What is SimMark?", status: "ok", created_at: "2026-08-20T09:59:00.000Z" },
      { id: 42, session_id: "s1", role: "assistant", content: "A sentence-level watermark.", status: "ok", model: "groq:openai/gpt-oss-20b", created_at: "2026-08-20T09:59:04.000Z" },
    ],
  };
  const first = await importAuditMessages(null, backup);
  assert.deepEqual(first, { ok: true, imported: 2, duplicates: 0, skipped: 0 });

  const second = await importAuditMessages(null, backup);
  assert.equal(second.imported, 0, "re-importing the same backup must not duplicate it");
  assert.equal(second.duplicates, 2);

  const stored = await listAuditMessages(null, { limit: 50 });
  assert.equal(stored.filter((row) => row.session_id === "s1").length, 2);
});

test("accepts a bare array and the camelCase shape, and skips unimportable rows", async () => {
  const result = await importAuditMessages(null, [
    { id: 91, sessionId: "s2", role: "user", content: "Hi", createdAt: "2026-08-21T00:00:00.000Z" },
    { id: 92, session_id: "s2", role: "system", content: "nope", created_at: "2026-08-21T00:00:01.000Z" },
    { session_id: "s2", role: "user", content: "no id", created_at: "2026-08-21T00:00:02.000Z" },
    { id: 94, session_id: "s2", role: "user", content: "", created_at: "2026-08-21T00:00:03.000Z" },
    "not an object",
  ]);
  // Only the first row is a message: a "system" role, a row with no id to deduplicate
  // on, an empty body, and a bare string are all counted rather than half-imported.
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 4);
});

test("refuses JSON that is not a chat export", async () => {
  assert.deepEqual(await importAuditMessages(null, { totally: "unrelated" }), { ok: false, reason: "shape" });
  assert.deepEqual(await importAuditMessages(null, 42), { ok: false, reason: "shape" });
});

test("bulk-restores a large D1 backup in bounded JSON chunks", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM json_each\(\?\)/);
      return {
        bind(json) {
          return {
            async run() {
              const rows = JSON.parse(json);
              calls.push({ bytes: new TextEncoder().encode(json).byteLength, rows: rows.length });
              return { meta: { changes: rows.length } };
            },
          };
        },
      };
    },
  };
  const messages = Array.from({ length: 1_000 }, (_, index) => ({
    id: index + 1,
    session_id: `session-${Math.floor(index / 2)}`,
    role: index % 2 ? "assistant" : "user",
    content: "x".repeat(2_000),
    status: "accepted",
    created_at: Date.now() + index,
  }));
  const result = await importAuditMessages(db, { messages });
  assert.equal(result.imported, messages.length);
  assert.ok(calls.length > 1, "a large backup must be split below the bound-value limit");
  assert.ok(calls.length < 10, "bulk import must not spend one D1 query per message");
  assert.ok(calls.every((call) => call.bytes <= 1_500_000));
});
