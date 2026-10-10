# Adormis — MVP

Extensie Chrome pentru adnotări vizuale (graffiti, bule cu text, comentarii) pe orice
pagină web sau video, cu salvare/partajare publică prin backend propriu, votare și
raportare. Construit după specificația din `Web Chrome Extension.odt`.

**Ce NU e inclus în acest MVP** (rămâne pentru o fază ulterioară, dacă vrei):
NFT-uri, wallet/ENS, blockchain, marketplace, login Gmail + reCAPTCHA, moderare AI.
Momentan oricine poate crea/vota/raporta anonim (id local generat automat).

## Structură

```
web-annotation-extension/
  extension/     — extensia Chrome (Manifest V3)
  server/        — backend Node.js + Express + SQLite (node:sqlite, nativ)
```

## 1. Pornește backend-ul

```bash
cd server
npm install      # deja rulat; repetă doar dacă ștergi node_modules
npm start
```

Ascultă implicit pe `http://localhost:4000`. Baza de date (`annotations.db`) se
creează automat lângă `server.js`, folosind modulul nativ `node:sqlite` — nu are
nevoie de compilare (necesită Node ≥ 22.5).

Endpoint-uri disponibile:
- `GET /api/health` — `{ok: true}`
- `GET /api/version` — conținutul `version.json` (`{latest, notes}`), pentru beculețul de update
- `GET /api/annotations?urlHash=<sha256(url)>[&minVotes=N]` — listă adnotări pentru o pagină,
  identificată prin amprenta SHA-256 (hex) a adresei, nu prin adresa în sine
  (`?url=` mai merge doar pentru extensiile vechi, ≤ 0.2.3). Fără `minVotes` le trimite pe
  toate; extensia face Top 10 pe pagină cu cel mult o adnotare per utilizator (cea mai bună a
  lui: scor, apoi vechime) și arată pe pagină doar adnotările din top
- `GET /privacy` — politica de confidențialitate (pagină statică din `server/legal`, fără resurse externe);
  e adresa oficială folosită de extensie și în Chrome Web Store
- `GET /api/annotations/by-author/:authorHash` — profilul public al unui utilizator: adnotările
  lui vizibile de pe toate paginile, după voturi (apoi vechime), max. 500
- `POST /api/annotations/mine` — `{authorId}`: toate adnotările autorului, de pe toate
  paginile (panoul „Ale mele → Toate”), cele mai noi primele, max. 500
- `GET /api/annotations/top?limit=10` — cele mai votate adnotări de pe toate paginile
  (min. 1 vot, `limit` max. 50, cache 10s)
- `GET /api/annotations/stats?urlHash=<sha256(url)>` — numărul de adnotări pe tipuri:
  `{global: {total, byType, withLink, pages}, page: {total, byType, withLink}}`
  (`page` doar dacă e dată pagina; partea globală are cache 30s)
- `POST /api/annotations` — creează `{url, type, data, authorId}`
- `PATCH /api/annotations/:id` — `{authorId, patch}` (mutare sau editare text/link; doar autorul)
- `DELETE /api/annotations/:id` — `{authorId}` (doar autorul își poate șterge propria adnotare)
- `authorId` e secretul autorului (generat local de extensie): nu apare în niciun răspuns —
  răspunsurile conțin doar `authorHash` (primele 32 de caractere hex din SHA-256(authorId))
- `POST /api/annotations/:id/vote` — `{voterId, direction: "up"|"down"}` (un vot pe adnotare
  per votant; autorul nu-și poate vota adnotările (403); cel mult 5 votanți per adresă IP,
  amprentată cu `IP_HASH_SECRET` (429 peste)
- `POST /api/annotations/:id/report` — `{reporterId, reason, details?, goodFaith: true}`;
  `reason` ∈ `illegal|hate|harassment|personal_data|sexual|spam|copyright|other`; o raportare
  per raportor și per IP; auto-ascundere la 5 raportări, până la verificarea unui moderator
- `GET /api/admin/queue?status=reported|removed`, `POST /api/admin/annotations/:id/remove`
  `{reason}`, `POST /api/admin/annotations/:id/restore` — moderare, cu
  `Authorization: Bearer <ADMIN_TOKEN>` (fără CORS); interfața e la `/admin`. Adnotările
  scoase dispar pentru toți, rămân ca evidență și se șterg definitiv după 2 ani
- `POST /api/check-url` — `{url}` → `{safe, checked, threats}` (verificare URLhaus;
  fără `URLHAUS_AUTH_KEY` linkurile trec)

Limite: 120 cereri/minut per IP pe tot API-ul, plus 20/minut pe rutele de scriere.

## 2. Încarcă extensia în Chrome

1. Deschide `chrome://extensions`
2. Activează **Developer mode** (colț dreapta sus)
3. **Load unpacked** → selectează folderul `extension/`
4. Iconița 🖍️ apare în bara de extensii

## 3. Folosire

- Butonul rotund de pe marginea din dreapta a paginii (sau **Alt+A**, sau popup-ul
  extensiei) deschide **dock-ul** — bara de unelte de sus. Se mută trăgând de mânerul ⠿
  (își ține minte locul pe fiecare site; dublu-click pe mâner = înapoi la locul implicit).
- Unelte și scurtături (cât e deschis dock-ul): **V** selectează, **P** creion, **S** spray,
  **F** formă (cerc, dreptunghi, stea, săgeată...), **B** bulă, **T** text, **L** link,
  **Esc** închide. Bulina colorată deschide culoarea / grosimea / tipul formei.
- Pe YouTube, Netflix și alte video-uri, adnotările se leagă de video și se pot limita la
  un interval de timp (dublu-click pe adnotare). Merg și în fullscreen, unde se vede și
  dock-ul.
- Fiecare adnotare are lângă ea 👍 👎 🚩 (like/dislike/raportează); autorul vede și 🔗
  (pune un link pe adnotare — apare ca pastilă pe colțul ei) și 🗑.
- 📍 din dock = adnotările tale de pe pagina curentă; 🏆 = arată / ascunde Topul global.
- Adnotările sunt publice: oricine cu extensia instalată și configurată spre același
  server le vede pe aceeași pagină (`origin + pathname + querystring`, fără parametri de
  urmărire `utm_*`/`fbclid`...; pe YouTube doar `?v=`, pe Netflix doar `/watch/<id>`).

Dacă rulezi backend-ul pe altă mașină/port, schimbă adresa din popup („Adresă server”)
și reîncarcă pagina.

## Deploy pe Railway (backend public, cu HTTPS)

1. `railway.com` → cont nou → **New Project** → **Deploy from GitHub repo** (repo-ul ăsta
   trebuie întâi pus pe GitHub) — sau, fără GitHub, `railway up` din CLI, rulat în `server/`.
2. Dacă deploy-ul e din repo-ul întreg (nu doar `server/`), setează **Root Directory** =
   `server` în setările serviciului, ca Railway să nu încerce să pornească extensia.
3. **Volume persistent** — obligatoriu, altfel baza de date dispare la fiecare redeploy:
   Settings → Volumes → Add Volume, montează-l la `/data`.
4. **Variabile de mediu** (Settings → Variables):
   - `DB_PATH` = `/data/annotations.db`
   - `PORT` — Railway o setează singur, serverul o citește deja (`process.env.PORT`).
   - `URLHAUS_AUTH_KEY` — cheie gratuită de pe auth.abuse.ch, pentru verificarea
     linkurilor; fără ea verificarea e dezactivată (linkurile trec).
   - `ADMIN_TOKEN` — parola paginii de moderare `/admin` (minim 24 de caractere,
     ex. `openssl rand -hex 32`); fără ea, moderarea e dezactivată (404).
   - `IP_HASH_SECRET` — cheia pentru amprenta IP-urilor de la voturi/raportări
     (`openssl rand -hex 32`); fără ea se generează una la fiecare pornire, iar aceeași
     conexiune poate vota din nou după un redeploy.
5. Adresa serverului live e setată implicit în `extension/background.js`
   (`DEFAULT_SERVER_URL`) — utilizatorii nu trebuie să configureze nimic.

## Limitări cunoscute (MVP)

- Bulele video se atașează la **primul** `<video>` găsit pe pagină, poziționate fix
  (fără drag după creare).
- Fără autentificare reală — id-ul de autor/votant e generat local per profil de Chrome.
- Fără moderare AI pentru limbaj; doar prag simplu de raportări (5) care ascunde adnotarea.
- Fără persistență/backup automat al `annotations.db` — e un fișier SQLite local.

## Următorii pași posibili

1. Deploy backend pe AWS/DigitalOcean (schimbă doar adresa din popup).
2. Login Gmail + reCAPTCHA înainte de a permite creare/vot.
3. NFT-urile și integrarea blockchain, ca fază separată — cer decizii de arhitectură
   proprii (wallet custodial vs. non-custodial, ce chain, cine plătește gas).
