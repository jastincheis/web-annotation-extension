// Adormis — content script principal.
// Injectează un layer transparent peste pagină pentru desen/adnotări
// și randează adnotările salvate de toți utilizatorii pentru acest URL.
(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    userId: null, // secret local — vezi getIdentity (lib/storage.js)
    consent: false, // acordul pentru trimiterea datelor — vezi showConsentDialog
    userHash: null, // amprenta publică a lui userId (authorHash din răspunsurile serverului)
    toolbarVisible: false,
    activeTool: null, // 'pen' | 'spray' | 'shape' | 'text' | 'video'
    shapeKind: "circle", // 'circle' | 'arrow'
    color: "#89CFF0", // baby blue
    strokeWidth: 4,
    rankVisible: new Set(), // id-urile din Top 10 al paginii (câte una per utilizator) — vezi refreshRanking
    pageTop: [], // Top 10 al paginii — vezi refreshRanking
    revealed: new Set(), // adnotări din afara topului arătate la cerere (salt din profil/"Ale mele")
    panelUser: null, // amprenta utilizatorului al cărui profil e deschis (a ta = "Ale mele")
    panelAll: null, // adnotările lui de pe toate paginile, aduse de pe server la cerere
    topMode: "page", // panoul Top: "page" (clasamentul paginii) sau "global" (de pe toate paginile)
    mineScope: "page", // panoul de profil: "page" (pagina asta) sau "all" (toate paginile)
    mineQuery: "", // căutarea din panoul de profil
    myPanelOpen: false, // panoul "Ale mele" — cât e deschis, adnotările proprii sunt forțat vizibile
    annotationsLoaded: false, // devine true după ce loadExisting() termină prima cerere către server — vezi renderMineList
    annotations: new Map(), // id -> { ann, el, refEl }
    globalTop: [], // top 10 de pe TOATE paginile (nu doar cea curentă) — vezi refreshGlobalTop
  };

  let els = {};
  let pendingToolFinish = null; // dacă o unealtă are o sesiune deschisă (ex. spray), finalizeaz-o la schimbarea uneltei

  const SENSITIVE_PARAM =
    /^(.*token.*|code|state|nonce|otp|session.*|sid|ssid|auth.*|.*key|password|pass|pwd|secret|sig|signature|hash|email|e-?mail|phone|tel|ticket|reset.*|verify.*|confirm.*)$/i;

  // Pagini care nu sunt publice: localhost, adrese IP, rețele interne. Pe ele extensia nu
  // pornește deloc — nici măcar amprenta adresei nu pleacă spre server. Excepție: când
  // serverul extensiei e el însuși local (dezvoltare), ca să se poată testa local.
  function isPrivatePage() {
    if (!/^https?:$/.test(location.protocol)) return true;
    const h = location.hostname.toLowerCase();
    if (!h.includes(".") || h === "localhost" || h.endsWith(".localhost")) return true;
    if (/\.(local|lan|internal|intranet|home|corp|test|example|invalid)$/.test(h)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[") || h.includes(":")) return true; // IPv4/IPv6
    return false;
  }

  function isLocalServer(url) {
    try {
      const h = new URL(url).hostname;
      return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
    } catch {
      return false;
    }
  }

  function pageKey() {
    // Pe YouTube, același video apare cu parametri în plus (&t=, &list=, &pp=...) —
    // fără normalizare, un link cu timestamp sau din playlist părea altă pagină și
    // adnotările nu se mai încărcau. Păstrăm doar ID-ul video-ului.
    if (/(^|\.)youtube\.com$/.test(location.hostname) && location.pathname === "/watch") {
      const v = new URLSearchParams(location.search).get("v");
      if (v) return location.origin + "/watch?v=" + v;
    }
    // Netflix: /watch/<id>?trackId=...&tctx=... — parametrii diferă de la om la om și de la
    // sesiune la sesiune, deci fiecare ar fi văzut doar propriile adnotări. ID-ul e în cale.
    if (/(^|\.)netflix\.com$/.test(location.hostname) && /^\/watch\/\d+/.test(location.pathname)) {
      return location.origin + location.pathname.match(/^\/watch\/\d+/)[0];
    }
    // Parametri de urmărire (reclame, share-uri) nu schimbă conținutul paginii — fără ei,
    // același link deschis din Facebook/newsletter ar fi părut altă pagină. Cei SENSIBILI
    // (token-uri de login/resetare parolă, coduri, sesiuni, email) nu au ce căuta într-o
    // adresă salvată pe server odată cu o adnotare publică — îi scoatem și pe ei.
    const params = new URLSearchParams(location.search);
    [...params.keys()].forEach((k) => {
      if (/^(utm_.+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga)$/i.test(k)) params.delete(k);
      else if (SENSITIVE_PARAM.test(k)) params.delete(k);
    });
    const search = params.toString();
    return location.origin + location.pathname + (search ? "?" + search : "");
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    children.forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return node;
  }

  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  // ---------- Layout ----------

  // #wa-root e "position: absolute", copil DIRECT al <html> — propria lui înălțime
  // (setată tot de funcția asta, via sizeLayers) intră în calculul lui
  // document.documentElement.scrollHeight, care e citit AICI ca să calculeze
  // înălțimea următoare: o buclă de auto-alimentare care doar crește (Math.max),
  // niciodată nu scade. Pe o pagină cu activitate DOM normală (orice site — și
  // MutationObserver-ul de mai jos recalculează la fiecare mutație), înălțimea
  // explodează în câteva interacțiuni la sute de mii de pixeli — bug confirmat
  // live: 10 464px conținut real -> 138 080px după un singur test cu o bulă.
  // Măsurăm cu #wa-root scos temporar din calcul (height: 0), ca
  // documentElement.scrollHeight să reflecte DOAR conținutul real al paginii.
  function docHeight() {
    const prevHeight = els.root.style.height;
    els.root.style.height = "0px";
    const h = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      window.innerHeight
    );
    els.root.style.height = prevHeight;
    return h;
  }

  function sizeLayers() {
    const h = docHeight();
    els.root.style.height = h + "px";
    els.svg.setAttribute("width", "100%");
    els.svg.setAttribute("height", h);
  }

  // ---------- Bootstrap UI ----------

  function buildOverlay() {
    els.root = el("div", { id: "wa-root" });
    els.svg = svgEl("svg", { id: "wa-svg-layer" });
    els.elements = el("div", { id: "wa-elements-layer" });

    // Strat "geamăn", separat de #wa-root: găzduiește DOAR adnotările legate de
    // video (videoRange) cât timp video-ul e în Fullscreen API real. Fullscreen-ul
    // randează DOAR subarborele elementului aflat în fullscreen — #wa-root, fiind
    // frate cu <html>, devine complet invizibil altfel. Vezi enterVideoFullscreen/
    // exitVideoFullscreen mai jos, unde stratul ăsta e mutat efectiv în interiorul
    // lui document.fullscreenElement cât ține fullscreen-ul, și înapoi la ieșire.
    els.videoRoot = el("div", { id: "wa-video-root" });
    els.videoSvg = svgEl("svg", { id: "wa-video-svg-layer" });
    els.videoElements = el("div", { id: "wa-video-elements-layer" });
    els.videoRoot.appendChild(els.videoSvg);
    els.videoRoot.appendChild(els.videoElements);

    els.topbar = buildTopbar();
    els.toolbar = buildToolbar();
    els.leaderboardPanel = buildLeaderboardPanel();
    els.minePanel = buildMinePanel();

    els.root.appendChild(els.svg);
    els.root.appendChild(els.elements);
    document.documentElement.appendChild(els.root);
    document.documentElement.appendChild(els.videoRoot);
    document.documentElement.appendChild(els.topbar);
    document.documentElement.appendChild(els.toolbar);
    document.documentElement.appendChild(els.stylePopover);
    document.documentElement.appendChild(els.statsPopover);
    document.documentElement.appendChild(els.leaderboardPanel);
    document.documentElement.appendChild(els.minePanel);

    sizeLayers();
    positionToolbar();
    positionLeaderboardPanel();
    positionMinePanel();
    window.addEventListener("resize", () => {
      sizeLayers();
      positionToolbar();
      positionLeaderboardPanel();
      positionMinePanel();
    });
    // resize/zoom pot rearanja pagina (layout responsive) — recalculăm pozițiile ancorate
    window.addEventListener("resize", debounce(repositionAnchoredAnnotations, 150));
    new MutationObserver(() => sizeLayers()).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // Iconițe desenate (stil linie, 24×24) — înlocuiesc emoji-urile, care arătau diferit pe
  // fiecare sistem de operare și nu se puteau colora după starea butonului.
  const ICONS = {
    select: '<path d="M5 3l14 7-6 2-2 6z"/>',
    pen: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>',
    spray: '<rect x="6" y="9" width="8" height="12" rx="2"/><path d="M8 9V6h4v3"/><path d="M17 5h.01M20 3h.01M20 7h.01M17 9h.01"/>',
    shape: '<circle cx="12" cy="12" r="8"/>',
    bubble: '<path d="M4 5h16v11H9l-5 4z"/>',
    text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/>',
    pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    grip: '<path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01"/>',
    mark: '<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M3 22h8"/>',
  };

  function icon(name) {
    const span = document.createElement("span");
    span.className = "wa-ico";
    // markup static, din ICONS de mai sus — nu conține nimic venit din pagină
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  }

  // Unealtă → [etichetă, tastă]. Tastele merg doar cât dock-ul e deschis (vezi key-guard.js).
  const TOOLS = [
    ["select", "Selectează / navighează normal", "V"],
    ["pen", "Creion", "P"],
    ["spray", "Spray graffiti", "S"],
    ["shape", "Formă — click și trage", "F"],
    ["bubble", "Bulă cu text — click pe pagină", "B"],
    ["text", "Text mișcabil — click pe pagină", "T"],
    ["link", "Link către alt conținut — click pe pagină", "L"],
  ];
  const SWATCHES = ["#89CFF0", "#F472B6", "#FACC15", "#4ADE80", "#F87171", "#FFFFFF", "#111111"];
  const WIDTHS = [2, 4, 8, 14];
  const SHAPES = [
    ["circle", "Cerc"],
    ["rectangle", "Dreptunghi"],
    ["square", "Pătrat"],
    ["triangle", "Triunghi"],
    ["diamond", "Romb"],
    ["star", "Stea"],
    ["arrow", "Săgeată"],
  ];

  // Dock flotant (varianta A din propunerile de design): o pastilă compactă, sus pe centru,
  // care se poate trage de mâner oriunde și își ține minte locul pe fiecare site. Stă sus
  // (nu jos) ca să nu se bată cu comenzile player-ului pe YouTube/Netflix.
  function buildToolbar() {
    const btn = (cls, iconName, title, onclick, extra = {}) =>
      el("button", { class: `wa-dock-btn ${cls}`, title, "aria-label": title, onclick, ...extra }, icon(iconName));

    const grip = el("span", { class: "wa-dock-grip", title: "Trage ca să muți bara" }, icon("grip"));
    const tools = TOOLS.map(([tool, label, key]) =>
      btn("wa-tool", tool, `${label} (${key})`, () => setActiveTool(tool), { "data-tool": tool })
    );

    els.colorDot = el("span", { class: "wa-color-dot" });
    els.styleBtn = el(
      "button",
      { class: "wa-dock-btn wa-style-btn", title: "Culoare, grosime, formă", "aria-label": "Culoare, grosime, formă", onclick: () => toggleStylePopover() },
      els.colorDot
    );
    els.mineBtn = btn("wa-mine-btn", "pin", "Adnotările mele pe pagina asta", () => setMinePanelOpen(!state.myPanelOpen));
    els.topBtn = btn("wa-top-btn", "trophy", "Arată / ascunde Topul", () => toggleLeaderboard());
    const closeBtn = btn("wa-close", "close", "Închide bara (Esc)", () => toggleToolbar(false));

    els.counterBtn = el(
      "button",
      { class: "wa-dock-btn wa-counter", title: "Câte adnotări sunt (click pentru detalii)", onclick: () => toggleStatsPopover() },
      el("span", { class: "wa-counter-num" }, "0")
    );
    const dock = el(
      "div",
      { id: "wa-toolbar", hidden: "true" },
      grip,
      els.counterBtn,
      el("span", { class: "wa-dock-sep" }),
      ...tools,
      el("span", { class: "wa-dock-sep" }),
      els.styleBtn,
      el("span", { class: "wa-dock-sep" }),
      els.mineBtn,
      els.topBtn,
      closeBtn
    );
    els.stylePopover = buildStylePopover();
    els.statsPopover = buildStatsPopover();
    wireDockDragging(dock, grip);
    refreshStyleControls();
    tools[0].classList.add("active"); // „Selectează” = starea de pornire (nicio unealtă activă)
    els.topBtn.classList.add("active"); // Topul e vizibil implicit
    return dock;
  }

  function buildStylePopover() {
    const swatches = SWATCHES.map((c) =>
      el("button", { class: "wa-swatch", "data-color": c, title: c, style: `background:${c}`, onclick: () => setStyle({ color: c }) })
    );
    const custom = el("input", {
      type: "color",
      class: "wa-swatch-custom",
      title: "Altă culoare",
      value: state.color,
      oninput: (e) => setStyle({ color: e.target.value }),
    });
    const widths = WIDTHS.map((w) =>
      el(
        "button",
        { class: "wa-width", "data-width": String(w), title: `Grosime ${w}`, onclick: () => setStyle({ strokeWidth: w }) },
        el("i", { style: `width:${8 + w * 1.4}px;height:${Math.max(2, w * 0.8)}px` })
      )
    );
    const shapes = SHAPES.map(([kind, label]) =>
      el("button", { class: "wa-shape-kind", "data-shape": kind, onclick: () => setStyle({ shapeKind: kind }) }, label)
    );
    const pop = el(
      "div",
      { id: "wa-style-popover", hidden: "true" },
      el("div", { class: "wa-pop-label" }, "Culoare"),
      el("div", { class: "wa-pop-row" }, ...swatches, custom),
      el("div", { class: "wa-pop-label" }, "Grosime"),
      el("div", { class: "wa-pop-row" }, ...widths),
      el("div", { class: "wa-pop-label" }, "Formă"),
      el("div", { class: "wa-pop-row wa-pop-wrap" }, ...shapes)
    );
    stopKeysPropagating(pop);
    return pop;
  }

  // ---------- Contor de adnotări ----------
  // Numărul mare din dock = adnotările de pe pagina curentă (același număr apare ca bulină pe
  // butonul rotund). Click = panou cu defalcarea pe tipuri, pentru pagină și pentru toată
  // aplicația (de la server, /api/annotations/stats).
  const COUNT_TYPES = [
    ["pen", "Desene"],
    ["spray", "Graffiti"],
    ["shape", "Forme"],
    ["text", "Texte"],
    ["bubble", "Bule"],
    ["link", "Linkuri"],
    ["video_bubble", "Bule video"],
  ];
  let statsScope = "page"; // "page" | "global"
  let globalStats = null;

  function pageStats() {
    const byType = {};
    let withLink = 0;
    state.annotations.forEach(({ ann }) => {
      byType[ann.type] = (byType[ann.type] || 0) + 1;
      if (hasAttachedLink(ann)) withLink++;
    });
    return { total: state.annotations.size, byType, withLink };
  }

  function formatCount(n) {
    return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
  }

  // Apelat la orice schimbare a listei de adnotări (adăugare, ștergere, navigare, link nou).
  function refreshCounter() {
    if (!els.counterBtn) return;
    const n = state.annotations.size;
    els.counterBtn.querySelector(".wa-counter-num").textContent = formatCount(n);
    els.launcherBadge.textContent = formatCount(n);
    els.launcherBadge.hidden = n === 0;
    if (!els.statsPopover.hidden) renderStats();
  }

  function buildStatsPopover() {
    const tab = (scope, label) =>
      el("button", { class: "wa-stats-tab", "data-scope": scope, onclick: () => setStatsScope(scope) }, label);
    return el(
      "div",
      { id: "wa-stats-popover", hidden: "true" },
      el("div", { class: "wa-stats-tabs" }, tab("page", "Pagina asta"), tab("global", "Toată aplicația")),
      el("div", { class: "wa-stats-body" })
    );
  }

  function setStatsScope(scope) {
    statsScope = scope;
    renderStats();
    if (scope === "global") loadGlobalStats();
  }

  async function loadGlobalStats() {
    if (!state.consent) return;
    try {
      globalStats = (await WA_Api.getStats()).global;
    } catch (err) {
      console.error("[Adormis] Nu am putut citi statisticile:", err);
      globalStats = { error: true };
    }
    if (statsScope === "global") renderStats();
  }

  function renderStats() {
    const pop = els.statsPopover;
    pop.querySelectorAll(".wa-stats-tab").forEach((b) => b.classList.toggle("active", b.dataset.scope === statsScope));
    const body = pop.querySelector(".wa-stats-body");
    body.textContent = "";
    const data = statsScope === "page" ? pageStats() : globalStats;
    if (!data) {
      body.appendChild(el("div", { class: "wa-stats-empty" }, "Se încarcă…"));
      return;
    }
    if (data.error) {
      body.appendChild(el("div", { class: "wa-stats-empty" }, "Nu am putut citi numerele de pe server."));
      return;
    }
    body.appendChild(el("div", { class: "wa-stats-total" }, data.total.toLocaleString("ro-RO")));
    body.appendChild(
      el(
        "div",
        { class: "wa-stats-caption" },
        statsScope === "page"
          ? data.total === 1 ? "adnotare pe pagina asta" : "adnotări pe pagina asta"
          : `adnotări pe ${data.pages.toLocaleString("ro-RO")} ${data.pages === 1 ? "pagină" : "pagini"}`
      )
    );
    const max = Math.max(1, ...COUNT_TYPES.map(([t]) => data.byType[t] || 0));
    COUNT_TYPES.forEach(([type, label]) => {
      const n = data.byType[type] || 0;
      if (!n && type === "video_bubble") return; // tip vechi, arătat doar dacă există
      body.appendChild(
        el(
          "div",
          { class: "wa-stats-row" + (n ? "" : " wa-zero") },
          el("span", { class: "wa-stats-ico" }, annotationIcon(type)),
          el("span", { class: "wa-stats-label" }, label),
          el("span", { class: "wa-stats-bar" }, el("i", { style: `width:${(n / max) * 100}%` })),
          el("span", { class: "wa-stats-n" }, n.toLocaleString("ro-RO"))
        )
      );
    });
    if (data.withLink) {
      body.appendChild(el("div", { class: "wa-stats-foot" }, `🔗 ${data.withLink} cu link atașat`));
    }
  }

  function toggleStatsPopover(force) {
    const open = typeof force === "boolean" ? force : els.statsPopover.hidden;
    els.statsPopover.hidden = !open;
    els.counterBtn.classList.toggle("active", open);
    if (!open) return;
    renderStats();
    if (statsScope === "global") loadGlobalStats();
    positionStatsPopover();
  }

  function positionStatsPopover() {
    const r = els.counterBtn.getBoundingClientRect();
    const w = els.statsPopover.offsetWidth || 260;
    els.statsPopover.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + "px";
    els.statsPopover.style.top = r.bottom + 8 + "px";
  }

  // Culoarea / grosimea / forma alese rămân aceleași pe toate site-urile, și după reload.
  const STYLE_KEY = "wa_style";

  function setStyle(patch) {
    Object.assign(state, patch);
    refreshStyleControls();
    chrome.storage.local
      .set({ [STYLE_KEY]: { color: state.color, strokeWidth: state.strokeWidth, shapeKind: state.shapeKind } })
      .catch(() => {});
  }

  async function loadStyle() {
    try {
      const { [STYLE_KEY]: saved } = await chrome.storage.local.get(STYLE_KEY);
      if (saved) Object.assign(state, saved);
    } catch {}
    refreshStyleControls();
  }

  function refreshStyleControls() {
    if (!els.stylePopover) return;
    els.colorDot.style.background = state.color;
    const custom = els.stylePopover.querySelector(".wa-swatch-custom");
    if (/^#[0-9a-f]{6}$/i.test(state.color)) custom.value = state.color.toLowerCase();
    els.stylePopover.querySelectorAll(".wa-swatch").forEach((b) =>
      b.classList.toggle("active", b.dataset.color.toLowerCase() === state.color.toLowerCase())
    );
    els.stylePopover.querySelectorAll(".wa-width").forEach((b) =>
      b.classList.toggle("active", Number(b.dataset.width) === state.strokeWidth)
    );
    els.stylePopover.querySelectorAll(".wa-shape-kind").forEach((b) =>
      b.classList.toggle("active", b.dataset.shape === state.shapeKind)
    );
  }

  function toggleStylePopover(force) {
    const open = typeof force === "boolean" ? force : els.stylePopover.hidden;
    els.stylePopover.hidden = !open;
    els.styleBtn.classList.toggle("active", open);
    if (open) positionStylePopover();
  }

  function positionStylePopover() {
    const r = els.styleBtn.getBoundingClientRect();
    const pop = els.stylePopover;
    const w = pop.offsetWidth || 240;
    pop.style.left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8) + "px";
    pop.style.top = r.bottom + 8 + "px";
  }

  function toggleLeaderboard(force) {
    const show = typeof force === "boolean" ? force : els.leaderboardPanel.hidden;
    els.leaderboardPanel.hidden = !show;
    els.topBtn?.classList.toggle("active", show);
    chrome.storage.local.set({ wa_top_hidden: !show }).catch(() => {});
  }

  // Butonul rotund de pornire (înlocuiește tab-ul vertical din stânga): stă pe jumătate
  // ascuns pe marginea din dreapta și iese la hover (CSS). Cât e deschis dock-ul, dispare —
  // dock-ul are propriul ✕.
  function buildTopbar() {
    els.toggleBtn = el(
      "button",
      { id: "wa-toggle-btn", onclick: () => toggleToolbar(), title: "Adormis — desenează pe pagină (Alt+A)", "aria-label": "Deschide Adormis" },
      icon("mark")
    );
    els.launcherBadge = el("span", { class: "wa-count-badge", hidden: "true" });
    return el("div", { id: "wa-topbar" }, els.toggleBtn, els.launcherBadge);
  }

  // Panou permanent — doar 10 bile statice, lipite de marginea din dreapta, TOP GLOBAL
  // de pe toate paginile adnotate (vezi refreshGlobalTop). Colorate dacă locul e ocupat,
  // gri dacă nu. Hover pe o bilă = tooltip nativ cu numele și pagina; click = detalii
  // complete (și, dacă adnotarea e pe altă pagină, un buton ca să sari acolo).
  function buildLeaderboardPanel() {
    els.leaderboardSlots = [];
    els.topModeBtn = el("button", { class: "wa-lb-mode", onclick: () => setTopMode(state.topMode === "page" ? "global" : "page") });
    const slots = [els.topModeBtn];
    for (let i = 1; i <= 10; i++) {
      const slot = el("div", { class: "wa-lb-slot" }, String(i));
      els.leaderboardSlots.push(slot);
      slots.push(slot);
    }
    return el("div", { id: "wa-leaderboard-panel" }, ...slots);
  }

  // Panou lateral, ascuns implicit — se deschide AUTOMAT odată cu tab-ul (nu mai
  // există un buton separat "Ale mele" de apăsat): hover pe tab = apar direct
  // adnotările tale, cu tip/minut/voturi, fără niciun click intermediar. Se închide
  // fie prin ✕-ul propriu, fie prin ✕-ul tab-ului (closeTopbarNow), fie automat când
  // se retrage tab-ul. Lista se umple în renderMineList(); aici doar construim
  // scheletul static.
  function buildMinePanel() {
    els.mineList = el("div", { id: "wa-mine-list" });
    els.mineTitle = el("span", {}, "📍 Adnotările mele");
    els.mineCount = el("div", { class: "wa-mine-count" });
    const tab = (scope, label) =>
      el("button", { class: "wa-mine-tab", "data-scope": scope, onclick: () => setMineScope(scope) }, label);
    els.mineTabs = [tab("page", "Pagina asta"), tab("all", "Toate paginile")];
    els.mineSearch = el("input", {
      class: "wa-mine-search",
      type: "search",
      placeholder: "🔎 Caută în adnotări…",
      oninput: () => {
        state.mineQuery = els.mineSearch.value;
        renderMineList();
      },
    });
    stopKeysPropagating(els.mineSearch);
    return el(
      "div",
      { id: "wa-mine-panel", hidden: "true" },
      el(
        "div",
        { class: "wa-mine-header" },
        els.mineTitle,
        el("button", { class: "wa-mine-close", onclick: () => setMinePanelOpen(false) }, "✕")
      ),
      els.mineCount,
      el("div", { class: "wa-mine-tabs" }, ...els.mineTabs),
      els.mineSearch,
      els.mineList
    );
  }

  // "Toate paginile" = adusă de pe server: pentru tine toate ale tale (și cele ascunse de
  // raportări), pentru altcineva profilul lui public. Ordonate după voturi (top general).
  async function loadPanelAll() {
    const user = state.panelUser;
    let list;
    try {
      list = user === state.userHash ? await WA_Api.listMine(state.userId) : await WA_Api.listByAuthor(user);
    } catch (err) {
      list = [];
      showSaveError(err.message);
    }
    if (state.panelUser !== user || !state.myPanelOpen) return; // între timp s-a deschis alt profil / s-a închis
    state.panelAll = list.sort(byRank);
    renderMineList();
  }

  function setMineScope(scope) {
    state.mineScope = scope;
    renderMineList();
  }

  const TOP_GAP = 16;
  const DOCK_POS_KEY = "wa_dock_pos"; // { [hostname]: { x, y } } — poziția mutată de utilizator, per site
  let dockPos = null; // null = implicit (sus, centrat)

  async function loadDockPosition() {
    try {
      const { [DOCK_POS_KEY]: all } = await chrome.storage.local.get(DOCK_POS_KEY);
      dockPos = all?.[location.hostname] || null;
    } catch {
      dockPos = null;
    }
    positionToolbar();
  }

  async function saveDockPosition() {
    try {
      const { [DOCK_POS_KEY]: all = {} } = await chrome.storage.local.get(DOCK_POS_KEY);
      if (dockPos) all[location.hostname] = dockPos;
      else delete all[location.hostname];
      await chrome.storage.local.set({ [DOCK_POS_KEY]: all });
    } catch {}
  }

  function positionToolbar() {
    const dock = els.toolbar;
    if (!dock) return;
    if (!dockPos) {
      dock.style.left = "50%";
      dock.style.top = TOP_GAP + "px";
      dock.style.transform = "translateX(-50%)";
    } else {
      // ținut mereu în ecran, chiar dacă fereastra s-a micșorat de când a fost mutat
      const w = dock.offsetWidth || 420;
      const h = dock.offsetHeight || 48;
      dock.style.left = Math.min(Math.max(4, dockPos.x), window.innerWidth - w - 4) + "px";
      dock.style.top = Math.min(Math.max(4, dockPos.y), window.innerHeight - h - 4) + "px";
      dock.style.transform = "none";
    }
    if (els.stylePopover && !els.stylePopover.hidden) positionStylePopover();
    if (els.statsPopover && !els.statsPopover.hidden) positionStatsPopover();
    if (state.myPanelOpen) positionMinePanel();
  }

  // Tras de mâner = mutat; dublu-click pe mâner = înapoi la locul implicit.
  function wireDockDragging(dock, grip) {
    let start = null;
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = dock.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      grip.setPointerCapture(e.pointerId);
      dock.classList.add("wa-dragging");
    });
    grip.addEventListener("pointermove", (e) => {
      if (!start) return;
      dockPos = { x: e.clientX - start.dx, y: e.clientY - start.dy };
      positionToolbar();
    });
    const end = () => {
      if (!start) return;
      start = null;
      dock.classList.remove("wa-dragging");
      saveDockPosition();
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", () => {
      dockPos = null;
      positionToolbar();
      saveDockPosition();
    });
  }

  // Dock-ul nu mai ocupă toată lățimea, deci Topul din dreapta stă mereu sus.
  function positionLeaderboardPanel() {
    els.leaderboardPanel.style.top = TOP_GAP + 4 + "px";
  }

  // Panoul "Ale mele" se deschide sub butonul 📍 din dock.
  function positionMinePanel() {
    const anchor = els.mineBtn && state.toolbarVisible ? els.mineBtn.getBoundingClientRect() : null;
    const panel = els.minePanel;
    const w = panel.offsetWidth || 260;
    if (anchor) {
      panel.style.left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - w / 2), window.innerWidth - w - 8) + "px";
      panel.style.top = anchor.bottom + 8 + "px";
    } else {
      panel.style.left = window.innerWidth - w - 40 + "px";
      panel.style.top = TOP_GAP + "px";
    }
  }

  function toggleToolbar(forceShow) {
    // Prima folosire: întâi acordul explicit (cerut de Chrome Web Store și GDPR), apoi uneltele.
    if (!state.consent && forceShow !== false) {
      showConsentDialog();
      return;
    }
    state.toolbarVisible = typeof forceShow === "boolean" ? forceShow : !state.toolbarVisible;
    els.toolbar.hidden = !state.toolbarVisible;
    els.toggleBtn?.classList.toggle("active", state.toolbarVisible);
    if (!state.toolbarVisible) {
      setActiveTool(null);
      toggleStylePopover(false);
      toggleStatsPopover(false);
      setMinePanelOpen(false);
    }
    positionToolbar();
    positionLeaderboardPanel();
    refreshTopbarVisibility();
  }

  // Cât e deschis dock-ul, butonul rotund de pornire se ascunde.
  function refreshTopbarVisibility() {
    if (!els.topbar) return;
    els.topbar.classList.toggle("wa-hidden", state.toolbarVisible);
  }

  // ✕ din panoul "Ale mele"
  function closeTopbarNow() {
    setMinePanelOpen(false);
  }

  // Scurtături (apelate din key-guard.js, care rulează în aceeași lume izolată și le
  // oprește înainte să ajungă la site — altfel pe Netflix „F” ar intra și în fullscreen).
  // Întoarce true dacă tasta a fost folosită de noi.
  window.__waShortcut = (e) => {
    if (!els.toolbar) return false;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyA") {
      toggleToolbar();
      return true;
    }
    if (!state.toolbarVisible || e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key === "Escape") {
      if (!els.stylePopover.hidden) toggleStylePopover(false);
      else if (!els.statsPopover.hidden) toggleStatsPopover(false);
      else if (state.myPanelOpen) setMinePanelOpen(false);
      else if (state.activeTool) setActiveTool(null);
      else toggleToolbar(false);
      return true;
    }
    const hit = TOOLS.find(([, , key]) => e.code === "Key" + key);
    if (!hit || e.shiftKey) return false;
    setActiveTool(hit[0] === state.activeTool ? "select" : hit[0]);
    return true;
  };

  function wireTopbarReveal() {
    // Dock-ul și popover-ul nu se închid singure; doar click în afara popover-ului îl închide.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!els.stylePopover.hidden && !els.stylePopover.contains(e.target) && !els.styleBtn.contains(e.target)) {
          toggleStylePopover(false);
        }
        if (!els.statsPopover.hidden && !els.statsPopover.contains(e.target) && !els.counterBtn.contains(e.target)) {
          toggleStatsPopover(false);
        }
      },
      true
    );
  }

  function setActiveTool(tool) {
    const nextTool = tool === state.activeTool ? null : tool === "select" ? null : tool;
    if (nextTool !== "spray" && pendingToolFinish) {
      // ai schimbat unealta cu o sesiune de spray deschisă — salvăm ce era deja desenat
      const finish = pendingToolFinish;
      pendingToolFinish = null;
      finish(true);
    }

    state.activeTool = nextTool;

    els.toolbar.querySelectorAll(".wa-tool[data-tool]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tool === (state.activeTool || "select"));
    });

    const drawing = ["pen", "spray", "shape"].includes(state.activeTool);
    const clickToPlace = ["text", "bubble", "link"].includes(state.activeTool);
    els.svg.classList.toggle("wa-drawing", drawing);
    // elements-layer stă DEASUPRA svg-ului în DOM — dacă ar primi pointer-events
    // și el cât timp desenezi (pen/spray/formă), ar fura click-urile înainte
    // să ajungă la svg, unde sunt de fapt legate handler-ele de desen.
    els.elements.classList.toggle("wa-drawing", clickToPlace);
  }

  // ---------- Vote / report / delete control ----------

  // ---------- Link atașat pe orice adnotare ----------

  // Orice adnotare (desen, spray, formă, text, bulă) poate avea un link în ann.data.url.
  // Se afișează ca o pastilă mică lipită de colțul din dreapta-sus al adnotării, vizibilă
  // pentru toată lumea; click pe ea = deschide link-ul. (Tipul "link" e deja un link.)
  function hasAttachedLink(ann) {
    return ann.type !== "link" && /^https?:\/\//i.test(String(ann.data?.url || ""));
  }

  function syncAttachedLink(entry) {
    const ann = entry.ann;
    if (!hasAttachedLink(ann)) {
      entry.linkChip?.remove();
      entry.linkChip = null;
      return;
    }
    if (!entry.linkChip) {
      entry.linkChip = el("a", {
        class: "wa-link-chip",
        target: "_blank",
        rel: "noopener noreferrer",
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(ann.data.url, "_blank", "noopener,noreferrer");
        },
      });
      els.elements.appendChild(entry.linkChip);
    }
    entry.linkChip.href = ann.data.url;
    entry.linkChip.title = ann.data.url;
    entry.linkChip.textContent = `🔗 ${shortenUrl(ann.data.url)}`;
    positionAttachedLink(entry);
  }

  // Pastila stă mereu în stratul normal, în coordonate de pagină (dreptunghiul real al
  // adnotării + scroll) — merge și cât adnotarea e în stratul de fullscreen, fiindcă și
  // stratul normal e mutat în fullscreen și compensat cu scroll-ul (vezi moveUiIntoFullscreen).
  function positionAttachedLink(entry) {
    const chip = entry.linkChip;
    if (!chip) return;
    chip.classList.remove("wa-fs-off");
    const hidden = !entry.el || getComputedStyle(entry.el).display === "none";
    chip.style.display = hidden ? "none" : "";
    if (hidden) return;
    const r = entry.el.getBoundingClientRect();
    chip.style.left = r.right + window.scrollX - 10 + "px";
    chip.style.top = r.top + window.scrollY - 12 + "px";
    chip.classList.toggle("wa-dimmed", entry.el.classList.contains("wa-dimmed"));
  }

  function positionAllAttachedLinks() {
    state.annotations.forEach((entry) => entry.linkChip && positionAttachedLink(entry));
  }

  function openAttachLinkForm(ann, clientX, clientY) {
    document.querySelectorAll(".wa-popover").forEach((p) => p.remove());
    const had = hasAttachedLink(ann);
    const urlInput = el("input", { type: "url", placeholder: "https://...", value: had ? ann.data.url : "" });
    stopKeysPropagating(urlInput);

    const save = async (url) => {
      try {
        await WA_Api.updateAnnotation(ann.id, state.userId, { url });
        ann.data.url = url;
        const entry = state.annotations.get(ann.id);
        if (entry) syncAttachedLink(entry);
        refreshCounter();
        popover.remove();
      } catch (err) {
        console.error("[Adormis] Nu am putut salva link-ul:", err);
        showSaveError("Nu am putut salva link-ul — verifică serverul.");
      }
    };

    const submitBtn = el("button", { class: "wa-submit" }, had ? "Salvează" : "Adaugă");
    const popover = el(
      "div",
      {
        class: "wa-popover",
        style: `top:${Math.max(Math.min(clientY, window.innerHeight - 150), 8)}px; left:${Math.max(Math.min(clientX, window.innerWidth - 240), 8)}px;`,
      },
      el("label", {}, "Link pe adnotarea asta"),
      urlInput,
      el(
        "div",
        { class: "wa-actions" },
        ...(had ? [el("button", { class: "wa-cancel wa-unlink", onclick: () => save("") }, "Scoate link-ul")] : []),
        el("button", { class: "wa-cancel", onclick: () => popover.remove() }, "Anulează"),
        submitBtn
      )
    );

    submitBtn.onclick = async () => {
      let url = urlInput.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      // aceeași verificare URLhaus ca la unealta Link (fail-open dacă serviciul nu răspunde)
      submitBtn.disabled = true;
      submitBtn.textContent = "Se verifică...";
      const verdict = await WA_Api.checkUrl(url);
      submitBtn.disabled = false;
      submitBtn.textContent = had ? "Salvează" : "Adaugă";
      if (verdict.checked && !verdict.safe) {
        showLinkBlockedWarning(url, verdict.threats);
        return;
      }
      save(url);
    };

    uiHost().appendChild(popover);
    clampToViewport(popover);
    urlInput.focus();
  }

  // Raportare motivată (DSA): motivul, detalii opționale și confirmarea bunei-credințe.
  const REPORT_REASONS = [
    ["illegal", "Conținut ilegal"],
    ["hate", "Ură sau discriminare"],
    ["harassment", "Hărțuire sau amenințări"],
    ["personal_data", "Date personale ale altcuiva"],
    ["sexual", "Conținut sexual"],
    ["spam", "Spam sau reclamă"],
    ["copyright", "Încalcă drepturi de autor"],
    ["other", "Altceva"],
  ];

  function openReportForm(ann, clientX, clientY, onDone) {
    document.querySelectorAll(".wa-popover").forEach((p) => p.remove());
    const select = el("select", { class: "wa-report-reason" }, el("option", { value: "" }, "Alege motivul…"), ...REPORT_REASONS.map(([v, l]) => el("option", { value: v }, l)));
    const details = el("textarea", { rows: "3", maxlength: "1000", placeholder: "Detalii (opțional): ce anume e problema" });
    const faith = el("input", { type: "checkbox" });
    const msg = el("div", { class: "wa-report-msg" });
    const submit = el("button", { class: "wa-submit" }, "Trimite raportarea");
    stopKeysPropagating(details);
    const popover = el(
      "div",
      {
        class: "wa-popover wa-report-form",
        style: `top:${Math.max(Math.min(clientY, window.innerHeight - 300), 8)}px; left:${Math.max(Math.min(clientX, window.innerWidth - 280), 8)}px;`,
      },
      el("label", {}, "De ce raportezi adnotarea?"),
      select,
      details,
      el("label", { class: "wa-report-faith" }, faith, "Confirm că raportez cu bună-credință și că informațiile sunt corecte"),
      msg,
      el("div", { class: "wa-actions" }, el("button", { class: "wa-cancel", onclick: () => popover.remove() }, "Anulează"), submit)
    );
    submit.onclick = async () => {
      if (!select.value) return (msg.textContent = "Alege un motiv.");
      if (!faith.checked) return (msg.textContent = "Bifează confirmarea.");
      submit.disabled = true;
      try {
        await WA_Api.report(ann.id, state.userId, {
          reason: select.value,
          details: details.value.trim() || undefined,
          goodFaith: true,
        });
        popover.remove();
        onDone?.();
        showSaveError("Mulțumim! Raportarea a fost trimisă și va fi verificată.", { ok: true });
      } catch (err) {
        msg.textContent = err.message;
        submit.disabled = false;
      }
    };
    uiHost().appendChild(popover);
    clampToViewport(popover);
    select.focus();
  }

  function attachVoteControl(ann, x, y) {
    const canDelete = isMine(ann);
    // Pe adnotările proprii: nimic despre voturi (nici 👍/👎/🚩, nici scorul) — doar 🔗/🗑 de mai jos.
    // Votezi și raportezi ce scriu alții; câte voturi ai primit vezi în „Top” și „Ale mele”.
    const control = canDelete
      ? el("div", { class: "wa-vote wa-vote-own", style: `left:${x}px; top:${y}px;` })
      : el(
          "div",
          { class: "wa-vote", style: `left:${x}px; top:${y}px;` },
          el("button", { class: "wa-up", title: "Like" }, "👍"),
          el("span", { class: "wa-count" }, String(ann.votes)),
          el("button", { class: "wa-down", title: "Dislike" }, "👎"),
          el("button", { class: "wa-report", title: "Raportează" }, "🚩")
        );

    const sendVote = async (direction) => {
      try {
        const updated = await WA_Api.vote(ann.id, state.userId, direction);
        updateVotes(ann.id, updated.votes);
      } catch (err) {
        showSaveError(err.message || "Votul nu a putut fi trimis.");
      }
    };
    if (!canDelete) {
      control.querySelector(".wa-up").onclick = (e) => {
        e.stopPropagation();
        sendVote("up");
      };
      control.querySelector(".wa-down").onclick = (e) => {
        e.stopPropagation();
        sendVote("down");
      };
      control.querySelector(".wa-report").onclick = (e) => {
        e.stopPropagation();
        pauseVideoIfPlaying();
        openReportForm(ann, e.clientX, e.clientY, () => {
          control.querySelector(".wa-report").textContent = "🚩✓";
        });
      };
    }

    if (canDelete && ann.type !== "link") {
      const linkBtn = el("button", { class: "wa-attach-link", title: "Adaugă / schimbă link" }, "🔗");
      linkBtn.onclick = (e) => {
        e.stopPropagation();
        pauseVideoIfPlaying();
        openAttachLinkForm(ann, e.clientX, e.clientY);
      };
      control.appendChild(linkBtn);
    }

    if (canDelete) {
      const delBtn = el("button", { class: "wa-del", title: "Șterge" }, "🗑");
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (await WA_Api.remove(ann.id, state.userId)) removeAnnotation(ann.id);
      };
      control.appendChild(delBtn);
    }

    els.elements.appendChild(control);
    return control;
  }

  // Site-uri ca YouTube/Netflix au scurtături globale de tastatură pe pagină (ex. Space = play/pause).
  // Fără asta, tastarea în casetele noastre de text "scapă" către pagină și declanșează acele scurtături.
  function stopKeysPropagating(node) {
    ["keydown", "keyup", "keypress"].forEach((type) => {
      node.addEventListener(type, (e) => e.stopPropagation());
    });
  }

  // Dacă serverul nu răspunde (oprit, fără rețea etc.), creare/editare eșuează silențios
  // altfel — desenul dispare de pe pagină fără nicio explicație. Un singur banner, refolosit
  // pentru toate uneltele, ca utilizatorul să știe DE CE a dispărut, nu doar CĂ a dispărut.
  let saveErrorToast = null;
  let saveErrorTimer = null;
  function showSaveError(message, { ok = false } = {}) {
    clearTimeout(saveErrorTimer);
    if (!saveErrorToast) {
      saveErrorToast = el("div", { class: "wa-save-error" });
      uiHost().appendChild(saveErrorToast);
    }
    saveErrorToast.textContent = `${ok ? "✅" : "⚠️"} ${message}`;
    saveErrorToast.classList.toggle("wa-ok", ok);
    saveErrorToast.classList.add("wa-visible");
    saveErrorTimer = setTimeout(() => saveErrorToast?.classList.remove("wa-visible"), 5000);
  }

  // Autorul poate re-edita textul unei adnotări (dublu-click) — funcționează pentru text/bulă.
  function makeEditableOnDblClick(ann, domEl, { onSave }) {
    if (!isMine(ann)) return;
    domEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      pauseVideoIfPlaying();
      domEl.contentEditable = "true";
      domEl.focus();
      document.execCommand("selectAll", false, null);
      // dacă are deja un interval SAU e poziționată peste video, arătăm un mic
      // formular alături ca să (mai) poți seta de la ce secundă la ce secundă apare.
      openRangeOnlyEditor(ann, domEl, e.clientX, e.clientY);
    });

    domEl.addEventListener("blur", async () => {
      if (domEl.contentEditable !== "true") return;
      domEl.contentEditable = "false";
      const text = domEl.textContent.trim();
      if (!text || text === ann.data.text) return;
      ann.data.text = text;
      try {
        await WA_Api.updateAnnotation(ann.id, state.userId, { text });
      } catch (err) {
        console.error("[Adormis] Nu am putut salva editarea:", err);
      }
      onSave?.(text);
    });
  }

  // Editare pentru desene (pen/spray/formă) — nu au text, deci dublu-click deschide
  // un mic formular de culoare/grosime în loc de retastare inline.
  function makeStyleEditableOnDblClick(ann, domEl) {
    if (!isMine(ann)) return;
    domEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      e.preventDefault();
      pauseVideoIfPlaying();
      openStyleEditor(ann, domEl, e.clientX, e.clientY);
    });
  }

  function isOverVideo(rect) {
    const video = getMainVideo();
    if (!video || !rect) return false;
    const v = video.getBoundingClientRect();
    return !(rect.right < v.left || rect.left > v.right || rect.bottom < v.top || rect.top > v.bottom);
  }

  // Reutilizat în toate popover-urile de editare: câmpuri De la/Până la (h:mm:ss).
  // Apar dacă adnotarea are deja un interval, SAU dacă e poziționată peste video —
  // caz în care poți adăuga unul acum, chiar dacă n-a fost creată cu "Legat de video".
  function buildVideoRangeFields(ann, targetEl) {
    const video = getMainVideo();
    const hadRange = !!ann.data.videoRange;
    if (!hadRange) {
      if (!video || !isOverVideo(targetEl?.getBoundingClientRect?.())) return null;
    }
    const defStart = ann.data.videoRange?.start ?? Math.round(video?.currentTime || 0);
    const defEnd = ann.data.videoRange?.end ?? defStart + 2;
    const startInput = el("input", { type: "text", placeholder: "h:mm:ss", value: formatTime(defStart) });
    const endInput = el("input", { type: "text", placeholder: "h:mm:ss", value: formatTime(defEnd) });
    stopKeysPropagating(startInput);
    stopKeysPropagating(endInput);
    return {
      fields: [
        el("label", {}, hadRange ? "🎬 De la (h:mm:ss)" : "🎬 Arată doar de la (h:mm:ss)", startInput),
        el("label", {}, "Până la (h:mm:ss)", endInput),
      ],
      readRange() {
        const parsedStart = parseTimeToSeconds(startInput.value);
        const start = Number.isNaN(parsedStart) ? 0 : parsedStart;
        const parsedEnd = parseTimeToSeconds(endInput.value);
        const end = Number.isNaN(parsedEnd) ? start + 1 : parsedEnd;
        return end > start ? { start, end } : null;
      },
    };
  }

  // Formular mic, doar pentru interval — apare lângă text/bulă când intri în editare
  // (acolo editarea textului e inline, nu într-un popover, deci intervalul e separat).
  function openRangeOnlyEditor(ann, targetEl, clientX, clientY) {
    document.querySelectorAll(".wa-popover").forEach((p) => p.remove());
    const rangeFields = buildVideoRangeFields(ann, targetEl);
    if (!rangeFields) return;

    const left = Math.min(clientX + 16, window.innerWidth - 200);
    const top = Math.min(clientY, window.innerHeight - 110);

    const popover = el(
      "div",
      { class: "wa-popover", style: `top:${Math.max(top, 8)}px; left:${Math.max(left, 8)}px;` },
      ...rangeFields.fields,
      el("div", { class: "wa-actions" }, el("button", { class: "wa-submit" }, "Salvează intervalul"))
    );

    popover.querySelector(".wa-submit").onclick = async () => {
      const newRange = rangeFields.readRange();
      if (newRange) {
        ann.data.videoRange = newRange;
        try {
          await WA_Api.updateAnnotation(ann.id, state.userId, { videoRange: newRange });
        } catch (err) {
          console.error("[Adormis] Nu am putut salva intervalul:", err);
        }
      }
      popover.remove();
    };

    uiHost().appendChild(popover);
    clampToViewport(popover);
  }

  function openStyleEditor(ann, targetEl, clientX, clientY) {
    document.querySelectorAll(".wa-popover").forEach((p) => p.remove());

    const colorInput = el("input", { type: "color", value: ann.data.color || "#89CFF0" });
    stopKeysPropagating(colorInput);

    const showWidth = ann.type === "pen" || ann.type === "shape";
    const widthInput = el("input", {
      type: "range",
      min: "1",
      max: "24",
      value: String(ann.data.strokeWidth || 4),
    });
    stopKeysPropagating(widthInput);

    const left = Math.min(clientX, window.innerWidth - 200);
    const top = Math.min(clientY, window.innerHeight - 140);

    const rangeFields = buildVideoRangeFields(ann, targetEl);
    const fields = [el("label", {}, "Culoare"), colorInput];
    if (showWidth) fields.push(el("label", {}, "Grosime"), widthInput);
    if (rangeFields) fields.push(...rangeFields.fields);

    const popover = el(
      "div",
      { class: "wa-popover", style: `top:${Math.max(top, 8)}px; left:${Math.max(left, 8)}px;` },
      ...fields,
      el(
        "div",
        { class: "wa-actions" },
        el("button", { class: "wa-cancel", onclick: () => popover.remove() }, "Anulează"),
        el("button", { class: "wa-submit" }, "Salvează")
      )
    );

    popover.querySelector(".wa-submit").onclick = async () => {
      const newColor = colorInput.value;
      const newWidth = Number(widthInput.value) || ann.data.strokeWidth;
      const patch = { color: newColor };
      if (showWidth) patch.strokeWidth = newWidth;

      ann.data.color = newColor;
      if (showWidth) ann.data.strokeWidth = newWidth;
      applyStyleToElement(ann, targetEl);

      if (rangeFields) {
        const newRange = rangeFields.readRange();
        if (newRange) {
          ann.data.videoRange = newRange;
          patch.videoRange = newRange;
        }
      }

      try {
        await WA_Api.updateAnnotation(ann.id, state.userId, patch);
      } catch (err) {
        console.error("[Adormis] Nu am putut salva editarea:", err);
      }
      popover.remove();
    };

    uiHost().appendChild(popover);
    clampToViewport(popover);
  }

  // Aplică vizual noua culoare/grosime pe elementul SVG existent, fără să-l recreeze
  // (ca să nu pierdem drag-ul/dublu-click-ul deja legate de el).
  function applyStyleToElement(ann, elm) {
    if (ann.type === "pen") {
      elm.setAttribute("stroke", ann.data.color);
      elm.setAttribute("stroke-width", ann.data.strokeWidth);
    } else if (ann.type === "spray") {
      [...elm.children].forEach((c) => c.setAttribute("fill", ann.data.color));
    } else if (ann.type === "shape") {
      if (SIMPLE_STROKE_SHAPES.has(ann.data.shape)) {
        elm.setAttribute("stroke", ann.data.color);
        elm.setAttribute("stroke-width", ann.data.strokeWidth);
        elm.style.stroke = ann.data.color; // pentru context-stroke pe săgeată
      } else {
        // bulă desenată (variantă veche a uneltei Formă)
        const rect = elm.querySelector("rect");
        const polygon = elm.querySelector("polygon");
        if (rect) {
          rect.setAttribute("stroke", ann.data.color);
          rect.setAttribute("stroke-width", ann.data.strokeWidth);
        }
        if (polygon) polygon.setAttribute("fill", ann.data.color);
      }
    }
  }

  // Doar autorul unei adnotări o poate muta după creare (drag). Alți useri văd cursor normal.
  // domEl poate fi un element DOM normal (text/bulă/link — poziționat cu left/top)
  // sau un element SVG (pen/spray/formă — mutat cu un translate, păstrat ca dx/dy în data).
  function makeMovable(ann, domEl, control) {
    if (!isMine(ann)) return;
    domEl.classList.add("wa-owned");
    domEl.draggable = false; // dezactivăm drag-ul nativ al browserului (ex. pe <a>)

    const isSvg = domEl instanceof SVGElement;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let origDx = 0;
    let origDy = 0;
    let ctrlOrigLeft = 0;
    let ctrlOrigTop = 0;

    // Ascultăm move/up pe window (nu doar pe domEl) — setPointerCapture nu redirecționează
    // fiabil evenimentele către elemente SVG în toate cazurile, mai ales dacă mouse-ul
    // se mișcă repede în afara zonei subțiri a conturului (stroke).
    function onPointerMove(e) {
      if (!dragging) return;
      const dx = e.pageX - startX;
      const dy = e.pageY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      if (isSvg) {
        ann.data.dx = origDx + dx;
        ann.data.dy = origDy + dy;
        applySvgTransform(domEl, ann);
      } else {
        domEl.style.left = origLeft + dx + "px";
        domEl.style.top = origTop + dy + "px";
      }
      if (control) {
        control.style.left = ctrlOrigLeft + dx + "px";
        control.style.top = ctrlOrigTop + dy + "px";
      }
      const entry = state.annotations.get(ann.id);
      if (entry) positionAttachedLink(entry);
    }

    async function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (!moved) return; // a fost doar un click (ex. pe link), nu o mutare

      // Re-ancorăm de la locul nou, ca o redimensionare/zoom viitoare să urmărească poziția
      // nouă. Reperul (poza/video-ul) se alege după locul unde ai lăsat mouse-ul, dar
      // poziția salvată e a PUNCTULUI DE ORIGINE al adnotării (colțul/începutul ei), nu a
      // mouse-ului — altfel, la prima recalculare (ex. când dispare bara player-ului pe
      // Netflix), adnotarea sărea cu distanța dintre colț și locul de unde ai apucat-o.
      let patch;
      let originPage;
      if (isSvg) {
        const newDx = origDx + (e.pageX - startX);
        const newDy = origDy + (e.pageY - startY);
        ann.data.dx = newDx;
        ann.data.dy = newDy;
        const o = svgOriginPoint(ann);
        originPage = o ? { x: o.x + newDx, y: o.y + newDy } : null;
        patch = { dx: newDx, dy: newDy };
      } else {
        const newX = parseFloat(domEl.style.left);
        const newY = parseFloat(domEl.style.top);
        ann.data.x = newX;
        ann.data.y = newY;
        originPage = { x: newX, y: newY };
        patch = { x: newX, y: newY };
      }
      const at = originPage ? { x: originPage.x - window.scrollX, y: originPage.y - window.scrollY } : null;
      const newAnchor = computeAnchor(e.clientX, e.clientY, ann._fit || 1, at);
      ann.data.anchor = newAnchor;
      patch.anchor = newAnchor;
      try {
        await WA_Api.updateAnnotation(ann.id, state.userId, patch);
      } catch (err) {
        console.error("[Adormis] Nu am putut salva poziția nouă:", err);
      }
    }

    domEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (domEl.contentEditable === "true") return; // ești în editare (dublu-click) — nu porni drag, lasă selecția de text
      dragging = true;
      moved = false;
      startX = e.pageX;
      startY = e.pageY;
      if (isSvg) {
        origDx = ann.data.dx || 0;
        origDy = ann.data.dy || 0;
      } else {
        origLeft = parseFloat(domEl.style.left) || 0;
        origTop = parseFloat(domEl.style.top) || 0;
      }
      if (control) {
        ctrlOrigLeft = parseFloat(control.style.left) || 0;
        ctrlOrigTop = parseFloat(control.style.top) || 0;
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    });

    // pentru link-uri: dacă a fost drag, nu deschide URL-ul la eliberare — stopImmediatePropagation
    // (nu doar stopPropagation) ca să blocheze și alte listenere de "click" puse pe ACELAȘI
    // element (ex. cel de navigare al bulei de link), nu doar propagarea către părinți.
    domEl.addEventListener("click", (e) => {
      if (moved) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    });
  }

  function updateVotes(id, votes) {
    const entry = state.annotations.get(id);
    if (!entry) return;
    entry.ann.votes = votes;
    const count = entry.control?.querySelector(".wa-count");
    if (count) count.textContent = String(votes);
    refreshRanking(); // un vot poate muta adnotarea în/din primele 10
    refreshGlobalTop(); // ...și clasamentul GLOBAL
  }

  // Top 10 al paginii: câte O adnotare per utilizator — cea mai bună a lui de pe pagină (scor
  // 👍 − 👎, la egalitate cea mai veche), indiferent când a publicat-o; o adnotare nouă nu o
  // înlocuiește pe cea din top decât dacă ajunge să aibă scor mai bun. Utilizatorii se ordonează
  // la fel (scor, apoi vechime); dacă sunt mai puțin de 10, intră toți, și cei cu scor negativ.
  // Pe pagină se văd doar adnotările din top (plus ale tale și cele cerute explicit, vezi
  // applyVisibility); restul se găsesc în profilul autorului.
  const PAGE_LIMIT = 10;
  const byRank = (a, b) => b.votes - a.votes || a.createdAt - b.createdAt;
  function refreshRanking() {
    const best = new Map(); // authorHash -> cea mai bună adnotare a lui de pe pagină
    state.annotations.forEach(({ ann }) => {
      const key = ann.authorHash || ann.id;
      const cur = best.get(key);
      if (!cur || byRank(ann, cur) < 0) best.set(key, ann);
    });
    state.pageTop = [...best.values()].sort(byRank).slice(0, PAGE_LIMIT);
    state.rankVisible = new Set(state.pageTop.map((a) => a.id));
    refreshVisibility();
    renderSidebar();
    if (state.myPanelOpen) renderMineList(); // ordinea după voturi din profil se poate schimba
  }

  // Decide dacă o adnotare stă ascunsă (în afara primelor 10 / în afara intervalului video)
  // sau vizibilă. Excepție: cât timp panoul "Ale mele" e deschis, propriile adnotări
  // ignoră ambele filtre — exact ca să le poți găsi chiar dacă n-au voturi sau nu e
  // momentul potrivit din video. Centralizat aici (nu în două locuri separate) ca cele
  // două filtre să nu se calce unul pe altul, scriind amândouă în același style.display.
  function applyVisibility(entry) {
    const mine = isMine(entry.ann);
    // cât e deschis profilul cuiva (inclusiv "Ale mele"), adnotările lui de pe pagină se văd toate
    const forced = state.myPanelOpen && !!entry.ann.authorHash && entry.ann.authorHash === state.panelUser;

    let filtered = false;
    // în afara Top 10 → ascunsă; ale tale le vezi mereu (altfel una nouă ar dispărea imediat)
    if (!state.rankVisible.has(entry.ann.id) && !mine && !state.revealed.has(entry.ann.id)) filtered = true;
    const range = entry.ann.data?.videoRange;
    if (range) {
      const video = getMainVideo();
      const t = video ? video.currentTime : 0;
      if (t < range.start || t > range.end) filtered = true;
    }
    const hidden = filtered && !forced;
    // Forțată de panou dar altfel ascunsă → semi-transparentă, ca autorul să vadă că
    // intervalul/filtrul funcționează (înainte părea mereu vizibilă și intervalul "stricat").
    const dimmed = filtered && forced;

    if (entry.el) {
      entry.el.style.display = hidden ? "none" : "";
      entry.el.classList.toggle("wa-dimmed", dimmed);
    }
    if (entry.control) entry.control.style.display = hidden ? "none" : "";
    positionAttachedLink(entry);
  }

  // Reaplică filtrele pe TOATE adnotările deodată — necesar la deschiderea/închiderea
  // panoului "Ale mele", care schimbă condiția de forțare pentru mai multe dintre ele
  // simultan (nu doar una, ca la un vot).
  function refreshVisibility() {
    state.annotations.forEach(applyVisibility);
  }

  function removeAnnotation(id) {
    const entry = state.annotations.get(id);
    if (!entry) return;
    entry.el?.remove();
    entry.control?.remove();
    entry.linkChip?.remove();
    state.annotations.delete(id);
    refreshCounter();
    refreshRanking();
    if (state.myPanelOpen) renderMineList();
  }

  function registerAnnotation(ann, domEl, control) {
    state.annotations.set(ann.id, { ann, el: domEl, control });
    syncAttachedLink(state.annotations.get(ann.id));
    applyVisibility(state.annotations.get(ann.id));
    refreshCounter();
    wireVideoRange(ann, domEl, control);
    const handles = attachTransformHandles(ann, domEl); // null dacă nu ești autorul
    const reveal = wireHoverReveal(domEl, [control, handles?.resizeHandle, handles?.rotateHandle], {
      onShow: () => {
        placeControlAtElement(domEl, control);
        handles?.startTracking();
      },
      onHide: handles?.stopTracking,
    });
    if (handles) wireHandleDragging(ann, domEl, handles, reveal);
    refreshRanking(); // clasamentul (și cine intră în primele 10) e mereu la zi
    if (state.myPanelOpen) renderMineList(); // panoul "Ale mele" prinde imediat noua adnotare
  }

  // Controlul de vot stă centrat sub dreptunghiul REAL al adnotării
  // (getBoundingClientRect), calculat abia când apare. Punctul salvat (x/y, primul punct al
  // desenului) nu e același lucru: la un cerc e colțul gol al cutiei, iar zoom-ul/rotirea/
  // scalarea cu pagina mută desenul față de el — meniul apărea „mai departe” de obiect.
  // Mijlocul marginii de jos e atins de orice formă (cerc, linie, text), colțul nu.
  // În stratul de fullscreen (#wa-video-root, fixed) coordonatele sunt de ecran, fără scroll.
  function placeControlAtElement(domEl, control) {
    if (!control) return;
    const r = domEl.getBoundingClientRect();
    if (!r.width && !r.height) return; // ascunsă (ex. în afara intervalului video)
    const inVideoLayer = control.parentNode === els.videoElements;
    control.style.left = r.left + r.width / 2 + (inVideoLayer ? 0 : window.scrollX) + "px";
    control.style.top = r.bottom + (inVideoLayer ? 0 : window.scrollY) + "px";
  }

  // Aplică translate (poziție, din drag/ancoră) + rotate + scale pe un element SVG
  // (pen/spray/formă) — TOATE trei combinate într-un singur "transform", ca zoom-ul
  // și rotirea să funcționeze corect chiar și pe o adnotare deja mutată din loc.
  function applySvgTransform(domEl, ann) {
    domEl.style.transform = svgTransformFor(domEl, ann, ann.data.dx || 0, ann.data.dy || 0);
  }

  // ann._fit (doar client-side, nu se salvează) = cât de mare e ACUM imaginea/video-ul de
  // reper față de momentul desenării (vezi resolveAnchor). Desenul se scalează cu el în jurul
  // punctului de ancoră, ca să rămână peste aceeași porțiune din imagine când pagina se
  // micșorează/mărește. Originea CSS e centrul formei (fill-box), deci compensăm cu un
  // translate: punctul de ancoră O ajunge exact la poziția rezolvată, restul se strânge spre el.
  function svgTransformFor(domEl, ann, dx, dy) {
    const rotate = ann.data.rotate || 0;
    const scale = ann.data.scale || 1;
    const fit = ann._fit || 1;
    if (fit !== 1) {
      const origin = svgOriginPoint(ann);
      // getBBox dă 0 cât elementul e ascuns (display:none, ex. în afara intervalului video),
      // așa că păstrăm ultima cutie validă — geometria desenului nu se schimbă după creare
      if (!ann._box) {
        try {
          const b = domEl.getBBox();
          if (b.width || b.height) ann._box = { x: b.x, y: b.y, width: b.width, height: b.height };
        } catch {}
      }
      const box = ann._box;
      if (origin && box) {
        dx += (fit - 1) * (box.x + box.width / 2 - origin.x);
        dy += (fit - 1) * (box.y + box.height / 2 - origin.y);
      }
    }
    return `translate(${dx}px, ${dy}px) scale(${fit}) rotate(${rotate}deg) scale(${scale})`;
  }

  // La fel, pentru elemente DOM obișnuite (text/bulă/link) — acolo poziția e deja pe
  // left/top (nu pe transform), deci aici e nevoie doar de rotate + scale.
  // Și aici se aplică ann._fit, cu pivotul în colțul stânga-sus (= punctul de ancoră), nu în centru.
  function applyDomTransform(domEl, ann) {
    const rotate = ann.data.rotate || 0;
    const scale = ann.data.scale || 1;
    const fit = ann._fit || 1;
    // procente = relativ la mărimea elementului, deci merge și cât e ascuns (display:none)
    const t = (fit - 1) * 50;
    domEl.style.transform = `translate(${t}%, ${t}%) scale(${fit}) rotate(${rotate}deg) scale(${scale})`;
  }

  // Mânere de zoom/rotire — doar pentru autor, ca la mutare/editare. Colțul dreapta-jos
  // = zoom (trage mai departe de centru = mărește, mai aproape = micșorează), colțul
  // stânga-jos = rotire liberă (trage în cerc în jurul centrului, în orice direcție).
  // Poziția lor urmărește dreptunghiul REAL al adnotării (getBoundingClientRect), cât
  // timp sunt vizibile — printr-un mic loop de animație, ca să rămână lipite de colțuri
  // chiar dacă adnotarea se mută/rotește/scalează în timp real.
  function attachTransformHandles(ann, domEl) {
    if (!isMine(ann)) return null;

    const resizeHandle = el("div", { class: "wa-handle wa-handle-resize", title: "Trage din colț pentru zoom" }, "⤡");
    const rotateHandle = el("div", { class: "wa-handle wa-handle-rotate", title: "Trage din colț pentru rotire" }, "↻");
    els.elements.appendChild(resizeHandle);
    els.elements.appendChild(rotateHandle);

    function positionHandles() {
      const r = domEl.getBoundingClientRect();
      resizeHandle.style.left = r.right + window.scrollX + "px";
      resizeHandle.style.top = r.bottom + window.scrollY + "px";
      rotateHandle.style.left = r.left + window.scrollX + "px";
      rotateHandle.style.top = r.bottom + window.scrollY + "px";
    }
    positionHandles();

    let raf = null;
    function tick() {
      positionHandles();
      raf = requestAnimationFrame(tick);
    }
    function startTracking() {
      if (raf) return;
      tick();
    }
    function stopTracking() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    }

    return { resizeHandle, rotateHandle, positionHandles, startTracking, stopTracking };
  }

  // Leagă drag-ul efectiv de pe cele două mânere de starea adnotării (ann.data.scale /
  // ann.data.rotate), cu previzualizare live și salvare pe server abia la eliberare.
  function wireHandleDragging(ann, domEl, handles, reveal) {
    const isSvg = domEl instanceof SVGElement;

    function applyLive() {
      if (isSvg) applySvgTransform(domEl, ann);
      else applyDomTransform(domEl, ann);
      handles.positionHandles();
      const entry = state.annotations.get(ann.id);
      if (entry) positionAttachedLink(entry);
    }

    function startDrag(handleEl, onMove) {
      handleEl.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation(); // nu porni și drag-ul de mutare al adnotării de sub mâner
        reveal.pin(); // rămâne vizibil cât ții mâna apăsată, chiar dacă ieși din zona lui

        const rect = domEl.getBoundingClientRect();
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const start = {
          scale: ann.data.scale || 1,
          rotate: ann.data.rotate || 0,
          dist: Math.hypot(e.clientX - center.x, e.clientY - center.y) || 1,
          angle: Math.atan2(e.clientY - center.y, e.clientX - center.x),
        };

        function onPointerMove(ev) {
          onMove(ev, center, start);
        }
        function onPointerUp() {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          reveal.unpin();
          WA_Api.updateAnnotation(ann.id, state.userId, {
            scale: ann.data.scale,
            rotate: ann.data.rotate,
          }).catch((err) => {
            console.error("[Adormis] Nu am putut salva zoom/rotire:", err);
          });
        }
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
      });
    }

    startDrag(handles.resizeHandle, (ev, center, start) => {
      const dist = Math.hypot(ev.clientX - center.x, ev.clientY - center.y) || 1;
      const scale = (start.scale * dist) / start.dist;
      ann.data.scale = Math.min(Math.max(scale, 0.2), 6); // limite rezonabile, nu dispare/explodează
      applyLive();
    });

    startDrag(handles.rotateHandle, (ev, center, start) => {
      const angle = Math.atan2(ev.clientY - center.y, ev.clientX - center.x);
      const deltaDeg = ((angle - start.angle) * 180) / Math.PI;
      ann.data.rotate = start.rotate + deltaDeg;
      applyLive();
    });
  }

  // Controlul de vot (👍👎🚩, plus 🗑 după caz) și, pentru adnotările proprii, mânerele
  // de zoom/rotire — stau ascunse (opacity 0, vezi CSS) și apar împreună, ca un grup,
  // doar cât ții mouse-ul pe adnotare SAU pe oricare dintre ele — cu o întârziere
  // generoasă la ieșire (nu una scurtă), ca să apuci efectiv să treci mouse-ul de pe
  // adnotare până în colțul unui mâner de zoom/rotire, chiar dacă mișcarea nu e perfect
  // dreaptă. Click pe adnotare le arată/reîmprospătează la fel — util dacă vrei să te
  // reorientezi o clipă spre mâner fără să "pierzi" fereastra de timp.
  // `extras` poate avea `onShow`/`onHide` (ex. pornește/oprește urmărirea poziției mânerelor
  // cât timp sunt vizibile). Întoarce `{pin, unpin}` — folosit ca grupul să rămână vizibil
  // în timp ce tragi de un mâner, chiar dacă mouse-ul iese temporar din zona lui.
  function wireHoverReveal(domEl, controls, extras = {}) {
    const list = (Array.isArray(controls) ? controls : [controls]).filter(Boolean);
    if (!list.length) return { pin() {}, unpin() {} };
    const HIDE_DELAY_MS = 1500;
    let hideTimer = null;
    let pinned = false;
    function show() {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      list.forEach((c) => c.classList.add("wa-visible-hover"));
      extras.onShow?.();
    }
    function hide() {
      list.forEach((c) => c.classList.remove("wa-visible-hover"));
      extras.onHide?.();
    }
    function scheduleHide() {
      if (pinned) return;
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, HIDE_DELAY_MS);
    }
    domEl.addEventListener("mouseenter", show);
    domEl.addEventListener("mouseleave", scheduleHide);
    domEl.addEventListener("click", show);
    list.forEach((c) => {
      c.addEventListener("mouseenter", show);
      c.addEventListener("mouseleave", scheduleHide);
    });
    return {
      pin() {
        pinned = true;
        show();
      },
      unpin() {
        pinned = false;
        scheduleHide();
      },
    };
  }

  // Dacă unealta "Legat de video" e activă la creare, întoarce {start, end}; altfel null.
  // Funcționează pentru orice tip de adnotare (pen/spray/formă = SVG, text/bulă/link = DOM):
  // dacă are un interval din video, o arată doar cât video.currentTime e în interval.
  // Legăm ascultătorul chiar dacă adnotarea NU are încă interval — dacă i se
  // adaugă unul mai târziu (dublu-click, pentru orice e peste video), prinde
  // efectul imediat, fără reload. Fără interval, rămâne mereu vizibilă.
  // Adnotări cu videoRange care n-au găsit niciun <video> la înregistrare — pe
  // site-uri SPA grele (YouTube), player-ul își construiește <video>-ul asincron,
  // DUPĂ ce loadExisting() a apucat deja să încerce legarea. Fără reîncercare, o
  // asemenea adnotare rămânea "înghețată" ascunsă (applyVisibility vede video=null,
  // deci t=0 < range.start) tot restul sesiunii paginii — nicio interacțiune
  // ulterioară n-o mai putea readuce la viață, nici măcar deschiderea "Ale mele".
  const pendingVideoWire = [];

  function wireVideoRange(ann, domEl, control) {
    const video = getMainVideo();
    if (!video) {
      pendingVideoWire.push({ ann, domEl, control });
      return;
    }

    // Doar reaplică vizibilitatea centralizată (applyVisibility) la fiecare tick de
    // redare — ea citește ann.data.videoRange DIN NOU de fiecare dată (nu memorat o
    // dată), deci o editare ulterioară a secundelor (dublu-click) are efect imediat,
    // fără reload, și respectă și forțarea din panoul "Ale mele".
    function update() {
      const entry = state.annotations.get(ann.id);
      if (entry) applyVisibility(entry);
    }
    video.addEventListener("timeupdate", update);
    update();
  }

  // O singură dată pentru toată pagina: dacă apare un <video> nou (player SPA
  // construit cu întârziere), reîncearcă legarea pentru tot ce aștepta. Rămâne activ
  // pe toată durata paginii (nu doar la prima reușită) — aceeași cursă se poate
  // repeta la fiecare navigare SPA (schimbare de video pe YouTube), care golește și
  // reumple state.annotations prin onPageNavigated(). Verificarea e ieftină
  // (`length` întâi) — nu costă nimic cât timp nu așteaptă nimic.
  // Pagini care își încarcă bucăți din conținut pe parcurs (meniul Netflix, galerii, feed-uri):
  // reperele pot apărea/muta fără niciun resize — recalculăm, rar (debounce), doar dacă avem ce.
  // Throttle, nu debounce: pe pagini care se modifică încontinuu (trailer, contoare), un
  // debounce n-ar mai apuca să ruleze niciodată.
  let mutationRepositionTimer = null;
  function repositionAfterMutations() {
    if (mutationRepositionTimer) return;
    mutationRepositionTimer = setTimeout(() => {
      mutationRepositionTimer = null;
      if (els.root && state.annotations.size) {
        repositionAnchoredAnnotations();
        repositionVideoLayerAnnotations(); // altfel, în fullscreen, cele din stratul-geamăn primeau coordonate de pagină
      }
    }, 400);
  }

  new MutationObserver((mutations) => {
    if (els.root && !mutations.every((m) => els.root.contains(m.target) || els.videoRoot?.contains(m.target))) {
      repositionAfterMutations();
    }
    watchVideoResize(); // dacă <video>-ul s-a schimbat/a apărut, prindem imediat mărimea lui reală
    if (!pendingVideoWire.length || !getMainVideo()) return;
    pendingVideoWire.splice(0).forEach(({ ann, domEl, control }) => wireVideoRange(ann, domEl, control));
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Repoziționarea ancorată (repositionAnchoredAnnotations) se baza DOAR pe
  // window.resize — dar dimensiunea/poziția video-ului se poate schimba fără ca
  // fereastra browserului să-și schimbe dimensiunea deloc: theatru mode, fullscreen
  // "fals" prin CSS (nu Fullscreen API), un layout responsiv al site-ului declanșat
  // de altceva decât un resize de fereastră (motivul cel mai probabil pentru care o
  // adnotare peste video apărea doar în anumite moduri de vizualizare, nu în altele).
  // ResizeObserver urmărește direct dreptunghiul REAL al <video>-ului, indiferent
  // de ce l-a schimbat.
  let videoResizeObserver = null;
  let observedVideo = null;
  function watchVideoResize() {
    const video = getMainVideo();
    if (video === observedVideo) return; // deja urmărim exact acest element
    videoResizeObserver?.disconnect();
    observedVideo = video;
    if (!video) return;
    videoResizeObserver = new ResizeObserver(
      debounce(() => {
        if (!els.root) return; // overlay-ul nu s-a construit încă (init() încă rulează)
        repositionAnchoredAnnotations();
        repositionVideoLayerAnnotations();
        sizeLayers();
      }, 100)
    );
    videoResizeObserver.observe(video);
  }
  watchVideoResize();
  // Fullscreen (Fullscreen API reală) e un caz special, în două privințe:
  // 1) dreptunghiul video-ului se poate schimba fără ca elementul să-și schimbe
  //    efectiv width/height CSS în același tick — un declanșator explicit aici, în
  //    plus față de ResizeObserver, nu strică.
  // 2) fullscreen-ul randează DOAR subarborele elementului aflat în fullscreen —
  //    #wa-root (frate cu <html>) devine complet invizibil, adnotare pe video sau
  //    nu. enterVideoFullscreen/exitVideoFullscreen (mai jos) mută DOAR adnotările
  //    legate de video (videoRange) într-un strat-geamăn, înăuntrul lui
  //    document.fullscreenElement, cât ține fullscreen-ul — cele statice rămân
  //    invizibile ca înainte (locateMine iese explicit din fullscreen pentru ele).
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) {
      enterVideoFullscreen();
      moveUiIntoFullscreen();
    } else {
      moveUiOutOfFullscreen();
      exitVideoFullscreen();
    }
    positionToolbar();
    setTimeout(() => {
      if (!els.root) return;
      repositionAnchoredAnnotations();
      repositionVideoLayerAnnotations();
      sizeLayers();
    }, 100);
  });

  // Adevărat doar dacă elementul aflat efectiv în fullscreen conține video-ul
  // principal — și NU e chiar tag-ul <video> (un <video> nu-și randează copiii DOM
  // arbitrari ca overlay, deci n-avem cum să-i suprapunem ceva vizibil; site-urile
  // care fac fullscreen pe <video> direct, nu pe un container-wrapper, rămân cu
  // limitarea veche: bula nu se vede cât ești fullscreen, doar seek-ul pe video).
  // Unde se atașează UI-ul extensiei (dock, meniuri, bare „OK, gata”, toast-uri): cât ține
  // un fullscreen peste video, ÎNĂUNTRUL elementului din fullscreen — altfel nu se vede.
  function uiHost() {
    return (fullscreenUiActive && document.fullscreenElement) || document.documentElement;
  }

  // Mută UI-ul și stratul de desen în fullscreen (și înapoi), ca să poți desena direct peste
  // film. Adnotările care NU țin de video (de pe restul paginii) se ascund cât ține
  // fullscreen-ul — locul lor nu se vede oricum. Cele legate de video sunt deja afișate prin
  // stratul-geamăn (enterVideoFullscreen); aici rămân doar cele noi, desenate în fullscreen.
  let fullscreenUiActive = false;
  const FS_UI = () => [els.topbar, els.toolbar, els.stylePopover, els.statsPopover, els.minePanel, els.leaderboardPanel];

  function moveUiIntoFullscreen() {
    const fsEl = document.fullscreenElement;
    if (fullscreenUiActive || !fsEl || !isFullscreenOverVideo()) return;
    fullscreenUiActive = true;
    [...els.svg.children, ...els.elements.children].forEach((c) => c.classList.add("wa-fs-off"));
    fsEl.appendChild(els.root);
    FS_UI().forEach((n) => fsEl.appendChild(n));
    document.querySelectorAll(".wa-spray-confirm, .wa-popover, .wa-save-error").forEach((n) => fsEl.appendChild(n));
    compensateFullscreenScroll();
    positionAllAttachedLinks();
  }

  function moveUiOutOfFullscreen() {
    if (!fullscreenUiActive) return;
    fullscreenUiActive = false;
    const html = document.documentElement;
    html.appendChild(els.root);
    FS_UI().forEach((n) => html.appendChild(n));
    document.querySelectorAll(".wa-spray-confirm, .wa-popover, .wa-save-error").forEach((n) => html.appendChild(n));
    els.root.style.transform = "";
    els.root.style.minHeight = "";
    els.root.querySelectorAll(".wa-fs-off").forEach((c) => c.classList.remove("wa-fs-off"));
    positionAllAttachedLinks();
  }

  // Elementul din fullscreen e „fixed” la colțul ecranului, iar adnotările au coordonate de
  // pagină (cu scroll inclus) — deplasăm tot stratul cu scroll-ul curent ca să cadă exact.
  function compensateFullscreenScroll() {
    if (!fullscreenUiActive) return;
    els.root.style.transform = `translate(${-window.scrollX}px, ${-window.scrollY}px)`;
    els.root.style.minHeight = window.scrollY + window.innerHeight + "px";
  }
  window.addEventListener("scroll", compensateFullscreenScroll, { passive: true });

  function isFullscreenOverVideo() {
    const video = getMainVideo();
    const fsEl = document.fullscreenElement;
    if (!video || !fsEl || fsEl === video) return false;
    return fsEl.contains(video);
  }

  let videoLayerActive = false;
  // {domEl, domParent, domNext, control, controlParent, controlNext}[] — ca să
  // restaurăm exact locul din DOM al fiecărui element mutat, la ieșirea din fullscreen.
  const movedIntoVideoLayer = [];

  // Legată de video = are interval de timp SAU e desenată direct peste <video> (ancora e
  // video-ul). Pe Netflix/YouTube lumea se uită mai mult în fullscreen — un desen pus peste
  // film, chiar fără interval, trebuie să se vadă și acolo, nu doar în fereastră.
  function isVideoBound(ann) {
    if (ann.data?.videoRange) return true;
    const sel = ann.data?.anchor?.selector;
    if (!sel) return false;
    const video = getMainVideo();
    try {
      return !!video && anchorTarget(ann.data.anchor) === video;
    } catch {
      return false;
    }
  }

  function enterVideoFullscreen() {
    if (videoLayerActive || !isFullscreenOverVideo()) return;

    state.annotations.forEach((entry) => {
      if (!isVideoBound(entry.ann) || !entry.el) return; // doar adnotările legate de video
      const targetLayer = entry.el instanceof SVGElement ? els.videoSvg : els.videoElements;
      movedIntoVideoLayer.push({
        domEl: entry.el,
        domParent: entry.el.parentNode,
        domNext: entry.el.nextSibling,
        control: entry.control || null,
        controlParent: entry.control ? entry.control.parentNode : null,
        controlNext: entry.control ? entry.control.nextSibling : null,
      });
      targetLayer.appendChild(entry.el);
      if (entry.control) els.videoElements.appendChild(entry.control);
    });

    document.fullscreenElement.appendChild(els.videoRoot);
    els.videoRoot.classList.add("wa-active");
    videoLayerActive = true;
    repositionVideoLayerAnnotations();
  }

  function exitVideoFullscreen() {
    if (!videoLayerActive) return;
    // Vecinul memorat (nextSibling) poate fi el însuși mutat în stratul video — de obicei
    // chiar controlul de vot al adnotării. insertBefore cu un nod care nu mai e copilul
    // părintelui aruncă NotFoundError, oprea restaurarea la jumătate și lăsa adnotarea
    // blocată în stratul de fullscreen (apărea apoi și pe alte video-uri). Restaurăm în
    // ordine inversă, controlul înaintea adnotării, și cădem pe "la final" dacă vecinul lipsește.
    const restore = (node, parent, next) => {
      if (!node || !parent) return;
      parent.insertBefore(node, next && next.parentNode === parent ? next : null);
    };
    movedIntoVideoLayer
      .splice(0)
      .reverse()
      .forEach(({ domEl, domParent, domNext, control, controlParent, controlNext }) => {
        restore(control, controlParent, controlNext);
        restore(domEl, domParent, domNext);
      });
    els.videoRoot.classList.remove("wa-active");
    document.documentElement.appendChild(els.videoRoot);
    videoLayerActive = false;
    repositionAnchoredAnnotations(); // înapoi la coordonate normale, relative la document
  }

  // Poziționează (viewport-relative, fiindcă #wa-video-root e "position: fixed")
  // adnotările mutate în stratul de fullscreen. Nu atinge ann.data.dx/dy/x/y — alea
  // rămân coordonatele REALE, relative la document, pentru afișarea normală de după
  // ieșirea din fullscreen; aici calculăm doar o poziție de afișare temporară.
  function repositionVideoLayerAnnotations() {
    if (!videoLayerActive) return;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    state.annotations.forEach((entry) => {
      const ann = entry.ann;
      if (!ann.data.anchor || !entry.el || !movedIntoVideoLayer.some((m) => m.domEl === entry.el)) return;
      const resolved = resolveAnchor(ann.data.anchor); // document-relative, ca de obicei
      if (!resolved) return;

      const isSvg = entry.el instanceof SVGElement;
      if (isSvg) {
        const origin = svgOriginPoint(ann);
        if (!origin) return;
        const dx = resolved.x - scrollX - origin.x;
        const dy = resolved.y - scrollY - origin.y;
        ann._fit = resolved.fit;
        entry.el.style.transform = svgTransformFor(entry.el, ann, dx, dy);
      } else {
        entry.el.style.left = resolved.x - scrollX + "px";
        entry.el.style.top = resolved.y - scrollY + "px";
        ann._fit = resolved.fit;
        applyDomTransform(entry.el, ann);
      }
      placeControlAtElement(entry.el, entry.control);
    });
    positionAllAttachedLinks();
  }

  // ---------- Pen tool ----------

  // Pen-ul e o sesiune, la fel ca spray-ul: poți desena mai multe curse (ridici mâna, mai
  // desenezi, tot pe aceeași adnotare) — se salvează abia când apeși OK.
  function initPenTool() {
    let drawing = false; // în timpul unei singure curse (mouse apăsat)
    let sessionActive = false; // sesiune deschisă, așteaptă OK/Anulează
    let path = null;
    let d = "";
    let confirmBar = null;
    let anchor = null;

    function showConfirmBar() {
      if (confirmBar) return;
      confirmBar = el(
        "div",
        { class: "wa-spray-confirm" },
        el("span", {}, "✏️ Mai desenezi sau apeși OK?"),
        el("button", { class: "wa-spray-ok", onclick: () => finishSession() }, "✓ OK, gata"),
        el("button", { class: "wa-spray-cancel", onclick: () => cancelSession() }, "✕ Anulează")
      );
      uiHost().appendChild(confirmBar);
    }

    function hideConfirmBar() {
      confirmBar?.remove();
      confirmBar = null;
    }

    async function finishSession(fromToolSwitch) {
      if (!sessionActive) return;
      sessionActive = false;
      pendingToolFinish = null;
      hideConfirmBar();

      if (d.split(" L ").length < 2) {
        path.remove();
      } else {
        try {
          const ann = await WA_Api.createAnnotation({
            url: pageKey(),
            type: "pen",
            data: { d, color: state.color, strokeWidth: state.strokeWidth, anchor },
            authorId: state.userId,
          });
          const firstPoint = d.match(/M (-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?)/);
          const control = attachVoteControl(ann, Number(firstPoint[1]), Number(firstPoint[2]));
          makeMovable(ann, path, control);
          makeStyleEditableOnDblClick(ann, path);
          registerAnnotation(ann, path, control);
        } catch (err) {
          console.error("[Adormis] Nu am putut salva desenul:", err);
          showSaveError("Nu am putut salva desenul — verifică serverul.");
          path.remove();
        }
      }
      path = null;
      d = "";
      anchor = null;
      if (!fromToolSwitch) setActiveTool(null);
    }

    function cancelSession() {
      sessionActive = false;
      pendingToolFinish = null;
      hideConfirmBar();
      path?.remove();
      path = null;
      d = "";
      anchor = null;
      setActiveTool(null);
    }

    els.svg.addEventListener("pointerdown", (e) => {
      if (state.activeTool !== "pen") return;
      if (isOverLiveVideo(e.clientX, e.clientY)) return showLiveBlocked();
      drawing = true;
      const { x, y } = pagePoint(e);
      if (!sessionActive) {
        sessionActive = true;
        anchor = computeAnchor(e.clientX, e.clientY);
        d = `M ${x} ${y}`;
        path = svgEl("path", {
          d,
          stroke: state.color,
          "stroke-width": state.strokeWidth,
          fill: "none",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        });
        els.svg.appendChild(path);
        showConfirmBar();
        pendingToolFinish = finishSession;
      } else {
        d += ` M ${x} ${y}`; // cursă nouă, aceeași adnotare — nu se leagă de sfârșitul celei anterioare
        path.setAttribute("d", d);
      }
    });

    els.svg.addEventListener("pointermove", (e) => {
      if (!drawing || state.activeTool !== "pen") return;
      const { x, y } = pagePoint(e);
      d += ` L ${x} ${y}`;
      path.setAttribute("d", d);
    });

    window.addEventListener("pointerup", () => {
      if (!drawing) return;
      drawing = false;
      // nu salvăm aici — sesiunea rămâne deschisă până apeși OK sau Anulează
    });
  }

  // ---------- Spray tool ----------

  // Spray-ul e o sesiune: poți da spray de mai multe ori (ridici mâna de pe mouse,
  // dai iar spray, tot pe aceeași adnotare) — se salvează abia când apeși OK.
  function initSprayTool() {
    let sprayOrigin = null; // punctul exact al click-ului (primul punct e împrăștiat aleator în jurul lui)
    let spraying = false; // în timpul unei singure curse (mouse apăsat)
    let sessionActive = false; // sesiune deschisă, așteaptă OK/Anulează
    let group = null;
    let dots = [];
    let raf = null;
    let confirmBar = null;
    let anchor = null;
    // Ca la un spray real: cât ții apăsat pe loc, norul se îngroașă (nu doar la mișcare).
    let holdTimer = null;
    let lastPoint = null;

    function stopHold() {
      clearInterval(holdTimer);
      holdTimer = null;
    }

    function addDots(x, y) {
      for (let i = 0; i < 4; i++) {
        const jx = x + (Math.random() - 0.5) * state.strokeWidth * 4;
        const jy = y + (Math.random() - 0.5) * state.strokeWidth * 4;
        const r = Math.random() * (state.strokeWidth / 2) + 1;
        dots.push({ cx: jx, cy: jy, r });
        group.appendChild(svgEl("circle", { cx: jx, cy: jy, r, fill: state.color, "fill-opacity": 0.7 }));
      }
    }

    function showConfirmBar() {
      if (confirmBar) return;
      confirmBar = el(
        "div",
        { class: "wa-spray-confirm" },
        el("span", {}, "🎨 Mai dai spray sau apeși OK?"),
        el("button", { class: "wa-spray-ok", onclick: () => finishSession() }, "✓ OK, gata"),
        el("button", { class: "wa-spray-cancel", onclick: () => cancelSession() }, "✕ Anulează")
      );
      uiHost().appendChild(confirmBar);
    }

    function hideConfirmBar() {
      confirmBar?.remove();
      confirmBar = null;
    }

    async function finishSession(fromToolSwitch) {
      if (!sessionActive) return;
      sessionActive = false;
      pendingToolFinish = null;
      hideConfirmBar();

      if (dots.length === 0) {
        group.remove();
      } else {
        try {
          const ann = await WA_Api.createAnnotation({
            url: pageKey(),
            type: "spray",
            data: { dots, color: state.color, anchor, origin: sprayOrigin },
            authorId: state.userId,
          });
          const control = attachVoteControl(ann, dots[0].cx, dots[0].cy);
          makeMovable(ann, group, control);
          makeStyleEditableOnDblClick(ann, group);
          registerAnnotation(ann, group, control);
        } catch (err) {
          console.error("[Adormis] Nu am putut salva spray-ul:", err);
          showSaveError("Nu am putut salva graffiti-ul — verifică serverul.");
          group.remove();
        }
      }
      group = null;
      dots = [];
      anchor = null;
      // dacă a fost declanșat automat (ai schimbat unealta), nu suprascrie unealta nou aleasă
      if (!fromToolSwitch) setActiveTool(null);
    }

    function cancelSession() {
      sessionActive = false;
      pendingToolFinish = null;
      hideConfirmBar();
      group?.remove();
      group = null;
      dots = [];
      anchor = null;
      setActiveTool(null);
    }

    els.svg.addEventListener("pointerdown", (e) => {
      if (state.activeTool !== "spray") return;
      if (isOverLiveVideo(e.clientX, e.clientY)) return showLiveBlocked();
      spraying = true;
      if (!sessionActive) {
        sessionActive = true;
        anchor = computeAnchor(e.clientX, e.clientY);
        sprayOrigin = pagePoint(e);
        dots = [];
        group = svgEl("g");
        els.svg.appendChild(group);
        showConfirmBar();
        pendingToolFinish = finishSession; // dacă schimbi unealta fără OK, salvăm ce-i deja desenat
      }
      const { x, y } = pagePoint(e);
      addDots(x, y);
      lastPoint = { x, y };
      stopHold();
      holdTimer = setInterval(() => {
        if (!spraying || !group || state.activeTool !== "spray") return stopHold();
        addDots(lastPoint.x, lastPoint.y);
      }, 80);
    });

    els.svg.addEventListener("pointermove", (e) => {
      if (!spraying || state.activeTool !== "spray") return;
      const { x, y } = pagePoint(e);
      lastPoint = { x, y };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        addDots(x, y);
        raf = null;
      });
    });

    window.addEventListener("pointerup", () => {
      if (!spraying) return;
      spraying = false;
      stopHold();
      // nu salvăm aici — sesiunea rămâne deschisă până apeși OK sau Anulează
    });
  }

  // ---------- Shape tool (bubble / circle / arrow) ----------

  function ensureArrowMarker() {
    if (document.getElementById("wa-arrowhead")) return;
    const defs = svgEl("defs");
    const marker = svgEl("marker", {
      id: "wa-arrowhead",
      markerWidth: "10",
      markerHeight: "10",
      refX: "8",
      refY: "5",
      orient: "auto",
    });
    marker.appendChild(svgEl("path", { d: "M0,0 L10,5 L0,10 Z", fill: "context-stroke" }));
    defs.appendChild(marker);
    els.svg.appendChild(defs);
  }

  // Toate formele "simple" — un singur contur, fără umplere, ca stilul să fie unitar.
  // Folosit și în applyStyleToElement, ca să știe ce forme au stroke direct pe element
  // (față de vechea variantă "bulă", un <g> cu rect+polygon în interior).
  const SIMPLE_STROKE_SHAPES = new Set(["circle", "arrow", "rectangle", "square", "triangle", "diamond", "star"]);

  function renderShapeGeometry(shape, x1, y1, x2, y2, color, strokeWidth) {
    ensureArrowMarker();
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.max(Math.abs(x2 - x1), 4);
    const h = Math.max(Math.abs(y2 - y1), 4);

    if (shape === "circle") {
      return svgEl("ellipse", {
        cx: x + w / 2,
        cy: y + h / 2,
        rx: w / 2,
        ry: h / 2,
        stroke: color,
        "stroke-width": strokeWidth,
        fill: "none",
      });
    }
    if (shape === "arrow") {
      const line = svgEl("line", {
        x1,
        y1,
        x2,
        y2,
        stroke: color,
        "stroke-width": strokeWidth,
      });
      line.setAttribute("marker-end", "url(#wa-arrowhead)");
      line.style.stroke = color; // pentru context-stroke pe marker
      return line;
    }
    if (shape === "rectangle") {
      return svgEl("rect", { x, y, width: w, height: h, stroke: color, "stroke-width": strokeWidth, fill: "none" });
    }
    if (shape === "square") {
      // pătrat = latură egală cu latura mai mare a drag-ului, păstrând colțul de start
      const side = Math.max(w, h);
      const sx = x2 >= x1 ? x1 : x1 - side;
      const sy = y2 >= y1 ? y1 : y1 - side;
      return svgEl("rect", { x: sx, y: sy, width: side, height: side, stroke: color, "stroke-width": strokeWidth, fill: "none" });
    }
    if (shape === "triangle") {
      const points = `${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`;
      return svgEl("polygon", { points, stroke: color, "stroke-width": strokeWidth, fill: "none" });
    }
    if (shape === "diamond") {
      const points = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
      return svgEl("polygon", { points, stroke: color, "stroke-width": strokeWidth, fill: "none" });
    }
    if (shape === "star") {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const innerRatio = 0.42; // cât de "ascuțită" e steaua
      const points = [];
      for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 1 : innerRatio;
        points.push(`${cx + Math.cos(angle) * (w / 2) * r},${cy + Math.sin(angle) * (h / 2) * r}`);
      }
      return svgEl("polygon", { points: points.join(" "), stroke: color, "stroke-width": strokeWidth, fill: "none" });
    }

    // bulă desenată — variantă veche a uneltei Formă, nu mai e selectabilă din meniu,
    // păstrată doar ca să randeze corect adnotările mai vechi create cu ea.
    const bw = Math.max(w, 20);
    const bh = Math.max(h, 20);
    const g = svgEl("g");
    g.appendChild(
      svgEl("rect", { x, y, width: bw, height: bh, rx: 12, stroke: color, "stroke-width": strokeWidth, fill: "white", "fill-opacity": 0.15 })
    );
    g.appendChild(
      svgEl("polygon", {
        points: `${x + 16},${y + bh} ${x + 32},${y + bh} ${x + 12},${y + bh + 16}`,
        fill: color,
      })
    );
    return g;
  }

  // Ca la Pen: tragi forma, poți re-trage câte ori vrei ca s-o ajustezi, se salvează
  // abia la OK. Nu se dezactivează unealta până nu apeși OK sau Anulează.
  function initShapeTool() {
    let dragging = false;
    let pending = false; // formă desenată, așteaptă OK/Anulează
    let start = null;
    let finalEnd = null;
    let preview = null;
    let anchor = null;
    let confirmBar = null;

    function showConfirmBar() {
      if (confirmBar) return;
      confirmBar = el(
        "div",
        { class: "wa-spray-confirm" },
        el("span", {}, "💬 Mai tragi o formă nouă sau apeși OK?"),
        el("button", { class: "wa-spray-ok", onclick: () => finishPending() }, "✓ OK, gata"),
        el("button", { class: "wa-spray-cancel", onclick: () => cancelPending() }, "✕ Anulează")
      );
      uiHost().appendChild(confirmBar);
    }

    function hideConfirmBar() {
      confirmBar?.remove();
      confirmBar = null;
    }

    function resetState() {
      preview = null;
      start = null;
      finalEnd = null;
      anchor = null;
    }

    async function finishPending(fromToolSwitch) {
      if (!pending) return;
      pending = false;
      pendingToolFinish = null;
      hideConfirmBar();

      try {
        const ann = await WA_Api.createAnnotation({
          url: pageKey(),
          type: "shape",
          data: {
            shape: state.shapeKind,
            x1: start.x,
            y1: start.y,
            x2: finalEnd.x,
            y2: finalEnd.y,
            color: state.color,
            strokeWidth: state.strokeWidth,
            anchor,
          },
          authorId: state.userId,
        });
        const control = attachVoteControl(ann, (start.x + finalEnd.x) / 2, (start.y + finalEnd.y) / 2);
        makeMovable(ann, preview, control);
        makeStyleEditableOnDblClick(ann, preview);
        registerAnnotation(ann, preview, control);
      } catch (err) {
        console.error("[Adormis] Nu am putut salva forma:", err);
        showSaveError("Nu am putut salva forma — verifică serverul.");
        preview?.remove();
      }
      resetState();
      if (!fromToolSwitch) setActiveTool(null);
    }

    function cancelPending() {
      pending = false;
      pendingToolFinish = null;
      hideConfirmBar();
      preview?.remove();
      resetState();
      setActiveTool(null);
    }

    els.svg.addEventListener("pointerdown", (e) => {
      if (state.activeTool !== "shape") return;
      if (isOverLiveVideo(e.clientX, e.clientY)) return showLiveBlocked();
      dragging = true;
      preview?.remove(); // re-tragi -> înlocuiește forma anterioară nesalvată
      start = pagePoint(e);
      anchor = computeAnchor(e.clientX, e.clientY);
      preview = renderShapeGeometry(state.shapeKind, start.x, start.y, start.x, start.y, state.color, state.strokeWidth);
      els.svg.appendChild(preview);
    });

    els.svg.addEventListener("pointermove", (e) => {
      if (!dragging || state.activeTool !== "shape") return;
      const p = pagePoint(e);
      preview.remove();
      preview = renderShapeGeometry(state.shapeKind, start.x, start.y, p.x, p.y, state.color, state.strokeWidth);
      els.svg.appendChild(preview);
    });

    window.addEventListener("pointerup", (e) => {
      if (!dragging || state.activeTool !== "shape") return;
      dragging = false;
      let end = pagePoint(e);
      if (Math.hypot(end.x - start.x, end.y - start.y) < 6) {
        // click simplu, fără drag: punem o formă cu dimensiune implicită în loc să nu apară nimic
        end = { x: start.x + 60, y: start.y + 60 };
        preview.remove();
        preview = renderShapeGeometry(state.shapeKind, start.x, start.y, end.x, end.y, state.color, state.strokeWidth);
        els.svg.appendChild(preview);
      }
      finalEnd = end;
      pending = true;
      showConfirmBar();
      pendingToolFinish = finishPending;
    });
  }

  // ---------- Text tool ----------

  function initTextTool() {
    els.elements.addEventListener("click", (e) => {
      if (state.activeTool !== "text") return;
      if (e.target.closest(".wa-text-box") || e.target.closest(".wa-vote")) return;
      if (isOverLiveVideo(e.clientX, e.clientY)) return showLiveBlocked();
      const { x, y } = pagePoint(e);
      createEditableTextBox(x, y, e.clientX, e.clientY);
      setActiveTool(null); // un singur text per activare, apoi revii la select
    });
  }

  // Ca la Pen: scrii, poți continua să editezi (blur-ul NU mai salvează automat),
  // se salvează abia când apeși OK.
  function createEditableTextBox(x, y, clientX, clientY) {
    const anchor = computeAnchor(clientX, clientY);
    const box = el("div", {
      class: "wa-text-box",
      contenteditable: "true",
      style: `left:${x}px; top:${y}px; border-color:${state.color};`,
    });
    stopKeysPropagating(box);
    els.elements.appendChild(box);
    box.focus();

    const confirmBar = el(
      "div",
      { class: "wa-spray-confirm" },
      el("span", {}, "🔤 Scrie textul, apoi apasă OK"),
      el("button", { class: "wa-spray-ok" }, "✓ OK, gata"),
      el("button", { class: "wa-spray-cancel" }, "✕ Anulează")
    );
    uiHost().appendChild(confirmBar);

    function cleanup() {
      confirmBar.remove();
      box.remove();
    }

    confirmBar.querySelector(".wa-spray-ok").onclick = async () => {
      const text = box.textContent.trim();
      cleanup();
      if (!text) return;
      try {
        const ann = await WA_Api.createAnnotation({
          url: pageKey(),
          type: "text",
          data: { x, y, text, color: state.color, anchor },
          authorId: state.userId,
        });
        renderTextAnnotation(ann);
      } catch (err) {
        console.error("[Adormis] Nu am putut salva textul:", err);
        showSaveError("Nu am putut salva textul — verifică serverul.");
      }
    };
    confirmBar.querySelector(".wa-spray-cancel").onclick = () => cleanup();
  }

  function renderTextAnnotation(ann) {
    const box = el(
      "div",
      {
        class: "wa-text-box",
        style: `left:${ann.data.x}px; top:${ann.data.y}px; border-color:${ann.data.color}; transform: rotate(${ann.data.rotate || 0}deg) scale(${ann.data.scale || 1});`,
      },
      ann.data.text
    );
    stopKeysPropagating(box);
    els.elements.appendChild(box);
    const control = attachVoteControl(ann, ann.data.x, ann.data.y);
    makeMovable(ann, box, control);
    makeEditableOnDblClick(ann, box, {});
    registerAnnotation(ann, box, control);
  }

  // ---------- Bulă cu text (click direct pe pagină, fără drag) ----------

  function initBubbleTool() {
    els.elements.addEventListener("click", (e) => {
      if (state.activeTool !== "bubble") return;
      if (e.target.closest(".wa-bubble") || e.target.closest(".wa-vote")) return;
      if (isOverLiveVideo(e.clientX, e.clientY)) return showLiveBlocked();
      const { x, y } = pagePoint(e);
      createEditableBubble(x, y, e.clientX, e.clientY);
      setActiveTool(null); // o singură bulă per activare, apoi revii la select
    });
  }

  // Ca la Pen: scrii, poți continua să editezi (blur-ul NU mai salvează automat),
  // se salvează abia când apeși OK.
  function createEditableBubble(x, y, clientX, clientY) {
    const anchor = computeAnchor(clientX, clientY);
    const bubble = el("div", {
      class: "wa-bubble",
      contenteditable: "true",
      style: `left:${x}px; top:${y}px; background:${state.color};`,
    });
    stopKeysPropagating(bubble);
    els.elements.appendChild(bubble);
    bubble.focus();

    const confirmBar = el(
      "div",
      { class: "wa-spray-confirm" },
      el("span", {}, "💬 Scrie bula, apoi apasă OK"),
      el("button", { class: "wa-spray-ok" }, "✓ OK, gata"),
      el("button", { class: "wa-spray-cancel" }, "✕ Anulează")
    );
    uiHost().appendChild(confirmBar);

    function cleanup() {
      confirmBar.remove();
      bubble.remove();
    }

    confirmBar.querySelector(".wa-spray-ok").onclick = async () => {
      const text = bubble.textContent.trim();
      cleanup();
      if (!text) return;
      try {
        const ann = await WA_Api.createAnnotation({
          url: pageKey(),
          type: "bubble",
          data: { x, y, text, color: state.color, anchor },
          authorId: state.userId,
        });
        renderBubbleAnnotation(ann);
      } catch (err) {
        console.error("[Adormis] Nu am putut salva bula:", err);
        showSaveError("Nu am putut salva bula — verifică serverul.");
      }
    };
    confirmBar.querySelector(".wa-spray-cancel").onclick = () => cleanup();
  }

  function renderBubbleAnnotation(ann) {
    const bubble = el(
      "div",
      {
        class: "wa-bubble",
        style: `left:${ann.data.x}px; top:${ann.data.y}px; background:${ann.data.color}; transform: rotate(${ann.data.rotate || 0}deg) scale(${ann.data.scale || 1});`,
      },
      ann.data.text
    );
    stopKeysPropagating(bubble);
    els.elements.appendChild(bubble);
    const control = attachVoteControl(ann, ann.data.x, ann.data.y);
    makeMovable(ann, bubble, control);
    makeEditableOnDblClick(ann, bubble, {});
    registerAnnotation(ann, bubble, control);
  }

  // ---------- Link către alt conținut ----------

  function initLinkTool() {
    els.elements.addEventListener("click", (e) => {
      if (state.activeTool !== "link") return;
      if (e.target.closest(".wa-popover") || e.target.closest(".wa-vote") || e.target.closest(".wa-link-badge")) return;
      if (isOverLiveVideo(e.clientX, e.clientY)) return showLiveBlocked();
      const { x, y } = pagePoint(e);
      openLinkForm(x, y, e.clientX, e.clientY);
      setActiveTool(null);
    });
  }

  // editing = adnotarea existentă, dacă e apelat pentru editare (dublu-click) în loc de creare
  function openLinkForm(x, y, clientX, clientY, editing) {
    document.querySelectorAll(".wa-popover").forEach((p) => p.remove());
    const anchor = editing ? null : computeAnchor(clientX, clientY);

    const urlInput = el("input", { type: "url", placeholder: "https://...", value: editing?.data.url || "" });
    const labelInput = el("input", {
      type: "text",
      placeholder: "Text afișat (opțional)",
      value: editing?.data.label || "",
    });
    stopKeysPropagating(urlInput);
    stopKeysPropagating(labelInput);

    const left = Math.min(clientX, window.innerWidth - 240);
    const top = Math.min(clientY, window.innerHeight - 160);

    const rangeFields = editing ? buildVideoRangeFields(editing, state.annotations.get(editing.id)?.el) : null;

    const popover = el(
      "div",
      { class: "wa-popover", style: `top:${Math.max(top, 8)}px; left:${Math.max(left, 8)}px;` },
      el("label", {}, "URL"),
      urlInput,
      el("label", {}, "Text afișat (opțional)"),
      labelInput,
      ...(rangeFields ? rangeFields.fields : []),
      el(
        "div",
        { class: "wa-actions" },
        el("button", { class: "wa-cancel", onclick: () => popover.remove() }, "Anulează"),
        el("button", { class: "wa-submit" }, editing ? "Salvează" : "Adaugă")
      )
    );

    popover.querySelector(".wa-submit").onclick = async () => {
      let url = urlInput.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      const label = labelInput.value.trim();

      // Verificare URLhaus ÎNAINTE de salvare — dacă link-ul e semnalat, blocăm
      // și arătăm un avertisment, fără să atingem popover-ul (rămâne deschis, ca
      // utilizatorul să poată corecta URL-ul sau anula). Fail-open: dacă verificarea
      // nu a putut rula deloc (server jos, fără cheie configurată), `safe` vine `true`
      // — nu blocăm postarea unui link doar pentru că paza suplimentară e indisponibilă.
      const submitBtn = popover.querySelector(".wa-submit");
      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = "Se verifică...";
      const verdict = await WA_Api.checkUrl(url);
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
      if (verdict.checked && !verdict.safe) {
        showLinkBlockedWarning(url, verdict.threats);
        return;
      }

      try {
        if (editing) {
          const patch = { url, label };
          editing.data.url = url;
          editing.data.label = label;
          if (rangeFields) {
            const newRange = rangeFields.readRange();
            if (newRange) {
              editing.data.videoRange = newRange;
              patch.videoRange = newRange;
            }
          }
          await WA_Api.updateAnnotation(editing.id, state.userId, patch);
          const entry = state.annotations.get(editing.id);
          if (entry?.el) {
            entry.el.href = url;
            entry.el.textContent = `🔗 ${label || shortenUrl(url)}`;
          }
        } else {
          const ann = await WA_Api.createAnnotation({
            url: pageKey(),
            type: "link",
            data: { x, y, url, label, color: state.color, anchor },
            authorId: state.userId,
          });
          renderLinkAnnotation(ann);
        }
      } catch (err) {
        console.error("[Adormis] Nu am putut salva link-ul:", err, err?.stack);
        showSaveError("Nu am putut salva link-ul — verifică serverul.");
      }
      popover.remove();
    };

    uiHost().appendChild(popover);
    clampToViewport(popover);
    urlInput.focus();
  }

  // Pop-up de avertisment când verificarea (URLhaus) semnalează link-ul ca periculos
  // (vezi checkUrl în api.js + server/routes/check-url.js). Backdrop + card centrat —
  // mai vizibil decât un toast obișnuit (showSaveError), intenționat, pentru un
  // avertisment de securitate care merită atenție, nu doar o notă trecătoare.
  // Etichete pentru codurile de amenințare întoarse de serviciul de verificare
  // (URLhaus folosește mai ales "malware_download"; restul rămân aici pentru
  // compatibilitate, dacă se schimbă vreodată furnizorul — vezi server/routes/check-url.js).
  const THREAT_LABELS = {
    malware_download: "distribuire de malware",
    MALWARE: "malware",
    SOCIAL_ENGINEERING: "phishing / inginerie socială",
    UNWANTED_SOFTWARE: "software nedorit",
    POTENTIALLY_HARMFUL_APPLICATION: "aplicație potențial periculoasă",
  };

  function showLinkBlockedWarning(url, threats) {
    const threatText = (threats || []).map((t) => THREAT_LABELS[t] || t).join(", ") || "conținut periculos";
    const backdrop = el("div", { class: "wa-link-warning-backdrop" });
    const box = el(
      "div",
      { class: "wa-link-warning" },
      el("h3", {}, "⚠️ Link nesigur"),
      el("p", {}, `Verificarea automată a semnalat acest link ca: ${threatText}.`),
      el("p", { class: "wa-link-warning-url" }, url),
      el("button", { onclick: () => backdrop.remove() }, "Am înțeles")
    );
    backdrop.appendChild(box);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    uiHost().appendChild(backdrop);
  }

  function shortenUrl(url) {
    try {
      const u = new URL(url);
      // decodăm ca diacriticele să apară normal ("Bistrița", nu "Bistri%C8%9Ba")
      let path = u.pathname;
      try {
        path = decodeURIComponent(path);
      } catch {}
      const tail = path !== "/" ? path.slice(0, 20) : "";
      return u.hostname.replace(/^www\./, "") + tail;
    } catch {
      return url.slice(0, 30);
    }
  }

  function renderLinkAnnotation(ann) {
    // Adnotările vin de la server și pot fi trimise de oricine direct la API — nu
    // afișăm niciodată un link care nu e http(s) (ex. `javascript:...`).
    if (!/^https?:\/\//i.test(String(ann.data.url))) return;
    const badge = el(
      "a",
      {
        class: "wa-link-badge",
        href: ann.data.url,
        target: "_blank",
        rel: "noopener noreferrer",
        style: `left:${ann.data.x}px; top:${ann.data.y}px; border-color:${ann.data.color}; transform: rotate(${ann.data.rotate || 0}deg) scale(${ann.data.scale || 1});`,
      },
      `🔗 ${ann.data.label || shortenUrl(ann.data.url)}`
    );
    els.elements.appendChild(badge);
    const control = attachVoteControl(ann, ann.data.x, ann.data.y);
    makeMovable(ann, badge, control);

    // Click simplu = deschide link-ul. Dublu-click (doar autorul) = editează.
    // Amânăm deschiderea cu o mică întârziere, ca al doilea click al unui dublu-click
    // s-o poată anula la timp — altfel orice dublu-click de editare ar deschide și
    // link-ul o dată pe drum, înainte să apuce browserul să recunoască dublu-click-ul.
    let openTimer = null;
    // În fullscreen badge-ul stă înăuntrul player-ului: fără stopPropagation, YouTube/Netflix
    // primesc și ei click-ul (play/pauză, ascund controalele) în loc să se deschidă link-ul.
    ["pointerdown", "mousedown"].forEach((type) =>
      badge.addEventListener(type, (e) => e.stopPropagation())
    );
    badge.addEventListener("click", (e) => {
      e.preventDefault(); // navigăm noi manual (vezi mai jos), nu prin href-ul nativ
      e.stopPropagation();
      if (openTimer) return; // al doilea click al unui dublu-click — nu programa încă un tab
      openTimer = setTimeout(() => {
        openTimer = null;
        window.open(ann.data.url, "_blank", "noopener,noreferrer");
      }, 250);
    });

    if (isMine(ann)) {
      badge.addEventListener("dblclick", (e) => {
        if (openTimer) {
          clearTimeout(openTimer);
          openTimer = null;
        }
        e.preventDefault();
        e.stopPropagation();
        pauseVideoIfPlaying();
        openLinkForm(ann.data.x, ann.data.y, e.clientX, e.clientY, ann);
      });
    }

    registerAnnotation(ann, badge, control);
  }

  // ---------- Video bubbles ----------

  const IS_NETFLIX = /(^|\.)netflix\.com$/.test(location.hostname);

  // Netflix NU suportă video.currentTime = ... (player-ul se oprește cu eroarea M7375) —
  // acolo cerem player-ului lor să sară, prin page-bridge.js (rulează în lumea paginii,
  // singura care vede API-ul `netflix`). Peste tot altundeva, direct pe <video>.
  function seekVideo(video, seconds) {
    if (IS_NETFLIX) {
      window.postMessage({ source: "adormis", type: "seek", seconds }, location.origin);
      return;
    }
    if (video) video.currentTime = seconds;
  }

  function pauseVideo(video) {
    if (IS_NETFLIX) {
      window.postMessage({ source: "adormis", type: "pause" }, location.origin);
      return;
    }
    video?.pause();
  }

  function getMainVideo() {
    return document.querySelector("video");
  }

  // Semnal standard pentru "e live": un video la cerere (VOD) are mereu o durată
  // finită; un stream live nativ (HLS etc.) raportează Infinity pe <video>.duration.
  // Cât timp durata încă nu s-a încărcat (NaN), nu tragem nicio concluzie — mai bine
  // să nu blocăm din greșeală un VOD normal chiar în primele clipe după load.
  function isLiveVideo(video) {
    video = video || getMainVideo();
    if (!video) return false;
    if (video.duration === Infinity) return true;
    // YouTube redă live-urile prin MediaSource cu o durată FINITĂ (fereastra DVR), deci
    // testul de mai sus nu le prinde. Player-ul marchează însă afișajul timpului cu
    // "ytp-live" doar pe live — îl căutăm în player-ul care conține video-ul.
    const player = video.closest(".html5-video-player");
    return !!player?.querySelector(".ytp-time-display.ytp-live");
  }

  // Punctul de ecran (clientX, clientY) cade peste fereastra unui video care e ACUM
  // live? Folosit ca să blocăm crearea de adnotări chiar acolo — vezi isLiveVideo mai
  // sus pentru motiv (timestamp-uri care nu mai au sens după ce live-ul se termină).
  // Restul paginii (tot ce nu se suprapune cu video-ul) rămâne neatins.
  function isOverLiveVideo(clientX, clientY) {
    const video = getMainVideo();
    if (!isLiveVideo(video)) return false;
    return isOverVideo({ left: clientX, right: clientX, top: clientY, bottom: clientY });
  }

  function showLiveBlocked() {
    showSaveError("Nu poți adnota peste un video live — reîncearcă după ce se termină transmisiunea.");
  }

  // Oprește video-ul de fiecare dată când intri în editare (dublu-click), ca să nu
  // treacă de intervalul pe care-l editezi cât timp te uiți la formular.
  function pauseVideoIfPlaying() {
    const video = getMainVideo();
    if (video && !video.paused) pauseVideo(video);
  }

  // Unealta dedicată "Bulă video" a fost scoasă — era un duplicat al Bulă + "Legat de
  // video", care face același lucru și e mai fiabilă. Păstrăm doar randarea, ca
  // adnotările video_bubble create anterior să tot apară corect.
  function renderVideoBubble(ann, video) {
    const bubble = el(
      "div",
      { class: "wa-video-bubble", style: `background:${ann.data.color};` },
      ann.data.text
    );
    els.elements.appendChild(bubble);

    function reposition() {
      const rect = video.getBoundingClientRect();
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      bubble.style.left = rect.left + scrollX + (rect.width * ann.data.xPct) / 100 + "px";
      bubble.style.top = rect.top + scrollY + (rect.height * ann.data.yPct) / 100 + "px";
    }

    function updateVisibility() {
      const t = video.currentTime;
      const visible = t >= ann.data.timestamp && t <= ann.data.timestamp + ann.data.duration;
      bubble.classList.toggle("wa-visible", visible);
      if (visible) reposition();
    }

    video.addEventListener("timeupdate", updateVisibility);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, { passive: true });
    updateVisibility();

    const control = attachVoteControl(ann, 0, 0);
    control.style.display = "none"; // arătat doar cât bula e vizibilă, mai jos
    video.addEventListener("timeupdate", () => {
      control.style.display = bubble.classList.contains("wa-visible") ? "" : "none";
      if (bubble.classList.contains("wa-visible")) placeControlAtElement(bubble, control);
    });

    registerAnnotation(ann, bubble, control);
  }

  // ---------- Rendering existing annotations ----------

  // Aplică poziția/zoom-ul/rotirea salvate (dacă autorul le-a modificat anterior)
  // unui element SVG la redare — vezi applySvgTransform.
  function applyStoredOffset(svgElement, ann) {
    applySvgTransform(svgElement, ann);
  }

  // Datele vin de la server și ajung în stiluri CSS / atribute SVG. Serverul le validează
  // (vezi validateAnnotation), dar nu ne bazăm doar pe el: o adnotare veche sau trimisă direct
  // la API cu o „culoare” ca `red; background:url(https://...)` ar face browserul fiecărui
  // vizitator să acceseze o adresă străină. Ce nu arată ca o valoare validă e înlocuit.
  const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;
  const NUM_FIELDS = ["x", "y", "x1", "y1", "x2", "y2", "dx", "dy", "rotate", "scale", "strokeWidth", "xPct", "yPct", "timestamp", "duration"];

  function sanitizeAnnotation(ann) {
    const d = ann.data && typeof ann.data === "object" ? ann.data : (ann.data = {});
    if (d.color !== undefined && !SAFE_COLOR.test(String(d.color))) d.color = "#89CFF0";
    NUM_FIELDS.forEach((f) => {
      if (d[f] !== undefined && !(typeof d[f] === "number" && Number.isFinite(d[f]))) d[f] = f === "scale" ? 1 : 0;
    });
    if (d.text !== undefined) d.text = String(d.text);
    if (d.label !== undefined) d.label = String(d.label);
    if (d.d !== undefined && !/^[MLQCZmlqcz0-9.,\s+\-eE]*$/.test(String(d.d))) d.d = "";
    if (Array.isArray(d.dots)) d.dots = d.dots.filter((p) => p && [p.cx, p.cy, p.r].every(Number.isFinite));
    return ann;
  }

  function renderAnnotation(ann) {
    sanitizeAnnotation(ann);
    switch (ann.type) {
      case "pen": {
        const path = svgEl("path", {
          d: ann.data.d,
          stroke: ann.data.color,
          "stroke-width": ann.data.strokeWidth,
          fill: "none",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        });
        applyStoredOffset(path, ann);
        els.svg.appendChild(path);
        const m = ann.data.d.match(/M (-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?)/);
        const control = attachVoteControl(
          ann,
          Number(m?.[1] || 0) + (ann.data.dx || 0),
          Number(m?.[2] || 0) + (ann.data.dy || 0)
        );
        makeMovable(ann, path, control);
        makeStyleEditableOnDblClick(ann, path);
        registerAnnotation(ann, path, control);
        break;
      }
      case "spray": {
        const group = svgEl("g");
        ann.data.dots.forEach((d) =>
          group.appendChild(svgEl("circle", { cx: d.cx, cy: d.cy, r: d.r, fill: ann.data.color, "fill-opacity": 0.7 }))
        );
        applyStoredOffset(group, ann);
        els.svg.appendChild(group);
        const first = ann.data.dots[0] || { cx: 0, cy: 0 };
        const control = attachVoteControl(ann, first.cx + (ann.data.dx || 0), first.cy + (ann.data.dy || 0));
        makeMovable(ann, group, control);
        makeStyleEditableOnDblClick(ann, group);
        registerAnnotation(ann, group, control);
        break;
      }
      case "shape": {
        ensureArrowMarker();
        const shapeEl = renderShapeGeometry(
          ann.data.shape,
          ann.data.x1,
          ann.data.y1,
          ann.data.x2,
          ann.data.y2,
          ann.data.color,
          ann.data.strokeWidth
        );
        applyStoredOffset(shapeEl, ann);
        els.svg.appendChild(shapeEl);
        const control = attachVoteControl(
          ann,
          (ann.data.x1 + ann.data.x2) / 2 + (ann.data.dx || 0),
          (ann.data.y1 + ann.data.y2) / 2 + (ann.data.dy || 0)
        );
        makeMovable(ann, shapeEl, control);
        makeStyleEditableOnDblClick(ann, shapeEl);
        registerAnnotation(ann, shapeEl, control);
        break;
      }
      case "text":
        renderTextAnnotation(ann);
        break;
      case "bubble":
        renderBubbleAnnotation(ann);
        break;
      case "link":
        renderLinkAnnotation(ann);
        break;
      case "video_bubble": {
        const video = getMainVideo();
        if (video) renderVideoBubble(ann, video);
        break;
      }
    }
  }

  function annotationIcon(type) {
    return { text: "🔤", bubble: "💬", link: "🔗", pen: "✏️", spray: "🎨", shape: "◯", video_bubble: "🎬" }[type] || "❓";
  }

  function shortLabel(ann) {
    if (ann.type === "text" || ann.type === "bubble" || ann.type === "video_bubble") {
      return `„${ann.data.text.slice(0, 24)}"`;
    }
    if (ann.type === "link") return ann.data.label || ann.data.url;
    if (ann.type === "pen") return "desen";
    if (ann.type === "spray") return "graffiti";
    if (ann.type === "shape") return "formă";
    return ann.type;
  }

  // Ale cui sunt adnotările: serverul nu mai trimite authorId (e secretul de editare), doar
  // amprenta lui — o comparăm cu amprenta propriului ID (state.userHash).
  function isMine(ann) {
    return !!ann?.authorHash && ann.authorHash === state.userHash;
  }

  function authorLabel(authorHash) {
    const short = String(authorHash || "????").slice(0, 4).toUpperCase();
    return authorHash === state.userHash ? `Tu (${short})` : `Utilizator ${short}`;
  }

  // Cele 10 cifre din panoul din dreapta: colorate (cu propria culoare) dacă există o
  // adnotare pe locul respectiv, gri dacă locul e gol. E TOP GLOBAL — cele mai votate
  // adnotări de pe TOATE paginile de pe net (nu doar pagina curentă) — vezi refreshGlobalTop.
  // Doar repictează (state.pageTop sau state.globalTop); nu face fetch aici.
  // Butonul de deasupra bilelor comută între topul paginii (implicit) și topul global.
  function setTopMode(mode) {
    state.topMode = mode;
    chrome.storage.local.set({ wa_top_mode: mode }).catch(() => {});
    document.querySelectorAll(".wa-lb-detail").forEach((p) => p.remove());
    renderSidebar();
  }

  function renderSidebar() {
    if (!els.leaderboardSlots) return;

    const global = state.topMode === "global";
    if (els.topModeBtn) {
      els.topModeBtn.textContent = global ? "🌐" : "📄";
      els.topModeBtn.title = global
        ? "Top global (toate paginile) — click pentru topul paginii"
        : "Topul paginii — click pentru topul global";
    }
    const top10 = (global ? state.globalTop : state.pageTop) || [];
    els.leaderboardSlots.forEach((slot, i) => {
      const ann = top10[i];
      slot.onclick = null;
      if (!ann) {
        slot.className = "wa-lb-slot";
        slot.style.background = "";
        slot.title = "";
        return;
      }
      slot.className = "wa-lb-slot wa-lb-filled";
      // culoarea vine de la server (Top global) — doar #hex, altfel `url(...)` ar încărca o adresă străină
      slot.style.background = SAFE_COLOR.test(String(ann.data?.color)) ? ann.data.color : "#7c3aed";
      // tooltip nativ la hover — nume + pagina pe care e adnotarea; click = detalii complete
      slot.title = `${shortLabel(ann)} — pe ${shortenUrl(ann.url)}\nClick pentru detalii`;
      slot.onclick = () => showLeaderboardDetail(ann, slot);
    });
  }

  // Aduce de pe server topul global (de pe TOATE paginile, nu doar cea curentă) și
  // repictează panoul. Apelat la pornire, după orice vot (poate schimba ordinea),
  // la navigare (SPA) și periodic — ca să prindă și voturile date de alții, pe alte
  // pagini/taburi, între timp.
  async function refreshGlobalTop() {
    if (!state.consent) return; // fără acord, nicio cerere spre server
    try {
      state.globalTop = await WA_Api.listTopGlobal(10);
    } catch (err) {
      console.warn("[Adormis] Nu am putut încărca top-ul global:", err);
    }
    renderSidebar();
  }

  // Popover cu detalii la click pe o cifră: ce e, cine a pus-o, pe ce pagină, câte voturi.
  // Fiind top GLOBAL, adnotarea poate fi de pe cu totul altă pagină decât cea deschisă —
  // atunci arătăm un buton ca să sari acolo, în loc să încercăm s-o găsim pe pagina asta.
  function showLeaderboardDetail(ann, anchorEl) {
    document.querySelectorAll(".wa-lb-detail").forEach((p) => p.remove());
    const onThisPage = ann.url === pageKey();

    const rows = [
      el(
        "button",
        {
          class: "wa-lb-detail-author",
          title: "Vezi toate adnotările acestui utilizator",
          onclick: () => {
            detail.remove();
            openUserProfile(ann.authorHash);
          },
        },
        `${annotationIcon(ann.type)} ${authorLabel(ann.authorHash)} ›`
      ),
      el("div", { class: "wa-lb-detail-text" }, shortLabel(ann)),
      el("div", { class: "wa-lb-detail-row" }, `📄 ${shortenUrl(ann.url)}`),
    ];
    if (ann.data?.videoRange) {
      rows.push(el("div", { class: "wa-lb-detail-row" }, `🎬 la ${formatTime(ann.data.videoRange.start)}–${formatTime(ann.data.videoRange.end)}`));
    }
    rows.push(el("div", { class: "wa-lb-detail-row" }, `${ann.votes} 👍`));
    if (!onThisPage) {
      rows.push(
        el(
          "button",
          {
            class: "wa-lb-detail-open",
            onclick: () => goToAnnotation(ann), // tab nou, direct la poziția adnotării
          },
          "↗ Deschide pagina"
        )
      );
    }

    const rect = anchorEl.getBoundingClientRect();
    const detail = el(
      "div",
      { class: "wa-lb-detail", style: `top:${rect.top}px; right:${window.innerWidth - rect.left + 10}px;` },
      el("button", { class: "wa-lb-detail-close", onclick: () => detail.remove() }, "✕"),
      ...rows
    );
    uiHost().appendChild(detail);
    clampToViewport(detail);

    if (onThisPage) goToAnnotation(ann); // la poziția exactă: derulează, evidențiază (și sare în video)

    setTimeout(() => {
      document.addEventListener("click", function onDocClick(e) {
        if (!detail.contains(e.target) && e.target !== anchorEl) {
          detail.remove();
          document.removeEventListener("click", onDocClick);
        }
      });
    }, 0);
  }

  // ---------- Panou "Ale mele" ----------

  // Apelat DOAR din refreshTopbarVisibility()/closeTopbarNow() — panoul nu mai are
  // buton propriu de toggle, se ține sincron cu starea tab-ului (vezi mai sus).
  // Panoul de profil: "Ale mele" (user = tu) sau profilul altcuiva (click pe autor în Top).
  function setMinePanelOpen(open, user = state.userHash) {
    if (state.myPanelOpen === open && (!open || state.panelUser === user)) return;
    if (open && state.panelUser !== user) {
      state.panelUser = user;
      state.panelAll = null;
      state.mineQuery = "";
      if (els.mineSearch) els.mineSearch.value = "";
    }
    state.myPanelOpen = open;
    els.minePanel.hidden = !open;
    els.mineBtn?.classList.toggle("active", open && user === state.userHash);
    if (open) {
      const me = user === state.userHash;
      els.mineTitle.textContent = me ? "📍 Adnotările mele" : `👤 ${authorLabel(user)}`;
      positionMinePanel();
      renderMineList();
      loadPanelAll(); // și pentru numărul total, nu doar pentru tab-ul "Toate paginile"
    }
    // deschis sau închis, adnotările acelui utilizator pot trece de la ascuns la vizibil
    refreshVisibility();
  }

  function openUserProfile(authorHash) {
    if (!authorHash) return;
    setMinePanelOpen(true, authorHash);
  }

  // Profilul (al tău sau al altcuiva): numărul de adnotări, căutare, tab-ul "Pagina asta" (toate
  // ale lui de aici, după voturi — cât e deschis panoul, se văd toate pe pagină, vezi
  // applyVisibility) și "Toate paginile" (top general al lui). Click = sari exact la adnotare.
  function renderMineList() {
    if (!els.mineList) return;
    els.mineList.innerHTML = "";
    els.mineTabs?.forEach((b) => b.classList.toggle("active", b.dataset.scope === state.mineScope));
    const user = state.panelUser;
    const me = user === state.userHash;
    const all = state.mineScope === "all";

    const onPage = [...state.annotations.values()]
      .map((entry) => entry.ann)
      .filter((ann) => ann.authorHash === user)
      .sort(byRank);
    if (els.mineCount) {
      const total = state.panelAll ? state.panelAll.length : "…";
      els.mineCount.textContent = `${onPage.length} pe pagina asta · ${total} în total`;
    }

    let list;
    if (all) {
      if (!state.panelAll) {
        els.mineList.appendChild(el("div", { class: "wa-mine-empty" }, "⏳ Se încarcă..."));
        return;
      }
      list = state.panelAll;
    } else {
      list = onPage;
    }

    const q = state.mineQuery.trim().toLowerCase();
    if (q) list = list.filter((ann) => `${shortLabel(ann)} ${ann.data?.url || ""} ${ann.url}`.toLowerCase().includes(q));

    if (!list.length) {
      const message = q
        ? "Nimic găsit."
        : all
          ? me ? "N-ai pus încă nicio adnotare." : "Nicio adnotare."
          : !state.annotationsLoaded
            ? "⏳ Se încarcă..."
            : me ? "N-ai pus încă nimic pe pagina asta." : "Nimic pe pagina asta.";
      els.mineList.appendChild(el("div", { class: "wa-mine-empty" }, message));
      return;
    }

    const here = pageKey();
    list.forEach((ann) => {
      const children = [
        el("span", { class: "wa-mine-icon" }, annotationIcon(ann.type)),
        el("span", { class: "wa-mine-label" }, shortLabel(ann)),
      ];
      if (ann.data?.videoRange) {
        children.push(el("span", { class: "wa-mine-time" }, `🎬 ${formatTime(ann.data.videoRange.start)}`));
      }
      children.push(el("span", { class: "wa-mine-votes" }, `${ann.votes} 👍`));
      const row = [el("div", { class: "wa-mine-row" }, ...children)];
      if (all) row.push(el("div", { class: "wa-mine-page" }, ann.url === here ? "📄 pagina asta" : `📄 ${shortenUrl(ann.url)}`));

      els.mineList.appendChild(el("div", { class: "wa-mine-item", onclick: () => goToAnnotation(ann) }, ...row));
    });
  }

  // Duce la poziția exactă a unei adnotări. Pe pagina asta: o arată (chiar dacă e în afara
  // topului), derulează și o evidențiază. Pe altă pagină: o deschide într-un tab nou și, după
  // încărcare, face același lucru acolo (cererea trece prin chrome.storage — locatePendingAnnotation).
  const PENDING_LOCATE_KEY = "wa_pending_locate";
  function goToAnnotation(ann) {
    if (ann.url === pageKey()) {
      const entry = state.annotations.get(ann.id);
      if (entry) {
        state.revealed.add(ann.id);
        applyVisibility(entry);
        return locateMine(entry.ann);
      }
    }
    if (!/^https?:\/\//i.test(String(ann.url))) return;
    chrome.storage.local
      .set({ [PENDING_LOCATE_KEY]: { id: ann.id, url: ann.url, at: Date.now() } })
      .catch(() => {})
      .finally(() => window.open(ann.url, "_blank", "noopener,noreferrer"));
  }

  async function locatePendingAnnotation() {
    let pending;
    try {
      pending = (await chrome.storage.local.get(PENDING_LOCATE_KEY))[PENDING_LOCATE_KEY];
    } catch {
      return;
    }
    if (!pending || pending.url !== pageKey()) return;
    chrome.storage.local.remove(PENDING_LOCATE_KEY).catch(() => {});
    if (Date.now() - pending.at > 60_000) return; // cerere veche, uitată
    const entry = state.annotations.get(pending.id);
    if (!entry) return;
    state.revealed.add(pending.id);
    applyVisibility(entry);
    setTimeout(() => locateMine(entry.ann), 400);
  }

  // Sare la o adnotare proprie: derulează spre ea, o pune la timpul potrivit din
  // video dacă e legată de un interval, și o marchează scurt cu un contur pulsatoriu
  // ca să se distingă imediat pe pagină.
  function locateMine(ann) {
    const entry = state.annotations.get(ann.id);
    if (!entry) return;
    const isVideoAnn = !!ann.data?.videoRange;

    if (isVideoAnn) {
      const video = getMainVideo();
      seekVideo(video, ann.data.videoRange.start);
      // Adnotările legate de video rămân vizibile și în fullscreen (vezi
      // enterVideoFullscreen) — nu are rost s-o scoatem pe utilizator de-acolo.
      locateMineStep2(entry);
      return;
    }

    // O adnotare STATICĂ (nelegată de video) trăiește tot timpul în #wa-root, care
    // fiind frate cu <html>, e complet invizibil cât ceva e în fullscreen real —
    // scrollIntoView ar derula pagina "pe ascuns", fără ca userul să vadă vreo
    // schimbare până iese manual din fullscreen (exact bug-ul raportat). Ieșim noi
    // înșine din fullscreen înainte de scroll+flash, ca să chiar se vadă.
    if (document.fullscreenElement && !(videoLayerActive && isVideoBound(ann))) {
      document.exitFullscreen().finally(() => setTimeout(() => locateMineStep2(entry), 100));
    } else {
      locateMineStep2(entry);
    }
  }

  function locateMineStep2(entry) {
    if (!entry.el) return;
    entry.el.scrollIntoView({ behavior: "smooth", block: "center" });

    // Scroll-ul "smooth" durează (mai ales pe pagini lungi) — dacă am aprinde flash-ul
    // imediat, cele 1.6s de contur pulsatoriu s-ar putea consuma cât utilizatorul încă
    // se uită în altă parte a paginii, pe unde se derulează. Așteptăm finalul scroll-ului
    // (scrollend) înainte de flash; fallback pe timeout dacă elementul era deja vizibil
    // (scrollend nu se declanșează dacă nu s-a mișcat nimic) sau browserul nu suportă evenimentul.
    let flashed = false;
    const doFlash = () => {
      if (flashed) return;
      flashed = true;
      flashHighlight(entry.el);
    };
    window.addEventListener("scrollend", doFlash, { once: true });
    setTimeout(doFlash, 700);
  }

  function flashHighlight(domEl) {
    if (!domEl) return;
    domEl.classList.add("wa-locate-flash");
    setTimeout(() => domEl.classList.remove("wa-locate-flash"), 1600);
  }

  // ---------- Helpers ----------

  function pagePoint(e) {
    return { x: e.pageX, y: e.pageY };
  }

  // Împinge un popover/panou "position: fixed" înapoi în interiorul ecranului dacă
  // iese pe vreo margine — verificat pe dimensiunea lui REALĂ, după randare (nu o
  // estimare dinainte), ca să funcționeze indiferent câte câmpuri are (ex. popover-ul
  // de editare, care poate crește cu câmpurile De la/Până la pentru video). Esențial
  // pentru adnotările de jos de tot ale paginii, unde popover-ul altfel iese sub ecran.
  function clampToViewport(panelEl, margin = 8) {
    const rect = panelEl.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (rect.bottom > window.innerHeight - margin) dy = window.innerHeight - margin - rect.bottom;
    if (rect.top + dy < margin) dy = margin - rect.top;
    if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
    if (rect.left + dx < margin) dx = margin - rect.left;
    if (!dx && !dy) return;
    if (panelEl.style.left) panelEl.style.left = parseFloat(panelEl.style.left) + dx + "px";
    if (panelEl.style.top) panelEl.style.top = parseFloat(panelEl.style.top) + dy + "px";
    if (panelEl.style.right) panelEl.style.right = parseFloat(panelEl.style.right) - dx + "px";
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // Secunde -> "h:mm:ss" (mereu cu ora, chiar dacă e 0, ca să fie clar dintr-o privire
  // unde în video se află — cerut explicit, altfel apar valori de sute de secunde greu de citit).
  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  // "h:mm:ss", "m:ss" sau doar secunde -> total secunde. NaN dacă formatul e invalid.
  function parseTimeToSeconds(str) {
    const parts = String(str ?? "").trim().split(":");
    if (!parts.length || parts.some((p) => p.trim() === "" || Number.isNaN(Number(p)))) return NaN;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
  }

  // ---------- Ancorare de element (poziția supraviețuiește la resize/zoom care rearanjează pagina) ----------

  // La căutarea elementului de sub punctul de click, dăm la o parte propriile noastre
  // layere (care altfel ar fi mereu "deasupra" și s-ar auto-selecta pe ele însele).
  function elementUnderPoint(clientX, clientY) {
    const prevSvgPE = els.svg.style.pointerEvents;
    const prevElPE = els.elements.style.pointerEvents;
    els.svg.style.pointerEvents = "none";
    els.elements.style.pointerEvents = "none";
    const found = document.elementFromPoint(clientX, clientY);
    els.svg.style.pointerEvents = prevSvgPE;
    els.elements.style.pointerEvents = prevElPE;
    return found;
  }

  // ID-uri create la fiecare încărcare (Netflix: rânduri cu ID base64 de sesiune, React
  // useId ":r1:", Ember/ExtJS/YUI) — un selector cu ele nu mai găsește nimic data viitoare.
  function isGeneratedId(id) {
    return id.length > 40 || /^:r[0-9a-z]+:$/i.test(id) || /^(ember|ext-gen|yui_)\d+/.test(id);
  }

  // Calea (fără host și query) a pozei: pe CDN-uri hostul și semnătura din query se schimbă,
  // calea rămâne aceeași pentru aceeași imagine.
  function imagePath(img) {
    try {
      return new URL(img.currentSrc || img.src).pathname;
    } catch {
      return "";
    }
  }

  // Selector CSS rezonabil de stabil: ID unic dacă există (pe el sau pe un strămoș), altfel
  // o cale de tip tag:nth-of-type până la acel strămoș sau până la <body>.
  function buildSelector(elm) {
    if (!elm || elm === document.body || elm === document.documentElement) return null;
    const parts = [];
    let node = elm;
    let depth = 0;
    // Fără plafon mic de adâncime: pe X <video>-ul e la ~38 de niveluri sub <body>, iar un drum
    // tăiat la 12 dar prefixat cu "body > " nu mai nimerea nimic — adnotarea nu mai urmărea
    // video-ul (nici la fullscreen, nici la resize). 80 e doar o plasă de siguranță.
    while (node && node.nodeType === 1 && node !== document.body && depth < 80) {
      if (node.id && !isGeneratedId(node.id)) {
        const idSel = `#${CSS.escape(node.id)}`;
        if (document.querySelectorAll(idSel).length === 1) {
          parts.unshift(idSel);
          return parts.join(" > ");
        }
      }
      const parent = node.parentElement;
      if (!parent) break;
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const idx = sameTag.indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${idx})`);
      node = parent;
      depth++;
    }
    return parts.length ? "body > " + parts.join(" > ") : null;
  }

  // Elemente al căror conținut se scalează odată cu cutia lor (o poză micșorată de layout
  // arată tot motorul, doar mai mic) — doar pentru ele desenul se scalează la resize.
  // La text/containere obișnuite, lățimea se schimbă dar conținutul nu, deci acolo nu scalăm.
  const SCALABLE_TAGS = new Set(["img", "video", "canvas", "svg", "picture", "iframe", "embed", "object"]);

  // Prima poză/video/canvas din stiva de sub punct, chiar dacă deasupra e un strat
  // transparent al site-ului (ex. lupa de zoom a galeriei de produs de pe eMAG).
  function scalableUnderPoint(clientX, clientY) {
    const hit = document
      .elementsFromPoint(clientX, clientY)
      .find((n) => SCALABLE_TAGS.has(n.localName) && !els.root.contains(n) && !els.videoRoot?.contains(n));
    if (hit) return hit;
    // elementsFromPoint sare peste elementele cu pointer-events: none — așa sunt video-ul și
    // copertele din meniul Netflix. Căutăm atunci în strămoșii elementului de deasupra cea mai
    // apropiată poză/video vizibilă care acoperă punctul (aceeași componentă a paginii).
    const contains = (n) => {
      const r = n.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2 && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    };
    const selector = [...SCALABLE_TAGS].join(",");
    for (let node = elementUnderPoint(clientX, clientY); node && node !== document.body; node = node.parentElement) {
      const found = [...node.querySelectorAll(selector)].find(
        (n) => contains(n) && getComputedStyle(n).visibility !== "hidden" && !els.root.contains(n)
      );
      if (found) return found;
    }
    return null;
  }

  // Dreptunghiul în care se vede EFECTIV poza/cadrul video, nu cutia elementului: cu
  // object-fit: contain (implicit la <video>, des folosit în galeriile de produs) imaginea
  // stă centrată cu margini goale, iar raportul lor se schimbă când layout-ul trece pe mobil.
  function mediaContentRect(elm) {
    const rect = elm.getBoundingClientRect();
    const nw = elm.naturalWidth || elm.videoWidth;
    const nh = elm.naturalHeight || elm.videoHeight;
    if (!nw || !nh || rect.width < 2 || rect.height < 2) return rect;
    const fit = getComputedStyle(elm).objectFit;
    if (fit !== "contain" && fit !== "cover" && fit !== "scale-down") return rect; // fill: umple cutia
    let k = fit === "cover" ? Math.max(rect.width / nw, rect.height / nh) : Math.min(rect.width / nw, rect.height / nh);
    if (fit === "scale-down") k = Math.min(k, 1);
    const w = nw * k;
    const h = nh * k;
    // object-position: presupunem centrat (valoarea implicită)
    const left = rect.left + (rect.width - w) / 2;
    const top = rect.top + (rect.height - h) / 2;
    return { left, top, right: left + w, bottom: top + h, width: w, height: h };
  }

  // La creare: reperul e elementul real de sub click + poziția relativă (%) în interiorul lui.
  // Pentru poze/video se salvează și lățimea lor `w` — raportul față de lățimea de acum e
  // factorul cu care scalăm desenul. `fit` = scala la care e afișat ACUM desenul (la re-ancorare
  // după mutare), ca lățimea salvată să corespundă mărimii lui „naturale”.
  // `at` (opțional, coordonate de ecran): punctul pentru care se calculează poziția relativă,
  // dacă diferă de punctul după care se alege reperul — vezi mutarea din makeMovable.
  function computeAnchor(clientX, clientY, fit = 1, at = null) {
    const px = at ? at.x : clientX;
    const py = at ? at.y : clientY;
    // Peste un video, ne ancorăm DIRECT de <video> (mereu prezent, stabil), nu de orice
    // e vizual deasupra în acel moment — pe YouTube/Netflix acolo pot fi straturi
    // temporare (bara de control, gradientul de hover) care dispar/reapar, și dacă
    // ANCORA ar fi unul din ele, la resize elementul poate lipsi și adnotarea rămâne
    // blocată pe poziția veche cât timp restul paginii se mișcă.
    const video = getMainVideo();
    if (video) {
      const vRect = mediaContentRect(video);
      const overVideo =
        clientX >= vRect.left && clientX <= vRect.right && clientY >= vRect.top && clientY <= vRect.bottom;
      if (overVideo && vRect.width >= 2 && vRect.height >= 2) {
        const selector = buildSelector(video);
        if (selector) {
          return {
            selector,
            offsetXPct: ((px - vRect.left) / vRect.width) * 100,
            offsetYPct: ((py - vRect.top) / vRect.height) * 100,
            w: vRect.width / fit,
          };
        }
      }
    }

    const media = scalableUnderPoint(clientX, clientY);
    const target = media || elementUnderPoint(clientX, clientY);
    const selector = buildSelector(target);
    if (!selector) return null;
    const rect = media ? mediaContentRect(media) : target.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const anchor = {
      selector,
      offsetXPct: ((px - rect.left) / rect.width) * 100,
      offsetYPct: ((py - rect.top) / rect.height) * 100,
    };
    if (media) anchor.w = rect.width / fit;
    if (media?.localName === "img") anchor.src = imagePath(media) || undefined;
    return anchor;
  }

  // La afișare/redimensionare: unde e reperul ACUM → poziția (în pagină) unde trebuie desenată adnotarea.
  // Elementul-reper al unei ancore. Ancorele puse peste video țintesc <video>-ul; dacă drumul
  // salvat nu-l mai găsește (salvat trunchiat de versiunile ≤ 0.2.7 pe pagini adânci ca X, sau
  // player reconstruit de site), cădem pe video-ul principal — e același, pe o pagină cu un player.
  function anchorTarget(anchor) {
    let target = null;
    try {
      target = document.querySelector(anchor.selector);
    } catch {}
    if (!target && /(^|[\s>])video:nth-of-type\(\d+\)$/.test(anchor.selector)) target = getMainVideo();
    return target;
  }

  function resolveAnchor(anchor) {
    if (!anchor?.selector) return null;
    let target = anchorTarget(anchor);
    // Poză: dacă selectorul nu mai nimerește aceeași imagine (layout schimbat, rânduri
    // reordonate — ex. meniul Netflix), o căutăm după adresa ei.
    if (anchor.src && !(target?.localName === "img" && imagePath(target) === anchor.src)) {
      target = [...document.images].find((i) => i.getBoundingClientRect().width > 1 && imagePath(i) === anchor.src) || null;
    }
    if (!target) return null;
    // ancorele noi (cu `w`) sunt relative la imaginea vizibilă; cele vechi, la cutia elementului
    const rect = anchor.w > 0 ? mediaContentRect(target) : target.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return null; // devenit invizibil / display:none
    // adnotările vechi (fără `w`) sau ancorate de text rămân la mărimea lor
    const fit = anchor.w > 0 && rect.width >= 2 ? Math.min(Math.max(rect.width / anchor.w, 0.1), 10) : 1;
    return {
      x: rect.left + window.scrollX + (anchor.offsetXPct / 100) * rect.width,
      y: rect.top + window.scrollY + (anchor.offsetYPct / 100) * rect.height,
      fit,
    };
  }

  // Punctul de referință ORIGINAL (necorectat) din geometria unei adnotări SVG — pen/spray/formă
  // nu au un singur x,y ca text/bulă/link, deci calculăm deplasarea față de acest punct.
  function svgOriginPoint(ann) {
    if (ann.type === "pen") {
      const m = ann.data.d.match(/M (-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?)/);
      if (!m) return null;
      return { x: Number(m[1]), y: Number(m[2]) };
    }
    if (ann.type === "spray") {
      // ancora s-a calculat din punctul click-ului, nu din primul punct (care e deplasat
      // aleator) — altfel desenul „sărea” câțiva pixeli la prima repoziționare
      if (ann.data.origin) return { x: ann.data.origin.x, y: ann.data.origin.y };
      const first = ann.data.dots[0];
      return first ? { x: first.cx, y: first.cy } : null;
    }
    if (ann.type === "shape") {
      // trebuie să fie x1,y1 (punctul de START al drag-ului), NU centrul — ancora s-a
      // calculat de la coordonatele click-ului de pornire, nu de la centrul formei
      return { x: ann.data.x1, y: ann.data.y1 };
    }
    return null;
  }

  // Recalculează poziția tuturor adnotărilor cu reper, pe baza poziției curente a reperelor lor.
  // Doar client-side — nu trimite nimic la server (altfel am bombarda serverul la fiecare resize).
  function repositionAnchoredAnnotations() {
    state.annotations.forEach(({ ann, el: domEl, control }) => {
      if (!ann.data.anchor) return;
      const resolved = resolveAnchor(ann.data.anchor);
      // Desen pus pe o poză care nu (mai) e pe pagină — ex. coperta unui film din meniul
      // Netflix, încă neîncărcată sau în alt rând: ascuns, nu lăsat peste altă copertă.
      const orphan = !resolved && !!ann.data.anchor.src;
      domEl.classList.toggle("wa-orphan", orphan);
      control?.classList.toggle("wa-orphan", orphan);
      if (!resolved) return; // reperul a dispărut de pe pagină — rămânem la ultima poziție cunoscută
      ann._fit = resolved.fit;

      const isSvg = domEl instanceof SVGElement;
      if (isSvg) {
        const origin = svgOriginPoint(ann);
        if (!origin) return;
        const dx = resolved.x - origin.x;
        const dy = resolved.y - origin.y;
        ann.data.dx = dx;
        ann.data.dy = dy;
        applySvgTransform(domEl, ann);
      } else {
        ann.data.x = resolved.x;
        ann.data.y = resolved.y;
        domEl.style.left = resolved.x + "px";
        domEl.style.top = resolved.y + "px";
        applyDomTransform(domEl, ann);
      }
      placeControlAtElement(domEl, control);
    });
    // Cele mutate în stratul de fullscreen (fixed) au nevoie de coordonate de ecran, nu de pagină —
    // altfel un resize (intrarea în fullscreen e unul) le lăsa decalate cu scroll-ul paginii.
    repositionVideoLayerAnnotations();
    positionAllAttachedLinks();
  }

  // ---------- Init ----------

  async function loadExisting() {
    if (!state.consent) return; // fără acord, nicio cerere spre server (nici amprenta paginii)
    try {
      const list = await WA_Api.listAnnotations(pageKey());
      list.forEach(renderAnnotation);
      sizeLayers();
      repositionAnchoredAnnotations(); // pagina poate fi deja alt layout decât la creare
      locatePendingAnnotation(); // deschisă dintr-un profil / din Top? sari la adnotare
    } catch (err) {
      console.warn("[Adormis] Nu pot contacta serverul (e pornit?):", err);
    } finally {
      // Setat și pe eroare (nu doar pe succes) — altfel panoul "Ale mele" ar rămâne
      // înțepenit pe mesajul de "se încarcă" la nesfârșit dacă serverul e jos.
      state.annotationsLoaded = true;
      // Dacă utilizatorul a deschis "Ale mele" ÎNAINTE ca cererea de mai sus să se
      // termine, lista randată atunci era goală (nu apucaseră să sosească adnotările
      // lui) — o reface acum, cu datele reale. Ăsta era motivul pentru care lista
      // părea goală "prima dată" și abia la un refresh ulterior (mai norocos cu
      // timing-ul) arăta corect.
      if (state.myPanelOpen) renderMineList();
    }
  }

  // Site-uri ca YouTube sunt SPA — schimbă video-ul fără reload complet de pagină.
  // Content script-ul rulează o singură dată la încărcare, așa că fără asta rămâneai
  // cu adnotările paginii vechi afișate peste noul video/pagină.
  let lastPageKey = null;

  function watchForNavigation() {
    lastPageKey = pageKey();
    setInterval(() => {
      const current = pageKey();
      if (current !== lastPageKey) {
        lastPageKey = current;
        onPageNavigated();
      }
    }, 700);
  }

  async function onPageNavigated() {
    els.svg.innerHTML = "";
    els.elements.innerHTML = "";
    // Și straturile-geamăn de fullscreen — altfel o adnotare video a paginii vechi
    // (dacă navigarea vine în fullscreen, ex. autoplay) rămânea afișată pe video-ul nou.
    els.videoSvg.innerHTML = "";
    els.videoElements.innerHTML = "";
    movedIntoVideoLayer.length = 0;
    state.annotations.clear();
    state.panelAll = null; // lista "Toate paginile" se reîncarcă la următoarea deschidere
    state.revealed.clear();
    refreshCounter();
    refreshRanking();
    document.querySelectorAll(".wa-popover, .wa-spray-confirm, .wa-lb-detail").forEach((p) => p.remove());
    setActiveTool(null);
    setMinePanelOpen(false); // lista era pentru pagina veche — se reface la o nouă deschidere
    await loadExisting();
    refreshGlobalTop(); // topul e global, nu se resetează la navigare — doar îl reîmprospătăm
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TOGGLE_TOOLBAR") toggleToolbar();
  });

  // ---------- Acord (prima folosire) ----------
  // Până la acord, extensia nu trimite NIMIC la server: nici amprenta paginii, nici Topul.
  // Acordul e global (o singură dată), ținut în chrome.storage; se retrage din popup.
  const CONSENT_KEY = "wa_consent";
  const CONSENT_VERSION = 3; // crește dacă se schimbă ce date se trimit — se cere acord din nou
  // (2: amprenta IP la voturi/raportări, motivul raportărilor, termenii de utilizare;
  //  3: profilul public — adnotările unui autor de pe toate paginile, grupate)
  const PRIVACY_URL = "https://web-annotation-extension-production.up.railway.app/privacy";
  const TERMS_URL = "https://claude.ai/artifact/Y1zMCdLSAioXzbo2t3Jztd";

  async function loadConsent() {
    try {
      const { [CONSENT_KEY]: c } = await chrome.storage.local.get(CONSENT_KEY);
      state.consent = !!c && c.v >= CONSENT_VERSION;
    } catch {
      state.consent = false;
    }
  }

  let consentDialog = null;
  function showConsentDialog() {
    if (consentDialog) return;
    const item = (title, text) => el("li", {}, el("strong", {}, title), " ", text);
    const accept = el("button", { class: "wa-consent-accept" }, "Sunt de acord, pornește");
    const later = el("button", { class: "wa-consent-later" }, "Nu acum");
    const policy = el("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener noreferrer" }, "Politica de confidențialitate");
    const terms = el("a", { href: TERMS_URL, target: "_blank", rel: "noopener noreferrer" }, "Termenii de utilizare");
    const box = el(
      "div",
      { class: "wa-consent", role: "dialog", "aria-modal": "true", "aria-labelledby": "wa-consent-title" },
      el("h2", { id: "wa-consent-title" }, "Înainte să pornești Adormis"),
      el("p", {}, "Adormis arată adnotările lăsate de alți utilizatori pe pagina pe care ești. Pentru asta:"),
      el(
        "ul",
        {},
        item(
          "Pagina:",
          "la fiecare pagină deschisă, extensia trimite serverului nostru o amprentă (hash) a adresei, nu adresa. Adresa reală pleacă doar pentru paginile pe care adaugi tu o adnotare."
        ),
        item("Public:", "ce desenezi sau scrii e vizibil pentru oricine are extensia, pe aceeași pagină. Nu posta conținut ilegal, ură, hărțuire sau date personale ale altora."),
        item("Profil public:", "cine dă click pe autorul unei adnotări vede toate adnotările lui, de pe toate paginile, cu adresa paginilor — sub pseudonim, fără nume. Apar doar paginile pe care ai adnotat, nu cele vizitate."),
        item(
          "Identitate:",
          "primești un ID generat pe dispozitivul tău (pseudonim, fără nume sau email). Serverul vede adresa IP a cererilor."
        ),
        item("Linkuri:", "linkurile pe care le adaugi sunt verificate la URLhaus (abuse.ch) ca să nu fie periculoase."),
        item("Voturi și raportări:", "se păstrează împreună cu o amprentă a adresei IP (nu IP-ul), ca o conexiune să nu poată umfla voturile sau raportările cu identități inventate."),
        item("Excepții:", "pe paginile locale sau interne (localhost, adrese IP) extensia nu pornește deloc.")
      ),
      el(
        "p",
        { class: "wa-consent-small" },
        "Nu vindem date și nu facem reclame sau profilare. Poți retrage acordul oricând din meniul extensiei. Apăsând „Sunt de acord” accepți ",
        terms,
        " și ",
        policy,
        "."
      ),
      el("div", { class: "wa-consent-actions" }, later, accept)
    );
    const backdrop = el("div", { class: "wa-consent-backdrop" }, box);
    const close = () => {
      backdrop.remove();
      consentDialog = null;
    };
    later.onclick = close;
    backdrop.addEventListener("click", (e) => e.target === backdrop && close());
    accept.onclick = async () => {
      await chrome.storage.local.set({ [CONSENT_KEY]: { v: CONSENT_VERSION, at: Date.now() } });
      state.consent = true;
      close();
      startNetwork();
      toggleToolbar(true);
    };
    consentDialog = backdrop;
    uiHost().appendChild(backdrop);
    accept.focus();
  }

  // Tot ce vorbește cu serverul pornește abia după acord (la init sau după „De acord”).
  let networkStarted = false;
  async function startNetwork() {
    if (networkStarted || !state.consent) return;
    networkStarted = true;
    await loadExisting();
    await refreshGlobalTop();
    // prinde și voturile date de alții între timp — doar în tab-ul pe care îl vezi, nu în
    // toate tab-urile deschise (fiecare tab ar fi cerut Topul la 30s)
    setInterval(() => document.visibilityState === "visible" && refreshGlobalTop(), 30000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshGlobalTop());
  }

  // Retragerea acordului (din popup) oprește imediat extensia pe paginile deschise.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && CONSENT_KEY in changes && !changes[CONSENT_KEY].newValue && state.consent) {
      location.reload();
    }
  });

  // ---------- Onboarding (o singură dată, vreodată) ----------

  // Tab-ul e acum aproape complet ascuns implicit (vezi CSS) — fără explicație, un
  // utilizator nou n-ar avea de unde să știe că extensia există pe pagină. Arătăm
  // O SINGURĂ DATĂ, pe primul site pe care se instalează sau se actualizează
  // extensia: îl deschidem forțat cu o săgeată/explicație, apoi îl retragem la loc
  // și explicăm unde să dea cu mouse-ul data viitoare. Flag-ul e global (nu per site)
  // — altfel ar reapărea enervant pe fiecare domeniu nou vizitat.
  const ONBOARDING_KEY = "wa_onboarding_seen";

  // Balonaș în stânga butonului rotund (care stă pe marginea din dreapta), cu săgeata spre el.
  function showOnboardingCallout(text) {
    const callout = el("div", { class: "wa-onboarding-callout" }, text);
    uiHost().appendChild(callout);
    const r = els.toggleBtn.getBoundingClientRect();
    callout.style.left = r.left - 14 - callout.offsetWidth + "px";
    callout.style.top = (r.top + r.bottom) / 2 + "px";
    requestAnimationFrame(() => callout.classList.add("wa-visible"));
    return callout;
  }

  async function runOnboarding() {
    const { [ONBOARDING_KEY]: seen } = await chrome.storage.local.get(ONBOARDING_KEY);
    if (seen) return;
    // Marcăm imediat "văzut", nu la final — ca un reload rapid în timpul secvenței
    // să n-o pornească a doua oară.
    await chrome.storage.local.set({ [ONBOARDING_KEY]: true });

    els.topbar.classList.add("wa-peek"); // scoate butonul complet din margine
    setTimeout(() => {
      const hint = showOnboardingCallout("Aici e Adormis! Apasă (sau Alt+A) ca să vezi și să adaugi adnotări pe pagină.");
      setTimeout(() => {
        hint.remove();
        els.topbar.classList.remove("wa-peek");
      }, 4500);
    }, 300); // așteaptă tranziția de ieșire înainte să poziționăm balonașul
  }

  (async function init() {
    const serverUrl = await window.WA_Storage.getServerUrl();
    if (isPrivatePage() && !isLocalServer(serverUrl)) return;
    // nici pe paginile serverului nostru (ex. pagina de moderare /admin)
    try {
      if (new URL(serverUrl).origin === location.origin) return;
    } catch {}
    await loadConsent();
    const identity = await window.WA_Storage.getIdentity();
    state.userId = identity.id; // secret — doar în cererile proprii de creare/editare/ștergere
    state.userHash = identity.hash;
    buildOverlay();
    initPenTool();
    initSprayTool();
    initShapeTool();
    initTextTool();
    initBubbleTool();
    initLinkTool();
    wireTopbarReveal();
    loadDockPosition();
    loadStyle();
    chrome.storage.local
      .get(["wa_top_hidden", "wa_top_mode"])
      .then(({ wa_top_hidden, wa_top_mode }) => {
        if (wa_top_hidden) toggleLeaderboard(false);
        if (wa_top_mode === "global") setTopMode("global");
      })
      .catch(() => {});
    watchForNavigation();
    runOnboarding();
    await startNetwork(); // nimic dacă încă nu există acord
  })();
})();
