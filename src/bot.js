/**
 * Telegram Bot — webhook update handler
 * Phase 2: /start, Mini App button, admin detection
 * Phase 4: receipt photo capture (orders + wallet recharge)
 * Phase 6 will wire the rcpt:approve / rcpt:reject callbacks.
 */

import { json, escapeHtml } from './utils/helpers.js';
import {
  sendMessage,
  answerCallbackQuery,
  notifyAdminsPhoto,
  editMessageCaption,
} from './utils/telegram.js';
import { upsertUser, isAdmin } from './database.js';
import { approveReceipt, rejectReceipt } from './services/admin.js';

export async function handleTelegramWebhook(update, env, ctx) {
  try {
    if (update.message) {
      await handleMessage(update.message, env, ctx);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query, env, ctx);
    }
  } catch (err) {
    console.error('[bot] update failed:', err?.stack || err);
  }
  return json({ ok: true }); // always ACK — no Telegram retry loops
}

/* ── Messages ───────────────────────────────────────────────── */

async function handleMessage(msg, env, ctx) {
  const from = msg.from;
  if (!from || from.is_bot) return;
  if (msg.chat?.type !== 'private') return;

  const user = await upsertUser(env, from);
  if (user?.is_banned) return;

  // Receipt photos (Phase 4)
  if (Array.isArray(msg.photo) && msg.photo.length) {
    return handleReceiptPhoto(msg, env, user);
  }

  const text = (msg.text || '').trim();
  if (text.startsWith('/start')) {
    return sendWelcome(env, from);
  }

  return sendMessage(
    env,
    msg.chat.id,
    'برای خرید سرویس، مشاهده سرویس‌ها و کیف پول، از دکمه زیر وارد شوید 👇',
    { reply_markup: await mainKeyboard(env, from.id) }
  );
}

async function sendWelcome(env, from) {
  const name = escapeHtml(from.first_name || 'دوست عزیز');
  const text =
    `سلام ${name} 👋\n\n` +
    `به <b>جاده ابریشم</b> خوش آمدید.\n\n` +
    `از طریق دکمه زیر می‌توانید:\n` +
    `🛒 سرویس جدید خریداری کنید\n` +
    `📦 سرویس‌های فعال خود را مدیریت کنید\n` +
    `💳 کیف پول خود را شارژ کنید\n` +
    `🎫 با پشتیبانی در ارتباط باشید`;

  return sendMessage(env, from.id, text, {
    reply_markup: await mainKeyboard(env, from.id),
  });
}

async function mainKeyboard(env, telegramId) {
  const url = env.MINIAPP_URL;
  const rows = [[{ text: '🛍 ورود به فروشگاه', web_app: { url } }]];
  if (await isAdmin(env, telegramId)) {
    rows.push([{ text: '⚙️ پنل ادمین', web_app: { url: `${url}#admin` } }]);
  }
  return { inline_keyboard: rows };
}

/* ── Receipt photos (Phase 4) ───────────────────────────────── */

async function handleReceiptPhoto(msg, env, user) {
  const stateKey = `awaiting_receipt:${user.telegram_id}`;
  const raw = await env.KV.get(stateKey);

  if (!raw) {
    return sendMessage(
      env,
      msg.chat.id,
      'سفارش یا درخواست شارژی در انتظار رسید ندارید.\nابتدا از داخل فروشگاه، خرید یا شارژ کیف پول را شروع کنید.',
      { reply_markup: await mainKeyboard(env, user.telegram_id) }
    );
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    await env.KV.delete(stateKey);
    return sendMessage(env, msg.chat.id, 'خطا در پردازش. لطفاً فرایند را از ابتدا شروع کنید.');
  }

  // Highest-resolution photo
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  const res = await env.DB
    .prepare(
      `INSERT INTO payment_receipts (user_id, order_id, type, telegram_file_id, amount)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(user.id, state.orderId ?? null, state.type, fileId, state.amount ?? null)
    .run();
  const receiptId = res.meta.last_row_id;

  if (state.type === 'order' && state.orderId) {
    await env.DB
      .prepare(`UPDATE orders SET status='pending_approval' WHERE id=? AND user_id=?`)
      .bind(state.orderId, user.id)
      .run();
  }

  await env.KV.delete(stateKey);

  await sendMessage(
    env,
    msg.chat.id,
    '🧾 رسید شما دریافت شد و برای بررسی به ادمین ارسال گردید.\nپس از تأیید، به‌صورت خودکار اطلاع‌رسانی می‌شود.'
  );

  // Forward to admins with approve/reject buttons (executed in Phase 6)
  const typeLabel =
    state.type === 'wallet' ? 'شارژ کیف پول' : 'خرید / تمدید سرویس';
  const amountLabel = state.amount
    ? `${Number(state.amount).toLocaleString('fa-IR')} تومان`
    : '—';

  let orderLine = '';
  if (state.orderId) {
    const order = await env.DB
      .prepare('SELECT order_number FROM orders WHERE id = ?')
      .bind(state.orderId)
      .first();
    if (order) orderLine = `\n🧾 سفارش: <code>${order.order_number}</code>`;
  }

  const caption =
    `🧾 <b>رسید جدید</b>\n\n` +
    `نوع: ${typeLabel}\n` +
    `👤 ${escapeHtml(user.full_name || '')} ${user.username ? '(@' + escapeHtml(user.username) + ')' : ''}\n` +
    `🆔 <code>${user.telegram_id}</code>\n` +
    `💰 مبلغ: ${amountLabel}` +
    orderLine;

  await notifyAdminsPhoto(env, fileId, caption, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ تأیید', callback_data: `rcpt:approve:${receiptId}` },
          { text: '❌ رد', callback_data: `rcpt:reject:${receiptId}` },
        ],
      ],
    },
  });
}

/* ── Callback queries (Phase 6: approve / reject) ───────────── */

async function handleCallback(cb, env, ctx) {
  const data = cb.data || '';

  if (data.startsWith('rcpt:')) {
    // Only admins may press these buttons.
    if (!(await isAdmin(env, cb.from.id))) {
      return answerCallbackQuery(env, cb.id, 'این عملیات مخصوص مدیران است.', true);
    }

    const [, action, idStr] = data.split(':');
    const receiptId = Math.trunc(Number(idStr));
    if (!receiptId || !['approve', 'reject'].includes(action)) {
      return answerCallbackQuery(env, cb.id, 'داده نامعتبر.', true);
    }

    const adminRow = await upsertUser(env, cb.from);
    const result =
      action === 'approve'
        ? await approveReceipt(env, receiptId, adminRow.id)
        : await rejectReceipt(env, receiptId, adminRow.id);

    await answerCallbackQuery(env, cb.id, result.ok ? result.message : result.error, true);

    // Stamp the receipt message so other admins see it's handled.
    if (result.ok && cb.message) {
      const verdict =
        action === 'approve'
          ? `\n\n✅ <b>تأیید شد</b> توسط ${escapeHtml(cb.from.first_name || 'ادمین')}`
          : `\n\n❌ <b>رد شد</b> توسط ${escapeHtml(cb.from.first_name || 'ادمین')}`;
      await editMessageCaption(
        env,
        cb.message.chat.id,
        cb.message.message_id,
        (cb.message.caption || '') + verdict,
        { reply_markup: { inline_keyboard: [] } }
      );
    }
    return;
  }

  return answerCallbackQuery(env, cb.id);
}
