// Pagina de moderare. Tokenul stă doar în sessionStorage (se uită la închiderea tab-ului).
// Tot conținutul utilizatorilor se pune în pagină ca TEXT (textContent), niciodată ca HTML.
const REASONS = {
  illegal: "Conținut ilegal",
  hate: "Ură / discriminare",
  harassment: "Hărțuire / amenințări",
  personal_data: "Date personale ale altcuiva",
  sexual: "Conținut sexual",
  spam: "Spam / reclamă",
  copyright: "Drepturi de autor",
  other: "Altceva",
};
const $ = (s) => document.querySelector(s);
let token = sessionStorage.getItem("wa_admin_token") || "";
let status = "reported";

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => (k === "class" ? (n.className = v) : n.setAttribute(k, v)));
  kids.forEach((k) => n.append(k instanceof Node ? k : document.createTextNode(String(k ?? ""))));
  return n;
}

async function api(path, body) {
  const res = await fetch(`/api/admin${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Eroare ${res.status}`);
  return data;
}

function summary(a) {
  const d = a.data || {};
  if (d.text) return d.text;
  if (a.type === "link") return `${d.label ? d.label + " — " : ""}${d.url}`;
  return { pen: "desen", spray: "graffiti", shape: `formă (${d.shape || "?"})` }[a.type] || a.type;
}

function card(a) {
  const when = (t) => (t ? new Date(t).toLocaleString("ro-RO") : "—");
  const link = el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, a.url);
  const reason = el("input", { placeholder: "Motivul (apare în evidență)", maxlength: "500" });
  const actions = el("div", { class: "actions" });
  if (a.authorName) actions.append(el("button", { "data-act": "reset-name" }, `Resetează numele „${a.authorName}”`));
  if (a.removedAt) {
    actions.append(el("button", { class: "ok", "data-act": "restore" }, "Repune"));
  } else {
    actions.append(reason, el("button", { class: "danger", "data-act": "remove" }, "Scoate"), el("button", { "data-act": "restore" }, "Raportări nefondate (repune)"));
  }
  const c = el(
    "article",
    { class: "card" },
    el("div", { class: "meta" },
      el("span", { class: "badge" }, a.type),
      el("span", { class: a.hidden ? "badge hidden" : "badge" }, `${a.reports} raportări${a.hidden ? " · ascunsă automat" : ""}`),
      el("span", {}, `${a.votes} voturi`),
      el("span", {}, `autor: ${a.authorName || "Utilizator " + String(a.authorHash || "????").slice(0, 4).toUpperCase()}`),
      el("span", {}, `creată ${when(a.createdAt)}`),
      a.removedAt ? el("span", {}, `scoasă ${when(a.removedAt)}`) : ""
    ),
    el("div", { class: "content" }, summary(a)),
    el("div", { class: "url" }, link),
    a.removedReason ? el("div", {}, "Motivul scoaterii: ", a.removedReason) : "",
    a.reportList?.length
      ? el("ul", { class: "reports" }, ...a.reportList.map((r) => el("li", {}, `${REASONS[r.reason] || r.reason || "fără motiv"}${r.details ? " — " + r.details : ""} (${when(r.at)})`)))
      : "",
    actions
  );
  actions.addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    try {
      if (act === "remove") await api(`/annotations/${a.id}/remove`, { reason: reason.value });
      else if (act === "reset-name") await api(`/users/${a.authorHash}/reset-name`, {});
      else await api(`/annotations/${a.id}/restore`, {});
      $("#msg").textContent =
        act === "remove" ? "Adnotarea a fost scoasă." : act === "reset-name" ? "Numele a fost resetat." : "Adnotarea a fost repusă.";
      load();
    } catch (err) {
      $("#msg").textContent = err.message;
    }
  });
  return c;
}

async function load() {
  $("#list").textContent = "";
  try {
    const items = await api(`/queue?status=${status}`);
    $("#login").hidden = true;
    $("#tabs").hidden = false;
    $("#name-form").hidden = false;
    if (!items.length) $("#list").append(el("p", {}, status === "removed" ? "Nimic scos încă." : "Nicio adnotare raportată."));
    items.forEach((a) => $("#list").append(card(a)));
  } catch (err) {
    $("#msg").textContent = err.message;
    if (/token/i.test(err.message)) logout();
  }
}

function logout() {
  token = "";
  sessionStorage.removeItem("wa_admin_token");
  $("#login").hidden = false;
  $("#tabs").hidden = true;
  $("#name-form").hidden = true;
  $("#list").textContent = "";
}

$("#login").addEventListener("submit", (e) => {
  e.preventDefault();
  token = $("#token").value.trim();
  sessionStorage.setItem("wa_admin_token", token);
  $("#msg").textContent = "";
  load();
});
$("#tabs").addEventListener("click", (e) => {
  const s = e.target.dataset?.status;
  if (!s) return;
  status = s;
  document.querySelectorAll("#tabs [data-status]").forEach((b) => b.classList.toggle("active", b === e.target));
  load();
});
$("#logout").addEventListener("click", logout);
$("#name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const hash = $("#name-hash").value.trim().toLowerCase();
  try {
    const r = await api(`/users/${encodeURIComponent(hash)}/set-name`, { name: $("#name-value").value });
    $("#msg").textContent = `Numele „${r.name}” a fost dat utilizatorului ${hash.slice(0, 4).toUpperCase()}.`;
    load();
  } catch (err) {
    $("#msg").textContent = err.message;
  }
});
if (token) load();
