const express = require("express");
const cors = require("cors");
const path = require("path");
const annotationsRouter = require("./routes/annotations");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors()); // extensia rulează pe origin-uri diferite (fiecare pagină web)
app.use(express.json({ limit: "2mb" })); // desenele SVG pot fi ceva mai mari

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Versiunea "oficială" curentă a extensiei — background.js o compară cu manifest.json
// local și arată un beculet pe iconiță dacă e mai veche. Actualizează version.json
// (nu manifest.json din instalările deja făcute!) de fiecare dată când merită anunțat.
app.get("/api/version", (_req, res) => res.sendFile(path.join(__dirname, "version.json")));

app.use("/api/annotations", annotationsRouter);

app.listen(PORT, () => {
  console.log(`Adormis server ascultă pe http://localhost:${PORT}`);
});
