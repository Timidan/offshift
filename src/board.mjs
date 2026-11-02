// The trader board: every realized close on a perp pool (REDUCE, CLOSE, FLIP), pulled from the
// indexer into SQLite every few minutes, and ranked from that copy, never on page load.
// Market makers (more than 200 closes per active day) and short records are left out.
import { db } from './store.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS closes (id TEXT PRIMARY KEY, pool TEXT NOT NULL, account TEXT NOT NULL, at INTEGER NOT NULL, pnl REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS closes_by_account ON closes (pool, account, at);`);
const BACKFILL_S = 3 * 86_400, WINDOW_S = 7 * 86_400, MM_PER_DAY = 200, MIN_CLOSES = 10, MIN_DAYS = 2;

export async function ingest(client, pool) {
  const last = db.prepare('SELECT MAX(at) AS at FROM closes WHERE pool = ?').get(pool).at;
  const from = last ?? Math.floor(Date.now() / 1000) - BACKFILL_S;
  const add = db.prepare('INSERT OR IGNORE INTO closes (id, pool, account, at, pnl) VALUES (?, ?, ?, ?, ?)');
  let total = 0;
  for (let offset = 0; ; offset += 1000) {
    const rows = await client.listPerpPositionChanges({ pool, kinds: ['REDUCE', 'CLOSE', 'FLIP'], from, order: 'asc', limit: 1000, offset });
    for (const r of rows) add.run(r.id, pool, r.account, Number(r.timestamp), Number(r.realizedPnl) / 1e18);
    total += rows.length;
    if (rows.length < 1000) return total;
  }
}

// The largest drop of cumulative realized PnL from a previous high, in USDso.
export function maxDrawdown(pnls) {
  let sum = 0, peak = 0, worst = 0;
  for (const p of pnls) {
    sum += p;
    peak = Math.max(peak, sum);
    worst = Math.max(worst, peak - sum);
  }
  return worst;
}

export function board(pool, limit = 20) {
  const since = Math.floor(Date.now() / 1000) - WINDOW_S;
  const rows = db.prepare(`
    SELECT account, COUNT(*) AS closes, SUM(pnl) AS pnl, SUM(pnl > 0) AS wins,
           COUNT(DISTINCT at / 86400) AS days, MAX(at) AS last
    FROM closes WHERE pool = ? AND at >= ? GROUP BY account
    HAVING closes >= ? AND days >= ? AND closes <= days * ?
    ORDER BY pnl DESC LIMIT ?`).all(pool, since, MIN_CLOSES, MIN_DAYS, MM_PER_DAY, limit);
  const series = db.prepare('SELECT pnl FROM closes WHERE pool = ? AND account = ? AND at >= ? ORDER BY at');
  return rows.map((r) => {
    const pnls = series.all(pool, r.account, since).map((x) => x.pnl);
    return { ...r, winRate: r.wins / r.closes, drawdown: maxDrawdown(pnls), pnls };
  });
}

// One trader's closes in the window, with or without a place on the board.
export function record(pool, account) {
  const since = Math.floor(Date.now() / 1000) - WINDOW_S;
  const rows = db.prepare('SELECT at, pnl FROM closes WHERE pool = ? AND account = ? AND at >= ? ORDER BY at').all(pool, account, since);
  const pnls = rows.map((r) => r.pnl);
  return { closes: pnls.length, pnl: pnls.reduce((a, b) => a + b, 0), wins: pnls.filter((p) => p > 0).length, pnls, first: rows[0]?.at, last: rows.at(-1)?.at };
}

// A trader's position changes in the window, across all markets, oldest first. Market makers make
// far too many to read on a page load, so this keeps the latest MAX_CHANGES.
export const MAX_CHANGES = 10_000;
export async function changes(client, account) {
  const from = Math.floor(Date.now() / 1000) - WINDOW_S, all = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await client.listPerpPositionChanges({ account, from, order: 'desc', limit: 1000, offset });
    all.push(...rows);
    if (rows.length < 1000 || all.length >= MAX_CHANGES) return all.reverse();
  }
}

// Funding the trader received in the window, net of what they paid. The indexer lists it newest
// first, and a positive amount is a payment by the account.
export async function funding(client, account) {
  const from = Math.floor(Date.now() / 1000) - WINDOW_S;
  let net = 0n;
  for (let offset = 0; ; offset += 1000) {
    const rows = await client.getFundingPayments(account, { limit: 1000, offset });
    for (const r of rows) if (Number(r.timestamp) >= from) net -= BigInt(r.amount);
    if (rows.length < 1000 || Number(rows.at(-1).timestamp) < from) return net;
  }
}

export const trader = (pool, account) => board(pool, 1000).find((t) => t.account.toLowerCase() === account.toLowerCase()) ?? null;
