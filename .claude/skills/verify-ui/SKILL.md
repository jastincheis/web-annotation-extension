---
name: verify-ui
description: Verifică în Chrome o modificare din extensia Adormis (content script, toolbar, unelte, panouri, popup) — DOM/consolă întâi, screenshot doar pentru aspect. Folosește după orice schimbare în extension/ sau când utilizatorul cere /verify-ui.
---

# Verificare UI Adormis

Argument opțional: ce s-a schimbat / ce trebuie verificat (ex. „unealta spray”, „panoul Ale mele”).
Fără argument, deduce din `git diff` ce fișiere din `extension/` s-au modificat și verifică acele zone.

## 1. Pregătire

1. Backend local: `curl -s localhost:4000/api/health`. Dacă nu răspunde, pornește-l în fundal
   (`cd server && npm run dev`, cu `run_in_background`). Nu porni o a doua instanță.
2. Încarcă tool-urile Chrome într-un singur ToolSearch (tabs_context_mcp, tabs_create_mcp, navigate,
   javascript_tool, find, read_console_messages, computer, browser_batch), apoi `tabs_context_mcp`.
3. **Reîncarcă extensia**: navighează la `chrome://extensions` și apasă reload pe Adormis. Dacă
   pagina `chrome://` nu e accesibilă, cere-i utilizatorului s-o reîncarce manual și așteaptă.
   Fără reload, Chrome rulează codul vechi.
4. Deschide un tab nou cu pagina de test (implicit `https://example.com`; pentru funcții video,
   o pagină cu `<video>` — întreabă utilizatorul dacă nu e evident care).
5. Extensia trebuie să vorbească cu serverul local: dacă adnotările nu apar/nu se salvează, verifică
   „Adresă server” din popup (`http://localhost:4000`) — popup-ul nu e accesibil din tab, deci
   cere-i utilizatorului să-l seteze dacă e nevoie.

## 2. Verificări DOM (preferate)

`javascript_tool` rulează în lumea paginii: vede DOM-ul extensiei, dar **nu** `window.WA_*`.
Clickurile din DOM ajung la handler-ele extensiei, deci poți acționa UI-ul prin script.

Grupează verificările într-un singur apel, de ex.:

```js
const q = (s) => document.querySelector(s);
({
  injected: !!q('#wa-root'),
  topbar: !!q('#wa-topbar'),
  toolbarVisible: (() => { const t = q('#wa-toolbar'); return !!t && getComputedStyle(t).display !== 'none'; })(),
  tools: [...document.querySelectorAll('.wa-tool[data-tool]')].map(b => b.dataset.tool + (b.classList.contains('active') ? '*' : '')),
  svgAnnotations: q('#wa-svg-layer')?.childElementCount,
  domAnnotations: q('#wa-elements-layer')?.childElementCount,
  videoLayer: !!q('#wa-video-root'),
})
```

Acțiuni utile:
- Deschide toolbar-ul: `document.getElementById('wa-toggle-btn').click()`
- Alege o unealtă: `document.querySelector('.wa-tool[data-tool="pen"]').click()`
  (`select`, `pen`, `spray`, `shape`, `bubble`, `text`, `link`)
- Panouri: `#wa-leaderboard-panel`, `#wa-mine-panel`, `#wa-mine-list`
- Popover-uri temporare: `.wa-popover`, `.wa-lb-detail`, `.wa-spray-confirm`

Apoi:
- `read_console_messages` cu `pattern: "Adormis|wa-|Error"` — nicio eroare nouă.
- Pentru salvare/vot/ștergere: confirmă și pe backend cu
  `curl -s "localhost:4000/api/annotations?url=<url-encodat>"` (URL-ul e `origin + pathname + search`).

## 3. Interacțiuni reale (doar când e nevoie)

Desenul (pen/spray/shape) și drag/resize/rotate cer evenimente de mouse reale — folosește `computer`
(left_click_drag) pentru ele, după ce ai ales unealta prin script. Grupează pașii cu `browser_batch`.

## 4. Screenshot

Doar când trebuie judecat aspectul: poziționare, suprapuneri, stil, comportament peste video/fullscreen.
Un screenshot la final per zonă modificată e suficient.

## 5. Raport

Listă scurtă: fiecare verificare → ✅/❌ cu dovada (valoare DOM, linie de consolă, răspuns curl).
Dacă ceva pică: diagnostichează, repară, reîncarcă extensia + pagina și reverifică. Nu declara
„merge” fără o verificare după ultimul reload. Șterge adnotările de test create (DELETE cu
`authorId`-ul lor, vizibil în răspunsul de la GET) dacă utilizatorul nu vrea să le păstreze.
