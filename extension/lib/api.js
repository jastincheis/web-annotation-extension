// Client subțire pentru API-ul backend-ului Adormis.
(function () {
  async function base() {
    return window.WA_Storage.getServerUrl();
  }

  async function listAnnotations(url) {
    const b = await base();
    const res = await fetch(`${b}/api/annotations?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`Fetch eșuat (${res.status})`);
    return res.json();
  }

  // Top global — cele mai votate adnotări de pe TOATE paginile, nu doar cea curentă.
  async function listTopGlobal(limit = 10) {
    const b = await base();
    const res = await fetch(`${b}/api/annotations/top?limit=${limit}`);
    if (!res.ok) throw new Error(`Fetch top eșuat (${res.status})`);
    return res.json();
  }

  async function createAnnotation({ url, type, data, authorId }) {
    const b = await base();
    const res = await fetch(`${b}/api/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, type, data, authorId }),
    });
    if (!res.ok) throw new Error(`Creare eșuată (${res.status})`);
    return res.json();
  }

  // patch = câmpuri de suprascris în data (ex. {x,y} la mutare, {text} la editare, {url,label} la link)
  async function updateAnnotation(id, authorId, patch) {
    const b = await base();
    const res = await fetch(`${b}/api/annotations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorId, patch }),
    });
    if (!res.ok) throw new Error(`Editare eșuată (${res.status})`);
    return res.json();
  }

  async function vote(id, voterId, direction) {
    const b = await base();
    const res = await fetch(`${b}/api/annotations/${id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voterId, direction }),
    });
    if (!res.ok) throw new Error(`Vot eșuat (${res.status})`);
    return res.json();
  }

  async function report(id, reporterId) {
    const b = await base();
    const res = await fetch(`${b}/api/annotations/${id}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reporterId }),
    });
    if (!res.ok) throw new Error(`Raportare eșuată (${res.status})`);
    return res.json();
  }

  async function remove(id, authorId) {
    const b = await base();
    const res = await fetch(`${b}/api/annotations/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorId }),
    });
    return res.ok;
  }

  window.WA_Api = { listAnnotations, listTopGlobal, createAnnotation, updateAnnotation, vote, report, remove };
})();
