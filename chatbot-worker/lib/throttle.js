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
    console.error("Throttle counter unavailable", error);
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
}
