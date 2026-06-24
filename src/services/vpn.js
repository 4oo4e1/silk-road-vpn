/**
 * VPN inventory — automatic assignment
 * Phase 5 core (needed by Phase 4 wallet purchases).
 *
 * ⚠️ SECURITY RULE:
 * worker_email, dashboard_password and dashboard_url are ADMIN-ONLY.
 * Customer-facing code must only ever use `publicView()` / subscription_url.
 */

/**
 * Atomically claim one available account for an order.
 * The WHERE guard makes two concurrent purchases impossible to
 * receive the same account (the second UPDATE matches 0 rows).
 * @returns {Promise<object|null>} the claimed vpn_accounts row, or null if out of stock
 */
export async function claimAvailableAccount(env, userId, orderId) {
  const result = await env.DB
    .prepare(
      `UPDATE vpn_accounts
       SET status = 'assigned',
           assigned_user_id = ?1,
           assigned_order_id = ?2,
           assigned_at = datetime('now')
       WHERE id = (SELECT id FROM vpn_accounts WHERE status = 'available' ORDER BY id LIMIT 1)
         AND status = 'available'`
    )
    .bind(userId, orderId)
    .run();

  if (!result.meta?.changes) return null;

  return env.DB
    .prepare('SELECT * FROM vpn_accounts WHERE assigned_order_id = ?')
    .bind(orderId)
    .first();
}

/** Return an account to the pool (failed payment, admin action, …) */
export async function releaseAccount(env, accountId) {
  await env.DB
    .prepare(
      `UPDATE vpn_accounts
       SET status = 'available',
           assigned_user_id = NULL,
           assigned_order_id = NULL,
           assigned_at = NULL
       WHERE id = ?`
    )
    .bind(accountId)
    .run();
}

export async function countAvailable(env) {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM vpn_accounts WHERE status = 'available'`)
    .first();
  return row?.n ?? 0;
}

/** The ONLY projection of a vpn_accounts row customers may see */
export function publicView(account) {
  return { subscription_url: account.subscription_url };
}
