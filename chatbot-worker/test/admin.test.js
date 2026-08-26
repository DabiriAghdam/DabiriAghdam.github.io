import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAdminRequest } from "../lib/admin.js";

function mockDb(rows = [], throttle = []) {
  const state = { credential: null, rows: [...rows], counters: new Map(), counterReads: 0, throttle: [...throttle], digest: null };

  function operation(sql, args = []) {
    return {
      bind(...nextArgs) { return operation(sql, nextArgs); },
      async all() {
        if (/FROM chat_throttle_events/i.test(sql)) {
          return { results: state.throttle.filter((row) => row.day_window >= args[0]) };
        }
        if (/GROUP BY ip_address/i.test(sql)) return { results: [...state.rows] };
        if (/GROUP BY COALESCE/i.test(sql)) return { results: [{ country: "CA", visitors: 1, messages: state.rows.length }] };
        if (/SELECT session_id, MAX\(created_at\)/i.test(sql)) {
          const sessions = new Map();
          state.rows.forEach((row) => sessions.set(row.session_id, Math.max(sessions.get(row.session_id) || 0, row.created_at)));
          const limit = Number(args.at(-2)) || 10;
          const offset = Number(args.at(-1)) || 0;
          return { results: [...sessions.entries()].sort((left, right) => right[1] - left[1]).slice(offset, offset + limit).map(([session_id, latest]) => ({ session_id, latest })) };
        }
        if (/session_id IN \(/i.test(sql)) {
          const sessionIds = new Set(args.filter((value) => state.rows.some((row) => row.session_id === value)));
          return { results: state.rows.filter((row) => sessionIds.has(row.session_id)).sort((a, b) => b.created_at - a.created_at) };
        }
        if (/FROM chat_messages/i.test(sql)) return { results: [...state.rows].sort((a, b) => b.created_at - a.created_at) };
        return { results: [] };
      },
      async first() {
        if (/FROM admin_credentials/i.test(sql)) return state.credential;
        if (/FROM chat_digest_state/i.test(sql)) return state.digest;
        if (/SELECT[\s\S]*FROM chat_rate_limits/i.test(sql)) {
          state.counterReads += 1;
          const counter = state.counters.get(args[0]);
          return counter ? { minute_window: counter.minuteWindow, minute_count: counter.minuteCount, day_window: counter.dayWindow, day_count: counter.dayCount } : null;
        }
        if (/INSERT INTO chat_rate_limits/i.test(sql)) {
          const [key, minuteWindow, dayWindow] = [args[0], args[1], args[2]];
          const previous = state.counters.get(key);
          const counter = {
            minuteWindow,
            minuteCount: previous?.minuteWindow === minuteWindow ? previous.minuteCount + 1 : 1,
            dayWindow,
            dayCount: previous?.dayWindow === dayWindow ? previous.dayCount + 1 : 1,
          };
          state.counters.set(key, counter);
          return { minute_count: counter.minuteCount, day_count: counter.dayCount };
        }
        if (/COUNT\(\*\) AS total_messages/i.test(sql)) {
          const now = Date.now();
          return {
            total_messages: state.rows.length,
            total_sessions: new Set(state.rows.map((row) => row.session_id)).size,
            unique_visitors: new Set(state.rows.map((row) => row.ip_address).filter(Boolean)).size,
            blocked_messages: state.rows.filter((row) => row.status.startsWith("blocked-")).length,
            last_24h: state.rows.filter((row) => row.created_at >= now - 86_400_000).length,
            delivered_24h: state.rows.filter((row) => row.created_at >= now - 86_400_000 && row.role === "assistant" && (row.status === "accepted" || row.status === "truncated")).length,
            older_than_90: state.rows.filter((row) => row.created_at < now - 90 * 86_400_000).length,
          };
        }
        if (/COUNT\(DISTINCT session_id\) AS total_conversations/i.test(sql)) {
          return { total_conversations: new Set(state.rows.map((row) => row.session_id)).size };
        }
        return null;
      },
      async run() {
        if (/INSERT OR IGNORE INTO admin_credentials/i.test(sql) && !state.credential) {
          state.credential = { username: args[0], password_salt: args[1], password_hash: args[2], iterations: args[3], updated_at: args[4] };
        }
        if (/UPDATE admin_credentials/i.test(sql)) {
          state.credential = { username: args[0], password_salt: args[1], password_hash: args[2], iterations: args[3], updated_at: args[4] };
        }
        // Match the WHERE clause, not just the table: a session-id delete binds a
        // string where the age delete binds a timestamp, and treating them alike would
        // let a wrong query pass its test.
        if (/DELETE FROM chat_messages WHERE session_id/i.test(sql)) {
          const before = state.rows.length;
          state.rows = state.rows.filter((row) => row.session_id !== args[0]);
          return { meta: { changes: before - state.rows.length } };
        }
        if (/DELETE FROM chat_messages WHERE created_at/i.test(sql)) {
          const before = state.rows.length;
          state.rows = state.rows.filter((row) => row.created_at >= args[0]);
          return { meta: { changes: before - state.rows.length } };
        }
        // Restore. The real D1 honours the id column and the OR IGNORE, and both are
        // load-bearing: without them a repeated import silently doubles the log.
        if (/INSERT OR IGNORE INTO chat_messages/i.test(sql) && /json_each/i.test(sql)) {
          let changes = 0;
          for (const row of JSON.parse(args[0])) {
            if (state.rows.some((existing) => existing.id === row.id)) continue;
            state.rows.push({ ...row });
            changes += 1;
          }
          return { meta: { changes } };
        }
        // The digest claims its slot with a compare-and-swap before mailing, so the
        // mock has to honour the guarded WHERE. Reporting changes: 1 unconditionally
        // would hide a broken claim; reporting 0 would hide a working one.
        if (/UPDATE chat_digest_state/i.test(sql)) {
          if (/AND last_sent_at = \?/i.test(sql)) {
            if (!state.digest || state.digest.last_sent_at !== args[1]) return { meta: { changes: 0 } };
            state.digest = { last_sent_at: args[0], last_status: "sending" };
            return { meta: { changes: 1 } };
          }
          if (!state.digest) return { meta: { changes: 0 } };
          state.digest = { last_sent_at: args[0], last_status: args[1] };
          return { meta: { changes: 1 } };
        }
        if (/INSERT OR IGNORE INTO chat_digest_state/i.test(sql)) {
          if (state.digest) return { meta: { changes: 0 } };
          state.digest = { last_sent_at: args[0], last_status: "sending" };
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO chat_digest_state/i.test(sql)) {
          state.digest = { last_sent_at: args[0], last_status: args[1] };
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM chat_digest_state/i.test(sql)) {
          const changes = state.digest ? 1 : 0;
          state.digest = null;
          return { meta: { changes } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
  }

  return {
    state,
    prepare(sql) { return operation(sql); },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function request(path = "/admin", credentials, options = {}) {
  const headers = new Headers(options.headers || {});
  if (credentials) headers.set("Authorization", `Basic ${Buffer.from(credentials).toString("base64")}`);
  return new Request(`https://assistant.example${path}`, { ...options, headers });
}

function envWith(db, extra = {}) {
  return { ADMIN_USERNAME: "amir", ADMIN_PASSWORD: "strong-password", DB: db, ...extra };
}

test("requires authentication for the audit dashboard", async () => {
  const response = await handleAdminRequest(request(), envWith(mockDb()));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("WWW-Authenticate"), /Amir Chat Dashboard/);
});

test("renders the full dashboard and bootstraps hashed credentials", async () => {
  const db = mockDb([{ id: 1, session_id: "session-12345678", visitor_hash: "abcdef123456", ip_address: "203.0.113.10", country: "CA", region: "British Columbia", city: "Vancouver", latitude: "49.28270", longitude: "-123.12070", role: "assistant", content: "Hello", reasoning: "I checked the profile context.", status: "accepted", origin: "https://dabiriaghdam.github.io", model: "openai/gpt-oss-20b", created_at: Date.now() }]);
  const response = await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Chat logs/);
  assert.match(html, /Conversations and visitor activity/);
  assert.match(html, /Times shown in Vancouver/);
  assert.match(html, /<h2>Search<\/h2>/);
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /admin-theme/);
  assert.doesNotMatch(html, /private-mark/);
  assert.match(html, /Change dashboard password/);
  assert.match(html, /Delete messages older than 90 days/);
  assert.match(html, /Visitor geography/);
  assert.match(html, /203\.0\.113\.10/);
  assert.match(html, /Model reasoning/);
  assert.match(html, /I checked the profile context/);
  assert.doesNotMatch(db.state.credential.password_hash, /strong-password/);
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
});

test("renders dashboard timestamps in Vancouver time", async () => {
  const db = mockDb([auditRow({ created_at: Date.UTC(2026, 0, 15, 20, 30, 0) })]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db))).text();
  assert.match(html, /Jan 15, 2026, 12:30:00 PST/);
  assert.doesNotMatch(html, /2026-01-15 20:30:00 UTC/);
});

test("does not render an empty map when the host supplies countries but no coordinates", async () => {
  const db = mockDb([auditRow({ country: "CA", latitude: null, longitude: null })]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db))).text();
  assert.match(html, /Where visitors come from/);
  assert.match(html, /Country data can remain available/);
  assert.doesNotMatch(html, /id="geo-map"/);
});

test("paginates conversations ten per page and preserves the page state", async () => {
  const now = Date.now();
  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    session_id: `session-${String(index).padStart(2, "0")}`,
    visitor_hash: `visitor-${index}`,
    ip_address: `203.0.113.${index + 1}`,
    country: "CA",
    role: "user",
    content: `Question ${index}`,
    status: "accepted",
    origin: "https://dabiriaghdam.github.io",
    model: "openai/gpt-oss-20b",
    created_at: now - index,
  }));
  const response = await handleAdminRequest(request("/admin?page=2", "amir:strong-password"), envWith(mockDb(rows)));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Showing 11–12 of 12 conversations/);
  assert.match(html, /Page 2 of 2/);
  assert.match(html, /Question 10/);
  assert.match(html, /Question 11/);
  assert.doesNotMatch(html, /Question 0/);
  assert.match(html, /href="\/admin\?page=1"/);
});

test("keeps conversations reachable beyond the former five-thousand-row cap", async () => {
  const now = Date.now();
  const rows = Array.from({ length: 5001 }, (_, index) => ({
    id: index + 1,
    session_id: `long-session-${String(index).padStart(5, "0")}`,
    visitor_hash: `visitor-${index}`,
    role: "user",
    content: `Long-history question ${index}`,
    status: "accepted",
    origin: "https://dabiriaghdam.github.io",
    model: "openai/gpt-oss-20b",
    created_at: now - index,
  }));
  const response = await handleAdminRequest(request("/admin?page=501", "amir:strong-password"), envWith(mockDb(rows)));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Showing 5001–5001 of 5001 conversations/);
  assert.match(html, /Long-history question 5000/);
  assert.doesNotMatch(html, /Long-history question 0/);
});

test("exports records with indefinite retention metadata", async () => {
  const db = mockDb();
  const response = await handleAdminRequest(request("/admin/export.json", "amir:strong-password"), envWith(db));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  const body = await response.json();
  assert.equal(body.retention, "indefinite-until-manual-deletion");
  assert.equal(body.totalMessages, 0);
  assert.equal(body.truncated, false);
});

test("changes the stored password and rejects the old one", async () => {
  const db = mockDb();
  await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db));
  const body = new URLSearchParams({ new_password: "a-new-secure-password", confirm_password: "a-new-secure-password" });
  const changed = await handleAdminRequest(request("/admin/password", "amir:strong-password", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://assistant.example" },
    body,
  }), envWith(db));
  assert.equal(changed.status, 200);
  assert.match(await changed.text(), /Password updated/);

  const oldLogin = await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db));
  assert.equal(oldLogin.status, 401);
  const newLogin = await handleAdminRequest(request("/admin", "amir:a-new-secure-password"), envWith(db));
  assert.equal(newLogin.status, 200);
});

test("deletes only records older than 90 days after explicit confirmation", async () => {
  const now = Date.now();
  const db = mockDb([
    { id: 1, session_id: "old-session", visitor_hash: "old", role: "user", content: "Old", status: "accepted", origin: "test", model: "test", created_at: now - 91 * 86_400_000 },
    { id: 2, session_id: "new-session", visitor_hash: "new", role: "user", content: "New", status: "accepted", origin: "test", model: "test", created_at: now - 10 * 86_400_000 },
  ]);
  const response = await handleAdminRequest(request("/admin/delete-old", "amir:strong-password", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://assistant.example" },
    body: new URLSearchParams({ confirm: "yes" }),
  }), envWith(db));
  assert.equal(response.status, 200);
  assert.equal(db.state.rows.length, 1);
  assert.equal(db.state.rows[0].content, "New");
  assert.match(await response.text(), /Deleted 1 message older than 90 days/);
});

test("rejects cross-origin dashboard mutations", async () => {
  const db = mockDb();
  const response = await handleAdminRequest(request("/admin/delete-old", "amir:strong-password", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://attacker.example" },
    body: new URLSearchParams({ confirm: "yes" }),
  }), envWith(db));
  assert.equal(response.status, 403);
});

test("stops brute-force attempts before paying for password verification", async () => {
  const db = mockDb();
  const env = envWith(db);
  const ip = { "CF-Connecting-IP": "198.51.100.7" };

  // Bootstrap the stored credential so later attempts hit the PBKDF2 path.
  assert.equal((await handleAdminRequest(request("/admin", "amir:strong-password", { headers: ip }), env)).status, 200);

  let derivations = 0;
  const realDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
  crypto.subtle.deriveBits = (...args) => { derivations += 1; return realDeriveBits(...args); };

  const statuses = [];
  try {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await handleAdminRequest(request("/admin", `amir:guess-${attempt}`, { headers: ip }), env);
      statuses.push(response.status);
    }
  } finally {
    crypto.subtle.deriveBits = realDeriveBits;
  }

  const throttled = statuses.filter((status) => status === 429);
  assert.ok(throttled.length >= 10, "sustained wrong passwords must be throttled");
  assert.equal(statuses.at(-1), 429);
  // Key derivation stops once the budget is spent: every attempt beyond the
  // one that trips the limit is rejected without any PBKDF2 work.
  const accepted = statuses.length - throttled.length;
  assert.equal(derivations, accepted + 1, "only the limit-tripping attempt derives past the budget");
  assert.ok(derivations < statuses.length / 2, "most attempts must cost no key derivation");
});

test("does not spend login budget on successful sign-ins or credential-less probes", async () => {
  const db = mockDb();
  const env = envWith(db);
  const ip = { "CF-Connecting-IP": "203.0.113.42" };

  assert.equal((await handleAdminRequest(request("/admin", "amir:strong-password", { headers: ip }), env)).status, 200);
  for (let visit = 0; visit < 30; visit += 1) {
    assert.equal((await handleAdminRequest(request("/admin", undefined, { headers: ip }), env)).status, 401);
    assert.equal((await handleAdminRequest(request("/admin", "amir:strong-password", { headers: ip }), env)).status, 200);
  }
  assert.equal([...db.state.counters.keys()].filter((key) => key.startsWith("__admin__")).length, 0);
});

const DAY_MS = 86_400_000;

function auditRow(overrides = {}) {
  return {
    id: 1, session_id: "session-12345678", visitor_hash: "abcdef123456", ip_address: "203.0.113.10",
    country: "CA", region: "British Columbia", city: "Vancouver", latitude: "49.28270", longitude: "-123.12070",
    role: "assistant", content: "Hello", reasoning: "", status: "accepted",
    origin: "https://dabiriaghdam.github.io", model: "openai/gpt-oss-20b", created_at: Date.now(), ...overrides,
  };
}

test("shows how many visitors were turned away in the last day", async () => {
  const today = Math.floor(Date.now() / DAY_MS);
  const db = mockDb([auditRow()], [{ day_window: today, kind: "visitor-minute", count: 4 }]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db))).text();
  assert.match(html, /turned away \(24h\)/);
  assert.match(html, /<strong>4<\/strong>/);
});

test("stays quiet when only a small share of questions is throttled", async () => {
  // 2 rejections against 40 delivered answers is noise, not a broken assistant.
  const today = Math.floor(Date.now() / DAY_MS);
  const delivered = Array.from({ length: 40 }, (_, index) => auditRow({ id: index + 1 }));
  const db = mockDb(delivered, [{ day_window: today, kind: "visitor-minute", count: 2 }]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db))).text();
  assert.match(html, /turned away \(24h\)/);
  assert.doesNotMatch(html, /Assistant is being throttled/);
});

test("warns when the provider's daily budget is exhausted", async () => {
  const today = Math.floor(Date.now() / DAY_MS);
  const db = mockDb([auditRow()], [{ day_window: today, kind: "upstream-exhausted", count: 3 }]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db))).text();
  assert.match(html, /Assistant is being throttled/);
  assert.match(html, /daily budget ran out/);
  assert.match(html, /by the model provider/);
});

test("labels each answer with the provider and model that served it", async () => {
  const db = mockDb([
    auditRow({ id: 1, role: "user", content: "What does Amir research?", model: "groq:openai/gpt-oss-20b" }),
    auditRow({ id: 2, role: "assistant", content: "LLM agents.", model: "openrouter:cohere/north-mini-code:free" }),
  ]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db))).text();
  assert.match(html, /openrouter · cohere\/north-mini-code:free/);
  // The user row's model is only the provider we meant to try first, so showing it
  // there would claim an answer came from somewhere it never went.
  assert.doesNotMatch(html, /groq · openai\/gpt-oss-20b/);
});

test("still labels answers recorded before the fallback chain existed", async () => {
  const db = mockDb([auditRow({ role: "assistant", content: "LLM agents.", model: "openai/gpt-oss-20b" })]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db))).text();
  assert.match(html, /class="model-badge"[^>]*>openai\/gpt-oss-20b</);
});

test("does not credit fallback providers that have no key configured", async () => {
  const today = Math.floor(Date.now() / DAY_MS);
  const db = mockDb([auditRow()], [{ day_window: today, kind: "upstream-exhausted", count: 30 }]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db, { GROQ_API_KEY: "k" }))).text();
  assert.match(html, /Assistant is being throttled/);
  assert.match(html, /No fallback provider is configured/);
  assert.doesNotMatch(html, /already tried/);
});

test("names the fallback providers that are actually configured", async () => {
  const today = Math.floor(Date.now() / DAY_MS);
  const db = mockDb([auditRow()], [{ day_window: today, kind: "upstream-exhausted", count: 30 }]);
  const env = envWith(db, { GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k", GEMINI_API_KEY: "k" });
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), env)).text();
  // One Google key configures three Gemini models, so the notice has to read as a
  // list rather than a chain of "and"s.
  assert.match(html, /openrouter, gemini, gemini-31b and gemini-flash are already tried/);
});

const deletePost = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://assistant.example" },
  body: new URLSearchParams(body),
});

test("deletes one conversation and leaves the others alone", async () => {
  const db = mockDb([
    auditRow({ id: 1, session_id: "keep-me", role: "user", content: "Kept question" }),
    auditRow({ id: 2, session_id: "delete-me", role: "user", content: "Doomed question" }),
    auditRow({ id: 3, session_id: "delete-me", role: "assistant", content: "Doomed answer" }),
    auditRow({ id: 4, session_id: "keep-me", role: "assistant", content: "Kept answer" }),
  ]);
  const response = await handleAdminRequest(
    request("/admin/delete-conversation", "amir:strong-password", deletePost({ session_id: "delete-me" })),
    envWith(db),
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Deleted this conversation and its 2 messages/);
  assert.deepEqual(db.state.rows.map((row) => row.session_id), ["keep-me", "keep-me"]);
});

test("says so rather than claiming success when the conversation is already gone", async () => {
  // Two dashboard tabs, or a double submit: reporting a deletion that deleted nothing
  // would quietly teach the operator to trust a message that is not true.
  const db = mockDb([auditRow({ id: 1, session_id: "keep-me" })]);
  const response = await handleAdminRequest(
    request("/admin/delete-conversation", "amir:strong-password", deletePost({ session_id: "never-existed" })),
    envWith(db),
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /no longer exists/);
  assert.doesNotMatch(html, /Deleted this conversation/);
  assert.equal(db.state.rows.length, 1);
});

test("refuses a conversation delete with no session and deletes nothing", async () => {
  const db = mockDb([auditRow({ id: 1, session_id: "keep-me" }), auditRow({ id: 2, session_id: "also-keep" })]);
  const response = await handleAdminRequest(
    request("/admin/delete-conversation", "amir:strong-password", deletePost({ session_id: "   " })),
    envWith(db),
  );
  assert.match(await response.text(), /No conversation was selected/);
  assert.equal(db.state.rows.length, 2, "a blank session id must never match every row");
});

test("requires authentication to delete a conversation", async () => {
  const db = mockDb([auditRow({ id: 1, session_id: "keep-me" })]);
  const response = await handleAdminRequest(
    request("/admin/delete-conversation", undefined, deletePost({ session_id: "keep-me" })),
    envWith(db),
  );
  assert.equal(response.status, 401);
  assert.equal(db.state.rows.length, 1);
});

test("rejects a cross-origin conversation delete", async () => {
  const db = mockDb([auditRow({ id: 1, session_id: "keep-me" })]);
  const response = await handleAdminRequest(request("/admin/delete-conversation", "amir:strong-password", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://attacker.example" },
    body: new URLSearchParams({ session_id: "keep-me" }),
  }), envWith(db));
  assert.equal(response.status, 403);
  assert.equal(db.state.rows.length, 1);
});

test("renders a confirming delete control on each conversation", async () => {
  const db = mockDb([auditRow({ id: 1, session_id: "session-12345678", role: "user", content: "Hi" })]);
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(db))).text();
  assert.match(html, /action="\/admin\/delete-conversation"/);
  assert.match(html, /name="session_id" value="session-12345678"/);
  assert.match(html, /data-confirm="[^"]*cannot be undone/);
});

const exportedBackup = (messages) => JSON.stringify({ exportedAt: "2026-08-20T10:00:00.000Z", messages });

test("restores an exported backup without touching what is already stored", async () => {
  const db = mockDb([auditRow({ id: 1, session_id: "already-here", role: "user", content: "Existing question" })]);
  const response = await handleAdminRequest(
    request("/admin/import", "amir:strong-password", deletePost({
      backup: exportedBackup([
        { id: 70, session_id: "restored", role: "user", content: "Restored question", status: "ok", created_at: Date.now() },
        { id: 71, session_id: "restored", role: "assistant", content: "Restored answer", status: "accepted", created_at: Date.now() },
      ]),
    })),
    envWith(db),
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Restored 2 messages/);
  assert.equal(db.state.rows.length, 3, "the restore must merge, never replace");
  assert.ok(db.state.rows.some((row) => row.session_id === "already-here"));
});

test("reports duplicates instead of doubling the log on a repeated restore", async () => {
  const db = mockDb([]);
  const backup = exportedBackup([
    { id: 70, session_id: "restored", role: "user", content: "Restored question", status: "ok", created_at: Date.now() },
  ]);
  const post = () => handleAdminRequest(request("/admin/import", "amir:strong-password", deletePost({ backup })), envWith(db));
  await post();
  const html = await (await post()).text();
  assert.match(html, /Restored 0 messages/);
  assert.match(html, /1 already present/);
  assert.equal(db.state.rows.length, 1);
});

test("rejects an upload that is not valid JSON rather than importing part of it", async () => {
  const db = mockDb([]);
  const response = await handleAdminRequest(
    request("/admin/import", "amir:strong-password", deletePost({ backup: '{"messages": [{"id": 1,' })),
    envWith(db),
  );
  const html = await response.text();
  assert.match(html, /not valid JSON/);
  assert.equal(db.state.rows.length, 0);
});

test("rejects JSON that parses but is not a chat export", async () => {
  const db = mockDb([]);
  const response = await handleAdminRequest(
    request("/admin/import", "amir:strong-password", deletePost({ backup: '{"settings": {"theme": "dark"}}' })),
    envWith(db),
  );
  assert.match(await response.text(), /not a chat export/);
  assert.equal(db.state.rows.length, 0);
});

test("asks for a file instead of reporting a successful empty restore", async () => {
  const response = await handleAdminRequest(
    request("/admin/import", "amir:strong-password", deletePost({ backup: "" })),
    envWith(mockDb([])),
  );
  assert.match(await response.text(), /Choose an exported JSON file/);
});

test("refuses an oversized upload instead of parsing it into memory", async () => {
  const db = mockDb([]);
  // Valid JSON, just far too big to be an export from this site. The guard has to fire
  // before JSON.parse, so this must be rejected on size rather than on shape.
  const huge = `{"messages":[{"id":1,"content":"${"x".repeat(24_000_001)}"}]}`;
  const response = await handleAdminRequest(
    request("/admin/import", "amir:strong-password", deletePost({ backup: huge })),
    envWith(db),
  );
  assert.match(await response.text(), /too large to be a chat export/);
  assert.equal(db.state.rows.length, 0);
});

test("requires authentication to restore a backup", async () => {
  const response = await handleAdminRequest(
    request("/admin/import", undefined, deletePost({ backup: exportedBackup([]) })),
    envWith(mockDb([])),
  );
  assert.equal(response.status, 401);
});

test("rejects a cross-origin restore", async () => {
  const response = await handleAdminRequest(
    request("/admin/import", "amir:strong-password", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": "https://evil.example" },
      body: new URLSearchParams({ backup: exportedBackup([]) }),
    }),
    envWith(mockDb([])),
  );
  assert.notEqual(response.status, 200);
});

test("shows the digest as off until it is configured, and offers no dead button", async () => {
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), envWith(mockDb([auditRow()])))).text();
  assert.match(html, /DIGEST_WEBHOOK_URL, DIGEST_WEBHOOK_SECRET, and DIGEST_TO_EMAIL/);
  assert.match(html, /<button type="submit" disabled>Send one now<\/button>/);
});

test("reports the schedule and recipient once the digest is configured", async () => {
  const env = envWith(mockDb([auditRow()]), { DIGEST_WEBHOOK_URL: "https://script.google.com/example", DIGEST_WEBHOOK_SECRET: "secret", DIGEST_TO_EMAIL: "owner@example.com", DIGEST_INTERVAL_DAYS: "14" });
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), env)).text();
  assert.match(html, /Emailing owner@example\.com every 14 days/);
});

test("refuses a manual digest send when the feature is off, rather than failing silently", async () => {
  const response = await handleAdminRequest(
    request("/admin/send-digest", "amir:strong-password", deletePost({})),
    envWith(mockDb([])),
  );
  assert.match(await response.text(), /Email digests are off/);
});

test("requires authentication to trigger a digest send", async () => {
  const response = await handleAdminRequest(
    request("/admin/send-digest", undefined, deletePost({})),
    envWith(mockDb([]), { DIGEST_WEBHOOK_URL: "https://script.google.com/example", DIGEST_WEBHOOK_SECRET: "secret", DIGEST_TO_EMAIL: "owner@example.com" }),
  );
  assert.equal(response.status, 401);
});

test("reports when the digest last went out and when the next one is due", async () => {
  const db = mockDb([auditRow()]);
  // Sent two days ago on a 14-day schedule, so neither the "never sent" nor the
  // "due now" wording applies and both timestamps have to render.
  db.state.digest = { last_sent_at: Date.now() - 2 * DAY_MS, last_status: "sent" };
  const env = envWith(db, { DIGEST_WEBHOOK_URL: "https://script.google.com/example", DIGEST_WEBHOOK_SECRET: "secret", DIGEST_TO_EMAIL: "owner@example.com", DIGEST_INTERVAL_DAYS: "14" });
  const html = await (await handleAdminRequest(request("/admin", "amir:strong-password"), env)).text();
  assert.match(html, /Last sent /);
  assert.match(html, /Next due /);
  assert.doesNotMatch(html, /Invalid Date/, "a stored timestamp must render as a date");
});
