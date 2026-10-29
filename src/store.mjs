// Sessions, their order events, and one bot key per owner, in one SQLite file.
// Bot keys are encrypted at rest with OFFSHIFT_SECRET (32 bytes hex). A bot key can place and
// cancel orders for its owner but cannot withdraw; owners' own keys never reach this service.
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const db = new DatabaseSync(process.env.OFFSHIFT_DB ?? 'offshift.sqlite');
db.exec(`
  CREATE TABLE IF NOT EXISTS bots (owner TEXT PRIMARY KEY, address TEXT NOT NULL, key_enc TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY, owner TEXT NOT NULL, bot TEXT NOT NULL, market TEXT NOT NULL,
    notional TEXT NOT NULL, ends_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
    blocked TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
    tx TEXT, side TEXT, quantity TEXT, price TEXT, position TEXT, note TEXT);
`);

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

// The owner's bot address, created on first request. `key` imports an existing bot key.
export function botFor(owner, key = generatePrivateKey()) {
  owner = getAddress(owner);
  const row = db.prepare('SELECT address FROM bots WHERE owner = ?').get(owner);
  if (row) return row.address;
  const address = privateKeyToAccount(key).address;
  db.prepare('INSERT INTO bots (owner, address, key_enc) VALUES (?, ?, ?)').run(owner, address, seal(key));
  return address;
}
export const botKey = (owner) => open(db.prepare('SELECT key_enc FROM bots WHERE owner = ?').get(getAddress(owner)).key_enc);

export function startSession({ owner, hours, notional, market = 'BTC' }) {
  owner = getAddress(owner);
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO sessions (owner, bot, market, notional, ends_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(owner, botFor(owner), market, String(notional), now + hours * 3_600_000, 'running', now);
  return Number(lastInsertRowid);
}
export const runningSessions = () => db.prepare("SELECT * FROM sessions WHERE status = 'running'").all();
export const session = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
export const sessions = () => db.prepare('SELECT * FROM sessions ORDER BY id DESC').all();
export const stopNow = (id) => db.prepare("UPDATE sessions SET ends_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), id);
export const finish = (id, status, reason = null) =>
  db.prepare('UPDATE sessions SET status = ?, reason = ? WHERE id = ?').run(status, reason, id);
export const setBlocked = (id, blocked) => db.prepare('UPDATE sessions SET blocked = ? WHERE id = ?').run(blocked, id);

export function addEvent(sessionId, e) {
  db.prepare('INSERT INTO events (session_id, at, kind, tx, side, quantity, price, position, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, Date.now(), e.kind, e.tx ?? null, e.side ?? null, e.quantity ?? null, e.price ?? null, e.position ?? null, e.note ?? null);
}
export const events = (sessionId) => db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionId);
