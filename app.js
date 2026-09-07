/* The case room, public shell. Talks only to Supabase Auth and the student API. */
(function () {
  const C = window.FB;
  const $ = (s) => document.querySelector(s);
  const store = {
    get: () => { try { return JSON.parse(sessionStorage.getItem("fb.session") || "null"); } catch { return null; } },
    set: (v) => { try { v ? sessionStorage.setItem("fb.session", JSON.stringify(v)) : sessionStorage.removeItem("fb.session"); } catch {} },
  };

  async function signIn(email, password) {
    const r = await fetch(`${C.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: C.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error("Those details were not recognised.");
    const j = await r.json();
    store.set({ token: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  }
  async function refresh() {
    const s = store.get(); if (!s) return null;
    if (Date.now() < s.exp) return s.token;
    const r = await fetch(`${C.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { apikey: C.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh }),
    });
    if (!r.ok) { store.set(null); return null; }
    const j = await r.json();
    store.set({ token: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    return j.access_token;
  }
  async function api(path, opts = {}) {
    const token = await refresh();
    if (!token) throw new Error("sign_in_required");
    const r = await fetch(`${C.API_BASE}${path}`, {
      ...opts, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { store.set(null); throw new Error("sign_in_required"); }
    if (!r.ok) throw Object.assign(new Error(j.message || j.error || `HTTP ${r.status}`), { code: j.error, status: r.status });
    return j;
  }

  function initials(name) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase(); }
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function renderPerson(p) {
    const cls = p.state === "in_progress" ? "live" : p.state === "completed" ? "spent" : "";
    const face = p.portrait_url ? `<img class="face" src="${esc(p.portrait_url)}" alt="">` : `<div class="face" aria-hidden="true">${esc(initials(p.name))}</div>`;
    const st = { not_started: "not yet interviewed", in_progress: "conversation running", completed: "conversation held" }[p.state] || p.state;
    return `<article class="person ${cls}">${face}<div><div class="nm">${esc(p.name)}</div><div class="rl">${esc(p.role || "")}</div><div class="br">${esc(p.brief || "")}</div><div class="st">${st}</div></div></article>`;
  }

  async function showCase() {
    const me = await api("/me");
    $("#who").textContent = me.group.code;
    $("#edition").textContent = me.edition.title || me.edition.code;
    $("#gate").hidden = me.questionnaire_locked;
    const roster = await api("/personas");
    $("#roster").innerHTML = roster.personas.length ? roster.personas.map(renderPerson).join("") : `<div class="empty"><span class="tag">no one available</span><p>No conversations are open in this edition yet.</p></div>`;
    $("#n-people").textContent = roster.personas.length;
    $("#n-held").textContent = roster.personas.filter((p) => p.state === "completed").length;
    $("#signin").hidden = true; $("#case").hidden = false; $("#nav").hidden = false;
  }
  function showSignIn(msg) {
    $("#case").hidden = true; $("#nav").hidden = true; $("#signin").hidden = false;
    $("#err").textContent = msg || "";
  }

  $("#form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = $("#go"); b.disabled = true; $("#err").textContent = "";
    try { await signIn($("#email").value.trim(), $("#password").value); await showCase(); }
    catch (err) { showSignIn(err.message === "sign_in_required" ? "Signed in, but this account is not an active group." : err.message); }
    finally { b.disabled = false; }
  });
  $("#out").addEventListener("click", () => { store.set(null); showSignIn(); });

  (async () => {
    if (store.get()) { try { await showCase(); return; } catch (e) { if (e.code === "no_active_group") { showSignIn("This group is not active."); return; } } }
    showSignIn();
  })();
})();
