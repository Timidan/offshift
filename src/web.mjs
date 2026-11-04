// The Offshift web app: the home page with its cover-my-shift form and trader board, the link step
// and the shift page. One process: importing the worker starts it, and the board refreshes here.
// Starting or ending a shift needs the bot's secret, which only the browser that created the bot
// holds (localStorage); every shift page is public and read-only without it.
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { getAddress, isAddress, formatUnits, formatEther } from 'viem';
import { PLACE_ORDER_FOR_SELECTOR } from '@somnia-chain/markets-sdk';
import * as store from './store.mjs';
import { rpc, exchange, markets, moved, pass, shiftPnl, openPnl } from './worker.mjs';
import { board, changes, funding, ingest, MAX_CHANGES, record, trader } from './board.mjs';
import { activity, byPair, closedOrders } from './insight.mjs';
import { follow, replay } from './strategy.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const BTC = markets.BTC;
const BOARD_ROWS = 10;
const FOLLOW_SIZE = 20; // the default size per trade, also used for the follow estimate
const MIN_MARGIN = 5; // USDso a shift needs in the perps account before it can start
const EXAMPLE_OWNER = '0x78fD47fb67a59E0b535b8a8D69D3eB3d7538584E'; // the project's test account, the only one shown publicly
const EXAMPLE_SHIFT = 2; // the home page's example: a full hour with four orders
const SENTENCE = 'Pick a trader to cover your perps account until a time you set; Offshift copies their trades within your limits, closes you out at the end, and hands you every fill.';
const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const dial = readFileSync(new URL('./dial.js', import.meta.url), 'utf8');
const clipJs = readFileSync(new URL('./clip.js', import.meta.url), 'utf8');
const logoFile = (name) => readFileSync(new URL(`./logos/${name}.svg`, import.meta.url), 'utf8').trim();
const icon = (name) => readFileSync(new URL(`./icons/${name}.svg`, import.meta.url), 'utf8').trim();
const MENU = [['/how', 'How it works', icon('how')], ['/traders', 'Traders', icon('traders')], ['/shifts', 'Shifts', icon('shifts')], ['/accounts', 'Accounts', icon('accounts')]];
const DREAMDEX_URL = 'https://app.testnet.dreamdex.io';
const LOGOS = {
  dreamdex: `<span class="logo">${logoFile('dreamdex')}dreamDEX</span>`,
  somnia: `<span class="logo logo--somnia" role="img" aria-label="Somnia">${logoFile('somnia')}</span>`,
};
const FONTS = [...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map((m) => m[1]);

const receipts = new Map(); // tx → receipt; receipts never change once mined
const finals = new Map(); // shift id → final PnL; a finished shift's PnL never changes
const charts = new Map(); // finished shift id → its minute candles
const open = new Map(); // board trader → their open position, refreshed with the board
const histories = new Map(); // trader → their recent trading record, kept for five minutes
let pairs = new Map(); // pool → its market, for names, sizes and marks
let tally = null; // closes and traders behind the board, counted with each refresh
let block = null; // the chain's latest block, shown in the nav

const filled = (evs) => evs.filter((e) => e.kind === 'order');
const shiftEnd = (s, evs) => Math.max(s.ends_at, evs.at(-1)?.at ?? 0);

// The indexer can lag a fresh close, so a final figure is only kept once the shift has settled.
async function finalPnl(s, evs = store.events(s.id)) {
  if (s.status === 'running' || finals.has(s.id)) return finals.get(s.id) ?? null;
  const pnl = filled(evs).length ? await shiftPnl(s, markets[s.market], 0n, 0n, 0n, Math.floor(evs.at(-1).at / 1000) + 60) : 0;
  if (Date.now() - (evs.at(-1)?.at ?? 0) > 3_600_000) finals.set(s.id, pnl); // the indexer can lag by minutes, so wait before keeping this for good
  return pnl;
}

async function candlesFor(s, evs) {
  if (charts.has(s.id)) return charts.get(s.id);
  const to = Math.ceil(Math.min(shiftEnd(s, evs), Date.now()) / 1000);
  const candles = await exchange.client.fetchPriceCandles(s.market, 'M1', { from: Math.floor(s.created_at / 1000) - 60, to, limit: 1500 });
  if (s.status !== 'running') charts.set(s.id, candles);
  return candles;
}

// Would a shift starting now copy this position at once? The same rule the worker runs.
const copyNow = (size, avgEntryPrice, markPrice) =>
  follow({ size: 0n, qty: 1n, leader: size, leaderEntry: raw(avgEntryPrice), mark: raw(markPrice), ending: false }).target !== 0n;

async function traderNow(account) {
  const [{ size, avgEntryPrice }, { markPrice }] = await Promise.all([
    exchange.client.getPerpPosition({ marginBank: BTC.marginBank, account, pool: BTC.poolAddress }),
    exchange.client.getPerpState(BTC.poolAddress),
  ]);
  if (size === 0n) return 'Flat. Your first order waits for their next position.';
  const side = size > 0n ? 'Long' : 'Short';
  return copyNow(size, avgEntryPrice, markPrice) ? `${side}. Your first order goes in when the shift starts.` : `${side}, but the price has moved on. Your first order waits for their next entry.`;
}

async function readOpen() {
  const { markPrice } = await exchange.client.getPerpState(BTC.poolAddress);
  await Promise.all(board(BTC.poolAddress, BOARD_ROWS).map(async (t) => {
    const { size, avgEntryPrice } = await exchange.client.getPerpPosition({ marginBank: BTC.marginBank, account: t.account, pool: BTC.poolAddress });
    open.set(t.account, { size, pnl: Number(formatUnits(openPnl(size, avgEntryPrice, markPrice, BTC), 18)), ready: copyNow(size, avgEntryPrice, markPrice) });
  }));
}

async function readPairs() {
  pairs = new Map((await exchange.client.listPerpMarkets()).map((m) => [m.poolAddress.toLowerCase(), m]));
}

// One at a time: this keeps the board's trader pages ready without crowding the indexer.
async function readHistories() {
  for (const t of board(BTC.poolAddress, BOARD_ROWS)) await history(t.account);
}

// Each step can fail alone: testnet reads time out now and then, and the next refresh covers it.
async function refreshBoard() {
  const step = (name, run) => run().catch((e) => console.log(`${name} failed: ${e.shortMessage ?? e.message}`));
  await step('shift records', async () => {
    for (const s of store.sessions()) {
      const evs = store.events(s.id);
      await finalPnl(s, evs);
      if (filled(evs).length >= 2) await candlesFor(s, evs);
    }
  });
  await step('board refresh', async () => {
    try {
      console.log(`board: ${await ingest(exchange.client, BTC.poolAddress)} new closes`);
    } finally { // new closes may be in even when an older stretch failed
      tally = store.db.prepare('SELECT COUNT(*) AS closes, COUNT(DISTINCT account) AS traders FROM closes').get();
    }
  });
  await step('open positions', readOpen);
  await step('markets', readPairs);
  await step('trader records', readHistories);
  setTimeout(refreshBoard, 300_000);
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// dreamDEX's own token icons, shown before each symbol. 1000PEPE uses pepe.svg.
const tokens = new Map(readdirSync(new URL('./tokens/', import.meta.url)).map((f) => [f, readFileSync(new URL(`./tokens/${f}`, import.meta.url))]));
const inUsd = (label) => `${label}<span class="th-unit">${tok('USDso')}</span>`;
const tok = (sym) => {
  const file = `${String(sym).toLowerCase().replace(/^\d+/, '')}.svg`;
  return `<span class="tok">${tokens.has(file) ? `<img src="/tokens/${file}" alt="" width="16" height="16">` : ''}${esc(sym)}</span>`;
};
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c'); // safe inside an inline script
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const btc = (units) => formatUnits(BigInt(units), BTC.baseDecimals);
const held = (size, html) => (BigInt(size) === 0n ? 'Flat' : `${BigInt(size) > 0n ? 'Long' : 'Short'} ${btc(BigInt(size) < 0n ? -BigInt(size) : size)} ${html ? tok('BTC') : 'BTC'}`);
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const pct = (n) => `${n.toFixed(2)}%`;
const POOL_BTC = BTC.poolAddress.toLowerCase();
const raw = (n) => Number(formatUnits(n, 18));
const pairName = (pool) => pairs.get(pool)?.baseSymbol ?? short(pool);
const baseDecimals = (pool) => pairs.get(pool)?.baseDecimals ?? 18;
const quantity = (units, pool) => formatUnits(units < 0n ? -units : units, baseDecimals(pool));
const span = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 86_400 ? `${(s / 3600).toFixed(1).replace('.0', '')} h` : `${(s / 86_400).toFixed(1).replace('.0', '')} d`);
const ago = (ms) => (Date.now() - ms < 60_000 ? 'Just now' : `${span((Date.now() - ms) / 1000)} ago`);
const lastMove = (account, seconds) => Math.max(moved.get(account) ?? 0, Number(seconds ?? 0) * 1000); // Reactivity hears BTC; the indexer knows the other pairs
// Rendered in UTC; the page script swaps in the reader's own clock.
const time = (ms, date) => `<time datetime="${new Date(ms).toISOString()}"${date ? ' data-date' : ''}>${new Date(ms).toISOString().slice(date ? 5 : 11, 16).replace('T', ' ')}</time>`;
const status = (s) => `<span class="status ${esc(s)}">${{ running: 'Live', done: 'Done', stopped: 'Stopped', failed: 'Failed' }[s] ?? esc(s)}</span>`;
const WORDS = { 'no-fill': 'No fill', 'loss-limit': 'Loss limit', 'stop-loss': 'Stop loss', skipped: 'Skipped', reverted: 'Reverted', failed: 'Failed', stopped: 'Stopped', done: 'Done' };
const side = (e) => (e.side === 'buy' ? 'Buy' : 'Sell');
const word = (e) => (e.kind === 'order' ? `<b class="${e.side}">${side(e)}</b>` : `<b class="${esc(e.kind)}">${WORDS[e.kind] ?? esc(e.kind)}</b>`);
const copied = (e) => e.note?.match(/^copied ([\d.]+) s/)?.[1];

// A mirrored 5×5 mark from the address, so traders can be told apart at a glance.
function pixels(address) {
  const hex = address.slice(2).toLowerCase();
  let cells = '';
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (parseInt(hex[y * 3 + x], 16) % 2 === 0) continue;
    for (const c of new Set([x, 4 - x])) cells += `<rect x="${c}" y="${y}" width="1" height="1"/>`;
  }
  return `<svg class="px" viewBox="0 0 5 5" aria-hidden="true">${cells}</svg>`;
}
const who = (a) => `<span class="who">${pixels(a)}<span title="${esc(a)}">${esc(short(a))}</span></span>`;

// Cumulative realized PnL, one point per close (at most 64 kept), spaced by time when the close times
// are given. A faint line marks zero once the total has been below it.
function curve(pnls, w, h, times) {
  let sum = 0;
  const all = pnls.map((p) => (sum += p));
  const step = Math.ceil(all.length / 64);
  const keep = (_, i) => i % step === 0 || i === all.length - 1;
  const pts = [0, ...all.filter(keep)], at = times && [times[0], ...times.filter(keep)];
  const lo = Math.min(...pts), span = Math.max(...pts) - lo || 1;
  const x = (i) => (at ? (at[i] - at[0]) / (at.at(-1) - at[0] || 1) : i / (pts.length - 1)) * w;
  const y = (v) => (h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1);
  // Over time the total only moves at a close, so it steps rather than slopes.
  const line = pts.map((v, i) => `${at && i ? `${x(i).toFixed(1)},${y(pts[i - 1])} ` : ''}${x(i).toFixed(1)},${y(v)}`).join(' ');
  const zero = lo < 0 ? `<line class="zero" x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}"/>` : '';
  return `<svg class="curve ${tone(sum)}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" role="img" aria-label="Realized PnL over ${pnls.length} closes">${zero}<polyline points="${line}"/></svg>`;
}

// The stretches the account held a position, read from its order events.
function heldSpans(s, evs, until) {
  const spans = [];
  let from = s.created_at, size = 0n;
  for (const e of filled(evs)) {
    if (size !== 0n) spans.push({ from, to: e.at, size });
    from = e.at;
    size = BigInt(e.position);
  }
  if (size !== 0n) spans.push({ from, to: until, size });
  return spans;
}

// The shift over BTC's price: a fill wherever a position was held, a numbered square for each order,
// a short tick for anything else that happened, and the end time as a wall on the right.
function shiftChart(s, evs, candles) {
  const live = s.status === 'running', now = Date.now(), end = shiftEnd(s, evs), span = end - s.created_at || 1;
  const x = (t) => ((Math.min(Math.max(t, s.created_at), end) - s.created_at) / span) * 100;
  const lo = Math.min(...candles.map((c) => c.low)), hi = Math.max(...candles.map((c) => c.high)), pad = (hi - lo) * 0.22 || 1;
  const y = (p) => 100 - ((p - lo + pad) / (hi - lo + 2 * pad)) * 100;
  const closeAt = (t) => (candles.findLast((c) => c.bucketStart * 1000 <= t) ?? candles[0]).close;
  const step = Math.ceil(candles.length / 240);
  const drawn = candles.filter((_, i) => i % step === 0 || i === candles.length - 1);
  const line = drawn.map((c) => `${x(c.bucketStart * 1000).toFixed(2)},${y(c.close).toFixed(2)}`).join(' ');
  const fills = heldSpans(s, evs, live ? now : end).map(({ from, to, size }) => `<rect class="${size > 0n ? 'long' : 'short'}" x="${x(from).toFixed(2)}" y="0" width="${(x(to) - x(from)).toFixed(2)}" height="100"><title>${held(size)}</title></rect><rect class="lane ${size > 0n ? 'long' : 'short'}" x="${x(from).toFixed(2)}" y="98.4" width="${(x(to) - x(from)).toFixed(2)}" height="1.6"/>`).join('');
  const marks = filled(evs).map((e, i) => `<i class="mark ${e.side}" data-n="${i + 1}" style="left:${pct(x(e.at))};top:${pct(y(closeAt(e.at)))}" title="${side(e)} ${btc(e.quantity)} BTC">${i + 1}</i>`).join('');
  const notes = evs.filter((e) => e.kind !== 'order' && e.kind !== 'done').map((e) => `<i class="note" style="left:${pct(x(e.at))}" title="${WORDS[e.kind] ?? esc(e.kind)}"></i>`).join('');
  const price = (p) => p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `<figure class="chart${filled(evs).length > 12 ? ' dense' : ''}" role="img" aria-label="BTC price through the shift, with ${filled(evs).length} orders">
<div class="plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${fills}<polyline points="${line}"/></svg></div>
<span class="axis hi" style="top:${pct(y(hi))}">${price(hi)}</span><span class="axis lo" style="top:${pct(y(lo))}">${price(lo)}</span>${notes}${marks}
${live ? `<i class="now" style="left:${pct(x(now))}"></i>` : ''}<i class="wall"></i><i class="head"></i></figure>`;
}

// The small version for the shifts table, and the stand-in when price data cannot be read.
function shiftBar(s, evs, small) {
  const live = s.status === 'running', now = Date.now(), end = shiftEnd(s, evs), span = end - s.created_at || 1;
  const at = (t) => pct(((Math.min(Math.max(t, s.created_at), end) - s.created_at) / span) * 100);
  const fills = heldSpans(s, evs, live ? now : end).map(({ from, to, size }) => `<i class="held ${size > 0n ? 'long' : 'short'}" style="left:${at(from)};width:calc(${at(to)} - ${at(from)})" title="${esc(held(size))}"></i>`).join('');
  const ticks = evs.filter((e) => e.kind !== 'done').map((e) => `<i class="tick ${e.kind === 'order' ? e.side : 'note'}" style="left:${at(e.at)}" title="${e.kind === 'order' ? `${side(e)} ${btc(e.quantity)} BTC` : WORDS[e.kind] ?? esc(e.kind)}"></i>`).join('');
  return `<div class="bar${small ? ' sm' : ''}" role="img" aria-label="Shift timeline with ${filled(evs).length} orders">${fills}${ticks}${live ? `<i class="now" style="left:${at(now)}"></i>` : ''}</div>`;
}

// The chart with its time axis. The gold label is the end time, or when the owner ended it.
function timeline(s, evs, candles) {
  return `<div class="trace">${candles?.length > 1 ? shiftChart(s, evs, candles) : shiftBar(s, evs)}
<div class="ends">${time(s.created_at)}<span class="key"><span><i class="long"></i>Long</span><span><i class="short"></i>Short</span></span><span class="until">${s.reason ? 'Ended' : 'End time'} ${time(s.ends_at)}</span></div></div>`;
}

const MARK = "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23123a42'/%3E%3Ccircle cx='16' cy='16' r='10.5' fill='%23f6f4ee'/%3E%3Cpath d='M16 16V8.500' fill='none' stroke='%23123a42' stroke-width='2' stroke-linecap='round'/%3E%3Cpath d='M16 16l6 4' fill='none' stroke='%23c69a3c' stroke-width='2.400' stroke-linecap='round'/%3E%3C/svg%3E";

function page(title, body, { cls = 'shell page', live = false, script = '', at = '', setup = false } = {}) {
  const brand = `<a class="brand" href="/"><img src="data:image/svg+xml,${MARK}" alt="" width="28" height="28"><span>Offshift</span></a>`;
  const chain = `<span class="chain">${block ? `Somnia Tokyo block <b>${block.toLocaleString('en-US')}</b>` : 'Somnia Tokyo testnet'}</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(SENTENCE)}"><meta name="theme-color" content="#0c0e10">
<link rel="icon" href="data:image/svg+xml,${MARK}">
${FONTS.map((f) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="${f}">`).join('')}
<style>${css}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav"><div class="shell nav__inner">${brand}<nav class="menu" aria-label="Main">${MENU.map(([href, label, svg]) => `<a href="${href}" aria-label="${label}" data-label="${label}"${href === at ? ' aria-current="page"' : ''}>${svg}<span class="menu__label" aria-hidden="true">${label}</span></a>`).join('')}</nav>${setup ? '' : `<div class="nav__end">${chain}${cls === 'home' ? '' : '<a class="btn" href="/#cover">Cover my shift</a>'}</div>`}</div></header>
<main id="main" class="${cls}"${live ? ' data-live' : ''}>${body}</main>
<footer class="shell foot"><span>Testnet money. Copying can lose money.</span><span class="built">Built on <a href="${DREAMDEX_URL}">${LOGOS.dreamdex}</a><a href="https://somnia.network">${LOGOS.somnia}</a></span></footer>
<p class="vh" id="said" role="status"></p>
<script>
const localize = (root) => { for (const t of root.querySelectorAll('time')) t.textContent = new Date(t.dateTime).toLocaleString([], 'date' in t.dataset ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }); };
localize(document);
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-copy]');
  if (!b) return;
  await navigator.clipboard.writeText(b.dataset.copy);
  b.dataset.label ??= b.textContent;
  b.textContent = document.getElementById('said').textContent = 'Copied';
  setTimeout(() => (b.textContent = b.dataset.label), 1200);
});
</script>${script && `<script>${script}</script>`}</body></html>`;
}

// The home page does one job: choose how long to be covered and go. The dial above the controls shows
// those hours in gold, and the hours you are off blow away as dust. Everything else has its own page.
const HOME_SCRIPT = `
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const form = $('f'), until = $('until'), cover = startDial($('dial'), document.querySelector('.stage'));
const picks = [...document.querySelectorAll('[data-h]')], pad = (n) => String(n).padStart(2, '0');
function target() {
  const [h, m] = until.value.split(':').map(Number), d = new Date();
  d.setHours(h, m, 0, 0);
  if (d <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function paint() {
  if (!until.value) return;
  const mins = Math.ceil((target() - Date.now()) / 60000);
  $('left').textContent = 'in ' + Math.floor(mins / 60) + ' h ' + pad(mins % 60) + ' m';
  cover(target());
}
function pick(hours) {
  const d = new Date(Date.now() + hours * 3600000);
  until.value = pad(d.getHours()) + ':' + pad(d.getMinutes());
  for (const b of picks) b.setAttribute('aria-pressed', String(Number(b.dataset.h) === hours));
  paint();
}
for (const b of picks) b.onclick = () => pick(Number(b.dataset.h));
until.addEventListener('input', () => { for (const b of picks) b.setAttribute('aria-pressed', 'false'); });
until.addEventListener('input', paint);
pick(8);
form.addEventListener('submit', () => { $('end').value = target(); });
const chart = document.querySelector('.chart');
if (chart && !reduced) {
  const plot = chart.querySelector('.plot'), head = chart.querySelector('.head'), marks = [...chart.querySelectorAll('.mark')];
  const outcome = document.querySelector('.outcome'), parts = [...marks, ...document.querySelectorAll('.moments li'), outcome];
  const HOLD = 350, RUN = 1700, ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  let frame = 0, fallback = 0;
  function rest() {
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    plot.style.clipPath = '';
    head.style.opacity = 0;
    for (const el of parts) el.classList.remove('wait');
  }
  function ready() {
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    plot.style.clipPath = 'inset(-2px 100% -2px 0)';
    head.style.transform = 'translateX(0)';
    head.style.opacity = 1;
    for (const el of parts) el.classList.add('wait');
    fallback = setTimeout(rest, 4000); // a chart left half on screen must not stay blank
  }
  function play() {
    ready();
    clearTimeout(fallback);
    const start = performance.now() + HOLD, width = chart.clientWidth;
    const step = (now) => {
      const t = Math.min(Math.max((now - start) / RUN, 0), 1), p = ease(t) * 100;
      plot.style.clipPath = 'inset(-2px ' + (100 - p) + '% -2px 0)';
      head.style.transform = 'translateX(' + (p / 100) * width + 'px)';
      for (const m of marks) {
        if (p < parseFloat(m.style.left)) continue;
        m.classList.remove('wait');
        document.querySelector('.moments [data-n="' + m.dataset.n + '"]')?.classList.remove('wait');
      }
      if (t < 1) frame = requestAnimationFrame(step);
      else setTimeout(rest, 140);
    };
    frame = requestAnimationFrame(step);
    fallback = setTimeout(rest, HOLD + RUN + 600);
  }
  new IntersectionObserver(([e], seen) => {
    if (!e.isIntersecting) return;
    if (e.intersectionRatio < 0.4) return ready();
    seen.disconnect();
    play();
  }, { threshold: [0, 0.4] }).observe(chart);
  document.getElementById('replay')?.addEventListener('click', play);
}`;

// What each order was, in a sentence, from what the worker recorded about it.
function moments(s, evs) {
  const orders = filled(evs), last = orders.at(-1);
  const why = (e) => {
    if (copied(e)) return `Copied ${copied(e)}&nbsp;s after the trader.`;
    if (e === last && e.at >= s.ends_at) return e.position === '0' ? 'End time. Closed flat.' : 'End time.';
    if (evs[evs.indexOf(e) - 1]?.kind === 'no-fill') return 'Filled on a retry, within 0.5% of the mark.';
    return e.position === '0' ? "Copied the trader’s close." : "Copied the trader’s entry.";
  };
  return orders.map((e, i) => `<li data-n="${i + 1}"><i class="mark ${e.side}">${i + 1}</i><h3>${side(e)} ${btc(e.quantity)} ${tok('BTC')}</h3><p>${why(e)}</p></li>`).slice(-4).join('');
}

// A real finished shift on the home page: the outcome a user gets back.
function handover(s, evs) {
  const orders = filled(evs), pnl = finals.get(s.id), candles = charts.get(s.id), flat = evs.at(-1).position === '0';
  const mins = Math.round((shiftEnd(s, evs) - s.created_at) / 60000);
  return `<section class="shell panel" aria-labelledby="shown">
<header class="lede"><h2 class="section__title" id="shown">What you get back</h2><p class="sub">Shift #${s.id}, covered by ${s.trader ? who(s.trader) : 'Preset: BTC trend'}</p></header>
<div class="log">
<ol class="moments">${moments(s, evs)}</ol>
<div class="log__main"><p class="outcome">${pnl === undefined ? '' : `<b class="${tone(pnl)}">${usd(pnl)} ${tok('USDso')}</b>`}<span>${orders.length} orders in ${mins} minutes</span></p>
${timeline(s, evs, candles)}</div>
</div>
<footer class="run-foot"><a class="quiet" href="/shift/${s.link}">View the full shift</a>${candles?.length > 1 ? '<button class="copy" id="replay" type="button">Replay</button>' : ''}</footer>
</section>`;
}

const DREAMDEX = `<a class="quiet" href="${DREAMDEX_URL}">dreamDEX</a>`;

function howPage() {
  return page('How it works · Offshift', `
<header class="lede"><h1>How it works</h1></header>
<div class="how">
  <div><h2>Add a bot on dreamDEX</h2><p>Paste your dreamDEX wallet address and Offshift makes a bot for it. You add the bot in dreamDEX’s Link a bot screen.</p></div>
  <div class="art"><dl class="sheet"><div><dt>Place orders</dt><dd>Yes</dd></div><div><dt>Cancel orders</dt><dd>Yes</dd></div><div><dt>Withdraw</dt><dd>Never</dd></div></dl></div>
</div>
<div class="how flip">
  <div><h2>Keep your money on dreamDEX</h2><p>A shift needs 5 ${tok('USDso')} in your perps account on ${DREAMDEX} and 1 ${tok('STT')} on the bot for gas.</p></div>
  <div class="art art--warm"><dl class="sheet"><div><dt>Deposits</dt><dd>On dreamDEX</dd></div><div><dt>Withdrawals</dt><dd>On dreamDEX</dd></div><div><dt>USDso held by Offshift</dt><dd>None</dd></div></dl></div>
</div>
<div class="how">
  <div><h2>Offshift copies the trader until your end time</h2><p>Somnia Reactivity reports each move. Offshift stops early at your loss limit and lists every order on the shift page.</p></div>
  <div class="art art--cool"><ol class="timeline"><li><span>Trader</span>Opens a position</li><li><span>Offshift</span>Copies it at your size</li><li class="gold"><strong>End time</strong>Closes you out, flat</li></ol></div>
</div>
<section class="panel faq" id="faq" aria-labelledby="faq-title">
<header class="lede"><h2 class="section__title" id="faq-title">Frequently asked questions</h2></header>
<details><summary>Do I need to log in or connect a wallet?</summary><p>No. Offshift only asks for your public dreamDEX address. The browser you start from keeps the bot’s secret, so only it can start or end shifts.</p></details>
<details><summary>What is an Offshift account?</summary><p>A dreamDEX wallet and its bot, saved in this browser. Clearing browser data forgets it.</p></details>
<details><summary>Who can see my shifts?</summary><p>The Shifts page lists only the shifts from accounts saved in your browser. Each shift’s page has a private link that can’t be guessed, so only people you send it to can open it. The orders themselves are public on chain.</p></details>
<details><summary>Which dreamDEX wallet can I use?</summary><p>A Somnia Account wallet. dreamDEX’s Legacy Account can’t link bots.</p></details>
<details><summary>Why does dreamDEX say “Can’t add a bot yet”?</summary><p>Your dreamDEX wallet has a small app key that pays for changes like adding a bot, and it has run out of STT. Click the gas warning in your wallet, copy the key and send it a little STT, then press Add bot again.</p></details>
<details><summary>What happens at the end time?</summary><p>Offshift closes the position and you’re flat. That only works while Offshift is running. If it stops with a position still open, the shift page says so and links to dreamDEX so you can close it yourself.</p></details>
<details><summary>Can I lose money?</summary><p>Yes. The loss limit ends a shift early but can’t promise an exact exit.</p></details>
</section>`, { at: '/how' });
}

function home(selected) {
  const rows = board(BTC.poolAddress, BOARD_ROWS);
  const shown = store.sessions().map((s) => ({ ...s, evs: store.events(s.id) })).find((s) => s.id === EXAMPLE_SHIFT && s.owner === EXAMPLE_OWNER);
  const chosen = selected ? rows.find((t) => t.account.toLowerCase() === selected.toLowerCase()) ?? trader(BTC.poolAddress, selected) ?? { account: selected.toLowerCase(), pnl: null } : rows.find((t) => open.get(t.account)?.ready) ?? rows[0];
  return page('Offshift', `
<section class="hero" id="cover">
  <canvas id="dial" aria-hidden="true"></canvas>
  <div class="stage"></div>
  <h1>Copy a top trader on dreamDEX perps <em>until a time you set</em>.</h1>
  <form class="composer" id="f" action="/cover">
    <input type="hidden" name="trader" value="${esc(chosen?.account ?? '')}"><input type="hidden" name="until" id="end">
    <div class="choice">
      <span class="choice__label">Trader</span>
      ${chosen ? `<div class="choice__who">${who(chosen.account)}</div><div class="choice__foot">${chosen.pnl === null ? '<span></span>' : `<span class="num ${tone(chosen.pnl)}">${usd(chosen.pnl).slice(0, -3)} ${tok('USDso')} in 7 days</span>`}<a class="quiet" href="/traders">Change trader</a></div>` : '<p class="sub">Loading traders. First run takes about 5 minutes.</p>'}
    </div>
    <div class="choice choice--time">
      <label class="choice__label" for="until">Cover until</label>
      <div class="choice__time"><input id="until" type="time" required><span id="left"></span></div>
      <div class="picks">${[1, 2, 4, 8, 12].map((h) => `<button type="button" data-h="${h}" aria-pressed="false">${h} h</button>`).join('')}</div>
    </div>
    <button class="btn"${chosen ? '' : ' disabled'}>Cover my shift</button>
  </form>
  <ul class="strip">
    <li><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.500l5.500 2v4c0 3.400-2.300 5.700-5.500 7-3.200-1.300-5.500-3.600-5.500-7v-4l5.500-2z"/></svg>Your bot can never withdraw</li>
  </ul>
</section>
${shown ? handover(shown, shown.evs) : ''}`, { cls: 'home', script: dial + HOME_SCRIPT });
}

function tradersPage() {
  const rows = board(BTC.poolAddress, BOARD_ROWS);
  const opened = (t) => {
    const o = open.get(t.account);
    return !o ? ['dim', '–'] : o.size === 0n ? ['dim', 'Flat'] : [tone(o.pnl), usd(o.pnl)];
  };
  return page('Traders · Offshift', `
<header class="case-head"><div><h1>Traders</h1><p class="sub">${tok('BTC')}, last 7 days</p></div></header>
${rows.length ? `<div class="wrap"><table class="rows"><thead><tr><th class="opt"><span class="vh">Rank</span></th><th>Trader</th><th class="opt-lg"><span class="vh">Realized PnL curve</span></th><th class="num">${inUsd('Realized PnL')}</th><th class="num opt">${inUsd('Open PnL')}</th><th class="num opt-md">Win rate</th><th class="num opt-md">${inUsd('Max drawdown')}</th><th class="num opt-md">Closes</th><th class="num opt-md">Pairs</th><th class="num opt">Last move</th><th><span class="vh">Action</span></th></tr></thead><tbody>
${rows.map((t, i) => { const [cls, now] = opened(t); return `<tr><td class="rank opt">${i + 1}</td><td><a class="go" href="/trader/${esc(t.account)}">${who(t.account)}</a></td><td class="opt-lg">${curve(t.pnls, 132, 28)}</td><td class="num pnl ${tone(t.pnl)}">${usd(t.pnl)}<small class="on-phone ${cls}">Open: ${now}</small></td><td class="num opt ${cls}">${now}</td><td class="num opt-md">${Math.round(t.winRate * 100)}%</td><td class="num opt-md">${usd(-t.drawdown)}</td><td class="num opt-md">${t.closes}</td><td class="num opt-md">${histories.has(t.account) ? new Set(histories.get(t.account).rows.map((c) => c.pool)).size : '–'}</td><td class="num opt dim">${ago(lastMove(t.account, histories.get(t.account)?.rows.at(-1)?.timestamp ?? t.last))}</td><td class="num"><a class="choose" href="/cover?trader=${esc(t.account)}" aria-label="Pick ${esc(short(t.account))}">Pick</a></td></tr>`; }).join('')}
</tbody></table></div><p class="fine">Market makers and records under 10 closes or 2 days are left out.</p>`
    : '<p class="empty">Loading traders. First run takes about 5 minutes.</p>'}`, { at: '/traders' });
}

// Shifts belong to whoever holds their bot's secret. There is no sign-in, so that secret is the proof:
// the page itself lists nothing, and the browser asks for the shifts of the bots it holds.
function myShifts(bots) {
  const mine = new Set(bots.slice(0, 100).filter((b) => isAddress(b?.bot ?? '') && store.checkSecret(b.bot, b.secret)).map((b) => getAddress(b.bot)));
  const shifts = store.sessions().filter((s) => mine.has(s.bot)).map((s) => ({ ...s, evs: store.events(s.id) }));
  if (!shifts.length) return '';
  return `<div class="wrap"><table class="rows"><thead><tr><th>Shift</th><th>Covered by</th><th class="opt-md"><span class="vh">Timeline</span></th><th class="num">${inUsd('PnL')}</th><th class="num opt">Orders</th><th>Status</th><th class="opt-md">Started</th></tr></thead><tbody>
${shifts.map((s) => { const pnl = finals.get(s.id); return `<tr><td><a class="go" href="/shift/${s.link}">#${s.id}</a></td><td>${s.trader ? who(s.trader) : 'Preset: BTC trend'}</td><td class="opt-md">${shiftBar(s, s.evs, true)}</td><td class="num ${tone(pnl)}">${pnl === undefined ? '–' : usd(pnl)}</td><td class="num opt">${filled(s.evs).length}</td><td>${status(s.status)}</td><td class="opt-md">${time(s.created_at, true)}</td></tr>`; }).join('')}
</tbody></table></div>`;
}

function shiftsPage() {
  return page('Shifts · Offshift', `
<header class="case-head"><div><h1>Shifts</h1><p class="sub">In this browser</p></div></header>
<div id="list"><p class="sub" role="status">Loading your shifts</p></div>
<div class="empty" id="none" hidden><p>No shifts in this browser yet.</p><a class="btn" href="/#cover">Cover my shift</a></div>`, { at: '/shifts', script: `
const list = document.getElementById('list'), none = document.getElementById('none');
const bots = Object.keys(localStorage).filter((k) => k.startsWith('offshift:bot:')).map((k) => ({ bot: k.slice(13), secret: localStorage.getItem(k) }));
const done = (html) => {
  list.innerHTML = html;
  localize(list);
  none.hidden = !!html;
};
if (!bots.length) done('');
else fetch('/api/shifts/mine', { method: 'POST', body: JSON.stringify({ bots }) }).then((r) => r.json()).then((r) => done(r.html ?? '')).catch(() => (list.innerHTML = '<p class="err" role="alert">Unable to load your shifts. Check your connection and try again.</p>'));` });
}

// Shared by the account and shift steps. An account is a name, a dreamDEX wallet and its bot, kept in
// this browser with the bot's secret; there is no sign-in. Only one step shows at a time.
const STEPS_JS = `
const $ = (id) => document.getElementById(id);
const accounts = () => { try { return JSON.parse(localStorage.getItem('offshift:accounts')) ?? []; } catch { return []; } };
const saveAccounts = (list) => localStorage.setItem('offshift:accounts', JSON.stringify(list));
const shortAddress = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const readBot = (bot) => fetch('/api/link/' + bot).then((r) => r.json()).then((r) => (r.error ? null : r)).catch(() => null);
const safeNext = (url) => (url && url.startsWith('/') && !url.startsWith('//') ? url : '/accounts');
function showStep(id) {
  for (const s of document.querySelectorAll('.wizard__step')) s.hidden = s.id !== id;
  scrollTo(0, 0);
  $(id).querySelector('h1').focus({ preventScroll: true });
}`;

// Each scene is a real dreamDEX screen, with x and y as percentages of the image.
const SCREENS = { 'top-bar': 527 / 364, 'wallet-panel': 363 / 400, 'wallet-list': 363 / 400, 'app-key': 363 / 400, 'bot-form': 710 / 984, 'bot-added': 668 / 758 };
const screenFiles = new Map(Object.keys(SCREENS).map((name) => [`${name}.webp`, readFileSync(new URL(`./clips/${name}.webp`, import.meta.url))]));
const scene = (name, text, x, y, hold) => ({ src: `/clips/${name}.webp`, ar: SCREENS[name], text, x, y, hold });
const openWallet = scene('top-bar', 'Click your wallet at the top right', 85.8, 10.2);
const CLIPS = {
  wallet: ['How to copy your wallet address on dreamDEX', [
    openWallet,
    scene('wallet-panel', 'Click the copy icon next to your address', 93.1, 62.5, 1800),
  ]],
  bot: ['How to add your bot on dreamDEX', [
    openWallet,
    scene('wallet-panel', 'Click your wallet name', 20.7, 26.3),
    scene('wallet-list', 'Choose Link a bot', 27, 59.3),
    scene('bot-form', 'Paste your bot address', 48.6, 42.7),
    scene('bot-form', 'Press Add bot', 19.1, 83.9),
    scene('bot-added', 'Access granted. Come back here', 53.7, 94, 2200),
  ]],
  gas: ['How to top up the app key on dreamDEX', [
    openWallet,
    scene('wallet-panel', 'Click the gas warning', 90, 49.3),
    scene('app-key', 'Copy this key and send it a little STT', 35, 87.5, 2400),
  ]],
  deposit: ['How to deposit on dreamDEX', [
    scene('top-bar', 'Press Deposit, then add USDso to your perps account', 68.3, 10.2, 2600),
  ]],
};
const clip = (name) => {
  const [title, scenes] = CLIPS[name];
  return `<figure class="clip" data-scenes="${esc(JSON.stringify(scenes))}" aria-label="${esc(title)}">
  <div class="clip__stage"><div class="clip__screen" style="--ar:${scenes[0].ar}" aria-hidden="true"><img src="${scenes[0].src}" alt=""><i class="clip__ring"></i><svg class="clip__cursor" viewBox="0 0 20 24"><path d="M3 2l14 12.500-6.200.500 3.700 7-3 1.500-3.600-7.100L3 21z"/></svg></div></div>
  <figcaption><span class="clip__caption" aria-hidden="true">${esc(scenes[0].text)}</span><button class="link" type="button">Pause</button></figcaption>
  <ol class="vh">${scenes.map((s) => `<li>${esc(s.text)}</li>`).join('')}</ol>
</figure>`;
};

function accountsPage() {
  return page('Accounts · Offshift', `
<header class="case-head"><div><h1>Accounts</h1></div><a class="btn" href="/accounts/new">Add account</a></header>
<ul class="accounts" id="list"></ul>
<div class="empty" id="none" hidden><p>No accounts yet.</p><a class="btn" href="/accounts/new">Add account</a></div>`, { at: '/accounts', script: `${STEPS_JS}
const list = accounts(), box = $('list');
$('none').hidden = list.length > 0;
function draw() {
  box.replaceChildren(...accounts().map((a) => {
    const row = document.createElement('li');
    row.className = 'account';
    row.innerHTML = '<div><h2></h2><p class="mono dim"></p></div><p class="state" data-state>Checking</p><div class="line"><a class="btn" data-go>Start a shift</a><button class="link" type="button" data-forget>Forget</button></div>';
    row.querySelector('h2').textContent = a.name;
    row.querySelector('.mono').textContent = shortAddress(a.wallet);
    row.querySelector('[data-go]').href = '/cover?account=' + a.bot;
    row.querySelector('[data-forget]').onclick = () => {
      if (!confirm('Forget ' + a.name + ' in this browser? Remove its bot on dreamDEX too, on the Bots tab.')) return;
      saveAccounts(accounts().filter((x) => x.bot !== a.bot));
      localStorage.removeItem('offshift:bot:' + a.bot);
      location.reload();
    };
    readBot(a.bot).then((r) => {
      const state = row.querySelector('[data-state]'), go = row.querySelector('[data-go]');
      if (!r) return (state.textContent = 'Unable to read dreamDEX. Reload to retry.');
      if (!r.granted) {
        state.textContent = 'Bot not added yet';
        go.textContent = 'Finish setup';
        go.href = '/accounts/new?bot=' + a.bot;
        return;
      }
      state.textContent = r.running.length ? 'Shift #' + r.running[0].id + ' running' : r.collateral.toFixed(2) + ' USDso margin';
      if (r.running.length) { go.textContent = 'View shifts'; go.href = '/shifts'; }
    });
    return row;
  }));
}
draw();` });
}

function accountSetup() {
  return page('Add an account · Offshift', `
<div class="wizard">
  <form class="wizard__step" id="s-wallet" novalidate>
    <h1 tabindex="-1">Add your dreamDEX wallet</h1>
    <p class="sub">Copy your address from <a class="quiet" href="${DREAMDEX_URL}" target="_blank" rel="noopener">dreamDEX</a>.</p>
    ${clip('wallet')}
    <div class="wizard__body">
      <label for="name">Account name</label><input id="name" placeholder="Night shifts" autocomplete="off" maxlength="40">
      <label for="wallet">Wallet address</label><input id="wallet" required placeholder="0x…" autocomplete="off" spellcheck="false" aria-describedby="wallet-err">
      <p class="err" id="wallet-err"></p>
    </div>
    <div class="wizard__foot"><span></span><button class="btn">Continue</button></div>
  </form>
  <section class="wizard__step" id="s-bot" hidden>
    <h1 tabindex="-1">Add your bot on dreamDEX</h1>
    <p class="sub">Leave Perps on. If your wallet has no STT, turn the gas option off.</p>
    ${clip('bot')}
    <div class="wizard__body">
      <div class="addr"><code id="bot-address"></code></div>
      <a class="btn" id="open" href="${DREAMDEX_URL}" target="_blank" rel="noopener" data-copy="">Copy address and open dreamDEX</a>
      <dl class="sheet checks">
        <div id="c-grant"><dt>Bot access</dt><dd class="state">Checking</dd></div>
        <div id="c-gas"><dt>Bot gas</dt><dd class="state">Checking</dd><dd class="hint" hidden>Send this address 1 STT from any wallet.</dd></div>
      </dl>
    </div>
    <p class="sub" id="wait" role="status">This page moves on once the bot is added.</p>
    <details class="stuck"><summary>dreamDEX says “Can’t add a bot yet”?</summary>
      <p class="sub">Send your dreamDEX app key a little STT, then press Add bot again.</p>
      ${clip('gas')}
    </details>
    <p class="fine">Legacy accounts can’t link bots, so pick a Somnia Account wallet. <a class="quiet" href="${DREAMDEX_URL}/docs/trading/common/link-a-bot" target="_blank" rel="noopener">See dreamDEX’s guide</a></p>
  </section>
</div>`, { script: `${STEPS_JS}
const params = new URLSearchParams(location.search), next = safeNext(params.get('next'));
let bot = null, timer = 0;
const set = (id, ok, text) => { $(id).classList.toggle('ok', ok); $(id).querySelector('.state').textContent = text; };
async function check() {
  const r = await readBot(bot);
  if (!r) return; // testnet reads time out now and then; the next check covers it
  const gas = r.gas >= 0.2;
  set('c-grant', r.granted, r.granted ? 'Added' : 'Waiting for dreamDEX');
  set('c-gas', gas, r.gas.toFixed(2) + ' STT');
  $('c-gas').querySelector('.hint').hidden = gas || !r.granted; // dreamDEX sends the gas when the bot is added
  if (r.granted && !gas) $('wait').textContent = 'Your bot needs gas.';
  if (!r.granted || !gas) return;
  clearInterval(timer);
  $('wait').textContent = 'Your bot is ready.';
  setTimeout(() => (location = next), 700);
}
function toBot(address) {
  bot = address;
  $('bot-address').textContent = bot;
  $('open').dataset.copy = bot;
  showStep('s-bot');
  check();
  timer = setInterval(check, 5000);
}
$('s-wallet').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const wallet = $('wallet').value.trim(), go = ev.target.querySelector('.btn'), list = accounts();
  const fail = (text) => { $('wallet-err').textContent = text; $('wallet').setAttribute('aria-invalid', 'true'); $('wallet').focus(); };
  $('wallet').removeAttribute('aria-invalid');
  $('wallet-err').textContent = '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return fail('Paste your wallet address: 0x followed by 40 letters and numbers.');
  const known = list.find((a) => a.wallet.toLowerCase() === wallet.toLowerCase());
  if (known) return toBot(known.bot);
  go.disabled = true;
  const r = await fetch('/api/bots', { method: 'POST', body: JSON.stringify({ owner: wallet }) }).then((r) => r.json()).catch(() => ({ error: 'Unable to reach Offshift. Check your connection and try again.' }));
  go.disabled = false;
  if (r.error) return fail(r.error);
  localStorage.setItem('offshift:bot:' + r.address, r.secret);
  saveAccounts([...list, { name: $('name').value.trim() || 'Account ' + (list.length + 1), wallet, bot: r.address }]);
  toBot(r.address);
});
const resume = accounts().find((a) => a.bot === params.get('bot'));
if (resume) toBot(resume.bot);
${clipJs}`, setup: true });
}

async function shiftSetup(q) {
  const shift = { trader: isAddress(q.trader ?? '') ? getAddress(q.trader) : '', until: Number(q.until) || Date.now() + 8 * 3_600_000 };
  const pickEnd = !(Number(q.until) > Date.now()); // the home page sets the end time; a trader page's Pick does not
  const covered = shift.trader ? who(shift.trader) : 'Preset: BTC trend';
  const now = shift.trader ? await traderNow(shift.trader).catch(() => null) : null;
  return page('Set up your shift · Offshift', `
<div class="wizard">
  <section class="wizard__step" id="s-wait"><h1 tabindex="-1" role="status">Checking your account</h1></section>
  <section class="wizard__step" id="s-account" hidden>
    <h1 tabindex="-1">${shift.trader ? `Which account follows ${who(shift.trader)}?` : 'Which account is this shift for?'}</h1>
    <ul class="choices" id="choices"></ul>
    <div class="wizard__foot"><span></span><a class="quiet" href="/accounts/new?next=${esc(encodeURIComponent(`/cover?trader=${shift.trader}${pickEnd ? '' : `&until=${shift.until}`}`))}">Add another account</a></div>
  </section>
  <form class="wizard__step" id="s-size" hidden novalidate>
    <h1 tabindex="-1">${pickEnd ? 'Set your shift' : 'Set your size and loss limit'}</h1>
    <div class="wizard__body">
      ${pickEnd ? `<div><label for="hours">End time</label><select id="hours">${[1, 2, 4, 8, 12].map((h) => `<option value="${h}"${h === 8 ? ' selected' : ''}>In ${h} h</option>`).join('')}</select></div>` : ''}
      <div class="two">
        <div><label for="size">Size per trade</label><div class="unit"><input id="size" aria-describedby="size-err" type="number" inputmode="numeric" min="5" max="1000" step="1" value="${Number(q.size) || FOLLOW_SIZE}" required><span>${tok('USDso')}</span></div></div>
        <div><label for="loss">Loss limit</label><div class="unit"><input id="loss" aria-describedby="size-err" type="number" inputmode="numeric" min="1" step="1" value="${Number(q.loss) || 5}" required><span>${tok('USDso')}</span></div></div>
      </div>
      <p class="err" id="size-err" role="alert"></p>
    </div>
    <div class="wizard__foot"><a class="quiet" id="back-account" href="/accounts">Change account</a><button class="btn">Continue</button></div>
  </form>
  <section class="wizard__step" id="s-deposit" hidden>
    <h1 tabindex="-1">Add margin on dreamDEX</h1>
    <p class="sub">Needs ${MIN_MARGIN} ${tok('USDso')} in your perps account. This page moves on once it arrives.</p>
    ${clip('deposit')}
    <div class="wizard__body"><dl class="sheet checks"><div><dt>Perps margin</dt><dd class="state" id="margin">Checking</dd></div></dl>
    <a class="btn" href="${DREAMDEX_URL}" target="_blank" rel="noopener">Open dreamDEX</a></div>
  </section>
  <section class="wizard__step" id="s-review" hidden>
    <h1 tabindex="-1">Review and start</h1>
    <div class="wizard__body wizard__body--teal">
      <dl>
        <div class="row"><dt>Account</dt><dd id="r-account"></dd></div>
        <div class="row"><dt>Covered by</dt><dd>${covered}</dd></div>
        ${now ? `<div class="row"><dt>Trader now</dt><dd>${now}</dd></div>` : ''}
        <div class="row"><dt>End time</dt><dd class="until-value" id="r-until">${time(shift.until, true)}</dd></div>
        <div class="row"><dt>Size per trade</dt><dd id="r-size"></dd></div>
        <div class="row"><dt>Loss limit</dt><dd id="r-loss"></dd></div>
      </dl>
    </div>
    <p id="err" class="err" role="alert"></p>
    <div class="wizard__foot"><button class="link" type="button" id="back">Back</button><button class="btn" id="go">Start shift</button></div>
    <p class="fine">Exits run only while Offshift runs.</p>
  </section>
</div>`, { script: `${STEPS_JS}
const q = ${js(shift)}, params = new URLSearchParams(location.search), here = location.pathname + location.search;
let account = null, timer = 0;
const review = () => {
  clearInterval(timer);
  $('r-account').textContent = account.name;
  $('r-size').textContent = $('size').value + ' USDso';
  $('r-loss').textContent = $('loss').value + ' USDso';
  if ($('hours')) {
    q.until = Date.now() + $('hours').value * 3_600_000;
    $('r-until').textContent = new Date(q.until).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  showStep('s-review');
};
async function waitForMargin() {
  const r = await readBot(account.bot);
  if (!r) return;
  $('margin').textContent = r.collateral.toFixed(2) + ' USDso';
  if (r.collateral >= ${MIN_MARGIN}) review();
}
async function useAccount(a) {
  account = a;
  showStep('s-wait');
  let r = await readBot(a.bot);
  while (!r) { await new Promise((done) => setTimeout(done, 3000)); r = await readBot(a.bot); }
  if (!r.granted || r.gas < 0.2) return location.replace('/accounts/new?bot=' + a.bot + '&next=' + encodeURIComponent(here));
  account.margin = r.collateral;
  showStep('s-size');
}
$('s-size').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const size = Number($('size').value), loss = Number($('loss').value);
  const bad = !(size >= 5 && size <= 1000) ? 'size' : !(loss >= 1) ? 'loss' : '';
  $('size-err').textContent = bad === 'size' ? 'Set a size between 5 and 1,000 USDso.' : bad === 'loss' ? 'Set a loss limit of at least 1 USDso.' : '';
  for (const id of ['size', 'loss']) $(id).toggleAttribute('aria-invalid', id === bad);
  if (bad) return $(bad).focus();
  if (account.margin >= ${MIN_MARGIN}) return review();
  $('margin').textContent = account.margin.toFixed(2) + ' USDso';
  showStep('s-deposit');
  timer = setInterval(waitForMargin, 5000);
});
$('back').onclick = () => showStep('s-size');
$('go').onclick = async () => {
  const secret = localStorage.getItem('offshift:bot:' + account.bot);
  if (!secret) return ($('err').textContent = 'This browser did not create this bot, so it cannot start its shifts.');
  $('go').disabled = true;
  const r = await fetch('/api/shifts', { method: 'POST', body: JSON.stringify({ ...q, size: $('size').value, loss: $('loss').value, bot: account.bot, secret }) }).then((r) => r.json()).catch(() => ({ error: 'Unable to reach Offshift. Check your connection and try again.' }));
  if (r.error) { $('go').disabled = false; return ($('err').textContent = r.error); }
  location = '/shift/' + r.link;
};
const list = accounts(), picked = list.find((a) => a.bot === params.get('account'));
if (!list.length) location.replace('/accounts/new?next=' + encodeURIComponent(here));
else if (picked || list.length === 1) useAccount(picked ?? list[0]);
else {
  $('choices').replaceChildren(...list.map((a) => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button';
    b.className = 'choice-row';
    b.innerHTML = '<strong></strong><span class="mono dim"></span>';
    b.querySelector('strong').textContent = a.name;
    b.querySelector('span').textContent = shortAddress(a.wallet);
    b.onclick = () => useAccount(a);
    li.append(b);
    return li;
  }));
  showStep('s-account');
}
${clipJs}`, setup: true });
}

async function shift(s) {
  const m = markets[s.market];
  const evs = store.events(s.id);
  const running = s.status === 'running';
  // Testnet reads time out now and then; show the stored record and mark the live numbers unavailable.
  let size = null, pnl = null;
  try {
    if (running) {
      const pos = await exchange.client.getPerpPosition({ marginBank: m.marginBank, account: s.owner, pool: m.poolAddress });
      const { markPrice } = await exchange.client.getPerpState(m.poolAddress);
      pnl = await shiftPnl(s, m, pos.size, pos.avgEntryPrice, markPrice);
      size = pos.size;
    } else {
      size = BigInt(evs.findLast((e) => e.position)?.position ?? 0);
      pnl = await finalPnl(s, evs);
    }
  } catch (e) {
    console.log(`shift ${s.id} page: live read failed: ${e.shortMessage ?? e.message}`);
  }
  const candles = await candlesFor(s, evs).catch(() => null);
  await Promise.all(evs.filter((e) => e.tx && !receipts.has(e.tx)).map(async (e) => {
    const r = await rpc.getTransactionReceipt({ hash: e.tx }).catch(() => null);
    if (r) receipts.set(e.tx, r);
  }));
  const chain = (e) => {
    const r = receipts.get(e.tx);
    if (!r) return 'RPC read failed, reload to retry';
    return `${r.status === 'success' ? 'Confirmed' : 'Reverted'} in block ${r.blockNumber}`;
  };
  const numbers = new Map(filled(evs).map((e, i) => [e.id, i + 1]));
  const again = new URLSearchParams({ trader: s.trader ?? '', until: Date.now() + Math.max(3_600_000, s.ends_at - s.created_at), size: s.notional, loss: s.max_loss ?? 5 });
  const title = `Shift #${s.id}`;
  const closing = running && Date.now() >= s.ends_at;
  const ordered = filled(evs).length > 0, abandoned = !running && s.status !== 'done' && !!size;
  const address = (label, a) => `<div class="row"><dt>${label}</dt><dd>${esc(a)}</dd><button class="copy" type="button" data-copy="${esc(a)}">Copy</button></div>`;
  const value = (label, v) => `<div class="row"><dt>${label}</dt><dd>${v}</dd></div>`;
  return page(`${title} · Offshift`, `
<header class="case-head">
  <div><h1>${esc(title)}</h1><p class="sub">${status(s.status)} · ${tok('BTC')} perp${closing ? ' · Closing out.' : s.reason ? ` · ${esc(s.reason)}` : ''}${abandoned ? ' Offshift has stopped, so close the remaining position on <a class="quiet" href="https://app.testnet.dreamdex.io">dreamDEX</a>.' : ''}</p></div>
  <div id="owner" hidden>${closing ? '' : running ? '<button class="btn btn--secondary" id="stop">End shift and close position</button>' : `<a class="btn" href="/link/${esc(s.bot)}?${esc(again)}">Run again</a>`}</div>
</header>
<dl class="cells">
  <div class="cell"><dt class="cell__q">PnL</dt><dd class="cell__a big ${tone(pnl)}">${pnl === null ? '–' : usd(pnl)}</dd><dd class="cell__note">${tok('USDso')}, ${running ? 'realized plus open' : 'realized'}</dd><dd><span class="prov prov--read">Indexer</span></dd></div>
  <div class="cell"><dt class="cell__q">Position</dt><dd class="cell__a">${size === null ? '–' : held(size, true)}</dd>${running ? '<dd><span class="prov prov--live">Live</span></dd>' : ordered ? '<dd><span class="prov prov--receipt">On chain</span></dd>' : ''}</div>
  <div class="cell"><dt class="cell__q">Orders</dt><dd class="cell__a">${filled(evs).length}</dd>${ordered ? '<dd><span class="prov prov--receipt">On chain</span></dd>' : ''}</div>
  <div class="cell"><dt class="cell__q">${running ? 'Time left' : 'Ended'}</dt><dd class="cell__a">${closing ? 'Closing out' : running ? `<span id="left" data-end="${s.ends_at}"></span>` : time(s.ends_at)}</dd>${running ? `<dd class="cell__note">Ends ${time(s.ends_at)}</dd>` : ''}<dd><span class="prov">Set by the owner</span></dd></div>
</dl>
${timeline(s, evs, candles)}
<section class="panel">
  <div class="panel__head"><h2 class="section__title">Details</h2></div>
  <dl class="fields">
    ${s.trader ? address('Covered by', s.trader) : value('Covered by', 'Preset: BTC trend')}${address('Account', s.owner)}
    ${address('Bot', s.bot)}${value('End time', time(s.ends_at, true))}
    ${value('Size per trade', `${esc(s.notional)} ${tok('USDso')}`)}${value('Loss limit', s.max_loss ? `${esc(s.max_loss)} ${tok('USDso')}` : 'None')}
  </dl>
</section>
<section class="panel">
  <div class="panel__head"><h2 class="section__title">Activity</h2>${evs.some((e) => e.tx) ? '<span class="prov prov--receipt">On chain</span>' : ''}</div>
  ${evs.length ? `<div class="wrap"><table class="events"><thead><tr><th>Time</th><th>Event</th><th class="num opt">${tok('BTC')}</th><th>Transaction</th></tr></thead><tbody>
${evs.map((e) => `<tr data-ev="${e.id}"><td>${time(e.at)}</td><td class="ev"><span class="ev-line">${numbers.has(e.id) ? `<i class="mark ${e.side}">${numbers.get(e.id)}</i>` : ''}${word(e)}</span>${e.note ? `<small>${esc(e.note)}</small>` : ''}</td><td class="num opt">${e.quantity ? btc(e.quantity) : ''}</td><td class="tx">${e.tx ? `${esc(short(e.tx))} <button class="copy" type="button" data-copy="${esc(e.tx)}">Copy</button><small>${chain(e)}</small>` : ''}</td></tr>`).join('')}
</tbody></table></div>${evs.some((e) => e.tx) ? '' : ''}`
    : `<p class="empty">${running ? (s.trader ? 'Waiting for the trader’s next move.' : 'Checks the trend every minute.') : 'No orders were placed.'}</p>`}
</section>`, { live: running, script: `
const secret = localStorage.getItem('offshift:bot:' + ${js(s.bot)});
const main = () => document.querySelector('main');
const reveal = () => { if (secret) document.getElementById('owner').hidden = false; };
function count() {
  const left = document.getElementById('left');
  if (!left) return;
  const t = Math.max(0, Math.round((Number(left.dataset.end) - Date.now()) / 1000));
  left.textContent = Math.floor(t / 3600) + ':' + String(Math.floor(t / 60) % 60).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
// A live shift updates in place: only new events move, and focus stays on the button it was on.
async function refresh() {
  clearTimeout(timer);
  try {
    if (!document.hidden) {
      const doc = new DOMParser().parseFromString(await fetch(location.href).then((r) => r.text()), 'text/html');
      const seen = new Set([...main().querySelectorAll('[data-ev]')].map((r) => r.dataset.ev));
      const focused = document.activeElement?.id === 'stop';
      main().replaceWith(doc.querySelector('main'));
      document.title = doc.title;
      localize(main()); reveal(); count();
      for (const r of main().querySelectorAll('[data-ev]')) if (!seen.has(r.dataset.ev)) r.classList.add('new');
      if (focused) document.getElementById('stop')?.focus();
    }
  } catch { /* testnet reads time out now and then; the next refresh covers it */ }
  if ('live' in main().dataset) timer = setTimeout(refresh, 5000);
}
let timer = 'live' in main().dataset ? setTimeout(refresh, 5000) : 0;
reveal(); count(); setInterval(count, 1000);
document.addEventListener('click', async (ev) => {
  if (!ev.target.closest('#stop')) return;
  if (!confirm('End this shift now? Offshift closes your position at market.')) return;
  ev.target.disabled = true;
  await fetch('/api/shifts/${s.id}/stop', { method: 'POST', body: JSON.stringify({ secret }) });
  refresh();
});` });
}

async function history(account) {
  const kept = histories.get(account);
  if (kept && Date.now() - kept.at < 300_000) return kept;
  if (!pairs.size) await readPairs();
  const [rows, positions, net] = await Promise.all([changes(exchange.client, account), exchange.client.listPerpPositions(account), funding(exchange.client, account)]);
  const fresh = { at: Date.now(), rows, positions, funding: net };
  histories.set(account, fresh);
  return fresh;
}

// One trader across every market: what they made, how they trade, and what following them would have made.
async function traderPage(account) {
  const r = record(BTC.poolAddress, account);
  const h = await history(account).catch((e) => console.log(`trader ${account} page: history failed: ${e.shortMessage ?? e.message}`));
  const missing = 'Trade history failed to load. Reload to retry.';
  const rows = h?.rows ?? [], closes = rows.filter((c) => c.closedSize), orders = closedOrders(rows), stats = activity(rows), markets = byPair(rows, baseDecimals);
  const made = h ? raw(closes.reduce((sum, c) => sum + c.realizedPnl, 0n)) : r.pnl, wins = h ? closes.filter((c) => c.realizedPnl > 0n).length : r.wins, count = h ? closes.length : r.closes;
  const worst = orders.reduce((w, o) => (!w || o.pnl < w.pnl ? o : w), null), loss = worst && worst.pnl < 0n ? raw(worst.pnl) : null;
  const follow = h && replay(rows.filter((c) => c.pool === POOL_BTC), FOLLOW_SIZE);
  const positions = (h?.positions ?? []).map((p) => {
    const m = pairs.get(p.pool), mark = m?.markPrice ? BigInt(m.markPrice) : null, size = BigInt(p.size), entry = BigInt(p.avgEntryPrice);
    return { pool: p.pool, size, entry, mark, pnl: mark === null ? null : raw(openPnl(size, entry, mark, { baseDecimals: baseDecimals(p.pool) })) };
  }).filter((p) => p.size !== 0n);
  const openTotal = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0), fundingNet = h ? raw(h.funding) : 0, net = made + fundingNet + openTotal;
  const price = (n) => (n ? raw(n).toLocaleString('en-US', { maximumFractionDigits: raw(n) < 10 ? 4 : 0 }) : '–');
  const volume = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const side = (units) => `${units > 0n ? 'Long' : 'Short'}`;
  const now = positions.length === 0 ? 'Flat' : positions.length === 1 ? `${side(positions[0].size)} ${tok(pairName(positions[0].pool))}` : `${positions.length} positions`;
  const move = lastMove(account, stats.last || r.last), live = move === moved.get(account);
  const cover = `/cover?trader=${esc(account)}`, title = `Trader ${short(account)}`;
  const line = (label, value) => `<div><dt>${label}</dt><dd class="${tone(value)}">${usd(value)}</dd></div>`;
  return page(`${title} · Offshift`, `
<header class="case-head">
  <div><h1>${who(account).replace('class="who"', 'class="who who--big"')}</h1><div class="addr"><code>${esc(account)}</code><button class="copy" type="button" data-copy="${esc(account)}">Copy</button></div></div>
  <a class="btn" href="${cover}">Pick this trader</a>
</header>
<dl class="cells">
  <div class="cell"><dt class="cell__q">Realized PnL</dt><dd class="cell__a big ${tone(made)}">${usd(made)}</dd><dd class="cell__note">${tok('USDso')}, ${h ? 'all pairs' : tok('BTC')}, 7 days</dd><dd><span class="prov prov--read">Indexer</span></dd></div>
  <div class="cell"><dt class="cell__q">Position</dt><dd class="cell__a">${h ? now : '–'}</dd>${h && !positions.length ? '' : `<dd class="cell__note ${tone(openTotal)}">${h ? `${usd(openTotal)} ${tok('USDso')} open` : 'Reload to retry'}</dd>`}<dd><span class="prov prov--read">Indexer</span></dd></div>
  <div class="cell"><dt class="cell__q">Win rate</dt><dd class="cell__a">${count ? `${Math.round((wins / count) * 100)}%` : '–'}</dd><dd class="cell__note">${wins} of ${count} closes</dd><dd><span class="prov prov--read">Indexer</span></dd></div>
  <div class="cell"><dt class="cell__q">Worst close</dt><dd class="cell__a ${tone(loss ?? 0)}">${loss === null ? (h ? 'No losses' : '–') : usd(loss)}</dd>${loss === null ? '' : `<dd class="cell__note">${tok('USDso')} on ${tok(pairName(worst.pool))}, ${time(Number(worst.at) * 1000, true)}</dd>`}<dd><span class="prov prov--read">Indexer</span></dd></div>
</dl>
<section class="follow" aria-labelledby="follow-title">
  <div class="panel__head"><h2 class="section__title" id="follow-title">Copying them on BTC</h2><span class="prov">Estimate</span></div>
  ${follow ? `<p class="outcome"><b class="${tone(follow.pnl)}">${usd(follow.pnl)} ${tok('USDso')}</b><span>at ${FOLLOW_SIZE} ${tok('USDso')} a trade, ${follow.trades} ${follow.trades === 1 ? 'trade' : 'trades'} closed</span></p>
  <p class="fine">Replayed at their BTC fills. Leaves out fees, funding, slippage, your loss limit and copy delay.</p>` : `<p class="sub">${missing}</p>`}
</section>
${h && rows.length ? `<section class="panel" aria-labelledby="activity-title">
  <div class="panel__head"><h2 class="section__title" id="activity-title">Activity</h2></div>
  <dl class="cells">
    <div class="cell"><dt class="cell__q">Orders</dt><dd class="cell__a">${stats.trades.toLocaleString('en-US')}</dd><dd class="cell__note">${stats.entries ? `${Math.round((stats.longs / stats.entries) * 100)}% of entries long` : 'No new entries'}</dd></div>
    <div class="cell"><dt class="cell__q">Days active</dt><dd class="cell__a">${stats.days} of 7</dd></div>
    <div class="cell"><dt class="cell__q">Typical hold</dt><dd class="cell__a">${stats.hold === null ? '–' : span(stats.hold)}</dd><dd class="cell__note">Median</dd></div>
    <div class="cell"><dt class="cell__q">Last move</dt><dd class="cell__a">${move ? ago(move) : '–'}</dd>${live ? '<dd><span class="prov prov--live">Live</span></dd>' : ''}</div>
  </dl>
  <figure class="heat" id="heat" data-at="${esc(JSON.stringify(rows.slice(-5000).map((c) => Number(c.timestamp))))}">
    <figcaption><span id="busy"></span><span class="heat__key" aria-hidden="true">Fewer<i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i>More</span></figcaption>
    <div class="heat__grid" id="heat-grid" role="img"></div>
  </figure>
</section>
<section class="panel" aria-labelledby="pairs-title">
  <div class="panel__head"><h2 class="section__title" id="pairs-title">Pairs traded</h2></div>
  <div class="wrap"><table><thead><tr><th>Pair</th><th class="num opt">${inUsd('Volume')}</th><th class="num opt">Closes</th><th class="num opt">Win rate</th><th class="num">${inUsd('Realized PnL')}</th></tr></thead><tbody>
${markets.map((m) => `<tr><td>${tok(pairName(m.pool))}${m.pool === POOL_BTC ? '<small class="tag">Copied by Offshift</small>' : ''}</td><td class="num opt">${volume(m.volume)}</td><td class="num opt">${m.closes}</td><td class="num opt">${m.closes ? `${Math.round((m.wins / m.closes) * 100)}%` : '–'}</td><td class="num ${tone(raw(m.pnl))}">${usd(raw(m.pnl))}</td></tr>`).join('')}
</tbody></table></div><p class="fine">Each fill counts as a close.${rows.length >= MAX_CHANGES ? ` Latest ${MAX_CHANGES.toLocaleString('en-US')} position changes only.` : ''}</p>
</section>
<section class="panel" aria-labelledby="pnl-title">
  <div class="panel__head"><h2 class="section__title" id="pnl-title">PnL</h2></div>
  <div class="pnl-split">
    <div class="trace">${closes.length > 1 ? `${curve(closes.map((c) => raw(c.realizedPnl)), 1000, 240, closes.map((c) => Number(c.timestamp)))}<div class="ends">${time(Number(closes[0].timestamp) * 1000, true)}<span>Realized, all pairs</span>${time(Number(closes.at(-1).timestamp) * 1000, true)}</div>` : '<p class="sub">Not enough closes to draw.</p>'}</div>
    <dl class="sheet sheet--money">${line('Realized', made)}${line('Funding', fundingNet)}${line('Open', openTotal)}${line('Total', net)}</dl>
  </div>
  <p class="fine">USDso, before fees.</p>
</section>` : ''}
${positions.length ? `<section class="panel" aria-labelledby="open-title">
  <div class="panel__head"><h2 class="section__title" id="open-title">Open positions</h2></div>
  <div class="wrap"><table><thead><tr><th>Position</th><th class="num opt">Entry</th><th class="num opt">Mark</th><th class="num">${inUsd('Open PnL')}</th></tr></thead><tbody>
${positions.map((p) => `<tr><td>${side(p.size)} ${quantity(p.size, p.pool)} ${tok(pairName(p.pool))}</td><td class="num opt">${price(p.entry)}</td><td class="num opt">${price(p.mark)}</td><td class="num ${tone(p.pnl ?? 0)}">${p.pnl === null ? '–' : usd(p.pnl)}</td></tr>`).join('')}
</tbody></table></div>
</section>` : ''}
<section class="panel">
  <div class="panel__head"><h2 class="section__title">Recent closes</h2></div>
  ${orders.length ? `<div class="wrap"><table><thead><tr><th class="opt">Closed</th><th>Position</th><th class="num opt">Entry</th><th class="num opt">Exit</th><th class="num">${inUsd('PnL')}</th></tr></thead><tbody>
${orders.slice(-20).reverse().map((o) => `<tr><td class="opt">${time(Number(o.at) * 1000, true)}</td><td>${o.long ? 'Long' : 'Short'} ${quantity(o.size, o.pool)} ${tok(pairName(o.pool))}<small class="on-phone dim">${time(Number(o.at) * 1000, true)}</small></td><td class="num opt">${price(o.entry)}</td><td class="num opt">${price(o.exit)}</td><td class="num ${tone(raw(o.pnl))}">${usd(raw(o.pnl))}</td></tr>`).join('')}
</tbody></table></div><p class="fine">Before fees and funding.</p>` : `<p class="empty">${h ? 'No closes in the last 7 days.' : missing}</p>`}
</section>`, { script: TRADER_SCRIPT });
}

// When they trade, drawn in the reader's own time so it can be set against the hours they'll be away.
const TRADER_SCRIPT = `
const heat = document.getElementById('heat');
if (heat) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], pad = (n) => String(n).padStart(2, '0');
  const grid = days.map(() => Array(24).fill(0)), hours = Array(24).fill(0);
  for (const t of JSON.parse(heat.dataset.at)) {
    const d = new Date(t * 1000);
    grid[(d.getDay() + 6) % 7][d.getHours()] += 1;
    hours[d.getHours()] += 1;
  }
  const top = Math.max(...grid.flat()), busiest = hours.map((_, h) => [h, hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24] + hours[(h + 3) % 24]]).sort((a, b) => b[1] - a[1])[0][0];
  const cell = (n, day, h) => '<i class="lv' + Math.ceil((n / top) * 4) + '" title="' + day + ' ' + pad(h) + ':00, ' + n + (n === 1 ? ' change' : ' changes') + '"></i>';
  const text = 'Busiest between ' + pad(busiest) + ':00 and ' + pad((busiest + 4) % 24) + ':00 your time';
  document.getElementById('busy').textContent = text;
  const box = document.getElementById('heat-grid');
  box.setAttribute('aria-label', 'Trading activity by day and hour. ' + text + '.');
  box.innerHTML = grid.map((row, d) => '<span>' + days[d] + '</span>' + row.map((n, h) => cell(n, days[d], h)).join('')).join('') + '<span></span>' + hours.map((_, h) => '<span class="heat__hour">' + (h % 6 ? '' : pad(h)) + '</span>').join('');
}`;

async function linkStatus(b) {
  const [granted, gas, margin] = await Promise.all([
    exchange.client.isOperatorAuthorized({ pool: BTC.poolAddress, owner: b.owner, operator: b.address, selector: PLACE_ORDER_FOR_SELECTOR }),
    rpc.getBalance({ address: b.address }),
    exchange.client.getMarginAccount(BTC.marginBank, b.owner),
  ]);
  const running = store.runningSessions().filter((s) => s.bot === b.address).map((s) => ({ id: s.id }));
  return { owner: b.owner, granted, gas: Number(formatEther(gas)), collateral: Number(formatUnits(margin.unlockedCollateralBalance, 18)), running };
}

function startShift(q) {
  if (!store.checkSecret(q.bot, q.secret)) throw new Error('This browser did not create this bot, so it cannot start its shifts.');
  const hours = (Number(q.until) - Date.now()) / 3_600_000, size = Number(q.size), loss = Number(q.loss);
  if (!(hours >= 0.25 && hours <= 24)) throw new Error('Pick an end time between 15 minutes and 24 hours from now.');
  if (!(size >= 5 && size <= 1000)) throw new Error('Size per trade must be between 5 and 1,000 USDso.');
  if (!(loss >= 1)) throw new Error('Set a loss limit of at least 1 USDso.');
  if (q.trader && !isAddress(q.trader)) throw new Error('That trader address is not valid.');
  return store.startSession({ bot: q.bot, hours, notional: String(size), trader: q.trader || null, maxLoss: String(loss) });
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) if ((raw += chunk).length > 10_000) throw new Error('Request too large.');
  return JSON.parse(raw || '{}');
}

async function readBlock() {
  block = await rpc.getBlockNumber().then(Number).catch(() => block);
  setTimeout(readBlock, 15_000);
}

readBlock();
refreshBoard();
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const [, a, b, c] = url.pathname.split('/');
  const html = (s, code = 200) => res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }).end(s);
  const json = (v, code = 200) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  try {
    const picked = url.searchParams.get('trader') ?? '';
    if (req.method === 'GET' && url.pathname === '/') return html(home(isAddress(picked) ? getAddress(picked) : null));
    if (req.method === 'GET' && a === 'tokens' && tokens.has(b)) return res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }).end(tokens.get(b));
    if (req.method === 'GET' && a === 'clips' && screenFiles.has(b)) return res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'public, max-age=86400' }).end(screenFiles.get(b));
    if (req.method === 'GET' && url.pathname === '/how') return html(howPage());
    if (req.method === 'GET' && url.pathname === '/traders') return html(tradersPage());
    if (req.method === 'GET' && url.pathname === '/shifts') return html(shiftsPage());
    if (req.method === 'GET' && url.pathname === '/accounts') return html(accountsPage());
    if (req.method === 'GET' && url.pathname === '/accounts/new') return html(accountSetup());
    if (req.method === 'GET' && url.pathname === '/cover') return html(await shiftSetup(Object.fromEntries(url.searchParams)));
    if (req.method === 'GET' && a === 'link' && isAddress(b ?? '') && store.bot(b)) return res.writeHead(302, { location: `/cover?account=${b}&${url.searchParams}` }).end();
    if (req.method === 'GET' && a === 'trader' && isAddress(b ?? '')) return html(await traderPage(b.toLowerCase()));
    if (req.method === 'GET' && a === 'shift' && store.sessionByLink(b ?? '')) return html(await shift(store.sessionByLink(b)));
    if (req.method === 'GET' && a === 'api' && b === 'link' && isAddress(c ?? '') && store.bot(c)) return json(await linkStatus(store.bot(c)));
    if (req.method === 'POST' && a === 'api' && b === 'bots') {
      const { owner } = await body(req);
      if (!isAddress(owner ?? '')) return json({ error: 'That account address is not valid.' }, 400);
      return json(store.newBot(owner)); // ponytail: no rate limit; a bot does nothing until its owner links it
    }
    if (req.method === 'POST' && a === 'api' && b === 'shifts' && !c) return json({ link: store.session(startShift(await body(req))).link });
    if (req.method === 'POST' && a === 'api' && b === 'shifts' && c === 'mine') {
      const { bots } = await body(req);
      return json({ html: myShifts(Array.isArray(bots) ? bots : []) });
    }
    if (req.method === 'POST' && a === 'api' && b === 'shifts' && url.pathname.endsWith('/stop')) {
      const s = store.session(Number(c));
      if (!s || !store.checkSecret(s.bot, (await body(req)).secret)) return json({ error: 'Only the browser that started this shift can end it.' }, 403);
      store.stopNow(s.id, 'Ended early by the owner.');
      pass();
      return json({ ok: true });
    }
    html(page('Not found · Offshift', '<h1>Not found</h1><p class="sub"><a class="quiet" href="/traders">Back to the traders</a></p>'), 404);
  } catch (e) {
    if (req.method === 'POST') return json({ error: e.message }, 400);
    console.log(`${req.url}: ${e.shortMessage ?? e.message}`);
    html(page('Error · Offshift', `<h1>Something failed</h1><p class="sub">${esc(e.shortMessage ?? e.message)}</p><p class="sub"><a class="quiet" href="/traders">Back to the traders</a></p>`), 500);
  }
}).listen(PORT, () => console.log(`offshift web on http://localhost:${PORT}`));
