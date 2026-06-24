/**
 * Telegram Bot API wrapper
 * Phase 2. All bot ↔ Telegram traffic goes through here.
 */

import { getAdminIds } from '../database.js';

const TG_API = 'https://api.telegram.org';

/**
 * Low-level Telegram API call.
 * Never throws — logs and returns the raw API response (or null).
 */
export async function tgCall(env, method, payload = {}) {
  try {
    const res = await fetch(`${TG_API}/bot${env.TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      console.error(`[tg] ${method} failed:`, JSON.stringify(data ?? res.status));
    }
    return data;
  } catch (err) {
    console.error(`[tg] ${method} network error:`, err?.message || err);
    return null;
  }
}

/** Send a text message (HTML parse mode by default) */
export function sendMessage(env, chat_id, text, extra = {}) {
  return tgCall(env, 'sendMessage', {
    chat_id,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

/** Acknowledge an inline-button press (stops the loading spinner) */
export function answerCallbackQuery(env, callback_query_id, text = undefined, show_alert = false) {
  return tgCall(env, 'answerCallbackQuery', {
    callback_query_id,
    ...(text ? { text, show_alert } : {}),
  });
}

/** Edit an existing bot message (used by admin approve/reject flows) */
export function editMessageText(env, chat_id, message_id, text, extra = {}) {
  return tgCall(env, 'editMessageText', {
    chat_id,
    message_id,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

/** Send a photo by Telegram file_id (receipt forwarding) */
export function sendPhoto(env, chat_id, photo, caption = '', extra = {}) {
  return tgCall(env, 'sendPhoto', {
    chat_id,
    photo,
    caption,
    parse_mode: 'HTML',
    ...extra,
  });
}

/** Edit the caption of a photo message (receipt approve/reject result) */
export function editMessageCaption(env, chat_id, message_id, caption, extra = {}) {
  return tgCall(env, 'editMessageCaption', {
    chat_id,
    message_id,
    caption,
    parse_mode: 'HTML',
    ...extra,
  });
}

/** Send a photo (e.g. a payment receipt) to every admin */
export async function notifyAdminsPhoto(env, photo, caption, extra = {}) {
  const adminIds = await getAdminIds(env);
  return Promise.allSettled(
    adminIds.map((id) => sendPhoto(env, id, photo, caption, extra))
  );
}

/* ─────────────────────────────────────────────────────────────
 * Notifications — used by orders / wallet / tickets in Phases 4–7
 * ──────────────────────────────────────────────────────────── */

/** Notify one user by telegram_id */
export function notifyUser(env, telegramId, text, extra = {}) {
  return sendMessage(env, telegramId, text, extra);
}

/** Notify every admin (admin_ids from the settings table) */
export async function notifyAdmins(env, text, extra = {}) {
  const adminIds = await getAdminIds(env);
  const results = await Promise.allSettled(
    adminIds.map((id) => sendMessage(env, id, text, extra))
  );
  return results;
}
