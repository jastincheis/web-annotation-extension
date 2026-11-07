// Rulează la document_start, ca pagina să nu clipească în alb înainte să se închidă.
// Starea e locală, nu ajunge pe server: pornit/oprit pe fiecare site + nuanța (o singură
// alegere, valabilă peste tot). content.js rulează în aceeași lume izolată și folosește
// window.__waDark pentru buton.
(() => {
  const SITES_KEY = "wa_dark_sites";
  const SHADE_KEY = "wa_dark_shade";
  const host = location.hostname;
  const root = document.documentElement;
  const listeners = new Set();
  let on = false;
  let shade = "gray";

  // În fullscreen elementul nu mai e sub filtrul de pe <html>, așa că doar contra-filtrul
  // lui ar rămâne și video-ul ar apărea ca un negativ. Îl oprim cât ține fullscreen-ul.
  function paint() {
    if (on && !document.fullscreenElement) root.setAttribute("data-wa-dark", shade);
    else root.removeAttribute("data-wa-dark");
    listeners.forEach((fn) => fn({ on, shade }));
  }

  async function load() {
    try {
      const got = await chrome.storage.local.get([SITES_KEY, SHADE_KEY]);
      on = !!got[SITES_KEY]?.[host];
      shade = got[SHADE_KEY] === "black" ? "black" : "gray";
    } catch {
      on = false; // contextul extensiei a dispărut: pagina rămâne cum e
    }
    paint();
  }

  async function setOn(value) {
    on = value;
    paint();
    const { [SITES_KEY]: sites = {} } = await chrome.storage.local.get(SITES_KEY);
    if (value) sites[host] = true;
    else delete sites[host];
    await chrome.storage.local.set({ [SITES_KEY]: sites });
  }

  async function setShade(value) {
    shade = value;
    paint();
    await chrome.storage.local.set({ [SHADE_KEY]: value });
  }

  // Fundalul e deja închis? Citim culorile din CSS, pe care filtrul nostru nu le schimbă.
  // 5 puncte de pe ecran, ca un antet închis să nu păcălească o pagină albă.
  function pageLooksDark() {
    const luminance = (x, y) => {
      for (const node of document.elementsFromPoint(x, y)) {
        if (node.closest('[id^="wa-"], [class^="wa-"]') || node.matches("img, video, canvas, iframe")) continue;
        const m = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
        if (!m || (m.length > 3 && +m[3] < 0.5)) continue;
        return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
      }
      return 1; // nimic colorat: fundalul implicit al browserului e alb
    };
    const w = innerWidth;
    const h = innerHeight;
    const points = [[0.5, 0.5], [0.25, 0.35], [0.75, 0.35], [0.25, 0.75], [0.75, 0.75]];
    return points.filter(([px, py]) => luminance(w * px, h * py) < 0.4).length >= 4;
  }

  document.addEventListener("fullscreenchange", paint);
  // Același site deschis în alt tab se schimbă odată cu acesta.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[SITES_KEY] || changes[SHADE_KEY])) load();
  });
  load();

  window.__waDark = {
    state: () => ({ on, shade }),
    setOn,
    setShade,
    pageLooksDark,
    subscribe: (fn) => listeners.add(fn),
  };
})();
