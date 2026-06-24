/**
 * Mini App REST API router
 * Phase 4: plans, purchase, wallet, my-services, renewal.
 * (Phase 3: /api/me · Phases 6–7 add admin & tickets.)
 */

import { json, errorJson, readJson } from './utils/helpers.js';
import { requireAuth, requireAdmin } from './auth.js';
import {
  createOrder,
  purchaseWithWallet,
  getMyOrders,
  logWalletTx,
  fulfillPaidOrder,
} from './services/orders.js';
import { getWalletInfo, requestRecharge, getCardInfo } from './services/wallet.js';
import { getMyServices, getOwnedSubscription } from './services/subscriptions.js';
import * as Admin from './services/admin.js';
import * as Tickets from './services/tickets.js';
import { getSetting, setSetting } from './database.js';

/* ═══ Phase 3 ═══════════════════════════════════════════════ */

const getMe = requireAuth(async (request, env, ctx, params, { user, admin }) =>
  json({
    ok: true,
    user: {
      id: user.id,
      telegram_id: user.telegram_id,
      username: user.username,
      full_name: user.full_name,
      wallet: user.wallet,
      is_admin: admin,
      created_at: user.created_at,
    },
  })
);

/* ═══ Phase 4 — Plans ═══════════════════════════════════════ */

const listPlans = requireAuth(async (request, env) => {
  const { results } = await env.DB
    .prepare(
      `SELECT id, name, description, price, duration_days, is_unlimited, gb_limit
       FROM plans WHERE is_active = 1 ORDER BY price ASC`
    )
    .all();
  return json({ ok: true, plans: results || [] });
});

/* ═══ Phase 4 — Purchase ════════════════════════════════════ */

const WARNING_TEXT =
  'سرویس ممکن است در زمان قطعی سراسری اینترنت، جنگ، اختلال زیرساخت یا فیلترینگ شدید از دسترس خارج شود.';

const createPurchase = requireAuth(async (request, env, ctx, params, { user }) => {
  const body = await readJson(request);
  if (!body) return errorJson(400, 'بدنه درخواست نامعتبر است.');

  const planId = Math.trunc(Number(body.plan_id));
  const method = body.method;

  if (!Number.isFinite(planId) || planId <= 0) return errorJson(400, 'پلن انتخاب نشده است.');
  if (method !== 'wallet' && method !== 'card') return errorJson(400, 'روش پرداخت نامعتبر است.');
  if (body.accepted !== true) {
    return errorJson(400, 'برای ادامه باید شرایط استفاده را بپذیرید.', { warning: WARNING_TEXT });
  }

  const plan = await env.DB
    .prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1')
    .bind(planId)
    .first();
  if (!plan) return errorJson(404, 'پلن موردنظر یافت نشد.');

  /* wallet → fully automatic purchase + delivery */
  if (method === 'wallet') {
    const result = await purchaseWithWallet(env, user, plan);
    if (!result.ok) return errorJson(400, result.error);
    return json({ ok: true, ...result });
  }

  /* card-to-card → order + await receipt photo in the bot */
  const order = await createOrder(env, {
    userId: user.id,
    planId: plan.id,
    price: plan.price,
    method: 'card',
  });

  await env.KV.put(
    `awaiting_receipt:${user.telegram_id}`,
    JSON.stringify({ type: 'order', orderId: order.id, amount: plan.price }),
    { expirationTtl: 3600 }
  );

  const card = await getCardInfo(env);
  return json({
    ok: true,
    order_number: order.orderNumber,
    amount: plan.price,
    ...card,
    instructions:
      'مبلغ را کارت‌به‌کارت کنید و سپس «عکس رسید» را در چت ربات ارسال نمایید. پس از تأیید ادمین، سرویس به‌صورت خودکار فعال و ارسال می‌شود.',
  });
});

/* ═══ Phase 4 — Wallet ══════════════════════════════════════ */

const getWallet = requireAuth(async (request, env, ctx, params, { user }) =>
  json({ ok: true, ...(await getWalletInfo(env, user.id)) })
);

const postRecharge = requireAuth(async (request, env, ctx, params, { user }) => {
  const body = await readJson(request);
  if (!body) return errorJson(400, 'بدنه درخواست نامعتبر است.');
  const result = await requestRecharge(env, user, body.amount);
  if (!result.ok) return errorJson(400, result.error);
  return json(result);
});

/* ═══ Phase 4 — My services / orders ════════════════════════ */

const myServices = requireAuth(async (request, env, ctx, params, { user }) =>
  json({ ok: true, services: await getMyServices(env, user.id) })
);

const myOrders = requireAuth(async (request, env, ctx, params, { user }) =>
  json({ ok: true, orders: await getMyOrders(env, user.id) })
);

/* ═══ Phase 4 — Renewal ═════════════════════════════════════ */

const renewService = requireAuth(async (request, env, ctx, params, { user }) => {
  const body = await readJson(request);
  if (!body) return errorJson(400, 'بدنه درخواست نامعتبر است.');

  const subId = Math.trunc(Number(body.subscription_id));
  const method = body.method;
  if (!Number.isFinite(subId) || subId <= 0) return errorJson(400, 'سرویس انتخاب نشده است.');
  if (method !== 'wallet' && method !== 'card') return errorJson(400, 'روش پرداخت نامعتبر است.');

  const sub = await getOwnedSubscription(env, subId, user.id);
  if (!sub) return errorJson(404, 'سرویس موردنظر یافت نشد.');

  const plan = await env.DB
    .prepare('SELECT * FROM plans WHERE id = ?')
    .bind(sub.plan_id)
    .first();
  if (!plan || !plan.is_active) return errorJson(400, 'این پلن دیگر قابل تمدید نیست.');

  /* wallet renewal — automatic */
  if (method === 'wallet') {
    const order = await createOrder(env, {
      userId: user.id,
      planId: plan.id,
      price: plan.price,
      method: 'wallet',
    });

    const deduct = await env.DB
      .prepare('UPDATE users SET wallet = wallet - ?1 WHERE id = ?2 AND wallet >= ?1')
      .bind(plan.price, user.id)
      .run();
    if (!deduct.meta?.changes) {
      await env.DB.prepare("UPDATE orders SET status='rejected' WHERE id=?").bind(order.id).run();
      return errorJson(400, 'موجودی کیف پول کافی نیست.');
    }
    await logWalletTx(env, user.id, -plan.price, 'purchase', `تمدید ${plan.name} — ${order.orderNumber}`, order.id);

    const result = await fulfillPaidOrder(env, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      userId: user.id,
      telegramId: user.telegram_id,
      plan,
      renewalSubscriptionId: sub.id,
    });
    if (!result.ok) return errorJson(400, result.error);
    return json({ ok: true, ...result });
  }

  /* card renewal — order + receipt; Phase 6 approval reads order_meta */
  const order = await createOrder(env, {
    userId: user.id,
    planId: plan.id,
    price: plan.price,
    method: 'card',
  });

  await env.KV.put(
    `awaiting_receipt:${user.telegram_id}`,
    JSON.stringify({ type: 'order', orderId: order.id, amount: plan.price }),
    { expirationTtl: 3600 }
  );
  // Renewal marker for the Phase 6 approval handler:
  await env.KV.put(
    `order_meta:${order.id}`,
    JSON.stringify({ renewal_subscription_id: sub.id }),
    { expirationTtl: 7 * 24 * 3600 }
  );

  const card = await getCardInfo(env);
  return json({
    ok: true,
    order_number: order.orderNumber,
    amount: plan.price,
    ...card,
    instructions:
      'مبلغ را کارت‌به‌کارت کنید و عکس رسید را در چت ربات ارسال نمایید. پس از تأیید، سرویس شما به‌صورت خودکار تمدید می‌شود.',
  });
});

/* ═══ Phase 6 — Admin ═══════════════════════════════════════ */

const okOr400 = (r) => (r.ok ? json(r) : errorJson(400, r.error));

const adminStats = requireAdmin(async (request, env) =>
  json({ ok: true, stats: await Admin.getStats(env) })
);

const adminSearchUsers = requireAdmin(async (request, env) => {
  const q = new URL(request.url).searchParams.get('q') || '';
  if (q.trim().length < 2) return errorJson(400, 'حداقل ۲ کاراکتر برای جستجو لازم است.');
  return json({ ok: true, users: await Admin.searchUsers(env, q) });
});

const adminUserProfile = requireAdmin(async (request, env, ctx, params) => {
  const profile = await Admin.getUserProfile(env, Number(params[0]));
  if (!profile) return errorJson(404, 'کاربر یافت نشد.');
  return json({ ok: true, ...profile });
});

const adminWalletAdjust = requireAdmin(async (request, env, ctx, params, { user }) => {
  const body = await readJson(request);
  return okOr400(await Admin.adjustWallet(env, Number(params[0]), body?.amount, body?.note, user.id));
});

const adminBanUser = requireAdmin(async (request, env, ctx, params) => {
  const body = await readJson(request);
  return okOr400(await Admin.setBanned(env, Number(params[0]), body?.banned === true));
});

const adminMessageUser = requireAdmin(async (request, env, ctx, params) => {
  const body = await readJson(request);
  const text = String(body?.text || '').trim();
  if (!text || text.length > 3500) return errorJson(400, 'متن پیام نامعتبر است.');
  return okOr400(await Admin.messageUser(env, Number(params[0]), text));
});

const adminReceipts = requireAdmin(async (request, env) =>
  json({ ok: true, receipts: await Admin.listPendingReceipts(env) })
);

const adminApproveReceipt = requireAdmin(async (request, env, ctx, params, { user }) =>
  okOr400(await Admin.approveReceipt(env, Number(params[0]), user.id))
);

const adminRejectReceipt = requireAdmin(async (request, env, ctx, params, { user }) =>
  okOr400(await Admin.rejectReceipt(env, Number(params[0]), user.id))
);

const adminRefulfill = requireAdmin(async (request, env, ctx, params) =>
  okOr400(await Admin.refulfillOrder(env, Number(params[0])))
);

const adminListPlans = requireAdmin(async (request, env) =>
  json({ ok: true, plans: await Admin.listAllPlans(env) })
);
const adminCreatePlan = requireAdmin(async (request, env) =>
  okOr400(await Admin.createPlan(env, await readJson(request)))
);
const adminUpdatePlan = requireAdmin(async (request, env, ctx, params) =>
  okOr400(await Admin.updatePlan(env, Number(params[0]), await readJson(request)))
);
const adminDeletePlan = requireAdmin(async (request, env, ctx, params) =>
  okOr400(await Admin.deletePlan(env, Number(params[0])))
);

const adminListVpn = requireAdmin(async (request, env) => {
  const status = new URL(request.url).searchParams.get('status') || '';
  return json({ ok: true, accounts: await Admin.listVpnAccounts(env, status) });
});
const adminAddVpn = requireAdmin(async (request, env) =>
  okOr400(await Admin.addVpnAccount(env, await readJson(request)))
);
const adminBulkVpn = requireAdmin(async (request, env) => {
  const body = await readJson(request);
  return okOr400(await Admin.bulkImportVpnAccounts(env, body?.text));
});
const adminUpdateVpn = requireAdmin(async (request, env, ctx, params) =>
  okOr400(await Admin.updateVpnAccount(env, Number(params[0]), await readJson(request)))
);
const adminVpnStatus = requireAdmin(async (request, env, ctx, params) => {
  const body = await readJson(request);
  return okOr400(await Admin.setVpnAccountStatus(env, Number(params[0]), body?.status));
});
const adminDeleteVpn = requireAdmin(async (request, env, ctx, params) =>
  okOr400(await Admin.deleteVpnAccount(env, Number(params[0])))
);

const adminExtendSub = requireAdmin(async (request, env, ctx, params) => {
  const body = await readJson(request);
  return okOr400(await Admin.adminExtendSubscription(env, Number(params[0]), body?.days));
});
const adminDisableSub = requireAdmin(async (request, env, ctx, params) =>
  okOr400(await Admin.adminDisableSubscription(env, Number(params[0])))
);

const adminGetSettings = requireAdmin(async (request, env) =>
  json({
    ok: true,
    settings: {
      card_number: (await getSetting(env, 'card_number')) || '',
      card_owner: (await getSetting(env, 'card_owner')) || '',
      channel_id: (await getSetting(env, 'channel_id')) || '',
    },
  })
);

const adminPutSettings = requireAdmin(async (request, env) => {
  const body = await readJson(request);
  if (!body) return errorJson(400, 'بدنه درخواست نامعتبر است.');
  const allowed = ['card_number', 'card_owner', 'channel_id'];
  for (const key of allowed) {
    if (key in body) await setSetting(env, key, String(body[key]).slice(0, 200));
  }
  return json({ ok: true });
});

const adminBroadcast = requireAdmin(async (request, env) => {
  const body = await readJson(request);
  const text = String(body?.text || '').trim();
  if (!text || text.length > 3500) return errorJson(400, 'متن پیام نامعتبر است.');
  return json(await Admin.runBroadcast(env, text, body?.reset === true));
});

/* ═══ Phase 7 — Tickets ═════════════════════════════════════ */

const myTickets = requireAuth(async (request, env, ctx, params, { user }) =>
  json({
    ok: true,
    subjects: Tickets.TICKET_SUBJECTS,
    tickets: await Tickets.getMyTickets(env, user.id),
  })
);

const createTicket = requireAuth(async (request, env, ctx, params, { user }) => {
  const body = await readJson(request);
  return okOr400(await Tickets.createTicket(env, user, body?.subject, body?.message));
});

const getMyTicket = requireAuth(async (request, env, ctx, params, { user }) => {
  const t = await Tickets.getTicket(env, Number(params[0]), { userId: user.id });
  if (!t) return errorJson(404, 'تیکت یافت نشد.');
  return json({ ok: true, ...t });
});

const replyMyTicket = requireAuth(async (request, env, ctx, params, { user }) => {
  const body = await readJson(request);
  return okOr400(await Tickets.addUserMessage(env, user, Number(params[0]), body?.message));
});

const adminTickets = requireAdmin(async (request, env) => {
  const status = new URL(request.url).searchParams.get('status') || '';
  return json({ ok: true, tickets: await Tickets.listTicketsAdmin(env, status) });
});

const adminGetTicket = requireAdmin(async (request, env, ctx, params) => {
  const t = await Tickets.getTicket(env, Number(params[0]));
  if (!t) return errorJson(404, 'تیکت یافت نشد.');
  return json({ ok: true, ...t });
});

const adminReplyTicket = requireAdmin(async (request, env, ctx, params, { user }) => {
  const body = await readJson(request);
  return okOr400(await Tickets.adminReply(env, user, Number(params[0]), body?.message));
});

const adminCloseTicket = requireAdmin(async (request, env, ctx, params) =>
  okOr400(await Tickets.closeTicket(env, Number(params[0])))
);

/* ═══ Route table ═══════════════════════════════════════════ */

const ROUTES = [
  { method: 'GET',  pattern: /^\/api\/me$/,              handler: getMe },
  { method: 'GET',  pattern: /^\/api\/plans$/,           handler: listPlans },
  { method: 'POST', pattern: /^\/api\/purchase$/,        handler: createPurchase },
  { method: 'GET',  pattern: /^\/api\/wallet$/,          handler: getWallet },
  { method: 'POST', pattern: /^\/api\/wallet\/recharge$/, handler: postRecharge },
  { method: 'GET',  pattern: /^\/api\/services$/,        handler: myServices },
  { method: 'POST', pattern: /^\/api\/services\/renew$/, handler: renewService },
  { method: 'GET',  pattern: /^\/api\/orders$/,          handler: myOrders },

  // ── Phase 6: admin ─────────────────────────────────────────
  { method: 'GET',    pattern: /^\/api\/admin\/stats$/,                    handler: adminStats },
  { method: 'GET',    pattern: /^\/api\/admin\/users$/,                    handler: adminSearchUsers },
  { method: 'GET',    pattern: /^\/api\/admin\/users\/(\d+)$/,             handler: adminUserProfile },
  { method: 'POST',   pattern: /^\/api\/admin\/users\/(\d+)\/wallet$/,     handler: adminWalletAdjust },
  { method: 'POST',   pattern: /^\/api\/admin\/users\/(\d+)\/ban$/,        handler: adminBanUser },
  { method: 'POST',   pattern: /^\/api\/admin\/users\/(\d+)\/message$/,    handler: adminMessageUser },
  { method: 'GET',    pattern: /^\/api\/admin\/receipts$/,                 handler: adminReceipts },
  { method: 'POST',   pattern: /^\/api\/admin\/receipts\/(\d+)\/approve$/, handler: adminApproveReceipt },
  { method: 'POST',   pattern: /^\/api\/admin\/receipts\/(\d+)\/reject$/,  handler: adminRejectReceipt },
  { method: 'POST',   pattern: /^\/api\/admin\/orders\/(\d+)\/fulfill$/,   handler: adminRefulfill },
  { method: 'GET',    pattern: /^\/api\/admin\/plans$/,                    handler: adminListPlans },
  { method: 'POST',   pattern: /^\/api\/admin\/plans$/,                    handler: adminCreatePlan },
  { method: 'PUT',    pattern: /^\/api\/admin\/plans\/(\d+)$/,             handler: adminUpdatePlan },
  { method: 'DELETE', pattern: /^\/api\/admin\/plans\/(\d+)$/,             handler: adminDeletePlan },
  { method: 'GET',    pattern: /^\/api\/admin\/vpn$/,                      handler: adminListVpn },
  { method: 'POST',   pattern: /^\/api\/admin\/vpn$/,                      handler: adminAddVpn },
  { method: 'POST',   pattern: /^\/api\/admin\/vpn\/bulk$/,                handler: adminBulkVpn },
  { method: 'PUT',    pattern: /^\/api\/admin\/vpn\/(\d+)$/,               handler: adminUpdateVpn },
  { method: 'POST',   pattern: /^\/api\/admin\/vpn\/(\d+)\/status$/,       handler: adminVpnStatus },
  { method: 'DELETE', pattern: /^\/api\/admin\/vpn\/(\d+)$/,               handler: adminDeleteVpn },
  { method: 'POST',   pattern: /^\/api\/admin\/subscriptions\/(\d+)\/extend$/,  handler: adminExtendSub },
  { method: 'POST',   pattern: /^\/api\/admin\/subscriptions\/(\d+)\/disable$/, handler: adminDisableSub },
  { method: 'GET',    pattern: /^\/api\/admin\/settings$/,                 handler: adminGetSettings },
  { method: 'PUT',    pattern: /^\/api\/admin\/settings$/,                 handler: adminPutSettings },
  { method: 'POST',   pattern: /^\/api\/admin\/broadcast$/,                handler: adminBroadcast },

  // ── Phase 7: tickets ───────────────────────────────────────
  { method: 'GET',  pattern: /^\/api\/tickets$/,                       handler: myTickets },
  { method: 'POST', pattern: /^\/api\/tickets$/,                       handler: createTicket },
  { method: 'GET',  pattern: /^\/api\/tickets\/(\d+)$/,                handler: getMyTicket },
  { method: 'POST', pattern: /^\/api\/tickets\/(\d+)\/messages$/,      handler: replyMyTicket },
  { method: 'GET',  pattern: /^\/api\/admin\/tickets$/,                handler: adminTickets },
  { method: 'GET',  pattern: /^\/api\/admin\/tickets\/(\d+)$/,         handler: adminGetTicket },
  { method: 'POST', pattern: /^\/api\/admin\/tickets\/(\d+)\/reply$/,  handler: adminReplyTicket },
  { method: 'POST', pattern: /^\/api\/admin\/tickets\/(\d+)\/close$/,  handler: adminCloseTicket },
];

export async function handleApiRequest(request, env, ctx) {
  const url = new URL(request.url);

  for (const route of ROUTES) {
    if (route.method !== request.method) continue;
    const match = url.pathname.match(route.pattern);
    if (!match) continue;

    try {
      return await route.handler(request, env, ctx, match.slice(1));
    } catch (err) {
      console.error(`[api] ${request.method} ${url.pathname} failed:`, err?.stack || err);
      return errorJson(500, 'خطای داخلی سرور');
    }
  }

  return errorJson(404, 'مسیر یافت نشد');
}
