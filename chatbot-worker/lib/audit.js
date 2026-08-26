const NINETY_DAYS_MS = 90 * 86_400_000;
const fallbackMessages = [];
let fallbackId = 0;

export async function writeAuditMessage(db, entry) {
  if (!db) {
    const row = { id: ++fallbackId, ...entry };
    fallbackMessages.push(row);
    return row.id;
  }

  const row = await db.prepare(`
    INSERT INTO chat_messages (
      session_id, visitor_hash, role, content, status, origin, model, reasoning,
      ip_address, country, region, city, latitude, longitude, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(
    entry.sessionId,
    entry.visitorHash,
    entry.role,
    entry.content,
    entry.status,
    entry.origin,
    entry.model || null,
    entry.reasoning || null,
    entry.ipAddress || null,
    entry.country || null,
    entry.region || null,
    entry.city || null,
    entry.latitude || null,
    entry.longitude || null,
    entry.createdAt,
  ).first();

  if (!row?.id) throw new Error("Audit insert did not return an id.");
  return Number(row.id);
}

export async function updateAuditStatus(db, id, status) {
  if (!db) {
    const row = fallbackMessages.find((item) => item.id === id);
    if (row) row.status = status;
    return;
  }
  await db.prepare("UPDATE chat_messages SET status = ? WHERE id = ?").bind(status, id).run();
}

function normalizedFilters(filters = {}) {
  const roles = new Set(["user", "assistant"]);
  const statuses = new Set(["accepted", "pending", "blocked-local", "blocked-guard", "blocked-provider", "guard-error", "model-error", "empty-response", "truncated"]);
  return {
    limit: Math.max(1, Math.min(5000, Number(filters.limit) || 500)),
    q: String(filters.q || "").trim().slice(0, 100),
    role: roles.has(filters.role) ? filters.role : "",
    status: statuses.has(filters.status) ? filters.status : "",
  };
}

function filterQuery(filters = {}) {
  const safe = normalizedFilters(filters);
  const clauses = [];
  const bindings = [];
  if (safe.q) {
    clauses.push("(content LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\')");
    const escaped = safe.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    bindings.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (safe.role) {
    clauses.push("role = ?");
    bindings.push(safe.role);
  }
  if (safe.status) {
    clauses.push("status = ?");
    bindings.push(safe.status);
  }
  return { safe, clauses, bindings, where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "" };
}

function fallbackFilteredMessages(safe) {
  const query = safe.q.toLowerCase();
  return fallbackMessages
    .filter((row) => !safe.role || row.role === safe.role)
    .filter((row) => !safe.status || row.status === safe.status)
    .filter((row) => !query || String(row.content).toLowerCase().includes(query) || String(row.sessionId).toLowerCase().includes(query));
}

export async function listAuditMessages(db, filters = {}) {
  if (typeof filters === "number") filters = { limit: filters };
  const { safe, where, bindings } = filterQuery(filters);
  if (!db) {
    return fallbackFilteredMessages(safe)
      .slice(-safe.limit)
      .reverse();
  }

  const result = await db.prepare(`
    SELECT id, session_id, visitor_hash, role, content, status, origin, model, reasoning,
      ip_address, country, region, city, latitude, longitude, created_at
    FROM chat_messages
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(...bindings, safe.limit).all();
  return result.results || [];
}

export async function countAuditMessages(db, filters = {}) {
  const { safe, where, bindings } = filterQuery(filters);
  if (!db) return fallbackFilteredMessages(safe).length;
  const row = await db.prepare(`
    SELECT COUNT(*) AS total_messages
    FROM chat_messages
    ${where}
  `).bind(...bindings).first();
  return Number(row?.total_messages || 0);
}

export async function listAuditConversationPage(db, filters = {}, page = 1, pageSize = 10) {
  const { safe, where, bindings } = filterQuery(filters);
  const size = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const requestedPage = Math.max(1, Number.parseInt(page, 10) || 1);

  if (!db) {
    const matching = fallbackFilteredMessages(safe);
    const sessions = new Map();
    matching.forEach((row) => {
      const sessionId = row.sessionId || row.session_id || "unknown";
      const latest = Number(row.createdAt ?? row.created_at) || 0;
      sessions.set(sessionId, Math.max(sessions.get(sessionId) || 0, latest));
    });
    const orderedSessions = [...sessions.entries()].sort((left, right) => right[1] - left[1]);
    const totalConversations = orderedSessions.length;
    const totalPages = Math.max(1, Math.ceil(totalConversations / size));
    const actualPage = Math.min(requestedPage, totalPages);
    const pageSessionIds = new Set(orderedSessions.slice((actualPage - 1) * size, actualPage * size).map(([sessionId]) => sessionId));
    return {
      messages: matching.filter((row) => pageSessionIds.has(row.sessionId || row.session_id || "unknown")),
      totalConversations,
      totalPages,
      page: actualPage,
    };
  }

  const countRow = await db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS total_conversations
    FROM chat_messages
    ${where}
  `).bind(...bindings).first();
  const totalConversations = Number(countRow?.total_conversations || 0);
  const totalPages = Math.max(1, Math.ceil(totalConversations / size));
  const actualPage = Math.min(requestedPage, totalPages);
  const sessionPage = await db.prepare(`
    SELECT session_id, MAX(created_at) AS latest
    FROM chat_messages
    ${where}
    GROUP BY session_id
    ORDER BY latest DESC, session_id DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings, size, (actualPage - 1) * size).all();
  const sessionIds = (sessionPage.results || []).map((row) => row.session_id).filter(Boolean);
  if (!sessionIds.length) return { messages: [], totalConversations, totalPages, page: actualPage };

  const placeholders = sessionIds.map(() => "?").join(", ");
  const messageWhere = where ? `${where} AND session_id IN (${placeholders})` : `WHERE session_id IN (${placeholders})`;
  const messages = await db.prepare(`
    SELECT id, session_id, visitor_hash, role, content, status, origin, model, reasoning,
      ip_address, country, region, city, latitude, longitude, created_at
    FROM chat_messages
    ${messageWhere}
    ORDER BY created_at DESC, id DESC
  `).bind(...bindings, ...sessionIds).all();
  return { messages: messages.results || [], totalConversations, totalPages, page: actualPage };
}

// Stats for one window rather than for all time. The dashboard's headline numbers are
// cumulative, which is the wrong shape for a digest: "3,411 messages ever" says nothing
// about the week being reported on.
export async function getPeriodStats(db, since, now = Date.now()) {
  if (!db) {
    const rows = fallbackMessages.filter((row) => {
      const at = row.createdAt ?? row.created_at;
      return at >= since && at <= now;
    });
    const models = rows.map((row) => row.model).filter(Boolean);
    return {
      messages: rows.length,
      questions: rows.filter((row) => row.role === "user").length,
      conversations: new Set(rows.map((row) => row.sessionId ?? row.session_id)).size,
      visitors: new Set(rows.map((row) => row.ipAddress ?? row.ip_address).filter(Boolean)).size,
      blocked: rows.filter((row) => String(row.status).startsWith("blocked-")).length,
      delivered: rows.filter((row) => row.role === "assistant" && (row.status === "accepted" || row.status === "truncated")).length,
      models: countBy(models),
      countries: countBy(rows.map((row) => row.country).filter(Boolean)),
    };
  }
  const [totals, models, countries] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) AS messages,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS questions,
        COUNT(DISTINCT session_id) AS conversations,
        COUNT(DISTINCT NULLIF(ip_address, '')) AS visitors,
        SUM(CASE WHEN status LIKE 'blocked-%' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN role = 'assistant' AND status IN ('accepted','truncated') THEN 1 ELSE 0 END) AS delivered
      FROM chat_messages WHERE created_at >= ? AND created_at <= ?
    `).bind(since, now).first(),
    db.prepare(`
      SELECT model, COUNT(*) AS count FROM chat_messages
      WHERE created_at >= ? AND created_at <= ? AND role = 'assistant' AND model IS NOT NULL AND model != ''
      GROUP BY model ORDER BY count DESC LIMIT 10
    `).bind(since, now).all(),
    db.prepare(`
      SELECT COALESCE(NULLIF(country, ''), 'Unknown') AS country, COUNT(DISTINCT NULLIF(ip_address, '')) AS count
      FROM chat_messages WHERE created_at >= ? AND created_at <= ?
      GROUP BY country ORDER BY count DESC LIMIT 5
    `).bind(since, now).all(),
  ]);
  return {
    messages: Number(totals?.messages || 0),
    questions: Number(totals?.questions || 0),
    conversations: Number(totals?.conversations || 0),
    visitors: Number(totals?.visitors || 0),
    blocked: Number(totals?.blocked || 0),
    delivered: Number(totals?.delivered || 0),
    models: (models?.results || []).map((row) => [row.model, Number(row.count)]),
    countries: (countries?.results || []).map((row) => [row.country, Number(row.count)]),
  };
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10);
}

export async function getAuditStats(db, now = Date.now()) {
  const dayCutoff = now - 86_400_000;
  const oldCutoff = now - NINETY_DAYS_MS;
  if (!db) {
    return {
      total_messages: fallbackMessages.length,
      total_sessions: new Set(fallbackMessages.map((row) => row.sessionId)).size,
      unique_visitors: new Set(fallbackMessages.map((row) => row.ipAddress || row.visitorHash)).size,
      blocked_messages: fallbackMessages.filter((row) => String(row.status).startsWith("blocked-")).length,
      last_24h: fallbackMessages.filter((row) => row.createdAt >= dayCutoff).length,
      delivered_24h: fallbackMessages.filter((row) => row.createdAt >= dayCutoff && row.role === "assistant" && (row.status === "accepted" || row.status === "truncated")).length,
      older_than_90: fallbackMessages.filter((row) => row.createdAt < oldCutoff).length,
    };
  }
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS total_messages,
      COUNT(DISTINCT session_id) AS total_sessions,
      COUNT(DISTINCT NULLIF(ip_address, '')) AS unique_visitors,
      SUM(CASE WHEN status LIKE 'blocked-%' THEN 1 ELSE 0 END) AS blocked_messages,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_24h,
      SUM(CASE WHEN created_at >= ? AND role = 'assistant' AND status IN ('accepted','truncated') THEN 1 ELSE 0 END) AS delivered_24h,
      SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END) AS older_than_90
    FROM chat_messages
  `).bind(dayCutoff, dayCutoff, oldCutoff).first();
  return {
    total_messages: Number(row?.total_messages || 0),
    total_sessions: Number(row?.total_sessions || 0),
    unique_visitors: Number(row?.unique_visitors || 0),
    blocked_messages: Number(row?.blocked_messages || 0),
    last_24h: Number(row?.last_24h || 0),
    delivered_24h: Number(row?.delivered_24h || 0),
    older_than_90: Number(row?.older_than_90 || 0),
  };
}

export async function getAuditLocations(db, limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  if (!db) {
    const visitors = new Map();
    for (const row of fallbackMessages) {
      const ip = row.ipAddress || row.visitorHash || "unknown";
      const key = `${ip}|${row.country || ""}|${row.region || ""}|${row.city || ""}`;
      const current = visitors.get(key) || { ip_address: ip, country: row.country, region: row.region, city: row.city, latitude: row.latitude, longitude: row.longitude, messages: 0, latest: 0 };
      current.messages += 1;
      current.latest = Math.max(current.latest, Number(row.createdAt) || 0);
      visitors.set(key, current);
    }
    const visitorRows = [...visitors.values()].sort((left, right) => right.latest - left.latest).slice(0, safeLimit);
    const countries = new Map();
    for (const row of visitorRows) {
      const country = row.country || "Unknown";
      const current = countries.get(country) || { country, visitors: 0, messages: 0 };
      current.visitors += 1;
      current.messages += row.messages;
      countries.set(country, current);
    }
    return { visitors: visitorRows, countries: [...countries.values()].sort((left, right) => right.visitors - left.visitors) };
  }

  const [visitorsResult, countriesResult] = await Promise.all([
    db.prepare(`
      SELECT ip_address, country, region, city, latitude, longitude,
        COUNT(*) AS messages, MAX(created_at) AS latest
      FROM chat_messages
      WHERE ip_address IS NOT NULL AND ip_address != ''
      GROUP BY ip_address, country, region, city, latitude, longitude
      ORDER BY latest DESC
      LIMIT ?
    `).bind(safeLimit).all(),
    db.prepare(`
      SELECT COALESCE(NULLIF(country, ''), 'Unknown') AS country,
        COUNT(DISTINCT ip_address) AS visitors, COUNT(*) AS messages
      FROM chat_messages
      WHERE ip_address IS NOT NULL AND ip_address != ''
      GROUP BY COALESCE(NULLIF(country, ''), 'Unknown')
      ORDER BY visitors DESC, messages DESC
      LIMIT ?
    `).bind(safeLimit).all(),
  ]);
  return { visitors: visitorsResult.results || [], countries: countriesResult.results || [] };
}

export async function deleteAuditOlderThan90Days(db, now = Date.now()) {
  const cutoff = now - NINETY_DAYS_MS;
  if (!db) {
    const before = fallbackMessages.length;
    for (let index = fallbackMessages.length - 1; index >= 0; index -= 1) {
      if (fallbackMessages[index].createdAt < cutoff) fallbackMessages.splice(index, 1);
    }
    return before - fallbackMessages.length;
  }
  const result = await db.prepare("DELETE FROM chat_messages WHERE created_at < ?").bind(cutoff).run();
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

// Deletes one conversation and reports how many messages went with it. Returning the
// count lets the caller tell "removed 4 messages" from "that session was already gone",
// which matters when two tabs are open on the same dashboard.
// Restore side of the export. Two properties make this safe to run more than once,
// which matters because the natural way to use a backup is to re-import the same file
// after a mistake and see whether it helped:
//
//   - the original row id is carried through and INSERT OR IGNORE drops collisions, so
//     re-importing a file already restored is a no-op rather than a duplicated log;
//   - nothing is deleted. An import merges into whatever is already there.
//
// Rows are read defensively because this file has been outside the worker: it may have
// been hand-edited, concatenated, or produced by an older export. Anything without the
// four fields that make a message a message is skipped and counted, not guessed at.
const IMPORT_COLUMNS = [
  "id", "session_id", "visitor_hash", "role", "content", "status", "origin", "model",
  "reasoning", "ip_address", "country", "region", "city", "latitude", "longitude", "created_at",
];

// D1 supports expanding a JSON array with json_each. Importing a whole backup this
// way avoids one query per message (and the platform's per-invocation query limit)
// while still keeping each bound value comfortably below D1's 2 MB value limit.
const IMPORT_JSON_CHUNK_BYTES = 1_500_000;
const IMPORT_JSON_SQL = `
  INSERT OR IGNORE INTO chat_messages (${IMPORT_COLUMNS.join(", ")})
  SELECT
    json_extract(value, '$.id'),
    json_extract(value, '$.session_id'),
    json_extract(value, '$.visitor_hash'),
    json_extract(value, '$.role'),
    json_extract(value, '$.content'),
    json_extract(value, '$.status'),
    json_extract(value, '$.origin'),
    json_extract(value, '$.model'),
    json_extract(value, '$.reasoning'),
    json_extract(value, '$.ip_address'),
    json_extract(value, '$.country'),
    json_extract(value, '$.region'),
    json_extract(value, '$.city'),
    json_extract(value, '$.latitude'),
    json_extract(value, '$.longitude'),
    json_extract(value, '$.created_at')
  FROM json_each(?)
`;

function normalizeImportRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  // Accept both the snake_case export shape and the camelCase shape used in code, so a
  // backup taken from either side of the wire restores.
  const pick = (snake, camel = snake) => {
    const value = raw[snake] ?? raw[camel];
    return value === undefined || value === "" ? null : value;
  };
  const rawCreatedAt = pick("created_at", "createdAt");
  const numericCreatedAt = Number(rawCreatedAt);
  const createdAt = Number.isFinite(numericCreatedAt) && numericCreatedAt > 0
    ? numericCreatedAt
    : Date.parse(String(rawCreatedAt || ""));
  const row = {
    id: Number(pick("id")) || null,
    session_id: pick("session_id", "sessionId"),
    visitor_hash: pick("visitor_hash", "visitorHash") ?? "restored-backup",
    role: pick("role"),
    content: pick("content"),
    status: pick("status") ?? "ok",
    origin: pick("origin") ?? "restored-backup",
    model: pick("model"),
    reasoning: pick("reasoning"),
    ip_address: pick("ip_address", "ipAddress"),
    country: pick("country"),
    region: pick("region"),
    city: pick("city"),
    latitude: pick("latitude"),
    longitude: pick("longitude"),
    created_at: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
  };
  // A row with no id cannot be deduplicated, and one missing role/content/session/time
  // is not a message. Either way it is unimportable rather than importable-with-holes.
  if (!row.id || !row.session_id || !row.created_at) return null;
  if (row.role !== "user" && row.role !== "assistant") return null;
  if (typeof row.content !== "string" || !row.content) return null;
  return row;
}

export async function importAuditMessages(db, payload) {
  // The file is either the export envelope or a bare array of messages.
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.messages) ? payload.messages : null;
  if (!list) return { ok: false, reason: "shape" };

  const rows = [];
  let skipped = 0;
  for (const raw of list) {
    const row = normalizeImportRow(raw);
    if (row) rows.push(row); else skipped += 1;
  }
  if (!rows.length) return { ok: true, imported: 0, duplicates: 0, skipped };

  if (!db) {
    let imported = 0;
    for (const row of rows) {
      if (fallbackMessages.some((existing) => existing.id === row.id)) continue;
      fallbackMessages.push(row);
      if (row.id > fallbackId) fallbackId = row.id;
      imported += 1;
    }
    return { ok: true, imported, duplicates: rows.length - imported, skipped };
  }

  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = [];
  let chunkBytes = 2;
  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + (chunk.length ? 1 : 0);
    if (chunk.length && chunkBytes + rowBytes > IMPORT_JSON_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 2;
    }
    chunk.push(row);
    chunkBytes += rowBytes;
  }
  if (chunk.length) chunks.push(chunk);

  let imported = 0;
  for (const rowsInChunk of chunks) {
    const result = await db.prepare(IMPORT_JSON_SQL).bind(JSON.stringify(rowsInChunk)).run();
    imported += Number(result?.meta?.changes ?? result?.changes ?? 0);
  }
  return { ok: true, imported, duplicates: rows.length - imported, skipped };
}

export async function deleteAuditConversation(db, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return 0;
  if (!db) {
    const before = fallbackMessages.length;
    for (let index = fallbackMessages.length - 1; index >= 0; index -= 1) {
      // The in-memory rows carry sessionId while D1 rows carry session_id; the
      // listing code straddles both, so deletion has to as well or the fallback
      // path would silently delete nothing.
      const rowSession = fallbackMessages[index].sessionId || fallbackMessages[index].session_id;
      if (rowSession === id) fallbackMessages.splice(index, 1);
    }
    return before - fallbackMessages.length;
  }
  const result = await db.prepare("DELETE FROM chat_messages WHERE session_id = ?").bind(id).run();
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export function resetAuditForTests() {
  fallbackMessages.length = 0;
  fallbackId = 0;
}

export const auditConfig = { manualDeletionAgeDays: 90, automaticDeletion: false };
