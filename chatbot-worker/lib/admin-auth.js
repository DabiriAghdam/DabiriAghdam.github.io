const encoder = new TextEncoder();
// Cloudflare Workers currently caps Web Crypto PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

function toBase64(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function fromBase64(value) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function safeEqual(left, right) {
  const [a, b] = await Promise.all([digest(String(left)), digest(String(right))]);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

async function derivePasswordHash(password, salt, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return toBase64(new Uint8Array(bits));
}

function newSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function parseBasicAuth(request) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Basic ")) return null;
  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function storedCredential(db) {
  return db.prepare(`
    SELECT username, password_salt, password_hash, iterations, updated_at
    FROM admin_credentials
    WHERE id = 1
  `).first();
}

async function storeCredential(db, username, password, mode = "insert") {
  const salt = newSalt();
  const hash = await derivePasswordHash(password, salt);
  if (mode === "update") {
    await db.prepare(`
      UPDATE admin_credentials
      SET username = ?, password_salt = ?, password_hash = ?, iterations = ?, updated_at = ?
      WHERE id = 1
    `).bind(username, toBase64(salt), hash, PBKDF2_ITERATIONS, Date.now()).run();
    return;
  }
  await db.prepare(`
    INSERT OR IGNORE INTO admin_credentials (
      id, username, password_salt, password_hash, iterations, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?)
  `).bind(username, toBase64(salt), hash, PBKDF2_ITERATIONS, Date.now()).run();
}

export async function verifyAdminCredentials(db, env, credentials) {
  if (!db || !credentials) return false;
  let stored = await storedCredential(db);

  if (!stored) {
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) return false;
    const [usernameMatches, passwordMatches] = await Promise.all([
      safeEqual(credentials.username, env.ADMIN_USERNAME),
      safeEqual(credentials.password, env.ADMIN_PASSWORD),
    ]);
    if (!usernameMatches || !passwordMatches) return false;
    await storeCredential(db, env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
    stored = await storedCredential(db);
    if (!stored) return false;
  }

  const candidateHash = await derivePasswordHash(credentials.password, fromBase64(stored.password_salt), Number(stored.iterations));
  const [usernameMatches, passwordMatches] = await Promise.all([
    safeEqual(credentials.username, stored.username),
    safeEqual(candidateHash, stored.password_hash),
  ]);
  return usernameMatches && passwordMatches;
}

export async function changeAdminPassword(db, username, password) {
  await storeCredential(db, username, password, "update");
}

export const adminAuthConfig = { minimumPasswordLength: 16, maximumPasswordLength: 128 };
