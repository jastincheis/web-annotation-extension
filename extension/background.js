// Service worker: inițializează adresa implicită a serverului la instalare și verifică
// periodic dacă există o versiune mai nouă a extensiei decât cea instalată local —
// dacă da, aprinde un "beculeț" (bulină verde) pe iconița din bara de extensii, plus
// un mesaj în popup (vezi popup.js).
const DEFAULT_SERVER_URL = "https://web-annotation-extension-production.up.railway.app";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("wa_server_url");
  if (!existing.wa_server_url) {
    await chrome.storage.local.set({ wa_server_url: DEFAULT_SERVER_URL });
  }
  chrome.alarms.create("wa_version_check", { periodInMinutes: 360 }); // la 6 ore
  checkForUpdate();
});

chrome.runtime.onStartup.addListener(checkForUpdate);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "wa_version_check") checkForUpdate();
});

// Compară numeric "1.2.3" vs "1.10.0" — ca text, "1.9.0" ar părea mai mare ca "1.10.0".
function isNewerVersion(remote, local) {
  const r = String(remote).split(".").map(Number);
  const l = String(local).split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = r[i] || 0;
    const b = l[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

async function checkForUpdate() {
  try {
    const { wa_server_url } = await chrome.storage.local.get("wa_server_url");
    const base = (wa_server_url || DEFAULT_SERVER_URL).replace(/\/$/, "");
    const res = await fetch(`${base}/api/version`);
    if (!res.ok) return;
    const { latest, notes } = await res.json();
    const current = chrome.runtime.getManifest().version;

    if (latest && isNewerVersion(latest, current)) {
      await chrome.storage.local.set({ wa_update_available: { latest, notes: notes || "", current } });
      chrome.action.setBadgeText({ text: "●" });
      chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
      chrome.action.setTitle({ title: `Adormis — actualizare disponibilă (v${latest})` });
    } else {
      await chrome.storage.local.remove("wa_update_available");
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "Adormis" });
    }
  } catch (err) {
    console.warn("[Adormis] Nu am putut verifica versiunea:", err);
  }
}
