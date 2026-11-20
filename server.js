// igrid: local image grid. One process, one SQLite file, one folder of images.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { processImage } from './lib/ingest.js';
import { fetchBoard } from './lib/pinterest.js';

const VERSION = '0.1.0';
const PORT = Number(process.env.IGRID_PORT || 4747);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.IGRID_DATA || path.join(ROOT, 'data');
const IMAGES = path.join(DATA, 'images');
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY = 80 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

fs.mkdirSync(IMAGES, { recursive: true });

// ---- Storage ---------------------------------------------------------------
const db = new DatabaseSync(path.join(DATA, 'igrid.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    source_url TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    position REAL NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    source_url TEXT,
    image_url TEXT,
    page_title TEXT,
    ext_id TEXT,
    file TEXT NOT NULL,
    mime TEXT,
    w INTEGER, h INTEGER, ow INTEGER, oh INTEGER,
    meta TEXT NOT NULL DEFAULT '{}',
    deleted_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_board ON items(board_id, position);
`);

const now = () => new Date().toISOString();
const q = (sql) => db.prepare(sql);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Exact-duplicate detection: every image carries the hash of its original file.
if (!q(`PRAGMA table_info(items)`).all().some((c) => c.name === 'hash')) db.exec(`ALTER TABLE items ADD COLUMN hash TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS items_hash ON items(board_id, hash)`);
for (const row of q(`SELECT id, file FROM items WHERE hash IS NULL`).all()) {
  try { q(`UPDATE items SET hash = ? WHERE id = ?`).run(sha(fs.readFileSync(path.join(IMAGES, row.file + '.orig'))), row.id); } catch {}
}

// Keep the first copy of each identical file on a board; later copies hand
// over any name, tags or link the first one lacks, then go to the trash.
function dedupeBoard(boardId) {
  const rows = q(`SELECT * FROM items WHERE board_id = ? AND deleted_at IS NULL AND hash IS NOT NULL ORDER BY position, id`).all(boardId);
  const first = new Map();
  let removed = 0;
  for (const r of rows) {
    const keep = first.get(r.hash);
    if (!keep) { first.set(r.hash, r); continue; }
    keep.name = keep.name || r.name;
    keep.source_url = keep.source_url || r.source_url;
    keep.tags = JSON.stringify([...new Set([...JSON.parse(keep.tags), ...JSON.parse(r.tags)])]);
    q(`UPDATE items SET name = ?, source_url = ?, tags = ? WHERE id = ?`).run(keep.name, keep.source_url, keep.tags, keep.id);
    q(`UPDATE items SET deleted_at = ? WHERE id = ?`).run(now(), r.id);
    removed++;
  }
  return removed;
}
for (const b of q(`SELECT id, name FROM boards`).all()) {
  const n = dedupeBoard(b.id);
  if (n) console.log(`dedupe: removed ${n} exact duplicate(s) from "${b.name}"`);
}

// Deleted items stay recoverable for a week, then their files go.
for (const row of q(`SELECT id, file FROM items WHERE deleted_at IS NOT NULL AND deleted_at < ?`).all(new Date(Date.now() - 7 * 864e5).toISOString())) {
  for (const ext of ['webp', 'orig']) fs.rmSync(path.join(IMAGES, `${row.file}.${ext}`), { force: true });
  q(`DELETE FROM items WHERE id = ?`).run(row.id);
}

const itemOut = (r) => ({
  id: r.id, board_id: r.board_id, name: r.name, tags: JSON.parse(r.tags),
  source_url: r.source_url, image_url: r.image_url, page_title: r.page_title,
  file: r.file, w: r.w, h: r.h, ow: r.ow, oh: r.oh, meta: JSON.parse(r.meta), created_at: r.created_at,
});
const boardOut = (r) => ({
  id: r.id, name: r.name, settings: JSON.parse(r.settings), source_url: r.source_url,
  archived: !!r.archived_at, created_at: r.created_at, updated_at: r.updated_at,
});

const getBoard = (id) => q(`SELECT * FROM boards WHERE id = ?`).get(id);
const boardItems = (id) => q(`SELECT * FROM items WHERE board_id = ? AND deleted_at IS NULL ORDER BY position, id`).all(id).map(itemOut);

function listBoards(archived) {
  const rows = q(`SELECT * FROM boards WHERE archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY created_at DESC, id DESC`).all();
  return rows.map((r) => ({
    ...boardOut(r),
    count: q(`SELECT COUNT(*) n FROM items WHERE board_id = ? AND deleted_at IS NULL`).get(r.id).n,
    covers: q(`SELECT file, meta FROM items WHERE board_id = ? AND deleted_at IS NULL ORDER BY position, id LIMIT 4`).all(r.id)
      .map((c) => ({ file: c.file, dom: JSON.parse(c.meta).dom })),
  }));
}

function createBoard(name, sourceUrl = null) {
  const t = now();
  const r = q(`INSERT INTO boards (name, source_url, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(name, sourceUrl, t, t);
  return getBoard(r.lastInsertRowid);
}

const nextPosition = (boardId) => q(`SELECT COALESCE(MAX(position), 0) + 1 p FROM items WHERE board_id = ?`).get(boardId).p;

const existingCopy = (boardId, hash) => q(`SELECT * FROM items WHERE board_id = ? AND hash = ? AND deleted_at IS NULL ORDER BY position, id LIMIT 1`).get(boardId, hash);

async function addItem(boardId, buf, info = {}) {
  const hash = sha(buf);
  let dup = existingCopy(boardId, hash);
  if (dup) return { ...itemOut(dup), duplicate: true };
  const img = await processImage(buf);
  dup = existingCopy(boardId, hash);            // another save may have landed meanwhile
  if (dup) return { ...itemOut(dup), duplicate: true };
  const file = crypto.randomBytes(9).toString('hex');
  fs.writeFileSync(path.join(IMAGES, file + '.webp'), img.view);
  fs.writeFileSync(path.join(IMAGES, file + '.orig'), buf);
  const t = now();
  const r = q(`INSERT INTO items (board_id, position, name, source_url, image_url, page_title, ext_id, file, hash, mime, w, h, ow, oh, meta, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    boardId, info.position ?? nextPosition(boardId), (info.name || '').slice(0, 300),
    info.sourceUrl || null, info.imageUrl || null, (info.pageTitle || '').slice(0, 300) || null, info.extId || null,
    file, hash, img.mime, img.w, img.h, img.ow, img.oh, JSON.stringify(img.meta), t);
  q(`UPDATE boards SET updated_at = ? WHERE id = ?`).run(t, boardId);
  return itemOut(q(`SELECT * FROM items WHERE id = ?`).get(r.lastInsertRowid));
}

// ---- Fetching images on the user's behalf ---------------------------------
async function download(url, referer) {
  const headers = { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
  if (referer && /^https?:/i.test(referer)) headers.Referer = referer;
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`The site answered ${r.status} for that image`);
  const type = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BODY) throw new Error('That image is too large');
  return { buf, type, finalUrl: r.url };
}

// A link to a page rather than an image: use the page's own preview image.
async function resolveImage(url, referer) {
  const first = await download(url, referer);
  if (!/text\/html/i.test(first.type)) return { buf: first.buf, imageUrl: url, pageUrl: null, title: null };
  const html = first.buf.toString('utf8', 0, Math.min(first.buf.length, 600000));
  const meta = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i'));
    return m && (m[0].match(/content=["']([^"']+)["']/i) || [])[1];
  };
  const og = meta('og:image:secure_url') || meta('og:image') || meta('twitter:image');
  if (!og) throw new Error('No image found at that address');
  const imageUrl = new URL(og.replace(/&amp;/g, '&'), first.finalUrl).href;
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
  const second = await download(imageUrl, first.finalUrl);
  return { buf: second.buf, imageUrl, pageUrl: first.finalUrl, title };
}

// ---- Pinterest import jobs --------------------------------------------------
const jobs = new Map();

async function runPinterestImport(job, url, boardId) {
  try {
    job.status = 'reading';
    const pb = await fetchBoard(url, (n, total) => { job.found = n; job.total = total; });
    let board = boardId ? getBoard(boardId) : null;
    if (!board) board = createBoard(pb.name, pb.url);
    job.boardId = board.id; job.boardName = board.name; job.partial = pb.partial;

    const have = new Set(q(`SELECT ext_id FROM items WHERE board_id = ? AND ext_id IS NOT NULL AND deleted_at IS NULL`).all(board.id).map((r) => r.ext_id));
    const todo = pb.pins.filter((p) => !have.has(p.extId));
    job.skipped = pb.pins.length - todo.length;
    job.total = todo.length; job.done = 0; job.failed = 0; job.status = 'saving';

    // Positions are fixed up front so the board keeps Pinterest's order even
    // though downloads finish out of order.
    const base = nextPosition(board.id);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = next++, pin = todo[i];
        try {
          const { buf } = await download(pin.imageUrl, 'https://www.pinterest.com/');
          const saved = await addItem(board.id, buf, { position: base + i, name: pin.name, sourceUrl: pin.sourceUrl, imageUrl: pin.imageUrl, extId: pin.extId });
          if (saved.duplicate) job.dupes++;
        } catch { job.failed++; }
        job.done++;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    job.status = 'done';
  } catch (e) {
    job.status = 'error'; job.error = e.message;
  }
}

// ---- HTTP -------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const send = (res, code, body, headers = {}) => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
};
const fail = (res, code, message) => send(res, code, { error: message });

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJson = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

// Only this app and browser extensions may change data. A web page elsewhere
// cannot post to igrid behind the user's back.
function trusted(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(host)) return false;
  const origin = req.headers.origin;
  if (!origin || req.method === 'GET') return true;
  return origin.startsWith('chrome-extension://') || [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(origin);
}

async function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname, m = req.method;
  if (!trusted(req)) return fail(res, 403, 'Not allowed');
  let x;

  if (p === '/api/ping') return send(res, 200, { app: 'igrid', version: VERSION, extensionPath: path.join(ROOT, 'extension') });

  if (p === '/api/boards' && m === 'GET') return send(res, 200, listBoards(url.searchParams.get('archived') === '1'));
  if (p === '/api/boards' && m === 'POST') {
    const name = String((await readJson(req)).name || '').trim();
    if (!name) return fail(res, 400, 'A board needs a name');
    return send(res, 201, boardOut(createBoard(name.slice(0, 120))));
  }

  if ((x = p.match(/^\/api\/boards\/(\d+)$/))) {
    const board = getBoard(+x[1]);
    if (!board) return fail(res, 404, 'No such board');
    if (m === 'GET') return send(res, 200, { ...boardOut(board), items: boardItems(board.id) });
    if (m === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.name === 'string' && body.name.trim()) q(`UPDATE boards SET name = ? WHERE id = ?`).run(body.name.trim().slice(0, 120), board.id);
      if (typeof body.archived === 'boolean') q(`UPDATE boards SET archived_at = ? WHERE id = ?`).run(body.archived ? now() : null, board.id);
      if (body.settings && typeof body.settings === 'object') {
        q(`UPDATE boards SET settings = ? WHERE id = ?`).run(JSON.stringify({ ...JSON.parse(board.settings), ...body.settings }), board.id);
      }
      return send(res, 200, boardOut(getBoard(board.id)));
    }
  }

  if ((x = p.match(/^\/api\/boards\/(\d+)\/items$/)) && m === 'POST') {
    const board = getBoard(+x[1]);
    if (!board) return fail(res, 404, 'No such board');
    const type = req.headers['content-type'] || '';
    try {
      if (/application\/json/i.test(type)) {
        const body = await readJson(req);
        if (!body.url) return fail(res, 400, 'No image address given');
        const got = await resolveImage(String(body.url), body.source);
        const item = await addItem(board.id, got.buf, {
          imageUrl: got.imageUrl.startsWith('data:') ? null : got.imageUrl,
          sourceUrl: body.source || got.pageUrl || (got.imageUrl.startsWith('data:') ? null : got.imageUrl),
          pageTitle: body.title || got.title, name: body.name,
        });
        return send(res, item.duplicate ? 200 : 201, item);
      }
      const buf = await readBody(req);
      if (!buf.length) return fail(res, 400, 'Empty upload');
      const sp = url.searchParams;
      const item = await addItem(board.id, buf, {
        imageUrl: sp.get('image_url'), sourceUrl: sp.get('source') || sp.get('image_url'),
        pageTitle: sp.get('title'), name: sp.get('name'),
      });
      return send(res, item.duplicate ? 200 : 201, item);
    } catch (e) {
      return fail(res, 422, e.message || 'Could not save that image');
    }
  }

  if ((x = p.match(/^\/api\/boards\/(\d+)\/order$/)) && m === 'PUT') {
    const ids = (await readJson(req)).ids;
    if (!Array.isArray(ids)) return fail(res, 400, 'ids required');
    db.exec('BEGIN');
    try {
      const st = q(`UPDATE items SET position = ? WHERE id = ? AND board_id = ?`);
      ids.forEach((id, i) => st.run(i + 1, id, +x[1]));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return send(res, 200, { ok: true });
  }

  if ((x = p.match(/^\/api\/items\/(\d+)(\/restore)?$/))) {
    const row = q(`SELECT * FROM items WHERE id = ?`).get(+x[1]);
    if (!row) return fail(res, 404, 'No such item');
    if (x[2] && m === 'POST') { q(`UPDATE items SET deleted_at = NULL WHERE id = ?`).run(row.id); return send(res, 200, itemOut({ ...row, deleted_at: null })); }
    if (m === 'DELETE') { q(`UPDATE items SET deleted_at = ? WHERE id = ?`).run(now(), row.id); return send(res, 200, { ok: true }); }
    if (m === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.name === 'string') q(`UPDATE items SET name = ? WHERE id = ?`).run(body.name.trim().slice(0, 300), row.id);
      if (Array.isArray(body.tags)) {
        const tags = [...new Set(body.tags.map((t) => String(t).trim().replace(/^#/, '').toLowerCase()).filter(Boolean))].slice(0, 50);
        q(`UPDATE items SET tags = ? WHERE id = ?`).run(JSON.stringify(tags), row.id);
      }
      if (typeof body.source_url === 'string') q(`UPDATE items SET source_url = ? WHERE id = ?`).run(body.source_url.trim() || null, row.id);
      if (Number.isInteger(body.board_id) && body.board_id !== row.board_id && getBoard(body.board_id)) {
        q(`UPDATE items SET board_id = ?, position = ? WHERE id = ?`).run(body.board_id, nextPosition(body.board_id), row.id);
      }
      return send(res, 200, itemOut(q(`SELECT * FROM items WHERE id = ?`).get(row.id)));
    }
  }

  if (p === '/api/search' && m === 'GET') {
    const tokens = (url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!tokens.length) return send(res, 200, []);
    const where = tokens.map(() => `(lower(i.name) LIKE ? OR lower(i.tags) LIKE ? OR lower(COALESCE(i.page_title,'')) LIKE ? OR lower(COALESCE(i.source_url,'')) LIKE ?)`).join(' AND ');
    const args = tokens.flatMap((t) => Array(4).fill('%' + t.replace(/[%_]/g, '') + '%'));
    const rows = q(`SELECT i.*, b.name AS board_name FROM items i JOIN boards b ON b.id = i.board_id
                    WHERE i.deleted_at IS NULL AND b.archived_at IS NULL AND ${where}
                    ORDER BY b.created_at DESC, i.position LIMIT 400`).all(...args);
    return send(res, 200, rows.map((r) => ({ ...itemOut(r), board_name: r.board_name })));
  }

  if (p === '/api/import/pinterest' && m === 'POST') {
    const body = await readJson(req);
    if (!body.url) return fail(res, 400, 'Paste a Pinterest board link');
    const job = { id: crypto.randomBytes(6).toString('hex'), status: 'starting', found: 0, total: 0, done: 0, failed: 0, skipped: 0, dupes: 0 };
    jobs.set(job.id, job);
    runPinterestImport(job, String(body.url), body.boardId || null);
    return send(res, 202, job);
  }
  if ((x = p.match(/^\/api\/jobs\/(\w+)$/)) && m === 'GET') {
    const job = jobs.get(x[1]);
    return job ? send(res, 200, job) : fail(res, 404, 'No such job');
  }

  if ((x = p.match(/^\/img\/([0-9a-f]+)\.(webp|orig)$/)) && m === 'GET') {
    const fp = path.join(IMAGES, `${x[1]}.${x[2]}`);
    if (!fs.existsSync(fp)) return fail(res, 404, 'Missing image');
    let type = 'image/webp';
    if (x[2] === 'orig') type = q(`SELECT mime FROM items WHERE file = ?`).get(x[1])?.mime || 'application/octet-stream';
    return send(res, 200, fs.readFileSync(fp), {
      'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
  }

  if (m === 'GET' && !p.startsWith('/api/')) {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const fp = path.join(PUBLIC, path.normalize(rel));
    if (fp.startsWith(PUBLIC) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      return send(res, 200, fs.readFileSync(fp), { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    }
  }
  return fail(res, 404, 'Not found');
}

http.createServer((req, res) => {
  route(req, res).catch((e) => { console.error(e); if (!res.headersSent) fail(res, 500, e.message || 'Server error'); });
}).listen(PORT, '127.0.0.1', () => console.log(`igrid ${VERSION} at http://localhost:${PORT}  (data in ${DATA})`));
