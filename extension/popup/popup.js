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

// Numele afișat (opțional, unic) — același ca în panoul „Ale mele” de pe pagină. Doar cu
// acordul dat: fără el, extensia nu trimite nimic serverului.
const nameBox = document.getElementById("name-box");
const nameInput = document.getElementById("display-name");
const saveNameBtn = document.getElementById("save-name");
const nameStatus = document.getElementById("name-status");

async function serverBase() {
  const { wa_server_url } = await chrome.storage.local.get("wa_server_url");
  return wa_server_url || DEFAULT_SERVER_URL;
}

async function renderName() {
  const { wa_consent, wa_user_hash } = await chrome.storage.local.get(["wa_consent", "wa_user_hash"]);
  const ok = !!wa_consent && !!wa_user_hash;
  nameBox.hidden = saveNameBtn.hidden = !ok;
  if (!ok) return;
  try {
    const res = await fetch(`${await serverBase()}/api/users/${wa_user_hash}`);
    const { name } = await res.json();
    nameInput.value = name || "";
    nameStatus.textContent = name ? "" : `Acum apari ca „Utilizator ${wa_user_hash.slice(0, 4).toUpperCase()}”.`;
  } catch {
    nameStatus.textContent = "Nu pot contacta serverul.";
  }
}

saveNameBtn.addEventListener("click", async () => {
  const { wa_user_id } = await chrome.storage.local.get("wa_user_id");
  try {
    const res = await fetch(`${await serverBase()}/api/users/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorId: wa_user_id, name: nameInput.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Eroare ${res.status}`);
    nameInput.value = body.name || "";
    nameStatus.textContent = body.name ? `Salvat: apari ca „${body.name}”.` : "Numele a fost șters.";
  } catch (err) {
    nameStatus.textContent = `⚠️ ${err.message}`;
  }
});

renderName();
