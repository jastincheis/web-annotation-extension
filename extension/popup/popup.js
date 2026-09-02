const DEFAULT_SERVER_URL = "http://localhost:4000";

const serverInput = document.getElementById("server-url");
const statusEl = document.getElementById("status");

chrome.storage.local.get("wa_server_url").then((r) => {
  serverInput.value = r.wa_server_url || DEFAULT_SERVER_URL;
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
