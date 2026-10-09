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

// Auto-hide annotations after this many unique reports (per doc: 5-10).
const REPORT_HIDE_THRESHOLD = 5;

module.exports = { db, REPORT_HIDE_THRESHOLD, sha256Hex };
