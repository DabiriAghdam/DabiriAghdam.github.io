import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAdminRequest } from "../lib/admin.js";

function mockDb(rows = [], throttle = []) {
  const state = { credential: null, rows: [...rows], counters: new Map(), counterReads: 0, throttle: [...throttle] };

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
        if (/DELETE FROM chat_messages/i.test(sql)) {
          const before = state.rows.length;
          state.rows = state.rows.filter((row) => row.created_at >= args[0]);
          return { meta: { changes: before - state.rows.length } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
  }

  return { state, prepare(sql) { return operation(sql); } };
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
  assert.match(html, /openrouter and gemini are already tried/);
});
