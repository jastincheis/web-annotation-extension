const path = require("path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

// Implicit: lângă codul sursă (bun pentru local). Pe o platformă cu disc efemer
// (Railway etc.), setează DB_PATH către un volum persistent (ex. /data/annotations.db) —
// altfel baza de date dispare la fiecare redeploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "annotations.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    author_id TEXT NOT NULL,
    votes INTEGER NOT NULL DEFAULT 0,
    reports INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_annotations_url ON annotations(url);`);

// url_hash = SHA-256 (hex) al adresei paginii. Extensia cere adnotările unei pagini DOAR după
// amprentă, ca serverul (și jurnalele lui) să nu primească adresa fiecărei pagini vizitate —
// adresa reală vine doar odată cu o adnotare nou creată. Coloana se adaugă și se completează
// pentru bazele de date vechi, la pornire.
const hasUrlHash = db
  .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('annotations') WHERE name = 'url_hash'")
  .get().n;
if (!hasUrlHash) db.exec("ALTER TABLE annotations ADD COLUMN url_hash TEXT");
{
  const missing = db.prepare("SELECT id, url FROM annotations WHERE url_hash IS NULL").all();
  const set = db.prepare("UPDATE annotations SET url_hash = ? WHERE id = ?");
  for (const r of missing) set.run(sha256Hex(r.url), r.id);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_annotations_url_hash ON annotations(url_hash);`);

db.exec(`
  CREATE TABLE IF NOT EXISTS votes (
    annotation_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('up','down')),
    PRIMARY KEY (annotation_id, voter_id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    annotation_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    PRIMARY KEY (annotation_id, reporter_id)
  );
`);

// Coloane adăugate după prima versiune — se adaugă automat la bazele de date existente.
function addColumn(table, column, type) {
  const exists = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = ?`).get(column).n;
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
// Moderare: o adnotare scoasă de administrator (conținut ilegal / contra regulilor) nu mai
// apare nicăieri, dar rămâne înregistrată, cu motivul (DSA cere o „expunere de motive”).
addColumn("annotations", "removed_at", "INTEGER");
addColumn("annotations", "removed_reason", "TEXT");
// Raportări cu motiv, detalii și momentul raportării (DSA: notificări motivate).
addColumn("reports", "reason", "TEXT");
addColumn("reports", "details", "TEXT");
addColumn("reports", "created_at", "INTEGER");
// Amprenta IP-ului (HMAC cu un secret al serverului, nu IP-ul): un singur vot și o singură
// raportare pe adnotare de pe aceeași adresă IP, oricâte ID-uri ar inventa cineva.
addColumn("votes", "ip_hash", "TEXT");
addColumn("reports", "ip_hash", "TEXT");
db.exec(`CREATE INDEX IF NOT EXISTS idx_votes_ip ON votes(annotation_id, ip_hash);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_ip ON reports(annotation_id, ip_hash);`);

// Voturile date de autori propriilor adnotări (permise până la 0.2.6) nu mai contează:
// le scoatem și scădem scorul corespunzător. Idempotent — la a doua pornire nu mai găsește nimic.
function purgeSelfVotes() {
  const self = db
    .prepare(
      `SELECT v.annotation_id, v.voter_id, v.direction FROM votes v
         JOIN annotations a ON a.id = v.annotation_id WHERE v.voter_id = a.author_id`
    )
    .all();
  for (const v of self) {
    db.prepare("UPDATE annotations SET votes = votes - ? WHERE id = ?").run(v.direction === "up" ? 1 : -1, v.annotation_id);
    db.prepare("DELETE FROM votes WHERE annotation_id = ? AND voter_id = ?").run(v.annotation_id, v.voter_id);
  }
}
purgeSelfVotes();

// Auto-hide annotations after this many unique reports (per doc: 5-10).
const REPORT_HIDE_THRESHOLD = 5;

// Adnotările scoase de moderator se păstrează ca evidență cel mult 2 ani (promis în politica
// de confidențialitate), apoi se șterg definitiv, cu voturile și raportările lor.
const REMOVED_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;
function purgeOldRemoved() {
  const cutoff = Date.now() - REMOVED_RETENTION_MS;
  const old = db.prepare("SELECT id FROM annotations WHERE removed_at IS NOT NULL AND removed_at < ?").all(cutoff);
  for (const { id } of old) {
    db.prepare("DELETE FROM votes WHERE annotation_id = ?").run(id);
    db.prepare("DELETE FROM reports WHERE annotation_id = ?").run(id);
    db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
  }
}
purgeOldRemoved();
setInterval(purgeOldRemoved, 24 * 60 * 60 * 1000).unref();

// Condiția „vizibilă public”: nu ascunsă de raportări și nu scoasă de moderator.
const VISIBLE = `reports < ${REPORT_HIDE_THRESHOLD} AND removed_at IS NULL`;

// Secretul pentru amprenta IP-urilor. Trebuie setat pe server (IP_HASH_SECRET), altfel se
// generează unul la fiecare pornire — și atunci aceeași adresă IP ar putea vota din nou
// după fiecare redeploy.
const IP_HASH_SECRET = process.env.IP_HASH_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.IP_HASH_SECRET) console.warn("[Adormis] IP_HASH_SECRET lipsește — folosesc unul temporar");

function ipHash(ip) {
  return crypto.createHmac("sha256", IP_HASH_SECRET).update(String(ip || "")).digest("hex").slice(0, 32);
}

module.exports = { db, REPORT_HIDE_THRESHOLD, VISIBLE, sha256Hex, ipHash };
