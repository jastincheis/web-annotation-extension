// Web Annotate — content script principal.
// Injectează un layer transparent peste pagină pentru desen/adnotări
// și randează adnotările salvate de toți utilizatorii pentru acest URL.
(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    userId: null,
    toolbarVisible: false,
    activeTool: null, // 'pen' | 'spray' | 'shape' | 'text' | 'video'
    shapeKind: "circle", // 'circle' | 'arrow'
    color: "#89CFF0", // baby blue
    strokeWidth: 4,
    minVotes: 0,
    annotations: new Map(), // id -> { ann, el, refEl }
    globalTop: [], // top 10 de pe TOATE paginile (nu doar cea curentă) — vezi refreshGlobalTop
  };

  let els = {};
  let pendingToolFinish = null; // dacă o unealtă are o sesiune deschisă (ex. spray), finalizeaz-o la schimbarea uneltei

  function pageKey() {
    return location.origin + location.pathname + location.search;
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

  function docHeight() {
    return Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      window.innerHeight
    );
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

    els.topbar = buildTopbar();
    els.toolbar = buildToolbar();
    els.leaderboardPanel = buildLeaderboardPanel();

    els.root.appendChild(els.svg);
    els.root.appendChild(els.elements);
    document.documentElement.appendChild(els.root);
    document.documentElement.appendChild(els.topbar);
    document.documentElement.appendChild(els.toolbar);
    document.documentElement.appendChild(els.leaderboardPanel);

    sizeLayers();
    positionToolbar();
    window.addEventListener("resize", () => {
      sizeLayers();
      positionToolbar();
    });
    // resize/zoom pot rearanja pagina (layout responsive) — recalculăm pozițiile ancorate
    window.addEventListener("resize", debounce(repositionAnchoredAnnotations, 150));
    new MutationObserver(() => sizeLayers()).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function buildToolbar() {
    const toolBtn = (tool, icon, title) =>
      el(
        "button",
        {
          class: "wa-tool",
          "data-tool": tool,
          title,
          onclick: () => setActiveTool(tool),
        },
        icon
      );

    const shapeSelect = el(
      "select",
      {
        onchange: (e) => (state.shapeKind = e.target.value),
      },
      el("option", { value: "circle" }, "Cerc"),
      el("option", { value: "rectangle" }, "Dreptunghi"),
      el("option", { value: "square" }, "Pătrat"),
      el("option", { value: "triangle" }, "Triunghi"),
      el("option", { value: "diamond" }, "Romb"),
      el("option", { value: "star" }, "Stea"),
      el("option", { value: "arrow" }, "Săgeată")
    );

    const colorInput = el("input", {
      type: "color",
      value: state.color,
      oninput: (e) => (state.color = e.target.value),
    });

    const widthInput = el("input", {
      type: "range",
      min: "1",
      max: "24",
      value: String(state.strokeWidth),
      oninput: (e) => (state.strokeWidth = Number(e.target.value)),
    });

    const toolbar = el(
      "div",
      { id: "wa-toolbar", hidden: "true" },
      el(
        "div",
        { class: "wa-row" },
        toolBtn("select", "🖱️", "Selectează / navighează normal"),
        toolBtn("pen", "✏️", "Pen liber"),
        toolBtn("spray", "🎨", "Spray graffiti"),
        toolBtn("shape", "◯", "Formă (cerc/săgeată) — click-drag"),
        toolBtn("bubble", "💬", "Bulă cu text — click pe pagină"),
        toolBtn("text", "🔤", "Text mișcabil — click pe pagină"),
        toolBtn("link", "🔗", "Link către alt conținut — click pe pagină")
      ),
      el("hr"),
      el("label", {}, "Formă", shapeSelect),
      el("label", {}, "Culoare", colorInput),
      el("label", {}, "Grosime", widthInput),
      el("button", { class: "wa-close", onclick: toggleToolbar, title: "Închide bara" }, "✕")
    );

    return toolbar;
  }

  // Bandă permanentă, sus de tot — nu se deschide/închide, e mereu vizibilă.
  // Conține doar butonul de pornit uneltele; clasamentul e panoul separat din dreapta (buildLeaderboardPanel).
  function buildTopbar() {
    els.toggleBtn = el(
      "button",
      { id: "wa-toggle-btn", onclick: toggleToolbar, title: "Deschide/închide uneltele de adnotare" },
      "🖍️ Adnotează"
    );
    return el("div", { id: "wa-topbar" }, els.toggleBtn);
  }

  // Panou permanent, redus în mod normal la 10 cifre — TOP GLOBAL, de pe toate paginile
  // adnotate, nu doar cea curentă (vezi refreshGlobalTop). Colorate dacă locul e ocupat,
  // gri dacă nu. Click pe o cifră = detalii (și, dacă adnotarea e pe altă pagină, un buton
  // ca să sari acolo).
  function buildLeaderboardPanel() {
    els.leaderboardSlots = [];
    const slots = [];
    for (let i = 1; i <= 10; i++) {
      const slot = el("div", { class: "wa-lb-slot" }, String(i));
      els.leaderboardSlots.push(slot);
      slots.push(slot);
    }

    // Filtru pe pagină: ascunde tot ce are mai puține voturi decât numărul introdus.
    // Stă lipit sub Top ca să fie clar că se leagă de voturi, nu e o unealtă de desen.
    const minVotesInput = el("input", {
      type: "number",
      min: "0",
      placeholder: "0",
      value: "0",
      title: "Arată doar meme-urile cu cel puțin atâtea voturi",
      oninput: (e) => {
        state.minVotes = Number(e.target.value) || 0;
        applyVoteFilter();
      },
    });
    const filterRow = el(
      "label",
      { class: "wa-lb-filter", title: "Introdu un număr ca să vezi doar meme-urile cu cel puțin atâtea voturi" },
      "Arată de la",
      minVotesInput,
      "voturi"
    );

    return el(
      "div",
      { id: "wa-leaderboard-panel", title: "Top global — cele mai votate adnotări de pe toate paginile" },
      ...slots,
      filterRow
    );
  }

  // Bara de unelte atârnă chiar sub banda permanentă, indiferent dacă e deschisă sau nu.
  function positionToolbar() {
    const h = els.topbar.getBoundingClientRect().height;
    els.toolbar.style.top = h + "px";
  }

  function toggleToolbar(forceShow) {
    state.toolbarVisible = typeof forceShow === "boolean" ? forceShow : !state.toolbarVisible;
    els.toolbar.hidden = !state.toolbarVisible;
    els.toggleBtn?.classList.toggle("active", state.toolbarVisible);
    if (!state.toolbarVisible) setActiveTool(null);
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
      btn.classList.toggle("active", btn.dataset.tool === state.activeTool);
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

  function attachVoteControl(ann, x, y) {
    const canDelete = ann.authorId === state.userId;
    const control = el(
      "div",
      { class: "wa-vote", style: `left:${x}px; top:${y}px;` },
      el("button", { class: "wa-up", title: "Like" }, "👍"),
      el("span", { class: "wa-count" }, String(ann.votes)),
      el("button", { class: "wa-down", title: "Dislike" }, "👎"),
      el("button", { class: "wa-report", title: "Raportează" }, "🚩")
    );

    control.querySelector(".wa-up").onclick = async (e) => {
      e.stopPropagation();
      const updated = await WA_Api.vote(ann.id, state.userId, "up");
      updateVotes(ann.id, updated.votes);
    };
    control.querySelector(".wa-down").onclick = async (e) => {
      e.stopPropagation();
      const updated = await WA_Api.vote(ann.id, state.userId, "down");
      updateVotes(ann.id, updated.votes);
    };
    control.querySelector(".wa-report").onclick = async (e) => {
      e.stopPropagation();
      await WA_Api.report(ann.id, state.userId);
      control.querySelector(".wa-report").textContent = "🚩✓";
    };

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

  // Autorul poate re-edita textul unei adnotări (dublu-click) — funcționează pentru text/bulă.
  function makeEditableOnDblClick(ann, domEl, { onSave }) {
    if (ann.authorId !== state.userId) return;
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
        console.error("[Web Annotate] Nu am putut salva editarea:", err);
      }
      onSave?.(text);
    });
  }

  // Editare pentru desene (pen/spray/formă) — nu au text, deci dublu-click deschide
  // un mic formular de culoare/grosime în loc de retastare inline.
  function makeStyleEditableOnDblClick(ann, domEl) {
    if (ann.authorId !== state.userId) return;
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
          console.error("[Web Annotate] Nu am putut salva intervalul:", err);
        }
      }
      popover.remove();
    };

    document.documentElement.appendChild(popover);
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
        console.error("[Web Annotate] Nu am putut salva editarea:", err);
      }
      popover.remove();
    };

    document.documentElement.appendChild(popover);
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
    if (ann.authorId !== state.userId) return;
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
    }

    async function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (!moved) return; // a fost doar un click (ex. pe link), nu o mutare

      // re-ancorăm de la locul nou al drop-ului, ca o redimensionare/zoom viitoare
      // să urmărească poziția nouă, nu pe cea originală de la creare
      const newAnchor = computeAnchor(e.clientX, e.clientY);
      ann.data.anchor = newAnchor;

      let patch;
      if (isSvg) {
        const newDx = origDx + (e.pageX - startX);
        const newDy = origDy + (e.pageY - startY);
        ann.data.dx = newDx;
        ann.data.dy = newDy;
        patch = { dx: newDx, dy: newDy, anchor: newAnchor };
      } else {
        const newX = parseFloat(domEl.style.left);
        const newY = parseFloat(domEl.style.top);
        ann.data.x = newX;
        ann.data.y = newY;
        patch = { x: newX, y: newY, anchor: newAnchor };
      }
      try {
        await WA_Api.updateAnnotation(ann.id, state.userId, patch);
      } catch (err) {
        console.error("[Web Annotate] Nu am putut salva poziția nouă:", err);
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
    if (entry.control) entry.control.querySelector(".wa-count").textContent = String(votes);
    applyVoteFilterOne(entry);
    refreshGlobalTop(); // un vot poate schimba și clasamentul GLOBAL, nu doar cel local
  }

  function applyVoteFilterOne(entry) {
    const hide = entry.ann.votes < state.minVotes;
    if (entry.el) entry.el.style.display = hide ? "none" : "";
    if (entry.control) entry.control.style.display = hide ? "none" : "";
  }

  function applyVoteFilter() {
    state.annotations.forEach(applyVoteFilterOne);
  }

  function removeAnnotation(id) {
    const entry = state.annotations.get(id);
    if (!entry) return;
    entry.el?.remove();
    entry.control?.remove();
    state.annotations.delete(id);
    renderSidebar();
  }

  function registerAnnotation(ann, domEl, control) {
    state.annotations.set(ann.id, { ann, el: domEl, control });
    applyVoteFilterOne(state.annotations.get(ann.id));
    wireVideoRange(ann, domEl, control);
    const handles = attachTransformHandles(ann, domEl); // null dacă nu ești autorul
    const reveal = wireHoverReveal(domEl, [control, handles?.resizeHandle, handles?.rotateHandle], {
      onShow: handles?.startTracking,
      onHide: handles?.stopTracking,
    });
    if (handles) wireHandleDragging(ann, domEl, handles, reveal);
    renderSidebar(); // clasamentul e mereu la zi, fără acțiune manuală
  }

  // Aplică translate (poziție, din drag/ancoră) + rotate + scale pe un element SVG
  // (pen/spray/formă) — TOATE trei combinate într-un singur "transform", ca zoom-ul
  // și rotirea să funcționeze corect chiar și pe o adnotare deja mutată din loc.
  function applySvgTransform(domEl, ann) {
    const dx = ann.data.dx || 0;
    const dy = ann.data.dy || 0;
    const rotate = ann.data.rotate || 0;
    const scale = ann.data.scale || 1;
    domEl.style.transform = `translate(${dx}px, ${dy}px) rotate(${rotate}deg) scale(${scale})`;
  }

  // La fel, pentru elemente DOM obișnuite (text/bulă/link) — acolo poziția e deja pe
  // left/top (nu pe transform), deci aici e nevoie doar de rotate + scale.
  function applyDomTransform(domEl, ann) {
    const rotate = ann.data.rotate || 0;
    const scale = ann.data.scale || 1;
    domEl.style.transform = `rotate(${rotate}deg) scale(${scale})`;
  }

  // Mânere de zoom/rotire — doar pentru autor, ca la mutare/editare. Colțul dreapta-jos
  // = zoom (trage mai departe de centru = mărește, mai aproape = micșorează), colțul
  // stânga-jos = rotire liberă (trage în cerc în jurul centrului, în orice direcție).
  // Poziția lor urmărește dreptunghiul REAL al adnotării (getBoundingClientRect), cât
  // timp sunt vizibile — printr-un mic loop de animație, ca să rămână lipite de colțuri
  // chiar dacă adnotarea se mută/rotește/scalează în timp real.
  function attachTransformHandles(ann, domEl) {
    if (ann.authorId !== state.userId) return null;

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
            console.error("[Web Annotate] Nu am putut salva zoom/rotire:", err);
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
  function wireVideoRange(ann, domEl, control) {
    const video = getMainVideo();
    if (!video) return; // fără video pe pagină

    function update() {
      // citim ann.data.videoRange DIN NOU la fiecare tick (nu memorat o dată) — ca editarea
      // ulterioară a secundelor (dublu-click) să aibă efect imediat, fără reload.
      const range = ann.data.videoRange;
      const visible = !range || (video.currentTime >= range.start && video.currentTime <= range.end);
      domEl.style.display = visible ? "" : "none";
      if (control) control.style.display = visible ? "" : "none";
    }
    video.addEventListener("timeupdate", update);
    update();
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
      document.documentElement.appendChild(confirmBar);
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
          const firstPoint = d.match(/M ([\d.]+) ([\d.]+)/);
          const control = attachVoteControl(ann, Number(firstPoint[1]), Number(firstPoint[2]));
          makeMovable(ann, path, control);
          makeStyleEditableOnDblClick(ann, path);
          registerAnnotation(ann, path, control);
        } catch (err) {
          console.error("[Web Annotate] Nu am putut salva desenul:", err);
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
    let spraying = false; // în timpul unei singure curse (mouse apăsat)
    let sessionActive = false; // sesiune deschisă, așteaptă OK/Anulează
    let group = null;
    let dots = [];
    let raf = null;
    let confirmBar = null;
    let anchor = null;

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
      document.documentElement.appendChild(confirmBar);
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
            data: { dots, color: state.color, anchor },
            authorId: state.userId,
          });
          const control = attachVoteControl(ann, dots[0].cx, dots[0].cy);
          makeMovable(ann, group, control);
          makeStyleEditableOnDblClick(ann, group);
          registerAnnotation(ann, group, control);
        } catch (err) {
          console.error("[Web Annotate] Nu am putut salva spray-ul:", err);
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
      spraying = true;
      if (!sessionActive) {
        sessionActive = true;
        anchor = computeAnchor(e.clientX, e.clientY);
        dots = [];
        group = svgEl("g");
        els.svg.appendChild(group);
        showConfirmBar();
        pendingToolFinish = finishSession; // dacă schimbi unealta fără OK, salvăm ce-i deja desenat
      }
      const { x, y } = pagePoint(e);
      addDots(x, y);
    });

    els.svg.addEventListener("pointermove", (e) => {
      if (!spraying || state.activeTool !== "spray") return;
      const { x, y } = pagePoint(e);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        addDots(x, y);
        raf = null;
      });
    });

    window.addEventListener("pointerup", () => {
      if (!spraying) return;
      spraying = false;
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
      document.documentElement.appendChild(confirmBar);
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
        console.error("[Web Annotate] Nu am putut salva forma:", err);
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
    document.documentElement.appendChild(confirmBar);

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
        console.error("[Web Annotate] Nu am putut salva textul:", err);
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
    document.documentElement.appendChild(confirmBar);

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
        console.error("[Web Annotate] Nu am putut salva bula:", err);
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
        console.error("[Web Annotate] Nu am putut salva link-ul:", err, err?.stack);
      }
      popover.remove();
    };

    document.documentElement.appendChild(popover);
    clampToViewport(popover);
    urlInput.focus();
  }

  function shortenUrl(url) {
    try {
      const u = new URL(url);
      const tail = u.pathname !== "/" ? u.pathname.slice(0, 20) : "";
      return u.hostname.replace(/^www\./, "") + tail;
    } catch {
      return url.slice(0, 30);
    }
  }

  function renderLinkAnnotation(ann) {
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
    badge.addEventListener("click", (e) => {
      e.preventDefault(); // navigăm noi manual (vezi mai jos), nu prin href-ul nativ
      if (openTimer) return; // al doilea click al unui dublu-click — nu programa încă un tab
      openTimer = setTimeout(() => {
        openTimer = null;
        window.open(ann.data.url, "_blank", "noopener,noreferrer");
      }, 250);
    });

    if (ann.authorId === state.userId) {
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

  function getMainVideo() {
    return document.querySelector("video");
  }

  // Oprește video-ul de fiecare dată când intri în editare (dublu-click), ca să nu
  // treacă de intervalul pe care-l editezi cât timp te uiți la formular.
  function pauseVideoIfPlaying() {
    const video = getMainVideo();
    if (video && !video.paused) video.pause();
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
      if (bubble.classList.contains("wa-visible")) {
        const r = bubble.getBoundingClientRect();
        control.style.left = r.left + window.scrollX + "px";
        control.style.top = r.top + window.scrollY + "px";
      }
    });

    registerAnnotation(ann, bubble, control);
  }

  // ---------- Rendering existing annotations ----------

  // Aplică poziția/zoom-ul/rotirea salvate (dacă autorul le-a modificat anterior)
  // unui element SVG la redare — vezi applySvgTransform.
  function applyStoredOffset(svgElement, ann) {
    applySvgTransform(svgElement, ann);
  }

  function renderAnnotation(ann) {
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
        const m = ann.data.d.match(/M ([\d.]+) ([\d.]+)/);
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

  function authorLabel(authorId) {
    const short = authorId.slice(0, 4).toUpperCase();
    return authorId === state.userId ? `Tu (${short})` : `Utilizator ${short}`;
  }

  // Cele 10 cifre din panoul din dreapta: colorate (cu propria culoare) dacă există o
  // adnotare pe locul respectiv, gri dacă locul e gol. E TOP GLOBAL — cele mai votate
  // adnotări de pe TOATE paginile de pe net (nu doar pagina curentă) — vezi refreshGlobalTop.
  // Doar repictează din state.globalTop, deja adus de pe server; nu face fetch aici.
  function renderSidebar() {
    if (!els.leaderboardSlots) return;

    const top10 = state.globalTop || [];
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
      slot.style.background = ann.data?.color || "#7c3aed";
      slot.title = `${shortLabel(ann)} — click pentru detalii`;
      slot.onclick = () => showLeaderboardDetail(ann, slot);
    });
  }

  // Aduce de pe server topul global (de pe TOATE paginile, nu doar cea curentă) și
  // repictează panoul. Apelat la pornire, după orice vot (poate schimba ordinea),
  // la navigare (SPA) și periodic — ca să prindă și voturile date de alții, pe alte
  // pagini/taburi, între timp.
  async function refreshGlobalTop() {
    try {
      state.globalTop = await WA_Api.listTopGlobal(10);
    } catch (err) {
      console.warn("[Web Annotate] Nu am putut încărca top-ul global:", err);
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
      el("div", { class: "wa-lb-detail-row" }, `${annotationIcon(ann.type)} ${authorLabel(ann.authorId)}`),
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
            onclick: () => window.open(ann.url, "_blank", "noopener,noreferrer"),
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
    document.documentElement.appendChild(detail);
    clampToViewport(detail);

    if (onThisPage) {
      const entry = state.annotations.get(ann.id);
      entry?.el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      if (ann.data?.videoRange) {
        const video = getMainVideo();
        if (video) video.currentTime = ann.data.videoRange.start;
      }
    }

    setTimeout(() => {
      document.addEventListener("click", function onDocClick(e) {
        if (!detail.contains(e.target) && e.target !== anchorEl) {
          detail.remove();
          document.removeEventListener("click", onDocClick);
        }
      });
    }, 0);
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

  // Selector CSS rezonabil de stabil: ID unic dacă există (pe el sau pe un strămoș), altfel
  // o cale de tip tag:nth-of-type până la acel strămoș sau până la <body>.
  function buildSelector(elm) {
    if (!elm || elm === document.body || elm === document.documentElement) return null;
    const parts = [];
    let node = elm;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 12) {
      if (node.id) {
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

  // La creare: reperul e elementul real de sub click + poziția relativă (%) în interiorul lui.
  function computeAnchor(clientX, clientY) {
    // Peste un video, ne ancorăm DIRECT de <video> (mereu prezent, stabil), nu de orice
    // e vizual deasupra în acel moment — pe YouTube/Netflix acolo pot fi straturi
    // temporare (bara de control, gradientul de hover) care dispar/reapar, și dacă
    // ANCORA ar fi unul din ele, la resize elementul poate lipsi și adnotarea rămâne
    // blocată pe poziția veche cât timp restul paginii se mișcă.
    const video = getMainVideo();
    if (video) {
      const vRect = video.getBoundingClientRect();
      const overVideo =
        clientX >= vRect.left && clientX <= vRect.right && clientY >= vRect.top && clientY <= vRect.bottom;
      if (overVideo && vRect.width >= 2 && vRect.height >= 2) {
        const selector = buildSelector(video);
        if (selector) {
          return {
            selector,
            offsetXPct: ((clientX - vRect.left) / vRect.width) * 100,
            offsetYPct: ((clientY - vRect.top) / vRect.height) * 100,
          };
        }
      }
    }

    const target = elementUnderPoint(clientX, clientY);
    const selector = buildSelector(target);
    if (!selector) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return {
      selector,
      offsetXPct: ((clientX - rect.left) / rect.width) * 100,
      offsetYPct: ((clientY - rect.top) / rect.height) * 100,
    };
  }

  // La afișare/redimensionare: unde e reperul ACUM → poziția (în pagină) unde trebuie desenată adnotarea.
  function resolveAnchor(anchor) {
    if (!anchor?.selector) return null;
    let target;
    try {
      target = document.querySelector(anchor.selector);
    } catch {
      return null;
    }
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return null; // devenit invizibil / display:none
    return {
      x: rect.left + window.scrollX + (anchor.offsetXPct / 100) * rect.width,
      y: rect.top + window.scrollY + (anchor.offsetYPct / 100) * rect.height,
    };
  }

  // Punctul de referință ORIGINAL (necorectat) din geometria unei adnotări SVG — pen/spray/formă
  // nu au un singur x,y ca text/bulă/link, deci calculăm deplasarea față de acest punct.
  function svgOriginPoint(ann) {
    if (ann.type === "pen") {
      const m = ann.data.d.match(/M ([\d.]+) ([\d.]+)/);
      if (!m) return null;
      return { x: Number(m[1]), y: Number(m[2]) };
    }
    if (ann.type === "spray") {
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
      if (!resolved) return; // reperul a dispărut de pe pagină — rămânem la ultima poziție cunoscută

      const isSvg = domEl instanceof SVGElement;
      if (isSvg) {
        const origin = svgOriginPoint(ann);
        if (!origin) return;
        const dx = resolved.x - origin.x;
        const dy = resolved.y - origin.y;
        ann.data.dx = dx;
        ann.data.dy = dy;
        applySvgTransform(domEl, ann);
        if (control) {
          control.style.left = origin.x + dx + "px";
          control.style.top = origin.y + dy + "px";
        }
      } else {
        if (control) {
          control.style.left = parseFloat(control.style.left) + (resolved.x - ann.data.x) + "px";
          control.style.top = parseFloat(control.style.top) + (resolved.y - ann.data.y) + "px";
        }
        ann.data.x = resolved.x;
        ann.data.y = resolved.y;
        domEl.style.left = resolved.x + "px";
        domEl.style.top = resolved.y + "px";
      }
    });
  }

  // ---------- Init ----------

  async function loadExisting() {
    try {
      const list = await WA_Api.listAnnotations(pageKey());
      list.forEach(renderAnnotation);
      sizeLayers();
      repositionAnchoredAnnotations(); // pagina poate fi deja alt layout decât la creare
    } catch (err) {
      console.warn("[Web Annotate] Nu pot contacta serverul (e pornit?):", err);
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
    state.annotations.clear();
    document.querySelectorAll(".wa-popover, .wa-spray-confirm, .wa-lb-detail").forEach((p) => p.remove());
    setActiveTool(null);
    await loadExisting();
    refreshGlobalTop(); // topul e global, nu se resetează la navigare — doar îl reîmprospătăm
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TOGGLE_TOOLBAR") toggleToolbar();
  });

  (async function init() {
    state.userId = await window.WA_Storage.getUserId();
    buildOverlay();
    initPenTool();
    initSprayTool();
    initShapeTool();
    initTextTool();
    initBubbleTool();
    initLinkTool();
    watchForNavigation();
    await loadExisting();
    await refreshGlobalTop();
    setInterval(refreshGlobalTop, 30000); // prinde și voturile date de alții, pe alte pagini, între timp
  })();
})();
