const express = require("express");
const rateLimit = require("express-rate-limit");
const { db, REPORT_HIDE_THRESHOLD } = require("../db");

const router = express.Router();

// Limită proprie, mai strictă, doar pentru scrieri (creare/editare/ștergere/vot/
// raportare) — peste limita generală din server.js. Un utilizator normal nu se
// apropie de 20/minut din interacțiune reală; un script de spam, da.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Prea multe acțiuni la rând — încearcă din nou peste un minut." },
});

// Linkurile din adnotări trebuie să fie http(s) — extensia verifică deja asta în
// formular, dar oricine poate trimite direct la API un `javascript:...`, care ar
// rula cod pe pagina celui care dă click. Verificăm aici, pe datele finale.
// Șirul gol e permis: înseamnă „link scos” de pe o adnotare (orice tip poate avea link atașat).
function hasUnsafeLink(data) {
  return data && data.url !== undefined && data.url !== "" && !/^https?:\/\//i.test(String(data.url));
}

function serialize(row) {
  return {
    id: row.id,
    url: row.url,
    type: row.type,
    data: JSON.parse(row.data),
    authorId: row.author_id,
    votes: row.votes,
    reports: row.reports,
    createdAt: row.created_at,
  };
}

// GET /api/annotations?url=<page url>&minVotes=0
router.get("/", (req, res) => {
  const { url, minVotes } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url query param" });

  const min = Number.isFinite(Number(minVotes)) ? Number(minVotes) : 0;

  const rows = db
    .prepare(
      `SELECT * FROM annotations
       WHERE url = ? AND reports < ? AND votes >= ?
       ORDER BY created_at ASC`
    )
    .all(url, REPORT_HIDE_THRESHOLD, min);

  res.json(rows.map(serialize));
});

// GET /api/annotations/top?limit=10 — cele mai votate adnotări de pe TOATE paginile
// (nu doar pagina curentă), pentru panoul global "Top". Cere măcar 1 vot, ca locurile
// goale să rămână goale în loc să se umple cu adnotări proaspete fără niciun like.
//
// Cache în memorie, per `limit` cerut, 10 secunde — fiecare tab deschis cu extensia
// cere asta la fiecare 30s (refreshGlobalTop), automat, indiferent dacă cineva se
// uită sau nu. Cu multe tab-uri deschise simultan (campanie de promovare = exact
// scenariul), rezultatul e IDENTIC pentru toată lumea și nu are rost să lovim baza
// de date de fiecare dată — 10s de întârziere pe un clasament global e nesesizabil.
const topCache = new Map(); // limit -> { data, expiresAt }
const TOP_CACHE_TTL_MS = 10_000;

router.get("/top", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

  const cached = topCache.get(limit);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.data);
  }

  const rows = db
    .prepare(
      `SELECT * FROM annotations
       WHERE reports < ? AND votes > 0
       ORDER BY votes DESC, created_at ASC
       LIMIT ?`
    )
    .all(REPORT_HIDE_THRESHOLD, limit);

  const data = rows.map(serialize);
  topCache.set(limit, { data, expiresAt: Date.now() + TOP_CACHE_TTL_MS });
  res.json(data);
});

// POST /api/annotations  { url, type, data, authorId }
router.post("/", writeLimiter, (req, res) => {
  const { url, type, data, authorId } = req.body || {};
  if (!url || !type || !data || !authorId) {
    return res.status(400).json({ error: "Missing url, type, data or authorId" });
  }
  if (hasUnsafeLink(data)) {
    return res.status(400).json({ error: "Link must start with http:// or https://" });
  }

  const id = crypto.randomUUID();
  const createdAt = Date.now();

  db.prepare(
    `INSERT INTO annotations (id, url, type, data, author_id, votes, reports, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(id, url, type, JSON.stringify(data), authorId, createdAt);

  const row = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  res.status(201).json(serialize(row));
});

// PATCH /api/annotations/:id  { authorId, patch: { ...câmpuri de suprascris în data } }
// Folosit atât pentru mutare (patch: {x,y}) cât și pentru editare text/link (patch: {text} sau {url,label}).
// Doar autorul original poate edita.
router.patch("/:id", writeLimiter, (req, res) => {
  const { id } = req.params;
  const { authorId, patch } = req.body || {};
  if (!authorId || !patch || typeof patch !== "object") {
    return res.status(400).json({ error: "Missing authorId or patch" });
  }

  const row = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.author_id !== authorId) {
    return res.status(403).json({ error: "Only the original author can edit this annotation" });
  }

  const data = { ...JSON.parse(row.data), ...patch };
  if (hasUnsafeLink(data)) {
    return res.status(400).json({ error: "Link must start with http:// or https://" });
  }
  db.prepare("UPDATE annotations SET data = ? WHERE id = ?").run(JSON.stringify(data), id);

  const updated = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  res.json(serialize(updated));
});

// DELETE /api/annotations/:id  { authorId }  -- only the original author can delete
router.delete("/:id", writeLimiter, (req, res) => {
  const { id } = req.params;
  const { authorId } = req.body || {};

  const row = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.author_id !== authorId) {
    return res.status(403).json({ error: "Only the original author can delete this annotation" });
  }

  db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
  db.prepare("DELETE FROM votes WHERE annotation_id = ?").run(id);
  db.prepare("DELETE FROM reports WHERE annotation_id = ?").run(id);
  res.status(204).end();
});

// POST /api/annotations/:id/vote  { voterId, direction: 'up'|'down' }
router.post("/:id/vote", writeLimiter, (req, res) => {
  const { id } = req.params;
  const { voterId, direction } = req.body || {};

  if (!voterId || !["up", "down"].includes(direction)) {
    return res.status(400).json({ error: "Missing voterId or invalid direction" });
  }

  const annotation = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  if (!annotation) return res.status(404).json({ error: "Not found" });

  const existing = db
    .prepare("SELECT * FROM votes WHERE annotation_id = ? AND voter_id = ?")
    .get(id, voterId);

  const delta = direction === "up" ? 1 : -1;

  if (!existing) {
    db.prepare(
      "INSERT INTO votes (annotation_id, voter_id, direction) VALUES (?, ?, ?)"
    ).run(id, voterId, direction);
    db.prepare("UPDATE annotations SET votes = votes + ? WHERE id = ?").run(delta, id);
  } else if (existing.direction !== direction) {
    // Switching vote: undo old, apply new (net change of 2).
    db.prepare("UPDATE votes SET direction = ? WHERE annotation_id = ? AND voter_id = ?").run(
      direction,
      id,
      voterId
    );
    db.prepare("UPDATE annotations SET votes = votes + ? WHERE id = ?").run(delta * 2, id);
  }
  // else: same vote repeated, no-op.

  const row = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  res.json(serialize(row));
});

// POST /api/annotations/:id/report  { reporterId }
router.post("/:id/report", writeLimiter, (req, res) => {
  const { id } = req.params;
  const { reporterId } = req.body || {};
  if (!reporterId) return res.status(400).json({ error: "Missing reporterId" });

  const annotation = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  if (!annotation) return res.status(404).json({ error: "Not found" });

  const existing = db
    .prepare("SELECT * FROM reports WHERE annotation_id = ? AND reporter_id = ?")
    .get(id, reporterId);

  if (!existing) {
    db.prepare("INSERT INTO reports (annotation_id, reporter_id) VALUES (?, ?)").run(
      id,
      reporterId
    );
    db.prepare("UPDATE annotations SET reports = reports + 1 WHERE id = ?").run(id);
  }

  const row = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  res.json(serialize(row));
});

module.exports = router;
