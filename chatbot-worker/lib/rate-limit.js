const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const VISITOR_MINUTE_LIMIT = 5;
const VISITOR_DAY_LIMIT = 50;
const GLOBAL_DAY_LIMIT = 1000;
const ADMIN_MINUTE_LIMIT = 10;
const ADMIN_DAY_LIMIT = 50;
const fallbackCounters = new Map();

const UPSERT_COUNTER_SQL = `
  INSERT INTO chat_rate_limits (
    visitor_hash, minute_window, minute_count, day_window, day_count, updated_at
  ) VALUES (?, ?, 1, ?, 1, ?)
  ON CONFLICT(visitor_hash) DO UPDATE SET
    minute_window = excluded.minute_window,
    minute_count = CASE
      WHEN chat_rate_limits.minute_window = excluded.minute_window
      THEN chat_rate_limits.minute_count + 1 ELSE 1 END,
    day_window = excluded.day_window,
    day_count = CASE
      WHEN chat_rate_limits.day_window = excluded.day_window
      THEN chat_rate_limits.day_count + 1 ELSE 1 END,
    updated_at = excluded.updated_at
  RETURNING minute_count, day_count
`;

const SELECT_COUNTER_SQL = `
  SELECT minute_window, minute_count, day_window, day_count
  FROM chat_rate_limits
  WHERE visitor_hash = ?
`;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function visitorHash(ip, dayWindow, scope = "chat") {
  const encoded = new TextEncoder().encode(`amir-${scope}:${dayWindow}:${ip}`);
  return toHex(await crypto.subtle.digest("SHA-256", encoded));
}

function fallbackUpdate(key, minuteWindow, dayWindow, now) {
  const current = fallbackCounters.get(key);
  const next = {
    minuteWindow,
    minuteCount: current?.minuteWindow === minuteWindow ? current.minuteCount + 1 : 1,
    dayWindow,
    dayCount: current?.dayWindow === dayWindow ? current.dayCount + 1 : 1,
    updatedAt: now,
  };
  fallbackCounters.set(key, next);
  return next;
}

async function updateCounter(db, key, minuteWindow, dayWindow, now) {
  if (!db) return fallbackUpdate(key, minuteWindow, dayWindow, now);

  const row = await db
    .prepare(UPSERT_COUNTER_SQL)
    .bind(key, minuteWindow, dayWindow, now)
    .first();

  return {
    minuteCount: Number(row?.minute_count || 0),
    dayCount: Number(row?.day_count || 0),
  };
}

// Read-only counterpart to updateCounter. Lets a caller reject a flooding client
// before paying for expensive work, without spending quota on the peek itself.
async function readCounter(db, key, minuteWindow, dayWindow) {
  if (!db) {
    const current = fallbackCounters.get(key);
    return {
      minuteCount: current?.minuteWindow === minuteWindow ? current.minuteCount : 0,
      dayCount: current?.dayWindow === dayWindow ? current.dayCount : 0,
    };
  }

  const row = await db.prepare(SELECT_COUNTER_SQL).bind(key).first();
  if (!row) return { minuteCount: 0, dayCount: 0 };
  return {
    minuteCount: Number(row.minute_window) === minuteWindow ? Number(row.minute_count || 0) : 0,
    dayCount: Number(row.day_window) === dayWindow ? Number(row.day_count || 0) : 0,
  };
}

function limited(counter, minuteLimit, dayLimit, now) {
  if (counter.minuteCount > minuteLimit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((MINUTE_MS - (now % MINUTE_MS)) / 1000)),
      reason: "minute",
    };
  }
  if (counter.dayCount > dayLimit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000)),
      reason: "day",
    };
  }
  return {
    allowed: true,
    remainingMinute: Math.max(0, minuteLimit - counter.minuteCount),
    remainingDay: Math.max(0, dayLimit - counter.dayCount),
  };
}

export async function enforceRateLimit(db, ip, now = Date.now()) {
  const minuteWindow = Math.floor(now / MINUTE_MS);
  const dayWindow = Math.floor(now / DAY_MS);
  const key = await visitorHash(ip, dayWindow);

  const visitorCounter = await updateCounter(db, key, minuteWindow, dayWindow, now);
  const visitorResult = limited(visitorCounter, VISITOR_MINUTE_LIMIT, VISITOR_DAY_LIMIT, now);
  if (!visitorResult.allowed) return { ...visitorResult, visitorHash: key };

  const globalCounter = await updateCounter(db, "__site_total__", minuteWindow, dayWindow, now);
  if (globalCounter.dayCount > GLOBAL_DAY_LIMIT) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000)),
      reason: "capacity",
      visitorHash: key,
    };
  }

  return { ...visitorResult, visitorHash: key };
}

// Checks the admin login budget without consuming it, so the caller can bail out
// before running PBKDF2. Successful sign-ins therefore never spend login quota.
export async function checkAdminLoginRateLimit(db, ip, now = Date.now()) {
  const minuteWindow = Math.floor(now / MINUTE_MS);
  const dayWindow = Math.floor(now / DAY_MS);
  const key = await visitorHash(ip, dayWindow, "admin");
  const counter = await readCounter(db, `__admin__:${key}`, minuteWindow, dayWindow);
  return limited(counter, ADMIN_MINUTE_LIMIT, ADMIN_DAY_LIMIT, now);
}

export async function enforceAdminLoginRateLimit(db, ip, now = Date.now()) {
  const minuteWindow = Math.floor(now / MINUTE_MS);
  const dayWindow = Math.floor(now / DAY_MS);
  const key = await visitorHash(ip, dayWindow, "admin");
  const counter = await updateCounter(db, `__admin__:${key}`, minuteWindow, dayWindow, now);
  return limited(counter, ADMIN_MINUTE_LIMIT, ADMIN_DAY_LIMIT, now);
}

export function resetRateLimitsForTests() {
  fallbackCounters.clear();
}

export const limitsForTests = {
  minute: VISITOR_MINUTE_LIMIT,
  day: VISITOR_DAY_LIMIT,
  globalDay: GLOBAL_DAY_LIMIT,
  adminMinute: ADMIN_MINUTE_LIMIT,
  adminDay: ADMIN_DAY_LIMIT,
};
