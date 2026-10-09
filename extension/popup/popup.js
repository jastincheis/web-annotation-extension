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

// Acordul pentru trimiterea datelor (dat la prima folosire, pe pagină). Retragerea lui
// oprește imediat extensia pe paginile deschise (content.js ascultă schimbarea) și o face
// să ceară din nou acordul data viitoare.
const consentStatus = document.getElementById("consent-status");
const revokeBtn = document.getElementById("revoke-consent");

async function renderConsent() {
  const { wa_consent } = await chrome.storage.local.get("wa_consent");
  if (wa_consent) {
    consentStatus.textContent = `Acord dat pe ${new Date(wa_consent.at).toLocaleDateString("ro-RO")}.`;
    revokeBtn.hidden = false;
  } else {
    consentStatus.textContent = "Extensia e oprită: nu trimite nimic până nu îți dai acordul (apasă butonul de mai sus pe o pagină).";
    revokeBtn.hidden = true;
  }
}

revokeBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("wa_consent");
  statusEl.textContent = "Acord retras. Extensia nu mai trimite nimic.";
  renderConsent();
});

renderConsent();
