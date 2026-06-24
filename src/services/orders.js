/**
 * Orders — purchase, fulfillment, renewal
 * Phase 4 (uses the Phase 5 auto-assignment core in services/vpn.js).
 *
 * Automation guarantee: once an order is PAID (wallet, or admin approval
 * in Phase 6), `fulfillPaidOrder()` does everything — claim account,
 * create subscription, complete order, deliver subscription_url via bot,
 * notify admins. Zero manual delivery.
 */

import { claimAvailableAccount } from './vpn.js';
import { createSubscription, extendSubscription } from './subscriptions.js';
import { notifyUser, notifyAdmins } from '../utils/telegram.js';
import { escapeHtml } from '../utils/helpers.js';

/* ── Order creation ─────────────────────────────────────────── */

/** Insert an order and stamp its SR-YYYY-NNNNNN number */
export async function createOrder(env, { userId, planId, price, method }) {
  const tmp = 'TMP-' + crypto.randomUUID();
  const res = await env.DB
    .prepare(
      `INSERT INTO orders (order_number, user_id, plan_id, price, payment_method)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(tmp, userId, planId, price, method)
    .run();

  const id = res.meta.last_row_id;
  const orderNumber = `SR-${new Date().getUTCFullYear()}-${String(id).padStart(6, '0')}`;

  await env.DB
    .prepare('UPDATE orders SET order_number = ? WHERE id = ?')
    .bind(orderNumber, id)
    .run();

  return { id, orderNumber };
}

export async function setOrderStatus(env, orderId, status) {
  await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, orderId).run();
}

export async function getMyOrders(env, userId, limit = 30) {
  const { results } = await env.DB
    .prepare(
      `SELECT o.id, o.order_number, o.price, o.payment_method, o.status,
              o.created_at, o.paid_at, p.name AS plan_name
       FROM orders o JOIN plans p ON p.id = o.plan_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ?`
    )
    .bind(userId, limit)
    .all();
  return results || [];
}

/* ── Wallet purchase (fully automatic) ──────────────────────── */

export async function purchaseWithWallet(env, user, plan) {
  const order = await createOrder(env, {
    userId: user.id,
    planId: plan.id,
    price: plan.price,
    method: 'wallet',
  });

  // Guarded deduction — never goes below zero, race-safe.
  const deduct = await env.DB
    .prepare('UPDATE users SET wallet = wallet - ?1 WHERE id = ?2 AND wallet >= ?1')
    .bind(plan.price, user.id)
    .run();

  if (!deduct.meta?.changes) {
    await setOrderStatus(env, order.id, 'rejected');
    return { ok: false, error: 'موجودی کیف پول کافی نیست. ابتدا کیف پول خود را شارژ کنید.' };
  }

  await logWalletTx(env, user.id, -plan.price, 'purchase', `خرید ${plan.name} — ${order.orderNumber}`, order.id);

  const fulfilled = await fulfillPaidOrder(env, {
    orderId: order.id,
    orderNumber: order.orderNumber,
    userId: user.id,
    telegramId: user.telegram_id,
    plan,
  });

  if (!fulfilled.ok) {
    // Automatic refund — money never gets stuck.
    await env.DB
      .prepare('UPDATE users SET wallet = wallet + ?1 WHERE id = ?2')
      .bind(plan.price, user.id)
      .run();
    await logWalletTx(env, user.id, plan.price, 'refund', `بازگشت وجه — ${order.orderNumber}`, order.id);
    await setOrderStatus(env, order.id, 'rejected');
    return fulfilled;
  }

  return fulfilled;
}

/* ── Fulfillment (shared with Phase 6 admin approval) ───────── */

/**
 * @param {object} p
 * @param {number}      p.orderId
 * @param {string}      p.orderNumber
 * @param {number}      p.userId
 * @param {string}      p.telegramId
 * @param {object}      p.plan                       plans row
 * @param {number|null} [p.renewalSubscriptionId]    set → renewal instead of new service
 */
export async function fulfillPaidOrder(env, p) {
  /* Renewal: extend the existing subscription, keep the same account */
  if (p.renewalSubscriptionId) {
    const sub = await extendSubscription(env, p.renewalSubscriptionId, p.plan.duration_days);
    if (!sub) return { ok: false, error: 'سرویس موردنظر یافت نشد.' };

    await env.DB
      .prepare(
        `UPDATE orders SET status='completed', paid_at=datetime('now'), vpn_account_id=?1 WHERE id=?2`
      )
      .bind(sub.vpn_account_id, p.orderId)
      .run();

    // keep account usable
    await env.DB
      .prepare(`UPDATE vpn_accounts SET status='assigned' WHERE id=?`)
      .bind(sub.vpn_account_id)
      .run();

    await notifyUser(
      env,
      p.telegramId,
      `♻️ <b>سرویس شما تمدید شد</b>\n\n` +
        `🧾 شماره سفارش: <code>${p.orderNumber}</code>\n` +
        `📦 پلن: ${escapeHtml(p.plan.name)}\n` +
        `📅 انقضای جدید: ${sub.expires_at}`
    );
    await notifyAdmins(env, `♻️ تمدید — <code>${p.orderNumber}</code> — ${escapeHtml(p.plan.name)}`);

    return { ok: true, renewed: true, order_number: p.orderNumber, expires_at: sub.expires_at };
  }

  /* New service: claim an account (retry once for race losers) */
  let account = null;
  for (let i = 0; i < 2 && !account; i++) {
    account = await claimAvailableAccount(env, p.userId, p.orderId);
  }
  if (!account) {
    await notifyAdmins(env, `⚠️ موجودی اکانت VPN تمام شده! سفارش <code>${p.orderNumber}</code> معطل ماند.`);
    return { ok: false, error: 'در حال حاضر ظرفیت تکمیل است. لطفاً کمی بعد دوباره تلاش کنید.' };
  }

  const sub = await createSubscription(env, {
    userId: p.userId,
    orderId: p.orderId,
    vpnAccountId: account.id,
    planId: p.plan.id,
    durationDays: p.plan.duration_days,
  });

  await env.DB
    .prepare(
      `UPDATE orders SET status='completed', paid_at=datetime('now'), vpn_account_id=?1 WHERE id=?2`
    )
    .bind(account.id, p.orderId)
    .run();

  // Delivery — ONLY the subscription_url, never the other fields.
  await notifyUser(
    env,
    p.telegramId,
    `🎉 <b>سرویس شما فعال شد</b>\n\n` +
      `🧾 شماره سفارش: <code>${p.orderNumber}</code>\n` +
      `📦 پلن: ${escapeHtml(p.plan.name)}\n` +
      `📅 انقضا: ${sub.expires_at}\n\n` +
      `🔗 لینک اشتراک شما:\n<code>${escapeHtml(account.subscription_url)}</code>\n\n` +
      `همین لینک را در اپلیکیشن خود وارد کنید.`
  );
  await notifyAdmins(
    env,
    `🛒 فروش جدید — <code>${p.orderNumber}</code> — ${escapeHtml(p.plan.name)} (${p.plan.price.toLocaleString('fa-IR')} تومان)`
  );

  return {
    ok: true,
    order_number: p.orderNumber,
    subscription_url: account.subscription_url,
    expires_at: sub.expires_at,
  };
}

/* ── shared tx logger ───────────────────────────────────────── */

export async function logWalletTx(env, userId, amount, type, description, orderId = null) {
  await env.DB
    .prepare(
      `INSERT INTO wallet_transactions (user_id, amount, type, description, order_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(userId, amount, type, description, orderId)
    .run();
}
