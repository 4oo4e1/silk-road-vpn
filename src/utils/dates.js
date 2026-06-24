/**
 * Date helpers
 * D1/SQLite datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS".
 */

/** Parse a D1 datetime string as a UTC timestamp (ms) */
export function parseDbDate(dt) {
  if (!dt) return NaN;
  return Date.parse(String(dt).replace(' ', 'T') + 'Z');
}

/** Whole days remaining until expiry (never negative) */
export function daysRemaining(expiresAt) {
  const ms = parseDbDate(expiresAt) - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function isExpired(expiresAt) {
  return parseDbDate(expiresAt) <= Date.now();
}
