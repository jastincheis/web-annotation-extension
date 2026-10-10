// Numele afișate ale utilizatorilor. Opțional: fără nume, un utilizator apare ca
// „Utilizator AF54” (primele caractere ale amprentei). Numele e UNIC — comparat după o cheie
// fără majuscule, diacritice, spații și . _ - (vezi nameKey), ca „Andrei”, „andrei” și „An-drei”
// să nu poată fi purtate de doi oameni diferiți.
const express = require("express");
const rateLimit = require("express-rate-limit");
const { db, nameKey, displayNameFor } = require("../db");
const crypto = require("node:crypto");

const router = express.Router();

const nameLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Prea multe schimbări de nume la rând — încearcă din nou peste un minut." },
});

const authorHash = (authorId) => crypto.createHash("sha256").update(String(authorId)).digest("hex").slice(0, 32);

// Nume care ar putea fi luate drept ale serviciului sau ale pseudonimelor automate.
const RESERVED = /^(admin|administrator|moderator|moderare|mod|adormis|utilizator|staff|support|suport|system|sistem|tu)/;

function validateName(raw) {
  const name = String(raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) return { name: "" }; // gol = renunți la nume
  if (name.length < 2 || name.length > 24) return { error: "Numele are între 2 și 24 de caractere." };
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) return { error: "Doar litere, cifre, spații și . _ -" };
  const key = nameKey(name);
  if (key.length < 2) return { error: "Numele trebuie să conțină măcar două litere sau cifre." };
  if (RESERVED.test(key)) return { error: "Numele acesta e rezervat — alege altul." };
  return { name, key };
}

// GET /api/users/:hash — numele afișat al unui utilizator (null dacă nu și-a ales unul).
router.get("/:hash", (req, res) => {
  const { hash } = req.params;
  if (!/^[0-9a-f]{32}$/.test(hash)) return res.status(400).json({ error: "Utilizator invalid" });
  res.json({ hash, name: displayNameFor(hash) });
});

// POST /api/users/name  { authorId, name } — își schimbă propriul nume (gol = îl șterge).
// authorId (secretul) dovedește că e al lui; numele se leagă de amprenta publică.
router.post("/name", nameLimiter, (req, res) => {
  const { authorId, name: raw } = req.body || {};
  if (typeof authorId !== "string" || !authorId || authorId.length > 100) {
    return res.status(400).json({ error: "Missing authorId" });
  }
  const hash = authorHash(authorId);
  const v = validateName(raw);
  if (v.error) return res.status(400).json({ error: v.error });

  if (!v.name) {
    db.prepare("DELETE FROM users WHERE author_hash = ?").run(hash);
    return res.json({ hash, name: null });
  }
  const taken = db.prepare("SELECT author_hash FROM users WHERE name_key = ?").get(v.key);
  if (taken && taken.author_hash !== hash) {
    return res.status(409).json({ error: `Numele „${v.name}” e deja folosit — alege altul.` });
  }
  db.prepare(
    `INSERT INTO users (author_hash, name, name_key, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(author_hash) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, updated_at = excluded.updated_at`
  ).run(hash, v.name, v.key, Date.now());
  res.json({ hash, name: v.name });
});

module.exports = router;
