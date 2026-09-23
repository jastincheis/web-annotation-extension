// Încarcă .env DOAR dacă există (dev local) — pe Railway (și oriunde altundeva)
// variabilele vin deja injectate direct în process.env, fișierul lipsește și
// dotenv.config() pur și simplu nu găsește nimic, fără nicio eroare.
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const rateLimit = require("express-rate-limit");
const annotationsRouter = require("./routes/annotations");
const checkUrlRouter = require("./routes/check-url");

const app = express();
const PORT = process.env.PORT || 4000;

// Pe Railway toate cererile trec printr-un proxy — fără asta, req.ip ar fi IP-ul
// proxy-ului pentru TOȚI utilizatorii, iar limitele de mai jos ar fi împărțite între
// toată lumea în loc să fie per utilizator. 1 = are încredere doar în primul hop.
app.set("trust proxy", 1);

app.use(cors()); // extensia rulează pe origin-uri diferite (fiecare pagină web)
app.use(express.json({ limit: "2mb" })); // desenele SVG pot fi ceva mai mari

// Limită generală, pe IP, pentru TOT API-ul — protecție de bază împotriva unui
// abuz/bug care bombardează serverul cu cereri (SQLite e sincronă: un val de cereri
// blochează tot procesul, nu doar cererile în exces). 120/minut = ~2/secundă,
// generos pentru trafic normal (chiar și cineva cu multe tab-uri deschise pe același
// IP), dar oprește rapid orice spam susținut. Rutele de SCRIERE au, în plus, o
// limită proprie mai strictă — vezi routes/annotations.js.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Versiunea "oficială" curentă a extensiei — background.js o compară cu manifest.json
// local și arată un beculet pe iconiță dacă e mai veche. Actualizează version.json
// (nu manifest.json din instalările deja făcute!) de fiecare dată când merită anunțat.
app.get("/api/version", (_req, res) => res.sendFile(path.join(__dirname, "version.json")));

app.use("/api/annotations", annotationsRouter);
app.use("/api/check-url", checkUrlRouter);

app.listen(PORT, () => {
  console.log(`Adormis server ascultă pe http://localhost:${PORT}`);
});
