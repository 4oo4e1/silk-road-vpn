/**
 * Wallet
 * Phase 4: balance, history, recharge requests.
 *
 * Recharge flow:
 *   Mini App → POST /api/wallet/recharge {amount}
 *   → KV state "awaiting_receipt:<telegram_id>" (1h TTL)
 *   → user sends the receipt PHOTO to the bot chat
 *   → bot stores it in payment_receipts and notifies admins
 *   → Phase 6: admin approves → wallet credited automatically
 */

import { getSetting } from '../database.js';

export const RECHARGE_PRESETS = [300_000, 600_000, 1_000_000];
export const MIN_RECHARGE = 50_000;
export const MAX_RECHARGE = 200_000_000;

export async function getWalletInfo(env, userId) {
  const balRow = await env.DB
    .prepare('SELECT wallet FROM users WHERE id = ?')
    .bind(userId)
    .first();

  const { results } = await env.DB
    .prepare(
      `SELECT id, amount, type, description, order_id, created_at
       FROM wallet_transactions
       WHERE user_id = ? ORDER BY id DESC LIMIT 50`
    )
    .bind(userId)
    .all();

  return {
    balance: balRow?.wallet ?? 0,
    presets: RECHARGE_PRESETS,
    transactions: results || [],
  };
}

/** Card details shown to the customer for card-to-card payments */
export async function getCardInfo(env) {
  return {
    card_number: (await getSetting(env, 'card_number')) || '—',
    card_owner: (await getSetting(env, 'card_owner')) || '—',
  };
}

/**
 * Register "this user is about to send a wallet-recharge receipt".
 * The bot consumes this state when the photo arrives.
 */
export async function requestRecharge(env, user, amount) {
  amount = Math.trunc(Number(amount));
  if (!Number.isFinite(amount) || amount < MIN_RECHARGE || amount > MAX_RECHARGE) {
    return { ok: false, error: `مبلغ شارژ باید بین ${MIN_RECHARGE.toLocaleString('fa-IR')} و ${MAX_RECHARGE.toLocaleString('fa-IR')} تومان باشد.` };
  }

  await env.KV.put(
    `awaiting_receipt:${user.telegram_id}`,
    JSON.stringify({ type: 'wallet', amount }),
    { expirationTtl: 3600 }
  );

  const card = await getCardInfo(env);
  return {
    ok: true,
    amount,
    ...card,
    instructions:
      'مبلغ را به کارت بالا واریز کنید، سپس «عکس رسید» را در همین ربات ارسال نمایید. پس از تأیید، کیف پول شما به‌صورت خودکار شارژ می‌شود.',
  };
}
