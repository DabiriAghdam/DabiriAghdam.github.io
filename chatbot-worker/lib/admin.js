import { adminAuthConfig, changeAdminPassword, parseBasicAuth, verifyAdminCredentials } from "./admin-auth.js";
import { getThrottleStats } from "./throttle.js";
import { activeProviders } from "./providers.js";
import { auditConfig, countAuditMessages, deleteAuditOlderThan90Days, getAuditLocations, getAuditStats, listAuditConversationPage, listAuditMessages } from "./audit.js";
import { checkAdminLoginRateLimit, enforceAdminLoginRateLimit } from "./rate-limit.js";

const STATUS_OPTIONS = ["accepted", "pending", "blocked-local", "blocked-guard", "blocked-provider", "guard-error", "model-error", "empty-response", "truncated"];
const CONVERSATIONS_PER_PAGE = 10;

function securityHeaders(contentType, nonce = "") {
  const contentSecurityPolicy = [
    "default-src 'none'",
    "style-src 'unsafe-inline' https://unpkg.com",
    "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
    nonce ? `script-src 'nonce-${nonce}'` : "",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].filter(Boolean).join("; ");
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": contentSecurityPolicy,
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function selected(value, expected) {
  return value === expected ? " selected" : "";
}

function groupConversations(messages) {
  const grouped = new Map();
  for (const message of messages) {
    const sessionId = message.session_id || message.sessionId || "unknown";
    if (!grouped.has(sessionId)) grouped.set(sessionId, []);
    grouped.get(sessionId).push(message);
  }
  return [...grouped.entries()].map(([sessionId, rows]) => ({
    sessionId,
    rows: rows.sort((left, right) => Number(left.created_at) - Number(right.created_at)),
    latest: Math.max(...rows.map((row) => Number(row.created_at) || 0)),
  })).sort((left, right) => right.latest - left.latest);
}

function locationLabel(row) {
  return [row.city, row.region, row.country].filter(Boolean).join(", ") || "Location unavailable";
}

// Stored coordinates may be null, empty, or a legacy "0.00000" written before
// absent Cloudflare geo data was rejected at capture time. Number(null) and
// Number("") both yield 0, so blanks have to be rejected explicitly instead of
// relying on Number.isFinite, which happily accepts that 0.
function coordinatePair(row) {
  const parse = (raw, maxAbs) => {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= -maxAbs && parsed <= maxAbs ? parsed : null;
  };
  const latitude = parse(row.latitude, 90);
  const longitude = parse(row.longitude, 180);
  if (latitude === null || longitude === null) return null;
  // Null Island is a sentinel in practice, never a visitor.
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

function mapDot(row) {
  const point = coordinatePair(row);
  if (!point) return "";
  const { latitude, longitude } = point;
  const left = Math.max(1, Math.min(99, ((longitude + 180) / 360) * 100));
  const top = Math.max(1, Math.min(99, ((90 - latitude) / 180) * 100));
  return `<span class="geo-dot" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%" title="${escapeHtml(`${row.ip_address} · ${locationLabel(row)}`)}"></span>`;
}

function renderLocations(locations) {
  const mapPoints = locations.visitors
    .map((row) => {
      const point = coordinatePair(row);
      if (!point) return null;
      return {
        ip: row.ip_address || "IP unavailable",
        location: locationLabel(row),
        latitude: point.latitude,
        longitude: point.longitude,
        messages: Number(row.messages) || 0,
      };
    })
    .filter(Boolean);
  const maxVisitors = Math.max(1, ...locations.countries.map((row) => Number(row.visitors) || 0));
  const countries = locations.countries.length
    ? locations.countries.map((row) => `<div class="country-row"><div><strong>${escapeHtml(row.country)}</strong><span>${number(row.visitors)} visitor${Number(row.visitors) === 1 ? "" : "s"} · ${number(row.messages)} messages</span></div><div class="country-track"><i style="width:${Math.max(4, ((Number(row.visitors) || 0) / maxVisitors) * 100).toFixed(1)}%"></i></div></div>`).join("")
    : '<div class="location-empty">No IP locations recorded yet.</div>';
  const visitors = locations.visitors.length
    ? locations.visitors.slice(0, 25).map((row) => `<tr><td><code>${escapeHtml(row.ip_address || "Unknown")}</code></td><td>${escapeHtml(locationLabel(row))}</td><td>${number(row.messages)}</td><td>${escapeHtml(formatTime(row.latest))}</td></tr>`).join("")
    : '<tr><td colspan="4" class="location-empty">No visitors recorded yet.</td></tr>';
  const mapData = escapeHtml(JSON.stringify(mapPoints));
  return `<section class="geo-grid">
    <div class="panel geo-panel"><div class="panel-head"><div><h2>Visitor geography</h2><p>Approximate IP-based locations supplied by Cloudflare.</p></div></div><div id="geo-map" class="geo-map${mapPoints.length ? "" : " geo-map--empty"}" data-points="${mapData}" role="region" aria-label="Approximate visitor locations on an OpenStreetMap map">${mapPoints.length ? "" : '<span class="map-empty">No precise coordinates available for these visitors.</span>'}</div><div class="geo-legend"><span><i class="geo-dot"></i> recorded visitor</span><span>OpenStreetMap · coordinates may be approximate</span></div></div>
    <div class="panel"><div class="panel-head"><div><h2>Where visitors come from</h2><p>Unique IP addresses grouped by country.</p></div></div><div class="country-list">${countries}</div></div>
    <div class="panel geo-wide"><div class="panel-head"><div><h2>Visitor IPs</h2><p>Most recent activity first.</p></div></div><div class="location-table-wrap"><table class="location-table"><thead><tr><th>IP address</th><th>Approximate location</th><th>Messages</th><th>Last seen</th></tr></thead><tbody>${visitors}</tbody></table></div></div>
  </section>`;
}

// Assistant rows record who actually answered as "provider:model"; the fallback chain
// means that is not always the primary. Rows written before the chain existed hold a
// bare model id, and rows for user messages hold only the provider we meant to try,
// so the badge is shown for assistant turns alone.
function modelBadge(row) {
  if (row.role !== "assistant" || !row.model) return "";
  const separator = row.model.indexOf(":");
  const provider = separator > 0 ? row.model.slice(0, separator) : "";
  const model = separator > 0 ? row.model.slice(separator + 1) : row.model;
  const label = provider ? `${provider} · ${model}` : model;
  return `<span class="model-badge" title="Served by ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function renderConversations(conversations) {
  if (!conversations.length) return '<div class="empty"><strong>No conversations found</strong><span>Try clearing the filters or wait for new chats.</span></div>';
  return conversations.map(({ sessionId, rows, latest }) => {
    const first = rows[0];
    const bubbles = rows.map((row) => `
      <div class="message-row ${escapeHtml(row.role)}">
        <div class="message-meta"><span>${escapeHtml(row.role)}</span><time>${escapeHtml(formatTime(row.created_at))}</time><span class="status status-${escapeHtml(row.status)}">${escapeHtml(row.status)}</span>${modelBadge(row)}</div>
        <div class="bubble">${escapeHtml(row.content)}</div>
        ${row.reasoning ? `<details class="reasoning"><summary>Model reasoning</summary><div class="reasoning-content">${escapeHtml(row.reasoning)}</div></details>` : ""}
      </div>`).join("");
    return `<article class="conversation">
      <details>
        <summary>
          <span><strong>Session ${escapeHtml(String(sessionId).slice(0, 16))}</strong><small>${rows.length} message${rows.length === 1 ? "" : "s"} · ${escapeHtml(formatTime(latest))}</small></span>
          <span class="session-meta"><code>${escapeHtml(first.ip_address || "IP unavailable")}</code><small>${escapeHtml(locationLabel(first))} · ${escapeHtml(first.origin || "unknown origin")}</small></span>
        </summary>
        <div class="thread">${bubbles}</div>
      </details>
    </article>`;
  }).join("");
}

function paginationLink(filters, page, label) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.role) params.set("role", filters.role);
  if (filters.status) params.set("status", filters.status);
  params.set("page", String(page));
  return `<a class="button secondary pagination-button" href="/admin?${escapeHtml(params.toString())}">${escapeHtml(label)}</a>`;
}

function renderPagination(filters, pagination) {
  if (pagination.totalPages <= 1) return "";
  const previous = pagination.page > 1
    ? paginationLink(filters, pagination.page - 1, "Previous")
    : '<span class="button secondary pagination-button is-disabled" aria-disabled="true">Previous</span>';
  const next = pagination.page < pagination.totalPages
    ? paginationLink(filters, pagination.page + 1, "Next")
    : '<span class="button secondary pagination-button is-disabled" aria-disabled="true">Next</span>';
  return `<nav class="pagination" aria-label="Conversation pages">${previous}<span class="pagination-label">Page ${pagination.page} of ${pagination.totalPages}</span>${next}</nav>`;
}

// The signal Amir actually needs is not "how many 429s" but "what share of people
// who tried to ask something got turned away" — a handful of rejections on a busy
// day is fine, while the same number on a quiet day means the assistant is broken
// for most visitors. An exhausted upstream budget is always called out, because at
// that point the assistant is down until the quota resets rather than merely slow.
function renderThrottleNotice(throttle, stats, providers = []) {
  if (!throttle || throttle.today === 0) return "";
  const delivered = Number(stats?.delivered_24h || 0);
  const attempted = delivered + throttle.today;
  const share = attempted > 0 ? Math.round((throttle.today / attempted) * 100) : 100;
  const exhausted = Number(throttle.byKind?.["upstream-exhausted"] || 0) > 0;
  const severe = exhausted || share >= 20;
  if (!severe) return "";
  const parts = [];
  if (throttle.todayOwnLimits > 0) parts.push(`${number(throttle.todayOwnLimits)} by this site's own rate limits`);
  if (throttle.todayUpstream > 0) parts.push(`${number(throttle.todayUpstream)} by the model provider`);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  const lead = exhausted
    ? "The model provider's daily budget ran out today, so the assistant stopped answering until the quota resets."
    : `About ${share}% of attempted questions were turned away today.`;
  // Never claim a fallback was tried that has no key configured: that would send the
  // reader looking for a bug in the chain when the fix is to add the missing secret.
  const fallbacks = providers.slice(1);
  const advice = fallbacks.length
    ? `${fallbacks.join(" and ")} ${fallbacks.length === 1 ? "is" : "are"} already tried before a visitor sees this, so consider raising the caps or trimming the prompt further.`
    : `No fallback provider is configured, so ${providers[0] || "the primary provider"} running out means the assistant stops answering. Adding a GEMINI_API_KEY or OPENROUTER_API_KEY secret would cover this.`;
  return `<div class="flash error" role="status"><strong>Assistant is being throttled.</strong> ${escapeHtml(lead)} ${number(throttle.today)} request${throttle.today === 1 ? "" : "s"} rejected in the last day${escapeHtml(detail)}, ${number(throttle.week)} in the last 7 days. ${escapeHtml(advice)}</div>`;
}

function renderAdmin({ messages, conversations, locations, stats, throttle, providers, filters, pagination, username, flash, nonce }) {
  const sessionsShown = conversations.length;
  const statusOptions = STATUS_OPTIONS.map((status) => `<option value="${status}"${selected(filters.status, status)}>${status}</option>`).join("");
  const flashMarkup = flash ? `<div class="flash ${escapeHtml(flash.type)}" role="status">${escapeHtml(flash.message)}</div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Amir Chat Dashboard</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
  <script nonce="${escapeHtml(nonce)}">try{const theme=localStorage.getItem("admin-theme");if(theme==="light"||theme==="dark")document.documentElement.dataset.theme=theme}catch{}</script>
  <style>
    :root{color-scheme:light dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:#f4f6f8;--panel:#fff;--panel-2:#f8fafc;--text:#18202a;--muted:#667085;--line:#dfe4ea;--accent:#7b3f98;--accent-soft:#f4ebf7;--danger:#b42318;--danger-soft:#fff1f0;--success:#067647;--success-soft:#ecfdf3;--shadow:0 1px 2px rgba(16,24,40,.04)}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}main{max-width:1320px;margin:auto;padding:32px 24px 64px}
    header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:24px}.eyebrow{margin:0 0 8px;color:var(--accent);font-size:12px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}h1{margin:0 0 7px;font-size:28px;letter-spacing:-.03em}.subtitle{margin:0;color:var(--muted);font-size:14px}.header-actions{display:flex;gap:8px;flex-wrap:wrap}
    .button,button{appearance:none;border:1px solid transparent;border-radius:9px;background:var(--text);color:var(--panel);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;font:inherit;font-size:13px;font-weight:700;text-decoration:none}.button.secondary,button.secondary{background:var(--panel);border-color:var(--line);color:var(--text)}button.danger{background:var(--danger);color:#fff}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 35%,transparent);outline-offset:2px}
    .stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:18px}.stat,.panel,.conversation{background:var(--panel);border:1px solid var(--line);border-radius:13px;box-shadow:var(--shadow)}.stat{padding:16px}.stat strong{display:block;font-size:24px;line-height:1.15;letter-spacing:-.025em}.stat span{color:var(--muted);font-size:12px}.stat.warn strong{color:var(--danger)}
    .flash{border:1px solid;border-radius:10px;margin-bottom:18px;padding:12px 14px;font-size:14px}.flash.success{background:var(--success-soft);border-color:#abefc6;color:var(--success)}.flash.error{background:var(--danger-soft);border-color:#fecdca;color:var(--danger)}
    .panel{padding:18px;margin-bottom:18px}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:15px}.panel h2{font-size:16px;margin:0 0 4px}.panel p{color:var(--muted);font-size:13px;line-height:1.5;margin:0}.filters{display:grid;grid-template-columns:minmax(220px,1fr) 150px 175px auto auto;gap:10px;align-items:end}.field{display:flex;flex-direction:column;gap:6px}.field label{font-size:12px;font-weight:700;color:var(--muted)}input,select{width:100%;min-height:41px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--text);font:inherit;font-size:14px;padding:9px 11px}
    .results-bar{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:22px 0 10px}.results-bar h2{font-size:17px;margin:0}.results-bar span{color:var(--muted);font-size:13px}.conversation{margin-bottom:10px;overflow:hidden}.pagination{display:flex;align-items:center;justify-content:center;gap:12px;margin:18px 0 28px}.pagination-button{padding:8px 11px;font-size:12px}.pagination-button.is-disabled{cursor:not-allowed;opacity:.45}.pagination-label{color:var(--muted);font-size:12px;font-weight:650;min-width:82px;text-align:center}details>summary{cursor:pointer;display:flex;justify-content:space-between;gap:16px;list-style:none;padding:14px 16px}summary::-webkit-details-marker{display:none}summary>span{display:flex;flex-direction:column;gap:3px}summary strong{font-size:13px}summary small{color:var(--muted);font-size:11px}.session-meta{text-align:right}.session-meta code{font-size:11px;color:var(--accent)}
    .thread{border-top:1px solid var(--line);background:var(--panel-2);padding:18px}.message-row{max-width:78%;margin-bottom:15px}.message-row:last-child{margin-bottom:0}.message-row.user{margin-left:auto}.message-meta{display:flex;gap:8px;align-items:center;margin:0 4px 5px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}.message-row.user .message-meta{justify-content:flex-end}.bubble{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55}.message-row.user .bubble{background:var(--accent);border-color:var(--accent);color:#fff}.reasoning{margin-top:7px;color:var(--muted);font-size:11px}.reasoning summary{cursor:pointer;display:inline-block;padding:3px 0}.reasoning-content{max-height:280px;overflow:auto;margin-top:5px;padding:8px 10px;border-left:2px solid var(--line);background:var(--panel);white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.5}.status{border-radius:99px;background:var(--panel);padding:2px 5px}.model-badge{border-radius:99px;border:1px solid var(--line);padding:2px 6px;color:var(--muted);text-transform:none;letter-spacing:0;font-size:10px;overflow-wrap:anywhere}.status-blocked-local,.status-blocked-guard,.status-blocked-provider,.status-model-error,.status-guard-error{color:var(--danger)}
    .geo-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:18px;margin-bottom:18px}.geo-panel{min-height:300px}.geo-wide{grid-column:1/-1}.geo-map{position:relative;min-height:220px;overflow:hidden;border:1px solid var(--line);border-radius:12px;background-color:var(--panel-2);background-image:linear-gradient(to right,color-mix(in srgb,var(--line) 70%,transparent) 1px,transparent 1px),linear-gradient(to bottom,color-mix(in srgb,var(--line) 70%,transparent) 1px,transparent 1px);background-size:10% 100%,100% 20%}.geo-map:before{content:"";position:absolute;inset:14% 5%;border-radius:48% 42% 50% 40%;background:color-mix(in srgb,var(--accent) 9%,transparent);clip-path:polygon(3% 21%,15% 11%,22% 20%,29% 15%,37% 28%,46% 17%,55% 26%,67% 17%,77% 30%,90% 24%,98% 44%,92% 58%,81% 54%,73% 70%,62% 62%,53% 79%,43% 69%,34% 83%,25% 67%,16% 75%,7% 57%)}.geo-dot{position:absolute;z-index:1;width:10px;height:10px;border:2px solid var(--panel);border-radius:50%;background:var(--accent);box-shadow:0 1px 5px color-mix(in srgb,var(--accent) 60%,transparent);transform:translate(-50%,-50%)}.geo-legend{display:flex;justify-content:space-between;gap:12px;margin-top:9px;color:var(--muted);font-size:11px}.geo-legend .geo-dot{position:static;display:inline-block;width:9px;height:9px;transform:none;margin-right:4px}.map-empty,.location-empty{color:var(--muted);font-size:13px}.map-empty{position:absolute;inset:0;display:grid;place-items:center}.country-list{display:grid;gap:14px}.country-row{display:grid;gap:7px}.country-row>div:first-child{display:flex;justify-content:space-between;gap:8px;font-size:13px}.country-row span{color:var(--muted);font-size:11px}.country-track{height:7px;overflow:hidden;border-radius:99px;background:var(--panel-2)}.country-track i{display:block;height:100%;border-radius:inherit;background:var(--accent)}.location-table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}.location-table{width:100%;border-collapse:collapse;font-size:12px}.location-table th,.location-table td{padding:10px 11px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}.location-table th{background:var(--panel-2);color:var(--muted);font-size:10px;letter-spacing:.05em;text-transform:uppercase}.location-table tr:last-child td{border-bottom:0}
    .empty{align-items:center;background:var(--panel);border:1px dashed var(--line);border-radius:13px;color:var(--muted);display:flex;flex-direction:column;gap:5px;padding:54px 20px}.empty strong{color:var(--text)}.settings{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:28px}.settings .panel{margin:0}.stack{display:grid;gap:11px;margin-top:15px}.inline-check{display:flex;align-items:flex-start;gap:9px;color:var(--muted);font-size:12px;line-height:1.45}.inline-check input{width:16px;min-height:16px;margin-top:1px}.danger-panel{border-color:#fecdca}.danger-panel h2{color:var(--danger)}.footnote{margin-top:22px;color:var(--muted);font-size:11px;text-align:center}
    .geo-map:before{display:none}.geo-map{position:relative;width:100%;height:280px;min-height:0;overflow:hidden;background:var(--panel-2)}.geo-map .leaflet-container{width:100%;height:100%;position:relative;overflow:hidden;background:var(--panel-2);font:inherit}.geo-map .leaflet-pane,.geo-map .leaflet-tile,.geo-map .leaflet-marker-icon,.geo-map .leaflet-marker-shadow,.geo-map .leaflet-tile-container,.geo-map .leaflet-pane>svg,.geo-map .leaflet-pane>canvas,.geo-map .leaflet-zoom-box,.geo-map .leaflet-image-layer,.geo-map .leaflet-layer{position:absolute;left:0;top:0}.geo-map .leaflet-tile{max-width:none;visibility:hidden}.geo-map .leaflet-tile-loaded{visibility:inherit}.geo-map .leaflet-tile-container{pointer-events:none}.geo-map .leaflet-marker-icon,.geo-map .leaflet-marker-shadow{display:block}.geo-map .leaflet-control{position:relative;z-index:800;pointer-events:auto}.geo-map .leaflet-top,.geo-map .leaflet-bottom{position:absolute;z-index:1000;pointer-events:none}.geo-map .leaflet-top{top:0}.geo-map .leaflet-bottom{bottom:0}.geo-map .leaflet-left{left:0}.geo-map .leaflet-right{right:0}.geo-map .leaflet-control-attribution{font-size:10px}.geo-map--empty{display:grid;place-items:center}.geo-dot{position:static;display:inline-block;width:9px;height:9px;transform:none;margin-right:4px}
    @media(max-width:1100px){.stats{grid-template-columns:repeat(3,1fr)}.geo-grid{grid-template-columns:1fr}.geo-wide{grid-column:auto}}@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}.filters{grid-template-columns:1fr 1fr}.filters .search{grid-column:1/-1}.settings{grid-template-columns:1fr}.message-row{max-width:92%}}
    @media(max-width:560px){main{padding:22px 14px 42px}header{flex-direction:column}.stats{grid-template-columns:1fr 1fr}.filters{grid-template-columns:1fr}.filters .search{grid-column:auto}.header-actions,.header-actions .button{width:100%}details>summary{flex-direction:column}.session-meta{text-align:left}.message-row{max-width:100%}}
    @media(prefers-color-scheme:dark){:root{--bg:#101214;--panel:#191c1f;--panel-2:#151719;--text:#f1f3f5;--muted:#a3aab3;--line:#353a40;--accent:#ca84e8;--accent-soft:#321f3b;--danger:#ff8a80;--danger-soft:#321b1b;--success:#70d7a1;--success-soft:#132a20;--shadow:none}.message-row.user .bubble{background:#753d8e;border-color:#9251ae}.danger-panel{border-color:#683334}.flash.success{border-color:#315d45}.flash.error{border-color:#683334}}

    /* Deliberately plain admin UI: compact, data-first, and visually separate from the public site. */
    :root{--bg:#f7f7f5;--panel:#fff;--panel-2:#f5f5f2;--text:#171717;--muted:#6b6b66;--line:#d9d9d4;--accent:#245b78;--accent-soft:#e9f1f5;--danger:#a33b32;--danger-soft:#faf0ee;--success:#276749;--success-soft:#edf7f1;--shadow:none}
    body{font-size:14px}main{max-width:1200px;padding:40px 28px 72px}
    header{align-items:center;margin-bottom:20px;padding-bottom:17px;border-bottom:1px solid var(--line)}
    h1{font-family:Georgia,"Times New Roman",serif;font-size:30px;font-weight:500;letter-spacing:-.025em;margin:0 0 4px}.eyebrow{display:none}.subtitle{font-size:13px}.title-line{display:flex;align-items:center;gap:10px}
    .button,button{border-radius:5px;padding:8px 12px;font-size:12px;font-weight:650;background:var(--text)}.button.secondary,button.secondary{background:transparent}.button:hover,button:hover{filter:brightness(.96)}
    .stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;margin:0 0 24px;background:var(--panel);border:1px solid var(--line);border-radius:7px;overflow:hidden}.stat{border:0;border-right:1px solid var(--line);border-radius:0;padding:13px 15px;background:transparent}.stat:last-child{border-right:0}.stat strong{font:500 20px/1.2 Georgia,"Times New Roman",serif}.stat span{display:block;margin-top:2px;font-size:10px;letter-spacing:.04em;text-transform:uppercase}.stat.warn strong{color:var(--text)}
    .panel,.conversation{border-radius:7px;box-shadow:none}.panel{padding:16px;margin-bottom:16px}.panel-head{margin-bottom:12px}.panel h2,.results-bar h2{font-family:Georgia,"Times New Roman",serif;font-size:18px;font-weight:500;letter-spacing:-.01em}.panel p{font-size:12px}.flash{border-radius:5px;padding:10px 12px}
    .geo-grid{grid-template-columns:minmax(0,1.45fr) minmax(280px,.55fr);gap:16px;margin-bottom:16px}.geo-panel{min-height:0}.geo-map{height:248px;border-radius:4px}.geo-legend{font-size:10px}.country-list{gap:12px}.country-row>div:first-child{font-size:12px}.country-track{height:3px;border-radius:0}.country-track i{border-radius:0}.geo-wide{grid-column:1/-1}.location-table-wrap{border-radius:4px}.location-table th,.location-table td{padding:9px 10px}.location-table th{font-size:9px;background:var(--panel-2)}
    .filters{grid-template-columns:minmax(240px,1fr) 140px 165px auto auto}.field{gap:5px}.field label{font-size:10px;letter-spacing:.05em;text-transform:uppercase}input,select{min-height:36px;border-radius:4px;font-size:13px;padding:7px 9px}
    .results-bar{margin:28px 0 9px;padding-bottom:8px;border-bottom:1px solid var(--line)}.results-bar span{font-size:11px}.conversation{margin:0;border-width:0 0 1px;border-radius:0;background:transparent}.conversation:first-of-type{border-top:1px solid var(--line)}details>summary{padding:12px 4px}details>summary:before{content:"+";flex:0 0 15px;color:var(--muted);font:16px/1 monospace}details[open]>summary:before{content:"−"}summary>span:first-of-type{flex:1}summary strong{font-size:12px;font-weight:650}summary small{font-size:10px}.session-meta{min-width:260px}.session-meta code{color:var(--text);font-size:10px}.thread{border:1px solid var(--line);border-bottom:0;background:var(--panel);padding:16px}.message-row{max-width:82%}.bubble{border-radius:5px;font-size:12px}.message-row.user .bubble{background:var(--accent-soft);border-color:#c9dbe5;color:var(--text)}.status{border-radius:3px;padding:1px 4px}.model-badge{border-radius:3px;padding:1px 4px}
    .pagination{margin:18px 0 34px}.settings{padding-top:22px;border-top:1px solid var(--line);gap:16px}.settings .panel{background:transparent}.danger-panel{border-color:#dfc8c4}.footnote{text-align:left;border-top:1px solid var(--line);padding-top:14px}.empty{border-radius:5px;padding:42px 20px}
    @media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}.stat:nth-child(3){border-right:0}.stat:nth-child(-n+3){border-bottom:1px solid var(--line)}.geo-grid{grid-template-columns:1fr}.geo-wide{grid-column:auto}.session-meta{min-width:0}}
    @media(max-width:560px){main{padding:24px 14px 44px}header{align-items:flex-start}.stats{grid-template-columns:repeat(2,1fr)}.stat:nth-child(3){border-right:1px solid var(--line)}.stat:nth-child(even){border-right:0}.stat:nth-child(-n+4){border-bottom:1px solid var(--line)}.filters{grid-template-columns:1fr}.geo-map{height:220px}.session-meta{text-align:left}.settings .panel{padding:14px 0;border-left:0;border-right:0}}
    @media(prefers-color-scheme:dark){:root{--bg:#111210;--panel:#191a18;--panel-2:#151614;--text:#ededE8;--muted:#a2a29b;--line:#383934;--accent:#78a9c2;--accent-soft:#1c303a;--danger:#e28a80;--danger-soft:#31201e;--success:#6fbd91;--success-soft:#183024}.message-row.user .bubble{background:var(--accent-soft);border-color:#315366;color:var(--text)}.danger-panel{border-color:#65423e}}
    :root[data-theme="light"]{color-scheme:light;--bg:#f7f7f5;--panel:#fff;--panel-2:#f5f5f2;--text:#171717;--muted:#6b6b66;--line:#d9d9d4;--accent:#245b78;--accent-soft:#e9f1f5;--danger:#a33b32;--danger-soft:#faf0ee;--success:#276749;--success-soft:#edf7f1}
    :root[data-theme="light"] .message-row.user .bubble{background:var(--accent-soft);border-color:#c9dbe5;color:var(--text)}
    :root[data-theme="light"] .danger-panel{border-color:#dfc8c4}
    :root[data-theme="dark"]{color-scheme:dark;--bg:#111210;--panel:#191a18;--panel-2:#151614;--text:#edede8;--muted:#a2a29b;--line:#383934;--accent:#78a9c2;--accent-soft:#1c303a;--danger:#e28a80;--danger-soft:#31201e;--success:#6fbd91;--success-soft:#183024}
    :root[data-theme="dark"] .message-row.user .bubble{background:var(--accent-soft);border-color:#315366;color:var(--text)}
    :root[data-theme="dark"] .danger-panel{border-color:#65423e}
  </style>
</head>
<body><main>
  <header><div><div class="title-line"><h1>Chat logs</h1></div><p class="subtitle">Conversations and visitor activity for dabiriaghdam.github.io</p></div><div class="header-actions"><button id="theme-toggle" class="secondary" type="button" aria-label="Switch dashboard color theme">Light mode</button><a class="button secondary" href="/admin/export.json">Export JSON</a></div></header>
  ${flashMarkup}
  <section class="stats" aria-label="Audit summary">
    <div class="stat"><strong>${number(stats.total_messages)}</strong><span>total messages</span></div>
    <div class="stat"><strong>${number(stats.total_sessions)}</strong><span>total sessions</span></div>
    <div class="stat"><strong>${number(stats.unique_visitors)}</strong><span>unique IPs</span></div>
    <div class="stat"><strong>${number(stats.last_24h)}</strong><span>messages in 24 hours</span></div>
    <div class="stat"><strong>${number(stats.blocked_messages)}</strong><span>blocked requests</span></div>
    <div class="stat${throttle && throttle.today > 0 ? " warn" : ""}"><strong>${number(throttle ? throttle.today : 0)}</strong><span>turned away (24h)</span></div>
    <div class="stat warn"><strong>${number(stats.older_than_90)}</strong><span>older than 90 days</span></div>
  </section>
  ${renderThrottleNotice(throttle, stats, providers)}
  ${renderLocations(locations)}
  <section class="panel">
    <div class="panel-head"><div><h2>Search</h2><p>Search message text or a session ID, then narrow by role or processing status.</p></div></div>
    <form class="filters" method="get" action="/admin">
      <div class="field search"><label for="q">Search</label><input id="q" name="q" value="${escapeHtml(filters.q)}" maxlength="100" placeholder="Message text or session ID"></div>
      <div class="field"><label for="role">Role</label><select id="role" name="role"><option value="">All roles</option><option value="user"${selected(filters.role, "user")}>User</option><option value="assistant"${selected(filters.role, "assistant")}>Assistant</option></select></div>
      <div class="field"><label for="status">Status</label><select id="status" name="status"><option value="">All statuses</option>${statusOptions}</select></div>
      <button type="submit">Apply filters</button><a class="button secondary" href="/admin">Clear</a>
    </form>
  </section>
  <div class="results-bar"><h2>Conversations</h2><span>Showing ${pagination.start}–${pagination.end} of ${pagination.totalConversations} conversation${pagination.totalConversations === 1 ? "" : "s"} · ${messages.length} message${messages.length === 1 ? "" : "s"} on this page</span></div>
  ${renderConversations(conversations)}
  ${renderPagination(filters, pagination)}
  <section class="settings">
    <div class="panel">
      <h2>Change dashboard password</h2><p>Signed in as <strong>${escapeHtml(username)}</strong>. Use at least ${adminAuthConfig.minimumPasswordLength} characters. After saving, your browser will ask you to sign in again.</p>
      <form class="stack" method="post" action="/admin/password">
        <div class="field"><label for="new-password">New password</label><input id="new-password" name="new_password" type="password" minlength="${adminAuthConfig.minimumPasswordLength}" maxlength="${adminAuthConfig.maximumPasswordLength}" autocomplete="new-password" required></div>
        <div class="field"><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirm_password" type="password" minlength="${adminAuthConfig.minimumPasswordLength}" maxlength="${adminAuthConfig.maximumPasswordLength}" autocomplete="new-password" required></div>
        <button type="submit">Update password</button>
      </form>
    </div>
    <div class="panel danger-panel">
      <h2>Delete old conversations</h2><p>Records are kept indefinitely by default. This permanently deletes every message older than ${auditConfig.manualDeletionAgeDays} days. Newer records are not affected.</p>
      <form class="stack" method="post" action="/admin/delete-old">
        <label class="inline-check"><input name="confirm" value="yes" type="checkbox" required><span>I understand this permanently deletes ${number(stats.older_than_90)} old message${stats.older_than_90 === 1 ? "" : "s"} and cannot be undone.</span></label>
        <button class="danger" type="submit"${stats.older_than_90 ? "" : " disabled"}>Delete messages older than 90 days</button>
      </form>
    </div>
  </section>
  <p class="footnote">Location data is supplied by Cloudflare and may be approximate or unavailable.</p>
</main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin="" nonce="${escapeHtml(nonce)}"></script>
<script nonce="${escapeHtml(nonce)}">
(() => {
  const root = document.documentElement;
  const themeButton = document.getElementById("theme-toggle");
  const systemTheme = () => window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const activeTheme = () => root.dataset.theme || systemTheme();
  const updateThemeButton = () => {
    if (themeButton) themeButton.textContent = activeTheme() === "dark" ? "Light mode" : "Dark mode";
  };
  if (themeButton) themeButton.addEventListener("click", () => {
    const nextTheme = activeTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = nextTheme;
    try { localStorage.setItem("admin-theme", nextTheme); } catch {}
    updateThemeButton();
  });
  updateThemeButton();

  const element = document.getElementById("geo-map");
  if (!element || !window.L) return;
  const points = JSON.parse(element.dataset.points || "[]");
  if (!points.length) return;
  const map = L.map(element, { scrollWheelZoom: false, worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(map);
  const bounds = [];
  points.forEach((point) => {
    const marker = L.marker([point.latitude, point.longitude]).addTo(map);
    const popup = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = point.ip;
    popup.appendChild(title);
    popup.appendChild(document.createElement("br"));
    popup.appendChild(document.createTextNode(point.location));
    popup.appendChild(document.createElement("br"));
    popup.appendChild(document.createTextNode(String(point.messages) + " message" + (point.messages === 1 ? "" : "s")));
    marker.bindPopup(popup);
    bounds.push([point.latitude, point.longitude]);
  });
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 7 });
  window.setTimeout(() => map.invalidateSize(), 0);
})();
</script>
</body></html>`;
}

function filtersFromUrl(url) {
  return {
    q: (url.searchParams.get("q") || "").trim().slice(0, 100),
    role: url.searchParams.get("role") || "",
    status: url.searchParams.get("status") || "",
    page: Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1),
  };
}

function sameOriginPost(request) {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return origin === expected && (!fetchSite || fetchSite === "same-origin");
}

async function dashboardResponse(request, env, username, flash) {
  const url = new URL(request.url);
  const filters = filtersFromUrl(url);
  const [conversationPage, stats, locations, throttle] = await Promise.all([
    listAuditConversationPage(env.DB, filters, filters.page, CONVERSATIONS_PER_PAGE),
    getAuditStats(env.DB),
    getAuditLocations(env.DB),
    getThrottleStats(env.DB),
  ]);
  const pageMessages = conversationPage.messages;
  const conversations = groupConversations(pageMessages);
  const { page, totalPages, totalConversations } = conversationPage;
  const messages = conversations.flatMap((conversation) => conversation.rows);
  const pagination = {
    page,
    totalPages,
    totalConversations,
    start: totalConversations ? (page - 1) * CONVERSATIONS_PER_PAGE + 1 : 0,
    end: Math.min(page * CONVERSATIONS_PER_PAGE, totalConversations),
  };
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(request.method === "HEAD" ? null : renderAdmin({ messages, conversations, locations, stats, throttle, providers: activeProviders(env).map((provider) => provider.name), filters, pagination, username, flash, nonce }), {
    headers: securityHeaders("text/html; charset=utf-8", nonce),
  });
}

function passwordChangedResponse() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Password updated</title><style>:root{color-scheme:light dark;font-family:system-ui}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f8;color:#18202a}.card{max-width:460px;margin:20px;padding:30px;border:1px solid #dfe4ea;border-radius:14px;background:#fff}h1{font-size:22px}p{line-height:1.6;color:#667085}a{display:inline-block;margin-top:8px;background:#18202a;color:#fff;padding:10px 14px;border-radius:9px;text-decoration:none;font-weight:700}@media(prefers-color-scheme:dark){body{background:#101214;color:#f1f3f5}.card{background:#191c1f;border-color:#353a40}p{color:#a3aab3}a{background:#f1f3f5;color:#18202a}}</style></head><body><main class="card"><h1>Password updated</h1><p>Your new dashboard password is active. Return to the dashboard and sign in with it. If your browser keeps sending the old password, close this tab and open the dashboard in a new private window.</p><a href="/admin">Return to dashboard</a></main></body></html>`, {
    headers: securityHeaders("text/html; charset=utf-8"),
  });
}

export async function handleAdminRequest(request, env) {
  const headers = securityHeaders("text/html; charset=utf-8");
  if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers });
  if (!env.DB) return new Response("The audit dashboard is not configured.", { status: 503, headers });

  const credentials = parseBasicAuth(request);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown-visitor";

  // Verifying a password costs a 100,000-iteration PBKDF2 derivation, so the
  // budget is checked before that work rather than after it. The check does not
  // consume quota; only a failed attempt below does, which keeps a successful
  // sign-in (and the browser's initial credential-less probe) free.
  if (credentials) {
    const budget = await checkAdminLoginRateLimit(env.DB, ip);
    if (!budget.allowed) {
      headers["Retry-After"] = String(budget.retryAfter);
      return new Response("Too many login attempts.", { status: 429, headers });
    }
  }

  if (!(await verifyAdminCredentials(env.DB, env, credentials))) {
    if (credentials) {
      const limit = await enforceAdminLoginRateLimit(env.DB, ip);
      if (!limit.allowed) {
        headers["Retry-After"] = String(limit.retryAfter);
        return new Response("Too many login attempts.", { status: 429, headers });
      }
    }
    headers["WWW-Authenticate"] = 'Basic realm="Amir Chat Dashboard", charset="UTF-8"';
    return new Response("Authentication required.", { status: 401, headers });
  }

  const url = new URL(request.url);
  if (request.method === "POST") {
    if (!sameOriginPost(request)) return new Response("Cross-origin form submission rejected.", { status: 403, headers });
    const form = await request.formData();
    if (url.pathname === "/admin/password") {
      const password = String(form.get("new_password") || "");
      const confirmation = String(form.get("confirm_password") || "");
      if (password !== confirmation) return dashboardResponse(request, env, credentials.username, { type: "error", message: "The new passwords do not match." });
      if (password.length < adminAuthConfig.minimumPasswordLength || password.length > adminAuthConfig.maximumPasswordLength) {
        return dashboardResponse(request, env, credentials.username, { type: "error", message: `Use a password between ${adminAuthConfig.minimumPasswordLength} and ${adminAuthConfig.maximumPasswordLength} characters.` });
      }
      await changeAdminPassword(env.DB, credentials.username, password);
      return passwordChangedResponse();
    }
    if (url.pathname === "/admin/delete-old") {
      if (form.get("confirm") !== "yes") return dashboardResponse(request, env, credentials.username, { type: "error", message: "Confirm the permanent deletion before continuing." });
      const deleted = await deleteAuditOlderThan90Days(env.DB);
      return dashboardResponse(request, env, credentials.username, { type: "success", message: `Deleted ${deleted} message${deleted === 1 ? "" : "s"} older than 90 days.` });
    }
    return new Response("Not found", { status: 404, headers });
  }

  if (url.pathname === "/admin/export.json") {
    const filters = filtersFromUrl(url);
    const [messages, totalMessages] = await Promise.all([
      listAuditMessages(env.DB, { ...filters, limit: 5000 }),
      countAuditMessages(env.DB, filters),
    ]);
    return new Response(request.method === "HEAD" ? null : JSON.stringify({ exportedAt: new Date().toISOString(), retention: "indefinite-until-manual-deletion", filters, totalMessages, exportedMessages: messages.length, truncated: messages.length < totalMessages, messages }, null, 2), {
      headers: securityHeaders("application/json; charset=utf-8"),
    });
  }
  if (url.pathname !== "/admin") return new Response("Not found", { status: 404, headers });
  return dashboardResponse(request, env, credentials.username);
}
