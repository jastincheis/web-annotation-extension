const express = require("express");
const cors = require("cors");
const annotationsRouter = require("./routes/annotations");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors()); // extensia rulează pe origin-uri diferite (fiecare pagină web)
app.use(express.json({ limit: "2mb" })); // desenele SVG pot fi ceva mai mari

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/annotations", annotationsRouter);

app.listen(PORT, () => {
  console.log(`Web Annotate server ascultă pe http://localhost:${PORT}`);
});
