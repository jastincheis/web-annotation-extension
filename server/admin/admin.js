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
let me = null; // { name, role } — rolul vine de la server; pagina doar ascunde ce nu e permis

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
  if (me?.role === "owner") actions.append(el("button", { "data-act": "delete-user", class: "danger" }, "Șterge utilizatorul"));
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

// ---------- Moderatori (doar proprietarul) ----------
const ROLE_LABEL = { owner: "proprietar", moderator: "moderator" };

function renderMods(tokens) {
  const name = el("input", { placeholder: "Numele omului (ex. Vlad)", maxlength: "40", required: "" });
  const role = el("select", {}, el("option", { value: "moderator" }, "Moderator"), el("option", { value: "owner" }, "Proprietar (tot)"));
  const create = el("button", { type: "submit" }, "Creează token");
  const out = el("div");
  const form = el("form", { class: "card" },
    el("strong", {}, "Moderator nou"),
    el("p", { class: "meta" }, "Moderatorul poate scoate și repune adnotări și mesaje, bloca din chat și reseta nume. Nu poate șterge utilizatori, reseta parole, descărca backup-ul sau face alți moderatori."),
    el("div", { class: "actions" }, name, role, create),
    out
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api("/tokens", { name: name.value, role: role.value });
      const code = el("code", {}, r.token);
      const copy = el("button", { type: "button" }, "Copiază");
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(r.token);
          copy.textContent = "Copiat ✓";
        } catch {
          copy.textContent = "Selectează și copiază manual";
        }
      };
      out.textContent = "";
      out.append(el("div", { class: "token-box" },
        el("strong", {}, `Tokenul lui ${r.name} (${ROLE_LABEL[r.role]}) — apare o singură dată:`),
        code,
        el("div", { class: "actions" }, copy),
        el("span", { class: "meta" }, "Trimite-l doar lui, pe o cale privată. Intră pe această pagină (/admin) și îl pune la „Token de administrator”. Dacă îl pierde, îi faci altul și îl retragi pe acesta.")
      ));
      name.value = "";
      loadTokenList(list);
    } catch (err) {
      $("#msg").textContent = err.message;
    }
  });
  const list = el("div", { class: "card" });
  $("#list").append(form, list);
  fillTokenList(list, tokens);
}

async function loadTokenList(list) {
  try {
    fillTokenList(list, await api("/tokens"));
  } catch (err) {
    $("#msg").textContent = err.message;
  }
}

function fillTokenList(list, tokens) {
  list.textContent = "";
  list.append(el("strong", {}, "Tokenuri"));
  list.append(el("p", { class: "meta" }, "Proprietarul principal intră cu ADMIN_TOKEN de pe server; acela nu apare aici și nu se retrage de aici."));
  if (!tokens.length) list.append(el("p", {}, "Niciun moderator încă."));
  for (const t of tokens) {
    const row = el("div", { class: "actions" },
      el("span", { class: t.revokedAt ? "badge revoked" : "badge" }, `${t.name} · ${ROLE_LABEL[t.role]}`),
      el("span", { class: "meta" }, `creat ${when(t.createdAt)}${t.createdBy ? " de " + t.createdBy : ""} · folosit ${t.lastUsedAt ? when(t.lastUsedAt) : "niciodată"}${t.revokedAt ? " · retras " + when(t.revokedAt) : ""}`)
    );
    if (!t.revokedAt) {
      const revoke = el("button", { class: "danger", type: "button" }, "Retrage");
      revoke.onclick = async () => {
        if (!revoke.dataset.armed) {
          revoke.dataset.armed = "1";
          revoke.textContent = `Sigur? ${t.name} nu mai poate intra — apasă din nou`;
          return;
        }
        try {
          await api(`/tokens/${t.id}/revoke`, {});
          $("#msg").textContent = `Tokenul lui ${t.name} a fost retras.`;
          loadTokenList(list);
        } catch (err) {
          $("#msg").textContent = err.message;
        }
      };
      row.append(revoke);
    }
    list.append(row);
  }
}

// ---------- Jurnal (doar proprietarul) ----------
const LOG_ACTIONS = [
  [/^\/annotations\/:id\/remove$/, "a scos o adnotare"],
  [/^\/annotations\/:id\/restore$/, "a repus o adnotare"],
  [/^\/chat\/:id\/remove$/, "a scos un mesaj din chat"],
  [/^\/chat\/:id\/restore$/, "a repus un mesaj din chat"],
  [/^\/users\/:id\/chat-block$/, "blocare în chat"],
  [/^\/users\/:id\/reset-name$/, "a resetat un nume"],
  [/^\/users\/:id\/set-name$/, "a dat un nume"],
  [/^\/users\/:id\/delete$/, "a șters un utilizator"],
  [/^\/users\/reset-password$/, "a resetat o parolă"],
  [/^\/tokens$/, "a creat un token"],
  [/^\/tokens\/:id\/revoke$/, "a retras un token"],
];
function logLabel(action) {
  return (LOG_ACTIONS.find(([re]) => re.test(action)) || [null, action])[1];
}

function renderLog(rows) {
  if (!rows.length) return $("#list").append(el("p", {}, "Nicio acțiune încă."));
  const table = el("table", { class: "log-table" },
    el("thead", {}, el("tr", {}, el("th", {}, "Când"), el("th", {}, "Cine"), el("th", {}, "Ce"), el("th", {}, "Asupra"), el("th", {}, "Detalii")))
  );
  const body = el("tbody");
  for (const r of rows) {
    let d = "";
    try {
      const o = JSON.parse(r.details || "{}");
      d = [o.reason && `motiv: ${o.reason}`, o.name && `nume: ${o.name}`, o.role && `rol: ${o.role}`, o.blocked !== undefined && (o.blocked ? "blocat" : "deblocat")].filter(Boolean).join(" · ");
    } catch {}
    body.append(el("tr", {}, el("td", {}, when(r.at)), el("td", {}, `${r.actor} (${ROLE_LABEL[r.role] || r.role})`), el("td", {}, logLabel(r.action)), el("td", {}, r.target ? String(r.target).slice(0, 8) : ""), el("td", {}, d)));
  }
  table.append(body);
  $("#list").append(table);
}

async function load() {
  $("#list").textContent = "";
  try {
    me = await api("/me");
    document.body.classList.toggle("is-owner", me.role === "owner");
    $("#whoami").textContent = `${me.name} · ${ROLE_LABEL[me.role]}`;
    if (me.role !== "owner" && (status === "mods" || status === "log")) status = "reported";
    const path = { users: "/users", chat: "/chat", mods: "/tokens", log: "/log" }[status] || `/queue?status=${status}`;
    const items = await api(path);
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
    if (status === "mods") return renderMods(items);
    if (status === "log") return renderLog(items);
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
