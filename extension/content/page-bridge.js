// Rulează în lumea PAGINII (world: "MAIN"), doar pe Netflix — content.js (lumea izolată)
// nu vede obiectul global `netflix`. Netflix nu acceptă video.currentTime = ... (player-ul
// se oprește cu eroarea M7375), așa că săritul la un moment și pauza trec prin API-ul lor.
(() => {
  function netflixPlayer() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      return ids.length ? vp.getVideoPlayerBySessionId(ids[ids.length - 1]) : null;
    } catch {
      return null;
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "adormis") return;
    const player = netflixPlayer();
    if (!player) {
      console.warn("[Adormis] Player-ul Netflix nu e disponibil");
      return;
    }
    if (e.data.type === "seek" && Number.isFinite(e.data.seconds)) player.seek(Math.round(e.data.seconds * 1000));
    if (e.data.type === "pause") player.pause();
  });
})();
