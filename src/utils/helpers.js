/**
 * Shared helpers — responses & security headers
 * (utils/dates.js arrives in Phase 4, utils/telegram.js in Phase 2)
 */

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // Telegram opens Mini Apps inside its own webview / web.telegram.org iframe.
  'Content-Security-Policy':
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
};

/** JSON success response */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...BASE_SECURITY_HEADERS,
      ...headers,
    },
  });
}

/** JSON error response: { ok:false, error:{ code, message } } */
export function errorJson(status, message, extra = undefined) {
  return json(
    { ok: false, error: { code: status, message, ...(extra ? { extra } : {}) } },
    status
  );
}

/** Clone a Response and attach baseline security headers */
export function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
}

/** Escape user-provided text before embedding in HTML messages */
export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Safe JSON body parse (returns null on bad input) */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
