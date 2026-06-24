/**
 * Support tickets
 * Phase 7.
 * Notifications: new ticket / user reply → admins · admin reply → user.
 */

import { notifyUser, notifyAdmins } from '../utils/telegram.js';
import { getUserById } from '../database.js';
import { escapeHtml } from '../utils/helpers.js';

export const TICKET_SUBJECTS = [
  'مشکل در اتصال',
  'مشکل پرداخت',
  'تمدید سرویس',
  'سؤال عمومی',
  'سایر',
];

function validMessage(message) {
  const m = String(message || '').trim();
  if (!m || m.length > 2000) return null;
  return m;
}

/* ── User side ──────────────────────────────────────────────── */

export async function createTicket(env, user, subject, message) {
  subject = String(subject || '').trim().slice(0, 100);
  const msg = validMessage(message);
  if (!subject) return { ok: false, error: 'موضوع تیکت را انتخاب کنید.' };
  if (!msg) return { ok: false, error: 'متن پیام نامعتبر است (حداکثر ۲۰۰۰ کاراکتر).' };

  const res = await env.DB
    .prepare(`INSERT INTO tickets (user_id, subject) VALUES (?1, ?2)`)
    .bind(user.id, subject)
    .run();
  const ticketId = res.meta.last_row_id;

  await env.DB
    .prepare(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, message)
       VALUES (?1, 'user', ?2, ?3)`
    )
    .bind(ticketId, user.id, msg)
    .run();

  await notifyAdmins(
    env,
    `🎫 <b>تیکت جدید #${ticketId}</b>\n` +
      `👤 ${escapeHtml(user.full_name || '')} ${user.username ? '(@' + escapeHtml(user.username) + ')' : ''}\n` +
      `📌 ${escapeHtml(subject)}\n\n${escapeHtml(msg.slice(0, 500))}`
  );

  return { ok: true, id: ticketId };
}

export async function getMyTickets(env, userId) {
  const { results } = await env.DB
    .prepare(
      `SELECT t.id, t.subject, t.status, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
       FROM tickets t WHERE t.user_id = ? ORDER BY t.updated_at DESC LIMIT 50`
    )
    .bind(userId)
    .all();
  return results || [];
}

/**
 * Ticket + messages.
 * Pass userId to enforce ownership (user side); omit for admin.
 */
export async function getTicket(env, ticketId, { userId = null } = {}) {
  const ticket = await env.DB
    .prepare(
      `SELECT t.*, u.telegram_id, u.username, u.full_name
       FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`
    )
    .bind(ticketId)
    .first();
  if (!ticket) return null;
  if (userId !== null && ticket.user_id !== userId) return null;

  const { results: messages } = await env.DB
    .prepare(
      `SELECT id, sender_type, message, created_at
       FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC`
    )
    .bind(ticketId)
    .all();

  return { ticket, messages: messages || [] };
}

export async function addUserMessage(env, user, ticketId, message) {
  const msg = validMessage(message);
  if (!msg) return { ok: false, error: 'متن پیام نامعتبر است.' };

  const ticket = await env.DB
    .prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?')
    .bind(ticketId, user.id)
    .first();
  if (!ticket) return { ok: false, error: 'تیکت یافت نشد.' };

  await env.DB
    .prepare(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, message)
       VALUES (?1, 'user', ?2, ?3)`
    )
    .bind(ticketId, user.id, msg)
    .run();
  await env.DB
    .prepare(`UPDATE tickets SET status='open', updated_at=datetime('now') WHERE id=?`)
    .bind(ticketId)
    .run();

  await notifyAdmins(
    env,
    `💬 پاسخ کاربر در تیکت <b>#${ticketId}</b>\n👤 ${escapeHtml(user.full_name || '')}\n\n${escapeHtml(msg.slice(0, 500))}`
  );
  return { ok: true };
}

/* ── Admin side ─────────────────────────────────────────────── */

export async function listTicketsAdmin(env, status) {
  const allowed = ['open', 'answered', 'closed'];
  let sql = `SELECT t.id, t.subject, t.status, t.created_at, t.updated_at,
                    u.telegram_id, u.username, u.full_name
             FROM tickets t JOIN users u ON u.id = t.user_id`;
  if (allowed.includes(status)) sql += ` WHERE t.status='${status}'`;
  sql += ' ORDER BY t.updated_at DESC LIMIT 100';
  const { results } = await env.DB.prepare(sql).all();
  return results || [];
}

export async function adminReply(env, adminUser, ticketId, message) {
  const msg = validMessage(message);
  if (!msg) return { ok: false, error: 'متن پیام نامعتبر است.' };

  const ticket = await env.DB.prepare('SELECT * FROM tickets WHERE id = ?').bind(ticketId).first();
  if (!ticket) return { ok: false, error: 'تیکت یافت نشد.' };

  await env.DB
    .prepare(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, message)
       VALUES (?1, 'admin', ?2, ?3)`
    )
    .bind(ticketId, adminUser.id, msg)
    .run();
  await env.DB
    .prepare(`UPDATE tickets SET status='answered', updated_at=datetime('now') WHERE id=?`)
    .bind(ticketId)
    .run();

  const owner = await getUserById(env, ticket.user_id);
  if (owner) {
    await notifyUser(
      env,
      owner.telegram_id,
      `📩 <b>پاسخ پشتیبانی — تیکت #${ticketId}</b>\n📌 ${escapeHtml(ticket.subject)}\n\n${escapeHtml(msg)}\n\nبرای ادامه گفتگو از بخش پشتیبانی مینی‌اپ استفاده کنید.`
    );
  }
  return { ok: true };
}

export async function closeTicket(env, ticketId) {
  const res = await env.DB
    .prepare(`UPDATE tickets SET status='closed', updated_at=datetime('now') WHERE id=?`)
    .bind(ticketId)
    .run();
  if (!res.meta?.changes) return { ok: false, error: 'تیکت یافت نشد.' };

  const ticket = await env.DB
    .prepare(`SELECT t.*, u.telegram_id FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?`)
    .bind(ticketId)
    .first();
  if (ticket) {
    await notifyUser(env, ticket.telegram_id, `🔒 تیکت #${ticketId} بسته شد. در صورت نیاز، تیکت جدیدی ثبت کنید.`);
  }
  return { ok: true };
}
