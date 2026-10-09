// Rulează la document_start, ÎNAINTEA scripturilor site-ului. Player-ele video (Netflix,
// Prime, Disney+, YouTube...) ascultă tastele pe window/document — unele în faza de
// "capture", înainte ca evenimentul să ajungă la câmpul nostru. Fără asta, când scrii într-o
// bulă/text/link, spațiul pune pauză, „f” intră în fullscreen, săgețile derulează filmul.
// Oprim propagarea DOAR pentru tastele apăsate într-un câmp editabil al extensiei; scrisul
// în sine (acțiunea implicită) nu e afectat.
//
// Tot aici trec și scurtăturile dock-ului (P, S, F, B, T, L, V, Esc, Alt+A): content.js
// rulează în aceeași lume izolată și expune window.__waShortcut. Dacă o folosește, o oprim
// și pentru site (altfel pe Netflix „F” ar alege forma ȘI ar intra în fullscreen).
(() => {
  const OURS = '[id^="wa-"], [class^="wa-"], [class*=" wa-"]';
  function isEditable(t) {
    return t.isContentEditable || t.matches("input, textarea, select");
  }
  function guard(e) {
    const t = e.composedPath()[0];
    if (t instanceof Element && isEditable(t)) {
      if (!t.closest(OURS)) return; // în câmpurile site-ului (căutare, chat) nu interceptăm nimic
      e.stopImmediatePropagation();
      // Oprirea de mai sus blochează și ascultătorii câmpului însuși, deci Enter/Esc din
      // formularele noastre (link, link atașat...) le tratăm direct aici.
      const pop = t.closest(".wa-popover");
      if (pop && e.type === "keydown" && !e.isComposing) {
        if (e.key === "Enter" && t.matches("input")) {
          e.preventDefault();
          pop.querySelector(".wa-submit")?.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          pop.querySelector(".wa-cancel:not(.wa-unlink)")?.click();
        }
      }
      return;
    }
    if (e.type === "keydown" && !e.repeat && window.__waShortcut?.(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  ["keydown", "keyup", "keypress"].forEach((type) => window.addEventListener(type, guard, true));
})();
