// Chat pe pagină: o cameră pentru fiecare pagină (după amprenta adresei, url_hash — serverul nu
// află adresa). Citesc toți; scriu doar cei cu cont (nume + parolă). Doar text, ≤ 300 de
// caractere. Mesajele se șterg după 24 de ore; cele scoase de moderator rămân ca evidență, ca
// adnotările, cel mult 2 ani. „Cine e aici” = cei care au chatul deschis pe pagină acum.
const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { db, VISIBLE: ANN_VISIBLE, sha256Hex, ipHash, displayNameFor, hasAccount } = require("../db");

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    url_hash TEXT NOT NULL,
    author_hash TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reports INTEGER NOT NULL DEFAULT 0,
    removed_at INTEGER,
    removed_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(url_hash, created_at);
  CREATE TABLE IF NOT EXISTS chat_reports (
    message_id TEXT NOT NULL,
    reporter_hash TEXT NOT NULL,
    ip_hash TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, reporter_hash)
  );
  CREATE TABLE IF NOT EXISTS chat_presence (
    url_hash TEXT NOT NULL,
    author_hash TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (url_hash, author_hash)
  );
  CREATE TABLE IF NOT EXISTS chat_blocks (
    author_hash TEXT PRIMARY KEY,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
`);
// Vizionare împreună: cât ai chatul deschis, extensia trimite și minutul video-ului de pe pagină
// (video_t, pauză, ora la care l-a citit serverul) și pe cine urmărești (follows = amprenta lui).
// Totul stă doar în rândul „ești aici”, deci dispare odată cu el (cel mult 2 minute).
for (const [col, type] of [["video_t", "REAL"], ["video_paused", "INTEGER"], ["video_at", "INTEGER"], ["follows", "TEXT"]]) {
  const has = db.prepare("SELECT 1 FROM pragma_table_info('chat_presence') WHERE name = ?").get(col);
  if (!has) db.exec(`ALTER TABLE chat_presence ADD COLUMN ${col} ${type}`);
}

const MAX_LEN = 300;
const KEEP_MS = 24 * 60 * 60 * 1000;
const REMOVED_KEEP_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const PRESENCE_MS = 30 * 1000; // „aici” = a întrebat de mesaje în ultimele 30 s
const HIDE_AT_REPORTS = 3; // un mesaj raportat de 3 oameni se ascunde până îl vede moderatorul
const REPORT_REASONS = new Set(["illegal", "hate", "harassment", "personal_data", "sexual", "spam", "copyright", "other"]);

const hashOf = (authorId) => sha256Hex(authorId).slice(0, 32);
const validId = (v) => typeof v === "string" && v.length >= 8 && v.length <= 100;
const validUrlHash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const validHash = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
const validVideo = (v) => v && typeof v === "object" && Number.isFinite(v.t) && v.t >= 0 && v.t < 1e7;

// Mesaje noi: cel mult 6 pe minut per conexiune (pe lângă limita generală a serverului).
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Scrii prea repede — mai așteaptă puțin." },
});
const reportLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

function purgeChat() {
  const now = Date.now();
  db.prepare("DELETE FROM chat_messages WHERE removed_at IS NULL AND created_at < ?").run(now - KEEP_MS);
  db.prepare("DELETE FROM chat_messages WHERE removed_at IS NOT NULL AND removed_at < ?").run(now - REMOVED_KEEP_MS);
  db.prepare("DELETE FROM chat_reports WHERE message_id NOT IN (SELECT id FROM chat_messages)").run();
  db.prepare("DELETE FROM chat_presence WHERE seen_at < ?").run(now - PRESENCE_MS * 4);
}
purgeChat();
setInterval(purgeChat, 60 * 1000).unref(); // la minut: „ești aici” dispare în cel mult 2 minute

const VISIBLE = `removed_at IS NULL AND reports < ${HIDE_AT_REPORTS}`;
function serialize(m) {
  return { id: m.id, authorHash: m.author_hash, authorName: displayNameFor(m.author_hash), text: m.text, createdAt: m.created_at };
}

// Câți au chatul deschis pe pagină acum (fără plafonul de 50 din lista `here`).
// `exclude` = o amprentă publică de scos din numărătoare (rândul tău rămas după ce ai închis chatul).
function countHere(urlHash, now, exclude = "") {
  return db
    .prepare("SELECT COUNT(*) AS n FROM chat_presence WHERE url_hash = ? AND seen_at > ? AND author_hash != ?")
    .get(urlHash, now - PRESENCE_MS, exclude).n;
}

// POST /api/chat/here  { urlHash, exclude? } — doar numărul celor din chat, pentru cifra de pe
// butonul de chat cât chatul e închis. Nu te marchează „aici”.
router.post("/here", (req, res) => {
  const { urlHash, exclude } = req.body || {};
  if (!validUrlHash(urlHash)) return res.status(400).json({ error: "urlHash invalid" });
  res.json({ count: countHere(urlHash, Date.now(), validHash(exclude) ? exclude : "") });
});

// POST /api/chat/poll  { urlHash, authorId?, since?, video?: {t, paused}, follows? } — mesajele camerei (ultimele 24 h, cel mult
// 100; cu `since`, doar cele mai noi) + cine e aici. POST ca să nu apară ID-ul în jurnale/URL.
// Cu authorId, te marchează „aici” (doar cât ai chatul deschis — extensia întreabă doar atunci).
router.post("/poll", (req, res) => {
  const { urlHash, authorId, since, video, follows } = req.body || {};
  if (!validUrlHash(urlHash)) return res.status(400).json({ error: "urlHash invalid" });
  const now = Date.now();
  let me = null;
  if (validId(authorId)) {
    me = hashOf(authorId);
    const v = validVideo(video) ? video : null;
    const f = validHash(follows) && follows !== me ? follows : null;
    db.prepare(
      `INSERT INTO chat_presence (url_hash, author_hash, seen_at, video_t, video_paused, video_at, follows) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url_hash, author_hash) DO UPDATE SET seen_at = excluded.seen_at, video_t = excluded.video_t,
         video_paused = excluded.video_paused, video_at = excluded.video_at, follows = excluded.follows`
    ).run(urlHash, me, now, v ? v.t : null, v ? (v.paused ? 1 : 0) : null, v ? now : null, f);
  }
  const after = Number.isFinite(Number(since)) && Number(since) > 0 ? Number(since) : now - KEEP_MS;
  const rows = db
    .prepare(`SELECT * FROM chat_messages WHERE url_hash = ? AND created_at > ? AND ${VISIBLE} ORDER BY created_at DESC LIMIT 100`)
    .all(urlHash, Math.max(after, now - KEEP_MS))
    .reverse();
  // id-urile vizibile acum — ca extensia să scoată mesajele șterse/ascunse între timp
  const alive = db
    .prepare(`SELECT id FROM chat_messages WHERE url_hash = ? AND created_at > ? AND ${VISIBLE}`)
    .all(urlHash, now - KEEP_MS)
    .map((r) => r.id);
  const present = db
    .prepare("SELECT * FROM chat_presence WHERE url_hash = ? AND seen_at > ? ORDER BY seen_at DESC LIMIT 50")
    .all(urlHash, now - PRESENCE_MS);
  const followers = new Map();
  present.forEach((r) => r.follows && followers.set(r.follows, (followers.get(r.follows) || 0) + 1));
  const here = present.map((r) => ({
    hash: r.author_hash,
    name: displayNameFor(r.author_hash),
    video: r.video_at ? { t: r.video_t, paused: !!r.video_paused, at: r.video_at } : null,
    follows: r.follows || null,
    followers: followers.get(r.author_hash) || 0,
  }));
  const hereCount = countHere(urlHash, now);
  // „Versiunea” adnotărilor paginii (câte + cea mai nouă): când se schimbă, extensia își
  // reîncarcă adnotările — așa le vezi pe ale celorlalți fără refresh, cât ai chatul deschis.
  const ann = db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS m FROM annotations WHERE url_hash = ? AND ${ANN_VISIBLE}`).get(urlHash);
  const annRev = `${ann.n}:${ann.m || 0}`;
  const canWrite = !!me && hasAccount(me) && !db.prepare("SELECT 1 FROM chat_blocks WHERE author_hash = ?").get(me);
  res.json({ messages: rows.map(serialize), alive, here, hereCount, annRev, canWrite, blocked: !!me && !!db.prepare("SELECT 1 FROM chat_blocks WHERE author_hash = ?").get(me), now });
});

// POST /api/chat  { urlHash, authorId, text } — scrie un mesaj (doar cu cont, dacă nu ești blocat).
router.post("/", sendLimiter, (req, res) => {
  const { urlHash, authorId } = req.body || {};
  const text = typeof req.body?.text === "string" ? req.body.text.replace(/\s+/g, " ").trim() : "";
  if (!validUrlHash(urlHash) || !validId(authorId)) return res.status(400).json({ error: "Cerere invalidă" });
  if (!text) return res.status(400).json({ error: "Scrie un mesaj" });
  if (text.length > MAX_LEN) return res.status(400).json({ error: `Cel mult ${MAX_LEN} de caractere` });
  const me = hashOf(authorId);
  if (!hasAccount(me)) return res.status(403).json({ error: "Chatul e doar pentru cei cu cont.", needAccount: true });
  if (db.prepare("SELECT 1 FROM chat_blocks WHERE author_hash = ?").get(me)) {
    return res.status(403).json({ error: "Nu mai poți scrie în chat (blocat de moderator)." });
  }
  // cel mult un mesaj la 2 secunde de la același om (pe lângă limita pe conexiune)
  const last = db.prepare("SELECT MAX(created_at) AS t FROM chat_messages WHERE author_hash = ?").get(me).t;
  if (last && Date.now() - last < 2000) return res.status(429).json({ error: "Scrii prea repede — mai așteaptă puțin." });
  const row = { id: crypto.randomUUID(), url_hash: urlHash, author_hash: me, text, created_at: Date.now() };
  db.prepare("INSERT INTO chat_messages (id, url_hash, author_hash, text, created_at) VALUES (?, ?, ?, ?, ?)").run(
    row.id,
    row.url_hash,
    row.author_hash,
    row.text,
    row.created_at
  );
  res.status(201).json(serialize(row));
});

// DELETE /api/chat/:id  { authorId } — autorul își șterge mesajul.
router.delete("/:id", (req, res) => {
  const { authorId } = req.body || {};
  if (!validId(authorId)) return res.status(400).json({ error: "Missing authorId" });
  const r = db.prepare("DELETE FROM chat_messages WHERE id = ? AND author_hash = ? AND removed_at IS NULL").run(req.params.id, hashOf(authorId));
  if (!r.changes) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM chat_reports WHERE message_id = ?").run(req.params.id);
  res.status(204).end();
});

// POST /api/chat/:id/report  { reporterId, reason } — raportare (oricine, o dată per mesaj și
// per conexiune). La HIDE_AT_REPORTS raportări mesajul se ascunde până la verificare.
router.post("/:id/report", reportLimiter, (req, res) => {
  const { reporterId, reason } = req.body || {};
  if (!validId(reporterId)) return res.status(400).json({ error: "Missing reporterId" });
  if (!REPORT_REASONS.has(reason)) return res.status(400).json({ error: "Alege un motiv" });
  const msg = db.prepare("SELECT * FROM chat_messages WHERE id = ? AND removed_at IS NULL").get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Not found" });
  const me = hashOf(reporterId);
  if (msg.author_hash === me) return res.status(403).json({ error: "Nu îți poți raporta propriul mesaj." });
  const ip = ipHash(req.ip);
  const dup = db.prepare("SELECT 1 FROM chat_reports WHERE message_id = ? AND (reporter_hash = ? OR ip_hash = ?)").get(msg.id, me, ip);
  if (dup) return res.json({ ok: true, already: true });
  db.prepare("INSERT INTO chat_reports (message_id, reporter_hash, ip_hash, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(
    msg.id,
    me,
    ip,
    reason,
    Date.now()
  );
  db.prepare("UPDATE chat_messages SET reports = reports + 1 WHERE id = ?").run(msg.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.HIDE_AT_REPORTS = HIDE_AT_REPORTS;
