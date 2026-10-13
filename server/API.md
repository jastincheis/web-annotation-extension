# Adormis — API

**[English](#english) · [Română](#română)**

## English

Base URL: `http://localhost:4000` locally, or the Railway server in production.

**Identity.** `authorId` is the author's secret (generated locally by the extension) and
never appears in any response — responses only contain `authorHash` (the first 32 hex
characters of SHA-256(authorId)). Pages are identified by `urlHash` = SHA-256 (hex) of the
normalized address, not by the address itself.

### General
- `GET /api/health` — `{ok: true}`
- `GET /api/version` — contents of `version.json` (`{latest, notes}`), for the update dot
- `GET /privacy` — privacy policy (static page from `server/legal`, no external resources);
  the official address used by the extension and the Chrome Web Store
- `POST /api/check-url` — `{url}` → `{safe, checked, threats}` (URLhaus check; without
  `URLHAUS_AUTH_KEY` links pass)

### Annotations
- `GET /api/annotations?urlHash=<sha256(url)>[&minVotes=N]` — annotations for a page
  (`?url=` only works for old extensions, ≤ 0.2.3). Without `minVotes` it returns all of
  them; the extension builds a per-page Top 10 with at most one annotation per user (their
  best: score, then age) and only shows annotations from that top. Safety cap: at most 2000
  per page (never reached in practice); above it, the most-voted are kept, so the per-page Top
  stays correct
- `GET /api/annotations/top?limit=10` — most-voted annotations across all pages, by votes
  from account holders (`votes` = that score); with `&v=<version>` → `{v, items}` or just
  `{v, same: true}` if the Top hasn't changed since that version (min. 1 vote, `limit`
  max. 50, 10 s cache)
- `GET /api/annotations/stats?urlHash=<sha256(url)>` — counts by type:
  `{global: {total, byType, withLink, pages, users}, page: {total, byType, withLink}}`
  (`users` = everyone who wrote, voted, reported or picked a name; `page` only if a page is
  given; the global part is cached 30 s)
- `GET /api/annotations/by-author/:authorHash` — a user's public profile: their visible
  annotations from all pages, by votes (then age), max. 500
- `POST /api/annotations/mine` — `{authorId}`: all of the author's annotations from all
  pages (“Mine → All” panel), newest first, max. 500
- `POST /api/annotations` — create `{url, type, data, authorId}`
  - without an account (name + password): at most 3 annotations per 24 h and no links →
    `403 {error, needAccount: true}` (same for `PATCH` with `url`)
- `PATCH /api/annotations/:id` — `{authorId, patch}` (move or edit text/link; author only)
- `DELETE /api/annotations/:id` — `{authorId}` (only the author can delete their annotation)
- `POST /api/annotations/:id/vote` — `{voterId, direction: "up"|"down"}` (one vote per
  annotation per voter; authors can't vote on their own (403); at most 5 voters per IP
  address, hashed with `IP_HASH_SECRET` (429 above that))
- `POST /api/annotations/:id/report` — `{reporterId, reason, details?, goodFaith: true}`;
  `reason` ∈ `illegal|hate|harassment|personal_data|sexual|spam|copyright|other`; one
  report per reporter and per IP; auto-hidden after 5 reports from accounts older than one
  day, until a moderator reviews it (reports without an account only go to the queue)

### Users and accounts
- `GET /api/users/:authorHash` — a user's display name (`null` if none)
- `POST /api/users/name` — `{authorId, name}`: pick / change the name (empty = remove it);
  unique by a key ignoring case, diacritics, spaces and `. _ -` (409 if taken), 2–24
  characters, reserved names refused (admin…, moderator…, adormis…, utilizator… as a
  prefix; tu, mod, staff etc. only as the whole name); max. 10 changes/minute. Annotation
  responses include `authorName`
- `POST /api/users/me` — `{authorId}` → `{name, hasPassword, freeLeft}` (`freeLeft` = how
  many annotations someone without an account can still make today; `null` with an account)
- `POST /api/users/password` — `{authorId, password}` (min. 8): create the account (at most
  3 new accounts per day from the same IP) / change the password; requires a chosen name
  (= the username); password stored only as a scrypt hash
- `POST /api/users/login` — `{name, password, currentAuthorId?}` → `{authorId, hash, name}`;
  the computer's current identity is merged into the account (annotations, votes, reports);
  10 attempts / 15 min

### Page chat
- `POST /api/chat/poll` — `{urlHash, authorId?, since?, video?: {t, paused}, follows?}` →
  the room's messages (last 24 h), `alive` (ids still visible), `here` (who had the chat
  open in the last 30 s, with `video` = position in the video, `follows` and `followers` for
  watching together), `hereCount` (how many are in the chat, uncapped), `annRev` (changes
  when annotations appear/disappear on the page), `canWrite`, `blocked`, `now`
- `POST /api/chat/here` — `{urlHash, exclude?}` → `{count}`: how many have the chat open now
  (the number on the chat button); `exclude` = your hash, so you're not counted
- `POST /api/chat` — `{urlHash, authorId, text}`: new message (account only, ≤ 300
  characters, 6/minute, 1 every 2 s)
- `DELETE /api/chat/:id` — `{authorId}`: the author deletes their message
- `POST /api/chat/:id/report` — `{reporterId, reason}`; after 3 reports from accounts older
  than one day the message is hidden (all reports reach a moderator)

### Moderation (`/admin`)
All admin routes need `Authorization: Bearer <token>` (no CORS); the UI is at `/admin`.
- Roles: `ADMIN_TOKEN` = owner; per-person tokens created from the Moderators tab
  (`GET/POST /api/admin/tokens`, `POST /api/admin/tokens/:id/revoke`), role `owner` or
  `moderator`. A moderator can NOT: delete users, reset passwords, give reserved names,
  download the backup, manage tokens, view the log. `GET /api/admin/me` → `{name, role}`;
  `GET /api/admin/log` — action log (owner). Only the SHA-256 of a token is stored.
- `GET /api/admin/queue?status=reported|removed`, `POST /api/admin/annotations/:id/remove`
  `{reason}`, `POST /api/admin/annotations/:id/restore` — removed annotations disappear for
  everyone, are kept as a record and are permanently deleted after 2 years
- `GET /api/admin/users` — everyone who wrote, voted, reported or picked a name: name,
  password account, annotations (and how many visible), votes, reports, first/last activity
- `POST /api/admin/users/reset-password` — `{name}`: temporary password (shown once) + the
  account's annotation count and latest annotations, so the moderator can verify the request
- `POST /api/admin/users/:authorHash/set-name` — `{name}`: the moderator sets a name, even a
  reserved one (e.g. “Adormis” for the owner); still unique
- `POST /api/admin/users/:authorHash/reset-name` — the moderator removes an unsuitable name
- `POST /api/admin/users/:authorHash/delete` — delete a user: their annotations, votes and
  reports given (scores are corrected), name/account
- `GET /api/admin/backup` — download a copy of the database (private: contains secret IDs
  and password hashes)
- `GET /api/admin/chat`, `POST /api/admin/chat/:id/remove|restore`,
  `POST /api/admin/users/:authorHash/chat-block` `{blocked}` — chat moderation

### Limits
120 requests/minute per IP across the API, plus 20/minute on write routes.

---

## Română

Endpoint-uri disponibile:
- `GET /api/health` — `{ok: true}`
- `GET /api/version` — conținutul `version.json` (`{latest, notes}`), pentru beculețul de update
- `GET /api/annotations?urlHash=<sha256(url)>[&minVotes=N]` — listă adnotări pentru o pagină,
  identificată prin amprenta SHA-256 (hex) a adresei, nu prin adresa în sine
  (`?url=` mai merge doar pentru extensiile vechi, ≤ 0.2.3). Fără `minVotes` le trimite pe
  toate; extensia face Top 10 pe pagină cu cel mult o adnotare per utilizator (cea mai bună a
  lui: scor, apoi vechime) și arată pe pagină doar adnotările din top. Plafon de siguranță:
  cel mult 2000 pe pagină (de neatins în practică); peste el se păstrează cele mai votate, deci
  Topul pe pagină rămâne corect
- `GET /api/users/:authorHash` — numele afișat al unui utilizator (`null` dacă nu are)
- `POST /api/users/name` — `{authorId, name}`: își alege / schimbă numele (gol = îl șterge); unic
  după o cheie fără majuscule, diacritice, spații și `. _ -` (409 dacă e luat), 2–24 caractere,
  nume rezervate refuzate (admin…, moderator…, adormis…, utilizator… ca început; tu, mod, staff etc. doar ca nume întreg); max. 10 schimbări/minut. Răspunsurile cu adnotări au `authorName`
- `GET /api/admin/users` — toți utilizatorii care au scris, votat, raportat sau și-au ales un nume:
  nume, cont cu parolă, adnotări (și câte vizibile), voturi, raportări, prima/ultima activitate (tab „Utilizatori” din /admin, cu căutare)
- `POST /api/admin/users/reset-password` — `{name}`: parolă temporară (arătată o singură dată) +
  numărul și ultimele adnotări ale contului, ca moderatorul să verifice cererea; fără garanție pentru utilizator
- `POST /api/admin/users/:authorHash/set-name` — `{name}`: moderatorul dă un nume, inclusiv unul
  rezervat (ex. „Adormis” pentru proprietar); tot unic
- `POST /api/admin/users/:authorHash/reset-name` — moderatorul șterge un nume nepotrivit
- `POST /api/admin/users/:authorHash/delete` — moderatorul șterge un utilizator: adnotările lui, voturile și raportările date (scorurile se corectează), numele/contul
- `GET /api/admin/backup` — descarcă o copie a bazei de date (privată: conține ID-urile secrete și hash-urile parolelor)
- Roluri în /admin: `ADMIN_TOKEN` = proprietar; tokenuri pe persoană create din tabul Moderatori (`GET/POST /api/admin/tokens`, `POST /api/admin/tokens/:id/revoke`), rol `owner` sau `moderator`. Moderatorul NU poate: șterge utilizatori, reseta parole, da nume rezervate, descărca backup-ul, gestiona tokenuri, vedea jurnalul. `GET /api/admin/me` → `{name, role}`; `GET /api/admin/log` — jurnalul acțiunilor (proprietar). În baza de date stă doar SHA-256 al tokenului.
- `POST /api/chat/poll` — `{urlHash, authorId?, since?, video?: {t, paused}, follows?}` → mesajele camerei (ultimele 24 h), `alive` (id-urile încă vizibile), `here` (cine are chatul deschis în ultimele 30 s, cu `video` = minutul din video, `follows` și `followers` pentru vizionarea împreună), `hereCount` (câți sunt în chat, fără plafon), `annRev` (se schimbă când apar/dispar adnotări pe pagină), `canWrite`, `blocked`, `now`
- `POST /api/chat/here` — `{urlHash, exclude?}` → `{count}`: câți au chatul deschis acum (cifra de pe butonul de chat); `exclude` = amprenta ta, ca să nu te numeri
- `POST /api/chat` — `{urlHash, authorId, text}`: mesaj nou (doar cu cont, ≤ 300 caractere, 6/minut, 1 la 2 s)
- `DELETE /api/chat/:id` — `{authorId}`: autorul își șterge mesajul
- `POST /api/chat/:id/report` — `{reporterId, reason}`; la 3 raportări de la conturi mai vechi de o zi mesajul se ascunde (toate ajung la moderator)
- `GET /api/admin/chat`, `POST /api/admin/chat/:id/remove|restore`, `POST /api/admin/users/:authorHash/chat-block` `{blocked}` — moderarea chatului
- `POST /api/users/me` — `{authorId}` → `{name, hasPassword, freeLeft}` (`freeLeft` = câte adnotări mai poate face azi cine n-are cont; `null` cu cont)
- `POST /api/users/password` — `{authorId, password}` (min. 8): creează contul (cel mult 3 conturi noi pe zi de pe același IP) / schimbă parola;
  cere un nume ales (= numele de utilizator); parola doar ca hash scrypt
- `POST /api/users/login` — `{name, password, currentAuthorId?}` → `{authorId, hash, name}`;
  identitatea curentă a calculatorului se mută în cont (adnotări, voturi, raportări); 10 încercări / 15 min
- `GET /privacy` — politica de confidențialitate (pagină statică din `server/legal`, fără resurse externe);
  e adresa oficială folosită de extensie și în Chrome Web Store
- `GET /api/annotations/by-author/:authorHash` — profilul public al unui utilizator: adnotările
  lui vizibile de pe toate paginile, după voturi (apoi vechime), max. 500
- `POST /api/annotations/mine` — `{authorId}`: toate adnotările autorului, de pe toate
  paginile (panoul „Ale mele → Toate”), cele mai noi primele, max. 500
- `GET /api/annotations/top?limit=10` — cele mai votate adnotări de pe toate paginile, după voturile celor cu cont (`votes` = acel scor); cu `&v=<versiune>` → `{v, items}` sau doar `{v, same: true}` dacă Topul nu s-a schimbat de la versiunea aceea
  (min. 1 vot, `limit` max. 50, cache 10s)
- `GET /api/annotations/stats?urlHash=<sha256(url)>` — numărul de adnotări pe tipuri:
  `{global: {total, byType, withLink, pages, users}, page: {total, byType, withLink}}`
  (`users` = câți au scris, votat, raportat sau și-au ales nume; `page` doar dacă e dată pagina; partea globală are cache 30s)
- `POST /api/annotations` — creează `{url, type, data, authorId}`
  - fără cont (nume + parolă): cel mult 3 adnotări în 24 h și fără linkuri → `403 {error, needAccount: true}` (la fel `PATCH` cu `url`)
- `PATCH /api/annotations/:id` — `{authorId, patch}` (mutare sau editare text/link; doar autorul)
- `DELETE /api/annotations/:id` — `{authorId}` (doar autorul își poate șterge propria adnotare)
- `authorId` e secretul autorului (generat local de extensie): nu apare în niciun răspuns —
  răspunsurile conțin doar `authorHash` (primele 32 de caractere hex din SHA-256(authorId))
- `POST /api/annotations/:id/vote` — `{voterId, direction: "up"|"down"}` (un vot pe adnotare
  per votant; autorul nu-și poate vota adnotările (403); cel mult 5 votanți per adresă IP,
  amprentată cu `IP_HASH_SECRET` (429 peste)
- `POST /api/annotations/:id/report` — `{reporterId, reason, details?, goodFaith: true}`;
  `reason` ∈ `illegal|hate|harassment|personal_data|sexual|spam|copyright|other`; o raportare
  per raportor și per IP; auto-ascundere la 5 raportări de la conturi mai vechi de o zi, până la verificarea unui moderator (cele fără cont ajung doar în coadă)
- `GET /api/admin/queue?status=reported|removed`, `POST /api/admin/annotations/:id/remove`
  `{reason}`, `POST /api/admin/annotations/:id/restore` — moderare, cu
  `Authorization: Bearer <ADMIN_TOKEN>` (fără CORS); interfața e la `/admin`. Adnotările
  scoase dispar pentru toți, rămân ca evidență și se șterg definitiv după 2 ani
- `POST /api/check-url` — `{url}` → `{safe, checked, threats}` (verificare URLhaus;
  fără `URLHAUS_AUTH_KEY` linkurile trec)

Limite: 120 cereri/minut per IP pe tot API-ul, plus 20/minut pe rutele de scriere.
