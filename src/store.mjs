// Shifts (sessions), their order events, and the bot keys, in one SQLite file.
// Bot keys are encrypted at rest with OFFSHIFT_SECRET (32 bytes hex). A bot key can place and
// cancel orders for its owner but cannot withdraw; owners' own keys never reach this service.
// Each bot comes with a random secret, shown once, that is required to start or end its shifts:
// knowing an owner's address is not enough to trade their account.
// Each shift has a random link: its page is open to whoever has that, and its number gives nothing away.
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const db = new DatabaseSync(process.env.OFFSHIFT_DB ?? 'offshift.sqlite');
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS bots (
    address TEXT PRIMARY KEY, owner TEXT NOT NULL, key_enc TEXT NOT NULL, secret_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY, owner TEXT NOT NULL, bot TEXT NOT NULL, market TEXT NOT NULL, trader TEXT,
    notional TEXT NOT NULL, max_loss TEXT, ends_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
    blocked TEXT, skipped TEXT, created_at INTEGER NOT NULL, link TEXT);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
    tx TEXT, side TEXT, quantity TEXT, price TEXT, position TEXT, note TEXT);
`);
export { db };

const secret = () => Buffer.from(process.env.OFFSHIFT_SECRET ?? '', 'hex');
function seal(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secret(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('hex')).join('.');
}
function open(sealed) {
  const [iv, tag, body] = sealed.split('.').map((h) => Buffer.from(h, 'hex'));
  const d = createDecipheriv('aes-256-gcm', secret(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}
const hash = (s) => createHash('sha256').update(s).digest('hex');

// A new bot for `owner`; `key` imports an existing bot key. Returns its address and secret.
export function newBot(owner, key = generatePrivateKey()) {
  const address = privateKeyToAccount(key).address;
  const pass = randomBytes(16).toString('hex');
  db.prepare('INSERT INTO bots (address, owner, key_enc, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(address, getAddress(owner), seal(key), hash(pass), Date.now());
  return { address, secret: pass };
}
export const bot = (address) => db.prepare('SELECT address, owner, created_at FROM bots WHERE address = ?').get(getAddress(address));
export const botKey = (address) => open(db.prepare('SELECT key_enc FROM bots WHERE address = ?').get(getAddress(address)).key_enc);
export const checkSecret = (address, pass) =>
  !!pass && db.prepare('SELECT secret_hash FROM bots WHERE address = ?').get(getAddress(address))?.secret_hash === hash(pass);

export function startSession({ bot: address, hours, notional, trader = null, maxLoss = null, market = 'BTC' }) {
  const b = bot(address);
  // Two shifts on one account and market would trade against each other.
  const running = db.prepare("SELECT id FROM sessions WHERE owner = ? AND market = ? AND status = 'running'").get(b.owner, market);
  if (running) throw new Error(`Shift #${running.id} is already running on this account. End it before starting another.`);
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO sessions (owner, bot, market, trader, notional, max_loss, ends_at, status, created_at, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(b.owner, b.address, market, trader && getAddress(trader), String(notional), maxLoss && String(maxLoss), now + hours * 3_600_000, 'running', now, randomBytes(16).toString('hex'));
  return Number(lastInsertRowid);
}
export const runningSessions = () => db.prepare("SELECT * FROM sessions WHERE status = 'running'").all();
export const session = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
export const sessionByLink = (link) => db.prepare('SELECT * FROM sessions WHERE link = ?').get(link);
export const sessions = () => db.prepare('SELECT * FROM sessions ORDER BY id DESC').all();
export const stopNow = (id, reason = null) =>
  db.prepare("UPDATE sessions SET ends_at = ?, reason = COALESCE(?, reason) WHERE id = ? AND status = 'running' AND ends_at > ?").run(Date.now(), reason, id, Date.now());
export const finish = (id, status, reason = null) =>
  db.prepare('UPDATE sessions SET status = ?, reason = COALESCE(?, reason), ends_at = MIN(ends_at, ?) WHERE id = ?').run(status, reason, Date.now(), id);
export const setBlocked = (id, blocked) => db.prepare('UPDATE sessions SET blocked = ? WHERE id = ?').run(blocked, id);
export const setSkipped = (id, skipped) => db.prepare('UPDATE sessions SET skipped = ? WHERE id = ?').run(skipped, id);

export function addEvent(sessionId, e) {
  db.prepare('INSERT INTO events (session_id, at, kind, tx, side, quantity, price, position, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, Date.now(), e.kind, e.tx ?? null, e.side ?? null, e.quantity ?? null, e.price ?? null, e.position ?? null, e.note ?? null);
}
export const events = (sessionId) => db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionId);
