/**
 * Authentication — Telegram WebApp initData
 * Phase 3.
 *
 * Every Mini App API request carries the raw initData string in the
 * `X-Telegram-Init-Data` header. We verify Telegram's HMAC signature
 * (so it cannot be forged), check freshness, then load/create the user.
 * Stateless: no server session needed — Telegram already signed it.
 *
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import { errorJson } from './utils/helpers.js';
import { upsertUser, isAdmin } from './database.js';

const MAX_INITDATA_AGE_SECONDS = 60 * 60 * 24; // 24h — Telegram re-issues on each open

/**
 * Verify initData signature + freshness.
 * @returns {Promise<object|null>} the Telegram user object, or null if invalid
 */
export async function verifyInitData(env, initDataRaw) {
  if (!initDataRaw || typeof initDataRaw !== 'string' || initDataRaw.length > 4096) {
    return null;
  }

  const params = new URLSearchParams(initDataRaw);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[0-9a-f]{64}$/i.test(receivedHash)) return null;
  params.delete('hash');

  // data_check_string: "key=value" lines, keys sorted alphabetically
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const enc = new TextEncoder();

  // secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
  const webAppKey = await crypto.subtle.importKey(
    'raw', enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const secret = await crypto.subtle.sign('HMAC', webAppKey, enc.encode(env.TELEGRAM_TOKEN));

  // expected_hash = HMAC_SHA256(key=secret_key, message=data_check_string)
  const secretKey = await crypto.subtle.importKey(
    'raw', secret,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheckString));
  const expectedHash = toHex(new Uint8Array(sig));

  if (!timingSafeEqual(expectedHash, receivedHash.toLowerCase())) return null;

  // Freshness — reject stale/replayed initData
  const authDate = Number(params.get('auth_date') || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > MAX_INITDATA_AGE_SECONDS) return null;

  // Extract the Telegram user
  let tgUser;
  try {
    tgUser = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!tgUser || typeof tgUser.id !== 'number') return null;

  return tgUser;
}

/**
 * Authenticate an API request end-to-end.
 * @returns {Promise<{user, tgUser, admin} | {error: Response}>}
 */
export async function authenticate(request, env) {
  const initData = request.headers.get('X-Telegram-Init-Data') || '';
  const tgUser = await verifyInitData(env, initData);
  if (!tgUser) {
    return { error: errorJson(401, 'احراز هویت ناموفق بود. لطفاً مینی‌اپ را از داخل تلگرام باز کنید.') };
  }

  const user = await upsertUser(env, tgUser);
  if (user?.is_banned) {
    return { error: errorJson(403, 'دسترسی شما مسدود شده است.') };
  }

  const admin = await isAdmin(env, tgUser.id);
  return { user, tgUser, admin };
}

/** Wrap a route handler: inject `auth` as 5th argument or reject with 401/403 */
export function requireAuth(handler) {
  return async (request, env, ctx, params) => {
    const auth = await authenticate(request, env);
    if (auth.error) return auth.error;
    return handler(request, env, ctx, params, auth);
  };
}

/** Same as requireAuth, but only admins pass */
export function requireAdmin(handler) {
  return requireAuth(async (request, env, ctx, params, auth) => {
    if (!auth.admin) return errorJson(403, 'این بخش مخصوص مدیران است.');
    return handler(request, env, ctx, params, auth);
  });
}

/* ── internals ─────────────────────────────────────────────── */

function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Constant-time string compare (both hex, same charset) */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
