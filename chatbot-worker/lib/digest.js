// Periodic activity digest, emailed to the site owner.
//
// The dashboard answers "what happened?" only when someone opens it, which means a
// quiet failure — the chain exhausted, every visitor turned away — stays invisible for
// as long as nobody looks. The digest inverts that: it arrives whether or not you were
// wondering, and its job is as much to say "nothing is broken" as to report traffic.
//
// Entirely optional. Delivery goes through a tiny Google Apps Script owned by Amir,
// rather than a third-party transactional-email account. Without the relay URL,
// shared secret, and recipient the feature is off.
import { getPeriodStats } from "./audit.js";
import { getThrottleStats } from "./throttle.js";

const DAY_MS = 86_400_000;

export const digestConfig = {
  defaultIntervalDays: 7,
  minIntervalDays: 1,
  maxIntervalDays: 90,
  sendTimeoutMs: 10_000,
};

export function digestIntervalDays(env) {
  const raw = Number(env?.DIGEST_INTERVAL_DAYS);
  if (!Number.isFinite(raw)) return digestConfig.defaultIntervalDays;
  // Clamped rather than rejected: a typo in a secret should not silently disable the
  // digest, and neither should it mail every few minutes.
  return Math.min(digestConfig.maxIntervalDays, Math.max(digestConfig.minIntervalDays, Math.floor(raw)));
}

export function digestEnabled(env) {
  if (!env?.DIGEST_WEBHOOK_URL || !env?.DIGEST_WEBHOOK_SECRET || !env?.DIGEST_TO_EMAIL) return false;
  try {
    return new URL(env.DIGEST_WEBHOOK_URL).protocol === "https:";
  } catch {
    return false;
  }
}

// Same self-heal rationale as the throttle counter: this table arrives in a migration
// later than the rest of the schema, and a deploy that ships the code without running
// it would otherwise mail the digest on every single trigger, forever, because the
// "when did I last send" read keeps failing.
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS chat_digest_state (
    id integer PRIMARY KEY NOT NULL,
    last_sent_at integer NOT NULL,
    last_status text
  )
`;

let fallbackState = null;

async function withRepair(db, run) {
  try {
    return await run();
  } catch {
    try {
      await db.prepare(CREATE_TABLE_SQL).run();
      return await run();
    } catch (error) {
      console.error("Digest state unavailable", error);
      return null;
    }
  }
}

export async function readDigestState(db) {
  if (!db) return fallbackState;
  const row = await withRepair(db, () => db.prepare("SELECT last_sent_at, last_status FROM chat_digest_state WHERE id = 1").first());
  return row ? { lastSentAt: Number(row.last_sent_at), lastStatus: row.last_status } : null;
}

async function writeDigestState(db, now, status) {
  if (!db) {
    fallbackState = { lastSentAt: now, lastStatus: status };
    return;
  }
  await withRepair(db, () => db.prepare(`
    INSERT INTO chat_digest_state (id, last_sent_at, last_status) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_sent_at = excluded.last_sent_at, last_status = excluded.last_status
  `).bind(now, status).run());
}

// Claiming the slot *before* the mail goes out, rather than recording it afterwards, is
// what stops two triggers from both mailing. The chat path calls maybeSendDigest on
// every request, so "read the clock, send, write the clock" leaves the entire relay
// round-trip as a window in which a second request still sees the old timestamp and
// mails a duplicate report. The claim is a compare-and-swap against the timestamp we
// read: exactly one caller changes a row, and only that caller sends.
async function claimDigestSlot(db, previous, now) {
  if (!db) {
    if (fallbackState?.lastSentAt !== previous?.lastSentAt) return false;
    fallbackState = { lastSentAt: now, lastStatus: "sending" };
    return true;
  }
  const result = await withRepair(db, () => (previous
    ? db.prepare("UPDATE chat_digest_state SET last_sent_at = ?, last_status = 'sending' WHERE id = 1 AND last_sent_at = ?").bind(now, previous.lastSentAt).run()
    : db.prepare("INSERT OR IGNORE INTO chat_digest_state (id, last_sent_at, last_status) VALUES (1, ?, 'sending')").bind(now).run()));
  return Number(result?.meta?.changes ?? 0) === 1;
}

// Undo the claim when the send fails, so the clock still only advances on success and
// the next trigger retries this period instead of skipping it. The failure is recorded
// in the status, which the dashboard shows; only the timestamp is rolled back.
async function releaseDigestSlot(db, previous, status) {
  if (!db) {
    fallbackState = previous ? { lastSentAt: previous.lastSentAt, lastStatus: status } : null;
    return;
  }
  await withRepair(db, () => (previous
    ? db.prepare("UPDATE chat_digest_state SET last_sent_at = ?, last_status = ? WHERE id = 1").bind(previous.lastSentAt, status).run()
    : db.prepare("DELETE FROM chat_digest_state WHERE id = 1").run()));
}

export function nextDigestDue(state, intervalDays, now) {
  // No record means the digest has never run. Rather than mailing a report covering
  // whatever happens to be in the database, the first trigger sets the clock and the
  // first real digest arrives one full interval later, covering a complete period.
  if (!state?.lastSentAt) return { due: true, first: true, at: now };
  return { due: now - state.lastSentAt >= intervalDays * DAY_MS, first: false, at: state.lastSentAt + intervalDays * DAY_MS };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

const number = (value) => Number(value || 0).toLocaleString("en-US");

export function renderDigest({ periodDays, since, until, stats, throttle, providers = [] }) {
  const answered = stats.delivered;
  const turnedAway = throttle?.week || 0;
  const exhausted = Number(throttle?.byKind?.["upstream-exhausted"] || 0);
  const quiet = stats.messages === 0;

  // The headline is a verdict, not a number. A digest that leads with "0 messages"
  // reads identically whether the site was quiet or the worker was down, and the
  // difference between those is the entire reason to send it.
  const headline = quiet
    ? "No questions this period."
    : exhausted > 0
      ? `${number(answered)} answered, but the provider chain ran out of budget.`
      : turnedAway > 0
        ? `${number(answered)} answered, ${number(turnedAway)} turned away.`
        : `${number(answered)} answered, nothing turned away.`;

  const lines = [
    `${number(stats.questions)} questions from ${number(stats.visitors)} visitors across ${number(stats.conversations)} conversations`,
    `${number(answered)} answers delivered`,
  ];
  if (stats.blocked > 0) lines.push(`${number(stats.blocked)} messages blocked before reaching a provider`);
  if (turnedAway > 0) lines.push(`${number(turnedAway)} requests turned away by a rate limit`);
  if (exhausted > 0) lines.push(`${number(exhausted)} of those because a provider's daily budget was gone — worth checking the caps`);

  const modelLines = stats.models.map(([model, count]) => `${model} — ${number(count)}`);
  const countryLines = stats.countries.map(([country, count]) => `${country} — ${number(count)} visitor${count === 1 ? "" : "s"}`);

  const period = `${new Date(since).toISOString().slice(0, 10)} to ${new Date(until).toISOString().slice(0, 10)}`;
  const subject = `Chat digest — ${headline}`;

  const text = [
    headline,
    `${periodDays} day${periodDays === 1 ? "" : "s"}: ${period}`,
    "",
    ...lines.map((line) => `• ${line}`),
    modelLines.length ? ["", "Answered by:", ...modelLines.map((line) => `• ${line}`)].join("\n") : "",
    countryLines.length ? ["", "Where from:", ...countryLines.map((line) => `• ${line}`)].join("\n") : "",
    providers.length ? `\nProviders configured: ${providers.join(", ")}` : "\nNo providers are configured — the assistant cannot answer at all.",
  ].filter(Boolean).join("\n");

  const list = (items) => `<ul style="margin:0;padding-left:18px">${items.map((item) => `<li style="margin:3px 0">${escapeHtml(item)}</li>`).join("")}</ul>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.55;color:#111;max-width:560px">
<h2 style="font-size:17px;margin:0 0 3px">${escapeHtml(headline)}</h2>
<p style="color:#666;font-size:12px;margin:0 0 16px">${escapeHtml(`${periodDays} day${periodDays === 1 ? "" : "s"}: ${period}`)}</p>
${list(lines)}
${modelLines.length ? `<h3 style="font-size:13px;margin:16px 0 5px">Answered by</h3>${list(modelLines)}` : ""}
${countryLines.length ? `<h3 style="font-size:13px;margin:16px 0 5px">Where from</h3>${list(countryLines)}` : ""}
<p style="color:#666;font-size:12px;margin:18px 0 0">${escapeHtml(providers.length ? `Providers configured: ${providers.join(", ")}` : "No providers are configured — the assistant cannot answer at all.")}</p>
</div>`;

  return { subject, text, html };
}

async function sendEmail(env, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("digest send timed out")), digestConfig.sendTimeoutMs);
  try {
    const response = await fetch(env.DIGEST_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: env.DIGEST_WEBHOOK_SECRET,
        to: env.DIGEST_TO_EMAIL,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: controller.signal,
    });
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    if (!response.ok) {
      return { ok: false, status: response.status, detail };
    }
    // Apps Script normally returns 200 even for an application-level refusal. Honour
    // an explicit {ok:false} so a bad shared secret never advances the digest clock.
    try {
      const result = JSON.parse(detail || "{}");
      if (result?.ok === false) return { ok: false, status: response.status, detail: String(result.error || "Email relay rejected the request").slice(0, 300) };
    } catch {
      // A successful non-JSON response is still a successful webhook delivery.
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, detail: String(error?.message || error).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// force: skip the interval check, for the dashboard's "Send now" button. The clock is
// still reset on success, so a manual send also postpones the next scheduled one
// rather than producing two reports covering overlapping periods.
export async function maybeSendDigest(env, db, now = Date.now(), { force = false, providers = [] } = {}) {
  if (!digestEnabled(env)) return { sent: false, reason: "disabled" };

  const intervalDays = digestIntervalDays(env);
  const state = await readDigestState(db);
  const due = nextDigestDue(state, intervalDays, now);

  if (!force && !due.due) return { sent: false, reason: "not-due", nextAt: due.at };
  if (!force && due.first) {
    // Start the clock without mailing: see nextDigestDue.
    await writeDigestState(db, now, "initialised");
    return { sent: false, reason: "initialised", nextAt: now + intervalDays * DAY_MS };
  }

  if (!(await claimDigestSlot(db, state, now))) return { sent: false, reason: "in-progress" };

  const since = Math.max(state?.lastSentAt ?? now - intervalDays * DAY_MS, now - digestConfig.maxIntervalDays * DAY_MS);
  let message;
  let result;
  try {
    const [stats, throttle] = await Promise.all([
      getPeriodStats(db, since, now),
      getThrottleStats(db, now),
    ]);
    const periodDays = Math.max(1, Math.round((now - since) / DAY_MS));
    message = renderDigest({ periodDays, since, until: now, stats, throttle, providers });
    result = await sendEmail(env, message);
  } catch (error) {
    // The claim already moved the clock; give the period back before rethrowing, or a
    // failure to read the stats would silently cost a whole digest.
    await releaseDigestSlot(db, state, "error");
    throw error;
  }

  // The clock only moves on success, so a relay outage means the next trigger retries
  // rather than skipping a period silently.
  if (result.ok) await writeDigestState(db, now, "sent");
  else {
    await releaseDigestSlot(db, state, `failed:${result.status ?? "error"}`);
    console.error("Digest send failed", result.status, result.detail);
  }
  return { sent: result.ok, reason: result.ok ? "sent" : "send-failed", status: result.status, detail: result.detail, subject: message.subject };
}

export function resetDigestForTests() {
  fallbackState = null;
}
