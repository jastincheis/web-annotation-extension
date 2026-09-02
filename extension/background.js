// Service worker minimal. Inițializează adresa implicită a serverului la instalare.
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("wa_server_url");
  if (!existing.wa_server_url) {
    await chrome.storage.local.set({ wa_server_url: "http://localhost:4000" });
  }
});
