# 🖍️ Adormis

**[English](#english) · [Română](#română)**

Draw, write, chat and vote on top of any web page or video — graffiti, speech bubbles,
links and comments that everyone with the extension can see.

Desenează, scrie, vorbește și votează peste orice pagină web sau video — graffiti, bule,
linkuri și comentarii pe care le vede oricine are extensia.

Current version / Versiunea curentă: **0.3.7**

---

## English

### What it is

Adormis is a Chrome extension (Manifest V3) that turns any page or video into a shared
canvas — even on sites that don't allow comments. Annotations are public: anyone with the
extension sees them on the same page. The repo contains both the extension and its
backend (Node.js + Express + SQLite).

### Features

**Drawing and writing**
- Free pen and graffiti spray (6 kinds: classic, mist, splatter, drips, soft cloud, burst),
  with adjustable color and size
- 13 shapes: circle, square, rectangle, triangle, diamond, star, heart, hexagon, cloud,
  lightning, arrow, double arrow, line
- Text and speech bubbles — 6 bubble styles (tail left or right) and 6 fonts (Impact,
  Bangers, Marker, handwriting, typewriter…) — movable, resizable and rotatable
- Links: on the page or attached to any annotation (checked against URLhaus)

**Video**
- On YouTube, Netflix, X and other players, annotations are tied to the video and can be
  limited to a time range (e.g. only between second 20 and 25)
- Works in fullscreen, toolbar included

**Community**
- 👍 👎 voting and 🚩 reporting on every annotation
- Top 10 per page (at most one annotation per user) and a global 🏆 Top
- Public profile: a unique name and all your annotations from every page
- **Page chat** — a movable, resizable window to talk with people on the same page or
  video; the chat button shows how many are there right now; messages vanish after 24 h
- **Watch together** — in the chat you can sync to someone else's spot in the video
- Live annotations: new ones appear while the chat is open

**Accounts**
- Without an account: see everything, read the chat, vote, report and make up to
  3 annotations a day (no links)
- With a free account — just a name and a password, no email: everything, including
  writing in the chat, and the same identity on any computer

**Privacy and safety**
- Nothing is sent before you give consent on first use; consent can be withdrawn from the
  extension menu
- For pages you only view, just a hash of the address is sent, not the address itself
- Local and internal pages are ignored
- Reported content goes to a human moderator (DSA-style moderation queue at `/admin`);
  auto-hiding only counts reports from accounts older than one day
- Privacy policy: <https://web-annotation-extension-production.up.railway.app/privacy>

### What's new

| Version | Changes |
|---|---|
| **0.3.7** | The “☕ Buy me a coffee” link is now an easy-to-see yellow button |
| **0.3.6** | “☕ Buy me a coffee” link (PayPal, you choose the amount) in “My annotations” and in the extension popup |
| **0.3.5** | Security fixes after an audit: pages can no longer click Adormis buttons for you; the global Top only counts votes from accounts; stricter limits on new accounts and on free annotations |
| **0.3.4** | Annotations appear live while the chat is open; the Top is downloaded only when it changes |
| **0.3.3** | The chat button shows how many people are in the chat |
| **0.3.2** | Watch together in the chat (sync to another viewer's spot in the video) |
| **0.3.1** | Tools are picked by hovering the top bar |
| **0.3.0** | Page chat; moderators with their own tokens and an action log |
| **0.2.x** | Accounts with name and password, account tiers, public profiles, Top 10, new fonts, bubbles, shapes and sprays, video time ranges, fullscreen, Netflix and X support, moderation and privacy |

The full history is in the git log.

### Install

The extension needs no build step:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → choose the `extension/` folder
4. The 🖍️ icon appears in the extensions bar

It connects by default to the public server on Railway — nothing to configure.

### Usage

- The round button on the right edge of the page (or **Alt+A**, or the extension popup)
  opens the **dock**, the toolbar at the top. Drag its ⠿ handle to move it (the position is
  remembered per site; double-click the handle to reset it).
- Shortcuts while the dock is open: **V** select, **P** pen, **S** spray, **F** shape,
  **B** bubble, **T** text, **L** link, **Esc** close.
- The colored dot opens the style of the current tool: color, size, shape, spray kind,
  bubble style, font.
- On video, double-click an annotation to set its time range.
- Next to each annotation: 👍 👎 🚩; its author also sees 🔗 (add a link) and 🗑.
- 📍 in the dock = your annotations; 🏆 = show/hide the global Top; the chat button = page chat.
- A page is identified by `origin + pathname + query`, without tracking parameters
  (`utm_*`, `fbclid`…); on YouTube only `?v=`, on Netflix only `/watch/<id>`.

### Run the backend yourself

```bash
cd server
npm install
npm start        # or: npm run dev (auto-restart)
```

It listens on `http://localhost:4000`. The database (`annotations.db`) is created
automatically, using Node's built-in `node:sqlite` — no compiling, but **Node ≥ 22.5**
is required. Point the extension to it from the popup (“Server address”), then reload the
page.

The full API reference is in [`server/API.md`](server/API.md).

### Deploy on Railway (public backend with HTTPS)

1. railway.com → **New Project** → **Deploy from GitHub repo** (or `railway up` from
   `server/`).
2. Set **Root Directory** = `server` in the service settings.
3. Add a **persistent volume** mounted at `/data` — otherwise the database is lost on every
   redeploy.
4. Environment variables:
   - `DB_PATH` = `/data/annotations.db`
   - `ADMIN_TOKEN` — owner password for `/admin` (at least 24 characters, e.g.
     `openssl rand -hex 32`); without it moderation is disabled
   - `IP_HASH_SECRET` — key for hashing IPs (`openssl rand -hex 32`); without it a new one
     is generated on every start
   - `URLHAUS_AUTH_KEY` — free key from auth.abuse.ch for link checking; without it links
     are not checked
   - `PORT` is set by Railway automatically
5. The live server address is `DEFAULT_SERVER_URL` in `extension/background.js`.

### Project structure

```
extension/   — the Chrome extension (Manifest V3, vanilla JS, no bundler)
server/      — backend: Node.js + Express + SQLite, moderation page at /admin
```

### Known limitations

- No AI moderation; reported content is handled by human moderators.
- Database backups are manual (download from `/admin`).
- Not on the Chrome Web Store yet — install it as an unpacked extension.

---

## Română

### Ce este

Adormis e o extensie Chrome (Manifest V3) care transformă orice pagină sau video într-o
pânză comună — chiar și pe site-urile care nu permit comentarii. Adnotările sunt publice:
oricine are extensia le vede pe aceeași pagină. Repo-ul conține și extensia, și
backend-ul ei (Node.js + Express + SQLite).

### Ce poți face

**Desen și text**
- Creion liber și spray graffiti (6 feluri: clasic, ceață, stropi, scurgeri, nor moale,
  explozie), cu culoare și grosime reglabile
- 13 forme: cerc, pătrat, dreptunghi, triunghi, romb, stea, inimă, hexagon, nor, fulger,
  săgeată, săgeată dublă, linie
- Text și bule — 6 stiluri de bulă (coada în stânga sau în dreapta) și 6 fonturi (Impact,
  Bangers, Marker, de mână, mașină de scris…) — se mută, se măresc și se rotesc
- Linkuri: pe pagină sau atașate oricărei adnotări (verificate cu URLhaus)

**Video**
- Pe YouTube, Netflix, X și alte playere, adnotările se leagă de video și pot apărea doar
  într-un interval (ex. doar între secunda 20 și 25)
- Merg și pe tot ecranul, cu tot cu bara de unelte

**Comunitate**
- Vot 👍 👎 și raportare 🚩 pe fiecare adnotare
- Top 10 pe fiecare pagină (cel mult o adnotare per utilizator) și 🏆 Top global
- Profil public: un nume unic și toate adnotările tale, de pe toate paginile
- **Chat pe pagină** — o fereastră pe care o muți și o mărești, ca să vorbești cu cei de
  pe aceeași pagină sau același video; butonul de chat arată câți sunt acolo acum;
  mesajele dispar după 24 de ore
- **Vizionare împreună** — din chat te poți sincroniza cu locul din video al altcuiva
- Adnotări live: cele noi apar cât timp chatul e deschis

**Cont**
- Fără cont: vezi tot, citești chatul, votezi, raportezi și faci până la 3 adnotări pe zi
  (fără linkuri)
- Cu un cont gratuit — doar un nume și o parolă, fără email: ai totul, inclusiv scrisul în
  chat, și ești același utilizator pe orice calculator

**Confidențialitate și siguranță**
- Nu se trimite nimic înainte de acordul de la prima folosire; acordul se retrage oricând
  din meniul extensiei
- Pentru paginile pe care doar le vezi se trimite doar o amprentă (hash) a adresei, nu
  adresa
- Paginile locale și interne sunt ignorate
- Conținutul raportat ajunge la un moderator uman (coadă de moderare DSA la `/admin`);
  ascunderea automată ține cont doar de raportările conturilor mai vechi de o zi
- Politica de confidențialitate: <https://web-annotation-extension-production.up.railway.app/privacy>

### Ce e nou

| Versiune | Modificări |
|---|---|
| **0.3.7** | Linkul „☕ Cumpără-mi o cafea” e acum un buton galben, ușor de văzut |
| **0.3.6** | Linkul „☕ Cumpără-mi o cafea” (PayPal, alegi tu suma) în „Ale mele” și în fereastra extensiei |
| **0.3.5** | Reparații de securitate după un audit: paginile nu mai pot apăsa butoanele Adormis în locul tău; Topul global ține cont doar de voturile celor cu cont; limite mai stricte pentru conturi noi și adnotări gratuite |
| **0.3.4** | Adnotările apar live cât timp chatul e deschis; Topul se descarcă doar când se schimbă |
| **0.3.3** | Butonul de chat arată câți sunt în chat |
| **0.3.2** | Vizionare împreună în chat (sincronizare cu locul din video al altcuiva) |
| **0.3.1** | Uneltele se aleg la hover pe bara de sus |
| **0.3.0** | Chat pe pagină; moderatori cu tokenuri proprii și jurnal de acțiuni |
| **0.2.x** | Cont cu nume și parolă, niveluri cu/fără cont, profil public, Top 10, fonturi, bule, forme și spray-uri noi, intervale pe video, fullscreen, Netflix și X, moderare și confidențialitate |

Istoricul complet e în git log.

### Instalare

Extensia nu are nevoie de build:

1. Deschide `chrome://extensions`
2. Activează **Developer mode** (dreapta sus)
3. **Load unpacked** → alege folderul `extension/`
4. Iconița 🖍️ apare în bara de extensii

Se conectează implicit la serverul public de pe Railway — nu e nimic de configurat.

### Folosire

- Butonul rotund de pe marginea din dreapta a paginii (sau **Alt+A**, sau popup-ul
  extensiei) deschide **dock-ul**, bara de unelte de sus. Se mută trăgând de mânerul ⠿
  (își ține minte locul pe fiecare site; dublu-click pe mâner = înapoi la locul implicit).
- Scurtături cât e deschis dock-ul: **V** selectează, **P** creion, **S** spray,
  **F** formă, **B** bulă, **T** text, **L** link, **Esc** închide.
- Bulina colorată deschide stilul uneltei alese: culoare, grosime, formă, fel de spray,
  stil de bulă, font.
- Pe video, dublu-click pe o adnotare îi setează intervalul de timp.
- Lângă fiecare adnotare: 👍 👎 🚩; autorul vede și 🔗 (pune un link) și 🗑.
- 📍 din dock = adnotările tale; 🏆 = arată/ascunde Topul global; butonul de chat = chatul paginii.
- O pagină e identificată prin `origin + pathname + query`, fără parametri de urmărire
  (`utm_*`, `fbclid`…); pe YouTube doar `?v=`, pe Netflix doar `/watch/<id>`.

### Pornește backend-ul la tine

```bash
cd server
npm install
npm start        # sau: npm run dev (repornire automată)
```

Ascultă pe `http://localhost:4000`. Baza de date (`annotations.db`) se creează singură,
cu modulul nativ `node:sqlite` — fără compilare, dar e nevoie de **Node ≥ 22.5**.
Setează adresa în popup („Adresă server”), apoi reîncarcă pagina.

Lista completă a API-ului e în [`server/API.md`](server/API.md).

### Deploy pe Railway (backend public, cu HTTPS)

1. railway.com → **New Project** → **Deploy from GitHub repo** (sau `railway up` din
   `server/`).
2. Setează **Root Directory** = `server` în setările serviciului.
3. Adaugă un **volum persistent** montat la `/data` — altfel baza de date se pierde la
   fiecare redeploy.
4. Variabile de mediu:
   - `DB_PATH` = `/data/annotations.db`
   - `ADMIN_TOKEN` — parola de proprietar pentru `/admin` (minim 24 de caractere, ex.
     `openssl rand -hex 32`); fără ea moderarea e dezactivată
   - `IP_HASH_SECRET` — cheia pentru amprenta IP-urilor (`openssl rand -hex 32`); fără ea
     se generează una nouă la fiecare pornire
   - `URLHAUS_AUTH_KEY` — cheie gratuită de pe auth.abuse.ch pentru verificarea linkurilor;
     fără ea linkurile nu se verifică
   - `PORT` îl setează Railway singur
5. Adresa serverului live e `DEFAULT_SERVER_URL` din `extension/background.js`.

### Structură

```
extension/   — extensia Chrome (Manifest V3, JavaScript simplu, fără bundler)
server/      — backend: Node.js + Express + SQLite, pagina de moderare la /admin
```

### Limitări cunoscute

- Fără moderare AI; conținutul raportat e verificat de moderatori oameni.
- Backup-ul bazei de date e manual (se descarcă din `/admin`).
- Nu e încă în Chrome Web Store — se instalează ca extensie despachetată (Load unpacked).
