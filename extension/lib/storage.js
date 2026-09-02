// Gestionează identitatea anonimă locală a utilizatorului și adresa serverului.
// Rulează în contextul izolat al content script-ului (nu se ciocnește cu pagina).
(function () {
  const KEY_USER_ID = "wa_user_id";
  const KEY_SERVER_URL = "wa_server_url";
  const DEFAULT_SERVER_URL = "http://localhost:4000";

  async function getUserId() {
    const result = await chrome.storage.local.get(KEY_USER_ID);
    if (result[KEY_USER_ID]) return result[KEY_USER_ID];
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [KEY_USER_ID]: id });
    return id;
  }

  async function getServerUrl() {
    const result = await chrome.storage.local.get(KEY_SERVER_URL);
    return result[KEY_SERVER_URL] || DEFAULT_SERVER_URL;
  }

  async function setServerUrl(url) {
    await chrome.storage.local.set({ [KEY_SERVER_URL]: url });
  }

  window.WA_Storage = { getUserId, getServerUrl, setServerUrl, DEFAULT_SERVER_URL };
})();
