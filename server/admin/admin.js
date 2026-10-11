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

// ---------- Utilizatori ----------
// Lista vine întreagă de la server (e mică); căutarea filtrează în pagină, după nume sau ID.
let users = [];
const when = (t) => (t ? new Date(t).toLocaleString("ro-RO") : "—");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const userLabel = (u) => u.name || `Utilizator ${u.hash.slice(0, 4).toUpperCase()}`;

function userCard(u) {
  const actions = el("div", { class: "actions" }, el("button", { "data-act": "anns" }, `Vezi adnotările (${u.visible})`));
  if (u.name) actions.append(el("button", { "data-act": "reset-name" }, `Resetează numele „${u.name}”`));
  actions.append(el("button", { "data-act": "chat-block" }, u.chatBlocked ? "Deblochează în chat" : "Blochează din chat"));
  actions.append(el("button", { "data-act": "delete-user", class: "danger" }, "Șterge utilizatorul"));
  const anns = el("ul", { class: "user-anns" });
  const c = el(
    "article",
    { class: "card" },
    el("div", { class: "user-head" },
      el("span", { class: "user-name" }, userLabel(u)),
      u.hasPassword ? el("span", { class: "badge" }, "cont cu parolă") : u.name ? el("span", { class: "badge" }, "doar nume") : "",
      el("span", { class: "user-id" }, u.hash)
    ),
    el("div", { class: "meta" },
      el("span", {}, `${plural(u.annotations, "adnotare", "adnotări")}${u.annotations !== u.visible ? ` (${u.visible} vizibile)` : ""}`),
      el("span", {}, plural(u.votes, "vot dat", "voturi date")),
      u.chatMessages ? el("span", {}, plural(u.chatMessages, "mesaj în chat", "mesaje în chat")) : "",
      u.chatBlocked ? el("span", { class: "badge hidden" }, "blocat în chat") : "",
      u.reports ? el("span", {}, plural(u.reports, "raportare făcută", "raportări făcute")) : "",
      el("span", {}, u.firstAt ? `prima activitate ${when(u.firstAt)}` : "doar a votat"),
      u.lastAt ? el("span", {}, `ultima ${when(u.lastAt)}`) : ""
    ),
    actions,
    anns
  );
  actions.addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    try {
      if (act === "chat-block") {
        await api(`/users/${u.hash}/chat-block`, { blocked: !u.chatBlocked });
        $("#msg").textContent = u.chatBlocked ? `${userLabel(u)} poate scrie din nou în chat.` : `${userLabel(u)} nu mai poate scrie în chat.`;
        return load();
      }
      if (act === "delete-user") {
        // a doua apăsare confirmă (fără dialog de browser)
        if (!e.target.dataset.armed) {
          e.target.dataset.armed = "1";
          e.target.textContent = `Sigur? Se șterg ${plural(u.annotations, "adnotare", "adnotări")} și ${plural(u.votes, "vot", "voturi")} — apasă din nou`;
          return;
        }
        const r = await api(`/users/${u.hash}/delete`, {});
        $("#msg").textContent = `${userLabel(u)} a fost șters (${plural(r.annotations, "adnotare", "adnotări")}, ${plural(r.votes, "vot", "voturi")}, ${plural(r.reports, "raportare", "raportări")}).`;
        return load();
      }
      if (act === "reset-name") {
        await api(`/users/${u.hash}/reset-name`, {});
        $("#msg").textContent = "Numele a fost resetat.";
        return load();
      }
      // profilul public al utilizatorului (aceleași date pe care le vede oricine în extensie)
      const res = await fetch(`/api/annotations/by-author/${u.hash}`);
      const list = await res.json();
      anns.textContent = "";
      if (!list.length) anns.append(el("li", {}, "Nicio adnotare vizibilă."));
      list.forEach((a) =>
        anns.append(el("li", {}, `${summary(a)} · ${plural(a.votes, "vot", "voturi")} · `, el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, a.url)))
      );
    } catch (err) {
      $("#msg").textContent = err.message;
    }
  });
  return c;
}

function renderUsers() {
  const q = $("#user-search").value.trim().toLowerCase();
  const norm = (t) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const shown = q ? users.filter((u) => norm(userLabel(u)).includes(norm(q)) || u.hash.startsWith(q)) : users;
  $("#user-count").textContent = q ? `${shown.length} din ${users.length} utilizatori` : `${users.length} utilizatori`;
  $("#list").textContent = "";
  if (!shown.length) $("#list").append(el("p", {}, q ? "Niciun utilizator găsit." : "Niciun utilizator încă."));
  shown.forEach((u) => $("#list").append(userCard(u)));
}

// ---------- Chat ----------
// Mesajele raportate (cele cu 3+ raportări sunt deja ascunse automat) și cele scoase.
function chatCard(m) {
  const reason = el("input", { placeholder: "Motivul (apare în evidență)", maxlength: "500" });
  const actions = el("div", { class: "actions" });
  if (m.removedAt) actions.append(el("button", { class: "ok", "data-act": "restore" }, "Repune"));
  else actions.append(reason, el("button", { class: "danger", "data-act": "remove" }, "Scoate"), el("button", { "data-act": "restore" }, "Raportări nefondate (repune)"));
  const c = el(
    "article",
    { class: "card" },
    el("div", { class: "meta" },
      el("span", { class: "badge" }, "chat"),
      m.removedAt ? "" : el("span", { class: m.reports >= 3 ? "badge hidden" : "badge" }, `${m.reports} raportări${m.reports >= 3 ? " · ascuns automat" : ""}`),
      el("span", {}, `autor: ${m.authorName || "Utilizator " + String(m.authorHash).slice(0, 4).toUpperCase()}`),
      el("span", {}, `scris ${when(m.createdAt)}`),
      m.removedAt ? el("span", {}, `scos ${when(m.removedAt)}`) : ""
    ),
    el("div", { class: "content" }, m.text),
    m.removedReason ? el("div", {}, "Motivul scoaterii: ", m.removedReason) : "",
    m.reasons?.length ? el("ul", { class: "reports" }, ...m.reasons.map((r) => el("li", {}, `${REASONS[r.reason] || r.reason} × ${r.n}`))) : "",
    actions
  );
  actions.addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    try {
      if (act === "remove") await api(`/chat/${m.id}/remove`, { reason: reason.value });
      else await api(`/chat/${m.id}/restore`, {});
      $("#msg").textContent = act === "remove" ? "Mesajul a fost scos." : "Mesajul a fost repus.";
      load();
    } catch (err) {
      $("#msg").textContent = err.message;
    }
  });
  return c;
}

function renderChat({ reported, removed }) {
  $("#list").append(el("h2", {}, "Mesaje raportate"));
  if (!reported.length) $("#list").append(el("p", {}, "Niciun mesaj raportat."));
  reported.forEach((m) => $("#list").append(chatCard(m)));
  $("#list").append(el("h2", {}, "Mesaje scoase"));
  if (!removed.length) $("#list").append(el("p", {}, "Nimic scos încă."));
  removed.forEach((m) => $("#list").append(chatCard(m)));
}

async function load() {
  $("#list").textContent = "";
  try {
    const items = await api(status === "users" ? "/users" : status === "chat" ? "/chat" : `/queue?status=${status}`);
    $("#login").hidden = true;
    $("#tabs").hidden = false;
    $("#name-form").hidden = false;
    $("#pass-form").hidden = false;
    $("#user-tools").hidden = status !== "users";
    if (status === "users") {
      users = items;
      return renderUsers();
    }
    if (status === "chat") return renderChat(items);
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
  $("#pass-form").hidden = true;
  $("#pass-result").hidden = true;
  $("#user-tools").hidden = true;
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
$("#user-search").addEventListener("input", renderUsers);
$("#pass-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#pass-name").value.trim();
  if (!confirm(`Resetezi parola contului „${name}”? Parola veche nu mai merge.`)) return;
  const box = $("#pass-result");
  box.textContent = "";
  try {
    const r = await api("/users/reset-password", { name });
    box.append(
      el("p", {}, `Parolă temporară pentru „${r.name}” (apare o singură dată — trimite-o doar titularului): `, el("code", {}, r.tempPassword)),
      el("p", {}, `Contul are ${r.total} adnotări. Ultimele:`),
      el("ul", {}, ...r.recent.map((a) => el("li", {}, `${a.text ? "„" + a.text + "” — " : ""}${a.url} (${new Date(a.at).toLocaleDateString("ro-RO")})`)))
    );
    box.hidden = false;
    $("#msg").textContent = "Parola a fost resetată. Spune-i utilizatorului s-o schimbe după ce intră.";
  } catch (err) {
    $("#msg").textContent = err.message;
  }
});
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
