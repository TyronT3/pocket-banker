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
  root.innerHTML = `<div class="backdrop"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  root.hidden = false;
  $('.backdrop', root).onclick = closeSheet;
  return $('.sheet', root);
}
function closeSheet() {
  const root = $('#sheet-root');
  root.hidden = true;
  root.innerHTML = '';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

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
    <div class="hero">
      <img src="icon.svg" alt="">
      <h1>Pocket Banker</h1>
      <p class="muted">The bank for your board game night</p>
    </div>
    <form class="card stack" id="join">
      <h2>Join a game</h2>
      <label class="field"><span>Game code</span>
        <input class="code-input" name="code" maxlength="4" autocomplete="off" autocapitalize="characters" required value="${esc(prefillCode || '')}" placeholder="ABCD"></label>
      <label class="field"><span>Your name</span>
        <input name="name" maxlength="20" required value="${esc(name)}" autocomplete="nickname" placeholder="e.g. Tyron"></label>
      <button class="btn primary block big" type="submit">Join game</button>
    </form>
    <div style="margin-top:12px"><a class="btn block" href="#/new">Start a new game (you're the banker)</a></div>
    <h3>Your games</h3>
    <div id="mine" class="card list"><p class="muted" style="padding:14px 16px">Loading…</p></div>
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
  if (!data.length) { mine.innerHTML = `<p class="muted" style="padding:14px 16px">No games yet on this phone.</p>`; return; }
  mine.innerHTML = data.map((p) => `
    <a class="game-link" href="#/game/${esc(p.games.code)}">
      <div class="grow"><strong>${esc(p.games.name)}</strong><div class="muted small">${esc(p.games.code)} · playing as ${esc(p.name)}</div></div>
      <strong>${esc(money(p.balance, p.games))}</strong>
    </a>`).join('');
}

// ------------------------------------------------------------------ create

function settingsFields(g = {}) {
  return `
    <div class="grid-2">
      <label class="field"><span>Currency symbol</span><input name="currency" maxlength="4" required value="${esc(g.currency ?? '$')}"></label>
      <label class="field"><span>Passing GO pays</span><input name="go" inputmode="numeric" class="amt" required value="${esc(num(g.go_amount ?? 200))}"></label>
    </div>
    <label class="field"><span>Starting money per player</span><input name="start" inputmode="numeric" class="amt" required value="${esc(num(g.starting_balance ?? 1500))}"></label>
    <label class="toggle"><input type="checkbox" name="free_parking" ${g.free_parking ? 'checked' : ''}>
      <span><strong>Free Parking pot</strong><br><span class="muted small">Taxes and fines can go into a pot someone collects</span></span></label>
    <label class="toggle"><input type="checkbox" name="allow_negative" ${g.allow_negative ? 'checked' : ''}>
      <span><strong>Allow negative balances</strong><br><span class="muted small">Otherwise players can't pay more than they have</span></span></label>
    <label class="field"><span>House rules (anything specific to your box)</span>
      <textarea name="rules" maxlength="4000" placeholder="e.g. Land exactly on GO = double. Auctions on. No rent while in jail.">${esc(g.rules_notes ?? '')}</textarea></label>
  `;
}
function readSettings(form) {
  const fd = new FormData(form);
  return {
    p_currency: String(fd.get('currency')).trim(),
    p_starting: parseAmount(fd.get('start')),
    p_go: parseAmount(fd.get('go')),
    p_free_parking: fd.get('free_parking') === 'on',
    p_allow_negative: fd.get('allow_negative') === 'on',
    p_rules: String(fd.get('rules') ?? ''),
  };
}

function showCreate() {
  const name = store.get('pb-name') || '';
  app.innerHTML = `
    <div class="topbar"><a class="btn ghost icon-btn" href="#/" aria-label="Back">←</a><h1>New game</h1></div>
    <form class="card stack" id="create">
      <label class="field"><span>Game name</span><input name="game_name" maxlength="40" placeholder="Sunday at Mom & Dad's"></label>
      <label class="field"><span>Your name</span><input name="name" maxlength="20" required value="${esc(name)}"></label>
      <label class="field"><span>Version preset</span>
        <select name="preset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select></label>
      ${settingsFields()}
      <button class="btn primary block big" type="submit">Create game</button>
      <p class="muted small">You'll be the banker. You can change any of this later from the Rules button.</p>
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
  const incoming = state.requests.filter((r) => r.payer === me.id);
  const outgoing = state.requests.filter((r) => r.requester === me.id);

  app.innerHTML = `
    <div class="topbar">
      <a class="btn ghost icon-btn" href="#/" aria-label="Home">←</a>
      <h1 class="grow">${esc(g.name)}</h1>
      <button class="code-chip" id="share" aria-label="Share game code">${esc(g.code)}</button>
      <button class="btn icon-btn" id="rules">Rules</button>
    </div>

    <section class="balance-card">
      <div class="label"><span class="dot" style="background:${esc(me.color)}"></span>${esc(me.name)} ${banker ? '<span class="badge">BANKER</span>' : ''}</div>
      <div class="amount ${me.balance < 0 ? 'neg' : ''}">${esc(money(me.balance))}</div>
    </section>

    ${incoming.map((r) => `
      <div class="request">
        <div class="grow"><strong>${esc(partyName('player', r.requester))}</strong> asks for <strong>${esc(money(r.amount))}</strong>${r.note ? ` <span class="small">· ${esc(r.note)}</span>` : ''}</div>
        <button class="btn primary" data-pay-req="${r.id}">Pay</button>
        <button class="btn" data-decline-req="${r.id}" aria-label="Decline">✕</button>
      </div>`).join('')}
    ${outgoing.map((r) => `
      <div class="request">
        <div class="grow small">Waiting for <strong>${esc(partyName('player', r.payer))}</strong> to pay <strong>${esc(money(r.amount))}</strong>${r.note ? ` · ${esc(r.note)}` : ''}</div>
        <button class="btn" data-decline-req="${r.id}">Cancel</button>
      </div>`).join('')}

    <div class="actions">
      <button class="action go" id="a-go"><span class="ico">➜</span><strong>Pass GO</strong><small>+${esc(money(g.go_amount))}</small></button>
      <button class="action" id="a-collect"><span class="ico">🏦</span><strong>Collect from bank</strong><small>Get money</small></button>
      <button class="action" id="a-paybank"><span class="ico">💸</span><strong>Pay the bank</strong><small>Buy, tax, fines</small></button>
      <button class="action" id="a-payplayer"><span class="ico">🤝</span><strong>Pay a player</strong><small>Rent, trades</small></button>
      <button class="action" id="a-request"><span class="ico">📨</span><strong>Request money</strong><small>They tap to pay</small></button>
      ${g.free_parking
        ? `<button class="action" id="a-pot"><span class="ico">🅿️</span><strong>Pot: ${esc(money(g.pot))}</strong><small>Pay in or collect</small></button>`
        : `<button class="action" id="a-history"><span class="ico">🧾</span><strong>My history</strong><small>Jump to activity</small></button>`}
      ${banker ? `<button class="action wide" id="a-banker"><span class="ico">⚖️</span><span><strong>Banker: move money</strong><br><small>Between anyone, the bank${g.free_parking ? ' or the pot' : ''}</small></span></button>` : ''}
    </div>

    <h3>Players</h3>
    <div class="card players">
      ${state.players.map((p) => `
        <button class="player ${p.id === me.id ? 'me' : ''}" data-player="${p.id}">
          <span class="dot" style="background:${esc(p.color)}"></span>
          <span class="grow">${esc(p.name)}${p.id === me.id ? ' <span class="muted small">(you)</span>' : ''} ${p.user_id === g.host_id ? '<span class="badge">BANKER</span>' : ''}</span>
          <span class="bal ${p.balance < 0 ? 'neg' : ''}">${esc(money(p.balance))}</span>
        </button>`).join('')}
    </div>
    ${state.players.length < 2 ? `<p class="muted small" style="margin-top:8px">Share the code <strong>${esc(g.code)}</strong> so others can join.</p>` : ''}

    <h3 id="activity">Activity</h3>
    <div class="card feed">
      ${state.txs.length ? state.txs.map(txRow).join('') : '<p class="muted" style="padding:14px 16px">Nothing yet.</p>'}
    </div>
    ${!hostPlayer ? '' : `<p class="muted small" style="margin-top:12px;text-align:center">${esc(hostPlayer.name)} is the banker.</p>`}
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
  $('#a-history')?.addEventListener('click', () => $('#activity').scrollIntoView({ behavior: 'smooth' }));
  $('#a-banker')?.addEventListener('click', () => bankerSheet());
  $$('[data-player]').forEach((b) => (b.onclick = () => playerSheet(b.dataset.player)));
  $$('[data-pay-req]').forEach((b) => (b.onclick = busy(b, async () => {
    await rpc('respond_request', { p_request: Number(b.dataset.payReq), p_accept: true });
    toast('Paid');
  })));
  $$('[data-decline-req]').forEach((b) => (b.onclick = busy(b, async () => {
    await rpc('respond_request', { p_request: Number(b.dataset.declineReq), p_accept: false });
  })));
  $$('[data-undo]').forEach((b) => (b.onclick = busy(b, async () => {
    const t = state.txs.find((x) => x.id === Number(b.dataset.undo));
    if (!t || !confirm(`Undo ${partyName(t.from_type, t.from_player)} → ${partyName(t.to_type, t.to_player)} ${money(t.amount)}?`)) return;
    await rpc('undo_transaction', { p_tx: t.id });
    toast('Undone');
  })));
}

function txRow(t) {
  const me = state.me;
  const inbound = t.to_type === 'player' && t.to_player === me.id;
  const outbound = t.from_type === 'player' && t.from_player === me.id;
  const by = playerById(t.created_by);
  const actor = t.from_type === 'player' ? t.from_player : t.to_type === 'player' ? t.to_player : null;
  const byLine = by && t.created_by !== actor ? ` · by ${by.name}` : '';
  const canUndo = t.kind === 'normal' && !t.reversed_by && (t.created_by === me.id || isBanker());
  return `
    <div class="tx ${t.reversed_by ? 'reversed' : ''}">
      <div class="grow">
        <div class="who">${esc(partyName(t.from_type, t.from_player))} → ${esc(partyName(t.to_type, t.to_player))}</div>
        <div class="muted small">${esc(t.note || '')}${t.note ? ' · ' : ''}${esc(timeAgo(t.created_at))}${esc(byLine)}</div>
      </div>
      <div class="amt ${inbound ? 'in' : outbound ? 'out' : ''}">${inbound ? '+' : outbound ? '−' : ''}${esc(money(t.amount))}</div>
      ${canUndo ? `<button class="btn undo" data-undo="${t.id}">Undo</button>` : ''}
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
  await transfer('bank', null, 'player', state.me.id, g.go_amount, 'Passed GO');
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
        <div><div class="muted small" style="margin-bottom:6px">${esc(pickLabel)}</div>
        <div class="pick">${pick.map((p) => `
          <button type="button" class="chip ${p.id === preselect ? 'on' : ''}" data-pick="${p.id}">
            <span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</button>`).join('')}</div></div>` : ''}
      ${parties ? `
        <div class="grid-2">
          <label class="field"><span>From</span><select name="from">${partyOpts(preselect?.from ?? 'bank:')}</select></label>
          <label class="field"><span>To</span><select name="to">${partyOpts(preselect?.to ?? `player:${state.players[0]?.id}`)}</select></label>
        </div>` : ''}
      <label class="amount-field"><span>${esc(g.currency)}</span>
        <input name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${amount ? esc(num(amount)) : ''}" aria-label="Amount"></label>
      <div class="chips">
        ${quickChips(g).map((c) => `<button type="button" class="chip" data-add="${c}">+${esc(num(c))}</button>`).join('')}
        <button type="button" class="chip" data-clear>Clear</button>
      </div>
      <input name="note" maxlength="60" placeholder="Note (optional)">
      ${notes.length ? `<div class="chips">${notes.map((n) => `<button type="button" class="chip" data-note="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <button class="btn primary block big" type="submit">${esc(confirm)}</button>
    </form>`);

  const form = $('#amt-form', el);
  const amt = form.amount;
  bindAmountInput(amt);
  let picked = pick ? preselect : null;
  $$('[data-pick]', el).forEach((b) => (b.onclick = () => {
    picked = b.dataset.pick;
    $$('[data-pick]', el).forEach((x) => x.classList.toggle('on', x === b));
  }));
  $$('[data-add]', el).forEach((b) => (b.onclick = () => {
    amt.value = (parseAmount(amt.value) + Number(b.dataset.add)).toLocaleString('en-US');
  }));
  $('[data-clear]', el).onclick = () => { amt.value = ''; amt.focus(); };
  $$('[data-note]', el).forEach((b) => (b.onclick = () => {
    form.note.value = b.dataset.note;
    $$('[data-note]', el).forEach((x) => x.classList.toggle('on', x === b));
  }));
  if (!pick && !parties) setTimeout(() => amt.focus(), 50);

  const btn = $('button[type=submit]', form);
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(btn, async () => {
      const a = parseAmount(amt.value);
      if (!a) { toast('Enter an amount', 'error'); return; }
      if (pick && !picked) { toast('Choose a player', 'error'); return; }
      let extra = {};
      if (parties) {
        const [ft, fid] = form.from.value.split(':');
        const [tt, tid] = form.to.value.split(':');
        extra = { ft, fid: fid || null, tt, tid: tid || null };
      }
      await submit(a, form.note.value.trim(), picked, extra);
      closeSheet();
      if (done) toast(done(a, picked, extra));
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
    title: 'Request money', confirm: 'Send request', pick: others, pickLabel: 'Request from?', notes: NOTES.request,
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
    await transfer('pot', null, 'player', state.me.id, g.pot, 'Free Parking');
    closeSheet();
    toast(`+${money(g.pot)} from the pot`);
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
      <div class="row"><span class="dot" style="background:${esc(p.color)}"></span><h2 class="grow">${esc(p.name)}</h2><strong>${esc(money(p.balance))}</strong></div>
      ${self ? '' : `
        <button class="btn primary block big" id="p-pay">Pay ${esc(p.name)}</button>
        <button class="btn block big" id="p-req">Request from ${esc(p.name)}</button>`}
      ${banker ? `
        <h3 style="margin-top:16px">Banker</h3>
        <button class="btn block" id="p-give">Give from bank</button>
        <button class="btn block" id="p-take">Take to bank</button>
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
        <dt>Free Parking pot</dt><dd>${g.free_parking ? 'On' : 'Off'}</dd>
        <dt>Negative balances</dt><dd>${g.allow_negative ? 'Allowed' : 'Not allowed'}</dd>
      </dl>
      <h3>House rules</h3>
      <div class="rules-text">${g.rules_notes ? esc(g.rules_notes) : '<span class="muted">None written yet.</span>'}</div>
      ${banker ? '<button class="btn block" id="edit-rules">Edit rules</button>' : '<p class="muted small">Only the banker can change these.</p>'}
    </div>`;
  const el = openSheet(view);
  $('#edit-rules', el)?.addEventListener('click', () => {
    const el2 = openSheet(`
      <form class="stack" id="rules-form">
        <h2>Edit rules</h2>
        <label class="field"><span>Game name</span><input name="game_name" maxlength="40" value="${esc(g.name)}"></label>
        ${settingsFields(g)}
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
