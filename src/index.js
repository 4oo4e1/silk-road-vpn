/**
 * ─────────────────────────────────────────────────────────────
 *  Silk Road VPN — Cloudflare Worker Entrypoint
 *  Phase 1: Routing
 *    • POST /webhook        → Telegram bot updates (bot.js)
 *    • *    /api/*          → Mini App REST API (api.js)
 *    • GET  /health         → health check
 *    • everything else      → Mini App static assets (env.ASSETS)
 * ─────────────────────────────────────────────────────────────
 */

import { handleTelegramWebhook } from './bot.js';
import { handleApiRequest } from './api.js';
import { json, errorJson, withSecurityHeaders } from './utils/helpers.js';
import { runScheduledJobs } from './services/subscriptions.js';

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      /* ── 1) Telegram Webhook ─────────────────────────────── */
      if (pathname === '/webhook') {
        if (request.method !== 'POST') {
          return errorJson(405, 'Method Not Allowed');
        }

        // Verify Telegram's secret token header.
        // Set when registering the webhook:
        //   setWebhook?url=...&secret_token=<TELEGRAM_WEBHOOK_SECRET>
        const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
          return errorJson(401, 'Unauthorized');
        }

        let update;
        try {
          update = await request.json();
        } catch {
          return errorJson(400, 'Invalid JSON body');
        }

        // Telegram only needs a fast 200 OK. Errors inside the bot
        // handler must never bubble up, otherwise Telegram retries
        // the same update in a loop.
        try {
          return await handleTelegramWebhook(update, env, ctx);
        } catch (err) {
          console.error('[webhook] handler error:', err?.stack || err);
          return json({ ok: true }); // ACK anyway — never let Telegram retry-loop
        }
      }

      /* ── 2) Mini App REST API ────────────────────────────── */
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (request.method === 'OPTIONS') {
          // Mini App is served from the same origin → same-origin requests.
          // Preflight only answered minimally; no cross-origin allowed.
          return new Response(null, {
            status: 204,
            headers: {
              'Allow': 'GET, POST, PUT, DELETE, OPTIONS',
              'Cache-Control': 'no-store',
            },
          });
        }
        const response = await handleApiRequest(request, env, ctx);
        return withSecurityHeaders(response);
      }

      /* ── 3) Health check ─────────────────────────────────── */
      if (pathname === '/health') {
        return json({ ok: true, service: 'silk-road-vpn', ts: Date.now() });
      }

      /* ── 4) Mini App static assets (SPA) ─────────────────── */
      return await serveMiniApp(request, env);
    } catch (err) {
      console.error('[worker] unhandled error:', err?.stack || err);
      return errorJson(500, 'Internal Server Error');
    }
  },

  /**
   * Cron triggers (wrangler.toml → [triggers].crons)
   * Expires overdue subscriptions and marks their VPN accounts.
   */
  async scheduled(event, env, ctx) {
    console.log('[cron] tick:', new Date(event.scheduledTime).toISOString());
    ctx.waitUntil(runScheduledJobs(env));
  },
};

/* ─────────────────────────────────────────────────────────────
 * Static serving for the Mini App frontend.
 * Requires in wrangler.toml:
 *
 *   [assets]
 *   directory = "src/frontend"
 *   binding = "ASSETS"
 *   not_found_handling = "single-page-application"
 *   run_worker_first = ["/webhook", "/api/*", "/health"]
 * ──────────────────────────────────────────────────────────── */
async function serveMiniApp(request, env) {
  if (!env.ASSETS) {
    return errorJson(
      500,
      'ASSETS binding missing — add the [assets] block to wrangler.toml'
    );
  }

  let res = await env.ASSETS.fetch(request);

  // SPA fallback safety-net (covered by not_found_handling, but cheap)
  if (res.status === 404 && request.method === 'GET') {
    const url = new URL(request.url);
    res = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
  }

  return withSecurityHeaders(res);
}
