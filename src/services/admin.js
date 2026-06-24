/**
 * Admin operations
 * Phase 6.
 *
 * The receipt-approval engine here is shared by BOTH entry points:
 *   • bot inline buttons  (rcpt:approve:<id> / rcpt:reject:<id>)
 *   • Mini App admin API  (POST /api/admin/receipts/:id/approve|reject)
 * Approving an order receipt triggers the same zero-touch fulfillment
 * pipeline as wallet purchases (services/orders.js → fulfillPaidOrder).
 */

import { fulfillPaidOrder, logWalletTx, setOrderStatus } from './orders.js';
import { notifyUser, sendMessage } from '../utils/telegram.js';
import { getUserById } from '../database.js';
import { escapeHtml } from '../utils/helpers.js';

/* ═══ Receipts ══════════════════════════════════════════════ */

export async function approveReceipt(env, receiptId, reviewerUserId) {
  // Race-safe claim: two admins can't approve the same receipt twice.
  const claim = await env.DB
    .prepare(
      `UPDATE payment_receipts
       SET status='approved', reviewed_by=?1, reviewed_at=datetime('now')
       WHERE id=?2 AND status='pending'`
    )
    .bind(reviewerUserId, receiptId)
    .run();
  if (!claim.meta?.changes) return { ok: false, error: 'این رسید قبلاً بررسی شده است.' };

  const receipt = await env.DB
    .prepare('SELECT * FROM payment_receipts WHERE id=?')
    .bind(receiptId)
    .first();
  const user = await getUserById(env, receipt.user_id);
  if (!user) return { ok: false, error: 'کاربر این رسید یافت نشد.' };

  /* wallet recharge */
  if (receipt.type === 'wallet') {
    const amount = Math.trunc(Number(receipt.amount || 0));
    if (amount <= 0) return { ok: false, error: 'مبلغ رسید نامعتبر است.' };

    await env.DB
      .prepare('UPDATE users SET wallet = wallet + ? WHERE id = ?')
      .bind(amount, user.id)
      .run();
    await logWalletTx(env, user.id, amount, 'recharge', `شارژ کیف پول — رسید #${receiptId}`);
    await notifyUser(
      env,
      user.telegram_id,
      `✅ شارژ کیف پول شما به مبلغ <b>${amount.toLocaleString('fa-IR')} تومان</b> تأیید شد.\nاکنون می‌توانید از داخل فروشگاه خرید کنید.`
    );
    return { ok: true, message: 'کیف پول کاربر شارژ شد.' };
  }

  /* order purchase / renewal */
  const order = await env.DB
    .prepare('SELECT * FROM orders WHERE id=?')
    .bind(receipt.order_id)
    .first();
  if (!order) return { ok: false, error: 'سفارش این رسید یافت نشد.' };
  if (order.status === 'completed') return { ok: true, message: 'این سفارش قبلاً تکمیل شده است.' };

  const plan = await env.DB.prepare('SELECT * FROM plans WHERE id=?').bind(order.plan_id).first();
  if (!plan) return { ok: false, error: 'پلن سفارش یافت نشد.' };

  await env.DB
    .prepare(`UPDATE orders SET status='paid', paid_at=datetime('now') WHERE id=?`)
    .bind(order.id)
    .run();

  // Renewal marker stored at order creation (Phase 4)
  let renewalSubscriptionId = null;
  const meta = await env.KV.get(`order_meta:${order.id}`);
  if (meta) {
    try { renewalSubscriptionId = JSON.parse(meta).renewal_subscription_id ?? null; } catch {}
  }

  const result = await fulfillPaidOrder(env, {
    orderId: order.id,
    orderNumber: order.order_number,
    userId: user.id,
    telegramId: user.telegram_id,
    plan,
    renewalSubscriptionId,
  });

  if (!result.ok) {
    // Money is acknowledged (paid) but stock ran out — retry later via
    // POST /api/admin/orders/:id/fulfill after adding accounts.
    return { ok: false, error: result.error + ' — پرداخت ثبت شد؛ پس از افزودن اکانت، از پنل «تکمیل سفارش» را بزنید.' };
  }

  await env.KV.delete(`order_meta:${order.id}`);
  return {
    ok: true,
    message: renewalSubscriptionId ? 'سرویس کاربر تمدید و اطلاع‌رسانی شد.' : 'سرویس واگذار و برای کاربر ارسال شد.',
  };
}

export async function rejectReceipt(env, receiptId, reviewerUserId) {
  const claim = await env.DB
    .prepare(
      `UPDATE payment_receipts
       SET status='rejected', reviewed_by=?1, reviewed_at=datetime('now')
       WHERE id=?2 AND status='pending'`
    )
    .bind(reviewerUserId, receiptId)
    .run();
  if (!claim.meta?.changes) return { ok: false, error: 'این رسید قبلاً بررسی شده است.' };

  const receipt = await env.DB
    .prepare('SELECT * FROM payment_receipts WHERE id=?')
    .bind(receiptId)
    .first();
  const user = await getUserById(env, receipt.user_id);

  if (receipt.order_id) {
    await setOrderStatus(env, receipt.order_id, 'rejected');
    await env.KV.delete(`order_meta:${receipt.order_id}`);
  }

  if (user) {
    await notifyUser(
      env,
      user.telegram_id,
      '❌ رسید پرداخت شما تأیید نشد.\nدر صورت اشتباه، از بخش پشتیبانی پیگیری کنید.'
    );
  }
  return { ok: true, message: 'رسید رد شد و به کاربر اطلاع داده شد.' };
}

/** Retry fulfillment for a paid-but-stuck order (out-of-stock case) */
export async function refulfillOrder(env, orderId) {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!order) return { ok: false, error: 'سفارش یافت نشد.' };
  if (order.status === 'completed') return { ok: false, error: 'سفارش قبلاً تکمیل شده است.' };
  if (order.status !== 'paid') return { ok: false, error: 'فقط سفارش‌های پرداخت‌شده قابل تکمیل هستند.' };

  const user = await getUserById(env, order.user_id);
  const plan = await env.DB.prepare('SELECT * FROM plans WHERE id=?').bind(order.plan_id).first();

  let renewalSubscriptionId = null;
  const meta = await env.KV.get(`order_meta:${orderId}`);
  if (meta) {
    try { renewalSubscriptionId = JSON.parse(meta).renewal_subscription_id ?? null; } catch {}
  }

  const result = await fulfillPaidOrder(env, {
    orderId: order.id,
    orderNumber: order.order_number,
    userId: user.id,
    telegramId: user.telegram_id,
    plan,
    renewalSubscriptionId,
  });
  if (result.ok) await env.KV.delete(`order_meta:${orderId}`);
  return result.ok ? { ok: true, message: 'سفارش تکمیل و ارسال شد.' } : result;
}

export async function listPendingReceipts(env) {
  const { results } = await env.DB
    .prepare(
      `SELECT r.id, r.type, r.amount, r.telegram_file_id, r.created_at,
              r.order_id, o.order_number,
              u.telegram_id, u.username, u.full_name
       FROM payment_receipts r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN orders o ON o.id = r.order_id
       WHERE r.status = 'pending'
       ORDER BY r.id ASC`
    )
    .all();
  return results || [];
}

/* ═══ Dashboard stats ═══════════════════════════════════════ */

export async function getStats(env) {
  const sales = await env.DB
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN paid_at >= datetime('now','start of day')            THEN price END),0) AS today,
         COALESCE(SUM(CASE WHEN paid_at >= datetime('now','-6 days','start of day')  THEN price END),0) AS week,
         COALESCE(SUM(CASE WHEN paid_at >= datetime('now','start of month')          THEN price END),0) AS month,
         COALESCE(SUM(CASE WHEN paid_at >= datetime('now','start of year')           THEN price END),0) AS year,
         COALESCE(SUM(price),0) AS total,
         COUNT(*) AS orders_completed
       FROM orders WHERE status='completed'`
    )
    .first();

  const one = (sql) => env.DB.prepare(sql).first().then((r) => r?.n ?? 0);

  return {
    sales,
    total_users: await one(`SELECT COUNT(*) n FROM users`),
    active_services: await one(`SELECT COUNT(*) n FROM subscriptions WHERE status='active'`),
    expired_services: await one(`SELECT COUNT(*) n FROM subscriptions WHERE status='expired'`),
    pending_receipts: await one(`SELECT COUNT(*) n FROM payment_receipts WHERE status='pending'`),
    stuck_paid_orders: await one(`SELECT COUNT(*) n FROM orders WHERE status='paid'`),
    vpn_available: await one(`SELECT COUNT(*) n FROM vpn_accounts WHERE status='available'`),
    vpn_assigned: await one(`SELECT COUNT(*) n FROM vpn_accounts WHERE status='assigned'`),
  };
}

/* ═══ Users ═════════════════════════════════════════════════ */

export async function searchUsers(env, q) {
  const like = `%${String(q || '').trim()}%`;
  const { results } = await env.DB
    .prepare(
      `SELECT id, telegram_id, username, full_name, wallet, is_banned, created_at
       FROM users
       WHERE telegram_id LIKE ?1 OR username LIKE ?1 OR full_name LIKE ?1
       ORDER BY id DESC LIMIT 20`
    )
    .bind(like)
    .all();
  return results || [];
}

/** Full profile — admin view includes ALL vpn account fields */
export async function getUserProfile(env, userId) {
  const user = await getUserById(env, userId);
  if (!user) return null;

  const { results: orders } = await env.DB
    .prepare(
      `SELECT o.id, o.order_number, o.price, o.payment_method, o.status, o.created_at, o.paid_at,
              p.name AS plan_name
       FROM orders o JOIN plans p ON p.id = o.plan_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 50`
    )
    .bind(userId)
    .all();

  const { results: subscriptions } = await env.DB
    .prepare(
      `SELECT s.id, s.status, s.started_at, s.expires_at,
              p.name AS plan_name, o.order_number,
              v.id AS vpn_id, v.worker_email, v.dashboard_password,
              v.subscription_url, v.dashboard_url
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN orders o ON o.id = s.order_id
       JOIN vpn_accounts v ON v.id = s.vpn_account_id
       WHERE s.user_id = ? ORDER BY s.id DESC`
    )
    .bind(userId)
    .all();

  const { results: transactions } = await env.DB
    .prepare(
      `SELECT id, amount, type, description, created_at
       FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20`
    )
    .bind(userId)
    .all();

  return { user, orders: orders || [], subscriptions: subscriptions || [], transactions: transactions || [] };
}

export async function adjustWallet(env, targetUserId, amount, note, adminUserId) {
  amount = Math.trunc(Number(amount));
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, error: 'مبلغ نامعتبر است.' };

  // Never let the balance go negative.
  const res = await env.DB
    .prepare('UPDATE users SET wallet = wallet + ?1 WHERE id = ?2 AND wallet + ?1 >= 0')
    .bind(amount, targetUserId)
    .run();
  if (!res.meta?.changes) return { ok: false, error: 'موجودی کاربر برای کسر کافی نیست.' };

  const type = amount > 0 ? 'admin_credit' : 'admin_debit';
  await logWalletTx(env, targetUserId, amount, type, note || `تغییر توسط ادمین #${adminUserId}`);

  const user = await getUserById(env, targetUserId);
  await notifyUser(
    env,
    user.telegram_id,
    amount > 0
      ? `💳 مبلغ ${amount.toLocaleString('fa-IR')} تومان به کیف پول شما اضافه شد.`
      : `💳 مبلغ ${Math.abs(amount).toLocaleString('fa-IR')} تومان از کیف پول شما کسر شد.`
  );
  return { ok: true, balance: user.wallet };
}

export async function setBanned(env, targetUserId, banned) {
  await env.DB
    .prepare('UPDATE users SET is_banned = ? WHERE id = ?')
    .bind(banned ? 1 : 0, targetUserId)
    .run();
  return { ok: true };
}

export async function messageUser(env, targetUserId, text) {
  const user = await getUserById(env, targetUserId);
  if (!user) return { ok: false, error: 'کاربر یافت نشد.' };
  const r = await sendMessage(env, user.telegram_id, `📩 <b>پیام از پشتیبانی</b>\n\n${text}`);
  return r?.ok ? { ok: true } : { ok: false, error: 'ارسال پیام ناموفق بود (شاید کاربر ربات را بلاک کرده).' };
}

/* ═══ Plans CRUD ════════════════════════════════════════════ */

export async function listAllPlans(env) {
  const { results } = await env.DB
    .prepare('SELECT * FROM plans ORDER BY is_active DESC, price ASC')
    .all();
  return results || [];
}

function validatePlanBody(b) {
  const name = String(b?.name || '').trim();
  const price = Math.trunc(Number(b?.price));
  const duration = Math.trunc(Number(b?.duration_days));
  if (!name || name.length > 100) return { error: 'نام پلن نامعتبر است.' };
  if (!Number.isFinite(price) || price <= 0) return { error: 'قیمت نامعتبر است.' };
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3650) return { error: 'مدت پلن نامعتبر است.' };
  const gb = b?.gb_limit == null || b.gb_limit === '' ? null : Math.trunc(Number(b.gb_limit));
  return {
    name,
    description: String(b?.description || '').slice(0, 300),
    price,
    duration_days: duration,
    is_unlimited: b?.is_unlimited ? 1 : 0,
    gb_limit: gb,
    is_active: b?.is_active === false ? 0 : 1,
  };
}

export async function createPlan(env, body) {
  const p = validatePlanBody(body);
  if (p.error) return { ok: false, error: p.error };
  const res = await env.DB
    .prepare(
      `INSERT INTO plans (name, description, price, duration_days, is_unlimited, gb_limit, is_active)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    )
    .bind(p.name, p.description, p.price, p.duration_days, p.is_unlimited, p.gb_limit, p.is_active)
    .run();
  return { ok: true, id: res.meta.last_row_id };
}

export async function updatePlan(env, planId, body) {
  const p = validatePlanBody(body);
  if (p.error) return { ok: false, error: p.error };
  const res = await env.DB
    .prepare(
      `UPDATE plans SET name=?1, description=?2, price=?3, duration_days=?4,
                        is_unlimited=?5, gb_limit=?6, is_active=?7
       WHERE id=?8`
    )
    .bind(p.name, p.description, p.price, p.duration_days, p.is_unlimited, p.gb_limit, p.is_active, planId)
    .run();
  return res.meta?.changes ? { ok: true } : { ok: false, error: 'پلن یافت نشد.' };
}

/** Soft delete — orders/subscriptions keep referencing the row */
export async function deletePlan(env, planId) {
  const res = await env.DB.prepare('UPDATE plans SET is_active=0 WHERE id=?').bind(planId).run();
  return res.meta?.changes ? { ok: true } : { ok: false, error: 'پلن یافت نشد.' };
}

/* ═══ VPN inventory ═════════════════════════════════════════ */

export async function listVpnAccounts(env, status) {
  const allowed = ['available', 'assigned', 'expired', 'disabled'];
  let sql = `SELECT v.*, u.telegram_id AS user_telegram_id, u.username AS user_username
             FROM vpn_accounts v LEFT JOIN users u ON u.id = v.assigned_user_id`;
  if (allowed.includes(status)) sql += ` WHERE v.status='${status}'`;
  sql += ' ORDER BY v.id DESC LIMIT 200';
  const { results } = await env.DB.prepare(sql).all();
  return results || [];
}

function validateAccount(a) {
  const email = String(a?.worker_email || '').trim();
  const password = String(a?.dashboard_password || '').trim();
  const sub = String(a?.subscription_url || '').trim();
  const dash = String(a?.dashboard_url || '').trim();
  if (!email || !password) return { error: 'ایمیل/رمز نامعتبر است.' };
  if (!/^https?:\/\//.test(sub) || !/^https?:\/\//.test(dash)) {
    return { error: 'آدرس‌های اشتراک/داشبورد باید با http(s) شروع شوند.' };
  }
  return { email, password, sub, dash };
}

export async function addVpnAccount(env, body) {
  const a = validateAccount(body);
  if (a.error) return { ok: false, error: a.error };
  const res = await env.DB
    .prepare(
      `INSERT INTO vpn_accounts (worker_email, dashboard_password, subscription_url, dashboard_url)
       VALUES (?1,?2,?3,?4)`
    )
    .bind(a.email, a.password, a.sub, a.dash)
    .run();
  return { ok: true, id: res.meta.last_row_id };
}

/**
 * Bulk import — paste blocks of 4 lines per account:
 *   email \n password \n subscription_url \n dashboard_url
 * Blank lines between blocks are ignored.
 */
export async function bulkImportVpnAccounts(env, text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length || lines.length % 4 !== 0) {
    return { ok: false, error: `تعداد خطوط باید مضرب ۴ باشد (الان: ${lines.length}). هر اکانت: ایمیل، رمز، لینک اشتراک، لینک داشبورد.` };
  }

  const stmts = [];
  for (let i = 0; i < lines.length; i += 4) {
    const a = validateAccount({
      worker_email: lines[i],
      dashboard_password: lines[i + 1],
      subscription_url: lines[i + 2],
      dashboard_url: lines[i + 3],
    });
    if (a.error) return { ok: false, error: `بلوک ${i / 4 + 1}: ${a.error}` };
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO vpn_accounts (worker_email, dashboard_password, subscription_url, dashboard_url)
           VALUES (?1,?2,?3,?4)`
        )
        .bind(a.email, a.password, a.sub, a.dash)
    );
  }

  await env.DB.batch(stmts); // transactional — all or nothing
  return { ok: true, imported: stmts.length };
}

export async function updateVpnAccount(env, id, body) {
  const a = validateAccount(body);
  if (a.error) return { ok: false, error: a.error };
  const res = await env.DB
    .prepare(
      `UPDATE vpn_accounts
       SET worker_email=?1, dashboard_password=?2, subscription_url=?3, dashboard_url=?4
       WHERE id=?5`
    )
    .bind(a.email, a.password, a.sub, a.dash, id)
    .run();
  if (!res.meta?.changes) return { ok: false, error: 'اکانت یافت نشد.' };

  // If this account is assigned and the admin asked for it, push the
  // (possibly new) subscription link straight to the customer via the bot.
  if (body?.notify_user === true) {
    const acc = await env.DB
      .prepare(
        `SELECT v.subscription_url, u.telegram_id
         FROM vpn_accounts v
         LEFT JOIN users u ON u.id = v.assigned_user_id
         WHERE v.id = ?`
      )
      .bind(id)
      .first();

    if (acc?.telegram_id) {
      await notifyUser(
        env,
        acc.telegram_id,
        `🔄 <b>به‌روزرسانی سرویس</b>\n\n` +
          `لینک اشتراک سرویس شما به‌روزرسانی شد. لطفاً لینک جدید را در اپلیکیشن خود جایگزین کنید:\n\n` +
          `<code>${escapeHtml(acc.subscription_url)}</code>`
      );
      return { ok: true, notified: true };
    }
  }

  return { ok: true };
}

export async function setVpnAccountStatus(env, id, status) {
  if (!['available', 'disabled'].includes(status)) return { ok: false, error: 'وضعیت نامعتبر است.' };
  const res = await env.DB
    .prepare(`UPDATE vpn_accounts SET status=?1 WHERE id=?2 AND status != 'assigned'`)
    .bind(status, id)
    .run();
  return res.meta?.changes
    ? { ok: true }
    : { ok: false, error: 'اکانت یافت نشد یا در حال استفاده توسط مشتری است.' };
}

export async function deleteVpnAccount(env, id) {
  const res = await env.DB
    .prepare(`DELETE FROM vpn_accounts WHERE id=? AND status='available'`)
    .bind(id)
    .run();
  return res.meta?.changes
    ? { ok: true }
    : { ok: false, error: 'فقط اکانت‌های «آزاد» قابل حذف هستند (برای بقیه از غیرفعال‌سازی استفاده کنید).' };
}

/* ═══ Subscriptions (admin actions) ═════════════════════════ */

export async function adminExtendSubscription(env, subId, days) {
  days = Math.trunc(Number(days));
  if (!Number.isFinite(days) || days <= 0 || days > 3650) return { ok: false, error: 'تعداد روز نامعتبر است.' };

  const res = await env.DB
    .prepare(
      `UPDATE subscriptions
       SET expires_at = datetime(MAX(expires_at, datetime('now')), '+' || ?1 || ' days'), status='active'
       WHERE id = ?2`
    )
    .bind(days, subId)
    .run();
  if (!res.meta?.changes) return { ok: false, error: 'سرویس یافت نشد.' };

  const sub = await env.DB
    .prepare(`SELECT s.*, u.telegram_id FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.id=?`)
    .bind(subId)
    .first();
  await env.DB.prepare(`UPDATE vpn_accounts SET status='assigned' WHERE id=?`).bind(sub.vpn_account_id).run();
  await notifyUser(env, sub.telegram_id, `♻️ سرویس شما توسط پشتیبانی تمدید شد.\n📅 انقضای جدید: ${sub.expires_at}`);
  return { ok: true, expires_at: sub.expires_at };
}

export async function adminDisableSubscription(env, subId) {
  const sub = await env.DB
    .prepare(`SELECT s.*, u.telegram_id FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.id=?`)
    .bind(subId)
    .first();
  if (!sub) return { ok: false, error: 'سرویس یافت نشد.' };

  await env.DB.prepare(`UPDATE subscriptions SET status='disabled' WHERE id=?`).bind(subId).run();
  await env.DB.prepare(`UPDATE vpn_accounts SET status='disabled' WHERE id=?`).bind(sub.vpn_account_id).run();
  await notifyUser(env, sub.telegram_id, '⛔️ سرویس شما توسط پشتیبانی غیرفعال شد. برای پیگیری با پشتیبانی در تماس باشید.');
  return { ok: true };
}

/* ═══ Broadcast ═════════════════════════════════════════════ */

const BROADCAST_BATCH = 30; // Workers free plan: ~50 subrequests/invocation

/**
 * Sends to users in batches; progress survives between calls in KV.
 * The admin UI keeps calling until { done: true }.
 */
export async function runBroadcast(env, text, reset = false) {
  const key = 'broadcast_progress';
  let lastId = 0;
  if (!reset) {
    const v = await env.KV.get(key);
    if (v) lastId = Number(v) || 0;
  }

  const { results } = await env.DB
    .prepare(
      `SELECT id, telegram_id FROM users
       WHERE is_banned = 0 AND id > ? ORDER BY id LIMIT ?`
    )
    .bind(lastId, BROADCAST_BATCH)
    .all();

  let sent = 0;
  for (const u of results || []) {
    const r = await sendMessage(env, u.telegram_id, text);
    if (r?.ok) sent++;
    lastId = u.id;
  }

  const remainRow = await env.DB
    .prepare(`SELECT COUNT(*) n FROM users WHERE is_banned = 0 AND id > ?`)
    .bind(lastId)
    .first();
  const remaining = remainRow?.n ?? 0;

  if (remaining > 0) await env.KV.put(key, String(lastId), { expirationTtl: 3600 });
  else await env.KV.delete(key);

  return { ok: true, sent, remaining, done: remaining === 0 };
}
