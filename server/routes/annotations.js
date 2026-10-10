const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { db, REPORT_HIDE_THRESHOLD, VISIBLE, sha256Hex, ipHash, displayNameFor, collectUsers } = require("../db");

// Pagina se identifică prin amprenta adresei (?urlHash=, 64 hex) — varianta nouă, care nu
// trimite adresa. ?url= rămâne doar pentru extensiile încă neactualizate (≤ 0.2.3).
function pageHashFromQuery(query) {
  if (typeof query.urlHash === "string" && /^[0-9a-f]{64}$/.test(query.urlHash)) return query.urlHash;
  if (query.url) return sha256Hex(query.url);
  return null;
}

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

// authorId e SECRETUL autorului — cu el se editează/șterge o adnotare (PATCH/DELETE), deci nu
// iese niciodată în răspunsuri. Public trimitem doar o amprentă SHA-256 a lui: extensia își
// calculează propria amprentă și o compară, ca să știe ce adnotări sunt ale ei. ID-ul e un
// UUID aleator (122 de biți), deci din amprentă nu se poate ghici înapoi.
function authorHash(authorId) {
  return crypto.createHash("sha256").update(String(authorId)).digest("hex").slice(0, 32);
}

// Validarea datelor unei adnotări. Valorile ajung în pagina FIECĂRUI vizitator (culori și
// poziții în stiluri CSS, coordonate în desene SVG) — o „culoare” ca `red; background:url(...)`
// ar face browserele lor să acceseze o adresă străină. Acceptăm doar forme cunoscute.
const TYPES = new Set(["pen", "spray", "shape", "text", "bubble", "link", "video_bubble"]);
const SHAPES = new Set(["circle", "rectangle", "square", "triangle", "diamond", "star", "arrow"]);
const NUM_FIELDS = ["x", "y", "x1", "y1", "x2", "y2", "dx", "dy", "rotate", "scale", "strokeWidth", "xPct", "yPct", "timestamp", "duration"];
const MAX_DATA_CHARS = 300_000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e7;
const isStr = (v, max) => typeof v === "string" && v.length <= max;

function validateAnnotation(type, data) {
  if (!TYPES.has(type)) return "Tip de adnotare necunoscut";
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Date lipsă";
  if (JSON.stringify(data).length > MAX_DATA_CHARS) return "Adnotare prea mare";
  for (const f of NUM_FIELDS) if (data[f] !== undefined && !isNum(data[f])) return `Câmp invalid: ${f}`;
  if (data.color !== undefined && !/^#[0-9a-fA-F]{3,8}$/.test(String(data.color))) return "Culoare invalidă";
  if (data.text !== undefined && !isStr(data.text, 2000)) return "Text prea lung";
  if (data.label !== undefined && !isStr(data.label, 300)) return "Etichetă prea lungă";
  if (data.url !== undefined && !isStr(data.url, 2000)) return "Link prea lung";
  if (data.shape !== undefined && !SHAPES.has(data.shape)) return "Formă necunoscută";
  if (data.d !== undefined && !(isStr(data.d, 250_000) && /^[MLQCZmlqcz0-9.,\s+\-eE]*$/.test(data.d))) return "Desen invalid";
  if (data.dots !== undefined) {
    if (!Array.isArray(data.dots) || data.dots.length > 6000) return "Spray invalid";
    if (!data.dots.every((p) => p && isNum(p.cx) && isNum(p.cy) && isNum(p.r))) return "Spray invalid";
  }
  if (data.origin !== undefined && !(data.origin && isNum(data.origin.x) && isNum(data.origin.y))) return "Origine invalidă";
  if (data.videoRange !== undefined && data.videoRange !== null) {
    if (!(isNum(data.videoRange.start) && isNum(data.videoRange.end))) return "Interval video invalid";
  }
  if (data.anchor !== undefined && data.anchor !== null) {
    const a = data.anchor;
    if (typeof a !== "object" || !isStr(a.selector, 3000) || !isNum(a.offsetXPct) || !isNum(a.offsetYPct)) return "Ancoră invalidă";
    if (a.w !== undefined && !isNum(a.w)) return "Ancoră invalidă";
    if (a.src !== undefined && !isStr(a.src, 3000)) return "Ancoră invalidă";
  }
  return null;
}

function serialize(row) {
  return {
    id: row.id,
    url: row.url,
    type: row.type,
    data: JSON.parse(row.data),
    authorHash: authorHash(row.author_id),
    authorName: displayNameFor(row.author_hash || authorHash(row.author_id)), // null = fără nume ales
    votes: row.votes,
    reports: row.reports,
    createdAt: row.created_at,
  };
}

// GET /api/annotations?urlHash=<amprentă>[&minVotes=N]
// Fără minVotes se trimit toate (și cele cu scor negativ): extensia decide ce arată — dacă
// pe pagină sunt cel mult 10, pe toate; altfel primele 10 din clasament (vezi refreshRanking).
router.get("/", (req, res) => {
  const { minVotes } = req.query;
  const urlHash = pageHashFromQuery(req.query);
  if (!urlHash) return res.status(400).json({ error: "Missing urlHash (or url) query param" });

  const min = minVotes !== undefined && Number.isFinite(Number(minVotes)) ? Number(minVotes) : -Number.MAX_SAFE_INTEGER;

  const rows = db
    .prepare(
      `SELECT * FROM annotations
       WHERE url_hash = ? AND ${VISIBLE} AND votes >= ?
       ORDER BY created_at ASC`
    )
    .all(urlHash, min);

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

// GET /api/annotations/stats?urlHash=<sha256> — câte adnotări sunt, pe tipuri: global (toate
// paginile) și, dacă e dat `url`, pentru pagina aceea. Cele ascunse prin raportări nu se
// numără. Partea globală e ținută în cache 30s (se cere la fiecare deschidere a contorului).
const STATS_CACHE_TTL_MS = 30000;
let globalStatsCache = null;

function countByType(where, params) {
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) AS n,
              SUM(CASE WHEN type != 'link' AND json_extract(data, '$.url') LIKE 'http%' THEN 1 ELSE 0 END) AS linked
       FROM annotations WHERE ${VISIBLE} ${where} GROUP BY type`
    )
    .all(...params);
  const byType = {};
  let total = 0;
  let withLink = 0;
  for (const r of rows) {
    byType[r.type] = r.n;
    total += r.n;
    withLink += r.linked || 0;
  }
  return { total, byType, withLink };
}

router.get("/stats", (req, res) => {
  if (!globalStatsCache || globalStatsCache.expiresAt < Date.now()) {
    const global = countByType("", []);
    global.pages = db
      .prepare(`SELECT COUNT(DISTINCT url) AS n FROM annotations WHERE ${VISIBLE}`)
      .get().n;
    global.users = collectUsers().size; // cine a scris, votat, raportat sau și-a ales un nume
    globalStatsCache = { data: global, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
  }
  const out = { global: globalStatsCache.data };
  const urlHash = pageHashFromQuery(req.query);
  if (urlHash) out.page = countByType("AND url_hash = ?", [urlHash]);
  res.json(out);
});

router.get("/top", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

  const cached = topCache.get(limit);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.data);
  }

  const rows = db
    .prepare(
      `SELECT * FROM annotations
       WHERE ${VISIBLE} AND votes > 0
       ORDER BY votes DESC, created_at ASC
       LIMIT ?`
    )
    .all(limit);

  const data = rows.map(serialize);
  topCache.set(limit, { data, expiresAt: Date.now() + TOP_CACHE_TTL_MS });
  res.json(data);
});

// GET /api/annotations/by-author/:hash — profilul public al unui utilizator: adnotările lui
// vizibile, de pe toate paginile, cele mai votate primele (la egalitate, cele mai vechi).
// Se caută după amprenta publică (authorHash), niciodată după secretul authorId.
router.get("/by-author/:hash", (req, res) => {
  const { hash } = req.params;
  if (!/^[0-9a-f]{32}$/.test(hash)) return res.status(400).json({ error: "Utilizator invalid" });
  const rows = db
    .prepare(
      `SELECT * FROM annotations WHERE author_hash = ? AND ${VISIBLE}
       ORDER BY votes DESC, created_at ASC LIMIT 500`
    )
    .all(hash);
  res.json(rows.map(serialize));
});

// POST /api/annotations/mine  { authorId } — toate adnotările autorului, de pe toate paginile,
// cele mai noi primele (panoul „Ale mele → Toate”). POST, nu GET: authorId e secretul de
// editare și nu trebuie să ajungă în adrese sau loguri. Fără cele scoase de moderator.
router.post("/mine", (req, res) => {
  const { authorId } = req.body || {};
  if (!isStr(authorId, 100) || !authorId) return res.status(400).json({ error: "Missing authorId" });
  const rows = db
    .prepare(
      `SELECT * FROM annotations WHERE author_id = ? AND removed_at IS NULL
       ORDER BY created_at DESC LIMIT 500`
    )
    .all(authorId);
  res.json(rows.map(serialize));
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
  const invalid = validateAnnotation(type, data);
  if (invalid) return res.status(400).json({ error: invalid });
  if (!isStr(url, 3000) || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Adresă de pagină invalidă" });

  const id = crypto.randomUUID();
  const createdAt = Date.now();

  db.prepare(
    `INSERT INTO annotations (id, url, url_hash, type, data, author_id, author_hash, votes, reports, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(id, url, sha256Hex(url), type, JSON.stringify(data), authorId, authorHash(authorId), createdAt);

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

  const row = db.prepare("SELECT * FROM annotations WHERE id = ? AND removed_at IS NULL").get(id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.author_id !== authorId) {
    return res.status(403).json({ error: "Only the original author can edit this annotation" });
  }

  const data = { ...JSON.parse(row.data), ...patch };
  if (hasUnsafeLink(data)) {
    return res.status(400).json({ error: "Link must start with http:// or https://" });
  }
  const invalid = validateAnnotation(row.type, data);
  if (invalid) return res.status(400).json({ error: invalid });
  db.prepare("UPDATE annotations SET data = ? WHERE id = ?").run(JSON.stringify(data), id);

  const updated = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  res.json(serialize(updated));
});

// DELETE /api/annotations/:id  { authorId }  -- only the original author can delete
router.delete("/:id", writeLimiter, (req, res) => {
  const { id } = req.params;
  const { authorId } = req.body || {};

  // o adnotare scoasă de moderator nu mai poate fi ștearsă de autor — rămâne ca evidență
  const row = db.prepare("SELECT * FROM annotations WHERE id = ? AND removed_at IS NULL").get(id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.author_id !== authorId) {
    return res.status(403).json({ error: "Only the original author can delete this annotation" });
  }

  db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
  db.prepare("DELETE FROM votes WHERE annotation_id = ?").run(id);
  db.prepare("DELETE FROM reports WHERE annotation_id = ?").run(id);
  res.status(204).end();
});

// POST /api/annotations/:id/vote  { voterId, direction: "up" | "down" }
// Un vot pe adnotare per votant; autorul nu-și poate vota propriile adnotări. Pe aceeași
// adresă IP (amprentată) se acceptă cel mult MAX_VOTES_PER_IP votanți diferiți — destul
// pentru o familie / colegi / CGNAT (Digi pune mulți clienți pe aceeași IP), dar nu cât să
// umfli o adnotare cu ID-uri inventate de pe același calculator. Votul repetat în aceeași
// direcție nu schimbă nimic; în direcția opusă își schimbă sensul.
const MAX_VOTES_PER_IP = 5;

router.post("/:id/vote", writeLimiter, (req, res) => {
  const { id } = req.params;
  const { voterId, direction } = req.body || {};
  if (!isStr(voterId, 100) || !voterId || !["up", "down"].includes(direction)) {
    return res.status(400).json({ error: "Missing voterId or invalid direction" });
  }

  const annotation = db.prepare(`SELECT * FROM annotations WHERE id = ? AND removed_at IS NULL`).get(id);
  if (!annotation) return res.status(404).json({ error: "Not found" });
  if (annotation.author_id === voterId) {
    return res.status(403).json({ error: "Nu-ți poți vota propriile adnotări." });
  }

  const ip = ipHash(req.ip);
  const existing = db.prepare("SELECT * FROM votes WHERE annotation_id = ? AND voter_id = ?").get(id, voterId);
  const delta = direction === "up" ? 1 : -1;

  if (!existing) {
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM votes WHERE annotation_id = ? AND ip_hash = ?")
      .get(id, ip);
    if (n >= MAX_VOTES_PER_IP) {
      return res.status(429).json({ error: "Prea multe voturi de pe aceeași conexiune pentru adnotarea asta." });
    }
    db.prepare("INSERT INTO votes (annotation_id, voter_id, direction, ip_hash) VALUES (?, ?, ?, ?)").run(
      id,
      voterId,
      direction,
      ip
    );
    db.prepare("UPDATE annotations SET votes = votes + ? WHERE id = ?").run(delta, id);
  } else if (existing.direction !== direction) {
    db.prepare("UPDATE votes SET direction = ? WHERE annotation_id = ? AND voter_id = ?").run(direction, id, voterId);
    db.prepare("UPDATE annotations SET votes = votes + ? WHERE id = ?").run(delta * 2, id);
  }

  const row = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  res.json(serialize(row));
});

// POST /api/annotations/:id/report  { reporterId, reason, details?, goodFaith: true }
// Notificare motivată (DSA art. 16): motivul din listă, detalii opționale și confirmarea că
// raportarea e făcută cu bună-credință. O singură raportare pe adnotare per raportor ȘI per
// adresă IP; la REPORT_HIDE_THRESHOLD raportări distincte adnotarea se ascunde automat,
// până o verifică un administrator (vezi routes/admin.js).
const REPORT_REASONS = new Set(["illegal", "hate", "harassment", "personal_data", "sexual", "spam", "copyright", "other"]);

router.post("/:id/report", writeLimiter, (req, res) => {
  const { id } = req.params;
  const { reporterId, reason, details, goodFaith } = req.body || {};
  if (!isStr(reporterId, 100) || !reporterId) return res.status(400).json({ error: "Missing reporterId" });
  if (!REPORT_REASONS.has(reason)) return res.status(400).json({ error: "Alege un motiv al raportării" });
  if (details !== undefined && !isStr(details, 1000)) return res.status(400).json({ error: "Detalii prea lungi" });
  if (goodFaith !== true) return res.status(400).json({ error: "Confirmă că raportarea e făcută cu bună-credință" });

  const annotation = db.prepare(`SELECT * FROM annotations WHERE id = ? AND removed_at IS NULL`).get(id);
  if (!annotation) return res.status(404).json({ error: "Not found" });

  const ip = ipHash(req.ip);
  const existing = db
    .prepare("SELECT 1 FROM reports WHERE annotation_id = ? AND (reporter_id = ? OR ip_hash = ?) LIMIT 1")
    .get(id, reporterId, ip);

  if (!existing) {
    db.prepare(
      "INSERT INTO reports (annotation_id, reporter_id, reason, details, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, reporterId, reason, details ? String(details) : null, Date.now(), ip);
    db.prepare("UPDATE annotations SET reports = reports + 1 WHERE id = ?").run(id);
  }

  const row = db.prepare("SELECT * FROM annotations WHERE id = ?").get(id);
  res.json(serialize(row));
});

module.exports = router;
