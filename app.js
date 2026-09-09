/* The case room. Static; talks only to Supabase Auth and the student API.
   Nothing about time, caps or entitlement is computed here: every figure
   comes from the API, which reads it from the engine. */
(function () {
  const C = window.FB;
  const $ = (s, r = document) => r.querySelector(s);
  const view = $("#view");
  const S = { me: null, personas: null, docs: null, poll: null };

  // ── auth ────────────────────────────────────────────────────────────────
  const store = {
    get: () => { try { return JSON.parse(sessionStorage.getItem("fb.session") || "null"); } catch { return null; } },
    set: (v) => { try { v ? sessionStorage.setItem("fb.session", JSON.stringify(v)) : sessionStorage.removeItem("fb.session"); } catch {} },
  };
  async function tokenCall(body) {
    const grant = body.refresh_token ? "refresh_token" : "password";
    const r = await fetch(`${C.SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
      method: "POST", headers: { apikey: C.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(grant === "password" ? "Those details were not recognised." : "sign_in_required");
    const j = await r.json();
    store.set({ token: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    return j.access_token;
  }
  async function token() {
    const s = store.get(); if (!s) return null;
    if (Date.now() < s.exp) return s.token;
    try { return await tokenCall({ refresh_token: s.refresh }); } catch { store.set(null); return null; }
  }
  async function api(path, opts = {}) {
    const t = await token();
    if (!t) throw Object.assign(new Error("sign_in_required"), { code: "sign_in_required" });
    const r = await fetch(`${C.API_BASE}${path}`, { ...opts, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { store.set(null); throw Object.assign(new Error("sign_in_required"), { code: "sign_in_required" }); }
    if (!r.ok) throw Object.assign(new Error(j.message || j.error || `HTTP ${r.status}`), { code: j.error, status: r.status, body: j });
    return j;
  }
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

  // ── helpers ─────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const prose = (t) => String(t ?? "").split(/\n{2,}/).map((b) => {
    const x = b.trim();
    if (!x) return "";
    return /^##\s+/.test(x) ? `<h2>${esc(x.replace(/^##\s+/, ""))}</h2>` : `<p>${esc(x).replace(/\n/g, "<br>")}</p>`;
  }).join("");
  const paras = (t) => String(t ?? "").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  function render(id) { const t = document.getElementById(id); view.replaceChildren(t.content.cloneNode(true)); }
  function nav(key) {
    $("#nav").hidden = false;
    document.querySelectorAll("[data-nav]").forEach((a) => a.toggleAttribute("aria-current", a.dataset.nav === key));
  }
  function recording(name) { const r = $("#rec"); r.hidden = !name; $("#rec-name").textContent = name || ""; $("#nav").hidden = !!name; }
  // A record carries its name twice: the language it was filed in and the
  // language the team works in. Either may be absent, in which case the
  // authored title stands for both, and identical names are shown once.
  const nameSv = (d) => (d.title_sv || "").trim() || d.title || "";
  const nameEn = (d) => (d.title_en || "").trim() || d.title || "";
  const bothNames = (d) => { const a = nameSv(d), b = nameEn(d); return a === b ? [a] : [a, b]; };
  const titleHtml = (d) => bothNames(d).map((t, i) => `<div class="${i ? "ttl-alt" : "ttl"}">${esc(t)}</div>`).join("");

  async function ensureMe() { if (!S.me) S.me = await api("/me"); $("#who").textContent = S.me.group.code; $("#foot-edition").textContent = `${S.me.edition.title || S.me.edition.code} · ${S.me.group.code}`; return S.me; }
  async function personas(force) { if (force || !S.personas) S.personas = (await api("/personas")).personas; return S.personas; }
  async function documents(force) { if (force || !S.docs) S.docs = (await api("/documents")).documents; return S.docs; }
  function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }

  // ── screens ─────────────────────────────────────────────────────────────
  function signin(msg) {
    stopPoll(); recording(null); $("#nav").hidden = true;
    render("t-signin"); $("#err").textContent = msg || "";
    $("#form").addEventListener("submit", async (e) => {
      e.preventDefault(); const b = $("#go"); b.disabled = true; $("#err").textContent = "";
      try { await tokenCall({ email: $("#email").value.trim(), password: $("#password").value }); S.me = null; location.hash = "#/"; await route(); }
      catch (err) { $("#err").textContent = err.message; }
      finally { b.disabled = false; }
    });
  }

  async function landing() {
    const me = await ensureMe(); nav("landing"); render("t-landing");
    const open = me.edition.status === "open";
    let d = { page: { headline: null, standfirst: null, history: null, pack_note: null, videos: [] }, pack: [] };
    try { d = await api("/case"); } catch { /* the page is optional; the course still works without it */ }
    const p = d.page;
    $("#ld-label").textContent = me.edition.title || me.edition.code;
    $("#ld-headline").textContent = p.headline || me.edition.title || "The case";
    $("#ld-standfirst").textContent = p.standfirst || "Interview the people. Read the record. Advise the family.";
    if (!open) {
      $("#ld-status").hidden = false;
      $("#ld-status").innerHTML = me.edition.status === "closed" || me.edition.status === "archived"
        ? "<strong>This course is closed.</strong> No new conversation can start. Your transcripts stay here."
        : "<strong>This course has not opened yet.</strong> Your file and the interviews open when your instructor opens it.";
    }
    if (me.engagement_released) {
      $("#ld-released").hidden = false;
      $("#ld-released").innerHTML = "<strong>The engagement documents have been released.</strong> They are in your case file, under Engagement.";
    }
    $("#ld-films").innerHTML = p.videos.length
      ? `<div class="films">${p.videos.map((v) => `<figure class="film">${v.title ? `<div class="ttl">${esc(v.title)}</div>` : ""}<div class="embed"><iframe src="${esc(v.embed_url)}" title="${esc(v.title || "Film")}" allow="fullscreen; picture-in-picture" loading="lazy" referrerpolicy="strict-origin"></iframe></div>${v.caption ? `<figcaption class="cap">${esc(v.caption)}</figcaption>` : ""}</figure>`).join("")}</div>`
      : "";
    $("#ld-history").innerHTML = p.history ? prose(p.history) : "";
    const total = d.pack.reduce((a, x) => a + x.n, 0);
    if (total) {
      $("#ld-pack").hidden = false;
      $("#ld-packnote").textContent = p.pack_note || "What the family, its companies and the public registers would hand you on the first day.";
      $("#ld-packlist").innerHTML = d.pack.map((x) => `<li><span>${esc(x.folder || "Papers")}</span><span class="n">${x.n}</span></li>`).join("");
    }
    $("#ld-gate").hidden = !open || me.interviews_open;
    $("#ld-go").hidden = !(open && me.interviews_open);
  }

  async function people() {
    const me = await ensureMe(); nav("case"); render("t-case");
    $("#edition").textContent = me.edition.title || me.edition.code;
    $("#gate").hidden = me.interviews_open && me.edition.status === "open";
    const [ps, ds] = await Promise.all([personas(true), documents(true)]);
    $("#n-people").textContent = ps.length; $("#n-held").textContent = ps.filter((p) => p.state === "completed").length; $("#n-docs").textContent = ds.length;
    $("#roster").innerHTML = ps.length ? ps.map((p) => {
      const cls = p.state === "in_progress" ? "live" : p.state === "completed" ? "spent" : "";
      const face = p.portrait_url ? `<img class="face" src="${esc(p.portrait_url)}" alt="">` : `<div class="face" aria-hidden="true">${esc(initials(p.name))}</div>`;
      const shut = p.state === "not_started" && !me.interviews_open;
      const st = shut ? "not open yet" : ({ not_started: "not yet interviewed", in_progress: "conversation running", completed: "conversation held" }[p.state] || p.state);
      const href = p.state === "in_progress" ? `#/room/${p.session_id}` : p.state === "completed" ? `#/transcripts/${p.session_id}` : `#/interview/${p.code}`;
      const body = `${face}<div><div class="nm">${esc(p.name)}</div><div class="rl">${esc(p.role || "")}</div><div class="br">${esc(p.brief || "")}</div><div class="st">${st}</div></div>`;
      // Until the instructor opens the interviews a person is readable but not enterable.
      return shut ? `<div class="person shut">${body}</div>` : `<a class="person ${cls}" href="${href}">${body}</a>`;
    }).join("") : `<div class="empty"><span class="tag">no one available</span><p>No conversations are open in this edition yet.</p></div>`;
  }

  async function file() {
    const me = await ensureMe(); nav("file"); render("t-file");
    const ds = await documents(true);
    const stage = { brief: "Onboarding pack", engagement_only: "The engagement", discovery: "Released to your team", deep: "From the registry" };
    // How this team came by a document, in their own terms. Never why.
    const via = { trigger: "released after an interview", request: "you asked for it", instructor: "given by your instructor", event: "released to every team" };
    const groups = {};
    const keyOf = (d) => (d.release_stage === "brief" && d.folder ? `brief/${d.folder}` : d.release_stage);
    for (const d of ds) (groups[keyOf(d)] ||= []).push(d);
    const folders = Object.keys(groups).filter((k) => k.startsWith("brief/")).sort();
    const order = [...folders, ...["brief", "engagement_only", "discovery", "deep"].filter((k) => groups[k])];
    const labelOf = (k) => (k.startsWith("brief/") ? `${stage.brief} · ${k.slice(6)}` : stage[k] || k);
    $("#docs").innerHTML = ds.length ? `<div class="doclist">${order.map((k) => `<div class="grp label">${esc(labelOf(k))} · ${groups[k].length}</div>` + groups[k].sort((a, b) => (a.doc_year || 0) - (b.doc_year || 0)).map((d) =>
      `<a class="docrow" href="#/file/${esc(d.code)}"><span class="code">${esc(d.code)}</span><span>${titleHtml(d)}<div class="prov">${esc(d.holding_institution || "")}${d.doc_year ? " · " + d.doc_year : ""}</div></span><span class="prov">${esc(d.record_class || "")}${d.granted_via && via[d.granted_via] ? `<div class="via">${esc(via[d.granted_via])}</div>` : ""}</span><span class="st ${d.first_opened ? "" : "new"}">${d.first_opened ? `opened ${d.opens}×` : "not yet opened"}</span></a>`).join("")).join("")}</div>`
      : me.edition.status === "open"
        ? `<div class="empty"><span class="tag">nothing yet</span><p>Your onboarding pack is not in place yet. Ask your instructor.</p></div>`
        : `<div class="empty"><span class="tag">not open yet</span><p>Your file opens when your instructor opens the course.</p></div>`;
    let deskList = [];
    try { deskList = (await api("/desks")).desks; } catch { /* the desks are optional */ }
    const registry = deskList.find((d) => d.desk_kind === "registry");
    if (registry) {
      $("#reg-aside").innerHTML = `<p class="label">Ask for a record</p>
        <div class="prose"><p><strong>${esc(registry.name)}</strong> keeps the archive. Ask by name and, if it is there, it goes into this file. The desk remembers what you asked.</p></div>
        <p><a class="btn quiet" href="#/desk/${esc(registry.code)}">Go to the desk</a></p>`;
      return;
    }
    $("#reg-form").addEventListener("submit", async (e) => {
      e.preventDefault(); const b = $("#reg-go"); b.disabled = true;
      try {
        const r = await post("/registry/request", { text: $("#reg-text").value });
        const say = {
          granted: `<p>I have found it. <strong>${esc(bothNames(r).join(" / "))}</strong> is now in your file under ${esc(r.code)}.</p>`,
          already: `<p>That one is already in your file: <strong>${esc(bothNames(r).join(" / "))}</strong>, ${esc(r.code)}.</p>`,
          ambiguous: `<p>That could be more than one record. Give me a year, a party to it, or who would have kept it, and I will look again.</p>`,
          not_found: `<p>I have nothing under that description. If you believe the record exists, tell me who would have produced it and roughly when.</p>`,
        }[r.outcome] || `<p>${esc(r.outcome)}</p>`;
        $("#reg-reply").innerHTML = `<p class="label">The registry replies</p>${say}`;
        if (r.outcome === "granted") await file();
      } catch (err) { $("#reg-reply").innerHTML = `<p>${esc(err.message)}</p>`; }
      finally { b.disabled = false; }
    });
  }

  async function doc(code) {
    await ensureMe(); nav("file"); render("t-doc");
    const ds = await documents(); const meta = ds.find((d) => d.code === code);
    if (!meta) { view.innerHTML = `<div class="empty"><span class="tag">not in your file</span><p>The registry has no such record released to your team.</p><p><a href="#/file">Back to the file</a></p></div>`; return; }
    $("#d-meta").textContent = `${meta.code} · ${meta.holding_institution || ""}${meta.doc_year ? " · " + meta.doc_year : ""}`;
    $("#d-title").innerHTML = bothNames(meta).map((t, i) => (i ? `<span class="alt">${esc(t)}</span>` : esc(t))).join("");
    // Opening the reading view is the open that counts: it records the disclosure key.
    let signed = null;
    try { signed = await post(`/documents/${encodeURIComponent(code)}/open`); } catch {}
    async function load(lang) {
      document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
      const t = await api(`/documents/${encodeURIComponent(code)}/text?lang=${lang}`);
      $("#d-text").textContent = t.text || "(no text in this language)";
    }
    document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => load(b.dataset.lang)));
    await load("en");
    $("#d-fac").addEventListener("click", async () => {
      const b = $("#d-fac"); b.disabled = true; b.textContent = "Rendering…";
      try {
        const s = signed || (await post(`/documents/${encodeURIComponent(code)}/open`));
        const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
        const pdf = await pdfjs.getDocument({ url: s.url }).promise;
        const box = $("#d-pages"); box.replaceChildren(); box.hidden = false;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 1.4 });
          const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height; box.appendChild(cv);
          await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        }
        b.textContent = "Facsimile shown above";
      } catch (e) {
        // If in-page rendering is not possible, the signed URL still opens for the minute it is valid.
        try { const s = signed || (await post(`/documents/${encodeURIComponent(code)}/open`)); window.open(s.url, "_blank", "noopener"); b.textContent = "Opened in a new tab"; }
        catch { b.textContent = "Facsimile unavailable"; }
      }
    });
  }

  async function confirm_(code) {
    await ensureMe(); nav("case"); render("t-confirm");
    const p = (await personas()).find((x) => x.code === code);
    if (!p) { location.hash = "#/people"; return; }
    $("#c-name").textContent = p.name; $("#c-brief").textContent = p.brief || "";
    $("#c-virtual").textContent = p.budget.virtual_minutes ?? "–"; $("#c-wall").textContent = p.budget.wall_minutes ?? "–";
    $("#c-go").addEventListener("click", async () => {
      const b = $("#c-go"); b.disabled = true;
      try {
        const r = await post("/sessions", { persona_code: code }); S.personas = null;
        try { if (r.opening_line) sessionStorage.setItem(`fb.opening.${r.session_id}`, r.opening_line); } catch {}
        location.hash = `#/room/${r.session_id}`;
      }
      catch (err) { $("#c-err").textContent = err.message; b.disabled = false; }
    });
  }

  function ring(id, frac) {
    const el = $(id); const r = Number(el.getAttribute("r")); const c = 2 * Math.PI * r;
    el.setAttribute("stroke-dasharray", c.toFixed(1)); el.setAttribute("stroke-dashoffset", (c * (1 - Math.max(0, Math.min(1, frac)))).toFixed(1));
  }
  function showState(st, name, wallTotal) {
    const note = $("#k-note"); if (!note) return;
    if (!st.allowed) {
      $("#k-virt").textContent = "–"; $("#k-wall").textContent = "–"; ring("#ring-virt", 0); ring("#ring-wall", 0);
      note.textContent = st.message || "The conversation has ended.";
      $("#send").disabled = true; $("#question").disabled = true; $("#cap").textContent = "–"; return;
    }
    const vl = st.virtual_left, vt = st.virtual_total, wl = st.wall_left_min;
    $("#k-virt").textContent = vl == null ? "–" : `${Math.max(0, vl).toFixed(0)} min`;
    $("#k-wall").textContent = wl == null ? "–" : `${wl} min`;
    ring("#ring-virt", vt ? Math.min(vl, vt) / vt : 0); ring("#ring-wall", wallTotal && wl != null ? wl / wallTotal : 0);
    $("#cap").textContent = st.input_char_cap ?? "–";
    if (st.in_grace) note.textContent = `${name} is glancing at the clock.`;
    else if (vl != null && vl <= 10) note.textContent = `You have about ${Math.max(1, Math.round(vl))} minutes of ${name}'s time left.`;
    else if (wl != null && wl <= 10) note.textContent = `Your window closes in ${wl} minutes. This deadline is real.`;
    else note.textContent = "";
  }
  function addTurn(box, speaker, text) {
    const d = document.createElement("div"); d.className = `turn ${speaker === "you" ? "q" : speaker === "sys" ? "sys" : ""}`;
    d.innerHTML = `<div class="sp">${esc(speaker)}</div><div>${esc(text)}</div>`; box.appendChild(d); d.scrollIntoView({ block: "nearest" });
  }

  async function room(id) {
    await ensureMe(); render("t-room");
    const ps = await personas();
    let st = await api(`/sessions/${id}/state`);
    const p = ps.find((x) => x.session_id === Number(id)) || ps.find((x) => x.code === st.persona_code) || { name: st.persona_code, budget: {} };
    if (st.session_state !== "open") { location.hash = `#/transcripts/${id}`; return; }
    recording(p.name); $("#r-name").textContent = p.name; $("#r-label").textContent = p.role || "";
    const box = $("#turns");
    // The opening line is the only earlier turn the room shows. There is no live transcript: a reload mid-conversation shows what you have heard only from your notes.
    let opening = null; try { opening = sessionStorage.getItem(`fb.opening.${id}`); } catch {}
    if (opening) addTurn(box, p.name, opening);
    addTurn(box, "sys", "The conversation is running. There is no live transcript: take notes. It arrives when the conversation ends.");
    const wallTotal = p.budget.wall_minutes || null;
    showState(st.state, p.name, wallTotal);
    const ds = await documents(); const sel = $("#exhibit");
    for (const d of ds) { const o = document.createElement("option"); o.value = d.code; o.textContent = `${d.code} · ${bothNames(d).join(" / ")}`.slice(0, 110); sel.appendChild(o); }
    sel.addEventListener("change", async () => {
      const code = sel.value; if (!code) return; sel.disabled = true;
      try { await post(`/sessions/${id}/exhibit`, { document_code: code }); addTurn(box, "you", `(You place ${code} on the table.)`); }
      catch (err) { $("#r-err").textContent = err.message; }
      finally { sel.value = ""; sel.disabled = false; }
    });
    const q = $("#question"), cnt = $("#count");
    q.addEventListener("input", () => { cnt.textContent = q.value.length; const cap = Number($("#cap").textContent); cnt.parentElement.classList.toggle("over", cap && q.value.length > cap); });
    let lastAnswerAt = Date.now();
    $("#ask").addEventListener("submit", async (e) => {
      e.preventDefault(); const text = q.value.trim(); if (!text) return;
      const cap = Number($("#cap").textContent); if (cap && text.length > cap) { $("#r-err").textContent = `Keep it under ${cap} characters.`; return; }
      const b = $("#send"); b.disabled = true; $("#r-err").textContent = "";
      addTurn(box, "you", text); q.value = ""; cnt.textContent = "0";
      const silence = Math.min(600, Math.round((Date.now() - lastAnswerAt) / 1000));
      try {
        const r = await post(`/sessions/${id}/ask`, { question: text, silence_seconds: silence });
        if (r.kind === "answer") addTurn(box, p.name, r.answer);
        else addTurn(box, "sys", r.message);
        showState(r.state, p.name, wallTotal); lastAnswerAt = Date.now();
        if (r.kind === "closed" || (r.state && !r.state.allowed && String(r.state.reason || "").startsWith("session_"))) setTimeout(() => { location.hash = `#/transcripts/${id}`; }, 1500);
      } catch (err) { $("#r-err").textContent = err.message; }
      finally { b.disabled = !st.state.allowed ? true : false; q.focus(); }
    });
    $("#end").addEventListener("click", async () => {
      if (!confirm("End the conversation? It does not reopen. The transcript is released when it ends.")) return;
      try { await post(`/sessions/${id}/close`); S.personas = null; location.hash = `#/transcripts/${id}`; } catch (err) { $("#r-err").textContent = err.message; }
    });
    stopPoll();
    S.poll = setInterval(async () => {
      try { st = await api(`/sessions/${id}/state`); showState(st.state, p.name, wallTotal); if (st.session_state !== "open") { stopPoll(); S.personas = null; location.hash = `#/transcripts/${id}`; } }
      catch {}
    }, 30000);
  }

  async function transcripts() {
    await ensureMe(); nav("transcripts"); render("t-transcripts");
    const ss = (await api("/sessions")).sessions.filter((s) => s.state !== "open");
    $("#tr-list").innerHTML = ss.length ? `<div class="doclist">${ss.map((s) => `<a class="docrow" href="#/transcripts/${s.id}"><span class="code">${esc(s.closed_at ? s.closed_at.slice(0, 16).replace("T", " ") : "")}</span><span><div class="ttl">${esc(s.name)}</div><div class="prov">${s.turn_count} turns · ${(s.virtual_seconds / 60).toFixed(0)} minutes of their time</div></span><span></span><span class="st">${esc(s.state.replace("_", " "))}</span></a>`).join("")}</div>`
      : `<div class="empty"><span class="tag">none yet</span><p>A transcript appears here when a conversation ends.</p></div>`;
  }
  async function transcript(id) {
    await ensureMe(); nav("transcripts"); render("t-transcript"); recording(null);
    let t;
    try { t = await api(`/sessions/${id}/transcript`); }
    catch (err) { view.innerHTML = `<div class="empty"><span class="tag">${err.code === "session_open" ? "still running" : "not available"}</span><p>${esc(err.message)}</p><p><a href="#/transcripts">All transcripts</a></p></div>`; return; }
    $("#t-name").textContent = t.name; $("#t-meta").textContent = `${t.session.state.replace("_", " ")} · ${t.session.turn_count} turns · ${(t.session.virtual_seconds / 60).toFixed(0)} minutes`;
    const box = $("#t-turns");
    for (const tr of t.turns) addTurn(box, tr.speaker === "interviewer" ? "you" : tr.speaker === "persona" ? t.name : "sys", tr.text);
    $("#t-dl").addEventListener("click", () => {
      const txt = t.turns.map((tr) => `${tr.speaker === "interviewer" ? "You" : t.name}: ${tr.text}`).join("\n\n");
      const safe = String(t.name || "interview").replace(/[^A-Za-z0-9À-ÿ]+/g, "-").replace(/^-|-$/g, "");
      const head = `${t.name} — interviewed by ${S.me.group.code}\n${t.session.turn_count} turns · ${(t.session.virtual_seconds / 60).toFixed(0)} minutes\n\n`;
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([head + txt], { type: "text/plain" })); a.download = `${safe}-${id}.txt`; a.click();
    });
  }
  async function desks() {
    await ensureMe(); nav("desk"); render("t-desks");
    const ds = (await api("/desks")).desks;
    if (ds.length === 1) { location.hash = `#/desk/${ds[0].code}`; return; }
    $("#desk-list").innerHTML = ds.length ? ds.map((d) => {
      const items = d.sources.reduce((a, s) => a + (s.item_count || 0), 0);
      const cap = d.questions_total || d.turn_cap;
      const what = d.desk_kind === "registry"
        ? "asks the archive for a record and hands it over"
        : `${d.sources.length} source${d.sources.length === 1 ? "" : "s"}${items ? ` · ${items.toLocaleString()} items` : ""}`;
      return `<a class="desk-card" href="#/desk/${esc(d.code)}"><div class="nm">${esc(d.name)}</div>${d.subtitle ? `<div class="sub">${esc(d.subtitle)}</div>` : ""}<div class="meta">${esc(what)}${cap ? ` · ${Math.max(0, cap - d.asked)} of ${cap} questions left` : ""}</div></a>`;
    }).join("") : `<div class="empty"><span class="tag">not open yet</span><p>No desk is open in this course.</p></div>`;
  }

  async function deskPage(code) {
    await ensureMe(); nav("desk"); render("t-desk");
    let d;
    try { d = await api(`/desks/${encodeURIComponent(code)}`); }
    catch (err) { view.innerHTML = `<div class="empty"><span class="tag">no such desk</span><p>${esc(err.message)}</p><p><a href="#/desk">The desks</a></p></div>`; return; }
    const desk = d.desk;
    $("#dk-label").textContent = desk.subtitle || "The literature";
    $("#dk-name").textContent = desk.name;
    const registry = desk.desk_kind === "registry";
    $("#dk-brief").textContent = desk.brief || (registry
      ? "Ask for a record by name. If the archive holds it, it goes into your case file."
      : "Ask about the literature. The desk answers from what it reads, and cites it.");
    $("#dk-q").placeholder = registry
      ? "e.g. the will of the founder, or the articles of association from the year the holding company was formed"
      : "Ask about the literature, not about the family";
    $("#dk-go").textContent = registry ? "Ask for it" : "Ask the desk";
    $("#dk-srclabel").textContent = registry ? "What this desk holds" : "What this desk reads";
    $("#dk-note").textContent = registry
      ? "The archive is large and most of it is not listed. Name a year, a party to it, or who would have kept it."
      : "Answers cite what they used. Follow the citation and read the source before you rely on it.";
    $("#dk-sources").innerHTML = registry
      ? `<li><span class="prov">The case archive. Ask for one record at a time.</span></li>`
      : desk.sources.length
        ? desk.sources.map((s) => `<li><span>${esc(s.label)}</span><span class="n">${s.item_count ? s.item_count.toLocaleString() : ""}</span></li>`).join("")
        : `<li><span class="prov">This desk has no sources switched on.</span></li>`;

    const box = $("#dk-thread");
    const draw = (turns) => {
      box.innerHTML = "";
      if (!turns.length) box.innerHTML = `<div class="empty"><span class="tag">nothing asked yet</span><p>Ask your first question. The desk answers in a few sentences and tells you what it read.</p></div>`;
      for (const t of turns) addDeskTurn(box, desk.name, t);
    };
    draw(d.turns);
    const left = (state, asked) => {
      const cap = desk.questions_total || desk.turn_cap;
      const n = cap ? Math.max(0, cap - asked) : null;
      $("#dk-left").textContent = n === null ? "" : n === 0 ? "no questions left" : `${n} question${n === 1 ? "" : "s"} left`;
      $("#dk-go").disabled = n === 0 || (state && state.allowed === false);
    };
    let asked = d.turns.filter((t) => t.speaker === "interviewer").length;
    left(d.state, asked);

    $("#dk-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = $("#dk-go"), q = $("#dk-q").value.trim();
      if (!q) return;
      b.disabled = true; $("#dk-err").textContent = "";
      addDeskTurn(box, desk.name, { speaker: "interviewer", text: q, citations: [] });
      const waiting = document.createElement("div");
      waiting.className = "turn sys"; waiting.textContent = "reading…"; box.appendChild(waiting);
      try {
        const r = await post(`/desks/${encodeURIComponent(code)}/ask`, { question: q });
        waiting.remove(); $("#dk-q").value = "";
        addDeskTurn(box, desk.name, { speaker: "persona", text: r.text, citations: r.citations });
        if (r.granted) S.docs = null;
        asked += 1; left(r.state, asked);
      } catch (err) {
        waiting.remove();
        $("#dk-err").textContent = err.body && err.body.message ? err.body.message : err.message;
        left(err.body && err.body.state, asked);
      } finally { if (!$("#dk-go").disabled) b.disabled = false; }
      box.scrollIntoView({ block: "end", behavior: "smooth" });
    });
  }

  function addDeskTurn(box, name, t) {
    const d = document.createElement("div");
    d.className = `turn ${t.speaker === "interviewer" ? "q" : ""}`;
    const who = t.speaker === "interviewer" ? "You" : name;
    const cites = (t.citations || []).length
      ? `<ul class="cites">${t.citations.map((c) => {
          if (c.source_key === "registry") {
            const code = c.item_id || "";
            return `<li><span class="pos">▸</span><span><a href="#/file/${esc(code)}">${esc(c.title)}</a> <span class="prov">now in your case file${code ? ` · ${esc(code)}` : ""}</span></span></li>`;
          }
          return `<li><span class="pos">[${c.position}]</span><span>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.reference)}</a>` : esc(c.reference)}</span></li>`;
        }).join("")}</ul>`
      : "";
    d.innerHTML = `<div class="sp">${esc(who)}</div>${paras(t.text)}${cites}`;
    box.appendChild(d);
  }

  // ── router ──────────────────────────────────────────────────────────────
  async function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [a, b] = h.split("/");
    if (!store.get()) return signin();
    if (a !== "room") { stopPoll(); recording(null); }
    try {
      if (!a) return await landing();
      if (a === "people") return await people();
      if (a === "file") return b ? await doc(decodeURIComponent(b)) : await file();
      if (a === "interview" && b) return await confirm_(b);
      if (a === "room" && b) return await room(b);
      if (a === "transcripts") return b ? await transcript(b) : await transcripts();
      if (a === "desk") return b ? await deskPage(decodeURIComponent(b)) : await desks();
      location.hash = "#/";
    } catch (err) {
      if (err.code === "sign_in_required") return signin();
      if (err.code === "no_active_group") return signin("This group is not active.");
      view.innerHTML = `<div class="empty"><span class="tag">something went wrong</span><p>${esc(err.message)}</p><p><a href="#/">Back to the case</a></p></div>`;
    }
  }
  window.addEventListener("hashchange", route);
  $("#out").addEventListener("click", () => { store.set(null); S.me = S.personas = S.docs = null; location.hash = "#/"; signin(); });
  route();
})();
