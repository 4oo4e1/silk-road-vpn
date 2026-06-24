/**
 * Mini App API client (browser)
 * Phase 3. Every request carries Telegram's signed initData so the
 * Worker can verify who is calling. Used by app.js and the Phase 8 UI.
 */

(function () {
  const tg = window.Telegram && window.Telegram.WebApp;

  async function apiFetch(path, options = {}) {
    const initData = tg ? tg.initData : '';

    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
        ...(options.headers || {}),
      },
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON response */
    }

    if (!res.ok) {
      const message =
        (data && data.error && data.error.message) || 'خطای ناشناخته سرور';
      const err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Public surface for the rest of the frontend
  window.API = {
    get: (path) => apiFetch(path),
    post: (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) }),
    put: (path, body) => apiFetch(path, { method: 'PUT', body: JSON.stringify(body || {}) }),
    del: (path) => apiFetch(path, { method: 'DELETE' }),
  };
})();
