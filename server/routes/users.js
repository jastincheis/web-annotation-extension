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

// Nume care ar putea fi luate drept ale serviciului sau ale pseudonimelor automate. Cele care
// pot înșela sunt blocate și ca ÎNCEPUT de nume („Adormis Oficial”, „Admin2”); cuvintele scurte
// doar ca nume ÎNTREG — altfel „tu” ar bloca „Tudor”, iar „mod” pe „Modest”. Un nume rezervat
// îl poate da doar moderatorul (POST /api/admin/users/:hash/set-name).
const RESERVED_PREFIX = /^(admin|moderator|moderare|adormis|utilizator)/;
const RESERVED_EXACT = new Set(["mod", "staff", "support", "suport", "system", "sistem", "tu", "echipa", "team"]);
const isReserved = (key) => RESERVED_PREFIX.test(key) || RESERVED_EXACT.has(key);

function validateName(raw, { allowReserved = false } = {}) {
  const name = String(raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) return { name: "" }; // gol = renunți la nume
  if (name.length < 2 || name.length > 24) return { error: "Numele are între 2 și 24 de caractere." };
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) return { error: "Doar litere, cifre, spații și . _ -" };
  const key = nameKey(name);
  if (key.length < 2) return { error: "Numele trebuie să conțină măcar două litere sau cifre." };
  if (!allowReserved && isReserved(key)) return { error: "Numele acesta e rezervat — alege altul." };
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
    if (db.prepare("SELECT password_hash FROM users WHERE author_hash = ?").get(hash)?.password_hash) {
      return res.status(400).json({ error: "Ai cont cu parolă: numele e numele tău de utilizator — îl poți schimba, nu șterge." });
    }
    db.prepare("DELETE FROM users WHERE author_hash = ?").run(hash);
    return res.json({ hash, name: null });
  }
  const r = assignName(hash, v);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ hash, name: r.name });
});

// ---------- Cont cu parolă (opțional) ----------
// Numele de utilizator = numele afișat (unic). Parola e păstrată doar ca hash scrypt cu sare;
// la logare de pe alt calculator, serverul dă înapoi secretul identității (authorId), iar acel
// calculator devine același utilizator. Fără email = fără recuperare: parola uitată e pierdută.

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Prea multe încercări de logare — mai încearcă peste 15 minute." },
});

const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
function checkPassword(password, stored) {
  const [kind, saltHex, keyHex] = String(stored || "").split("$");
  if (kind !== "scrypt" || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 32, SCRYPT);
  const want = Buffer.from(keyHex, "hex");
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex")); // vezi /login
const validId = (v) => typeof v === "string" && v.length > 0 && v.length <= 100;
const validPassword = (v) => typeof v === "string" && v.length >= 8 && v.length <= 200;

// POST /api/users/me  { authorId } — numele tău și dacă ai cont cu parolă.
router.post("/me", (req, res) => {
  const { authorId } = req.body || {};
  if (!validId(authorId)) return res.status(400).json({ error: "Missing authorId" });
  const row = db.prepare("SELECT name, password_hash FROM users WHERE author_hash = ?").get(authorHash(authorId));
  res.json({ name: row?.name || null, hasPassword: !!row?.password_hash });
});

// POST /api/users/password  { authorId, password } — creează contul (sau schimbă parola).
// Cere un nume ales: el e numele de utilizator cu care intri de pe alt calculator.
router.post("/password", nameLimiter, (req, res) => {
  const { authorId, password } = req.body || {};
  if (!validId(authorId)) return res.status(400).json({ error: "Missing authorId" });
  if (!validPassword(password)) return res.status(400).json({ error: "Parola are cel puțin 8 caractere." });
  const hash = authorHash(authorId);
  const row = db.prepare("SELECT name FROM users WHERE author_hash = ?").get(hash);
  if (!row) return res.status(400).json({ error: "Alege-ți întâi un nume — el e numele de utilizator." });
  db.prepare("UPDATE users SET password_hash = ?, author_id = ?, updated_at = ? WHERE author_hash = ?").run(
    hashPassword(password),
    authorId,
    Date.now(),
    hash
  );
  res.json({ ok: true, name: row.name });
});

// POST /api/users/login  { name, password, currentAuthorId? } — intri în cont de pe alt
// calculator. Dacă acel calculator avea deja o identitate (currentAuthorId) cu adnotări, voturi
// sau raportări, ele se mută în cont (mergeIdentity), ca să nu rămână needitabile.
router.post("/login", loginLimiter, (req, res) => {
  const { name, password, currentAuthorId } = req.body || {};
  if (typeof name !== "string" || !validPassword(password)) {
    return res.status(400).json({ error: "Scrie numele de utilizator și parola." });
  }
  const row = db.prepare("SELECT * FROM users WHERE name_key = ?").get(nameKey(name));
  const fail = () => res.status(401).json({ error: "Nume de utilizator sau parolă greșită." });
  if (!row?.password_hash || !row.author_id) {
    checkPassword(password, DUMMY_HASH); // același timp de răspuns, ca să nu se afle ce nume există
    return fail();
  }
  if (!checkPassword(password, row.password_hash)) return fail();
  if (validId(currentAuthorId) && currentAuthorId !== row.author_id) mergeIdentity(currentAuthorId, row.author_id);
  res.json({ authorId: row.author_id, hash: row.author_hash, name: row.name });
});

// Mută tot ce ține de identitatea `fromId` pe `toId`: adnotări, voturi, raportări. Voturile
// sau raportările duble (amândouă pe aceeași adnotare) și voturile date propriilor adnotări se
// scot, cu scorurile corectate. Numele vechi (fără parolă) se eliberează.
function mergeIdentity(fromId, toId) {
  const fromHash = authorHash(fromId);
  const toHash = authorHash(toId);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE annotations SET author_id = ?, author_hash = ? WHERE author_id = ?").run(toId, toHash, fromId);

    const dropVote = db.prepare("DELETE FROM votes WHERE annotation_id = ? AND voter_id = ?");
    const fixScore = db.prepare("UPDATE annotations SET votes = votes - ? WHERE id = ?");
    for (const v of db.prepare("SELECT * FROM votes WHERE voter_id = ?").all(fromId)) {
      const dup = db.prepare("SELECT 1 FROM votes WHERE annotation_id = ? AND voter_id = ?").get(v.annotation_id, toId);
      if (dup) {
        dropVote.run(v.annotation_id, fromId);
        fixScore.run(v.direction === "up" ? 1 : -1, v.annotation_id);
      } else {
        db.prepare("UPDATE votes SET voter_id = ? WHERE annotation_id = ? AND voter_id = ?").run(toId, v.annotation_id, fromId);
      }
    }
    // după mutare, contul poate avea voturi pe propriile adnotări — nu contează
    for (const v of db
      .prepare("SELECT v.* FROM votes v JOIN annotations a ON a.id = v.annotation_id WHERE v.voter_id = ? AND a.author_id = ?")
      .all(toId, toId)) {
      dropVote.run(v.annotation_id, toId);
      fixScore.run(v.direction === "up" ? 1 : -1, v.annotation_id);
    }

    for (const r of db.prepare("SELECT * FROM reports WHERE reporter_id = ?").all(fromId)) {
      const dup = db.prepare("SELECT 1 FROM reports WHERE annotation_id = ? AND reporter_id = ?").get(r.annotation_id, toId);
      if (dup) {
        db.prepare("DELETE FROM reports WHERE annotation_id = ? AND reporter_id = ?").run(r.annotation_id, fromId);
        db.prepare("UPDATE annotations SET reports = MAX(reports - 1, 0) WHERE id = ?").run(r.annotation_id);
      } else {
        db.prepare("UPDATE reports SET reporter_id = ? WHERE annotation_id = ? AND reporter_id = ?").run(toId, r.annotation_id, fromId);
      }
    }

    db.prepare("DELETE FROM users WHERE author_hash = ? AND password_hash IS NULL").run(fromHash);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Salvează numele unui utilizator, dacă nu e purtat de altcineva. Folosit și de moderator.
function assignName(hash, v) {
  const taken = db.prepare("SELECT author_hash FROM users WHERE name_key = ?").get(v.key);
  if (taken && taken.author_hash !== hash) return { status: 409, error: `Numele „${v.name}” e deja folosit — alege altul.` };
  db.prepare(
    `INSERT INTO users (author_hash, name, name_key, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(author_hash) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, updated_at = excluded.updated_at`
  ).run(hash, v.name, v.key, Date.now());
  return { name: v.name };
}

module.exports = router;
module.exports.validateName = validateName;
module.exports.assignName = assignName;
module.exports.hashPassword = hashPassword;
