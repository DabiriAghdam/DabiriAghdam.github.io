import assert from "node:assert/strict";
import { test } from "node:test";
import { digestEnabled, digestIntervalDays, maybeSendDigest, nextDigestDue, renderDigest, resetDigestForTests } from "../lib/digest.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const env = (extra = {}) => ({
  DIGEST_WEBHOOK_URL: "https://script.google.com/macros/s/example/exec",
  DIGEST_WEBHOOK_SECRET: "relay-secret",
  DIGEST_TO_EMAIL: "owner@example.com",
  ...extra,
});

const emptyStats = { messages: 0, questions: 0, conversations: 0, visitors: 0, blocked: 0, delivered: 0, models: [], countries: [] };

function mockFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responder(calls.length);
  };
  return calls;
}

test("is off unless the HTTPS relay, shared secret, and recipient are configured", () => {
  assert.equal(digestEnabled(env()), true);
  assert.equal(digestEnabled(env({ DIGEST_WEBHOOK_URL: "" })), false);
  assert.equal(digestEnabled(env({ DIGEST_WEBHOOK_SECRET: "" })), false);
  assert.equal(digestEnabled(env({ DIGEST_TO_EMAIL: "" })), false);
  assert.equal(digestEnabled(env({ DIGEST_WEBHOOK_URL: "http://example.com/relay" })), false);
  assert.equal(digestEnabled({}), false);
});

test("clamps the interval instead of letting a typo disable or spam it", () => {
  assert.equal(digestIntervalDays({}), 7, "the default is weekly");
  assert.equal(digestIntervalDays({ DIGEST_INTERVAL_DAYS: "14" }), 14);
  // A stray 0 must not mean "mail on every trigger", and a stray 100000 must not mean
  // "never mail again". Both clamp into the supported range.
  assert.equal(digestIntervalDays({ DIGEST_INTERVAL_DAYS: "0" }), 1);
  assert.equal(digestIntervalDays({ DIGEST_INTERVAL_DAYS: "100000" }), 90);
  assert.equal(digestIntervalDays({ DIGEST_INTERVAL_DAYS: "banana" }), 7);
});

test("the first trigger starts the clock rather than mailing a partial period", async () => {
  resetDigestForTests();
  const calls = mockFetch(() => new Response("{}", { status: 200 }));
  const result = await maybeSendDigest(env(), null, NOW);
  assert.equal(result.sent, false);
  assert.equal(result.reason, "initialised");
  assert.equal(calls.length, 0, "a digest covering an arbitrary slice of history is worse than none");

  // ...and one interval later it does send.
  const later = await maybeSendDigest(env(), null, NOW + 7 * DAY);
  assert.equal(later.sent, true);
  assert.equal(calls.length, 1);
});

test("does not mail again until a full interval has passed", async () => {
  resetDigestForTests();
  const calls = mockFetch(() => new Response("{}", { status: 200 }));
  await maybeSendDigest(env(), null, NOW);
  await maybeSendDigest(env(), null, NOW + 7 * DAY);
  assert.equal(calls.length, 1);

  const tooSoon = await maybeSendDigest(env(), null, NOW + 13 * DAY);
  assert.equal(tooSoon.sent, false);
  assert.equal(tooSoon.reason, "not-due");
  assert.equal(calls.length, 1, "a trigger inside the interval must be a no-op");

  await maybeSendDigest(env(), null, NOW + 14 * DAY);
  assert.equal(calls.length, 2);
});

test("keeps the clock unmoved when sending fails, so the period is retried not skipped", async () => {
  resetDigestForTests();
  const calls = mockFetch((n) => n === 1
    ? new Response('{"message":"domain not verified"}', { status: 403 })
    : new Response("{}", { status: 200 }));
  await maybeSendDigest(env(), null, NOW);

  const failed = await maybeSendDigest(env(), null, NOW + 7 * DAY);
  assert.equal(failed.sent, false);
  assert.equal(failed.reason, "send-failed");
  assert.equal(failed.status, 403);

  // The retry happens on the very next trigger rather than a week later, because a
  // failed send must not consume the period it was reporting on.
  const retried = await maybeSendDigest(env(), null, NOW + 7 * DAY + 60_000);
  assert.equal(retried.sent, true);
  // Two requests, not three: the very first trigger only started the clock.
  assert.equal(calls.length, 2);
});

test("a forced send still resets the clock, so it cannot double up with the scheduled one", async () => {
  resetDigestForTests();
  const calls = mockFetch(() => new Response("{}", { status: 200 }));
  await maybeSendDigest(env(), null, NOW);
  await maybeSendDigest(env(), null, NOW + DAY, { force: true });
  assert.equal(calls.length, 1);

  const scheduled = await maybeSendDigest(env(), null, NOW + 7 * DAY);
  assert.equal(scheduled.sent, false, "the manual send already covered this period");
  assert.equal(calls.length, 1);
});

test("does nothing at all when the feature is not configured", async () => {
  resetDigestForTests();
  const calls = mockFetch(() => new Response("{}", { status: 200 }));
  const result = await maybeSendDigest({}, null, NOW);
  assert.equal(result.reason, "disabled");
  assert.equal(calls.length, 0);
});

test("leads with a verdict, so a quiet week reads differently from a broken one", () => {
  const base = { periodDays: 7, since: NOW - 7 * DAY, until: NOW, providers: ["groq"] };

  const quiet = renderDigest({ ...base, stats: emptyStats, throttle: { week: 0, byKind: {} } });
  assert.match(quiet.subject, /No questions this period/);

  const healthy = renderDigest({ ...base, stats: { ...emptyStats, messages: 40, delivered: 20, questions: 20 }, throttle: { week: 0, byKind: {} } });
  assert.match(healthy.subject, /nothing turned away/);

  // The case the digest exists for: traffic arrived and the chain could not serve it.
  const broken = renderDigest({ ...base, stats: { ...emptyStats, messages: 40, delivered: 5, questions: 20 }, throttle: { week: 15, byKind: { "upstream-exhausted": 15 } } });
  assert.match(broken.subject, /ran out of budget/);
  assert.match(broken.text, /worth checking the caps/);
  assert.notEqual(quiet.subject, broken.subject, "a silent failure must not look like a quiet week");
});

test("says so loudly when no provider is configured at all", () => {
  const message = renderDigest({ periodDays: 7, since: NOW - 7 * DAY, until: NOW, stats: emptyStats, throttle: { week: 0, byKind: {} }, providers: [] });
  assert.match(message.text, /No providers are configured/);
});

test("escapes report content into the HTML body", () => {
  const message = renderDigest({
    periodDays: 7, since: NOW - 7 * DAY, until: NOW, providers: ["groq"],
    stats: { ...emptyStats, messages: 1, models: [["<script>alert(1)</script>", 1]], countries: [] },
    throttle: { week: 0, byKind: {} },
  });
  assert.doesNotMatch(message.html, /<script>alert/);
  assert.match(message.html, /&lt;script&gt;/);
});

test("sends the digest only to the configured private relay", async () => {
  resetDigestForTests();
  const calls = mockFetch(() => Response.json({ ok: true }));
  await maybeSendDigest(env(), null, NOW);
  await maybeSendDigest(env(), null, NOW + 7 * DAY);
  assert.equal(calls[0].url, "https://script.google.com/macros/s/example/exec");
  assert.equal(calls[0].body.to, "owner@example.com");
  assert.equal(calls[0].body.token, "relay-secret");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
});

test("does not advance the clock when the relay rejects the shared secret", async () => {
  resetDigestForTests();
  const calls = mockFetch(() => Response.json({ ok: false, error: "unauthorized" }));
  await maybeSendDigest(env(), null, NOW);
  const result = await maybeSendDigest(env(), null, NOW + 7 * DAY);
  assert.equal(result.sent, false);
  assert.match(result.detail, /unauthorized/);
  assert.equal(calls.length, 1);
});

test("reports when the next digest is due", () => {
  assert.deepEqual(nextDigestDue(null, 7, NOW), { due: true, first: true, at: NOW });
  assert.equal(nextDigestDue({ lastSentAt: NOW }, 7, NOW + 3 * DAY).due, false);
  assert.equal(nextDigestDue({ lastSentAt: NOW }, 7, NOW + 7 * DAY).due, true);
});

// A fake D1 whose digest read does not resolve until both callers have made it, so the
// two triggers are guaranteed to see the same clock. Without that the test would pass
// by accident whenever one call happened to finish first.
function racingDb(digest) {
  const state = { digest };
  let arrived = 0;
  let release;
  const bothRead = new Promise((resolve) => { release = resolve; });

  function operation(sql, args = []) {
    return {
      bind(...next) { return operation(sql, next); },
      async all() { return { results: [] }; },
      async first() {
        if (/FROM chat_digest_state/i.test(sql)) {
          arrived += 1;
          if (arrived >= 2) release();
          await bothRead;
          return state.digest;
        }
        return { messages: 0, questions: 0, conversations: 0, visitors: 0, blocked: 0, delivered: 0 };
      },
      async run() {
        if (/UPDATE chat_digest_state/i.test(sql)) {
          if (/AND last_sent_at = \?/i.test(sql)) {
            if (!state.digest || state.digest.last_sent_at !== args[1]) return { meta: { changes: 0 } };
            state.digest = { last_sent_at: args[0], last_status: "sending" };
            return { meta: { changes: 1 } };
          }
          state.digest = { last_sent_at: args[0], last_status: args[1] };
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO chat_digest_state/i.test(sql)) {
          state.digest = { last_sent_at: args[0], last_status: args[1] };
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }

  return { state, prepare: (sql) => operation(sql) };
}

test("two triggers arriving together send one digest, not two", async () => {
  resetDigestForTests();
  const calls = mockFetch(() => new Response("{}", { status: 200 }));
  // Every chat request checks whether the digest is due, so two concurrent visitors on
  // the day it comes due is the ordinary case, not a corner one.
  const db = racingDb({ last_sent_at: NOW - 8 * DAY, last_status: "sent" });
  const results = await Promise.all([
    maybeSendDigest(env(), db, NOW),
    maybeSendDigest(env(), db, NOW),
  ]);

  assert.equal(calls.length, 1, "the second trigger must not mail a duplicate report");
  assert.equal(results.filter((result) => result.sent).length, 1);
  assert.equal(results.find((result) => !result.sent).reason, "in-progress");
  assert.equal(db.state.digest.last_status, "sent");
  assert.equal(db.state.digest.last_sent_at, NOW, "the winner's send advances the clock");
});
