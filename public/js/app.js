// ═══════════════════════════════════════════════════
//  CORLEONE MARKET — Frontend App (connects to backend)
// ═══════════════════════════════════════════════════

const AVATARS = ['🦁','🐺','🦊','🐉','🦅','🎩','🃏','🌹','🐯','🦝','🤵','👑','🎯','⚡','🔱'];

let CU = null;           // current user
let stocks = [];         // cached stock list
let priceHistory = {};   // sym -> [{p}]
let mainChart = null;
let selectedSym = null;
let orderType = 'buy';
let editAvatar = null;
let regAvatar = '🦁';
let pollInterval = null;

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

// ── AUTH TAB ──
function authTab(t) {
  document.querySelectorAll('.auth-tab').forEach((b, i) =>
    b.classList.toggle('active', (i === 0 && t === 'login') || (i === 1 && t === 'register')));
  document.getElementById('auth-login').style.display    = t === 'login'    ? 'block' : 'none';
  document.getElementById('auth-register').style.display = t === 'register' ? 'block' : 'none';
}

function buildAvatarGrid(containerId, onSelect, current) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  AVATARS.forEach(a => {
    const d = document.createElement('div');
    d.className = 'av-opt' + (a === current ? ' sel' : '');
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
  if (mainChart) { mainChart.destroy(); mainChart = null; }
  document.getElementById('s-app').classList.remove('active');
  document.getElementById('s-auth').classList.add('active');
}

// ── APP START ──
async function startApp() {
  document.getElementById('s-auth').classList.remove('active');
  document.getElementById('s-app').classList.add('active');
  updateHeaderUser();
  if (['admin','moderator'].includes(CU.role))
    document.querySelectorAll('.admin-only').forEach(e => e.style.display = '');
  await loadMarketState();
  buildChart();
  showPage('market');
  startPolling();
}

function updateHeaderUser() {
  if (!CU) return;
  document.getElementById('hdr-name').textContent = CU.nick || CU.name;
  const avEl = document.getElementById('hdr-av');
  if (CU.photo) {
    avEl.innerHTML = `<img src="${CU.photo}?t=${Date.now()}" alt="">`;
  } else {
    avEl.textContent = CU.avatar || '🦁';
  }
}

// ── POLLING ──
function startPolling() {
  clearInterval(pollInterval);
  pollInterval = setInterval(loadMarketState, 3000);
}

async function loadMarketState() {
  try {
    const data = await GET('market/state');
    stocks = data.stocks;
    updateMktBadge(data.open);
    renderAll(data);
    updateTicker();
    // fetch history for selected stock and refresh chart
    if (selectedSym) await refreshChartHistory(selectedSym);
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
  if (!selectedSym && stocks.length) selectedSym = stocks[0].sym;
  const maxVol = Math.max(...stocks.map(s => s.volume + 1));
  document.getElementById('stocks-body').innerHTML = stocks.map(s => {
    const pct = ((s.price - s.open) / s.open * 100);
    const cls = pct > 0 ? 'up' : pct < 0 ? 'dn' : 'neu';
    const sign = pct > 0 ? '+' : '';
    const dr = s.demand / (s.demand + s.supply + .001);
    return `<tr onclick="selectStock('${s.sym}')" style="cursor:pointer" id="row-${s.sym}">
      <td><span class="sym-tag">${s.sym}</span></td>
      <td style="font-weight:600;font-size:12px">${s.name}</td>
      <td><span class="sector-tag">${s.sector}</span></td>
      <td><span class="status-badge ${s.status}">${s.status==='active'?'Ativa':'Suspensa'}</span></td>
      <td class="price-${cls} mono">R$${s.price.toFixed(2)}</td>
      <td><span class="chg-pill ${cls}">${sign}${pct.toFixed(2)}%</span></td>
      <td class="mono" style="font-size:10px;color:var(--text3)">${fmtN(s.volume)}</td>
      <td><div class="dbar"><div class="dbar-fill" style="width:${dr*100}%;background:${dr>.5?'var(--green2)':'var(--red2)'}"></div></div></td>
      <td>
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">${((s.buys - s.sells > 0 ? s.buys - s.sells : 0) / s.shares * 100).toFixed(3)}% negociado</div>
        <div class="dbar" style="width:90px"><div class="dbar-fill" style="width:${Math.min(100,(s.buys+s.sells)/s.shares*100*20)}%;background:var(--gold)"></div></div>
      </td>
      <td><button class="btn btn-dark btn-sm" onclick="event.stopPropagation();goTrade('${s.sym}')">Negociar</button></td>
    </tr>`;
  }).join('');
}

function selectStock(sym) {
  selectedSym = sym;
  document.getElementById('chart-label').textContent = sym + ' — Tempo Real';
  updateOrderBook();
  refreshChartHistory(sym);
}

function updateOrderBook() {
  const s = stocks.find(x => x.sym === selectedSym);
  if (!s) return;
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
function buildChart() {
  const ctx = document.getElementById('mainChart').getContext('2d');
  mainChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#c9a84c', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: ctx2 => {
      const g = ctx2.chart.ctx.createLinearGradient(0, 0, 0, 255);
      g.addColorStop(0, 'rgba(201,168,76,.12)'); g.addColorStop(1, 'rgba(201,168,76,0)'); return g;
    }, tension: .3 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'R$' + c.parsed.y.toFixed(2) }, backgroundColor: '#131318', borderColor: '#2a2a3a', borderWidth: 1, titleColor: '#9890b0', bodyColor: '#e8e6f0' } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#5a5570', font: { size: 9 } } },
        y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#5a5570', font: { size: 9 }, callback: v => 'R$' + v.toFixed(0) }, position: 'right' }
      }
    }
  });
}

function updateMainChart() {
  if (!mainChart || !selectedSym) return;
  const hist = priceHistory[selectedSym] || [];
  const s    = stocks.find(x => x.sym === selectedSym);
  mainChart.data.labels = hist.map((_, i) => i === hist.length - 1 ? 'agora' : '');
  mainChart.data.datasets[0].data = hist; // plain number[]
  const up = !s || s.price >= s.open;
  mainChart.data.datasets[0].borderColor = up ? '#27ae60' : '#c0392b';
  mainChart.update('none');
}

// ── NAV ──
function showPage(pg) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.hn-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('p-' + pg).classList.add('active');
  const map = { market: 0, trade: 1, portfolio: 2, ranking: 3, profile: 4, admin: 5 };
  document.querySelectorAll('.hn-btn')[map[pg]]?.classList.add('active');
  if (pg === 'trade')     renderTradePage();
  if (pg === 'portfolio') renderPortfolio();
  if (pg === 'ranking')   renderRanking();
  if (pg === 'profile')   renderProfile();
  if (pg === 'admin')     renderAdmin();
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
      <div style="background:var(--s2);padding:8px;border:1px solid var(--border);border-radius:4px"><div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Abertura</div><div class="mono" style="font-size:12px">R$${s.open.toFixed(2)}</div></div>
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
  const sym = document.getElementById('trade-sym').value;
  const qty = parseInt(document.getElementById('trade-qty').value) || 0;
  try {
    const data = await POST('market/order', { sym, type: orderType, qty });
    CU.balance = data.user.balance;
    document.getElementById('td-bal').textContent = 'R$' + CU.balance.toFixed(2);
    showMsg('trade-msg', `✓ ${orderType==='buy'?'Compra':'Venda'}: ${qty}× ${sym} — R$${data.tx.total.toFixed(2)}`, 'ok');
    renderTradeHist();
    updateTradeInfo();
  } catch(e) { showMsg('trade-msg', e.message, 'err'); }
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
  try {
    const { user, portfolio, transactions } = await GET('market/portfolio');
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
}

// ── RANKING ──
async function renderRanking() {
  try {
    const { investors, supplyDemand, topTraded } = await GET('market/ranking');
    const medals = ['r1', 'r2', 'r3'];
    document.getElementById('rank-inv').innerHTML = investors.map((r, i) => {
      const avHtml = r.photo
        ? `<div class="rank-av"><img src="${r.photo}"></div>`
        : `<div class="rank-av">${r.avatar||'🦁'}</div>`;
      return `<div class="rank-row" onclick="openProfileModal('${r.id}')" style="cursor:pointer" title="Ver perfil">
        <div class="rank-n ${medals[i]||''} serif">${i+1}</div>
        ${avHtml}
        <div style="flex:1"><div style="font-weight:600;font-size:13px">${r.name} <span style="font-size:10px;color:var(--text3)">${r.country||''}</span></div><div style="font-size:10px;color:var(--text3)">Cash R$${fmtN(r.cash)}</div></div>
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
}

// ── PROFILE ──
function renderProfile() {
  editAvatar = CU.avatar || '🦁';
  const photoHtml = CU.photo
    ? `<img src="${CU.photo}?t=${Date.now()}" alt="">`
    : CU.avatar || '🦁';
  document.getElementById('prof-hero').innerHTML = `
    <div class="profile-photo" onclick="document.getElementById('photo-input').click()" title="Clique para trocar foto">
      ${photoHtml}
      <div class="ph-overlay">📷 Trocar</div>
    </div>
    <div>
      <div class="profile-name-big">${CU.nick || CU.name}</div>
      <div style="font-size:12px;color:var(--text3)">${CU.name} · ${CU.country||''}</div>
      <span class="role-badge ${CU.role}">${CU.role === 'admin' ? '👑 Admin' : CU.role === 'moderator' ? '🎩 Moderador' : '🦁 Investidor'}</span>
      ${CU.bio ? `<div style="font-size:11px;color:var(--text2);margin-top:6px;font-style:italic">"${CU.bio}"</div>` : ''}
    </div>
    <div style="margin-left:auto;text-align:right">
      <div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">Saldo</div>
      <div class="serif gold" style="font-size:26px">R$${fmtN(CU.balance)}</div>
    </div>
  `;
  document.getElementById('edit-nick').value = CU.nick || '';
  document.getElementById('edit-bio').value  = CU.bio  || '';
  const csel = document.getElementById('edit-country');
  for (let o of csel.options) if (o.value === CU.country || o.textContent === CU.country) o.selected = true;
  buildAvatarGrid('edit-av-grid', a => editAvatar = a, CU.avatar || '🦁');
  // stats
  GET('market/portfolio').then(({ transactions }) => {
    const txs = transactions || [];
    document.getElementById('prof-stats').innerHTML = `
      <div style="display:grid;gap:8px">
        <div style="background:var(--s2);padding:12px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Total Operações</div><div class="stat-val serif">${txs.length}</div></div>
        <div style="background:var(--s2);padding:12px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Compras</div><div class="stat-val green serif">${txs.filter(t=>t.type==='buy').length}</div></div>
        <div style="background:var(--s2);padding:12px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Vendas</div><div class="stat-val red serif">${txs.filter(t=>t.type==='sell').length}</div></div>
        <div style="background:var(--s2);padding:12px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Membro desde</div><div class="mono" style="font-size:12px;color:var(--text2)">${new Date(CU.joined||Date.now()).toLocaleDateString('pt-BR')}</div></div>
      </div>
    `;
  }).catch(() => {});
}

async function saveProfile() {
  const nick    = document.getElementById('edit-nick').value.trim();
  const bio     = document.getElementById('edit-bio').value.trim();
  const country = document.getElementById('edit-country').value;
  try {
    const { user } = await PUT('users/me', { nick, bio, country, avatar: editAvatar });
    CU = { ...CU, ...user };
    updateHeaderUser();
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
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    CU.photo = data.photo;
    updateHeaderUser();
    showMsg('prof-msg', '✓ Foto atualizada!', 'ok');
    renderProfile();
  } catch(e) { showMsg('prof-msg', e.message, 'err'); }
}

// ── ADMIN ──
async function renderAdmin() {
  try {
    const [usersData, logData] = await Promise.all([GET('admin/users'), GET('admin/log')]);
    document.getElementById('adm-log').innerHTML = (logData || []).map(l =>
      `<div class="log-line"><span class="log-time">[${l.t}]</span>${l.msg}</div>`).join('');
    // populate edit sym
    const sel = document.getElementById('edit-sym-sel');
    sel.innerHTML = '<option value="">— Selecionar —</option>' +
      stocks.map(s => `<option value="${s.sym}">${s.sym} — ${s.name}</option>`).join('');
    // users table
    document.getElementById('users-body').innerHTML = usersData.map(u => {
      const avHtml = u.photo
        ? `<img src="${u.photo}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;vertical-align:middle">`
        : `<span style="font-size:18px">${u.avatar||'👤'}</span>`;
      const canChange = u.id !== CU.id;
      return `<tr>
        <td>${avHtml}</td>
        <td style="font-size:12px;font-weight:600">${u.nick||u.name}</td>
        <td style="font-size:11px;color:var(--text3)">${u.email}</td>
        <td style="font-size:11px">${u.country||'—'}</td>
        <td>
          ${CU.role === 'admin' && canChange
            ? `<select class="role-select" onchange="changeRole('${u.id}',this.value)">
                <option ${u.role==='user'?'selected':''} value="user">user</option>
                <option ${u.role==='moderator'?'selected':''} value="moderator">moderator</option>
                <option ${u.role==='admin'?'selected':''} value="admin">admin</option>
              </select>`
            : `<span class="role-badge ${u.role}">${u.role}</span>`}
        </td>
        <td class="mono" style="font-size:11px">R$${fmtN(u.balance)}</td>
        <td>
          <div class="btns-row">
            ${canChange ? `<button class="btn btn-dark btn-sm" onclick="openBalanceModal('${u.id}','${u.nick||u.name}',${u.balance})">💰 Saldo</button>` : ''}
            ${CU.role==='admin' && canChange ? `<button class="btn btn-r btn-sm" onclick="deleteUser('${u.id}','${u.nick||u.name}')">✕</button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');
  } catch(e) { console.error(e); }
}

async function adminAct(path, confirm_) {
  if (confirm_ && !confirm('Confirmar ação?')) return;
  try {
    await POST('admin/' + path);
    showMsg('adm-mkt-msg', '✓ Feito!', 'ok');
    await loadMarketState();
  } catch(e) { showMsg('adm-mkt-msg', e.message, 'err'); }
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
  try {
    await POST('stocks', { sym, name, sector, desc, price, shares, vol, status });
    showMsg('adm-create-msg', `✓ Ativo ${sym} criado!`, 'ok');
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
  try {
    await PUT(`stocks/${sym}`, { name, sector, desc, vol, status, pricePct });
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

async function changeRole(uid, role) {
  try {
    await PUT(`admin/users/${uid}/role`, { role });
    showMsg('adm-mkt-msg', `✓ Papel alterado para ${role}!`, 'ok');
    renderAdmin();
  } catch(e) { showMsg('adm-mkt-msg', e.message, 'err'); }
}

function openBalanceModal(uid, name, currentBalance) {
  document.getElementById('modal-content').innerHTML = `
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
      <button class="btn btn-gold" onclick="applyBalance('${uid}')">Aplicar</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
    </div>
    <div id="bal-msg" style="margin-top:8px"></div>
  `;
  document.getElementById('modal-bg').classList.add('open');
}

async function applyBalance(uid) {
  const balance = document.getElementById('bal-val').value;
  const mode    = document.getElementById('bal-mode').value;
  try {
    const { balance: nb } = await PUT(`admin/users/${uid}/balance`, { balance, mode });
    showMsg('bal-msg', `✓ Novo saldo: R$${fmtN(nb)}`, 'ok');
    setTimeout(() => { closeModal(); renderAdmin(); }, 1200);
  } catch(e) { showMsg('bal-msg', e.message, 'err'); }
}

async function deleteUser(uid, name) {
  if (!confirm(`Deletar ${name}?`)) return;
  try {
    await DEL(`admin/users/${uid}`);
    renderAdmin();
  } catch(e) { showMsg('adm-mkt-msg', e.message, 'err'); }
}

function closeModal() { document.getElementById('modal-bg').classList.remove('open'); }

// ── PUBLIC PROFILE MODAL ──
async function openProfileModal(uid) {
  try {
    const p = await GET('users/' + uid + '/public');
    const photoHtml = p.photo
      ? `<img src="${p.photo}" style="width:70px;height:70px;border-radius:50%;object-fit:cover;border:2px solid var(--gold)">`
      : `<span style="font-size:40px">${p.avatar||'🦁'}</span>`;
    const roleLabel = p.role === 'admin' ? '👑 Admin' : p.role === 'moderator' ? '🎩 Moderador' : '🦁 Investidor';

    const holdingsHtml = p.holdings.length
      ? p.holdings.map(h => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px">
            <div><span class="sym-tag" style="font-size:10px">${h.sym}</span> <span style="color:var(--text2)">${h.name}</span></div>
            <div style="text-align:right">
              <div class="mono" style="font-size:11px">${h.qty} cotas</div>
              <div style="font-size:9px;color:var(--gold)">${h.pctOfCompany.toFixed(4)}% empresa</div>
            </div>
          </div>`).join('')
      : '<p style="color:var(--text3);font-size:12px;padding:8px 0">Carteira vazia.</p>';

    document.getElementById('modal-content').innerHTML = `
      <h2>Perfil do Investidor</h2>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        <div style="width:70px;height:70px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--s3);overflow:hidden;flex-shrink:0">${photoHtml}</div>
        <div>
          <div style="font-family:'Playfair Display',serif;font-size:20px;font-weight:700;font-style:italic">${p.nick}</div>
          <div style="font-size:11px;color:var(--text3)">${p.name} · ${p.country||''}</div>
          <span class="role-badge ${p.role}" style="margin-top:4px;display:inline-block">${roleLabel}</span>
          ${p.bio ? `<div style="font-size:11px;color:var(--text2);margin-top:6px;font-style:italic">"${p.bio}"</div>` : ''}
        </div>
      </div>
      <div class="grid2" style="gap:8px;margin-bottom:16px">
        ${p.totalWealth !== null ? `<div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Patrimônio</div><div class="mono gold" style="font-size:16px">R$${fmtN(p.totalWealth)}</div></div>` : ''}
        <div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Operações</div><div class="mono" style="font-size:16px">${p.totalTx}</div></div>
        <div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Compras / Vendas</div><div class="mono" style="font-size:14px"><span style="color:var(--green2)">${p.buys}</span> / <span style="color:var(--red2)">${p.sells}</span></div></div>
        <div style="background:var(--s2);padding:10px;border:1px solid var(--border);border-radius:4px"><div class="stat-label">Membro desde</div><div class="mono" style="font-size:12px">${new Date(p.joined).toLocaleDateString('pt-BR')}</div></div>
      </div>
      <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text3);margin-bottom:8px">Posições em Carteira</div>
      ${holdingsHtml}
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

// ── AUTO-CHECK SESSION ──
(async () => {
  try {
    const user = await GET('auth/me');
    if (user && user.id) { CU = user; startApp(); }
  } catch(e) {}
})();
