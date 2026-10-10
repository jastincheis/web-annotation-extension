// Service worker: inițializează adresa implicită a serverului la instalare și verifică
// periodic (la o oră, la pornire și la cerere) dacă există o versiune mai nouă a extensiei.
// Starea se salvează în wa_version_status — bulina din bara Adormis (verde = la zi, portocaliu =
// versiune nouă) și meniul extensiei o citesc. Pe iconiță: nimic cât ești la zi, „↑” portocaliu
// când apare o versiune nouă.
const DEFAULT_SERVER_URL = "https://web-annotation-extension-production.up.railway.app";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("wa_server_url");
  if (!existing.wa_server_url) {
    await chrome.storage.local.set({ wa_server_url: DEFAULT_SERVER_URL });
  }
  chrome.alarms.create("wa_version_check", { periodInMinutes: 60 }); // la o oră
  checkForUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("wa_version_check", { periodInMinutes: 60 }); // și pentru instalările vechi (erau la 6 ore)
  checkForUpdate();
});
// La deschiderea barei, pagina cere o verificare proaspătă.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "WA_CHECK_VERSION") checkForUpdate();
});
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

    const outdated = !!latest && isNewerVersion(latest, current);
    await chrome.storage.local.set({
      wa_version_status: { current, latest: latest || current, notes: notes || "", outdated, checkedAt: Date.now() },
    });
    if (outdated) {
      await chrome.storage.local.set({ wa_update_available: { latest, notes: notes || "", current } });
      chrome.action.setBadgeText({ text: "↑" });
      chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
      chrome.action.setTitle({ title: `Adormis — versiune nouă: v${latest} (ai v${current})` });
    } else {
      await chrome.storage.local.remove("wa_update_available");
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: `Adormis v${current} — ești la zi` });
    }
  } catch (err) {
    console.warn("[Adormis] Nu am putut verifica versiunea:", err);
  }
}
