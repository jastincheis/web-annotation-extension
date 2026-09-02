const DEFAULT_SERVER_URL = "https://web-annotation-extension-production.up.railway.app";

const serverInput = document.getElementById("server-url");
const statusEl = document.getElementById("status");
const updateBanner = document.getElementById("update-banner");
const updateText = document.getElementById("update-text");

chrome.storage.local.get("wa_server_url").then((r) => {
  serverInput.value = r.wa_server_url || DEFAULT_SERVER_URL;
});

// Dacă background.js a găsit o versiune mai nouă pe server decât cea instalată local,
// arată mesajul aici — e aceeași informație ca beculețul de pe iconiță, dar cu detalii.
chrome.storage.local.get("wa_update_available").then((r) => {
  const info = r.wa_update_available;
  if (!info) return;
  updateText.textContent = `Versiune nouă: v${info.latest} (ai v${info.current}).${info.notes ? " " + info.notes : ""}`;
  updateBanner.hidden = false;
});

document.getElementById("save-server").addEventListener("click", async () => {
  const url = serverInput.value.trim().replace(/\/$/, "") || DEFAULT_SERVER_URL;
  await chrome.storage.local.set({ wa_server_url: url });
  statusEl.textContent = "Salvat. Reîncarcă pagina pentru efect.";
});

document.getElementById("toggle-btn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_TOOLBAR" });
    window.close();
  } catch (err) {
    statusEl.textContent = "Reîncarcă pagina (extensia tocmai a pornit).";
  }
});
