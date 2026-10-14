/* ==========================================================================
 * Street Light GIS · server/store.js
 * The saved state: one SQLite file (node:sqlite, built into Node 22.13+; no packages).
 *
 * The browser app keeps all workflow logic. The server stores its state as small documents
 * (one per pole, ticket, report, reporter, activity entry, plus one settings document), each with
 * a revision number. A staff browser sends the documents an action changed, with the revision it
 * started from; if any of them changed on the server meanwhile, nothing is written (a conflict) and
 * the browser reloads the latest state. Every write gets a sequence number, so browsers can ask
 * for what changed since they last looked.
 * ========================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const KINDS = ['pole', 'ticket', 'report', 'reporter', 'activity', 'setting'];
const MAX_DOC_BYTES = 64 * 1024;          // one document; a ticket with a long history is a few KB
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS docs (
      kind TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL,
      body TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      PRIMARY KEY (kind, id));
    CREATE INDEX IF NOT EXISTS docs_seq ON docs (seq);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS writes (            -- server-side audit: who wrote which document, when
      seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, name TEXT NOT NULL, roles TEXT NOT NULL, crew TEXT,
      password TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS otps (
      phone_hash TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hits (                -- rate limits: one row per counted event
      bucket TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS hits_bucket ON hits (bucket, at);
    CREATE TABLE IF NOT EXISTS claims (              -- a staff browser processing a citizen report
      report_id TEXT PRIMARY KEY, by TEXT NOT NULL, until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, delete_after INTEGER NOT NULL);
  `);
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      get: db.prepare('SELECT rev, seq, body FROM docs WHERE kind = ? AND id = ?'),
      put: db.prepare(`INSERT INTO docs (kind, id, rev, seq, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (kind, id) DO UPDATE SET rev = excluded.rev, seq = excluded.seq, body = excluded.body,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
      del: db.prepare('DELETE FROM docs WHERE kind = ? AND id = ?'),
      all: db.prepare('SELECT kind, id, rev, seq, body FROM docs'),
      since: db.prepare('SELECT kind, id, rev, seq, body FROM docs WHERE seq > ?'),
      byKind: db.prepare('SELECT id, rev, body FROM docs WHERE kind = ?'),
      write: db.prepare('INSERT INTO writes (seq, kind, id, rev, by, at) VALUES (?, ?, ?, ?, ?, ?)'),
      meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    };
  }

  meta(key, fallback = null) {
    const row = this.q.meta.get(key);
    return row ? row.value : fallback;
  }
  setMeta(key, value) { this.q.setMeta.run(key, String(value)); }
  seq() { return Number(this.meta('seq', '0')); }

  /** Run fn inside one transaction; any throw rolls everything back. */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  get(kind, id) {
    const row = this.q.get.get(kind, id);
    return row ? { kind, id, rev: row.rev, seq: row.seq, doc: JSON.parse(row.body) } : null;
  }
  list(kind) { return this.q.byKind.all(kind).map((r) => ({ kind, id: r.id, rev: r.rev, doc: JSON.parse(r.body) })); }
  all() { return this.q.all.all().map(rowOut); }
  since(seq) { return this.q.since.all(seq).map(rowOut); }

  /** Write documents unconditionally (seeding, server-side updates). Call inside tx(). */
  writeDocs(changes, by) {
    let seq = this.seq();
    const at = new Date().toISOString();
    const revs = {};
    for (const c of changes) {
      const cur = this.q.get.get(c.kind, c.id);
      const rev = (cur?.rev ?? 0) + 1;
      seq += 1;
      if (c.doc === null) this.q.del.run(c.kind, c.id);
      else this.q.put.run(c.kind, c.id, rev, seq, JSON.stringify(c.doc), at, by);
      this.q.write.run(seq, c.kind, c.id, rev, by, at);
      revs[`${c.kind}:${c.id}`] = rev;
    }
    this.setMeta('seq', seq);
    return { seq, revs };
  }

  /**
   * A staff browser's changes, all or nothing. Each change: { kind, id, rev (the revision it started
   * from; 0 = new), doc (null = delete) }. Returns { ok, seq, revs } or { ok: false, conflicts, current revs }.
   */
  sync(changes, by) {
    return this.tx(() => {
      const conflicts = [];
      const current = {};
      for (const c of changes) {
        const cur = this.q.get.get(c.kind, c.id);
        if ((cur?.rev ?? 0) !== c.rev) {
          conflicts.push(`${c.kind}:${c.id}`);
          current[`${c.kind}:${c.id}`] = cur?.rev ?? 0;
        }
      }
      if (conflicts.length) return { ok: false, conflicts, current };
      return { ok: true, ...this.writeDocs(changes, by) };
    });
  }

  /** Hand out the next ticket or report IDs (a browser keeps a few in hand, so IDs are unique, not always consecutive). */
  leaseIds(kind, n, year = new Date().getFullYear()) {
    return this.tx(() => {
      const key = kind === 'ticket' ? `ticket_seq_${year}` : 'report_seq';
      let last = Number(this.meta(key, kind === 'ticket' ? '100' : '0'));
      const ids = [];
      for (let i = 0; i < n; i++) {
        last += 1;
        ids.push(kind === 'ticket' ? `TKT-${year}-${String(last).padStart(4, '0')}` : `CR-${String(last).padStart(3, '0')}`);
      }
      this.setMeta(key, last);
      return ids;
    });
  }

  isSeeded() { return this.meta('seeded') === '1'; }
}

const rowOut = (r) => ({ kind: r.kind, id: r.id, rev: r.rev, seq: r.seq, doc: JSON.parse(r.body) });

/** Validate one incoming change from a browser. Returns an error string or null. */
function checkChange(c) {
  if (!c || typeof c !== 'object') return 'change must be an object';
  if (!KINDS.includes(c.kind)) return `unknown kind ${String(c.kind).slice(0, 20)}`;
  if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) return 'bad id';
  if (!Number.isInteger(c.rev) || c.rev < 0) return 'bad rev';
  if (c.doc !== null && (typeof c.doc !== 'object' || Array.isArray(c.doc))) return 'doc must be an object or null';
  if (c.doc !== null && JSON.stringify(c.doc).length > MAX_DOC_BYTES) return 'doc too large';
  return null;
}

/** Never store contact details or in-browser picture links in a document. */
function sanitizeDoc(kind, doc) {
  if (!doc) return doc;
  if (kind === 'report') {
    const { name, phone, mine, ...rest } = doc; // eslint-disable-line no-unused-vars
    if (rest.photo) {
      const { url, ...photo } = rest.photo;
      rest.photo = typeof url === 'string' && /^\/api\/photos\/[a-f0-9]{32}$/.test(url) ? { ...photo, url } : photo;
    }
    return rest;
  }
  if (kind === 'ticket' && doc.dusk_photo) {
    const url = doc.dusk_photo.url;
    return { ...doc, dusk_photo: typeof url === 'string' && /^\/api\/photos\/[a-f0-9]{32}$/.test(url) ? doc.dusk_photo : { at: doc.dusk_photo.at, url: null } };
  }
  return doc;
}

// ---- seeding from the app's dataset ----------------------------------------------------------------
/** Read data/streetlights.js (it sets window.SLGIS_DATA) without a browser. */
function loadDataset(file) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window }, { filename: file, timeout: 5000 });
  if (!window.SLGIS_DATA?.streetlights?.features?.length) throw new Error(`no streetlights in ${file}`);
  return window.SLGIS_DATA;
}

/** The documents for a fresh server: the dataset's poles, live tickets, reporters and reports. */
function seedDocs(data, { publicSharing = true } = {}) {
  const docs = [];
  const tickets = new Map();
  let maxTicket = {};
  const noteId = (id) => {
    const m = /^TKT-(\d{4})-(\d+)$/.exec(id ?? '');
    if (m) maxTicket[m[1]] = Math.max(maxTicket[m[1]] ?? 0, Number(m[2]));
  };
  for (const f of data.streetlights.features) {
    const p = f.properties;
    docs.push({ kind: 'pole', id: p.uid, doc: { status: p.status, ticket_id: p.ticket?.id ?? null, repair_history: p.repair_history ?? [], last_inspected: p.last_inspected ?? null, fixture_type: p.fixture_type } });
    for (const h of p.repair_history ?? []) noteId(h.ticket_id);
    if (p.ticket) {
      noteId(p.ticket.id);
      const t = tickets.get(p.ticket.id) ?? { ...p.ticket, pole_uids: p.ticket.pole_uids ?? [p.uid], kind: 'pole', reports: [] };
      tickets.set(t.id, t);
    }
  }
  for (const f of data.locationTickets?.features ?? []) {
    noteId(f.properties.id);
    tickets.set(f.properties.id, { ...f.properties, kind: 'location', position: f.geometry.coordinates, pole_uids: [], reports: [] });
  }
  for (const s of data.citizenReports ?? []) {
    tickets.get(s.ticket_id)?.reports.push(s.id);
    docs.push({ kind: 'report', id: s.id, doc: {
      id: s.id, reporter_id: s.reporter_id, category: s.category, uid: s.uid, position: s.uid ? null : s.spot,
      note: '', source: s.source, created_at: s.created_at, ticket_id: s.ticket_id, noticed: s.noticed,
      photo: s.photo ? { ...s.photo } : null,
      device: s.device_location ? { position: s.device_location.position, accuracy_m: s.device_location.accuracy_m } : null,
      simulated: true,
    } });
  }
  for (const t of tickets.values()) docs.push({ kind: 'ticket', id: t.id, doc: t });
  for (const r of data.reporters ?? []) {
    const { mine, ...rest } = r; // eslint-disable-line no-unused-vars
    docs.push({ kind: 'reporter', id: r.id, doc: rest });
  }
  docs.push({ kind: 'setting', id: 'main', doc: { publicSharing, auditRoute: null } });
  return { docs, maxTicket };
}

function seedStore(store, data, opts) {
  if (store.isSeeded()) return false;
  const { docs, maxTicket } = seedDocs(data, opts);
  store.tx(() => {
    store.writeDocs(docs, 'seed');
    for (const [year, n] of Object.entries(maxTicket)) store.setMeta(`ticket_seq_${year}`, Math.max(n, Number(store.meta(`ticket_seq_${year}`, '0'))));
    store.setMeta('seeded', '1');
  });
  return true;
}

module.exports = { openStore, checkChange, sanitizeDoc, loadDataset, seedDocs, seedStore, KINDS };
