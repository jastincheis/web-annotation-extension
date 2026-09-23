const express = require("express");

const router = express.Router();

// URLhaus (abuse.ch) — verificare gratuită. Din 30 iunie 2025 cere o cheie ("Auth-Key"),
// obținută gratuit prin login rapid cu un cont existent (Google/GitHub/X/LinkedIn) pe
// auth.abuse.ch — nu mai e complet "fără cont" cum a fost o vreme, dar tot cel mai
// simplu de pornit. Acoperă doar URL-uri cunoscute ca distribuind malware — mai îngust
// decât Google Safe Browsing (nu detectează phishing general), suficient ca prim filtru.
// Fără cheie configurată, verificarea e dezactivată: linkurile trec direct (fail-open).
const URLHAUS_ENDPOINT = "https://urlhaus-api.abuse.ch/v1/url/";
const AUTH_KEY = process.env.URLHAUS_AUTH_KEY;

// POST /api/check-url  { url }
// Răspuns: { safe: bool, checked: bool, threats?: string[] }
// `checked: false` = verificarea n-a putut rula (fără cheie, serviciul jos, sau URL-ul
// nu s-a putut interpreta) — tratat mereu ca fail-open (safe: true), niciodată nu
// blocăm un link doar pentru că nu am putut verifica, doar când chiar e semnalat.
router.post("/", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url" });
  }

  if (!AUTH_KEY) {
    console.warn("[check-url] URLHAUS_AUTH_KEY nesetat — verificare dezactivată, link permis implicit.");
    return res.json({ safe: true, checked: false });
  }

  try {
    const uRes = await fetch(URLHAUS_ENDPOINT, {
      method: "POST",
      headers: {
        "Auth-Key": AUTH_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ url }),
    });

    if (!uRes.ok) {
      console.warn("[check-url] URLhaus a răspuns cu eroare:", uRes.status);
      return res.json({ safe: true, checked: false });
    }

    const data = await uRes.json();
    // query_status: "ok" = URL găsit în baza lor (deci semnalat ca malware),
    // "no_results" = necunoscut lor (tratat ca sigur — nu e o confirmare de siguranță,
    // doar "nu apare în baza asta"). "invalid_url"/"http_post_expected" = n-am putut
    // verifica deloc.
    const flagged = data.query_status === "ok";
    const realVerdict = data.query_status === "ok" || data.query_status === "no_results";
    res.json({
      safe: !flagged,
      checked: realVerdict,
      threats: flagged ? [data.threat || "malware"] : [],
    });
  } catch (err) {
    console.warn("[check-url] Eroare la contactarea URLhaus:", err);
    res.json({ safe: true, checked: false });
  }
});

module.exports = router;
