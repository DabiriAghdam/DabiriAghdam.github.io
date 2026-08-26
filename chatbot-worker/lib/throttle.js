const DAY_MS = 86_400_000;

// Every way a visitor can be turned away with a 429, split by cause so the admin
// page can tell "my own caps are too tight" apart from "Groq has no budget left".
export const THROTTLE_KINDS = ["visitor-minute", "visitor-day", "site-capacity", "upstream-busy", "upstream-exhausted"];

const OWN_LIMIT_KINDS = new Set(["visitor-minute", "visitor-day", "site-capacity"]);

const fallbackEvents = new Map();

const UPSERT_SQL = `
  INSERT INTO chat_throttle_events (day_window, kind, count, updated_at)
  VALUES (?, ?, 1, ?)
  ON CONFLICT(day_window, kind) DO UPDATE SET
    count = chat_throttle_events.count + 1,
    updated_at = excluded.updated_at
`;

const SELECT_SQL = `
  SELECT day_window, kind, count
  FROM chat_throttle_events
  WHERE day_window >= ?
`;

// Counting rather than logging one row per rejection: a client that keeps hammering
// after a 429 would otherwise write unbounded audit rows, turning a cheap rejection
// into an expensive one. Failures here are swallowed — losing a statistic must never
// turn into a failed response for the visitor.
// Mirrors drizzle/0005_add_throttle_events.sql exactly. Kept here as a self-heal for
// one specific failure: this table arrived in a later migration than the rest of the
// schema, so a deploy that ships the code without running 0005 leaves every throttle
// write failing silently and the dashboard permanently reading zero. That is invisible
// precisely when it matters — you go looking at the counter *because* visitors are
// being turned away, and it says nothing is wrong.
//
// This is a safety net, not a substitute for the migration: it runs only after a write
// has already failed, it is idempotent, and if 0005 has been applied it never runs at
// all. Deliberately not attempted for the audit tables, which carry real data and a
// history of column changes — guessing at their shape from application code is how you
// end up with two divergent schemas.
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS chat_throttle_events (
    day_window integer NOT NULL,
    kind text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    updated_at integer NOT NULL,
    PRIMARY KEY(day_window, kind)
  )
`;

// One attempt per isolate. A table that cannot be created is a permissions or binding
// problem, and retrying it on every rejected request would turn a lost statistic into
// a second failing write on the path that is already under load.
let repairAttempted = false;

export async function recordThrottle(db, kind, now = Date.now()) {
  const dayWindow = Math.floor(now / DAY_MS);
  if (!db) {
    const key = `${dayWindow}:${kind}`;
    fallbackEvents.set(key, (fallbackEvents.get(key) || 0) + 1);
    return;
  }
  try {
    await db.prepare(UPSERT_SQL).bind(dayWindow, kind, now).run();
  } catch (error) {
    if (repairAttempted) {
      console.error("Throttle counter unavailable", error);
      return;
    }
    repairAttempted = true;
    try {
      await db.prepare(CREATE_TABLE_SQL).run();
      await db.prepare(UPSERT_SQL).bind(dayWindow, kind, now).run();
      console.warn("Created chat_throttle_events; migration 0005 has not been applied to this database.");
    } catch (repairError) {
      console.error("Throttle counter unavailable", repairError);
    }
  }
}

export async function getThrottleStats(db, now = Date.now()) {
  const today = Math.floor(now / DAY_MS);
  const weekStart = today - 6;
  const rows = [];
  if (!db) {
    for (const [key, count] of fallbackEvents) {
      const [dayWindow, kind] = key.split(":");
      rows.push({ day_window: Number(dayWindow), kind, count });
    }
  } else {
    try {
      const result = await db.prepare(SELECT_SQL).bind(weekStart).all();
      rows.push(...(result?.results || []));
    } catch (error) {
      console.error("Throttle stats unavailable", error);
    }
  }

  const byKind = Object.fromEntries(THROTTLE_KINDS.map((kind) => [kind, 0]));
  let todayTotal = 0;
  let weekTotal = 0;
  let todayOwnLimits = 0;
  let todayUpstream = 0;
  for (const row of rows) {
    const dayWindow = Number(row.day_window);
    const count = Number(row.count) || 0;
    if (dayWindow < weekStart) continue;
    weekTotal += count;
    if (dayWindow !== today) continue;
    todayTotal += count;
    if (row.kind in byKind) byKind[row.kind] += count;
    if (OWN_LIMIT_KINDS.has(row.kind)) todayOwnLimits += count;
    else todayUpstream += count;
  }
  return { today: todayTotal, week: weekTotal, byKind, todayOwnLimits, todayUpstream };
}

export function resetThrottleForTests() {
  fallbackEvents.clear();
  repairAttempted = false;
}
