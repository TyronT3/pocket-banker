import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pocket-banker-auth' },
});

const PRESETS = {
  classic:    { label: 'Classic ($1,500)',            currency: '$', start: 1500,     go: 200 },
  rand:       { label: 'Rand (R1,500) – check your box', currency: 'R', start: 1500,  go: 200 },
  electronic: { label: 'Electronic (M15M)',           currency: 'M', start: 15000000, go: 2000000 },
  custom:     { label: 'Custom' },
};
const NOTES = {
  collect: ['Sold houses', 'Mortgage', 'Card', 'Bank payout'],
  payBank: ['Buy property', 'Houses', 'Tax', 'Card', 'Jail fine', 'Unmortgage'],
  payPlayer: ['Rent', 'Trade', 'Card'],
  request: ['Rent', 'Trade', 'Card'],
  pot: ['Tax', 'Jail fine', 'Card'],
};

const state = {
  user: null,
  game: null, players: [], txs: [], requests: [], me: null,
  channel: null, reloadTimer: null,
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Math.abs(Number(n) || 0).toLocaleString('en-US');
const money = (n, g = state.game) => `${Number(n) < 0 ? '-' : ''}${g?.currency ?? '$'}${num(n)}`;
const parseAmount = (s) => Number(String(s ?? '').replace(/\D/g, '')) || 0;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// hand-drawn line icons (24px grid)
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  share: '<path d="M12 15V3M8 7l4-4 4 4M5 12v7h14v-7"/>',
  book: '<path d="M5 5.5A2.5 2.5 0 017.5 3H19v15H7.5A2.5 2.5 0 005 20.5zM5 20.5A2.5 2.5 0 007.5 23H19v-5"/>',
  collect: '<path d="M12 3v11M7 9.5l5 5 5-5M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"/>',
  pay: '<path d="M12 15V4M7 8.5l5-5 5 5M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"/>',
  swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
  ask: '<path d="M4 6h16v12H4zM4 7l8 6 8-6"/>',
  bank: '<path d="M3 9.5L12 4l9 5.5M5 10v8M9.7 10v8M14.3 10v8M19 10v8M3 20.5h18"/>',
  pot: '<circle cx="12" cy="12" r="9"/><path d="M10 17V7.5h3a2.75 2.75 0 010 5.5h-3"/>',
  scale: '<path d="M12 4v16M7 20h10M5 7h14M5 7l-2.5 6a2.5 2.5 0 005 0zM19 7l-2.5 6a2.5 2.5 0 005 0z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  del: '<path d="M21 5H9l-6 7 6 7h12zM12.5 9.5l5 5M17.5 9.5l-5 5"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const LOGO = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true">
  <rect x="4" y="14" width="50" height="32" rx="5" fill="#1d5b3e" transform="rotate(-8 29 30)"/>
  <rect x="10" y="18" width="50" height="32" rx="5" fill="#fbf8f2" stroke="#1d5b3e" stroke-width="2.5"/>
  <rect x="14.5" y="22.5" width="41" height="23" rx="3" fill="none" stroke="#1d5b3e" stroke-width="1.2" opacity=".5"/>
  <circle cx="35" cy="34" r="7.5" fill="#e3b23c"/>
  <text x="35" y="38.3" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="11" fill="#2b2104">$</text>
</svg>`;
// splits "R1,500" so the currency symbol can be styled smaller
const moneyHTML = (n, g = state.game) =>
  `${Number(n) < 0 ? '−' : ''}<span class="cur">${esc(g?.currency ?? '$')}</span>${esc(num(n))}`;

// ------------------------------------------------------------------ ui helpers

let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), type === 'error' ? 4000 : 2200);
}

function cleanError(err) {
  const m = err?.message || String(err);
  if (/anonymous/i.test(m) && /disabled/i.test(m)) return 'Anonymous sign-in is turned off in Supabase';
  return m.replace(/^.*?ERROR:\s*/i, '');
}

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) { toast(cleanError(error), 'error'); throw error; }
  return data;
}

function openSheet(html) {
  const root = $('#sheet-root');
  sheetKeys = null;
  root.innerHTML = `<div class="backdrop"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  root.hidden = false;
  $('.backdrop', root).onclick = closeSheet;
  return $('.sheet', root);
}
function closeSheet() {
  const root = $('#sheet-root');
  root.hidden = true;
  root.innerHTML = '';
  sheetKeys = null;
}
let sheetKeys = null; // set by the amount keypad while it's open
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeSheet();
  if (sheetKeys && !$('#sheet-root').hidden) sheetKeys(e);
});

function busy(btn, fn) {
  return async (...a) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(...a); } catch (e) { console.error(e); } finally { btn.disabled = false; }
  };
}

function bindAmountInput(input) {
  input.addEventListener('input', () => {
    const v = parseAmount(input.value);
    input.value = v ? v.toLocaleString('en-US') : '';
  });
}

// quick-add chips scale with the game's money size
function quickChips(g) {
  const scale = Math.max(1, 10 ** Math.round(Math.log10(Math.max(1, g.starting_balance || g.go_amount || 1500) / 1500)));
  return [1, 5, 10, 20, 50, 100, 500].map((n) => n * scale);
}

// ------------------------------------------------------------------ routing

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  leaveGame();
  if (page === 'game' && arg) return showGame(arg.toUpperCase());
  if (page === 'new') return showCreate();
  return showHome(page === 'join' ? arg : '');
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// ------------------------------------------------------------------ home

async function showHome(prefillCode = '') {
  const name = store.get('pb-name') || '';
  app.innerHTML = `
    <header class="brand">
      ${LOGO}
      <div><h1>Pocket Banker</h1><p class="muted">No more paper money all over the table.</p></div>
    </header>
    <form class="card stack join" id="join">
      <div><h2>Join a game</h2><p class="muted small">Ask the banker for the 4-letter code.</p></div>
      <label class="field"><span>Game code</span>
        <input class="code-input" name="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" required value="${esc(prefillCode || '')}" placeholder="····"></label>
      <label class="field"><span>Your name</span>
        <input name="name" maxlength="20" required value="${esc(name)}" autocomplete="nickname" placeholder="What should the table call you?"></label>
      <button class="btn primary block big" type="submit">Take a seat</button>
    </form>
    <div class="or">or</div>
    <a class="btn block big" href="#/new">${icon('bank')} Start a game and be the banker</a>
    <div class="section-title"><span>Your games</span></div>
    <div id="mine" class="card games"><p class="muted" style="padding:14px 16px">Loading…</p></div>
  `;
  const form = $('#join');
  const btn = $('button[type=submit]', form);
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(btn, async () => {
      const fd = new FormData(form);
      const n = String(fd.get('name')).trim();
      store.set('pb-name', n);
      const code = await rpc('join_game', { p_code: String(fd.get('code')).trim().toUpperCase(), p_name: n });
      go(`#/game/${code}`);
    })();
  };

  const { data, error } = await sb.from('players')
    .select('name, balance, games!inner(code, name, currency, created_at)')
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false })
    .limit(20);
  const mine = $('#mine');
  if (!mine) return;
  if (error) { mine.innerHTML = `<p class="muted" style="padding:14px 16px">${esc(cleanError(error))}</p>`; return; }
  if (!data.length) { mine.innerHTML = `<p class="muted" style="padding:14px 16px">Nothing yet. Games you join on this phone show up here.</p>`; return; }
  mine.innerHTML = data.map((p) => `
    <a class="game-link" href="#/game/${esc(p.games.code)}">
      <span class="code">${esc(p.games.code)}</span>
      <div class="grow"><strong>${esc(p.games.name)}</strong><div class="muted small">as ${esc(p.name)}</div></div>
      <strong class="num">${esc(money(p.balance, p.games))}</strong>
    </a>`).join('');
}

// ------------------------------------------------------------------ create

// locked = approval is on and play has started: money rules can't be loosened
function settingsFields(g = {}, locked = false) {
  const dis = locked ? 'disabled' : '';
  return `
    <div class="grid-2">
      <label class="field"><span>Currency symbol</span><input name="currency" maxlength="4" required value="${esc(g.currency ?? '$')}"></label>
      <label class="field"><span>Passing GO pays</span><input name="go" inputmode="numeric" class="amt" required ${dis} value="${esc(num(g.go_amount ?? 200))}"></label>
    </div>
    <label class="field"><span>Starting money per player</span><input name="start" inputmode="numeric" class="amt" required ${dis} value="${esc(num(g.starting_balance ?? 1500))}"></label>
    <label class="toggle"><input type="checkbox" name="require_approval" ${dis} ${(g.require_approval ?? true) ? 'checked' : ''}>
      <span><strong>Approve bank payouts</strong><br><span class="muted small">Money from the bank or pot needs the banker's OK. The banker's own payouts need another player's OK.${locked ? ' Locked once play starts, along with GO and starting money.' : ''}</span></span></label>
    <label class="toggle"><input type="checkbox" name="free_parking" ${g.free_parking ? 'checked' : ''}>
      <span><strong>Free Parking pot</strong><br><span class="muted small">Taxes and fines can go into a pot someone collects</span></span></label>
    <label class="toggle"><input type="checkbox" name="allow_negative" ${g.allow_negative ? 'checked' : ''}>
      <span><strong>Allow negative balances</strong><br><span class="muted small">Otherwise players can't pay more than they have</span></span></label>
    <label class="field"><span>House rules (anything specific to your box)</span>
      <textarea name="rules" maxlength="4000" placeholder="e.g. Land exactly on GO = double. Auctions on. No rent while in jail.">${esc(g.rules_notes ?? '')}</textarea></label>
  `;
}
// disabled (locked) fields are sent as null = "leave unchanged"
function readSettings(form) {
  const f = form.elements;
  const amount = (el) => (el.disabled ? null : parseAmount(el.value));
  const check = (el) => (el.disabled ? null : el.checked);
  return {
    p_currency: f.currency.value.trim(),
    p_starting: amount(f.start),
    p_go: amount(f.go),
    p_free_parking: check(f.free_parking),
    p_allow_negative: check(f.allow_negative),
    p_require_approval: check(f.require_approval),
    p_rules: f.rules.value,
  };
}

function showCreate() {
  const name = store.get('pb-name') || '';
  app.innerHTML = `
    <div class="topbar"><a class="btn ghost icon-btn" href="#/" aria-label="Back">${icon('back')}</a>
      <div class="title"><h1>New game</h1><div class="sub">You'll be the banker</div></div></div>
    <form class="card stack" id="create">
      <label class="field"><span>Game name</span><input name="game_name" maxlength="40" placeholder="Sunday at Mom & Dad's"></label>
      <label class="field"><span>Your name</span><input name="name" maxlength="20" required value="${esc(name)}"></label>
      <label class="field"><span>Which box are you playing?</span>
        <select name="preset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select></label>
      ${settingsFields()}
      <button class="btn primary block big" type="submit">Open the bank</button>
      <p class="muted small">Everything except the locked money rules can be changed later under Rules.</p>
    </form>`;
  const form = $('#create');
  $$('.amt', form).forEach(bindAmountInput);
  form.preset.onchange = () => {
    const p = PRESETS[form.preset.value];
    if (!p.currency) return;
    form.currency.value = p.currency;
    form.start.value = num(p.start);
    form.go.value = num(p.go);
  };
  const btn = $('button[type=submit]', form);
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(btn, async () => {
      const n = form.name.value.trim();
      store.set('pb-name', n);
      const code = await rpc('create_game', { p_game_name: form.game_name.value, p_player_name: n, ...readSettings(form) });
      go(`#/game/${code}`);
    })();
  };
}

// ------------------------------------------------------------------ game: data

function leaveGame() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = null;
  state.game = null;
  closeSheet();
}

async function loadGameByCode(code) {
  const { data, error } = await sb.from('games').select('*').eq('code', code).maybeSingle();
  if (error) throw error;
  return data;
}

async function reload() {
  const gid = state.game?.id;
  if (!gid) return;
  const [g, p, t, r] = await Promise.all([
    sb.from('games').select('*').eq('id', gid).single(),
    sb.from('players').select('*').eq('game_id', gid).order('created_at'),
    sb.from('transactions').select('*').eq('game_id', gid).order('id', { ascending: false }).limit(150),
    sb.from('payment_requests').select('*').eq('game_id', gid).eq('status', 'pending').order('id'),
  ]);
  const err = g.error || p.error || t.error || r.error;
  if (err) { toast(cleanError(err), 'error'); return; }
  if (state.game?.id !== gid) return; // navigated away meanwhile
  state.game = g.data;
  state.players = p.data;
  state.txs = t.data;
  state.requests = r.data;
  state.me = p.data.find((x) => x.user_id === state.user.id);
  renderGame();
}
function scheduleReload() {
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(reload, 120);
}

function subscribe(gid) {
  const ch = sb.channel(`game-${gid}`);
  for (const table of ['players', 'transactions', 'payment_requests']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `game_id=eq.${gid}` }, scheduleReload);
  }
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gid}` }, scheduleReload);
  ch.subscribe((status) => { if (status === 'SUBSCRIBED') scheduleReload(); });
  state.channel = ch;
}

// phones drop websockets while asleep; catch up when we come back
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.game) scheduleReload(); });
window.addEventListener('online', () => state.game && scheduleReload());

async function showGame(code) {
  app.innerHTML = `<div class="center muted">Opening ${esc(code)}…</div>`;
  let g;
  try { g = await loadGameByCode(code); } catch (e) { toast(cleanError(e), 'error'); }
  if (!g) { go(`#/join/${code}`); return; } // not a member yet (or no such game)
  state.game = g;
  subscribe(g.id);
  await reload();
}

// ------------------------------------------------------------------ game: render

const playerById = (id) => state.players.find((p) => p.id === id);
const isBanker = () => state.game && state.game.host_id === state.user.id;
function partyName(type, id) {
  if (type === 'bank') return 'Bank';
  if (type === 'pot') return 'Pot';
  return playerById(id)?.name ?? 'Someone';
}
function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderGame() {
  const g = state.game, me = state.me;
  if (!g || !me) return;
  const banker = isBanker();
  const hostPlayer = state.players.find((p) => p.user_id === g.host_id);
  // mine to approve first, then my own, then everyone else's (for transparency)
  const rank = (r) => (approversOf(r).includes(me.id) ? 0 : r.requester === me.id ? 1 : 2);
  const pending = [...state.requests].sort((a, b) => rank(a) - rank(b) || a.id - b.id);

  const collectSub = g.require_approval ? (banker ? 'Another player OKs it' : 'The banker OKs it') : 'Cards, sales, payouts';
  app.innerHTML = `
    <div class="topbar">
      <a class="btn ghost icon-btn" href="#/" aria-label="All games">${icon('back')}</a>
      <div class="title"><h1>${esc(g.name)}</h1><div class="sub">${state.players.length} player${state.players.length === 1 ? '' : 's'}${hostPlayer ? ` · ${esc(hostPlayer.name)} is banker` : ''}</div></div>
      <button class="code-pill" id="share" aria-label="Share game code ${esc(g.code)}">${icon('share')}${esc(g.code)}</button>
      <button class="btn ghost icon-btn" id="rules" aria-label="Rules">${icon('book')}</button>
    </div>

    <section class="banknote" style="--pc:${esc(me.color)}">
      <div class="who"><span class="token" style="background:${esc(me.color)}"></span>${esc(me.name)}${banker ? '<span class="stamp">BANKER</span>' : ''}</div>
      <div class="label">Your balance</div>
      <div class="amount ${me.balance < 0 ? 'neg' : ''}">${moneyHTML(me.balance)}</div>
    </section>

    ${pending.map((r) => requestRow(r)).join('')}

    <button class="go-btn" id="a-go">
      <span><span class="go">GO</span><div class="go-sub">Passed it? Collect.</div></span>
      <span class="go-amt">+${esc(money(g.go_amount))}</span>
    </button>
    <div class="tiles">
      <button class="tile in" id="a-collect"><span class="ic">${icon('collect')}</span><span><strong>Collect from bank</strong><small>${esc(collectSub)}</small></span></button>
      <button class="tile out" id="a-paybank"><span class="ic">${icon('pay')}</span><span><strong>Pay the bank</strong><small>Buy, build, tax, fines</small></span></button>
      <button class="tile" id="a-payplayer"><span class="ic">${icon('swap')}</span><span><strong>Pay a player</strong><small>Rent, trades</small></span></button>
      <button class="tile req" id="a-request"><span class="ic">${icon('ask')}</span><span><strong>Ask for money</strong><small>They tap to pay you</small></span></button>
    </div>
    ${g.free_parking ? `<button class="wide-btn" id="a-pot"><span class="ic">${icon('pot')}</span><span><strong>Free Parking pot</strong><small>Pay in or collect</small></span><span class="val">${esc(money(g.pot))}</span></button>` : ''}
    ${banker ? `<button class="wide-btn" id="a-banker"><span class="ic">${icon('scale')}</span><span><strong>Banker desk</strong><small>Move money between anyone${g.require_approval ? ' (needs an OK)' : ''}</small></span></button>` : ''}

    <div class="section-title"><span>At the table</span><span>tap a player</span></div>
    <div class="deeds">
      ${state.players.map((p) => `
        <button class="deed ${p.id === me.id ? 'me' : ''}" style="--pc:${esc(p.color)}" data-player="${p.id}">
          <div class="band">${esc(p.name)}</div>
          <div class="body">
            <span class="bal ${p.balance < 0 ? 'neg' : ''}">${esc(money(p.balance))}</span>
            ${p.user_id === g.host_id ? '<span class="stamp sm">BANKER</span>' : p.id === me.id ? '<span class="you">You</span>' : ''}
          </div>
        </button>`).join('')}
    </div>
    ${state.players.length < 2 ? `<p class="muted small" style="margin-top:10px">Nobody else yet. Tap <strong>${esc(g.code)}</strong> at the top to send the invite.</p>` : ''}

    <div class="section-title" id="activity"><span>Ledger</span></div>
    <div class="card ledger">
      ${state.txs.length ? state.txs.map(txRow).join('') : '<p class="muted" style="padding:14px 16px">Nothing yet.</p>'}
    </div>
  `;

  $('#share').onclick = shareCode;
  $('#rules').onclick = rulesSheet;
  $('#a-go').onclick = (e) => busy(e.currentTarget, passGo)();
  $('#a-collect').onclick = () => amountSheet({
    title: 'Collect from the bank', confirm: 'Collect', notes: NOTES.collect,
    submit: (amt, note) => transfer('bank', null, 'player', me.id, amt, note), done: (a) => `+${money(a)} from the bank`,
  });
  $('#a-paybank').onclick = () => amountSheet({
    title: 'Pay the bank', confirm: 'Pay', notes: NOTES.payBank,
    submit: (amt, note) => transfer('player', me.id, 'bank', null, amt, note), done: (a) => `Paid ${money(a)} to the bank`,
  });
  $('#a-payplayer').onclick = () => payPlayerSheet();
  $('#a-request').onclick = () => requestSheet();
  $('#a-pot')?.addEventListener('click', potSheet);
  $('#a-banker')?.addEventListener('click', () => bankerSheet());
  $$('[data-player]').forEach((b) => (b.onclick = () => playerSheet(b.dataset.player)));
  $$('[data-approve-req]').forEach((b) => (b.onclick = busy(b, async () => {
    await rpc('respond_request', { p_request: Number(b.dataset.approveReq), p_accept: true });
    toast('Done');
  })));
  $$('[data-reject-req]').forEach((b) => (b.onclick = busy(b, async () => {
    await rpc('respond_request', { p_request: Number(b.dataset.rejectReq), p_accept: false });
  })));
  $$('[data-undo]').forEach((b) => (b.onclick = busy(b, async () => {
    const t = state.txs.find((x) => x.id === Number(b.dataset.undo));
    if (!t || !confirm(`Undo ${partyName(t.from_type, t.from_player)} → ${partyName(t.to_type, t.to_player)} ${money(t.amount)}?`)) return;
    const res = await rpc('undo_transaction', { p_tx: t.id });
    toast(res === 'pending' ? 'Undo sent for approval' : 'Undone');
  })));
}

// Mirrors public._approvers() in schema.sql (the server has the final say).
function approversOf(r) {
  const ids = state.players.map((p) => p.id);
  if (r.reverses) return ids.filter((id) => id !== r.requester);
  if (r.from_type === 'player') return [r.from_player];
  const bankerId = state.players.find((p) => p.user_id === state.game.host_id)?.id;
  if (bankerId && bankerId !== r.requester && bankerId !== r.to_player) return [bankerId];
  const others = ids.filter((id) => id !== r.requester && id !== r.to_player && id !== bankerId);
  if (!others.length && r.to_player && r.to_player !== r.requester) return [r.to_player];
  return others;
}

function requestRow(r) {
  const me = state.me;
  const who = (id) => (id === me.id ? 'you' : partyName('player', id));
  const req = r.requester === me.id ? 'You' : partyName('player', r.requester);
  const amt = `<strong>${esc(money(r.amount))}</strong>`;
  const note = r.note && !r.reverses ? ` <span class="small">· ${esc(r.note)}</span>` : '';
  let text;
  if (r.reverses) {
    text = `${esc(req)} want${req === 'You' ? '' : 's'} to undo ${esc(partyName(r.to_type, r.to_player))} → ${esc(partyName(r.from_type, r.from_player))} ${amt}`;
  } else if (r.from_type === 'player') {
    text = `${esc(req)} asked ${esc(who(r.from_player))} for ${amt}`;
  } else {
    const src = r.from_type === 'pot' ? 'the pot' : 'the bank';
    const forWhom = r.to_type === 'player' && r.to_player !== r.requester ? ` for ${esc(who(r.to_player))}` : '';
    const dest = r.to_type !== 'player' ? ` to ${r.to_type === 'pot' ? 'the pot' : 'the bank'}` : '';
    text = `${esc(req)} want${req === 'You' ? '' : 's'} ${amt} from ${src}${forWhom}${dest}`;
  }

  const approvers = approversOf(r);
  const canApprove = approvers.includes(me.id);
  const mine = r.requester === me.id;
  let waiting = '';
  if (!canApprove) {
    const names = approvers.map((id) => partyName('player', id));
    waiting = `<div class="wait">Waiting for ${esc(
      !names.length ? 'another player to join' : names.length === 1 ? names[0] : names.length > 2 ? 'any other player' : names.join(' or ')
    )}</div>`;
  }
  const isPay = r.from_type === 'player' && r.from_player === me.id && !r.reverses;
  const acts = canApprove
    ? `<button class="btn primary" data-approve-req="${r.id}">${isPay ? `Pay ${esc(money(r.amount))}` : 'Approve'}</button>
       <button class="btn" data-reject-req="${r.id}">${isPay ? 'Decline' : 'Reject'}</button>`
    : mine ? `<button class="btn" data-reject-req="${r.id}">Cancel request</button>` : '';
  return `
    <div class="slip ${canApprove ? 'mine-to-act' : ''}">
      <div class="what">${text}${note}</div>
      ${waiting}
      ${acts ? `<div class="acts">${acts}</div>` : ''}
    </div>`;
}

function txRow(t) {
  const me = state.me;
  const inbound = t.to_type === 'player' && t.to_player === me.id;
  const outbound = t.from_type === 'player' && t.from_player === me.id;
  const by = playerById(t.created_by);
  const actor = t.from_type === 'player' ? t.from_player : t.to_type === 'player' ? t.to_player : null;
  const approver = playerById(t.approved_by);
  const byLine = (by && t.created_by !== actor ? ` · by ${by.name}` : '') + (approver ? ` · ✓ ${approver.name}` : '');
  const undoPending = state.requests.some((r) => r.reverses === t.id);
  const canUndo = t.kind === 'normal' && !t.reversed_by && !undoPending && (t.created_by === me.id || isBanker());
  return `
    <div class="entry ${t.reversed_by ? 'reversed' : ''}">
      <div class="grow">
        <div class="flow"><span>${esc(partyName(t.from_type, t.from_player))}</span>${icon('arrow')}<span>${esc(partyName(t.to_type, t.to_player))}</span></div>
        <div class="meta">${esc(t.note || '')}${t.note ? ' · ' : ''}${esc(timeAgo(t.created_at))}${esc(byLine)}</div>
      </div>
      <div class="amt ${inbound ? 'in' : outbound ? 'out' : ''}">${inbound ? '+' : outbound ? '−' : ''}${esc(money(t.amount))}</div>
      ${canUndo ? `<button class="undo" data-undo="${t.id}" aria-label="Undo">${icon('undo')}</button>` : ''}
    </div>`;
}

// ------------------------------------------------------------------ game: actions

async function transfer(fromType, from, toType, to, amount, note) {
  return rpc('transfer', {
    p_game: state.game.id, p_from_type: fromType, p_from: from, p_to_type: toType, p_to: to,
    p_amount: amount, p_note: note || null,
  });
}

async function passGo() {
  const g = state.game;
  if (!g.go_amount) return toast('Passing GO pays nothing in this game');
  await rpc('pass_go', { p_game: g.id });
  toast(`+${money(g.go_amount)} for passing GO`);
}

async function shareCode() {
  const g = state.game;
  const url = `${location.origin}${location.pathname}#/join/${g.code}`;
  const text = `Join "${g.name}" on Pocket Banker. Code: ${g.code}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Pocket Banker', text, url }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invite link copied'); }
  catch { toast(`Game code: ${g.code}`); }
}

/**
 * Generic money sheet.
 *  pick: array of players to choose one from (or null)
 *  parties: true for banker from/to pickers
 */
function amountSheet({ title, confirm, notes = [], pick = null, pickLabel = 'Who?', preselect = null, parties = false, amount = 0, submit, done }) {
  const g = state.game;
  const partyOpts = (sel) => [
    ['bank:', 'Bank'],
    ...(g.free_parking ? [['pot:', `Pot (${money(g.pot)})`]] : []),
    ...state.players.map((p) => [`player:${p.id}`, `${p.name} (${money(p.balance)})`]),
  ].map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

  const el = openSheet(`
    <form class="stack" id="amt-form">
      <h2>${esc(title)}</h2>
      ${pick ? `
        <div><div class="muted small" style="margin-bottom:8px">${esc(pickLabel)}</div>
        <div class="pick">${pick.map((p) => `
          <button type="button" class="chip ${p.id === preselect ? 'on' : ''}" data-pick="${p.id}">
            <span class="token" style="background:${esc(p.color)}"></span>${esc(p.name)}</button>`).join('')}</div></div>` : ''}
      ${parties ? `
        <div class="grid-2">
          <label class="field"><span>From</span><select name="from">${partyOpts(preselect?.from ?? 'bank:')}</select></label>
          <label class="field"><span>To</span><select name="to">${partyOpts(preselect?.to ?? `player:${state.players[0]?.id}`)}</select></label>
        </div>` : ''}
      <div class="display" aria-live="polite"><span class="cur">${esc(g.currency)}</span><span class="val">0</span></div>
      <div class="note-row">
        ${quickChips(g).map((c) => `<button type="button" class="chip" data-add="${c}">+${esc(num(c))}</button>`).join('')}
      </div>
      <div class="keypad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button type="button" class="key" data-key="${d}">${d}</button>`).join('')}
        <button type="button" class="key" data-key="000">000</button>
        <button type="button" class="key" data-key="0">0</button>
        <button type="button" class="key fn" data-key="del" aria-label="Delete">${icon('del')}</button>
      </div>
      <div class="note-row">
        ${notes.map((n) => `<button type="button" class="chip" data-note="${esc(n)}">${esc(n)}</button>`).join('')}
        <button type="button" class="chip" data-note-other>${notes.length ? 'Other…' : 'Add a note'}</button>
      </div>
      <input name="note" maxlength="60" placeholder="What's it for?" hidden>
      <button class="btn primary block big" type="submit">${esc(confirm)}</button>
    </form>`);

  const form = $('#amt-form', el);
  const display = $('.display', el);
  let value = amount || 0;
  const MAX = 999999999999;
  const submitBtn = $('button[type=submit]', form);
  const show = () => {
    $('.val', display).textContent = num(value);
    display.classList.toggle('empty', !value);
    submitBtn.textContent = value ? `${confirm} ${money(value)}` : confirm;
  };
  const press = (k) => {
    if (k === 'del') value = Math.floor(value / 10);
    else if (k === 'clear') value = 0;
    else {
      const next = Number(String(value || '') + k);
      if (next <= MAX) value = next;
    }
    show();
  };
  show();
  $$('[data-key]', el).forEach((b) => (b.onclick = () => press(b.dataset.key)));
  // long-press delete clears
  const delKey = $('[data-key="del"]', el);
  let holdTimer;
  delKey.addEventListener('pointerdown', () => { holdTimer = setTimeout(() => press('clear'), 500); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => delKey.addEventListener(ev, () => clearTimeout(holdTimer)));
  // physical keyboard support (desktop)
  sheetKeys = (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (/^\d$/.test(e.key)) { press(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { press('del'); e.preventDefault(); }
    else if (e.key === 'Enter') { form.requestSubmit(); e.preventDefault(); }
  };

  let picked = pick ? preselect : null;
  $$('[data-pick]', el).forEach((b) => (b.onclick = () => {
    picked = b.dataset.pick;
    $$('[data-pick]', el).forEach((x) => x.classList.toggle('on', x === b));
  }));
  $$('[data-add]', el).forEach((b) => (b.onclick = () => {
    value = Math.min(MAX, value + Number(b.dataset.add));
    show();
  }));
  $$('[data-note]', el).forEach((b) => (b.onclick = () => {
    const on = !b.classList.contains('on');
    form.note.value = on ? b.dataset.note : '';
    form.note.hidden = true;
    $$('[data-note], [data-note-other]', el).forEach((x) => x.classList.toggle('on', on && x === b));
  }));
  $('[data-note-other]', el).onclick = (e) => {
    $$('[data-note]', el).forEach((x) => x.classList.remove('on'));
    e.currentTarget.classList.add('on');
    form.note.value = '';
    form.note.hidden = false;
    form.note.focus();
  };

  const btn = $('button[type=submit]', form);
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(btn, async () => {
      const a = value;
      if (!a) { toast('Enter an amount', 'error'); return; }
      if (pick && !picked) { toast('Choose a player', 'error'); return; }
      let extra = {};
      if (parties) {
        const [ft, fid] = form.from.value.split(':');
        const [tt, tid] = form.to.value.split(':');
        extra = { ft, fid: fid || null, tt, tid: tid || null };
      }
      const res = await submit(a, form.note.value.trim(), picked, extra);
      closeSheet();
      if (res === 'pending') toast('Sent for approval');
      else if (done) toast(done(a, picked, extra));
    })();
  };
}

function payPlayerSheet(preselect = null) {
  const others = state.players.filter((p) => p.id !== state.me.id);
  if (!others.length) return toast('No one else has joined yet', 'error');
  amountSheet({
    title: 'Pay a player', confirm: 'Pay', pick: others, pickLabel: 'Pay who?', notes: NOTES.payPlayer,
    preselect: preselect ?? (others.length === 1 ? others[0].id : null),
    submit: (a, note, to) => transfer('player', state.me.id, 'player', to, a, note),
    done: (a, to) => `Paid ${money(a)} to ${partyName('player', to)}`,
  });
}

function requestSheet(preselect = null) {
  const others = state.players.filter((p) => p.id !== state.me.id);
  if (!others.length) return toast('No one else has joined yet', 'error');
  amountSheet({
    title: 'Ask for money', confirm: 'Send request', pick: others, pickLabel: 'Who owes you?', notes: NOTES.request,
    preselect: preselect ?? (others.length === 1 ? others[0].id : null),
    submit: (a, note, payer) => rpc('request_payment', { p_game: state.game.id, p_payer: payer, p_amount: a, p_note: note || null }),
    done: (a, payer) => `Asked ${partyName('player', payer)} for ${money(a)}`,
  });
}

function potSheet() {
  const g = state.game;
  const el = openSheet(`
    <div class="stack">
      <h2>Free Parking pot</h2>
      <p class="muted">The pot holds <strong>${esc(money(g.pot))}</strong>.</p>
      <button class="btn primary block big" id="pot-collect" ${g.pot > 0 ? '' : 'disabled'}>Collect the pot</button>
      <button class="btn block big" id="pot-pay">Pay into the pot</button>
    </div>`);
  $('#pot-collect', el).onclick = busy($('#pot-collect', el), async () => {
    const res = await transfer('pot', null, 'player', state.me.id, g.pot, 'Free Parking');
    closeSheet();
    toast(res === 'pending' ? 'Sent for approval' : `+${money(g.pot)} from the pot`);
  });
  $('#pot-pay', el).onclick = () => amountSheet({
    title: 'Pay into the pot', confirm: 'Pay', notes: NOTES.pot,
    submit: (a, note) => transfer('player', state.me.id, 'pot', null, a, note), done: (a) => `Paid ${money(a)} into the pot`,
  });
}

function bankerSheet(preselect) {
  amountSheet({
    title: 'Banker: move money', confirm: 'Move money', parties: true, preselect,
    submit: (a, note, _p, x) => transfer(x.ft, x.fid, x.tt, x.tid, a, note),
    done: (a, _p, x) => `${partyName(x.ft, x.fid)} → ${partyName(x.tt, x.tid)}: ${money(a)}`,
  });
}

function playerSheet(pid) {
  const p = playerById(pid);
  if (!p) return;
  const me = state.me, banker = isBanker(), g = state.game;
  const self = p.id === me.id;
  const el = openSheet(`
    <div class="stack">
      <div class="sheet-head"><span class="token" style="background:${esc(p.color)}"></span><h2 class="grow">${esc(p.name)}</h2><strong class="num" style="font-size:1.3rem">${esc(money(p.balance))}</strong></div>
      ${self ? '' : `
        <button class="btn primary block big" id="p-pay">${icon('swap')} Pay ${esc(p.name)}</button>
        <button class="btn block big" id="p-req">${icon('ask')} Ask ${esc(p.name)} for money</button>`}
      ${banker ? `
        <div class="section-title"><span>Banker desk</span>${g.require_approval ? '<span>needs an OK</span>' : ''}</div>
        <button class="btn block" id="p-give">${icon('collect')} Give from the bank</button>
        <button class="btn block" id="p-take">${icon('pay')} Take back to the bank</button>
        ${!self ? `<button class="btn block" id="p-host">Make ${esc(p.name)} the banker</button>` : ''}` : ''}
      ${self && !banker ? `<p class="muted">That's you. Use the buttons on the main screen to move money.</p>` : ''}
    </div>`);
  $('#p-pay', el)?.addEventListener('click', () => payPlayerSheet(p.id));
  $('#p-req', el)?.addEventListener('click', () => requestSheet(p.id));
  $('#p-give', el)?.addEventListener('click', () => amountSheet({
    title: `Give ${p.name} money from the bank`, confirm: 'Give', notes: ['Passed GO', ...NOTES.collect],
    submit: (a, note) => transfer('bank', null, 'player', p.id, a, note), done: (a) => `${p.name} +${money(a)}`,
  }));
  $('#p-take', el)?.addEventListener('click', () => amountSheet({
    title: `Take money from ${p.name}`, confirm: 'Take', notes: NOTES.payBank,
    submit: (a, note) => transfer('player', p.id, 'bank', null, a, note), done: (a) => `${p.name} −${money(a)}`,
  }));
  $('#p-host', el)?.addEventListener('click', busy($('#p-host', el) || document.createElement('button'), async () => {
    if (!confirm(`Hand the bank over to ${p.name}? You'll become a normal player.`)) return;
    await rpc('make_banker', { p_game: g.id, p_player: p.id });
    closeSheet();
    toast(`${p.name} is now the banker`);
  }));
}

function rulesSheet() {
  const g = state.game;
  const banker = isBanker();
  const view = `
    <div class="stack">
      <h2>Rules for this game</h2>
      <dl class="settings">
        <dt>Currency</dt><dd>${esc(g.currency)}</dd>
        <dt>Starting money</dt><dd>${esc(money(g.starting_balance))}</dd>
        <dt>Passing GO</dt><dd>${esc(money(g.go_amount))}</dd>
        <dt>Approve bank payouts</dt><dd>${g.require_approval ? 'On' : 'Off'}</dd>
        <dt>Free Parking pot</dt><dd>${g.free_parking ? 'On' : 'Off'}</dd>
        <dt>Negative balances</dt><dd>${g.allow_negative ? 'Allowed' : 'Not allowed'}</dd>
      </dl>
      <div class="section-title"><span>House rules</span></div>
      <div class="rules-text">${g.rules_notes ? esc(g.rules_notes) : '<span class="muted">None written yet.</span>'}</div>
      ${banker ? '<button class="btn block" id="edit-rules">Edit rules</button>' : '<p class="muted small">Only the banker can change these.</p>'}
    </div>`;
  const el = openSheet(view);
  $('#edit-rules', el)?.addEventListener('click', () => {
    const el2 = openSheet(`
      <form class="stack" id="rules-form">
        <h2>Edit rules</h2>
        <label class="field"><span>Game name</span><input name="game_name" maxlength="40" value="${esc(g.name)}"></label>
        ${settingsFields(g, g.require_approval && state.txs.some((t) => t.kind !== 'start'))}
        <p class="muted small">Changing starting money only affects players who join after this.</p>
        <button class="btn primary block big" type="submit">Save</button>
      </form>`);
    const form = $('#rules-form', el2);
    $$('.amt', form).forEach(bindAmountInput);
    const btn = $('button[type=submit]', form);
    form.onsubmit = (e) => {
      e.preventDefault();
      busy(btn, async () => {
        await rpc('update_game', { p_game: g.id, p_name: form.game_name.value, ...readSettings(form) });
        closeSheet();
        toast('Rules saved');
      })();
    };
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  if (SUPABASE_URL.includes('YOUR-PROJECT')) {
    app.innerHTML = '<div class="center"><h2>Almost there</h2><p class="muted">Add your Supabase URL in config.js.</p></div>';
    return;
  }
  let { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) {
      app.innerHTML = `<div class="center"><h2>Can't sign in</h2><p class="muted">${esc(cleanError(error))}</p></div>`;
      return;
    }
    session = data.session;
  }
  state.user = session.user;
  window.addEventListener('hashchange', route);
  route();
}
boot();
