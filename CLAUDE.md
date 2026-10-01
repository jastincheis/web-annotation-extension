# Adormis — note pentru Claude

Extensie Chrome (Manifest V3) pentru adnotări vizuale pe pagini web/video + backend
Node/Express/SQLite. Detalii de utilizare și deploy: `README.md`.

## Comenzi

- Backend local: `cd server && npm run dev` (node --watch) sau `npm start` → `http://localhost:4000`
  - Verifică întâi dacă rulează deja: `curl -s localhost:4000/api/health` sau `ss -ltnp | grep 4000`
  - Necesită Node ≥ 22.5 (folosește `node:sqlite` nativ, fără compilare)
- Extensia: **fără build**, se încarcă direct `extension/` ca „Load unpacked” în `chrome://extensions`.
- Nu există teste, linter sau formatter în proiect.

## Structură

- `extension/content/content.js` (~2700 linii) — toată logica de pe pagină: toolbar, unelte
  (pen, spray, formă, text, bulă, link, video), vot, panouri „🏆 Top” și „📍 Ale mele”.
- `extension/lib/storage.js`, `lib/api.js` — IIFE-uri expuse ca `window.WA_Storage` / `window.WA_Api`
  (rulează în lumea izolată a content script-ului).
- `extension/background.js` — service worker: URL server implicit + verificare de versiune (beculeț).
- `extension/popup/` — popup: toggle toolbar (mesaj `TOGGLE_TOOLBAR`), adresă server.
- `server/server.js` — Express, rate limit global; `routes/annotations.js` (GET, GET /top, POST,
  PATCH, DELETE, vote, report); `routes/check-url.js` (URLhaus); `GET /api/version` servește `version.json`.
- Când adaugi/modifici un endpoint, actualizează și lista din `README.md`.

## Convenții

- JavaScript vanilla, fără framework-uri sau bundler — nu introduce unele fără să întrebi.
- Comentariile, textele din UI și mesajele de commit sunt **în română**.
- ID-urile/clasele DOM ale extensiei au prefixul `wa-` (ex. `#wa-root`, `#wa-toolbar`);
  cheile din `chrome.storage` au prefixul `wa_`.
- Nu urca în git: `server/annotations.db*`, `.env` (deja în `.gitignore`).

## La lansarea unei versiuni noi

1. `extension/manifest.json` → `version`
2. `server/version.json` → `latest` + `notes` (trebuie să fie sincron cu manifestul,
   altfel beculețul de update se aprinde greșit)
3. Backend-ul live e pe Railway (`DEFAULT_SERVER_URL` în `background.js`); fallback-ul din
   `lib/storage.js` e `http://localhost:4000`.

## Verificare în browser

- După orice modificare în `extension/`: reîncarcă extensia din `chrome://extensions`, apoi
  reîncarcă pagina de test (content script-urile vechi nu se actualizează singure).
- Pentru test local, setează „Adresă server” din popup la `http://localhost:4000`.
- Preferă verificări DOM cu `javascript_tool`/`find` (ex. există `#wa-toolbar`, câte elemente
  sunt în `#wa-elements-layer`, erori în consolă) în locul screenshot-urilor și click-urilor
  repetate. Atenție: `javascript_tool` rulează în lumea paginii, deci `window.WA_*` nu e vizibil
  acolo — doar DOM-ul.
- Screenshot doar când trebuie judecat aspectul vizual (poziționare, stil).
- Backend-ul se poate testa direct cu `curl` pe `/api/annotations?url=...`.
