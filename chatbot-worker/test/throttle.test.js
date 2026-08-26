import assert from "node:assert/strict";
import { test } from "node:test";
import { getThrottleStats, recordThrottle, resetThrottleForTests } from "../lib/throttle.js";

// A D1 stand-in whose chat_throttle_events table does not exist until it is created,
// which is exactly the state a deploy leaves behind when migration 0005 was skipped.
function dbWithoutThrottleTable() {
  const state = { exists: false, rows: new Map(), statements: [] };
  return {
    state,
    prepare(sql) {
      const run = async (args = []) => {
        state.statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
        if (/CREATE TABLE IF NOT EXISTS chat_throttle_events/i.test(sql)) {
          state.exists = true;
          return { meta: { changes: 0 } };
        }
        if (!state.exists) throw new Error("D1_ERROR: no such table: chat_throttle_events");
        const key = `${args[0]}:${args[1]}`;
        state.rows.set(key, (state.rows.get(key) || 0) + 1);
        return { meta: { changes: 1 } };
      };
      return { bind: (...args) => ({ run: () => run(args) }), run: () => run([]) };
    },
  };
}

test("creates the throttle table itself when migration 0005 was never applied", async () => {
  resetThrottleForTests();
  const db = dbWithoutThrottleTable();
  await recordThrottle(db, "visitor-minute", 1_700_000_000_000);
  // The count must survive, not just the table: a repair that swallows the event it
  // was triggered by still reports zero on the dashboard for the first rejection.
  assert.equal(db.state.rows.size, 1, "the rejection that triggered the repair must still be counted");
  assert.ok(db.state.statements.some((sql) => /^CREATE TABLE IF/i.test(sql)));
});

test("repairs once, not on every rejected request", async () => {
  resetThrottleForTests();
  const db = dbWithoutThrottleTable();
  for (let index = 0; index < 5; index += 1) await recordThrottle(db, "visitor-minute", 1_700_000_000_000);
  const creates = db.state.statements.filter((sql) => /^CREATE TABLE IF/i.test(sql));
  assert.equal(creates.length, 1, "a hot 429 path must not re-run DDL on every request");
});

test("never lets a broken counter reach the visitor", async () => {
  resetThrottleForTests();
  // Nothing works: neither the insert nor the repair. recordThrottle still resolves,
  // because losing a statistic must never turn into a failed response.
  const brokenDb = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("nope"); } }), run: async () => { throw new Error("nope"); } }) };
  await assert.doesNotReject(() => recordThrottle(brokenDb, "visitor-day", 1_700_000_000_000));
  await assert.doesNotReject(() => getThrottleStats(brokenDb, 1_700_000_000_000));
});
