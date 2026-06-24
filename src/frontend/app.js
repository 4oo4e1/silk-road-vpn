/**
 * جاده ابریشم — Mini App UI (Phase 8)
 * Hash-routed SPA over window.API (frontend/api.js).
 */

(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  const $boot = document.getElementById('boot');

  const state = {
    user: null,
    plans: [],
    selectedPlan: null,
    adminTab: 'dash',
    adminUserId: null,
    editPlan: null,
  };

  /* ── helpers ─────────────────────────────────────────────── */

  const esc = (s) =>
    String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  const fmt = (n) => Number(n || 0).toLocaleString('fa-IR');

  function fmtDate(s, withTime = false) {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    const opts = { year: 'numeric', month: 'long', day: 'numeric' };
    if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('fa-IR', opts);
  }

  let toastTimer = null;
  function toast(msg, isError = false) {
    const root = document.getElementById('toast-root');
    root.innerHTML = `<div class="toast ${isError ? 'err' : ''}">${esc(msg)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (root.innerHTML = ''), 3200);
  }

  function openModal(html) {
    document.getElementById('modal-root').innerHTML =
      `<div class="modal-wrap" data-action="modal-close"><div class="modal" data-stop>${html}</div></div>`;
  }
  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('کپی شد ✓');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('کپی شد ✓');
    }
  }

  const SUB_PILL = {
    active: ['فعال', 'green'], expired: ['منقضی', 'gray'], disabled: ['غیرفعال', 'red'],
  };
  const ORDER_PILL = {
    pending_payment: ['در انتظار پرداخت', 'orange'],
    pending_approval: ['در انتظار تأیید', 'orange'],
    paid: ['پرداخت‌شده — در انتظار تکمیل', 'orange'],
    completed: ['تکمیل‌شده', 'green'],
    rejected: ['رد شده', 'red'],
    expired: ['منقضی', 'gray'],
  };
  const TICKET_PILL = {
    open: ['باز', 'orange'], answered: ['پاسخ داده شد', 'green'], closed: ['بسته', 'gray'],
  };
  const pill = (map, key) => {
    const [label, color] = map[key] || [key, 'gray'];
    return `<span class="pill ${color}">${esc(label)}</span>`;
  };

  const copyBox = (text) =>
    `<div class="copy-box"><span class="txt">${esc(text)}</span>
       <button class="btn sm ghost" data-action="copy" data-copy="${esc(text)}">کپی</button></div>`;

  /* ── router ──────────────────────────────────────────────── */

  function nav(page) { location.hash = page; }

  async function route() {
    const page = (location.hash || '#home').slice(1).split('/')[0] || 'home';
    const arg = (location.hash.slice(1).split('/')[1]) || null;

    // Always start each page from the top
    window.scrollTo(0, 0);

    // bottom-nav highlight + Telegram back button
    $nav.querySelectorAll('.nav-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.page === page)
    );
    if (tg) {
      if (page === 'home') tg.BackButton.hide();
      else tg.BackButton.show();
    }

    $app.innerHTML = '<div class="empty">در حال بارگذاری…</div>';
    try {
      if (page === 'home') return renderHome();
      if (page === 'buy') return await renderBuy();
      if (page === 'checkout') return renderCheckout();
      if (page === 'services') return await renderServices();
      if (page === 'wallet') return await renderWallet();
      if (page === 'support') return await renderSupport();
      if (page === 'ticket') return await renderTicket(Number(arg));
      if (page === 'admin') return await renderAdmin();
      renderHome();
    } catch (err) {
      $app.innerHTML = `<div class="empty"><span class="ico">⚠️</span>${esc(err.message || 'خطا در بارگذاری')}</div>`;
    }
  }

  /* ── HOME ────────────────────────────────────────────────── */

  function renderHome() {
    const u = state.user;
    $app.innerHTML = `
      <div class="hero">
        <div class="hello">سلام ${esc(u.full_name || u.username || 'کاربر')} 👋</div>
        <div class="balance">${fmt(u.wallet)} <span class="unit">تومان</span></div>
        <div class="sub">موجودی کیف پول شما در جاده ابریشم</div>
      </div>
      <div class="menu-grid">
        <button class="menu-tile" data-action="nav" data-page="buy"><span class="ico">🛒</span>خرید سرویس</button>
        <button class="menu-tile" data-action="nav" data-page="services"><span class="ico">📦</span>سرویس‌های من</button>
        <button class="menu-tile" data-action="nav" data-page="wallet"><span class="ico">💳</span>کیف پول</button>
        <button class="menu-tile" data-action="nav" data-page="support"><span class="ico">🎫</span>پشتیبانی</button>
        ${u.is_admin ? `<button class="menu-tile admin" data-action="nav" data-page="admin"><span class="ico">⚙️</span>پنل ادمین</button>` : ''}
      </div>`;
  }

  /* ── BUY ─────────────────────────────────────────────────── */

  async function renderBuy() {
    const data = await API.get('/api/plans');
    state.plans = data.plans;

    if (!state.plans.length) {
      $app.innerHTML = `<h1 class="page-title">خرید سرویس</h1>
        <div class="empty"><span class="ico">📭</span>در حال حاضر پلنی برای فروش موجود نیست.</div>`;
      return;
    }

    $app.innerHTML = `
      <h1 class="page-title">خرید سرویس</h1>
      ${state.plans.map((p) => `
        <div class="card">
          <div class="row"><b>${esc(p.name)}</b>
            <span class="pill green">${p.is_unlimited ? 'نامحدود' : fmt(p.gb_limit) + ' گیگ'}</span></div>
          ${p.description ? `<div class="muted">${esc(p.description)}</div>` : ''}
          <div class="row"><span class="k">مدت</span><span class="v">${fmt(p.duration_days)} روز</span></div>
          <div class="row"><span class="k">قیمت</span><span class="v">${fmt(p.price)} تومان</span></div>
          <button class="btn mt" data-action="buy-select" data-id="${p.id}">انتخاب و ادامه</button>
        </div>`).join('')}`;
  }

  function renderCheckout() {
    const p = state.selectedPlan;
    if (!p) return nav('buy');
    const u = state.user;

    $app.innerHTML = `
      <h1 class="page-title">تکمیل خرید</h1>
      <div class="card">
        <div class="row"><span class="k">پلن</span><span class="v">${esc(p.name)}</span></div>
        <div class="row"><span class="k">مدت</span><span class="v">${fmt(p.duration_days)} روز</span></div>
        <div class="row"><span class="k">مبلغ</span><span class="v">${fmt(p.price)} تومان</span></div>
      </div>

      <div class="card" style="border: 1.5px solid color-mix(in srgb, var(--warn) 55%, transparent)">
        <b>⚠️ هشدار مهم</b>
        <p class="muted" style="margin:6px 0 0">سرویس ممکن است در زمان قطعی سراسری اینترنت، جنگ، اختلال زیرساخت یا فیلترینگ شدید از دسترس خارج شود.</p>
        <label class="check"><input type="checkbox" id="accept-terms" />این شرایط را می‌پذیرم</label>
      </div>

      <div class="route-divider">روش پرداخت</div>
      <div class="card">
        <label class="check"><input type="radio" name="paym" value="wallet" checked />
          کیف پول <span class="muted">(موجودی: ${fmt(u.wallet)} تومان — تحویل آنی)</span></label>
        <label class="check"><input type="radio" name="paym" value="card" />
          کارت به کارت <span class="muted">(پس از تأیید رسید)</span></label>
      </div>
      <button class="btn" data-action="checkout-submit">پرداخت ${fmt(p.price)} تومان</button>`;
  }

  function renderPurchaseSuccess(r) {
    $app.innerHTML = `
      <div class="empty" style="padding-top:18px"><span class="ico">🎉</span><b>سرویس شما فعال شد!</b></div>
      <div class="card">
        <div class="row"><span class="k">شماره سفارش</span><span class="v mono">${esc(r.order_number)}</span></div>
        <div class="row"><span class="k">انقضا</span><span class="v">${fmtDate(r.expires_at)}</span></div>
        <div class="label mt">لینک اشتراک شما (در چت ربات هم ارسال شد):</div>
        ${copyBox(r.subscription_url)}
      </div>
      <div class="btn-row">
        <button class="btn ghost" data-action="nav" data-page="services">سرویس‌های من</button>
        <button class="btn" data-action="nav" data-page="home">بازگشت به خانه</button>
      </div>`;
  }

  function renderCardPayment(r, title) {
    $app.innerHTML = `
      <h1 class="page-title">${esc(title)}</h1>
      <div class="card">
        ${r.order_number ? `<div class="row"><span class="k">شماره سفارش</span><span class="v mono">${esc(r.order_number)}</span></div>` : ''}
        <div class="row"><span class="k">مبلغ قابل پرداخت</span><span class="v">${fmt(r.amount)} تومان</span></div>
        <div class="label mt">شماره کارت:</div>
        ${copyBox(r.card_number)}
        <div class="row"><span class="k">به نام</span><span class="v">${esc(r.card_owner)}</span></div>
      </div>
      <div class="card">
        <b>🧾 مرحله بعد</b>
        <p class="muted" style="margin:6px 0 0">${esc(r.instructions)}</p>
      </div>
      <button class="btn" data-action="close-app">ارسال عکس رسید در چت ربات</button>`;
  }

  /* ── SERVICES ────────────────────────────────────────────── */

  async function renderServices() {
    const data = await API.get('/api/services');

    if (!data.services.length) {
      $app.innerHTML = `<h1 class="page-title">سرویس‌های من</h1>
        <div class="empty"><span class="ico">📦</span>هنوز سرویسی ندارید.</div>
        <button class="btn" data-action="nav" data-page="buy">خرید اولین سرویس</button>`;
      return;
    }

    $app.innerHTML = `
      <h1 class="page-title">سرویس‌های من</h1>
      ${data.services.map((s) => `
        <div class="card">
          <div class="row"><b>${esc(s.plan_name)}</b>${pill(SUB_PILL, s.status)}</div>
          <div class="row"><span class="k">شماره سفارش</span><span class="v mono">${esc(s.order_number)}</span></div>
          <div class="row"><span class="k">تاریخ خرید</span><span class="v">${fmtDate(s.purchased_at)}</span></div>
          <div class="row"><span class="k">انقضا</span><span class="v">${fmtDate(s.expires_at)}</span></div>
          <div class="row"><span class="k">روز باقی‌مانده</span><span class="v">${fmt(s.remaining_days)} روز</span></div>
          <div class="label mt">لینک اشتراک:</div>
          ${copyBox(s.subscription_url)}
          ${s.status !== 'disabled'
            ? `<button class="btn ghost mt" data-action="renew-open" data-id="${s.id}"
                 data-name="${esc(s.plan_name)}" data-price="${s.plan_price}">♻️ تمدید سرویس (${fmt(s.plan_price)} تومان)</button>`
            : ''}
        </div>`).join('')}`;
  }

  /* ── WALLET ──────────────────────────────────────────────── */

  async function renderWallet() {
    const data = await API.get('/api/wallet');
    state.user.wallet = data.balance;

    const TX_LABEL = {
      purchase: '🛒 خرید', recharge: '💳 شارژ', refund: '↩️ بازگشت وجه',
      admin_credit: '➕ افزایش (ادمین)', admin_debit: '➖ کسر (ادمین)',
    };

    $app.innerHTML = `
      <h1 class="page-title">کیف پول</h1>
      <div class="hero">
        <div class="hello">موجودی فعلی</div>
        <div class="balance">${fmt(data.balance)} <span class="unit">تومان</span></div>
        <div class="sub">با کیف پول، خرید و تمدید بدون انتظار انجام می‌شود</div>
      </div>

      <div class="card">
        <b>افزایش موجودی</b>
        <div class="chips mt">
          ${data.presets.map((a) => `<button class="chip" data-action="preset" data-amount="${a}">${fmt(a)}</button>`).join('')}
        </div>
        <input class="input" id="recharge-amount" type="number" inputmode="numeric" placeholder="یا مبلغ دلخواه (تومان)" />
        <button class="btn" data-action="recharge">دریافت شماره کارت</button>
      </div>

      <div class="route-divider">تاریخچه تراکنش‌ها</div>
      ${data.transactions.length
        ? data.transactions.map((t) => `
            <div class="card" style="padding:11px 14px">
              <div class="row">
                <span>${TX_LABEL[t.type] || esc(t.type)}</span>
                <b style="color:${t.amount >= 0 ? 'var(--ok)' : 'var(--danger)'}">${t.amount >= 0 ? '+' : ''}${fmt(t.amount)}</b>
              </div>
              <div class="muted">${esc(t.description || '')} · ${fmtDate(t.created_at, true)}</div>
            </div>`).join('')
        : '<div class="empty">هنوز تراکنشی ندارید.</div>'}`;
  }

  /* ── SUPPORT ─────────────────────────────────────────────── */

  async function renderSupport() {
    const data = await API.get('/api/tickets');

    $app.innerHTML = `
      <h1 class="page-title">پشتیبانی</h1>
      <div class="card">
        <b>🎫 تیکت جدید</b>
        <select class="select mt" id="ticket-subject">
          ${data.subjects.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
        </select>
        <textarea class="textarea" id="ticket-message" placeholder="مشکل یا سؤال خود را بنویسید…"></textarea>
        <button class="btn" data-action="ticket-create">ارسال تیکت</button>
      </div>

      <div class="route-divider">تیکت‌های شما</div>
      ${data.tickets.length
        ? data.tickets.map((t) => `
            <div class="list-item" data-action="ticket-open" data-id="${t.id}">
              <div class="row"><b>#${t.id} — ${esc(t.subject)}</b>${pill(TICKET_PILL, t.status)}</div>
              <div class="muted">${fmt(t.message_count)} پیام · ${fmtDate(t.updated_at, true)}</div>
            </div>`).join('')
        : '<div class="empty"><span class="ico">🎫</span>تیکتی ثبت نکرده‌اید.</div>'}`;
  }

  async function renderTicket(id) {
    const data = await API.get('/api/tickets/' + id);
    const t = data.ticket;

    $app.innerHTML = `
      <h1 class="page-title">تیکت #${t.id}</h1>
      <div class="card">
        <div class="row"><b>${esc(t.subject)}</b>${pill(TICKET_PILL, t.status)}</div>
      </div>
      <div>
        ${data.messages.map((m) => `
          <div class="bubble ${m.sender_type === 'user' ? 'user' : 'admin'}">
            ${esc(m.message)}<span class="t">${fmtDate(m.created_at, true)}</span>
          </div>`).join('')}
      </div>
      ${t.status !== 'closed'
        ? `<div class="card mt">
             <textarea class="textarea" id="reply-message" placeholder="پاسخ شما…"></textarea>
             <button class="btn" data-action="ticket-reply" data-id="${t.id}">ارسال پاسخ</button>
           </div>`
        : '<div class="empty muted">این تیکت بسته شده است.</div>'}`;
  }

  /* ── ADMIN ───────────────────────────────────────────────── */

  const ADMIN_TABS = [
    ['dash', '📊 داشبورد'], ['receipts', '🧾 رسیدها'], ['users', '👥 کاربران'],
    ['plans', '📦 پلن‌ها'], ['vpn', '🔑 اکانت‌ها'], ['tickets', '🎫 تیکت‌ها'],
    ['broadcast', '📣 همگانی'], ['settings', '⚙️ تنظیمات'],
  ];

  async function renderAdmin() {
    if (!state.user.is_admin) return nav('home');

    $app.innerHTML = `
      <h1 class="page-title">پنل ادمین</h1>
      <div class="tabs">
        ${ADMIN_TABS.map(([id, label]) =>
          `<button class="chip ${state.adminTab === id ? 'active' : ''}" data-action="admin-tab" data-tab="${id}">${label}</button>`
        ).join('')}
      </div>
      <div id="admin-body"><div class="empty">در حال بارگذاری…</div></div>`;

    const body = document.getElementById('admin-body');
    try {
      if (state.adminTab === 'dash') return await adminDash(body);
      if (state.adminTab === 'receipts') return await adminReceipts(body);
      if (state.adminTab === 'users') return await adminUsers(body);
      if (state.adminTab === 'plans') return await adminPlans(body);
      if (state.adminTab === 'vpn') return await adminVpn(body);
      if (state.adminTab === 'tickets') return await adminTickets(body);
      if (state.adminTab === 'broadcast') return adminBroadcast(body);
      if (state.adminTab === 'settings') return await adminSettings(body);
    } catch (err) {
      body.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}</div>`;
    }
  }

  async function adminDash(body) {
    const { stats } = await API.get('/api/admin/stats');
    const s = stats.sales;
    body.innerHTML = `
      <div class="stats-grid">
        <div class="stat"><div class="n">${fmt(s.today)}</div><div class="l">فروش امروز (تومان)</div></div>
        <div class="stat"><div class="n">${fmt(s.week)}</div><div class="l">فروش هفته</div></div>
        <div class="stat"><div class="n">${fmt(s.month)}</div><div class="l">فروش ماه</div></div>
        <div class="stat"><div class="n">${fmt(s.year)}</div><div class="l">فروش سال</div></div>
        <div class="stat"><div class="n">${fmt(s.total)}</div><div class="l">فروش کل</div></div>
        <div class="stat"><div class="n">${fmt(s.orders_completed)}</div><div class="l">سفارش تکمیل‌شده</div></div>
        <div class="stat"><div class="n">${fmt(stats.total_users)}</div><div class="l">کل کاربران</div></div>
        <div class="stat"><div class="n">${fmt(stats.active_services)}</div><div class="l">سرویس فعال</div></div>
        <div class="stat"><div class="n">${fmt(stats.expired_services)}</div><div class="l">سرویس منقضی</div></div>
        <div class="stat"><div class="n">${fmt(stats.pending_receipts)}</div><div class="l">رسید در انتظار</div></div>
        <div class="stat"><div class="n">${fmt(stats.vpn_available)}</div><div class="l">اکانت آزاد</div></div>
        <div class="stat"><div class="n">${fmt(stats.stuck_paid_orders)}</div><div class="l">سفارش معطل تکمیل</div></div>
      </div>`;
  }

  async function adminReceipts(body) {
    const { receipts } = await API.get('/api/admin/receipts');
    if (!receipts.length) {
      body.innerHTML = '<div class="empty"><span class="ico">✅</span>رسیدی در انتظار بررسی نیست.</div>';
      return;
    }
    body.innerHTML = receipts.map((r) => `
      <div class="card">
        <div class="row"><b>رسید #${r.id}</b>
          <span class="pill ${r.type === 'wallet' ? 'orange' : 'green'}">${r.type === 'wallet' ? 'شارژ کیف پول' : 'خرید/تمدید'}</span></div>
        <div class="row"><span class="k">کاربر</span><span class="v">${esc(r.full_name || '')} ${r.username ? '(@' + esc(r.username) + ')' : ''}</span></div>
        <div class="row"><span class="k">آیدی</span><span class="v mono">${esc(r.telegram_id)}</span></div>
        ${r.order_number ? `<div class="row"><span class="k">سفارش</span><span class="v mono">${esc(r.order_number)}</span></div>` : ''}
        <div class="row"><span class="k">مبلغ</span><span class="v">${r.amount ? fmt(r.amount) + ' تومان' : '—'}</span></div>
        <div class="row"><span class="k">زمان</span><span class="v">${fmtDate(r.created_at, true)}</span></div>
        <div class="muted">🖼 عکس رسید در چت ربات برای شما ارسال شده است.</div>
        <div class="btn-row mt">
          <button class="btn ok sm" data-action="rcpt" data-verdict="approve" data-id="${r.id}">✅ تأیید</button>
          <button class="btn danger sm" data-action="rcpt" data-verdict="reject" data-id="${r.id}">❌ رد</button>
        </div>
      </div>`).join('');
  }

  async function adminUsers(body) {
    if (state.adminUserId) return adminUserProfile(body, state.adminUserId);
    body.innerHTML = `
      <div class="card">
        <input class="input" id="user-q" placeholder="جستجو: آیدی تلگرام، نام کاربری یا نام…" />
        <button class="btn" data-action="user-search">جستجو</button>
      </div>
      <div id="user-results"></div>`;
  }

  async function adminUserProfile(body, userId) {
    const data = await API.get('/api/admin/users/' + userId);
    const u = data.user;

    body.innerHTML = `
      <button class="btn ghost sm" data-action="user-back">← بازگشت به جستجو</button>
      <div class="card mt">
        <div class="row"><b>${esc(u.full_name || '—')}</b>${u.is_banned ? '<span class="pill red">مسدود</span>' : '<span class="pill green">فعال</span>'}</div>
        <div class="row"><span class="k">آیدی تلگرام</span><span class="v mono">${esc(u.telegram_id)}</span></div>
        <div class="row"><span class="k">نام کاربری</span><span class="v">${u.username ? '@' + esc(u.username) : '—'}</span></div>
        <div class="row"><span class="k">موجودی</span><span class="v">${fmt(u.wallet)} تومان</span></div>
        <div class="row"><span class="k">عضویت</span><span class="v">${fmtDate(u.created_at)}</span></div>
      </div>

      <div class="card">
        <b>💳 تغییر موجودی</b>
        <input class="input mt" id="adj-amount" type="number" placeholder="مبلغ (منفی برای کسر)" />
        <input class="input" id="adj-note" placeholder="توضیح (اختیاری)" />
        <button class="btn" data-action="user-wallet" data-id="${u.id}">اعمال</button>
      </div>

      <div class="card">
        <b>📩 ارسال پیام</b>
        <textarea class="textarea mt" id="msg-text" placeholder="متن پیام به کاربر…"></textarea>
        <div class="btn-row">
          <button class="btn" data-action="user-message" data-id="${u.id}">ارسال پیام</button>
          <button class="btn ${u.is_banned ? 'ok' : 'danger'}" data-action="user-ban" data-id="${u.id}" data-banned="${u.is_banned ? 0 : 1}">
            ${u.is_banned ? 'رفع مسدودی' : 'مسدود کردن'}</button>
        </div>
      </div>

      <div class="route-divider">سرویس‌ها (${fmt(data.subscriptions.length)})</div>
      ${data.subscriptions.map((s) => `
        <div class="card">
          <div class="row"><b>${esc(s.plan_name)}</b>${pill(SUB_PILL, s.status)}</div>
          <div class="row"><span class="k">سفارش</span><span class="v mono">${esc(s.order_number)}</span></div>
          <div class="row"><span class="k">انقضا</span><span class="v">${fmtDate(s.expires_at)}</span></div>
          <div class="row"><span class="k">ایمیل ورکر</span><span class="v mono">${esc(s.worker_email)}</span></div>
          <div class="row"><span class="k">رمز داشبورد</span><span class="v mono">${esc(s.dashboard_password)}</span></div>
          <div class="label">لینک اشتراک:</div>${copyBox(s.subscription_url)}
          <div class="label">داشبورد:</div>${copyBox(s.dashboard_url)}
          <div class="btn-row mt">
            <button class="btn ghost sm" data-action="sub-extend" data-id="${s.id}">♻️ تمدید (روز)</button>
            <button class="btn danger sm" data-action="sub-disable" data-id="${s.id}">⛔️ غیرفعال</button>
          </div>
        </div>`).join('') || '<div class="empty muted">سرویسی ندارد.</div>'}

      <div class="route-divider">سفارش‌ها (${fmt(data.orders.length)})</div>
      ${data.orders.map((o) => `
        <div class="card" style="padding:11px 14px">
          <div class="row"><span class="mono">${esc(o.order_number)}</span>${pill(ORDER_PILL, o.status)}</div>
          <div class="muted">${esc(o.plan_name)} · ${fmt(o.price)} تومان · ${fmtDate(o.created_at, true)}</div>
          ${o.status === 'paid' ? `<button class="btn ok sm mt" data-action="order-fulfill" data-id="${o.id}">🚀 تکمیل سفارش</button>` : ''}
        </div>`).join('') || '<div class="empty muted">سفارشی ندارد.</div>'}`;
  }

  async function adminPlans(body) {
    const { plans } = await API.get('/api/admin/plans');
    const p = state.editPlan || {};
    body.innerHTML = `
      <div class="card">
        <b>${p.id ? '✏️ ویرایش پلن #' + p.id : '➕ پلن جدید'}</b>
        <input class="input mt" id="pl-name" placeholder="نام پلن" value="${esc(p.name || '')}" />
        <input class="input" id="pl-desc" placeholder="توضیح (اختیاری)" value="${esc(p.description || '')}" />
        <input class="input" id="pl-price" type="number" placeholder="قیمت (تومان)" value="${p.price || ''}" />
        <input class="input" id="pl-days" type="number" placeholder="مدت (روز)" value="${p.duration_days || ''}" />
        <input class="input" id="pl-gb" type="number" placeholder="حجم گیگ (خالی = نامحدود)" value="${p.gb_limit ?? ''}" />
        <label class="check"><input type="checkbox" id="pl-active" ${p.is_active !== 0 ? 'checked' : ''} />فعال (قابل فروش)</label>
        <div class="btn-row">
          <button class="btn" data-action="plan-save" ${p.id ? `data-id="${p.id}"` : ''}>${p.id ? 'ذخیره تغییرات' : 'افزودن پلن'}</button>
          ${p.id ? '<button class="btn ghost" data-action="plan-cancel">انصراف</button>' : ''}
        </div>
      </div>
      <div class="route-divider">پلن‌ها</div>
      ${plans.map((pl) => `
        <div class="card">
          <div class="row"><b>${esc(pl.name)}</b>${pl.is_active ? '<span class="pill green">فعال</span>' : '<span class="pill gray">غیرفعال</span>'}</div>
          <div class="muted">${fmt(pl.price)} تومان · ${fmt(pl.duration_days)} روز · ${pl.is_unlimited ? 'نامحدود' : fmt(pl.gb_limit) + ' گیگ'}</div>
          <div class="btn-row mt">
            <button class="btn ghost sm" data-action="plan-edit" data-id="${pl.id}">ویرایش</button>
            ${pl.is_active ? `<button class="btn danger sm" data-action="plan-delete" data-id="${pl.id}">حذف از فروش</button>` : ''}
          </div>
        </div>`).join('')}`;
    body.dataset.plans = JSON.stringify(plans);
  }

  async function adminVpn(body) {
    const status = body.dataset.vpnFilter || '';
    const { accounts } = await API.get('/api/admin/vpn' + (status ? '?status=' + status : ''));

    body.innerHTML = `
      <div class="card">
        <b>➕ افزودن اکانت</b>
        <input class="input mt" id="v-email" placeholder="ایمیل ورکر" />
        <input class="input" id="v-pass" placeholder="رمز داشبورد" />
        <input class="input" id="v-sub" placeholder="لینک اشتراک (https://…)" dir="ltr" />
        <input class="input" id="v-dash" placeholder="لینک داشبورد (https://…)" dir="ltr" />
        <button class="btn" data-action="vpn-add">افزودن</button>
      </div>
      <div class="card">
        <b>📋 ایمپورت گروهی</b>
        <p class="muted" style="margin:4px 0 8px">هر اکانت ۴ خط: ایمیل، رمز، لینک اشتراک، لینک داشبورد</p>
        <textarea class="textarea" id="v-bulk" dir="ltr" placeholder="email@example.com&#10;password&#10;https://…/sub?token=…&#10;https://…/admin"></textarea>
        <button class="btn" data-action="vpn-bulk">ایمپورت</button>
      </div>

      <div class="route-divider">موجودی اکانت‌ها</div>
      <div class="chips">
        ${[['', 'همه'], ['available', 'آزاد'], ['assigned', 'واگذارشده'], ['expired', 'منقضی'], ['disabled', 'غیرفعال']]
          .map(([v, l]) => `<button class="chip ${status === v ? 'active' : ''}" data-action="vpn-filter" data-status="${v}">${l}</button>`).join('')}
      </div>
      ${accounts.map((a) => `
        <div class="card">
          <div class="row"><span class="mono">#${a.id} ${esc(a.worker_email)}</span>
            ${pill({ available: ['آزاد', 'green'], assigned: ['واگذارشده', 'orange'], expired: ['منقضی', 'gray'], disabled: ['غیرفعال', 'red'] }, a.status)}</div>
          ${a.user_telegram_id ? `<div class="muted">👤 ${a.user_username ? '@' + esc(a.user_username) : esc(a.user_telegram_id)}</div>` : ''}
          ${copyBox(a.subscription_url)}
          <div class="btn-row mt">
            <button class="btn ghost sm" data-action="vpn-edit" data-id="${a.id}">✏️ ویرایش</button>
            ${a.status === 'available' ? `
              <button class="btn ghost sm" data-action="vpn-status" data-id="${a.id}" data-status="disabled">غیرفعال</button>
              <button class="btn danger sm" data-action="vpn-delete" data-id="${a.id}">حذف</button>` : ''}
            ${a.status === 'disabled' || a.status === 'expired' ? `
              <button class="btn ok sm" data-action="vpn-status" data-id="${a.id}" data-status="available">بازگشت به فروش</button>` : ''}
          </div>
        </div>`).join('') || '<div class="empty">اکانتی یافت نشد.</div>'}`;
    body.dataset.vpnFilter = status;
    body.dataset.accounts = JSON.stringify(accounts);
  }

  async function adminTickets(body) {
    if (state.adminTicketId) return adminTicketDetail(body, state.adminTicketId);
    const { tickets } = await API.get('/api/admin/tickets');
    body.innerHTML = tickets.length
      ? tickets.map((t) => `
          <div class="list-item" data-action="atkt-open" data-id="${t.id}">
            <div class="row"><b>#${t.id} — ${esc(t.subject)}</b>${pill(TICKET_PILL, t.status)}</div>
            <div class="muted">${esc(t.full_name || '')} ${t.username ? '(@' + esc(t.username) + ')' : ''} · ${fmtDate(t.updated_at, true)}</div>
          </div>`).join('')
      : '<div class="empty"><span class="ico">🎫</span>تیکتی وجود ندارد.</div>';
  }

  async function adminTicketDetail(body, id) {
    const data = await API.get('/api/admin/tickets/' + id);
    const t = data.ticket;
    body.innerHTML = `
      <button class="btn ghost sm" data-action="atkt-back">← بازگشت</button>
      <div class="card mt">
        <div class="row"><b>#${t.id} — ${esc(t.subject)}</b>${pill(TICKET_PILL, t.status)}</div>
        <div class="muted">${esc(t.full_name || '')} ${t.username ? '(@' + esc(t.username) + ')' : ''} · <span class="mono">${esc(t.telegram_id)}</span></div>
      </div>
      ${data.messages.map((m) => `
        <div class="bubble ${m.sender_type === 'user' ? 'admin' : 'user'}">
          ${esc(m.message)}<span class="t">${m.sender_type === 'user' ? 'کاربر' : 'پشتیبانی'} · ${fmtDate(m.created_at, true)}</span>
        </div>`).join('')}
      <div class="card mt">
        <textarea class="textarea" id="atkt-reply" placeholder="پاسخ پشتیبانی…"></textarea>
        <div class="btn-row">
          <button class="btn" data-action="atkt-send" data-id="${t.id}">ارسال پاسخ</button>
          ${t.status !== 'closed' ? `<button class="btn ghost" data-action="atkt-close" data-id="${t.id}">بستن تیکت</button>` : ''}
        </div>
      </div>`;
  }

  function adminBroadcast(body) {
    body.innerHTML = `
      <div class="card">
        <b>📣 پیام همگانی</b>
        <p class="muted" style="margin:4px 0 8px">به همه کاربران (به‌جز مسدودها) از طریق ربات ارسال می‌شود — به‌صورت دسته‌ای.</p>
        <textarea class="textarea" id="bc-text" placeholder="متن پیام…"></textarea>
        <button class="btn" data-action="bc-send">شروع ارسال</button>
        <div class="muted mt" id="bc-progress"></div>
      </div>`;
  }

  async function adminSettings(body) {
    const { settings } = await API.get('/api/admin/settings');
    body.innerHTML = `
      <div class="card">
        <b>💳 اطلاعات پرداخت کارت‌به‌کارت</b>
        <label class="label mt">شماره کارت</label>
        <input class="input" id="set-card" dir="ltr" value="${esc(settings.card_number)}" />
        <label class="label">نام صاحب کارت</label>
        <input class="input" id="set-owner" value="${esc(settings.card_owner)}" />
        <button class="btn" data-action="settings-save">ذخیره</button>
      </div>`;
  }

  /* ── actions ─────────────────────────────────────────────── */

  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); }
    catch (err) { toast(err.message || 'خطا رخ داد', true); }
    finally { if (btn) btn.disabled = false; }
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;

    if (a === 'modal-close' && !e.target.closest('[data-stop]')) return closeModal();
    if (a === 'nav') { state.adminUserId = null; state.adminTicketId = null; return nav(el.dataset.page); }
    if (a === 'copy') return copyText(el.dataset.copy);
    if (a === 'close-app') return tg ? tg.close() : nav('home');

    /* buy */
    if (a === 'buy-select') {
      state.selectedPlan = state.plans.find((p) => p.id === Number(el.dataset.id));
      return nav('checkout');
    }
    if (a === 'checkout-submit') {
      const accepted = document.getElementById('accept-terms').checked;
      if (!accepted) return toast('برای ادامه باید شرایط را بپذیرید', true);
      const method = document.querySelector('input[name="paym"]:checked').value;
      return busy(el, async () => {
        const r = await API.post('/api/purchase', { plan_id: state.selectedPlan.id, method, accepted: true });
        if (method === 'wallet') {
          state.user.wallet -= state.selectedPlan.price;
          renderPurchaseSuccess(r);
        } else {
          renderCardPayment(r, 'پرداخت کارت به کارت');
        }
      });
    }

    /* renew */
    if (a === 'renew-open') {
      const { id, name, price } = el.dataset;
      return openModal(`
        <h3>♻️ تمدید «${esc(name)}»</h3>
        <p class="muted">مبلغ تمدید: ${fmt(price)} تومان — روش پرداخت را انتخاب کنید:</p>
        <div class="btn-row mt">
          <button class="btn" data-action="renew-do" data-id="${id}" data-method="wallet">کیف پول</button>
          <button class="btn ghost" data-action="renew-do" data-id="${id}" data-method="card">کارت به کارت</button>
        </div>`);
    }
    if (a === 'renew-do') {
      return busy(el, async () => {
        const r = await API.post('/api/services/renew', {
          subscription_id: Number(el.dataset.id),
          method: el.dataset.method,
        });
        closeModal();
        if (el.dataset.method === 'wallet') {
          toast('سرویس با موفقیت تمدید شد ✓');
          route();
        } else {
          renderCardPayment(r, 'تمدید — کارت به کارت');
        }
      });
    }

    /* wallet */
    if (a === 'preset') {
      document.getElementById('recharge-amount').value = el.dataset.amount;
      document.querySelectorAll('.chip[data-action="preset"]').forEach((c) => c.classList.remove('active'));
      el.classList.add('active');
      return;
    }
    if (a === 'recharge') {
      const amount = Number(document.getElementById('recharge-amount').value);
      if (!amount) return toast('مبلغ را وارد یا انتخاب کنید', true);
      return busy(el, async () => {
        const r = await API.post('/api/wallet/recharge', { amount });
        renderCardPayment(r, 'شارژ کیف پول');
      });
    }

    /* tickets (user) */
    if (a === 'ticket-create') {
      const subject = document.getElementById('ticket-subject').value;
      const message = document.getElementById('ticket-message').value.trim();
      if (!message) return toast('متن پیام را بنویسید', true);
      return busy(el, async () => {
        const r = await API.post('/api/tickets', { subject, message });
        toast('تیکت ثبت شد ✓');
        nav('ticket/' + r.id);
      });
    }
    if (a === 'ticket-open') return nav('ticket/' + el.dataset.id);
    if (a === 'ticket-reply') {
      const message = document.getElementById('reply-message').value.trim();
      if (!message) return toast('متن پاسخ را بنویسید', true);
      return busy(el, async () => {
        await API.post(`/api/tickets/${el.dataset.id}/messages`, { message });
        route();
      });
    }

    /* admin */
    if (a === 'admin-tab') {
      state.adminTab = el.dataset.tab;
      state.adminUserId = null;
      state.adminTicketId = null;
      state.editPlan = null;
      return renderAdmin();
    }
    if (a === 'rcpt') {
      return busy(el, async () => {
        const r = await API.post(`/api/admin/receipts/${el.dataset.id}/${el.dataset.verdict}`, {});
        toast(r.message || 'انجام شد ✓');
        renderAdmin();
      });
    }
    if (a === 'user-search') {
      const q = document.getElementById('user-q').value.trim();
      if (q.length < 2) return toast('حداقل ۲ کاراکتر وارد کنید', true);
      return busy(el, async () => {
        const { users } = await API.get('/api/admin/users?q=' + encodeURIComponent(q));
        document.getElementById('user-results').innerHTML = users.length
          ? users.map((u) => `
              <div class="list-item" data-action="user-open" data-id="${u.id}">
                <div class="row"><b>${esc(u.full_name || '—')}</b>${u.is_banned ? '<span class="pill red">مسدود</span>' : ''}</div>
                <div class="muted"><span class="mono">${esc(u.telegram_id)}</span> ${u.username ? '· @' + esc(u.username) : ''} · ${fmt(u.wallet)} تومان</div>
              </div>`).join('')
          : '<div class="empty">کاربری یافت نشد.</div>';
      });
    }
    if (a === 'user-open') { state.adminUserId = Number(el.dataset.id); return renderAdmin(); }
    if (a === 'user-back') { state.adminUserId = null; return renderAdmin(); }
    if (a === 'user-wallet') {
      const amount = Number(document.getElementById('adj-amount').value);
      const note = document.getElementById('adj-note').value.trim();
      if (!amount) return toast('مبلغ را وارد کنید (منفی = کسر)', true);
      return busy(el, async () => {
        await API.post(`/api/admin/users/${el.dataset.id}/wallet`, { amount, note });
        toast('موجودی به‌روزرسانی شد ✓');
        renderAdmin();
      });
    }
    if (a === 'user-message') {
      const text = document.getElementById('msg-text').value.trim();
      if (!text) return toast('متن پیام را بنویسید', true);
      return busy(el, async () => {
        await API.post(`/api/admin/users/${el.dataset.id}/message`, { text });
        toast('پیام ارسال شد ✓');
        document.getElementById('msg-text').value = '';
      });
    }
    if (a === 'user-ban') {
      return busy(el, async () => {
        await API.post(`/api/admin/users/${el.dataset.id}/ban`, { banned: el.dataset.banned === '1' });
        toast('انجام شد ✓');
        renderAdmin();
      });
    }
    if (a === 'sub-extend') {
      const days = Number(prompt('چند روز تمدید شود؟', '30'));
      if (!days) return;
      return busy(el, async () => {
        await API.post(`/api/admin/subscriptions/${el.dataset.id}/extend`, { days });
        toast('تمدید شد ✓');
        renderAdmin();
      });
    }
    if (a === 'sub-disable') {
      return busy(el, async () => {
        await API.post(`/api/admin/subscriptions/${el.dataset.id}/disable`, {});
        toast('غیرفعال شد ✓');
        renderAdmin();
      });
    }
    if (a === 'order-fulfill') {
      return busy(el, async () => {
        const r = await API.post(`/api/admin/orders/${el.dataset.id}/fulfill`, {});
        toast(r.message || 'انجام شد ✓');
        renderAdmin();
      });
    }
    if (a === 'plan-edit') {
      const plans = JSON.parse(document.getElementById('admin-body').dataset.plans || '[]');
      state.editPlan = plans.find((p) => p.id === Number(el.dataset.id));
      return renderAdmin();
    }
    if (a === 'plan-cancel') { state.editPlan = null; return renderAdmin(); }
    if (a === 'plan-save') {
      const gbRaw = document.getElementById('pl-gb').value;
      const bodyData = {
        name: document.getElementById('pl-name').value,
        description: document.getElementById('pl-desc').value,
        price: Number(document.getElementById('pl-price').value),
        duration_days: Number(document.getElementById('pl-days').value),
        gb_limit: gbRaw === '' ? null : Number(gbRaw),
        is_unlimited: gbRaw === '',
        is_active: document.getElementById('pl-active').checked,
      };
      return busy(el, async () => {
        if (el.dataset.id) await API.put('/api/admin/plans/' + el.dataset.id, bodyData);
        else await API.post('/api/admin/plans', bodyData);
        toast('ذخیره شد ✓');
        state.editPlan = null;
        renderAdmin();
      });
    }
    if (a === 'plan-delete') {
      return busy(el, async () => {
        await API.del('/api/admin/plans/' + el.dataset.id);
        toast('از فروش حذف شد ✓');
        renderAdmin();
      });
    }
    if (a === 'vpn-add') {
      return busy(el, async () => {
        await API.post('/api/admin/vpn', {
          worker_email: document.getElementById('v-email').value,
          dashboard_password: document.getElementById('v-pass').value,
          subscription_url: document.getElementById('v-sub').value,
          dashboard_url: document.getElementById('v-dash').value,
        });
        toast('اکانت اضافه شد ✓');
        renderAdmin();
      });
    }
    if (a === 'vpn-bulk') {
      return busy(el, async () => {
        const r = await API.post('/api/admin/vpn/bulk', { text: document.getElementById('v-bulk').value });
        toast(`${fmt(r.imported)} اکانت ایمپورت شد ✓`);
        renderAdmin();
      });
    }
    if (a === 'vpn-filter') {
      document.getElementById('admin-body').dataset.vpnFilter = el.dataset.status;
      return adminVpn(document.getElementById('admin-body'));
    }
    if (a === 'vpn-edit') {
      const accounts = JSON.parse(document.getElementById('admin-body').dataset.accounts || '[]');
      const acc = accounts.find((x) => x.id === Number(el.dataset.id));
      if (!acc) return;
      return openModal(`
        <h3>✏️ ویرایش اکانت #${acc.id}</h3>
        <label class="label">ایمیل ورکر</label>
        <input class="input" id="e-email" value="${esc(acc.worker_email)}" />
        <label class="label">رمز داشبورد</label>
        <input class="input" id="e-pass" value="${esc(acc.dashboard_password)}" />
        <label class="label">لینک اشتراک</label>
        <input class="input" id="e-sub" dir="ltr" value="${esc(acc.subscription_url)}" />
        <label class="label">لینک داشبورد</label>
        <input class="input" id="e-dash" dir="ltr" value="${esc(acc.dashboard_url)}" />
        ${acc.status === 'assigned'
          ? `<label class="check"><input type="checkbox" id="e-notify" checked />ارسال لینک جدید به مشتری از طریق ربات</label>`
          : ''}
        <button class="btn" data-action="vpn-save" data-id="${acc.id}">ذخیره تغییرات</button>`);
    }
    if (a === 'vpn-save') {
      const notifyEl = document.getElementById('e-notify');
      return busy(el, async () => {
        const r = await API.put('/api/admin/vpn/' + el.dataset.id, {
          worker_email: document.getElementById('e-email').value,
          dashboard_password: document.getElementById('e-pass').value,
          subscription_url: document.getElementById('e-sub').value,
          dashboard_url: document.getElementById('e-dash').value,
          notify_user: notifyEl ? notifyEl.checked : false,
        });
        closeModal();
        toast(r.notified ? 'ذخیره شد و لینک جدید برای مشتری ارسال شد ✓' : 'اکانت به‌روزرسانی شد ✓');
        adminVpn(document.getElementById('admin-body'));
      });
    }
    if (a === 'vpn-status') {
      return busy(el, async () => {
        await API.post(`/api/admin/vpn/${el.dataset.id}/status`, { status: el.dataset.status });
        toast('انجام شد ✓');
        adminVpn(document.getElementById('admin-body'));
      });
    }
    if (a === 'vpn-delete') {
      return busy(el, async () => {
        await API.del('/api/admin/vpn/' + el.dataset.id);
        toast('حذف شد ✓');
        adminVpn(document.getElementById('admin-body'));
      });
    }
    if (a === 'atkt-open') { state.adminTicketId = Number(el.dataset.id); return renderAdmin(); }
    if (a === 'atkt-back') { state.adminTicketId = null; return renderAdmin(); }
    if (a === 'atkt-send') {
      const message = document.getElementById('atkt-reply').value.trim();
      if (!message) return toast('متن پاسخ را بنویسید', true);
      return busy(el, async () => {
        await API.post(`/api/admin/tickets/${el.dataset.id}/reply`, { message });
        toast('پاسخ ارسال شد ✓');
        renderAdmin();
      });
    }
    if (a === 'atkt-close') {
      return busy(el, async () => {
        await API.post(`/api/admin/tickets/${el.dataset.id}/close`, {});
        toast('تیکت بسته شد ✓');
        state.adminTicketId = null;
        renderAdmin();
      });
    }
    if (a === 'bc-send') {
      const text = document.getElementById('bc-text').value.trim();
      if (!text) return toast('متن پیام را بنویسید', true);
      const prog = document.getElementById('bc-progress');
      return busy(el, async () => {
        let total = 0;
        let r = await API.post('/api/admin/broadcast', { text, reset: true });
        total += r.sent;
        prog.textContent = `ارسال شد: ${fmt(total)} — باقی‌مانده: ${fmt(r.remaining)}`;
        while (!r.done) {
          r = await API.post('/api/admin/broadcast', { text });
          total += r.sent;
          prog.textContent = `ارسال شد: ${fmt(total)} — باقی‌مانده: ${fmt(r.remaining)}`;
        }
        prog.textContent = `✅ ارسال کامل شد به ${fmt(total)} کاربر.`;
        toast('ارسال همگانی تمام شد ✓');
      });
    }
    if (a === 'settings-save') {
      return busy(el, async () => {
        await API.put('/api/admin/settings', {
          card_number: document.getElementById('set-card').value,
          card_owner: document.getElementById('set-owner').value,
        });
        toast('تنظیمات ذخیره شد ✓');
      });
    }
  });

  /* ── boot ────────────────────────────────────────────────── */

  (async function boot() {
    const textEl = $boot.querySelector('.boot__text');

    // Never restore old scroll positions between hash pages
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

    if (!tg || !tg.initData) {
      textEl.textContent = 'لطفاً مینی‌اپ را از داخل تلگرام باز کنید.';
      return;
    }

    try {
      const data = await API.get('/api/me');
      state.user = data.user;

      tg.BackButton.onClick(() => history.back());

      window.addEventListener('hashchange', route);
      $boot.hidden = true;
      $app.hidden = false;
      $nav.hidden = false;
      route();
    } catch (err) {
      textEl.textContent = '❌ ' + (err.message || 'خطا در احراز هویت');
    }
  })();
})();
