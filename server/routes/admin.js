// Moderare (DSA): lista adnotărilor raportate / ascunse / scoase și acțiunile de scoatere și
// restaurare, cu motivul înregistrat. Protejată cu ADMIN_TOKEN (variabilă pe server, trimisă
// ca „Authorization: Bearer …”). Fără ADMIN_TOKEN setat, toată zona răspunde 404.
const crypto = require("node:crypto");
const express = require("express");
const { db, REPORT_HIDE_THRESHOLD, displayNameFor, nameKey } = require("../db");

const router = express.Router();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

router.use((req, res, next) => {
  if (ADMIN_TOKEN.length < 24) return res.status(404).json({ error: "Not found" });
  const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!given || !sameSecret(given, ADMIN_TOKEN)) return res.status(401).json({ error: "Token greșit" });
  next();
});

function adminView(row) {
  const reports = db
    .prepare("SELECT reason, details, created_at FROM reports WHERE annotation_id = ? ORDER BY created_at DESC")
    .all(row.id);
  return {
    id: row.id,
    url: row.url,
    type: row.type,
    data: JSON.parse(row.data),
    votes: row.votes,
    reports: row.reports,
    authorHash: row.author_hash,
    authorName: displayNameFor(row.author_hash),
    hidden: row.reports >= REPORT_HIDE_THRESHOLD,
    removedAt: row.removed_at,
    removedReason: row.removed_reason,
    createdAt: row.created_at,
    reportList: reports.map((r) => ({ reason: r.reason, details: r.details, at: r.created_at })),
  };
}

// GET /api/admin/queue?status=reported|removed — raportate (inclusiv cele ascunse automat),
// sau scoase de moderator.
router.get("/queue", (req, res) => {
  const removed = req.query.status === "removed";
  const rows = db
    .prepare(
      removed
        ? "SELECT * FROM annotations WHERE removed_at IS NOT NULL ORDER BY removed_at DESC LIMIT 200"
        : "SELECT * FROM annotations WHERE reports > 0 AND removed_at IS NULL ORDER BY reports DESC, created_at DESC LIMIT 200"
    )
    .all();
  res.json(rows.map(adminView));
});

// POST /api/admin/annotations/:id/remove  { reason } — scoate adnotarea pentru toată lumea.
router.post("/annotations/:id/remove", (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: "Scrie motivul (3–500 caractere)" });
  const r = db
    .prepare("UPDATE annotations SET removed_at = ?, removed_reason = ? WHERE id = ? AND removed_at IS NULL")
    .run(Date.now(), reason, req.params.id);
  if (!r.changes) return res.status(404).json({ error: "Nu există sau e deja scoasă" });
  res.json(adminView(db.prepare("SELECT * FROM annotations WHERE id = ?").get(req.params.id)));
});

// POST /api/admin/annotations/:id/restore — repune adnotarea și șterge raportările (ex. abuz
// de raportare împotriva unei adnotări legitime).
router.post("/annotations/:id/restore", (req, res) => {
  const row = db.prepare("SELECT * FROM annotations WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Nu există" });
  db.prepare("UPDATE annotations SET removed_at = NULL, removed_reason = NULL, reports = 0 WHERE id = ?").run(row.id);
  db.prepare("DELETE FROM reports WHERE annotation_id = ?").run(row.id);
  res.json(adminView(db.prepare("SELECT * FROM annotations WHERE id = ?").get(row.id)));
});

// POST /api/admin/users/:hash/set-name  { name } — moderatorul dă un nume, inclusiv unul
// rezervat (ex. „Adormis” pentru contul proprietarului). Tot unic, tot cu regulile de format.
router.post("/users/:hash/set-name", (req, res) => {
  const { validateName, assignName } = require("./users");
  if (!/^[0-9a-f]{32}$/.test(req.params.hash)) return res.status(400).json({ error: "ID public invalid (32 de caractere hex)" });
  const v = validateName(req.body?.name, { allowReserved: true });
  if (v.error) return res.status(400).json({ error: v.error });
  if (!v.name) return res.status(400).json({ error: "Scrie numele" });
  const r = assignName(req.params.hash, v);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true, name: r.name });
});

// POST /api/admin/users/reset-password  { name } — recuperare la cerere (prin email către
// administrator; fără garanție). Generează o parolă temporară, arătată O SINGURĂ DATĂ, și
// întoarce câteva adnotări ale contului, ca moderatorul să compare cu ce descrie cel care cere.
router.post("/users/reset-password", (req, res) => {
  const { hashPassword } = require("./users");
  const row = db.prepare("SELECT * FROM users WHERE name_key = ?").get(nameKey(String(req.body?.name || "")));
  if (!row?.password_hash) return res.status(404).json({ error: "Nu există un cont cu parolă cu acest nume." });
  const tempPassword = crypto.randomBytes(9).toString("base64url"); // 12 caractere
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE author_hash = ?").run(hashPassword(tempPassword), Date.now(), row.author_hash);
  const total = db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE author_hash = ? AND removed_at IS NULL").get(row.author_hash).n;
  const recent = db
    .prepare("SELECT url, data, created_at FROM annotations WHERE author_hash = ? AND removed_at IS NULL ORDER BY created_at DESC LIMIT 5")
    .all(row.author_hash)
    .map((a) => ({ url: a.url, text: JSON.parse(a.data).text || JSON.parse(a.data).label || null, at: a.created_at }));
  res.json({ name: row.name, tempPassword, total, recent });
});

// POST /api/admin/users/:hash/reset-name — șterge un nume afișat nepotrivit; utilizatorul
// redevine „Utilizator XXXX” și își poate alege altul.
// Un cont cu parolă nu se șterge (și-ar pierde logarea): primește un nume neutru, unic,
// „Utilizator XXXXXXXX”, pe care și-l poate schimba.
router.post("/users/:hash/reset-name", (req, res) => {
  const row = db.prepare("SELECT password_hash FROM users WHERE author_hash = ?").get(req.params.hash);
  if (!row) return res.status(404).json({ error: "Utilizatorul nu are nume ales" });
  if (row.password_hash) {
    const name = `Utilizator ${req.params.hash.slice(0, 8).toUpperCase()}`;
    db.prepare("UPDATE users SET name = ?, name_key = ?, updated_at = ? WHERE author_hash = ?").run(
      name,
      nameKey(name),
      Date.now(),
      req.params.hash
    );
    return res.json({ ok: true, name });
  }
  db.prepare("DELETE FROM users WHERE author_hash = ?").run(req.params.hash);
  res.json({ ok: true });
});

module.exports = router;
