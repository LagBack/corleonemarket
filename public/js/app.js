// ═══════════════════════════════════════════════════
//  CORLEONE MARKET — Frontend App (connects to backend)
// ═══════════════════════════════════════════════════

const AVATARS = ['🦁','🐺','🦊','🐉','🦅','🎩','🃏','🌹','🐯','🦝','🤵','👑','🎯','⚡','🔱'];

const COUNTRY_OPTIONS = [
  { value: 'Brasil', flag: '🇧🇷' },
  { value: 'Estados Unidos', flag: '🇺🇸' },
  { value: 'Itália', flag: '🇮🇹' },
  { value: 'Japão', flag: '🇯🇵' },
  { value: 'Alemanha', flag: '🇩🇪' },
  { value: 'França', flag: '🇫🇷' },
  { value: 'Argentina', flag: '🇦🇷' },
  { value: 'Portugal', flag: '🇵🇹' },
  { value: 'Outro', flag: '🌍' },
];

function countryNameOnly(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/^(\?{1,2}|\uFFFD)+\s*/g, '').trim();
  s = s.replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '').trim();
  s = s.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+\s*/u, '').trim();
  if (!s) s = String(raw).trim();
  const hit = COUNTRY_OPTIONS.find(c => c.value.toLowerCase() === s.toLowerCase());
  if (hit) return hit.value;
  const partial = COUNTRY_OPTIONS.find(c => s.toLowerCase().includes(c.value.toLowerCase()));
  return partial ? partial.value : s;
}

function formatCountry(raw) {
  const name = countryNameOnly(raw);
  if (!name) return '';
  const hit = COUNTRY_OPTIONS.find(c => c.value.toLowerCase() === name.toLowerCase());
  return hit ? `${hit.flag} ${hit.value}` : name;
}

let CU = null;           // current user
let stocks = [];         // cached stock list
let priceHistory = {};   // sym -> [{p}]
let mainChart = null;
let pieChart  = null;
let ownerRows = [];      // create stock — [{userId, name, pct}]
let editOwnerRows = [];  // edit stock
let selectedSym = null;
let marketHistory = [];
let orderType = 'buy';
let editAvatar = null;
let regAvatar = '🦁';
let pollInterval = null;
let keepAliveInterval = null;
let adminOwnershipReady = false;
let roleChangeBusy = false;
const _actionBusy = new Set();
let _pageLoadGen = 0;

// ── API HELPER ──
async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch('/api/' + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erro desconhecido');
  return data;
}
const GET  = p       => api('GET', p);
const POST = (p, b)  => api('POST', p, b);
const PUT  = (p, b)  => api('PUT', p, b);
const DEL  = p       => api('DELETE', p);

function sameUserId(a, b) {
  return String(a) === String(b);
}

function withActionLock(key, fn) {
  if (_actionBusy.has(key)) return Promise.resolve();
  _actionBusy.add(key);
  return Promise.resolve(fn()).finally(() => _actionBusy.delete(key));
}

function setBtnBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = label || 'Aguarde…';
  } else {
    btn.disabled = false;
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
  }
}

function setPageLoading(pageId, loading) {
  const page = document.getElementById('p-' + pageId);
  if (!page) return;
  page.classList.toggle('page-loading', loading);
}

function roleLabel(role) {
  if (role === 'admin') return '👑 Admin';
  if (role === 'moderator') return '🎩 Moderador';
  if (role === 'dev') return '🛠 Dev';
  return '🦁 Investidor';
}

const TIER_EMOJI = { don_corleone:'🔥', supremo:'⚡', magnata:'🏆', padrinom:'🎭', notavel:'🏛️', investidor:'💰' };
const TIER_LABEL = { don_corleone:'Don Corleone', supremo:'SUPREMO', magnata:'MAGNATA', padrinom:'PADRINO', notavel:'NOTÁVEL', investidor:'INVESTIDOR' };
const TIER_COLOR = { don_corleone:'#FFD700', supremo:'#FF6B35', magnata:'#DAA520', padrinom:'#CD853F', notavel:'#90EE90', investidor:'#aaa' };

const TIER_TT = {
  don_corleone:  'Patrimônio ≥ R$1 bilhão. O ápice do mercado.',
  supremo:       'Patrimônio ≥ R$500 milhões. Elite financeira.',
  magnata:       'Patrimônio ≥ R$100 milhões. Magnata do mercado.',
  padrinom:      'Patrimônio ≥ R$10 milhões. Padrino dos negócios.',
  notavel:       'Patrimônio ≥ R$1 milhão. Investidor Notável.',
  investidor:    'Comece a investir! Compre ações e cresça seu patrimônio.',
};

function tierBadge(tierId) {
  return TIER_EMOJI[tierId] || '💰';
}

function tierName(tierId) {
  return TIER_LABEL[tierId] || 'INVESTIDOR';
}

function tierColorStr(tierId) {
  return TIER_COLOR[tierId] || '#aaa';
}

function tierTooltip(tierId) {
  return TIER_TT[tierId] || '';
}

function supporterBadge(user) {
  if (!user || !user.hasDonated) return '';
  return `<span class="badge-tip"><span class="supporter-badge">🌟 Supporter</span><span class="tip-bubble">Entregue aos usuários que contribuíram ao projeto doando.</span></span>`;
}

function getFontClass() {
  return localStorage.getItem('corleone-font-preference') || '';
}

// ── AUTH TAB ──
function authTab(t) {
  document.querySelectorAll('.auth-tab').forEach((b, i) =>
    b.classList.toggle('active', (i === 0 && t === 'login') || (i === 1 && t === 'register')));
  document.getElementById('auth-login').style.display    = t === 'login'    ? 'block' : 'none';
  document.getElementById('auth-register').style.display = t === 'register' ? 'block' : 'none';
}

function normalizeAvatar(avatar) {
  return AVATARS.includes(avatar) ? avatar : '🦁';
}

function buildAvatarGrid(containerId, onSelect, current) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const selected = normalizeAvatar(current);
  el.innerHTML = '';
  AVATARS.forEach(a => {
    const d = document.createElement('div');
    d.className = 'av-opt' + (a === selected ? ' sel' : '');
    d.textContent = a;
    d.onclick = () => {
      el.querySelectorAll('.av-opt').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      onSelect(a);
    };
    el.appendChild(d);
  });
}
buildAvatarGrid('reg-avatar-grid', a => regAvatar = a, '🦁');

function showAuthErr(msg) {
  const e = document.getElementById('auth-err');
  e.style.display = 'block'; e.textContent = msg;
}

async function doLogin() {
  const email = document.getElementById('l-email').value.trim();
  const pass  = document.getElementById('l-pass').value;
  try {
    const { user } = await POST('auth/login', { email, pass });
    CU = user;
    startApp();
  } catch(e) { showAuthErr(e.message); }
}

async function doRegister() {
  const name    = document.getElementById('r-name').value.trim();
  const lname   = document.getElementById('r-lname').value.trim();
  const email   = document.getElementById('r-email').value.trim();
  const pass    = document.getElementById('r-pass').value;
  const nick    = document.getElementById('r-nick').value.trim();
  const country = document.getElementById('r-country').value;
  try {
    const { user } = await POST('auth/register', { name, lname, email, pass, nick, avatar: regAvatar, country });
    CU = user;
    startApp();
  } catch(e) { showAuthErr(e.message); }
}

async function doLogout() {
  await POST('auth/logout').catch(() => {});
  CU = null; stocks = []; priceHistory = {};
  clearInterval(pollInterval);
  clearInterval(keepAliveInterval);
  adminOwnershipReady = false;
  if (mainChart) { mainChart.destroy(); mainChart = null; }
  document.querySelectorAll('.admin-only').forEach(e => e.style.display = 'none');
  document.querySelectorAll('.dev-only').forEach(e => e.style.display = 'none');
  document.querySelectorAll('.bottom-nav-btn.admin-only,.bottom-nav-btn.dev-only').forEach(e => {
    e.style.display = 'none';
  });
  document.getElementById('s-app').classList.remove('active');
  document.getElementById('s-auth').classList.add('active');
}

// ── APP START ──
async function startApp() {
  document.getElementById('s-auth').classList.remove('active');
  document.getElementById('s-app').classList.add('active');
  updateHeaderUser();
  document.querySelectorAll('.admin-only').forEach(e => e.style.display = 'none');
  document.querySelectorAll('.dev-only').forEach(e => e.style.display = 'none');
  if (canAccessAdmin())
    document.querySelectorAll('.admin-only').forEach(e => e.style.display = '');
  if (canAccessDev())
    document.querySelectorAll('.dev-only').forEach(e => e.style.display = '');
  document.querySelectorAll('.bottom-nav-btn.admin-only').forEach(e => {
    e.style.display = canAccessAdmin() ? '' : 'none';
  });
  document.querySelectorAll('.bottom-nav-btn.dev-only').forEach(e => {
    e.style.display = canAccessDev() ? '' : 'none';
  });
  await loadMarketState();
  buildChart();
  showPage('market');
  startPolling();
  startKeepAlive();
}

function canAccessAdmin() {
  return !!CU && ['admin', 'moderator', 'dev'].includes(CU.role);
}

function canAccessFullAdmin() {
  return !!CU && ['admin', 'dev'].includes(CU.role);
}

function canAccessDev() {
  return !!CU && CU.role === 'dev';
}

function userPhotoSrc(user) {
  if (!user) return null;
  return user.photoDisplay || user.photo || null;
}

function photoWithBust(url) {
  if (!url || url.startsWith('data:')) return url || '';
  return url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
}

function userAvatarHtml(user, { wrapClass = '' } = {}) {
  const emoji = normalizeAvatar(user?.avatar);
  const src = userPhotoSrc(user);
  if (src) {
    const bust = photoWithBust(src);
    return `<div class="${wrapClass}"><img src="${bust}" alt="${emoji}" onerror="this.parentElement.textContent=this.alt"></div>`;
  }
  return `<div class="${wrapClass}">${emoji}</div>`;
}

function refreshRankingIfActive() {
  if (document.getElementById('p-ranking')?.classList.contains('active')) renderRanking();
}

function updateHeaderUser() {
  if (!CU) return;
  const nameEl = document.getElementById('hdr-name');
  nameEl.textContent = CU.nick || CU.name;
  const avEl = document.getElementById('hdr-av');
  const src = userPhotoSrc(CU);
  if (src) {
    avEl.innerHTML = `<img src="${photoWithBust(src)}" alt="${normalizeAvatar(CU.avatar)}" onerror="this.replaceWith(document.createTextNode(this.alt))">`;
  } else {
    avEl.textContent = normalizeAvatar(CU.avatar);
  }
}

// ── POLLING ──
function startPolling() {
  clearInterval(pollInterval);
  const tick = () => {
    if (document.hidden) return;
    loadMarketState();
  };
  pollInterval = setInterval(tick, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadMarketState();
  });
}

function startKeepAlive() {
  clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(() => {
    if (document.hidden) return;
    fetch('/api/market/state', { credentials: 'include' }).catch(() => {});
  }, 10 * 60 * 1000);
}

async function loadMarketState() {
  try {
    const data = await GET('market/state');
    stocks = data.stocks;
    marketHistory.push(data.ibcx || 1000);
    if (marketHistory.length > 80) marketHistory = marketHistory.slice(-80);
    updateMktBadge(data.open);
    renderAll(data);
    updateTicker();
    const mktActive = document.getElementById('p-market')?.classList.contains('active');
    if (selectedSym && mktActive) await refreshChartHistory(selectedSym);
  } catch(e) { console.error('Poll error:', e); }
}

async function refreshChartHistory(sym) {
  try {
    const { history } = await GET('market/history/' + sym);
    priceHistory[sym] = history; // plain number[]
    if (mainChart) updateMainChart();
  } catch(e) { console.error('History fetch error:', e); }
}

// ── RENDER ALL ──
function renderAll(data) {
  renderMktStats(data);
  renderStocksTable();
  updateOrderBook();
}

function renderMktStats(data) {
  const { ibcx, totalVol, stocks: st, open } = data || {};
  const gainers = (st || []).filter(s => s.price >= s.open).length;
  const losers  = (st || []).filter(s => s.price <  s.open).length;
  document.getElementById('mkt-stats').innerHTML = `
    <div class="stat"><div class="stat-label">IBCX</div><div class="stat-val ${(ibcx||1000)>=1000?'green':'red'} serif">${(ibcx||1000).toFixed(0)}</div><div class="stat-sub">${(ibcx||1000)>=1000?'▲':'▼'}${Math.abs((ibcx||1000)-1000).toFixed(1)}pts</div></div>
    <div class="stat"><div class="stat-label">Volume Fin.</div><div class="stat-val serif">R$${fmtN(totalVol||0)}</div><div class="stat-sub">Total do dia</div></div>
    <div class="stat"><div class="stat-label">Alta / Queda</div><div class="stat-val serif"><span class="green">${gainers}</span> / <span class="red">${losers}</span></div></div>
    <div class="stat"><div class="stat-label">Status</div><div class="stat-val ${open?'green':'red'} serif">${open?'ABERTO':'FECHADO'}</div><div class="stat-sub">${(stocks||[]).filter(s=>s.status==='active').length} ativos</div></div>
  `;
}

function renderStocksTable() {
  document.getElementById('stocks-ct').textContent = stocks.length;
  const maxVol = Math.max(...stocks.map(s => s.volume + 1));
  document.getElementById('stocks-body').innerHTML = stocks.map(s => {
    const pct = ((s.price - s.open) / s.open * 100);
    const cls = pct > 0 ? 'up' : pct < 0 ? 'dn' : 'neu';
    const sign = pct > 0 ? '+' : '';
    const dr = s.demand / (s.demand + s.supply + .001);
    // Intraday high/low — fall back gracefully if the backend hasn't seeded them yet
    const dayHigh = (s.dayHigh != null) ? s.dayHigh : s.price;
    const dayLow  = (s.dayLow  != null) ? s.dayLow  : s.price;
    return `<tr onclick="selectStock('${s.sym}')" style="cursor:pointer" id="row-${s.sym}">
      <td data-label="Código"><span class="sym-tag">${s.sym}</span></td>
      <td data-label="Empresa" style="font-weight:600;font-size:12px">${s.name}</td>
      <td data-label="Setor"><span class="sector-tag">${s.sector}</span></td>
      <td data-label="Status"><span class="status-badge ${s.status}">${s.status==='active'?'Ativa':'Suspensa'}</span></td>
      <td data-label="Preço" class="price-${cls} mono">R$${s.price.toFixed(2)}</td>
      <td data-label="Var."><span class="chg-pill ${cls}">${sign}${pct.toFixed(2)}%</span></td>
      <td data-label="Máx Dia" class="mono price-up" style="font-size:11px">R$${dayHigh.toFixed(2)}</td>
      <td data-label="Mín Dia" class="mono price-dn"  style="font-size:11px">R$${dayLow.toFixed(2)}</td>
      <td data-label="Volume" class="mono" style="font-size:10px;color:var(--text3)">${fmtN(s.volume)}</td>
      <td data-label="D/O"><div class="dbar"><div class="dbar-fill" style="width:${dr*100}%;background:${dr>.5?'var(--green2)':'var(--red2)'}"></div></div></td>
      <td data-label="Cotas">
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">${((s.buys - s.sells > 0 ? s.buys - s.sells : 0) / s.shares * 100).toFixed(3)}% negociado</div>
        <div class="dbar" style="width:90px;max-width:100%"><div class="dbar-fill" style="width:${Math.min(100,(s.buys+s.sells)/s.shares*100*20)}%;background:var(--gold)"></div></div>
      </td>
      <td class="td-actions" data-label=""><button class="btn btn-dark btn-sm" onclick="event.stopPropagation();goTrade('${s.sym}')">Negociar</button></td>
    </tr>`;
  }).join('');
}

function selectStock(sym) {
  selectedSym = sym;
  document.getElementById('chart-reset-btn').style.display = '';
  document.getElementById('chart-label').textContent = sym + ' — Tempo Real';
  updateOrderBook();
  refreshChartHistory(sym);
}

function showMarketChart() {
  selectedSym = null;
  document.getElementById('chart-label').textContent = 'Mercado Geral';
  document.getElementById('chart-reset-btn').style.display = 'none';
  updateOrderBook();
  updateMainChart();
}

function updateOrderBook() {
  const s = stocks.find(x => x.sym === selectedSym);
  if (!s) {
    document.getElementById('ob-asks').innerHTML = '';
    document.getElementById('ob-spread').textContent = 'SELECIONE UM ATIVO';
    document.getElementById('ob-bids').innerHTML = '';
    return;
  }
  const asks = [], bids = [];
  for (let i = 0; i < 5; i++) {
    asks.push({ p: s.price * (1 + .001 * (i + 1)), q: Math.floor(Math.random() * 400 + 50) });
    bids.push({ p: s.price * (1 - .001 * (i + 1)), q: Math.floor(Math.random() * 400 + 50) });
  }
  asks.reverse();
  document.getElementById('ob-asks').innerHTML = asks.map(a =>
    `<div class="ob-row ask"><span>R$${a.p.toFixed(2)}</span><span>${a.q}</span><span>R$${fmtN(a.p*a.q)}</span></div>`).join('');
  document.getElementById('ob-spread').textContent = `SPREAD R$${(asks[0].p - bids[0].p).toFixed(3)}`;
  document.getElementById('ob-bids').innerHTML = bids.map(b =>
    `<div class="ob-row bid"><span>R$${b.p.toFixed(2)}</span><span>${b.q}</span><span>R$${fmtN(b.p*b.q)}</span></div>`).join('');
}

function updateMktBadge(open) {
  const b = document.getElementById('mkt-status');
  b.textContent = open ? '● ABERTO' : '● FECHADO';
  b.className = 'mkt-pill ' + (open ? 'open' : 'closed');
}

function updateTicker() {
  const items = [...stocks, ...stocks].map(s => {
    const pct = ((s.price - s.open) / s.open * 100);
    const cls = pct >= 0 ? 'up' : 'dn';
    return `<span class="ti"><span class="ti-sym">${s.sym}</span><span class="ti-price">R$${s.price.toFixed(2)}</span><span class="ti-chg ${cls}">${pct>=0?'+':''}${pct.toFixed(2)}%</span></span>`;
  }).join('<span style="color:var(--border2);margin:0 4px">◆</span>');
  document.getElementById('ticker').innerHTML = items;
}

// ── CHART ──
function _chartColors() {
  const t = document.documentElement.getAttribute('data-theme') || 'default';
  const isLight = t === 'light';
  return {
    line:      '#c9a84c',
    up:        isLight ? '#249653' : '#27ae60',
    down:      isLight ? '#b03025' : '#c0392b',
    bgFill:    () => { const g = mainChart?.ctx?.createLinearGradient?.(0,0,0,255); g?.addColorStop(0,isLight?'rgba(166,138,62,.1)':'rgba(201,168,76,.12)'); g?.addColorStop(1,'rgba(201,168,76,0)'); return g; },
    grid:      isLight ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.04)',
    tick:      isLight ? '#7a7368' : '#5a5570',
    tooltipBg: isLight ? '#ffffff' : '#131318',
    tooltipBd: isLight ? '#d6d2ca'  : '#2a2a3a',
    titleC:    isLight ? '#7a6228'  : '#c9a84c',
    bodyC:     isLight ? '#1a1815'  : '#e8e6f0',
  };
}

function buildChart() {
  const c = _chartColors();
  const ctx = document.getElementById('mainChart').getContext('2d');
  mainChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: c.line, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: () => c.bgFill(), tension: .3 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'R$' + c.parsed.y.toFixed(2) }, backgroundColor: c.tooltipBg, borderColor: c.tooltipBd, borderWidth: 1, titleColor: c.titleC, bodyColor: c.bodyC } },
      scales: {
        x: { grid: { color: c.grid }, ticks: { color: c.tick, font: { size: 9 } } },
        y: { grid: { color: c.grid }, ticks: { color: c.tick, font: { size: 9 }, callback: v => 'R$' + v.toFixed(0) }, position: 'right' }
      }
    }
  });
}

function updateMainChart() {
  if (!mainChart || !selectedSym) return;
  const c = _chartColors();
  const hist = priceHistory[selectedSym] || [];
  const s    = stocks.find(x => x.sym === selectedSym);
  mainChart.data.labels = hist.map((_, i) => i === hist.length - 1 ? 'agora' : '');
  mainChart.data.datasets[0].data = hist; // plain number[]
  const up = !s || s.price >= s.open;
  mainChart.data.datasets[0].borderColor = up ? c.up : c.down;
  // Update tooltip/theme colors if theme changed
  mainChart.options.plugins.tooltip.backgroundColor = c.tooltipBg;
  mainChart.options.plugins.tooltip.borderColor      = c.tooltipBd;
  mainChart.options.plugins.tooltip.titleColor        = c.titleC;
  mainChart.options.plugins.tooltip.bodyColor         = c.bodyC;
  mainChart.options.scales.x.grid.color = c.grid;
  mainChart.options.scales.y.grid.color = c.grid;
  mainChart.options.scales.x.ticks.color = c.tick;
  mainChart.options.scales.y.ticks.color = c.tick;
  mainChart.update('none');
}

// ── NAV ──
function showPage(pg) {
  if (pg === 'p2p') pg = 'admin';
  if (pg === 'admin' && !canAccessAdmin()) {
    showPage('market');
    return;
  }
  if (pg === 'dev' && !canAccessDev()) {
    showPage('market');
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.hn-btn,.bottom-nav-btn').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('p-' + pg);
  if (!page) return;
  page.classList.add('active');
  document.querySelector(`.hn-btn[data-page="${pg}"]`)?.classList.add('active');
  document.querySelector(`.bottom-nav-btn[data-page="${pg}"]`)?.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (pg === 'trade')     renderTradePage();
  if (pg === 'portfolio') renderPortfolio();
  if (pg === 'ranking')   renderRanking();
  if (pg === 'profile')   renderProfile();
  if (pg === 'admin')     renderAdmin();
  if (pg === 'dev')       renderDev();
}

function roleSelectOptions(currentRole) {
  // 'dev' can only be granted via direct database edit — not through the admin panel
  const roles = ['user', 'moderator', 'admin'];
  return roles.map(r =>
    `<option value="${r}" ${currentRole === r ? 'selected' : ''}>${r}</option>`
  ).join('');
}

// ── TRADE ──
function goTrade(sym) { selectedSym = sym; showPage('trade'); }

function renderTradePage() {
  const sel = document.getElementById('trade-sym');
  sel.innerHTML = stocks.map(s =>
    `<option value="${s.sym}" ${s.sym === selectedSym ? 'selected' : ''}>${s.sym} — ${s.name}</option>`).join('');
  setOT(orderType);
  updateTradeInfo();
  renderTradeHist();
}

function setOT(t) {
  orderType = t;
  document.getElementById('btn-buy').className  = 'btn ' + (t === 'buy'  ? 'btn-g'    : 'btn-ghost');
  document.getElementById('btn-sell').className = 'btn ' + (t === 'sell' ? 'btn-r'    : 'btn-ghost');
  updateTradeTotal();
}

function updateTradeInfo() {
  const sym = document.getElementById('trade-sym')?.value;
  if (!sym) return;
  selectedSym = sym;
  const s = stocks.find(x => x.sym === sym);
  if (!s) return;
  const pct = ((s.price - s.open) / s.open * 100);
  document.getElementById('td-price').textContent = 'R$' + s.price.toFixed(2);
  document.getElementById('td-bal').textContent   = 'R$' + (CU.balance || 0).toFixed(2);
  // Daily reference prices — fall back to current price if not yet set
  const ref = (val, fallback) => (val != null) ? val : fallback;
  const dOpen = ref(s.dayOpen, s.price);
  const dHigh = ref(s.dayHigh, s.price);
  const dLow  = ref(s.dayLow,  s.price);

  document.getElementById('trade-info').innerHTML = `
    <div style="margin-bottom:12px">
      <div style="font-family:'Playfair Display',serif;font-size:17px;font-weight:700;font-style:italic;margin-bottom:4px">${s.name}</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:10px">${s.desc || 'Sem descrição.'}</div>
      <div style="display:flex;align-items:baseline;gap:10px">
        <span class="mono" style="font-size:22px">${s.price.toFixed(2)}</span>
        <span class="${pct>=0?'price-up':'price-dn'}" style="font-size:12px">${pct>=0?'+':''}${pct.toFixed(2)}%</span>
      </div>
    </div>
    <div class="grid2" style="gap:6px;margin-bottom:10px">
      <div style="background:var(--s2);padding:8px;border:1px solid var(--border);border-radius:4px"><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Abertura</div><div class="mono" style="font-size:12px">R$${dOpen.toFixed(2)}</div></div>
      <div style="background:var(--s2);padding:8px;border:1px solid var(--border);border-radius:4px"><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Máx Dia</div><div class="mono price-up" style="font-size:12px">R$${dHigh.toFixed(2)}</div></div>
      <div style="background:var(--s2);padding:8px;border:1px solid var(--border);border-radius:4px"><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Mín Dia</div><div class="mono price-dn" style="font-size:12px">R$${dLow.toFixed(2)}</div></div>
      <div style="background:var(--s2);padding:8px;border:1px solid var(--border);border-radius:4px"><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Em Carteira</div><div class="mono" style="font-size:12px" id="owned-count">—</div></div>
      <div style="background:var(--s2);padding:8px;border:1px solid var(--border);border-radius:4px"><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Volume</div><div class="mono" style="font-size:12px">${fmtN(s.volume)}</div></div>
      <div style="background:var(--s2);padding:8px;border:1px solid var(--border);border-radius:4px"><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Status</div><span class="status-badge ${s.status}">${s.status==='active'?'Ativa':'Suspensa'}</span></div>
    </div>
    <div style="font-size:9px;color:var(--text3);letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Demanda vs Oferta</div>
    <div style="display:flex;gap:6px;align-items:center;font-size:10px">
      <span style="color:var(--green2)">D ${(s.demand*100).toFixed(0)}%</span>
      <div style="flex:1;height:5px;background:var(--s3);border-radius:2px;overflow:hidden"><div style="width:${s.demand/(s.demand+s.supply)*100}%;height:100%;background:linear-gradient(90deg,var(--green2),var(--red2))"></div></div>
      <span style="color:var(--red2)">O ${(s.supply*100).toFixed(0)}%</span>
    </div>
  `;
  // load owned count + % of company
  GET('market/portfolio').then(data => {
    const owned = (data.portfolio || {})[sym] || 0;
    const el = document.getElementById('owned-count');
    if (el && s) {
      const pctCompany = (owned / s.shares * 100);
      el.innerHTML = owned + ' cotas' +
        (owned > 0 ? '<br><span style="font-size:9px;color:var(--gold)">' + pctCompany.toFixed(4) + '% da empresa</span>' : '');
    }
  }).catch(() => {});
  updateTradeTotal();
}

function updateTradeTotal() {
  const sym = document.getElementById('trade-sym')?.value;
  const s   = stocks.find(x => x.sym === sym);
  const qty = parseInt(document.getElementById('trade-qty')?.value) || 0;
  document.getElementById('td-total').textContent = (s && qty) ? 'R$' + (s.price * qty).toFixed(2) : '—';
}

async function executeOrder() {
  const btn = document.getElementById('exec-btn');
  return withActionLock('executeOrder', async () => {
    const sym = document.getElementById('trade-sym').value;
    const qty = parseInt(document.getElementById('trade-qty').value) || 0;
    setBtnBusy(btn, true, 'Executando…');
    try {
      const data = await POST('market/order', { sym, type: orderType, qty });
      CU.balance = data.user.balance;
      document.getElementById('td-bal').textContent = 'R$' + CU.balance.toFixed(2);
      showMsg('trade-msg', `✓ ${orderType==='buy'?'Compra':'Venda'}: ${qty}× ${sym} — R$${data.tx.total.toFixed(2)}`, 'ok');
      renderTradeHist();
      updateTradeInfo();
    } catch(e) { showMsg('trade-msg', e.message, 'err'); }
    finally { setBtnBusy(btn, false); }
  });
}

async function renderTradeHist() {
  try {
    const { transactions } = await GET('market/portfolio');
    const txs = (transactions || []).reverse().slice(0, 30);
    document.getElementById('orders-ct').textContent = txs.length;
    document.getElementById('trade-hist').innerHTML = txs.length
      ? txs.map(t => `<div class="hist-item">
          <span class="hist-badge ${t.type}">${t.type==='buy'?'COMPRA':'VENDA'}</span>
          <span style="font-weight:600">${t.sym}</span>
          <span style="color:var(--text3)">${t.qty}×</span>
          <span class="mono" style="font-size:10px">R$${t.price.toFixed(2)}</span>
          <span class="mono ${t.type==='buy'?'price-dn':'price-up'}" style="margin-left:auto;font-size:11px">R$${t.total.toFixed(2)}</span>
          <span style="color:var(--text3);font-size:9px">${t.time}</span>
        </div>`).join('')
      : '<p style="color:var(--text3);font-size:12px;padding:10px 0">Sem ordens.</p>';
  } catch(e) {}
}

// ── PORTFOLIO ──
async function renderPortfolio() {
  const gen = ++_pageLoadGen;
  setPageLoading('portfolio', true);
  document.getElementById('pf-stats').innerHTML = '<p class="page-hint">Carregando carteira…</p>';
  try {
    const { user, portfolio, transactions } = await GET('market/portfolio');
    if (gen !== _pageLoadGen) return;
    CU.balance = user.balance;
    const pf = portfolio || {};
    let mv = 0;
    Object.entries(pf).forEach(([sym, qty]) => {
      const s = stocks.find(x => x.sym === sym);
      if (s) mv += s.price * qty;
    });
    const total = CU.balance + mv;
    const txs = (transactions || []);
    document.getElementById('pf-stats').innerHTML = `
      <div class="stat"><div class="stat-label">Saldo Cash</div><div class="stat-val serif">R$${fmtN(CU.balance)}</div></div>
      <div class="stat"><div class="stat-label">Em Ações</div><div class="stat-val serif">R$${fmtN(mv)}</div></div>
      <div class="stat"><div class="stat-label">Patrimônio</div><div class="stat-val gold serif">R$${fmtN(total)}</div></div>
      <div class="stat"><div class="stat-label">Operações</div><div class="stat-val serif">${txs.length}</div><div class="stat-sub">C:${txs.filter(t=>t.type==='buy').length} V:${txs.filter(t=>t.type==='sell').length}</div></div>
    `;
    const pfArr = Object.entries(pf).filter(([, q]) => q > 0);
    document.getElementById('pf-assets').innerHTML = pfArr.length
      ? pfArr.map(([sym, qty]) => {
          const s = stocks.find(x => x.sym === sym);
          if (!s) return '';
          const val = s.price * qty;
          const pl = (s.price - s.open) * qty;
          return `<div class="pf-item">
            <span class="sym-tag">${sym}</span>
            <div style="flex:1;margin-left:10px"><div style="font-weight:600;font-size:12px">${s.name}</div><div style="font-size:10px;color:var(--text3)">${qty} cotas</div></div>
            <div style="text-align:right"><div class="mono" style="font-size:13px">R$${val.toFixed(2)}</div><div class="${pl>=0?'price-up':'price-dn'} mono" style="font-size:10px">${pl>=0?'+':''}R$${pl.toFixed(2)}</div></div>
            <button class="btn btn-r btn-sm" style="margin-left:10px" onclick="goTrade('${sym}');setOT('sell')">Vender</button>
          </div>`;
        }).join('')
      : '<p style="color:var(--text3);font-size:12px;padding:10px 0">Nenhum ativo.</p>';
    const allTx = [...txs].reverse();
    document.getElementById('pf-hist').innerHTML = allTx.length
      ? allTx.map(t => `<div class="hist-item">
          <span class="hist-badge ${t.type}">${t.type==='buy'?'C':'V'}</span>
          <span style="font-weight:600;font-size:11px">${t.sym}</span>
          <span style="color:var(--text3);font-size:10px">${t.qty}× R$${t.price.toFixed(2)}</span>
          <span class="mono ${t.type==='buy'?'price-dn':'price-up'}" style="margin-left:auto;font-size:10px">R$${t.total.toFixed(2)}</span>
          <span style="color:var(--text3);font-size:9px">${t.time}</span>
        </div>`).join('')
      : '<p style="color:var(--text3);font-size:12px;padding:10px 0">Sem histórico.</p>';
  } catch(e) { console.error(e); }
  finally { if (gen === _pageLoadGen) setPageLoading('portfolio', false); }
}

// ── RANKING ──
async function renderRanking() {
  const gen = ++_pageLoadGen;
  setPageLoading('ranking', true);
  const loading = '<p class="page-hint">Carregando ranking…</p>';
  document.getElementById('rank-inv').innerHTML = loading;
  document.getElementById('rank-sd').innerHTML = loading;
  document.getElementById('rank-top').innerHTML = loading;
  try {
    const { investors, supplyDemand, topTraded } = await GET('market/ranking');
    if (gen !== _pageLoadGen) return;
    const medals = ['r1', 'r2', 'r3'];
    document.getElementById('rank-inv').innerHTML = investors.map((r, i) => {
      const avHtml = userAvatarHtml(r, { wrapClass: 'rank-av' });
      return `<div class="rank-row" onclick="openProfileModal('${r.id}')" style="cursor:pointer" title="Ver perfil">
        <div class="rank-n ${medals[i]||''} serif">${i+1}</div>
        ${avHtml}
        <div style="flex:1">
          <div style="font-weight:600;font-size:13px" class="${getFontClass()}">${r.name} <span style="font-size:10px;color:var(--text3)">${formatCountry(r.country)}</span></div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
            <span class="badge-tip"><span class="tier-badge ${r.wealthTier}" style="color:${tierColorStr(r.wealthTier)}">${tierBadge(r.wealthTier)} ${tierName(r.wealthTier)}</span><span class="tip-bubble">${tierTooltip(r.wealthTier)}</span></span>
            ${r.role !== 'user' ? `<span class="badge-tip"><span class="role-badge ${r.role}">${roleLabel(r.role)}</span></span>` : ''}${supporterBadge(r)}
          </div>
          <div style="font-size:10px;color:var(--text3)">Cash R$${fmtN(r.cash)}</div>
        </div>
        <div class="mono gold" style="font-size:13px">R$${fmtN(r.total)}</div>
      </div>`;
    }).join('');
    document.getElementById('rank-sd').innerHTML = supplyDemand.slice(0,5).map((s, i) => {
      const rat = s.demand / (s.demand + s.supply);
      return `<div class="rank-row">
        <div class="rank-n ${medals[i]||''} serif">${i+1}</div>
        <div style="flex:1"><div class="sym-tag" style="font-size:11px">${s.sym}</div><div style="font-size:10px;color:var(--text3);margin-top:2px">${(rat*100).toFixed(0)}% demanda</div></div>
        <div class="${rat>.5?'price-up':'price-dn'} mono" style="font-size:13px">${(rat*100).toFixed(1)}%</div>
      </div>`;
    }).join('');
    document.getElementById('rank-top').innerHTML = topTraded.slice(0,5).map((s, i) =>
      `<div class="rank-row">
        <div class="rank-n ${medals[i]||''} serif">${i+1}</div>
        <div style="flex:1"><div class="sym-tag" style="font-size:11px">${s.sym}</div><div style="font-size:10px;color:var(--text3);margin-top:2px">${fmtN(s.volume)} cotas</div></div>
        <div class="mono" style="font-size:12px">R$${fmtN(s.volume*s.price)}</div>
      </div>`
    ).join('');
  } catch(e) { console.error(e); }
  finally { if (gen === _pageLoadGen) setPageLoading('ranking', false); }
}

// ── PROFILE ──
function renderProfile() {
  editAvatar = normalizeAvatar(CU.avatar);
  const photoSrc = userPhotoSrc(CU);
  const emoji = normalizeAvatar(CU.avatar);
  const photoHtml = photoSrc
    ? `<img src="${photoWithBust(photoSrc)}" alt="${emoji}" onerror="this.replaceWith(document.createTextNode(this.alt))">`
    : emoji;
  document.getElementById('prof-hero').innerHTML = `
    <div class="profile-photo" onclick="document.getElementById('photo-input').click()" title="Clique para trocar foto">
      ${photoHtml}
      <div class="ph-overlay">📷 Trocar</div>
    </div>
    <div>
      <div class="profile-name-big">${CU.nick || CU.name}</div>
      <div style="font-size:12px;color:var(--text3)">${CU.name} · ${formatCountry(CU.country)}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">
        <span class="badge-tip"><span class="tier-badge ${CU.wealthTier || 'investidor'}" style="color:${tierColorStr(CU.wealthTier || 'investidor')}">${tierBadge(CU.wealthTier || 'investidor')} ${tierName(CU.wealthTier || 'investidor')}</span><span class="tip-bubble">${tierTooltip(CU.wealthTier || 'investidor')}</span></span>
        ${CU.role !== 'user' ? `<span class="badge-tip"><span class="role-badge ${CU.role}">${roleLabel(CU.role)}</span></span>` : ''}${supporterBadge(CU)}
      </div>
      ${CU.bio ? `<div style="font-size:11px;color:var(--text2);margin-top:6px;font-style:italic">"${CU.bio}"</div>` : ''}
    </div>
    <div style="margin-left:auto;text-align:right">
      <div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Saldo</div>
      <div class="serif gold" style="font-size:26px">R$${fmtN(CU.balance)}</div>
    </div>
  `;
  document.getElementById('edit-name').value = CU.name || '';
  document.getElementById('edit-nick').value = CU.nick || '';
  document.getElementById('edit-bio').value  = CU.bio  || '';
  const csel = document.getElementById('edit-country');
  const countryVal = countryNameOnly(CU.country);
  for (let o of csel.options) o.selected = (o.value === countryVal);
  buildAvatarGrid('edit-av-grid', a => editAvatar = a, normalizeAvatar(CU.avatar));

  // Font selector
  const fSel = document.getElementById('edit-font-select');
  if (fSel) {
    fSel.value = localStorage.getItem('corleone-font-preference') || '';
    fSel.addEventListener('change', function() {
      localStorage.setItem('corleone-font-preference', this.value);
      // Re-render all badges so font class updates everywhere
      renderProfile();
      if (document.getElementById('rank-inv')) renderRanking();
    });
  }

  // Stats + pie chart + dividends — load in parallel (portfolio failure must not break profile)
  Promise.all([
    GET('market/portfolio').catch(() => ({ transactions: [], portfolio: {} })),
    GET('users/me/dividends').catch(() => ({ dividends: [], total: 0, ownedStocks: [], founded: [], myListings: [] }))
  ]).then(([pfData, divData]) => {
    const txs = pfData.transactions || [];
    const pf  = pfData.portfolio   || {};
    const founded = divData.founded || divData.ownedStocks || [];

    document.getElementById('prof-stats').innerHTML = `
      <div style="display:grid;gap:8px">
        <div style="background:var(--s2);padding:12px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Total Operações</div><div class="stat-val serif">${txs.length}</div></div>
        <div style="background:var(--s2);padding:12px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Compras / Vendas</div><div class="stat-val serif"><span class="green">${txs.filter(t=>t.type==='buy').length}</span> / <span class="red">${txs.filter(t=>t.type==='sell').length}</span></div></div>
        <div style="background:var(--s2);padding:12px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Membro desde</div><div class="mono" style="font-size:12px;color:var(--text2)">${new Date(CU.joined||Date.now()).toLocaleDateString('pt-BR')}</div></div>
        ${founded.length ? `<div style="background:var(--gold-dim);padding:12px;border:1px solid rgba(201,168,76,.3);border-radius:4px"><div class="stat-label">Participações em empresas</div><div class="stat-val gold serif">${founded.length}</div><div style="font-size:10px;color:var(--gold);margin-top:2px">${founded.map(f=>f.sym).join(', ')}</div></div>` : ''}
      </div>
    `;

    renderPieChart(pf);
    renderDividends(divData);

  }).catch(e => console.error(e));
}

function renderPieChart(pf) {
  const c = _chartColors();
  const pfArr = Object.entries(pf).filter(([, q]) => q > 0);
  const canvas = document.getElementById('pieChart');
  const empty  = document.getElementById('pie-empty');
  const legend = document.getElementById('pie-legend');

  if (!pfArr.length) {
    if (canvas) canvas.style.display = 'none';
    if (empty)  empty.style.display  = 'block';
    if (legend) legend.innerHTML = '';
    return;
  }
  if (canvas) canvas.style.display = 'block';
  if (empty)  empty.style.display  = 'none';

  // Build data: % ownership of each company
  const COLORS = [
    '#c9a84c','#27ae60','#2980b9','#8e44ad','#e74c3c',
    '#e67e22','#1abc9c','#f39c12','#3498db','#e91e63'
  ];

  const labels  = [];
  const data    = [];
  const colors  = [];
  const details = [];

  pfArr.forEach(([sym, qty], i) => {
    const s = stocks.find(x => x.sym === sym);
    if (!s) return;
    const pctCompany = qty / s.shares * 100;
    const val = s.price * qty;
    labels.push(sym);
    data.push(parseFloat(pctCompany.toFixed(6)));
    colors.push(COLORS[i % COLORS.length]);
    details.push({ sym, name: s.name, qty, pctCompany, val });
  });

  if (pieChart) { pieChart.destroy(); pieChart = null; }

  const ctx = canvas.getContext('2d');
  pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors.map(c => c + 'cc'),
        borderColor:     colors,
        borderWidth: 1.5,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const d = details[ctx.dataIndex];
              return [
                ` ${d.qty} cotas`,
                ` ${d.pctCompany.toFixed(4)}% da empresa`,
                ` Val: R$${d.val.toFixed(2)}`
              ];
            }
          },
          backgroundColor: c.tooltipBg,
          borderColor: c.tooltipBd,
          borderWidth: 1,
          titleColor: c.titleC,
          bodyColor: c.bodyC,
          padding: 10
        }
      }
    }
  });

  // Custom legend
  legend.innerHTML = details.map((d, i) => `
    <div style="display:flex;align-items:center;gap:5px;font-size:10px;padding:3px 6px;background:var(--s2);border-radius:3px;border:1px solid var(--border)">
      <span style="width:8px;height:8px;border-radius:50%;background:${colors[i]};flex-shrink:0;display:inline-block"></span>
      <span class="mono" style="color:var(--gold3)">${d.sym}</span>
      <span style="color:var(--text3)">${d.pctCompany.toFixed(4)}%</span>
    </div>
  `).join('');
}

function renderDividends(divData) {
  if (!divData) return;
  const badge = document.getElementById('div-total-badge');
  if (badge) badge.textContent = 'R$' + fmtN(divData.total || 0);

  const divHist = document.getElementById('div-history');
  if (divHist) {
    divHist.innerHTML = (divData.dividends || []).length
      ? (divData.dividends || []).map(d => `
        <div class="hist-item">
          <span class="hist-badge buy" style="background:rgba(201,168,76,.15);color:var(--gold);border-color:rgba(201,168,76,.3)">TAXA</span>
          <span class="sym-tag" style="font-size:10px">${d.sym}</span>
          <span style="color:var(--text3);font-size:10px">${d.traderName}</span>
          <span style="color:var(--text3);font-size:9px">${d.type==='buy'?'comprou':'vendeu'}</span>
          <span class="mono gold" style="margin-left:auto;font-size:11px">+R$${d.fee.toFixed(2)}</span>
          <span style="color:var(--text3);font-size:9px">${d.time}</span>
        </div>
      `).join('')
      : '<p style="color:var(--text3);font-size:12px;padding:10px 0">Nenhum dividendo ainda.</p>';
  }

  const divCreated = document.getElementById('div-created');
  const founded = divData.founded || divData.ownedStocks || [];
  if (divCreated && founded.length) {
    divCreated.innerHTML = `
      <div class="card-title" style="border:none;padding:0;margin-bottom:8px">🏭 Participações em empresas</div>
      ${founded.map(f => `
        <div class="pf-item" style="margin-bottom:6px">
          <span class="sym-tag">${f.sym}</span>
          <div style="flex:1;margin-left:10px">
            <div style="font-size:12px;font-weight:600">${f.name}</div>
            <div style="font-size:10px;color:var(--text3)">Taxa: ${(f.founderFee*100).toFixed(1)}% por trade</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:9px;color:var(--text3)">Receita total</div>
            <div class="mono gold" style="font-size:13px">R$${fmtN(f.totalRevenue)}</div>
          </div>
        </div>
      `).join('')}
    `;
  } else if (divCreated) {
    divCreated.innerHTML = '';
  }
}

async function saveProfile() {
  const name    = document.getElementById('edit-name').value.trim();
  const nick    = document.getElementById('edit-nick').value.trim();
  const bio     = document.getElementById('edit-bio').value.trim();
  const country = document.getElementById('edit-country').value;
  try {
    const body = { nick, bio, country, avatar: editAvatar };
    if (name) body.name = name;
    const { user } = await PUT('users/me', body);
    CU = { ...CU, ...user };
    editAvatar = normalizeAvatar(CU.avatar);
    updateHeaderUser();
    refreshRankingIfActive();
    showMsg('prof-msg', '✓ Perfil salvo!', 'ok');
    renderProfile();
  } catch(e) { showMsg('prof-msg', e.message, 'err'); }
}

async function uploadPhoto(input) {
  const file = input.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('photo', file);
  try {
    const r = await fetch('/api/users/me/photo', { method: 'POST', credentials: 'include', body: formData });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401) throw new Error('Sessão expirada. Faça login novamente.');
      throw new Error(data.error || `Erro ao enviar foto (${r.status})`);
    }
    CU.photo = data.photo || CU.photo;
    CU.photoDisplay = data.photoDisplay || CU.photoDisplay;
    try {
      const me = await GET('auth/me');
      CU = { ...CU, ...me };
    } catch (_) {}
    updateHeaderUser();
    refreshRankingIfActive();
    showMsg('prof-msg', '✓ Foto atualizada!', 'ok');
    renderProfile();
  } catch(e) { showMsg('prof-msg', e.message, 'err'); }
  finally { input.value = ''; }
}

async function removePhoto() {
  try {
    const r = await fetch('/api/users/me/photo', { method: 'DELETE', credentials: 'include' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || 'Não foi possível remover a foto.');
    }
    CU.photo = null;
    CU.photoDisplay = null;
    try {
      const me = await GET('auth/me');
      CU = { ...CU, ...me };
    } catch (_) {}
    editAvatar = normalizeAvatar(CU.avatar);
    updateHeaderUser();
    refreshRankingIfActive();
    showMsg('prof-msg', 'Foto removida — usando emoji.', 'ok');
    renderProfile();
  } catch(e) { showMsg('prof-msg', e.message, 'err'); }
}

// ── P2P OWNERSHIP MARKETPLACE ──
function mountOwnershipPanelInAdmin() {
  const source = document.getElementById('p-p2p');
  const target = document.getElementById('admin-ownership-content');
  if (!source || !target || target.dataset.mounted === '1') return;
  while (source.firstChild) target.appendChild(source.firstChild);
  target.dataset.mounted = '1';
}

async function renderP2PPage() {
  try {
    const [pfData, offersData] = await Promise.all([
      GET('market/portfolio'),
      GET('market/ownership-offers')
    ]);
    const pf = pfData.portfolio || {};

    // My ownership positions
    const myOwned = stocks.filter(s => {
      const os = s.ownershipShares || {};
      return os[CU.id] && os[CU.id] > 0;
    });

    document.getElementById('my-ownership-list').innerHTML = myOwned.length
      ? myOwned.map(s => {
          const myPct = (s.ownershipShares||{})[CU.id] || 0;
          const owner = (s.owners||[]).find(o => o.userId === CU.id);
          const feePct = owner ? owner.pct : 0;
          const totalRev = s.totalRevenue || 0;
          const myShare = totalRev * feePct / (s.owners||[]).reduce((a,o)=>a+o.pct,feePct||1);
          return `<div class="pf-item" style="flex-direction:column;align-items:flex-start;gap:6px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:10px;width:100%">
              <span class="sym-tag">${s.sym}</span>
              <div style="flex:1"><div style="font-weight:600;font-size:12px">${s.name}</div><div style="font-size:10px;color:var(--text3)">${s.sector}</div></div>
              <div style="text-align:right">
                <div style="font-size:9px;color:var(--text3)">Sua participação</div>
                <div class="mono gold" style="font-size:14px">${myPct.toFixed(4)}%</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;font-size:10px;width:100%">
              <div style="background:var(--s3);padding:4px 8px;border-radius:3px;flex:1;text-align:center">
                <div style="color:var(--text3)">Taxa/trade</div><div class="mono gold">${feePct.toFixed(3)}%</div>
              </div>
              <div style="background:var(--s3);padding:4px 8px;border-radius:3px;flex:1;text-align:center">
                <div style="color:var(--text3)">Vol. total</div><div class="mono">${fmtN(s.volume)} cotas</div>
              </div>
              <div style="background:var(--s3);padding:4px 8px;border-radius:3px;flex:1;text-align:center">
                <div style="color:var(--text3)">Receita total empresa</div><div class="mono green">R$${fmtN(totalRev)}</div>
              </div>
            </div>
          </div>`;
        }).join('')
      : '<p style="color:var(--text3);font-size:12px;padding:8px 0">Você não tem participações em nenhuma empresa.</p>';

    // Populate sell selector
    const sellSel = document.getElementById('sell-own-sym');
    sellSel.innerHTML = '<option value="">— Selecionar —</option>' +
      myOwned.map(s => `<option value="${s.sym}">${s.sym} — ${s.name}</option>`).join('');

    // Ownership market
    const offers = offersData || [];
    document.getElementById('offers-ct').textContent = offers.length;
    document.getElementById('ownership-market-list').innerHTML = offers.length
      ? offers.map(o => {
          const isMine = o.sellerId === CU.id;
          return `<div style="background:var(--s2);border:1px solid var(--border);border-radius:4px;padding:12px;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <span class="sym-tag">${o.sym}</span>
              <div style="flex:1">
                <div style="font-weight:600;font-size:12px">${o.stockName}</div>
                <div style="font-size:10px;color:var(--text3)">Vendido por <span style="color:var(--text2)">${o.sellerName}</span></div>
              </div>
              <div style="text-align:right">
                <div style="font-size:9px;color:var(--text3)">Preço pedido</div>
                <div class="mono gold" style="font-size:15px">R$${o.askPrice.toFixed(2)}</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;font-size:10px;margin-bottom:10px">
              <div style="background:var(--s3);padding:4px 8px;border-radius:3px;flex:1;text-align:center">
                <div style="color:var(--text3)">Participação</div><div class="mono gold">${o.pct.toFixed(4)}%</div>
              </div>
              <div style="background:var(--s3);padding:4px 8px;border-radius:3px;flex:1;text-align:center">
                <div style="color:var(--text3)">Taxa/trade incluída</div><div class="mono">${o.pct.toFixed(4)}% do volume</div>
              </div>
            </div>
            <div style="display:flex;gap:8px">
              ${!isMine
                ? `<button class="btn btn-gold btn-sm" style="flex:1" onclick="buyOwnershipOffer('${o.id}', '${o.sym}', ${o.askPrice}, ${o.pct})">Comprar Participação</button>`
                : `<span style="font-size:11px;color:var(--text3);flex:1;display:flex;align-items:center">Sua oferta</span>`}
              ${isMine ? `<button class="btn btn-ghost btn-sm" onclick="cancelOwnershipOffer('${o.id}')">Cancelar</button>` : ''}
            </div>
          </div>`;
        }).join('')
      : '<p style="color:var(--text3);font-size:12px;padding:10px 0">Nenhuma participação à venda no momento.</p>';

  } catch(e) { console.error(e); }
}

function updateSellOwnershipInfo() {
  const sym = document.getElementById('sell-own-sym').value;
  const pctInp = document.getElementById('sell-own-pct');
  const infoEl = document.getElementById('sell-own-info');
  if (!sym) { infoEl.innerHTML = ''; return; }
  const s = stocks.find(x => x.sym === sym);
  if (!s) return;
  const myPct = (s.ownershipShares||{})[CU.id] || 0;
  const inputPct = parseFloat(pctInp?.value) || 0;
  infoEl.innerHTML = `
    <div style="background:var(--s2);border:1px solid var(--border);border-radius:4px;padding:10px;font-size:11px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="color:var(--text3)">Sua participação atual</span>
        <span class="mono gold">${myPct.toFixed(4)}%</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:var(--text3)">Ficará com</span>
        <span class="mono">${Math.max(0, myPct - inputPct).toFixed(4)}%</span>
      </div>
      ${myPct <= 0 ? '<div style="color:var(--red2);margin-top:6px">Você não tem participação nessa empresa.</div>' : ''}
    </div>
  `;
}

async function createOwnershipOffer() {
  return withActionLock('createOwnershipOffer', async () => {
    const sym      = document.getElementById('sell-own-sym').value;
    const pctToSell = document.getElementById('sell-own-pct').value;
    const askPrice = document.getElementById('sell-own-price').value;
    try {
      await POST('market/ownership-offers', { sym, pctToSell, askPrice });
      showMsg('sell-own-msg', '✓ Oferta publicada!', 'ok');
      adminOwnershipReady = false;
      await renderP2PPage();
      adminOwnershipReady = true;
    } catch(e) { showMsg('sell-own-msg', e.message, 'err'); }
  });
}

async function buyOwnershipOffer(offerId, sym, price, pct) {
  if (!confirm(`Comprar ${pct.toFixed(4)}% de participação em ${sym} por R$${price.toFixed(2)}?\n\nVocê passará a receber ${pct.toFixed(4)}% do volume de cada trade nessa ação.`)) return;
  return withActionLock('buyOwnership:' + offerId, async () => {
    try {
      const { user } = await POST(`market/ownership-offers/${offerId}/buy`);
      CU.balance = user.balance;
      showMsg('sell-own-msg', `✓ Participação adquirida! Agora você recebe ${pct.toFixed(4)}% dos trades em ${sym}.`, 'ok');
      adminOwnershipReady = false;
      await renderP2PPage();
      adminOwnershipReady = true;
    } catch(e) { alert(e.message); }
  });
}

async function cancelOwnershipOffer(offerId) {
  if (!confirm('Cancelar esta oferta?')) return;
  try {
    await DEL(`market/ownership-offers/${offerId}`);
    renderP2PPage();
  } catch(e) { alert(e.message); }
}

// ── ADMIN ──
function renderUsersTable(usersData) {
  document.getElementById('users-body').innerHTML = usersData.map(u => {
    const emoji = normalizeAvatar(u.avatar);
    const avHtml = u.photo
      ? `<img src="${photoWithBust(u.photo)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;vertical-align:middle" alt="${emoji}" onerror="this.replaceWith(document.createTextNode(this.alt))">`
      : `<span style="font-size:18px">${emoji}</span>`;
    const isSelf = sameUserId(u.id, CU.id);
    const roleLocked = u.role === 'dev';
    const canEditRole = canAccessFullAdmin() && !roleLocked && (!isSelf || canAccessDev());
    const safeName = (u.nick || u.name || '').replace(/'/g, "\\'");
    return `<tr>
      <td data-label="Foto">${avHtml}</td>
      <td data-label="Nome" style="font-size:12px;font-weight:600">${u.nick||u.name}${isSelf ? ' <span style="font-size:9px;color:var(--gold)">(você)</span>' : ''}</td>
      <td data-label="E-mail" style="font-size:11px;color:var(--text3)">${u.email}</td>
      <td data-label="País" style="font-size:11px">${formatCountry(u.country) || '—'}</td>
      <td data-label="Papel">
        ${canEditRole
          ? `<select class="role-select" data-uid="${u.id}" data-prev="${u.role}" onchange="changeRole(this)">
              ${roleSelectOptions(u.role)}
            </select>`
          : `<span class="badge-tip"><span class="tier-badge ${u.wealthTier || 'investidor'}" style="color:${tierColorStr(u.wealthTier || 'investidor')}">${tierBadge(u.wealthTier || 'investidor')} ${tierName(u.wealthTier || 'investidor')}</span><span class="tip-bubble">${tierTooltip(u.wealthTier || 'investidor')}</span></span>${u.role !== 'user' ? `<span class="role-badge ${u.role}">${roleLabel(u.role)}</span>` : ''}${supporterBadge({ hasDonated: u.hasDonated })}${roleLocked ? ' <span style="font-size:9px;color:var(--text3)">🔒</span>' : ''}`}
      </td>
      <td data-label="Saldo" class="mono" style="font-size:11px">R$${fmtN(u.balance)}</td>
      <td class="td-actions" data-label="Ações">
        <div class="btns-row">
          ${canAccessAdmin() ? `<button class="btn btn-dark btn-sm" onclick="openBalanceModal('${u.id}','${safeName}',${parseFloat(u.balance)||0})">💰 Saldo</button>` : ''}
          ${canAccessFullAdmin() && !isSelf && !roleLocked ? `<button class="btn btn-r btn-sm" onclick="deleteUser('${u.id}','${safeName}')">✕</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function renderAdminUsers() {
  const usersData = await GET('admin/users');
  renderUsersTable(usersData);
  return usersData;
}

async function renderAdmin() {
  if (!canAccessAdmin()) return showPage('market');
  try {
    mountOwnershipPanelInAdmin();
    if (!adminOwnershipReady) {
      await renderP2PPage();
      adminOwnershipReady = true;
    }
    populateOwnerPlayerSel();
    const [usersData, logData] = await Promise.all([GET('admin/users'), GET('admin/log')]);
    document.getElementById('adm-log').innerHTML = (logData || []).map(l =>
      `<div class="log-line"><span class="log-time">[${l.t}]</span>${l.msg}</div>`).join('');
    const sel = document.getElementById('edit-sym-sel');
    sel.innerHTML = '<option value="">— Selecionar —</option>' +
      stocks.map(s => `<option value="${s.sym}">${s.sym} — ${s.name}</option>`).join('');
    renderUsersTable(usersData);
  } catch(e) { console.error(e); }
}

async function adminAct(path, confirm_) {
  if (confirm_ && !confirm('Confirmar ação?')) return;
  return withActionLock('adminAct:' + path, async () => {
    try {
      await POST('admin/' + path);
      showMsg('adm-mkt-msg', '✓ Feito!', 'ok');
      await loadMarketState();
    } catch(e) { showMsg('adm-mkt-msg', e.message, 'err'); }
  });
}

// ── OWNER MANAGEMENT ──
function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function downloadDbBackup() {
  if (!canAccessDev()) return showPage('market');
  try {
    const r = await fetch('/api/admin/dev/download-db', { credentials: 'include' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || 'Nao foi possivel baixar a database.');
    }

    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const cd = r.headers.get('content-disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/i);
    const name = match ? match[1] : `corleone-db-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showMsg('dev-msg', 'Backup do db.json baixado.', 'ok');
  } catch(e) {
    showMsg('dev-msg', e.message, 'err');
  }
}

function pickDbBackup() {
  if (!canAccessDev()) return showPage('market');
  const input = document.getElementById('import-db-input');
  if (!input) return;
  input.value = '';
  input.click();
}

async function importDbBackup(input) {
  if (!canAccessDev()) return showPage('market');
  const file = input.files && input.files[0];
  if (!file) return;
  if (!confirm('Isso substitui TODA a database atual pelos dados do backup. Continuar?')) {
    input.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('dbfile', file);
  try {
    const r = await fetch('/api/admin/dev/import-db', { method: 'POST', credentials: 'include', body: formData });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Nao foi possivel importar a database.');

    const t = data.totals || {};
    showMsg(
      'dev-msg',
      `Database restaurada: ${t.users ?? 0} usuarios, ${t.stocks ?? 0} ativos, ${t.transactions ?? 0} transacoes. Mercado ${data.marketOpen ? 'aberto' : 'fechado'}.`,
      'ok'
    );
    await renderDev();
    if (CU) {
      try {
        CU = await GET('auth/me');
        updateHeaderUser();
      } catch (_) {}
    }
  } catch(e) {
    showMsg('dev-msg', e.message, 'err');
  } finally {
    input.value = '';
  }
}

async function renderDev() {
  if (!canAccessDev()) return showPage('market');
  try {
    const [report, history] = await Promise.all([
      GET('admin/dev/database-report'),
      GET('admin/dev/history')
    ]);

    document.getElementById('dev-msg').innerHTML =
      `<div class="msg ok" style="display:block">Relatorio atualizado em ${new Date(report.generatedAt).toLocaleString('pt-BR')}</div>`;

    document.getElementById('dev-db-summary').innerHTML = `
      <div class="grid2">
        <div class="stat"><div class="stat-label">Usuarios</div><div class="stat-val gold">${report.totals.users}</div></div>
        <div class="stat"><div class="stat-label">Ativos</div><div class="stat-val gold">${report.totals.stocks}</div></div>
        <div class="stat"><div class="stat-label">Transacoes</div><div class="stat-val gold">${report.totals.transactions}</div></div>
        <div class="stat"><div class="stat-label">Logs</div><div class="stat-val gold">${report.totals.adminLog}</div></div>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:10px">Mercado: ${report.market.open ? 'Aberto' : 'Fechado'}</div>
    `;

    document.getElementById('dev-db-files').innerHTML = report.files.map(f => `
      <div class="hist-item">
        <span class="sym-tag" style="font-size:10px">${f.name}</span>
        <span class="mono" style="font-size:11px">${fmtBytes(f.sizeBytes)}</span>
        <span style="margin-left:auto;color:var(--text3);font-size:10px">${new Date(f.modifiedAt).toLocaleString('pt-BR')}</span>
      </div>
    `).join('');

    document.getElementById('dev-db-collections').innerHTML = report.collections.map(c => `
      <tr>
        <td style="font-size:12px;font-weight:600">${c.name}</td>
        <td style="font-size:11px">${c.type}</td>
        <td class="mono" style="font-size:11px">${c.count}</td>
        <td class="mono" style="font-size:11px">${fmtBytes(c.sizeBytes)}</td>
        <td style="font-size:10px;color:var(--text3)">${c.sampleKeys.join(', ') || '-'}</td>
      </tr>
    `).join('');

    document.getElementById('dev-tech-history').innerHTML = (history.adminLog || []).map(l =>
      `<div class="log-line"><span class="log-time">[${l.t}]</span>${l.msg}</div>`).join('') ||
      '<p style="color:var(--text3);font-size:12px;padding:8px 0">Sem historico.</p>';

    document.getElementById('dev-tx-history').innerHTML = (history.transactions || []).map(t => `
      <div class="hist-item">
        <span class="hist-badge ${t.type === 'buy' ? 'buy' : 'sell'}">${t.type}</span>
        <span class="sym-tag" style="font-size:10px">${t.sym || '-'}</span>
        <span style="font-size:10px;color:var(--text3)">${t.userName || t.userId || ''}</span>
        <span class="mono" style="margin-left:auto;font-size:11px">${t.qty || 0} cotas</span>
        <span class="mono gold" style="font-size:11px">R$${fmtN(t.total || 0)}</span>
      </div>
    `).join('') || '<p style="color:var(--text3);font-size:12px;padding:8px 0">Sem transacoes.</p>';
  } catch(e) {
    showMsg('dev-msg', e.message, 'err');
  }
}

function ownerSelectOptions(users, includeSelf = true) {
  const opts = ['<option value="">— Escolher player —</option>'];
  if (includeSelf && CU) {
    opts.push(`<option value="${CU.id}" data-nick="${CU.nick||CU.name}">👤 Eu — ${CU.nick||CU.name}</option>`);
  }
  const others = users.filter(u => !CU || u.id !== CU.id);
  opts.push(...others.map(u =>
    `<option value="${u.id}" data-nick="${u.nick||u.name}">${u.nick||u.name} (${u.email})</option>`
  ));
  return opts.join('');
}

async function populateOwnerPlayerSel() {
  try {
    const users = await GET('admin/users');
    const sel = document.getElementById('owner-player-sel');
    const editSel = document.getElementById('edit-owner-player-sel');
    if (sel) sel.innerHTML = ownerSelectOptions(users);
    if (editSel) editSel.innerHTML = ownerSelectOptions(users);
  } catch(e) {}
}

function pushOwnerRow(rows, uid, nick, pct, renderFn) {
  if (!uid) { alert('Selecione um player.'); return false; }
  if (!pct || pct <= 0) { alert('Insira uma porcentagem válida (ex: 0.05).'); return false; }
  if (rows.find(r => r.userId === uid)) { alert('Este player já foi adicionado.'); return false; }
  rows.push({ userId: uid, name: nick, pct });
  renderFn();
  return true;
}

function addSelfAsOwner() {
  if (!CU) return;
  const pct = parseFloat(document.getElementById('owner-pct-inp')?.value);
  if (pushOwnerRow(ownerRows, CU.id, CU.nick || CU.name, pct, renderOwnerRows)) {
    const pctInp = document.getElementById('owner-pct-inp');
    const sel = document.getElementById('owner-player-sel');
    if (pctInp) pctInp.value = '';
    if (sel) sel.value = '';
  }
}

function addSelfAsEditOwner() {
  if (!CU) return;
  const pct = parseFloat(document.getElementById('edit-owner-pct-inp')?.value);
  if (pushOwnerRow(editOwnerRows, CU.id, CU.nick || CU.name, pct, renderEditOwnerRows)) {
    document.getElementById('edit-owner-pct-inp').value = '';
    document.getElementById('edit-owner-player-sel').value = '';
  }
}

function addOwnerRow() {
  const sel = document.getElementById('owner-player-sel');
  const pctInp = document.getElementById('owner-pct-inp');
  const uid  = sel.value;
  const nick = sel.options[sel.selectedIndex]?.dataset.nick || sel.options[sel.selectedIndex]?.text || '';
  const pct  = parseFloat(pctInp.value);
  if (pushOwnerRow(ownerRows, uid, nick, pct, renderOwnerRows)) {
    pctInp.value = '';
    sel.value = '';
  }
}

function addEditOwnerRow() {
  const sel = document.getElementById('edit-owner-player-sel');
  const pctInp = document.getElementById('edit-owner-pct-inp');
  const uid  = sel.value;
  const nick = sel.options[sel.selectedIndex]?.dataset.nick || '';
  const pct  = parseFloat(pctInp.value);
  if (pushOwnerRow(editOwnerRows, uid, nick, pct, renderEditOwnerRows)) {
    pctInp.value = '';
    sel.value = '';
  }
}

function removeOwnerRow(uid) {
  ownerRows = ownerRows.filter(r => r.userId !== uid);
  renderOwnerRows();
}

function removeEditOwnerRow(uid) {
  editOwnerRows = editOwnerRows.filter(r => r.userId !== uid);
  renderEditOwnerRows();
}

function renderOwnerRowsList(rows, containerId, totalId, warningId, summaryId, updateFn, removeFn) {
  const container = document.getElementById(containerId);
  const totalPctEl = document.getElementById(totalId);
  const warning = warningId ? document.getElementById(warningId) : null;
  const summary = summaryId ? document.getElementById(summaryId) : null;
  if (!container) return;

  const total = rows.reduce((a, r) => a + r.pct, 0);
  if (totalPctEl) totalPctEl.textContent = total.toFixed(3) + '%';
  if (warning) warning.style.display = total > 7 ? 'block' : 'none';
  if (summary) summary.textContent = rows.length ? `${rows.length} dono(s) · ${total.toFixed(3)}% total por trade` : '';

  container.innerHTML = rows.length
    ? rows.map(r => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--s2);border:1px solid var(--border);border-radius:4px;margin-bottom:6px;flex-wrap:wrap">
        <div style="font-size:16px">${r.userId === CU?.id ? '👑' : '👤'}</div>
        <div style="flex:1;min-width:120px">
          <div style="font-weight:600;font-size:12px">${r.name}${r.userId === CU?.id ? ' <span style="color:var(--gold);font-size:10px">(você)</span>' : ''}</div>
          <div style="font-size:10px;color:var(--text3)">Recebe <span class="mono gold">${r.pct.toFixed(3)}%</span> de cada trade</div>
        </div>
        <input type="number" value="${r.pct}" min="0.001" max="10" step="0.001"
          style="width:80px;text-align:right;font-size:12px;padding:6px"
          onchange="${updateFn}('${r.userId}', this.value)">
        <span style="font-size:11px;color:var(--text3)">%</span>
        <button type="button" class="btn btn-r btn-sm" onclick="${removeFn}('${r.userId}')">✕</button>
      </div>
    `).join('')
    : '<p style="color:var(--text3);font-size:12px;padding:4px 0">Nenhum dono adicionado.</p>';
}

function renderOwnerRows() {
  renderOwnerRowsList(ownerRows, 'owners-list', 'owners-total-pct', 'owners-warning', 'owners-summary-line', 'updateOwnerPct', 'removeOwnerRow');
}

function renderEditOwnerRows() {
  renderOwnerRowsList(editOwnerRows, 'edit-owners-list', 'edit-owners-total-pct', 'edit-owners-warning', null, 'updateEditOwnerPct', 'removeEditOwnerRow');
}

function updateOwnerPct(uid, val) {
  const r = ownerRows.find(r => r.userId === uid);
  if (r) { r.pct = parseFloat(val) || 0; renderOwnerRows(); }
}

function updateEditOwnerPct(uid, val) {
  const r = editOwnerRows.find(r => r.userId === uid);
  if (r) { r.pct = parseFloat(val) || 0; renderEditOwnerRows(); }
}

async function adminCreateStock() {
  const sym    = document.getElementById('na-sym').value.trim().toUpperCase();
  const name   = document.getElementById('na-name').value.trim();
  const sector = document.getElementById('na-sector').value;
  const desc   = document.getElementById('na-desc').value.trim();
  const price  = document.getElementById('na-price').value;
  const shares = document.getElementById('na-shares').value;
  const vol    = document.getElementById('na-vol').value;
  const status = document.getElementById('na-status').value;

  const total = ownerRows.reduce((a, r) => a + r.pct, 0);
  if (total > 10) { showMsg('adm-create-msg', 'Total de % dos donos não pode ultrapassar 10%.', 'err'); return; }

  try {
    await POST('stocks', { sym, name, sector, desc, price, shares, vol, status, owners: ownerRows });
    showMsg('adm-create-msg', `✓ Ativo ${sym} criado${ownerRows.length ? ` com ${ownerRows.length} dono(s)!` : '!'}`, 'ok');
    ownerRows = [];
    renderOwnerRows();
    await loadMarketState();
    renderAdmin();
  } catch(e) { showMsg('adm-create-msg', e.message, 'err'); }
}

function loadEditStock() {
  const sym  = document.getElementById('edit-sym-sel').value;
  const form = document.getElementById('edit-stock-form');
  if (!sym) { form.style.display = 'none'; return; }
  const s = stocks.find(x => x.sym === sym);
  if (!s) { form.style.display = 'none'; return; }
  form.style.display = 'block';
  document.getElementById('es-name').value = s.name;
  document.getElementById('es-desc').value = s.desc || '';
  document.getElementById('es-pct').value  = '';
  editOwnerRows = (s.owners || []).map(o => ({ userId: o.userId, name: o.name, pct: o.pct }));
  renderEditOwnerRows();
  for (let o of document.getElementById('es-sector').options) if (o.value === s.sector || o.textContent === s.sector) o.selected = true;
  for (let o of document.getElementById('es-vol').options)    if (parseFloat(o.value) === s.vol) o.selected = true;
  for (let o of document.getElementById('es-status').options) if (o.value === s.status) o.selected = true;
}

async function adminSaveStock() {
  const sym    = document.getElementById('edit-sym-sel').value;
  const name   = document.getElementById('es-name').value.trim();
  const sector = document.getElementById('es-sector').value;
  const desc   = document.getElementById('es-desc').value.trim();
  const vol    = document.getElementById('es-vol').value;
  const status = document.getElementById('es-status').value;
  const pricePct = document.getElementById('es-pct').value;
  const totalOwners = editOwnerRows.reduce((a, r) => a + r.pct, 0);
  if (totalOwners > 10) { showMsg('adm-edit-msg', 'Total de % dos donos não pode ultrapassar 10%.', 'err'); return; }
  try {
    await PUT(`stocks/${sym}`, { name, sector, desc, vol, status, pricePct, owners: editOwnerRows });
    showMsg('adm-edit-msg', `✓ ${sym} atualizado!`, 'ok');
    await loadMarketState();
  } catch(e) { showMsg('adm-edit-msg', e.message, 'err'); }
}

async function adminDeleteStock() {
  const sym = document.getElementById('edit-sym-sel').value;
  if (!sym || !confirm(`Deletar ${sym}?`)) return;
  try {
    await DEL(`stocks/${sym}`);
    showMsg('adm-edit-msg', `✓ ${sym} deletado.`, 'ok');
    document.getElementById('edit-stock-form').style.display = 'none';
    await loadMarketState();
    renderAdmin();
  } catch(e) { showMsg('adm-edit-msg', e.message, 'err'); }
}

async function changeRole(selectEl) {
  if (roleChangeBusy) return;
  const uid = selectEl.dataset.uid;
  const role = selectEl.value;
  const prev = selectEl.dataset.prev || selectEl.value;
  if (role === prev) return;

  roleChangeBusy = true;
  selectEl.disabled = true;
  document.querySelectorAll('.role-select').forEach(s => { s.disabled = true; });

  try {
    if (role === 'dev') {
      const devPassword = prompt('Senha para conceder papel Dev:');
      if (!devPassword) {
        selectEl.value = prev;
        return;
      }
    }
    const { role: savedRole } = await PUT(`admin/users/${uid}/role`, { role });
    const finalRole = savedRole || role;
    selectEl.dataset.prev = finalRole;
    if (sameUserId(uid, CU.id)) {
      CU.role = finalRole;
      document.querySelectorAll('.admin-only').forEach(e => e.style.display = 'none');
      document.querySelectorAll('.dev-only').forEach(e => e.style.display = 'none');
      if (canAccessAdmin()) document.querySelectorAll('.admin-only').forEach(e => e.style.display = '');
      if (canAccessDev()) document.querySelectorAll('.dev-only').forEach(e => e.style.display = '');
      updateHeaderUser();
    }
    showMsg('adm-users-msg', `✓ Papel alterado para ${finalRole}.`, 'ok');
    await renderAdminUsers();
  } catch(e) {
    selectEl.value = prev;
    showMsg('adm-users-msg', e.message, 'err');
  } finally {
    roleChangeBusy = false;
    document.querySelectorAll('.role-select').forEach(s => { s.disabled = false; });
  }
}

function openBalanceModal(uid, name, currentBalance) {
  const modal = document.getElementById('modal-content');
  modal.className = 'modal';
  modal.innerHTML = `
    <h2>💰 Saldo de ${name}</h2>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px">Saldo atual: <span class="mono gold">R$${fmtN(currentBalance)}</span></p>
    <div class="fg"><label>Valor (R$)</label><input type="number" id="bal-val" placeholder="50000" step="0.01" style="width:100%"></div>
    <div class="fg"><label>Operação</label>
      <select id="bal-mode" style="width:100%">
        <option value="set">Definir exato</option>
        <option value="add">Adicionar</option>
        <option value="subtract">Subtrair</option>
      </select>
    </div>
    <div class="btns-row" style="margin-top:14px">
      <button class="btn btn-gold" id="bal-apply-btn" onclick="applyBalance('${uid}')">Aplicar</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
    </div>
    <div id="bal-msg" style="margin-top:8px"></div>
  `;
  document.getElementById('modal-bg').classList.add('open');
}

async function applyBalance(uid) {
  const btn = document.getElementById('bal-apply-btn');
  return withActionLock('applyBalance:' + uid, async () => {
    const balance = document.getElementById('bal-val').value;
    const mode    = document.getElementById('bal-mode').value;
    setBtnBusy(btn, true, 'Salvando…');
    try {
      const { balance: nb } = await PUT(`admin/users/${uid}/balance`, { balance, mode });
      if (sameUserId(uid, CU.id)) {
        CU.balance = nb;
        updateHeaderUser();
      }
      showMsg('bal-msg', `✓ Novo saldo: R$${fmtN(nb)}`, 'ok');
      setTimeout(async () => {
        closeModal();
        await renderAdminUsers();
      }, 800);
    } catch(e) { showMsg('bal-msg', e.message, 'err'); }
    finally { setBtnBusy(btn, false); }
  });
}

async function deleteUser(uid, name) {
  if (!confirm(`Deletar ${name}?`)) return;
  try {
    await DEL(`admin/users/${uid}`);
    await renderAdminUsers();
    showMsg('adm-users-msg', '✓ Usuário removido.', 'ok');
  } catch(e) { showMsg('adm-users-msg', e.message, 'err'); }
}

function closeModal() {
  document.getElementById('modal-bg').classList.remove('open');
  _profileModalData = null;
  const modal = document.getElementById('modal-content');
  if (modal) modal.className = 'modal';
}

// ── PUBLIC PROFILE MODAL ──
let _profileModalData = null;

function renderProfileHoldings(holdings) {
  if (!holdings.length) {
    return '<p style="color:var(--text3);font-size:12px;padding:8px 0">Nenhum ativo em carteira.</p>';
  }
  return holdings.map(h => {
    const dayCls = h.dayPct > 0 ? 'price-up' : h.dayPct < 0 ? 'price-dn' : '';
    const daySign = h.dayPct > 0 ? '+' : '';
    return `<div class="prof-hold-row">
      <div>
        <span class="sym-tag" style="font-size:10px">${h.sym}</span>
        <span style="font-weight:600;color:var(--text2)">${h.name}</span>
        <div class="prof-hold-meta">
          <span class="sector-tag" style="font-size:9px">${h.sector}</span>
          · ${h.qty} cotas · R$${h.price.toFixed(2)}
          · <span class="${dayCls}">${daySign}${h.dayPct.toFixed(2)}% hoje</span>
        </div>
      </div>
      <div style="text-align:right">
        <div class="mono" style="font-size:12px">R$${fmtN(h.value)}</div>
        <div class="prof-hold-meta">${h.pctOfPortfolio.toFixed(1)}% carteira · ${h.pctOfCompany.toFixed(4)}% empresa</div>
      </div>
    </div>`;
  }).join('');
}

function renderProfileTransactions(txs, filter) {
  const list = filter === 'all' ? txs : txs.filter(t => t.type === filter);
  if (!list.length) {
    const label = filter === 'buy' ? 'compras' : filter === 'sell' ? 'vendas' : 'operações';
    return `<p style="color:var(--text3);font-size:12px;padding:8px 0">Sem ${label} registradas.</p>`;
  }
  return list.map(t => `<div class="hist-item">
    <span class="hist-badge ${t.type}">${t.type === 'buy' ? 'COMPRA' : 'VENDA'}</span>
    <span style="font-weight:600">${t.sym}</span>
    <span style="color:var(--text3)">${t.qty}×</span>
    <span class="mono" style="font-size:10px">R$${Number(t.price).toFixed(2)}</span>
    <span class="mono ${t.type === 'buy' ? 'price-dn' : 'price-up'}" style="margin-left:auto;font-size:11px">R$${Number(t.total).toFixed(2)}</span>
    <span style="color:var(--text3);font-size:9px">${t.time || ''}</span>
  </div>`).join('');
}

function switchProfileTab(tab) {
  document.querySelectorAll('.prof-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.prof-panel').forEach(p =>
    p.classList.toggle('active', p.dataset.panel === tab));
}

function filterProfileTx(filter) {
  if (!_profileModalData) return;
  document.querySelectorAll('.prof-filter button').forEach(b =>
    b.classList.toggle('active', b.dataset.filter === filter));
  const el = document.getElementById('prof-tx-list');
  if (el) el.innerHTML = renderProfileTransactions(_profileModalData.transactions, filter);
}

async function openProfileModal(uid) {
  try {
    const p = await GET('users/' + uid + '/public');
    _profileModalData = p;
    const emoji = normalizeAvatar(p.avatar);
    const photoHtml = p.photo
      ? `<img src="${photoWithBust(p.photo)}" style="width:70px;height:70px;border-radius:50%;object-fit:cover;border:2px solid var(--gold)" alt="${emoji}" onerror="this.replaceWith(document.createTextNode(this.alt))">`
      : `<span style="font-size:40px">${emoji}</span>`;
    const financeHidden = p.totalWealth === null;
    const topHoldings = (p.holdings || []).slice(0, 3);
    const topHoldingsHtml = topHoldings.length
      ? topHoldings.map(h => `<div style="display:flex;justify-content:space-between;font-size:11px;padding:5px 0;border-bottom:1px solid var(--border)">
          <span><span class="sym-tag" style="font-size:9px">${h.sym}</span> ${h.qty} cotas</span>
          <span class="mono">R$${fmtN(h.value)}</span>
        </div>`).join('')
      : '<p style="color:var(--text3);font-size:11px;padding:4px 0">Sem posições.</p>';

    const modal = document.getElementById('modal-content');
    modal.className = 'modal modal-wide';
    modal.innerHTML = `
      <h2>Análise do Investidor</h2>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
        <div style="width:70px;height:70px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--s3);overflow:hidden;flex-shrink:0">${photoHtml}</div>
        <div style="flex:1;min-width:0">
          <div class="${getFontClass()}" style="font-family:'Playfair Display',serif;font-size:20px;font-weight:700;font-style:italic">${p.nick}</div>
          <div style="font-size:11px;color:var(--text3)">${p.name} · ${formatCountry(p.country)}</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">
            <span class="badge-tip"><span class="tier-badge ${p.wealthTier || 'investidor'}" style="color:${tierColorStr(p.wealthTier || 'investidor')}">${tierBadge(p.wealthTier || 'investidor')} ${tierName(p.wealthTier || 'investidor')}</span><span class="tip-bubble">${tierTooltip(p.wealthTier || 'investidor')}</span></span>
            ${p.role !== 'user' ? `<span class="badge-tip"><span class="role-badge ${p.role}">${roleLabel(p.role)}</span></span>` : ''}${supporterBadge({ hasDonated: p.hasDonated })}
          </div>
          ${p.bio ? `<div style="font-size:11px;color:var(--text2);margin-top:6px;font-style:italic">"${p.bio}"</div>` : ''}
        </div>
      </div>

      <div class="prof-tabs">
        <button type="button" class="prof-tab active" data-tab="summary" onclick="switchProfileTab('summary')">Resumo</button>
        <button type="button" class="prof-tab" data-tab="portfolio" onclick="switchProfileTab('portfolio')">Carteira (${p.assetsCount || 0})</button>
        <button type="button" class="prof-tab" data-tab="ops" onclick="switchProfileTab('ops')">Operações (${p.totalTx || 0})</button>
      </div>

      <div class="prof-panel active" data-panel="summary">
        <div class="grid2" style="gap:8px;margin-bottom:14px">
          ${!financeHidden ? `<div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Patrimônio</div><div class="mono gold" style="font-size:16px">R$${fmtN(p.totalWealth)}</div></div>` : ''}
          ${!financeHidden ? `<div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Cash / Ações</div><div class="mono" style="font-size:12px">R$${fmtN(p.cash)} / R$${fmtN(p.marketValue)}</div></div>` : ''}
          <div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Operações</div><div class="mono" style="font-size:16px">${p.totalTx}</div></div>
          <div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Compras / Vendas</div><div class="mono" style="font-size:14px"><span class="green">${p.buys}</span> / <span class="red">${p.sells}</span></div></div>
          ${!financeHidden ? `<div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Vol. Compras</div><div class="mono price-dn" style="font-size:13px">R$${fmtN(p.buyVolume)}</div></div>` : ''}
          ${!financeHidden ? `<div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Vol. Vendas</div><div class="mono price-up" style="font-size:13px">R$${fmtN(p.sellVolume)}</div></div>` : ''}
          <div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Ativos</div><div class="mono" style="font-size:16px">${p.assetsCount || 0}</div></div>
          <div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Membro desde</div><div class="mono" style="font-size:12px">${new Date(p.joined).toLocaleDateString('pt-BR')}</div></div>
        </div>
        <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text3);margin-bottom:6px">Maiores Posições</div>
        ${topHoldingsHtml}
      </div>

      <div class="prof-panel" data-panel="portfolio">
        ${renderProfileHoldings(p.holdings || [])}
      </div>

      <div class="prof-panel" data-panel="ops">
        <div class="prof-filter">
          <button type="button" class="active" data-filter="all" onclick="filterProfileTx('all')">Todas</button>
          <button type="button" data-filter="buy" onclick="filterProfileTx('buy')">Compras (${p.buys})</button>
          <button type="button" data-filter="sell" onclick="filterProfileTx('sell')">Vendas (${p.sells})</button>
        </div>
        <div class="prof-tx-list" id="prof-tx-list">${renderProfileTransactions(p.transactions || [], 'all')}</div>
        ${(p.transactions || []).length >= 100 ? '<p style="font-size:9px;color:var(--text3);margin-top:8px">Exibindo as 100 operações mais recentes.</p>' : ''}
      </div>

      <div style="margin-top:16px"><button class="btn btn-ghost" onclick="closeModal()" style="width:100%">Fechar</button></div>
    `;
    document.getElementById('modal-bg').classList.add('open');
  } catch(e) { console.error(e); }
}

// ── HELPERS ──
function fmtN(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return (n || 0).toFixed(0);
}
function showMsg(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<div class="alert ${type}">${msg}</div>`;
  setTimeout(() => { if (el) el.innerHTML = ''; }, 4000);
}

// ── THEME SELECTOR ──
function applyThemeColors(chart, theme) {
  if (!chart) return;
  const isLight = theme === 'light';
  const gridCol = isLight ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.04)';
  const tickCol = isLight ? '#7a7368' : '#5a5570';
  const bgCol   = isLight ? '#ffffff' : '#131318';
  const fgCol   = isLight ? '#1a1815' : '#e8e6f0';
  try {
    chart.options.scales?.x?.grid && (chart.options.scales.x.grid.color = gridCol);
    chart.options.scales?.y?.grid && (chart.options.scales.y.grid.color = gridCol);
    chart.options.scales?.x?.ticks && (chart.options.scales.x.ticks.color = tickCol);
    chart.options.scales?.y?.ticks && (chart.options.scales.y.ticks.color = tickCol);
    chart.options.plugins?.tooltip && (Object.assign(chart.options.plugins.tooltip, { backgroundColor: bgCol, titleColor: isLight ? '#7a6228' : '#c9a84c', bodyColor: fgCol }));
  } catch (_) {}
}

function rebuildChartColors(theme) {
  if (!mainChart) return;
  const isLight = theme === 'light';
  const bg      = isLight ? '#ffffff' : (theme === 'very-dark' ? '#0a0a0a' : '#131318');
  const upColor = isLight ? '#249653' : '#27ae60';
  const dnColor = isLight ? '#b03025' : '#c0392b';

  // Rebuild with theme-aware colors
  if (mainChart.data && mainChart.data.datasets) {
    mainChart.data.datasets.forEach(ds => {
      if (ds.borderColor === upColor || ds.borderColor === dnColor) {
        ds.backgroundColor = isLight
          ? (() => { const g = mainChart.ctx?.createLinearGradient?.(0,0,0,255); g?.addColorStop(0,'rgba(166,138,62,.1)'); g?.addColorStop(1,'rgba(166,138,62,0)'); return g; })()
          : (() => { const g = mainChart.ctx?.createLinearGradient?.(0,0,0,255); g?.addColorStop(0,'rgba(201,168,76,.12)'); g?.addColorStop(1,'rgba(201,168,76,0)'); return g; })();
      }
    });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('corleone-theme', theme);
  // Close menu
  const menu = document.getElementById('theme-menu');
  if (menu) menu.classList.remove('open');
  // Update active button state
  document.querySelectorAll('.tm-item').forEach(b => b.setAttribute('aria-selected', b.dataset.theme === theme ? 'true' : 'false'));
}

function toggleThemeMenu() {
  const menu = document.getElementById('theme-menu');
  if (menu) menu.classList.toggle('open');
}

// Close theme menu on outside click
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('theme-wrap');
  const menu = document.getElementById('theme-menu');
  if (wrap && menu && !wrap.contains(e.target)) {
    menu.classList.remove('open');
  }
});

// Init theme from saved or default
(function initTheme() {
  const saved = localStorage.getItem('corleone-theme');
  const theme = saved || 'default';
  document.documentElement.setAttribute('data-theme', theme);
})();

// ── AUTO-CHECK SESSION ──
(async () => {
  try {
    const user = await GET('auth/me');
    if (user && user.id) { CU = user; startApp(); }
  } catch(e) {}
})();
