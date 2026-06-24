/**
 * Subscriptions
 * Phase 4: create / list / extend + scheduled expiry job.
 */

import { daysRemaining } from '../utils/dates.js';

export async function createSubscription(env, { userId, orderId, vpnAccountId, planId, durationDays }) {
  const res = await env.DB
    .prepare(
      `INSERT INTO subscriptions (user_id, order_id, vpn_account_id, plan_id, status, expires_at)
       VALUES (?1, ?2, ?3, ?4, 'active', datetime('now', '+' || ?5 || ' days'))`
    )
    .bind(userId, orderId, vpnAccountId, planId, Number(durationDays))
    .run();

  return env.DB
    .prepare('SELECT * FROM subscriptions WHERE id = ?')
    .bind(res.meta.last_row_id)
    .first();
}

/**
 * Customer view of their services.
 * NOTE: selects ONLY v.subscription_url from vpn_accounts — never
 * email / password / dashboard_url (admin-only fields).
 */
export async function getMyServices(env, userId) {
  const { results } = await env.DB
    .prepare(
      `SELECT s.id, s.status, s.started_at, s.expires_at,
              o.order_number, o.created_at AS purchased_at,
              p.name AS plan_name, p.duration_days, p.price AS plan_price,
              v.subscription_url
       FROM subscriptions s
       JOIN orders        o ON o.id = s.order_id
       JOIN plans         p ON p.id = s.plan_id
       JOIN vpn_accounts  v ON v.id = s.vpn_account_id
       WHERE s.user_id = ?
       ORDER BY s.id DESC`
    )
    .bind(userId)
    .all();

  return (results || []).map((s) => ({
    ...s,
    remaining_days: s.status === 'active' ? daysRemaining(s.expires_at) : 0,
    is_active: s.status === 'active' && daysRemaining(s.expires_at) > 0,
  }));
}

/** Load one subscription, enforcing ownership */
export function getOwnedSubscription(env, subscriptionId, userId) {
  return env.DB
    .prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?')
    .bind(subscriptionId, userId)
    .first();
}

/**
 * Extend by N days from max(now, current expiry) and re-activate.
 * (ISO datetime strings compare correctly as text in SQLite.)
 */
export async function extendSubscription(env, subscriptionId, days) {
  await env.DB
    .prepare(
      `UPDATE subscriptions
       SET expires_at = datetime(MAX(expires_at, datetime('now')), '+' || ?1 || ' days'),
           status = 'active'
       WHERE id = ?2`
    )
    .bind(Number(days), subscriptionId)
    .run();

  return env.DB
    .prepare('SELECT * FROM subscriptions WHERE id = ?')
    .bind(subscriptionId)
    .first();
}

/* ── Cron job (wired in src/index.js scheduled handler) ─────── */

export async function runScheduledJobs(env) {
  // 1) expire overdue subscriptions
  const expired = await env.DB
    .prepare(
      `UPDATE subscriptions
       SET status = 'expired'
       WHERE status = 'active' AND expires_at < datetime('now')`
    )
    .run();

  // 2) mark their VPN accounts as expired (admin recycles/disables them)
  await env.DB
    .prepare(
      `UPDATE vpn_accounts
       SET status = 'expired'
       WHERE status = 'assigned'
         AND id IN (SELECT vpn_account_id FROM subscriptions WHERE status = 'expired')`
    )
    .run();

  if (expired.meta?.changes) {
    console.log(`[cron] expired ${expired.meta.changes} subscription(s)`);
  }
}
