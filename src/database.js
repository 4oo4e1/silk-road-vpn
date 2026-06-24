/**
 * D1 database helpers
 * Phase 2: settings, admin detection, users.
 * Later phases add their own queries inside services/*.
 */

/* ── Settings (KV-cached, 60s TTL) ──────────────────────────── */

export async function getSetting(env, key) {
  const cacheKey = `setting:${key}`;

  const cached = await env.KV.get(cacheKey);
  if (cached !== null) return cached;

  const row = await env.DB
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first();

  const value = row?.value ?? null;
  if (value !== null) {
    await env.KV.put(cacheKey, value, { expirationTtl: 60 });
  }
  return value;
}

export async function setSetting(env, key, value) {
  await env.DB
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')`
    )
    .bind(key, String(value))
    .run();
  await env.KV.delete(`setting:${key}`);
}

/* ── Admins ─────────────────────────────────────────────────── */

/** admin_ids is stored in settings as a JSON array of telegram IDs */
export async function getAdminIds(env) {
  const raw = await getSetting(env, 'admin_ids');
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    console.error('[db] settings.admin_ids is not valid JSON');
    return [];
  }
}

export async function isAdmin(env, telegramId) {
  const ids = await getAdminIds(env);
  return ids.includes(String(telegramId));
}

/* ── Users ──────────────────────────────────────────────────── */

/**
 * Create the user on first contact, refresh username/full_name after.
 * @param {object} tgUser  Telegram User object (update.message.from)
 * @returns {Promise<object>} the users row
 */
export async function upsertUser(env, tgUser) {
  const telegramId = String(tgUser.id);
  const username = tgUser.username || null;
  const fullName =
    [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || null;

  await env.DB
    .prepare(
      `INSERT INTO users (telegram_id, username, full_name)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(telegram_id) DO UPDATE SET username = ?2, full_name = ?3`
    )
    .bind(telegramId, username, fullName)
    .run();

  return getUserByTelegramId(env, telegramId);
}

export function getUserByTelegramId(env, telegramId) {
  return env.DB
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .bind(String(telegramId))
    .first();
}

export function getUserById(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}
