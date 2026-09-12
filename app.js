/* The case room. Static; talks only to Supabase Auth and the student API.
   Nothing about time, caps or entitlement is computed here: every figure
   comes from the API, which reads it from the engine. */
(function () {
  const C = window.FB;
  const $ = (s, r = document) => r.querySelector(s);
  const view = $("#view");
  const S = { me: null, personas: null, interviews: null, docs: null, poll: null, voice: null };

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
  // Swedish names carry å ä ö and a team types what its keyboard has. Folding
  // both sides of a comparison to unaccented lower case keeps a search honest.
  const fold = (s) => String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  // An HTML textarea submits its value with CRLF line breaks — the spec says
  // so — which means every paragraph break in text typed into the console
  // arrives as \r\n\r\n. A splitter looking for two consecutive \n then finds
  // none, and a five-thousand-word history renders as one paragraph with its
  // ## headings sitting inline as literal text. So the line endings are
  // normalised before anything looks at them.
  const lines = (t) => String(t ?? "").replace(/\r\n?/g, "\n");
  const prose = (t) => lines(t).split(/\n{2,}/).map((b) => {
    const x = b.trim();
    if (!x) return "";
    return /^##\s+/.test(x) ? `<h2>${esc(x.replace(/^##\s+/, ""))}</h2>` : `<p>${esc(x).replace(/\n/g, "<br>")}</p>`;
  }).join("");
  const paras = (t) => lines(t).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
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
  // The name of a record, and there is one: the English one. The advisers work
  // in English, and a record named twice on one line is a record you have to
  // parse before you can look for it. The filed name is not lost — it is what
  // is printed on the paper, it stays searchable, and it stays on the record's
  // own page — but it is not the name of the thing.
  const docName = (d) => nameEn(d);
  // Both names, for searching only: a student who reads the name off the
  // facsimile is typing Swedish, and that has to find the record.
  const bothNames = (d) => { const a = nameSv(d), b = nameEn(d); return a === b ? [a] : [a, b]; };
  const titleHtml = (d) => `<div class="ttl">${esc(docName(d))}</div>`;

  // /me carries the two gates — whether the course is open and whether the
  // interviews are — and both move while a team is sitting in front of the
  // page. Caching it for the life of the tab meant an instructor could open
  // the interviews and the students would go on being told they were shut
  // until somebody thought to reload. It is one row; re-read it.
  const ME_TTL = 15000;
  async function ensureMe(force) {
    if (force || !S.me || Date.now() - (S.meAt || 0) > ME_TTL) { S.me = await api("/me"); S.meAt = Date.now(); }
    $("#who").textContent = S.me.group.code;
    $("#foot-edition").textContent = `${S.me.edition.title || S.me.edition.code} · ${S.me.group.code}`;
    return S.me;
  }

  /**
   * A gate is a switch someone else throws while you wait. Watch it rather than
   * asking the team to reload: when it moves, the page redraws itself. The
   * watcher only runs while a gate is actually shut, and stops on the way out.
   */
  function stopGate() { if (S.gate) { clearInterval(S.gate); S.gate = null; } }
  function watchGate(shut, redraw) {
    stopGate();
    if (!shut(S.me)) return;
    S.gate = setInterval(async () => {
      let me;
      try { me = await ensureMe(true); } catch { return; }
      if (!shut(me)) { stopGate(); redraw(); }
    }, 10000);
  }
  // The roster and, with it, whatever the engine says about this team's
  // interviews: which way the course is choosing, and how many conversations
  // are left when the team is the one choosing. Both arrive from the same
  // response, so the cards and the counter can never be a request apart.
  async function personas(force) {
    if (force || !S.personas) {
      const r = await api("/personas");
      S.personas = r.personas; S.interviews = r.interviews || null;
    }
    return S.personas;
  }
  /**
   * What the engine says about the team's own budget. Never computed here.
   *
   * Since migration 024 the budget belongs to the course rather than to the
   * selection mode: a curated course can cap the interviews too — the list,
   * eight of it — so the presence of a budget is what matters, not the mode.
   */
  function budgetState() {
    const iv = S.interviews;
    if (!iv || iv.budget == null) return null;
    return { budget: iv.budget, held: iv.held || 0, pending: iv.pending || 0,
             left: iv.left == null ? null : iv.left, choosing: iv.selection === "open" };
  }
  async function documents(force) { if (force || !S.docs) S.docs = (await api("/documents")).documents; return S.docs; }
  function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }


  // ── dictation ───────────────────────────────────────────────────────────
  /**
   * The microphone beside a composer. Browser-native recognition (Web Speech
   * API): the transcript lands in the box, the student reads it and presses
   * Enter. No audio reaches the platform and none is stored — Chrome sends it
   * to Google and Safari to Apple, which is the one sentence the course privacy
   * notice has to carry, and which the notice line says out loud.
   *
   * Switched on per course run by the instructor (fbcourse migration 035). The
   * button stays hidden until `me.edition.voice_input_enabled` says otherwise.
   *
   * Two behaviours that look like bugs and are not:
   *
   *  - Chrome ends the session on a silence even with `continuous = true`, so
   *    `onend` restarts it. `manualStop` is what stops that turning the
   *    student's click into an instant restart.
   *  - Interim text is NOT written into the textarea. It shows in the notice
   *    line instead: written into the box it flickers and fights whatever the
   *    student has already typed.
   *
   * Accuracy on Swedish surnames is poor and there is no vocabulary hint in the
   * API. That is the argument for the transcript landing in an editable box
   * rather than going to the persona, and if it becomes a real irritation in
   * class it is the signal to move to server-side recognition that accepts a
   * prompt — this flag and this admin toggle would not change.
   */
  const VOICE = {
    idle: "Please speak in English. Chrome, Edge and Safari can listen; Firefox cannot.",
    listening: "Speak in English. Say \u201ccomma\u201d, \u201cfull stop\u201d or \u201cquestion mark\u201d where you want one — nothing is punctuated for you. Read it back before you send.",
    unsupported: "This browser cannot listen. Chrome, Edge and Safari can; Firefox does not support it. Type your question instead.",
    blocked: "Microphone blocked. Allow it in the address bar, then try again.",
    network: "The speech service could not be reached. Type your question instead.",
    failed: "Dictation stopped unexpectedly. Type your question instead.",
  };
  function attachVoice(button, textarea, notice) {
    if (!button || !textarea) return null;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supported = !!Ctor;
    let rec = null, listening = false, manualStop = false;

    const say = (text, tone) => {
      if (!notice) return;
      notice.hidden = !text;
      notice.textContent = text || "";
      notice.className = `micnote${tone ? " " + tone : ""}`;
    };
    const paint = () => {
      button.setAttribute("aria-pressed", String(listening));
      button.classList.toggle("on", listening);
      button.classList.toggle("off", !supported);
      button.title = !supported ? "Dictation needs Chrome, Edge or Safari"
        : listening ? "Stop dictating" : "Dictate your question";
      const label = button.querySelector("span");
      if (label) label.textContent = listening ? "Talk" : "Dictate";
    };
    // ── punctuation ───────────────────────────────────────────────────────
    //
    // The recogniser supplies none. It returns unpunctuated, uncapitalised
    // text and finalises a phrase the moment it hears a breath, so a spoken
    // question arrives in pieces with nothing between them.
    //
    // A first version guessed the sentence ends from those pauses. It guessed
    // wrong on real speech: a student who stops to think gets a full stop
    // inside their own clause and a capital on the fragment after it, which
    // reads as a transcription error and costs more than the missing marks
    // ever did. Nothing is invented here now. A phrase is appended as heard;
    // punctuation appears only where the student says it aloud, and a capital
    // only where a sentence demonstrably starts — the top of an empty box, or
    // after a mark they put there themselves.
    //
    // Said aloud, these become marks. Whole words only — a sentence about a
    // comma is rarer than a student wanting one, but "commander" must survive.
    const SPOKEN = [
      [/\b(full stop|period)\b/gi, "."], [/\bcomma\b/gi, ","],
      [/\bquestion mark\b/gi, "?"], [/\bexclamation (mark|point)\b/gi, "!"],
      [/\b(colon)\b/gi, ":"], [/\bsemicolon\b/gi, ";"],
      [/\b(new line|new paragraph)\b/gi, "\n"], [/\bdash\b/gi, " — "],
    ];
    const marks = (t) => SPOKEN.reduce((x, [re, ch]) => x.replace(re, ch), t)
      // A mark arrives as its own word, so it lands with a space before it.
      .replace(/\s+([.,?!:;])/g, "$1").replace(/\s*\n\s*/g, "\n").replace(/ {2,}/g, " ").trim();

    const append = (text) => {
      let clean = marks(text);
      if (!clean) return;
      const base = textarea.value || "";
      // A capital only where a sentence really begins: the top of the box, or
      // after a mark the student dictated. Never in the middle of their words.
      if (!base.trim() || /[.?!\n]\s*$/.test(base)) clean = clean.charAt(0).toUpperCase() + clean.slice(1);
      const joiner = base && !/[\s\n]$/.test(base) ? " " : "";
      textarea.value = base + joiner + clean;
      // The counter, the autosize and the send button all listen for this.
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };

    function start() {
      if (!supported) return;
      const r = new Ctor();
      r.lang = "en-US"; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      r.onresult = (ev) => {
        let pending = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) append(res[0].transcript); else pending += res[0].transcript;
        }
        say(pending || VOICE.listening, pending ? "interim" : "live");
      };
      r.onerror = (ev) => {
        if (ev.error === "aborted" || ev.error === "no-speech") return;
        manualStop = true; listening = false; rec = null;
        say(ev.error === "not-allowed" || ev.error === "service-not-allowed" ? VOICE.blocked
          : ev.error === "network" ? VOICE.network : VOICE.failed, "bad");
        paint();
      };
      r.onend = () => {
        if (manualStop) { listening = false; rec = null; say(VOICE.idle); paint(); return; }
        try { r.start(); } catch { listening = false; rec = null; paint(); }
      };
      manualStop = false;
      try { r.start(); rec = r; listening = true; say(VOICE.listening, "live"); }
      catch { say(VOICE.failed, "bad"); }
      paint();
    }
    function stop() {
      manualStop = true;
      if (rec) { try { rec.stop(); } catch {} }
      listening = false; say(VOICE.idle); paint();
    }
    const onClick = () => {
      if (!supported) { say(VOICE.unsupported, "bad"); return; }
      listening ? stop() : start();
    };
    button.addEventListener("click", onClick);
    button.hidden = false;
    say(VOICE.idle);
    paint();
    return { destroy() {
      button.removeEventListener("click", onClick);
      manualStop = true;
      if (rec) { try { rec.abort(); } catch {} }
      rec = null; listening = false; say(null);
    } };
  }
  /** Wire the microphone for one composer, if this course run allows it. */
  function voiceFor(me, buttonId, textareaId, noticeId) {
    stopVoice();
    if (!me?.edition?.voice_input_enabled) return;
    S.voice = attachVoice($(`#${buttonId}`), $(`#${textareaId}`), $(`#${noticeId}`));
  }
  function stopVoice() { if (S.voice) { S.voice.destroy(); S.voice = null; } }

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
    const gate = interviewGate(me);
    $("#ld-gate").hidden = !open || !gate;
    if (open && gate) $("#ld-gate").innerHTML = `<span class="tag">${esc(gate.tag)}</span><p>${esc(gate.text)}</p>`;
    $("#ld-go").hidden = !!gate;
    watchGate((m) => !!interviewGate(m), landing);
  }

  // The people. A portrait first, because a team chooses whom to spend an hour
  // with by looking at them, and then the few facts that place a person in the
  // family: how old they are, which branch they belong to, which generation.
  // The course-level gate. Everything a team can do — the desks, the archive,
  // an interview — is behind course_editions.status = 'open'. Until an
  // instructor opens the course, say so plainly instead of letting a team
  // write a question and refusing it on submit.
  function courseGate(me) {
    if (me.edition.status === "open") return null;
    return me.edition.status === "closed"
      ? "This course has closed. You can still read your case file and your transcripts."
      : "This course has not opened yet. Your instructor opens it when the engagement begins.";
  }
  function gateBanner(text) {
    return `<div class="empty"><span class="tag">not open yet</span><p>${esc(text)}</p></div>`;
  }

  const faceHtml = (name, url) => (url
    ? `<img class="portrait" src="${esc(url)}" alt="${esc(name)}">`
    : `<div class="portrait none" aria-hidden="true">${esc(initials(name))}</div>`);

  const groupOf = (p) => (p.generation ? `gen:${p.generation}` : "independent");

  /**
   * Why a team cannot start a conversation, if it cannot. The course has to be
   * open and the interviews have to be switched on, and these are two different
   * controls: a banner that names the wrong one sends everybody to the wrong
   * place. Null when nothing is in the way.
   */
  function interviewGate(me) {
    const g = courseGate(me);
    if (g) return { tag: "course not open", text: g };
    if (!me.interviews_open) {
      return { tag: "not yet", text: "The course is open, but your instructor has not started the interviews. You can read the people and their CVs in the meantime — this page opens itself when the interviews begin." };
    }
    return null;
  }

  /**
   * Who you are speaking with, in the card the roster already uses: the
   * portrait, the name, the facts that place them, what they are, and the
   * state of this conversation. An interview and both desks share it.
   */
  /**
   * Enter sends. A textarea takes Enter as a newline, which is right for
   * writing and wrong for asking — a team types a question and reaches for the
   * mouse. So the two are swapped: Enter sends, Shift+Enter (and Ctrl/Cmd
   * +Enter) breaks the line for anyone who wants a paragraph. Composing in
   * another script goes through an IME whose own Enter confirms a candidate,
   * so a keystroke mid-composition is left alone.
   */
  function sendOnEnter(el, formSel) {
    let composing = false;
    el.addEventListener("compositionstart", () => { composing = true; });
    el.addEventListener("compositionend", () => { composing = false; });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (composing || e.isComposing) return;
      const form = document.querySelector(formSel); if (!form) return;
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  }

  function whoCard(a) {
    return `${faceHtml(a.name, a.portrait_url)}
      <div class="whobody">
        <h1 class="pname">${esc(a.name)}</h1>
        ${a.facts ? `<p class="pfacts">${esc(a.facts)}</p>` : ""}
        ${a.role ? `<p class="prole">${esc(a.role)}</p>` : ""}
        ${a.state ? `<p class="pstate">${esc(a.state)}</p>` : ""}
      </div>`;
  }

  function personFacts(p) {
    return [
      p.age != null ? `${p.age}` : p.died ? `${p.born || "?"}\u2013${p.died}` : null,
      p.generation ? (/^\d+$/.test(String(p.generation)) ? `generation ${p.generation}` : String(p.generation)) : null,
      p.branch ? (/^(branch|gren)\b/i.test(String(p.branch)) ? String(p.branch) : `branch ${p.branch}`) : null,
    ].filter(Boolean);
  }

  function personCard(p, interviewsOpen, spent) {
    // Two different closed doors, and a team is owed the difference: the
    // seminar has not begun, or the team has spent its choices.
    const shut = p.state === "not_started" && (!interviewsOpen || spent);
    const cls = p.state === "in_progress" ? "live" : p.state === "completed" ? "spent" : shut ? "shut" : "";
    const face = p.portrait_url
      ? `<img class="portrait" src="${esc(p.portrait_url)}" alt="${esc(p.name)}" loading="lazy">`
      : `<div class="portrait none" aria-hidden="true">${esc(initials(p.name))}</div>`;
    // Only what the case actually carries. A missing fact is left out, not guessed.
    const facts = [
      p.age != null ? `${p.age}` : p.died ? `${p.born || "?"}–${p.died}` : null,
      p.generation ? (/^\d+$/.test(String(p.generation)) ? `generation ${p.generation}` : String(p.generation)) : null,
      p.branch ? (/^(branch|gren)\b/i.test(String(p.branch)) ? String(p.branch) : `branch ${p.branch}`) : null,
    ].filter(Boolean);
    const st = shut ? (interviewsOpen ? "no conversations left" : "not open yet")
      : { not_started: "not yet interviewed", in_progress: "conversation running", completed: "conversation held" }[p.state] || p.state;
    const mins = p.budget && p.budget.virtual_minutes ? `${p.budget.virtual_minutes} minutes` : "";
    const href = p.state === "in_progress" ? `#/room/${p.session_id}`
      : p.state === "completed" ? `#/transcripts/${p.session_id}`
      : `#/interview/${p.code}`;
    const action = shut
      ? `<span class="pbtn off">${interviewsOpen ? "None left" : "Not open yet"}</span>`
      : `<a class="pbtn" href="${href}">${p.state === "in_progress" ? "Return to the room" : p.state === "completed" ? "Read the transcript" : "Begin the interview"}</a>`;
    // Direct access: the CV of someone you may interview is yours, so the button
    // fetches the file rather than sending you to a desk to ask for it.
    const cv = p.cv
      ? `<button type="button" class="pbtn quiet cv-get" data-code="${esc(p.cv.code)}" data-name="${esc(p.name)}">CV (PDF)</button>`
      : "";
    return `<article class="person ${cls}" data-group="${esc(groupOf(p))}">
      ${face}
      <div class="pbody">
        <h3 class="pname">${esc(p.name)}</h3>
        ${facts.length ? `<p class="pfacts">${facts.map(esc).join(" · ")}</p>` : ""}
        ${p.role ? `<p class="prole">${esc(p.role)}</p>` : ""}
        <p class="pstate">${esc(st)}${mins && p.state === "not_started" && !shut ? ` · ${mins}` : ""}</p>
        <div class="pacts">${action}${cv}</div>
      </div>
    </article>`;
  }

  // A signed URL lives for a minute, so the file is fetched and handed over as
  // a blob: the download works even after the URL has expired in the address bar.
  async function downloadDoc(code, filename, btn) {
    const was = btn.textContent;
    btn.disabled = true; btn.textContent = "Fetching…";
    try {
      const s = await post(`/documents/${encodeURIComponent(code)}/open`);
      const res = await fetch(s.url);
      if (!res.ok) throw new Error(`the archive returned ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      btn.textContent = "Downloaded";
    } catch (e) {
      // The blob route can fail behind a strict network; the signed URL still opens.
      try { const s = await post(`/documents/${encodeURIComponent(code)}/open`); window.open(s.url, "_blank", "noopener"); btn.textContent = "Opened in a new tab"; }
      catch { btn.textContent = "Unavailable"; }
    } finally { btn.disabled = false; setTimeout(() => { btn.textContent = was; }, 4000); }
  }

  async function people() {
    const me = await ensureMe(); nav("case"); render("t-case");
    $("#edition").textContent = me.edition.title || me.edition.code;
    const gate = interviewGate(me);
    const open = !gate;
    $("#gate").hidden = open;
    if (gate) $("#gate").innerHTML = `<span class="tag">${esc(gate.tag)}</span><p>${esc(gate.text)}</p>`;
    watchGate((m) => !!interviewGate(m), people);
    const ps = await personas(true);
    const bs = budgetState();
    // Curated: the set is the exercise, so the strip counts it. Open: the
    // team's own budget is the thing that matters, and every number in it
    // comes from the engine — including what counts as held, which is a
    // question asked and not a session closed.
    if (bs) {
      const spending = bs.held + bs.pending;
      $("#case-lede").innerHTML = bs.choosing
        ? `Everyone the family has agreed to make available. Your team chooses <strong>${bs.budget}</strong> of them`
          + ` — one conversation each, and none of them reopens, so choose before you knock. Take notes; the transcript arrives only when the conversation ends.`
        : `Everyone the family has agreed you may speak with. Your team may hold <strong>${bs.budget}</strong> of these conversations`
          + ` — one with each person, and none of them reopens, so choose before you knock. Take notes; the transcript arrives only when the conversation ends.`;
      $("#l-people").textContent = bs.choosing ? "people you may choose from" : "people";
      $("#l-held").textContent = "conversations held";
      $("#l-left").textContent = "still to speak with";
      $("#n-people").textContent = ps.length;
      $("#n-held").textContent = spending;
      // The figure a team actually needs: how many are left of how many they
      // get. Both come from the engine.
      $("#n-left").textContent = bs.left == null ? "–" : `${bs.left}/${bs.budget}`;
      const note = $("#budget");
      const thing = bs.choosing ? "choice" : "conversation";
      note.innerHTML = bs.left === 0
        ? `Your ${bs.budget} conversations are spent. The people below stay in your file — their CVs, where they stand in the family — but no further room will open.`
        : bs.pending
          ? `${bs.left} left. A room you have opened counts while it is open, even before you ask anything, so ${bs.pending === 1 ? "the one standing open is" : `the ${bs.pending} standing open are`} included. Leave one without asking and the ${thing} comes back.`
          : `${bs.left} of ${bs.budget} left. A ${thing} is spent when you ask your first question — opening a room to read it and backing out costs nothing.`;
    } else {
      const held = ps.filter((p) => p.state === "completed").length;
      $("#n-people").textContent = ps.length;
      $("#n-held").textContent = held;
      $("#n-left").textContent = ps.length - held;
    }

    // The filter, built from the people who are actually there: one chip per
    // generation the case knows, and one for everybody outside the family tree
    // — the board and the management, who belong to no generation of it.
    const gens = [...new Set(ps.map((p) => p.generation).filter(Boolean))];
    const independents = ps.filter((p) => !p.generation).length;
    if (gens.length > 1 || (gens.length && independents)) {
      const bar = $("#gen-filter"); bar.hidden = false;
      bar.innerHTML = `<button type="button" class="gen on" data-group="">Everyone</button>`
        + gens.map((g) => `<button type="button" class="gen" data-group="gen:${esc(g)}">${esc(/^\d+$/.test(String(g)) ? `Generation ${g}` : g)}</button>`).join("")
        + (independents ? `<button type="button" class="gen" data-group="independent">Independent</button>` : "");
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("button.gen"); if (!b) return;
        bar.querySelectorAll("button.gen").forEach((x) => x.classList.toggle("on", x === b));
        document.querySelectorAll("#roster .person").forEach((el) => {
          el.hidden = !!b.dataset.group && el.dataset.group !== b.dataset.group;
        });
      });
    }

    $("#roster").innerHTML = ps.length
      ? ps.map((p) => personCard(p, open, !!bs && bs.left === 0)).join("")
      : `<div class="empty"><span class="tag">no one available</span><p>No conversations are open in this edition yet.</p></div>`;
    $("#roster").addEventListener("click", (e) => {
      const b = e.target.closest(".cv-get"); if (!b) return;
      downloadDoc(b.dataset.code, `${b.dataset.name.replace(/[^\p{L}\p{N} .-]/gu, "")} CV.pdf`, b);
    });
  }

  /**
   * The case file. `at` names a record to land on: the list runs to seventy-odd
   * rows across several folders, so arriving at the top and hunting for the one
   * that just came in is the wrong experience. The row is scrolled to the middle
   * and marked, and the mark fades rather than persisting into the next visit.
   */
  async function file(at) {
    const me = await ensureMe(); nav("file"); render("t-file");
    const ds = await documents(true);
    const stage = { brief: "Onboarding pack", roster: "The people you may interview", engagement_only: "The engagement", discovery: "Released to your team", deep: "From the registry" };
    // How this team came by a document, in their own terms. Never why.
    const via = { trigger: "released after an interview", request: "you asked for it", instructor: "given by your instructor", event: "released to every team" };
    const groups = {};
    // A CV that is in the file because you may interview its subject belongs
    // with the people, not with whatever stage the archive happens to file it at.
    const keyOf = (d) => (d.roster_cv ? "roster" : d.release_stage === "brief" && d.folder ? `brief/${d.folder}` : d.release_stage);
    for (const d of ds) (groups[keyOf(d)] ||= []).push(d);
    const folders = Object.keys(groups).filter((k) => k.startsWith("brief/")).sort();
    const order = [...folders, ...["brief", "roster", "engagement_only", "discovery", "deep"].filter((k) => groups[k])];
    const labelOf = (k) => (k.startsWith("brief/") ? `${stage.brief} · ${k.slice(6)}` : stage[k] || k);
    // What a row answers to when a team searches for it: its code, both of its
    // names, the year, the class of record, who holds it, how it reached the
    // team, and the folder it sits in — folded, so a search for "malmo" finds
    // Malmö and one for "will" finds a testamente filed in English.
    const findable = (d) => fold([d.code, ...bothNames(d), d.doc_year, d.record_class, d.holding_institution, via[d.granted_via], labelOf(keyOf(d))].filter(Boolean).join(" "));
    $("#docs").innerHTML = ds.length ? `<div class="doclist">${order.map((k) => `<div class="grp label" data-label="${esc(labelOf(k))}" data-total="${groups[k].length}">${esc(labelOf(k))} · ${groups[k].length}</div>` + groups[k].sort((a, b) => (a.doc_year || 0) - (b.doc_year || 0)).map((d) =>
      // The row still opens the record. The chevron beside it opens the
      // description, which is the cheaper question — "what is this?" — and
      // does not spend a click on the wrong paper. The toggle sits outside
      // the anchor because a button inside a link is neither.
      `<div class="docitem" id="row-${esc(d.code)}" data-find="${esc(findable(d))}" data-kind="${esc(d.doc_class || "other")}" data-new="${d.first_opened ? "" : "1"}">${
        d.blurb_en ? `<button type="button" class="docmore" aria-expanded="false" aria-label="What this record is"></button>` : `<span class="docmore none"></span>`
      }<a class="docrow" href="#/file/${esc(d.code)}"><span class="code">${esc(d.code)}</span><span>${titleHtml(d)}<div class="prov">${esc(d.holding_institution || "")}${d.doc_year ? " · " + d.doc_year : ""}</div></span><span class="prov">${esc(d.record_class || "")}${d.granted_via && via[d.granted_via] ? `<div class="via">${esc(via[d.granted_via])}</div>` : ""}</span><span class="st ${d.first_opened ? "" : "new"}">${d.first_opened ? `opened ${d.opens}×` : "not yet opened"}</span></a>${
        d.blurb_en ? `<p class="docblurb" hidden>${esc(d.blurb_en)}</p>` : ""}</div>`).join("")).join("")}</div>`
      : me.edition.status === "open"
        ? `<div class="empty"><span class="tag">nothing yet</span><p>Your onboarding pack is not in place yet. Ask your instructor.</p></div>`
        : `<div class="empty"><span class="tag">not open yet</span><p>Your file opens when your instructor opens the course.</p></div>`;
    $("#docs").addEventListener("click", (e) => {
      const b = e.target.closest("button.docmore"); if (!b) return;
      const item = b.closest(".docitem"); const p = item.querySelector(".docblurb");
      if (!p) return;
      p.hidden = !p.hidden;
      b.setAttribute("aria-expanded", String(!p.hidden));
      item.classList.toggle("open", !p.hidden);
    });

    // The file runs past seventy rows in six folders by the end of a course, and
    // the row a team wants is one it can already name. The filter narrows the
    // list as they type, empties out the folders that stop answering, and says
    // how much of the file is still in front of them. Nothing leaves the page.
    const rows = [...document.querySelectorAll("#docs .docitem")];
    const heads = [...document.querySelectorAll("#docs .grp")];

    // The list is grouped by how a record reached the team, which is the right
    // question early and the wrong one by the end of a course: two folders
    // swallow everything. The kind of record is what a team actually asks for
    // — "show me the shareholders' agreements" — and doc_class has carried it
    // in the payload all along, unused. These are the same chips the roster
    // uses for generations, built from the kinds this file actually holds.
    const kindName = {
      constitution: "Articles and statutes", shareholders_agreement: "Shareholders' agreements",
      financial: "Financial", will: "Wills and estates", correspondence: "Correspondence",
      memorandum: "Memoranda", policy: "Policies", cv: "People", other: "Other",
    };
    const kindOrder = ["constitution", "shareholders_agreement", "financial", "will", "correspondence", "memorandum", "policy", "cv", "other"];
    const tally = {};
    for (const r of rows) tally[r.dataset.kind] = (tally[r.dataset.kind] || 0) + 1;
    const kinds = kindOrder.filter((k) => tally[k]).concat(Object.keys(tally).filter((k) => !kindOrder.includes(k)).sort());
    const unopened = rows.filter((r) => r.dataset.new).length;
    let pick = "";                                     // "" is everything
    if (rows.length) {
      const bar = $("#doc-kinds");
      if (kinds.length > 1) {
        bar.hidden = false;
        bar.innerHTML = `<button type="button" class="gen on" data-pick="">Everything · ${rows.length}</button>`
          + kinds.map((k) => `<button type="button" class="gen" data-pick="kind:${esc(k)}">${esc(kindName[k] || k.replace(/_/g, " "))} · ${tally[k]}</button>`).join("")
          + (unopened && unopened < rows.length ? `<button type="button" class="gen" data-pick="new">Not yet opened · ${unopened}</button>` : "");
      }
      $("#doc-filter").hidden = false;
      const q = $("#doc-q");
      const apply = () => {
        const terms = fold(q.value).split(/\s+/).filter(Boolean);
        let shown = 0;
        for (const r of rows) {
          const kindOk = !pick || (pick === "new" ? !!r.dataset.new : r.dataset.kind === pick.slice(5));
          const hit = kindOk && terms.every((t) => r.dataset.find.includes(t));
          r.hidden = !hit;
          if (hit) shown++;
        }
        for (const h of heads) {
          let n = 0;
          for (let el = h.nextElementSibling; el && !el.classList.contains("grp"); el = el.nextElementSibling) if (!el.hidden) n++;
          h.hidden = n === 0;
          h.textContent = `${h.dataset.label} · ${terms.length ? `${n} of ${h.dataset.total}` : h.dataset.total}`;
        }
        $("#doc-count").textContent = terms.length || pick
          ? `${shown} of ${rows.length} record${rows.length === 1 ? "" : "s"}`
          : `${rows.length} record${rows.length === 1 ? "" : "s"}`;
      };
      q.addEventListener("input", apply);
      q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; apply(); } });
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("button.gen"); if (!b) return;
        pick = b.dataset.pick;
        bar.querySelectorAll("button.gen").forEach((x) => x.classList.toggle("on", x === b));
        apply();
      });
      apply();
    }
    if (at) {
      const row = document.getElementById(`row-${at}`);
      if (row) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.classList.add("landed");
        setTimeout(() => row.classList.remove("landed"), 2600);
      }
    }
    let deskList = [];
    try { deskList = (await api("/desks")).desks; } catch { /* the desks are optional */ }
    const registry = deskList.find((d) => d.desk_kind === "registry");
    if (registry) {
      // The registrar is a person, and she gets the card a person gets — the
      // same one the desk page and the roster use. She was a 52px thumbnail
      // beside a label here, which made the one human being on the page the
      // smallest thing on it.
      $("#reg-aside").innerHTML = `<div class="whocard">${whoCard({
        name: registry.name, portrait_url: registry.portrait_url,
        role: registry.subtitle || "the document registry",
        facts: "the case archive",
      })}</div>
        <div class="card">
          <div class="prose"><p>Keeps the archive. Ask for a record by name and, if it is there, it goes into this file. She remembers what you asked.</p></div>
          <p><a class="btn quiet" href="#/desk/${esc(registry.code)}">Ask ${esc(registry.name.split(" ")[0])}</a></p>
        </div>`;
      return;
    }
    $("#reg-form").addEventListener("submit", async (e) => {
      e.preventDefault(); const b = $("#reg-go"); b.disabled = true;
      try {
        const r = await post("/registry/request", { text: $("#reg-text").value });
        const say = {
          granted: `<p>I have found it. <strong>${esc(docName(r))}</strong> is now in your file under ${esc(r.code)}.</p>`,
          already: `<p>That one is already in your file: <strong>${esc(docName(r))}</strong>, ${esc(r.code)}.</p>`,
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
    $("#d-meta").innerHTML = `<a class="backrow" href="#/file/${esc(code)}/at" title="Show this record in your case file">${esc(meta.code)}</a> · ${esc(meta.holding_institution || "")}${meta.doc_year ? " · " + meta.doc_year : ""}`;
    $("#d-title").innerHTML = esc(docName(meta))
      + (nameSv(meta) !== docName(meta) ? `<span class="alt">Filed as ${esc(nameSv(meta))}</span>` : "");

    // Opening the reading view is the open that counts: it records the disclosure key.
    let signed = null;
    try { signed = await post(`/documents/${encodeURIComponent(code)}/open`); } catch {}
    const sign = async () => (signed && Date.now() - signed.at < 45000 ? signed : (signed = Object.assign(await post(`/documents/${encodeURIComponent(code)}/open`), { at: Date.now() })));
    if (signed) signed.at = Date.now();

    // The facsimile is the document. It renders on arrival rather than behind a
    // button: a team should meet the paper as it was written, and read the
    // transcription underneath only if it wants to.
    const note = $("#d-facnote"); const box = $("#d-pages");
    (async () => {
      note.textContent = "Rendering the facsimile…";
      try {
        const s = await sign();
        const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
        const pdf = await pdfjs.getDocument({ url: s.url }).promise;
        box.replaceChildren();
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 1.6 });
          const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height; box.appendChild(cv);
          await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        }
        note.textContent = `${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}, as filed.`;
      } catch {
        note.textContent = "The facsimile could not be shown here. The transcription is below, and the download still works.";
      }
    })();

    $("#d-dl").addEventListener("click", async () => {
      const b = $("#d-dl"); const was = b.textContent; b.disabled = true; b.textContent = "Fetching…";
      try {
        const s = await sign();
        const res = await fetch(s.url);
        if (!res.ok) throw new Error(String(res.status));
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement("a");
        a.href = url; a.download = `${code}.pdf`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        b.textContent = "Downloaded";
      } catch {
        try { const s = await sign(); window.open(s.url, "_blank", "noopener"); b.textContent = "Opened in a new tab"; }
        catch { b.textContent = "Unavailable"; }
      } finally { b.disabled = false; setTimeout(() => { b.textContent = was; }, 4000); }
    });

    // The transcription, in either language, under the paper it transcribes.
    async function load(lang) {
      document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
      const t = await api(`/documents/${encodeURIComponent(code)}/text?lang=${lang}`);
      $("#d-text").innerHTML = t.text ? prose(t.text) : "<p class=\"prov\">(no text in this language)</p>";
    }
    document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => load(b.dataset.lang)));
    await load("en");
  }

  async function confirm_(code) {
    await ensureMe(); nav("case"); render("t-confirm");
    const p = (await personas()).find((x) => x.code === code);
    if (!p) { location.hash = "#/people"; return; }
    $("#c-name").textContent = p.name;
    $("#c-brief").innerHTML = paras(p.brief || "");
    // The two papers a team wants open while it reads the brief: this
    // person's curriculum vitae, and the family tree the brief places them
    // in. Both are records of the case, so both go through the case file
    // rather than being rendered here. The genogram is offered only when the
    // team can actually reach it.
    (async () => {
      const el = $("#c-papers"); if (!el) return;
      const bits = [];
      if (p.cv && p.cv.code) bits.push(`<a href="#/file/${esc(p.cv.code)}">Curriculum vitae</a>`);
      try {
        const tree = (await documents()).find((d) => /genogram/i.test(d.code) || /genogram/i.test(docName(d)));
        if (tree) bits.push(`<a href="#/file/${esc(tree.code)}">${esc(docName(tree))}</a>`);
      } catch { /* the CV alone is worth the line */ }
      el.innerHTML = bits.length ? bits.join('<span class="sep">·</span>') : "";
    })();
    // The same portrait and the same few facts as the roster: this is the last
    // page before a conversation that does not reopen.
    $("#c-portrait").innerHTML = p.portrait_url
      ? `<img class="portrait" src="${esc(p.portrait_url)}" alt="${esc(p.name)}">`
      : `<div class="portrait none" aria-hidden="true">${esc(initials(p.name))}</div>`;
    $("#c-facts").textContent = personFacts(p).join(" · ");
    $("#c-virtual").textContent = p.budget.virtual_minutes ?? "–"; $("#c-wall").textContent = p.budget.wall_minutes ?? "–";
    // When the team is the one choosing, this button spends a choice. Say so
    // here, on the last page before it, with the engine's own numbers.
    const bs = budgetState();
    if (bs) {
      $("#c-budget").innerHTML = bs.left === 0
        ? `Your team has used all ${bs.budget} of its conversations. This room will not open.`
        : `This is one of your team's ${bs.budget} conversations. ${bs.left} ${bs.left === 1 ? "is" : "are"} left, and this one is counted from the moment the room opens — leave without asking anything and it comes back.`;
      if (bs.left === 0) $("#c-go").disabled = true;
    }
    // The papers worth bringing to this conversation. Read before it starts,
    // because the point of the page is preparation: what exists about this
    // person, what the team already holds, and what it would have to ask the
    // registry for by name. Contents are never here — a description and, for
    // a record the team holds, a link to read the record itself.
    records(code).catch(() => {});

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

  /**
   * The registry's dossier on one person: the records the case says are worth
   * putting to them, in the order it set. A record the team holds links to
   * itself; one it does not is marked as something to ask for, which is the
   * whole reason a team is told it exists.
   *
   * The registrar's portrait is a graphic device — these papers were put
   * together by someone, for this person. Nothing here is a conversation, and
   * the desk is not asked anything to draw it.
   */
  async function records(code) {
    let rs = [];
    try { rs = (await api(`/personas/${encodeURIComponent(code)}/records`)).records || []; } catch { return; }
    if (!rs.length) return;
    const box = $("#c-records"); if (!box) return;
    // Whoever keeps the archive in this case, by name and by face. Read from
    // the desk rather than named here: this site runs whatever case it is
    // pointed at, and the registrar has a different name in each one.
    let keeper = null;
    try { keeper = (await api("/desks")).desks.find((d) => d.desk_kind === "registry") || null; } catch { /* the box stands without a face */ }
    const first = keeper ? keeper.name.split(" ")[0] : null;
    const held = rs.filter((r) => r.held).length;
    const ask = rs.length - held;
    $("#c-reg-face").innerHTML = keeper ? faceHtml(keeper.name, keeper.portrait_url) : "";
    $("#c-reg-label").textContent = keeper ? keeper.name : "The registry";
    $("#c-reg-role").textContent = keeper ? (keeper.subtitle || "the document registry") : "";
    // The count reads down the column: the figure, then what it counts.
    $("#c-reg-counts").innerHTML = [
      ["", rs.length, `record${rs.length === 1 ? "" : "s"} bear on this person`],
      ...(held ? [["", held, "already in your case file"]] : []),
      ...(ask ? [["ask", ask, `to ask ${first ? esc(first) : "the registry"} for`]] : []),
    ].map(([cls, n, what]) => `<div class="${cls}"><dt>${n}</dt><dd>${what}</dd></div>`).join("");
    // One line per record, folded. Twenty personas' worth of fifty-word
    // descriptions is a page nobody reads; the name and the code are what a
    // team scans, and the description is one click away.
    $("#c-reclist").innerHTML = rs.map((r) => {
      const name = esc(docName(r));
      const bits = [esc(r.code), r.doc_year ? esc(r.doc_year) : null,
        r.record_class ? esc(String(r.record_class).replace(/_/g, " ")) : null,
        r.holding_institution ? esc(r.holding_institution) : null].filter(Boolean).join(" · ");
      // Held: read it. Not held: ask for it here, and it is handed over here.
      // The list is authored, so the paper the team pressed is the paper it
      // gets — no conversation, and no resolution to get wrong.
      const mark = r.held
        ? `<a class="rmark" href="#/file/${esc(r.code)}">read it</a>`
        : `<button type="button" class="rmark ask" data-code="${esc(r.code)}">ask ${esc(first || "the registry")} for it</button>`;
      return `<li><details class="recrow"><summary><span class="rttl">${name}</span>
          <span class="rmeta">${bits}</span></summary>${
        r.blurb ? `<p class="rblurb">${esc(r.blurb)}</p>` : ""}</details>${mark}</li>`;
    }).join("");
    // Asking is the whole transaction: the record goes into the case file and
    // the button becomes the way to read it, without leaving the page.
    $("#c-reclist").addEventListener("click", async (e) => {
      const b = e.target.closest("button.rmark.ask"); if (!b) return;
      const doc = b.dataset.code;
      b.disabled = true; const was = b.textContent; b.textContent = "asking…";
      try {
        await post(`/personas/${encodeURIComponent(code)}/records/${encodeURIComponent(doc)}`);
        const a = document.createElement("a");
        a.className = "rmark"; a.href = `#/file/${doc}`; a.textContent = "read it";
        b.replaceWith(a);
        // The case file is now out of date in this tab.
        S.docs = null;
        const c = $("#c-reg-counts"); if (c) {
          const held = document.querySelectorAll("#c-reclist a.rmark").length;
          const ask = document.querySelectorAll("#c-reclist button.rmark.ask").length;
          c.innerHTML = [
            ["", held + ask, `record${held + ask === 1 ? "" : "s"} bear on this person`],
            ...(held ? [["", held, "now in your case file"]] : []),
            ...(ask ? [["ask", ask, `to ask ${first ? esc(first) : "the registry"} for`]] : []),
          ].map(([cls, n, what]) => `<div class="${cls}"><dt>${n}</dt><dd>${what}</dd></div>`).join("");
        }
      } catch (err) {
        b.disabled = false; b.textContent = was;
        const p = $("#c-err"); if (p) p.textContent = err.message;
      }
    });
    box.hidden = false;
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
    // The window is an appointment and it starts with the first question, so
    // until then there is no wall_left_min to report. That is not a missing
    // figure to be dashed out — it is a full window, and the ring says so.
    const notStarted = wl == null && !!wallTotal;
    $("#k-virt").textContent = vl == null ? "–" : `${Math.max(0, vl).toFixed(0)} min`;
    $("#k-wall").textContent = notStarted ? `${wallTotal} min` : wl == null ? "–" : `${wl} min`;
    ring("#ring-virt", vt ? Math.min(vl, vt) / vt : 0);
    ring("#ring-wall", notStarted ? 1 : wallTotal && wl != null ? wl / wallTotal : 0);
    const warn = $("#r-warn");
    if (warn) warn.textContent = notStarted
      ? `Your ${wallTotal}-minute window has not started. It begins when you send your first question — reading and preparing cost you nothing.`
      : "";
    $("#cap").textContent = st.input_char_cap ?? "–";
    if (notStarted) note.textContent = "The window starts with your first question.";
    else if (st.in_grace) note.textContent = `${name} is glancing at the clock.`;
    else if (vl != null && vl <= 10) note.textContent = `You have about ${Math.max(1, Math.round(vl))} minutes of ${name}'s time left.`;
    else if (wl != null && wl <= 10) note.textContent = `Your window closes in ${wl} minutes. This deadline is real.`;
    else note.textContent = "";
  }
  function addTurn(box, speaker, text) {
    const d = document.createElement("div"); d.className = `turn ${speaker === "you" ? "q" : speaker === "sys" ? "sys" : ""}`;
    d.innerHTML = `<div class="sp">${esc(speaker)}</div><div></div>`;
    const body = d.lastElementChild;
    body.textContent = String(text ?? "");
    box.appendChild(d); d.scrollIntoView({ block: "nearest" });
    // Returned so an answer that arrives in pieces can grow in the turn it
    // already occupies, rather than appearing as a dozen turns.
    return { turn: d, body };
  }

  /**
   * Ask, and show the answer as it is spoken.
   *
   * The API streams server-sent events: a `delta` per fragment, then one `done`
   * carrying the kind, the cap state and the whole answer. `done` is what the
   * page trusts — the fragments are only so that the room does not sit blank
   * for eight seconds while a person is thinking — so a dropped fragment
   * cannot leave the screen disagreeing with the transcript.
   *
   * fetch is used directly rather than EventSource: EventSource cannot send an
   * Authorization header or a body, and this request is a POST that carries
   * the question.
   */
  async function askStreamed(path, payload, onDelta) {
    const t = await token();
    if (!t) throw Object.assign(new Error("sign_in_required"), { code: "sign_in_required" });
    const r = await fetch(`${C.API_BASE}${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload || {}),
    });
    if (r.status === 401) { store.set(null); throw Object.assign(new Error("sign_in_required"), { code: "sign_in_required" }); }
    if (!r.ok || !r.body) {
      const j = await r.json().catch(() => ({}));
      throw Object.assign(new Error(j.message || j.error || `HTTP ${r.status}`), { code: j.error, status: r.status });
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "", done = null, failed = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      // Events are separated by a blank line; a partial one stays in the
      // buffer until the rest of it arrives.
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = "message", data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed; try { parsed = JSON.parse(data); } catch { continue; }
        if (ev === "delta" && parsed.t) onDelta(parsed.t);
        else if (ev === "done") done = parsed;
        else if (ev === "failed") failed = parsed;
      }
    }
    if (failed) throw Object.assign(new Error(failed.message || "The interview stalled."), { code: failed.error });
    if (!done) throw new Error("The answer was cut off. Ask again.");
    return done;
  }

  async function room(id) {
    const me = await ensureMe(); render("t-room");
    const ps = await personas();
    let st = await api(`/sessions/${id}/state`);
    const p = ps.find((x) => x.session_id === Number(id)) || ps.find((x) => x.code === st.persona_code) || { name: st.persona_code, budget: {} };
    if (st.session_state !== "open") { location.hash = `#/transcripts/${id}`; return; }
    recording(p.name);
    $("#r-label").textContent = "The interview";
    $("#r-who").innerHTML = whoCard({
      name: p.name, portrait_url: p.portrait_url, role: p.role,
      facts: personFacts(p).join(" · "),
      state: "conversation running",
    });
    const box = $("#turns");
    // The opening line is the only earlier turn the room shows. There is no live transcript: a reload mid-conversation shows what you have heard only from your notes.
    let opening = null; try { opening = sessionStorage.getItem(`fb.opening.${id}`); } catch {}
    if (opening) addTurn(box, p.name, opening);
    addTurn(box, "sys", "The conversation is running. There is no live transcript: take notes. It arrives when the conversation ends.");
    const wallTotal = p.budget.wall_minutes || null;
    showState(st.state, p.name, wallTotal);
    // ── putting a record in front of them ────────────────────────────────
    // This was a native <select> holding the team's whole case file, labels
    // truncated at 110 characters, firing on `change` — so choosing was
    // committing, on a phone through the system picker, with no way to see
    // what you had chosen or to change your mind. Worse, it was its own act:
    // a line appeared in the thread and the question you actually wanted to
    // ask about the record went separately.
    //
    // A record now rides WITH the question, the way it does across a real
    // table: you find it by name, it sits above what you are writing as
    // something you can still take back, and it goes out when you send.
    const ds = await documents();
    let holding = null;                                  // the attached record
    const chip = $("#ex-chip"), pick = $("#ex-pick"), exq = $("#ex-q");
    const drawChip = () => {
      chip.hidden = !holding;
      $("#ex-open").hidden = !!holding;
      if (holding) {
        chip.innerHTML = `<span class="excode">${esc(holding.code)}</span>
          <span class="exttl">${esc(docName(holding))}</span>
          <button type="button" class="exdrop" id="ex-drop" title="Take it back">×</button>`;
        $("#ex-drop").addEventListener("click", () => { holding = null; drawChip(); });
      }
    };
    const drawList = () => {
      const terms = fold(exq.value).split(/\s+/).filter(Boolean);
      const hits = ds.filter((d) => {
        const hay = fold([d.code, ...bothNames(d), d.doc_year, d.holding_institution].filter(Boolean).join(" "));
        return terms.every((t) => hay.includes(t));
      }).slice(0, 12);
      $("#ex-list").innerHTML = hits.length
        ? hits.map((d) => `<button type="button" class="exhit" data-code="${esc(d.code)}">
            <span class="excode">${esc(d.code)}</span>
            <span class="exttl">${esc(docName(d))}${d.doc_year ? ` · ${d.doc_year}` : ""}</span></button>`).join("")
        : `<p class="prov">Nothing in your file answers that. You can only show a record you hold.</p>`;
    };
    $("#ex-open").addEventListener("click", () => {
      pick.hidden = !pick.hidden;
      if (!pick.hidden) { exq.value = ""; drawList(); exq.focus(); }
    });
    exq.addEventListener("input", drawList);
    exq.addEventListener("keydown", (e) => { if (e.key === "Escape") { pick.hidden = true; } });
    $("#ex-list").addEventListener("click", (e) => {
      const b = e.target.closest(".exhit"); if (!b) return;
      holding = ds.find((d) => d.code === b.dataset.code) || null;
      pick.hidden = true; drawChip(); $("#question").focus();
    });

    const q = $("#question"), cnt = $("#count");
    q.addEventListener("input", () => { cnt.textContent = q.value.length; const cap = Number($("#cap").textContent); cnt.parentElement.classList.toggle("over", cap && q.value.length > cap); });
    sendOnEnter(q, "#ask");
    // The microphone, if this course run allows one. It appends into the same
    // box the student types in, so everything downstream — the counter, the cap,
    // Enter to send — is unchanged and unaware of it.
    voiceFor(me, "mic", "question", "mic-note");
    let lastAnswerAt = Date.now();
    $("#ask").addEventListener("submit", async (e) => {
      e.preventDefault(); const text = q.value.trim(); if (!text) return;
      const cap = Number($("#cap").textContent); if (cap && text.length > cap) { $("#r-err").textContent = `Keep it under ${cap} characters.`; return; }
      const b = $("#send"); b.disabled = true; $("#r-err").textContent = "";
      addTurn(box, "you", text); q.value = ""; cnt.textContent = "0";
      const silence = Math.min(600, Math.round((Date.now() - lastAnswerAt) / 1000));
      const shown = holding;
      if (shown) { addTurn(box, "sys", `You put ${shown.code} — ${docName(shown)} — in front of them.`); holding = null; drawChip(); }
      // The answer arrives as it is spoken. An empty turn goes up first so the
      // room shows who is talking and the page does not sit blank while a
      // person thinks; the text then grows inside it. `done` carries the whole
      // answer and replaces whatever accumulated, so a dropped fragment cannot
      // leave the screen out of step with the transcript. If the stream cannot
      // be had at all — an old browser, a proxy that will not pass it — the
      // buffered route still answers, and the only difference is the wait.
      const payload = { question: text, silence_seconds: silence, document_code: shown ? shown.code : undefined };
      try {
        let live = null;
        let r;
        // Measured on the box: the first word of an answer arrives about three
        // and a half seconds after the question, because the person is
        // thinking before she speaks. Those seconds are covered rather than
        // hidden — the same row the desks use, with its seconds counter, so a
        // slow answer and a dead service are never the same blank pause — and
        // it is removed the instant the first fragment lands.
        const thinking = working(box, `${p.name} is thinking`);
        try {
          r = await askStreamed(`/sessions/${id}/ask/stream`, payload, (chunk) => {
            if (!live) { thinking.stop(); live = addTurn(box, p.name, ""); live.turn.classList.add("speaking"); }
            live.body.textContent += chunk;
            live.turn.scrollIntoView({ block: "nearest" });
          });
        } catch (streamErr) {
          thinking.stop();
          if (streamErr.code === "sign_in_required") throw streamErr;
          // Nothing was shown yet: fall back rather than fail. Something was
          // shown: the turn was spoken and asking again would double it.
          if (live) throw streamErr;
          console.warn("[room] stream unavailable, falling back", streamErr);
          r = await post(`/sessions/${id}/ask`, payload);
        }
        thinking.stop();
        if (live) live.turn.classList.remove("speaking");
        if (r.kind === "answer") {
          if (live) live.body.textContent = r.answer; else addTurn(box, p.name, r.answer);
        } else {
          if (live) live.turn.remove();
          addTurn(box, "sys", r.message);
        }
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
    // Interviews only. A desk conversation is not a transcript: it is a
    // reference tool a group returns to, and it lives on its desk's own page
    // beside the group's other conversations there. It only started appearing
    // here at all because nothing used to close a desk thread, so none had
    // ever reached a state this page lists.
    const iv = ss.filter((s) => s.kind !== "desk");
    const mins = (n) => `${n} minute${n === 1 ? "" : "s"} of their time`;
    $("#tr-list").innerHTML = iv.length ? `<div class="doclist">${iv.map((s) => `<a class="docrow" href="#/transcripts/${s.id}"><span class="code">${esc(s.closed_at ? s.closed_at.slice(0, 16).replace("T", " ") : "")}</span><span><div class="ttl">${esc(s.name)}</div><div class="prov">${s.turn_count} turns · ${esc(mins(Math.round(s.virtual_seconds / 60)))}</div></span><span></span><span class="st">${esc(s.state.replace("_", " "))}</span></a>`).join("")}</div>`
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
    const me = await ensureMe(); nav("desk"); render("t-desks");
    const shut = courseGate(me);
    const ds = (await api("/desks")).desks.filter((d) => d.desk_kind !== "registry");
    if (shut) { $("#desk-list").innerHTML = gateBanner(shut); watchGate((m) => !!courseGate(m), desks); return; }
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

  /**
   * A desk gets the same page before it that a person does: who you are about
   * to write to, and what the rules of this particular conversation are. It
   * appears only while nothing has been asked — after that the thread is the
   * page, exactly as an interview goes straight to the room once it is open.
   */
  function deskIntro(d, code) {
    const desk = d.desk;
    render("t-deskintro");
    const registry = desk.desk_kind === "registry";
    const cap = desk.questions_total || desk.turn_cap;
    const items = desk.sources.reduce((a, s2) => a + (s2.item_count || 0), 0);
    $("#di-portrait").innerHTML = faceHtml(desk.name, desk.portrait_url);
    $("#di-name").textContent = desk.name;
    $("#di-facts").textContent = [
      desk.subtitle || (registry ? "the document registry" : "the literature desk"),
      registry ? "the case archive" : `${desk.sources.length} source${desk.sources.length === 1 ? "" : "s"}${items ? `, ${items.toLocaleString()} items` : ""}`,
    ].join(" · ");
    $("#di-brief").textContent = desk.brief || (registry
      ? "Keeps the archive. Ask for a record by name and, if it is there, it goes into your case file."
      : "Reads the literature of the field and answers from it, citing what it used.");
    $("#di-rules").innerHTML = registry
      ? `<p>You are about to write to the archive. Ask for <strong>one record at a time</strong>, by name — a year, a party to it, or who would have kept it will narrow a request that is too broad. A record that is found and released to your team goes straight into your case file.</p>
         <p>The registrar will not describe what is inside a document she is not releasing, and every request you make is recorded${cap ? `. Your team has <strong>${cap}</strong> request${cap === 1 ? "" : "s"} in this course` : ""}.</p>
         <p>Unlike an interview, this conversation does not close. She remembers what you have already asked.</p>`
      : `<p>You are about to write to the literature desk. It answers from the sources listed beside the conversation and cites what it used${cap ? `, and your team has <strong>${cap}</strong> question${cap === 1 ? "" : "s"} in this course` : ""}.</p>
         <p>It has never heard of the family, the firm or the people you are studying, and it will say so if you ask about them. Ask it about the field, not about the case.</p>
         <p>Unlike an interview, this conversation does not close. It remembers what you have already asked.</p>`;
    $("#di-go").textContent = registry ? "Ask for a record" : "Open the desk";
    $("#di-back").href = registry ? "#/file" : "#/desk";
    $("#di-go").addEventListener("click", () => deskPage(code, true));
  }

  async function deskPage(code, skipIntro, threadId) {
    const me = await ensureMe(); nav("desk");
    let d;
    // `new` is the blank page: no request on screen, the composer ready. It
    // has to be its own address. Without it "open a new request" pointed at
    // #/desk/CODE — the URL a group was already on once it had finished its
    // last request, since that is where the newest thread is read from — so
    // the link fired no navigation and the button did nothing, on both desks.
    let fresh = threadId === "new";
    const at = fresh ? "?thread=new" : threadId ? `?thread=${encodeURIComponent(threadId)}` : "";
    try { d = await api(`/desks/${encodeURIComponent(code)}${at}`); }
    catch (err) { render("t-desk"); view.innerHTML = `<div class="empty"><span class="tag">no such desk</span><p>${esc(err.message)}</p><p><a href="#/desk">The desks</a></p></div>`; return; }
    // Nothing asked yet, and the course is open: meet the desk first.
    if (!skipIntro && !threadId && !d.turns.length && !courseGate(S.me)) return deskIntro(d, code);
    render("t-desk");
    const desk = d.desk;
    $("#dk-label").textContent = desk.subtitle || "The literature";
    const registry = desk.desk_kind === "registry";
    const deskBrief = desk.brief || (registry
      ? "Ask for a record by name. If the archive holds it, it goes into your case file."
      : "Ask about the literature. The desk answers from what it reads, and cites it.");
    $("#dk-q").placeholder = registry
      ? "e.g. the will of the founder, or the articles of association from the year the holding company was formed"
      : "Ask about the literature, not about the family";
    $("#dk-go").textContent = registry ? "Ask for it" : "Ask the desk";
    $("#dk-srclabel").textContent = registry ? "What this desk holds" : "What this desk reads";
    $("#dk-brief").textContent = deskBrief;
    $("#dk-note").textContent = registry
      ? "The archive is large and most of it is not listed. Name a year, a party to it, or who would have kept it."
      : "Answers cite what they used. Follow the citation and read the source before you rely on it.";
    $("#dk-sources").innerHTML = registry
      ? `<li><span class="prov">The case archive. Ask for one record at a time.</span></li>`
      : desk.sources.length
        ? desk.sources.map((s) => `<li><span>${esc(s.label)}</span><span class="n">${s.item_count ? s.item_count.toLocaleString() : ""}</span></li>`).join("")
        : `<li><span class="prov">This desk has no sources switched on.</span></li>`;

    const shut = courseGate(S.me);
    if (shut) {
      $("#dk-form").hidden = true;
      $("#dk-gate").hidden = false;
      $("#dk-gate").innerHTML = `<span class="tag">not open yet</span><p>${esc(shut)}</p>`;
      watchGate((m) => !!courseGate(m), () => deskPage(code));
    }

    // ── the group's requests to this desk ─────────────────────────────────
    // A desk is not an interview. The engine has always allowed a group many
    // numbered threads here, one open at a time, and nothing ever offered
    // them: the single thread simply grew until the page was unreadable and,
    // for a desk with a per-thread cap, until the button went dead with no way
    // to start again. All of that was reachable already.
    const threads = d.threads || [];
    const open = threads.find((t) => t.state === "open") || null;
    const here = d.thread;                      // the thread on screen
    const reading = !!here && here.state !== "open";
    const shown = (t) => (t.opening || "").replace(/\s+/g, " ").slice(0, 60);
    if (threads.length > 1 || reading || fresh || (open && threads.length && open.questions > 0)) {
      $("#dk-threads").hidden = false;
      $("#dk-threadlist").innerHTML = threads.map((t) => {
        const on = here && t.id === here.id;
        const what = t.state === "open"
          ? `Open · ${t.questions} question${t.questions === 1 ? "" : "s"}`
          : `${t.seq} · ${t.questions} question${t.questions === 1 ? "" : "s"}`;
        return `<a class="thchip${on ? " on" : ""}" href="#/desk/${esc(code)}/t/${t.id}"
                  title="${esc(shown(t) || "nothing asked")}">${esc(what)}${
          t.opening ? `<span class="th-q">${esc(shown(t))}</span>` : ""}</a>`;
      }).join("") + (open || fresh ? "" : `<a class="thchip new" href="#/desk/${esc(code)}/new">Open a new request</a>`);
    }

    const box = $("#dk-thread");
    const draw = (turns) => {
      box.innerHTML = "";
      if (!turns.length) box.innerHTML = `<div class="empty"><span class="tag">nothing asked yet</span><p>Ask your first question. The desk answers in a few sentences and tells you what it read.</p></div>`;
      else drawExchanges(box, desk.name, turns);
    };
    draw(d.turns);

    // What you can do with the request you are looking at. A finished one is
    // read-only: it can be put away, and the way back to work is a new one.
    const headActs = () => {
      const acts = [];
      if (reading) {
        acts.push(`<a class="pbtn" href="#/desk/${esc(code)}${open ? "" : "/new"}">${open ? "Back to the open one" : "Open a new request"}</a>`);
        acts.push(`<button type="button" class="pbtn quiet" id="dk-hide" title="Takes it off this list. It stays in the record and your instructor still sees it.">Put this away</button>`);
      } else if (here && here.questions > 0) {
        acts.push(`<button type="button" class="pbtn quiet" id="dk-finish" title="Ends this request. You can still read it, and your next question opens a new one.">Close this request</button>`);
      }
      if (d.turns.length > 2) acts.push(`<button type="button" class="pbtn quiet" id="dk-all">Expand all</button>`);
      $("#dk-headacts").innerHTML = acts.join("");
      $("#dk-head").hidden = !here;
      if (here) {
        const when = (here.closed_at || here.opened_at || "").slice(0, 10);
        $("#dk-headline").textContent = reading
          ? `Request ${here.seq} · closed ${when} · ${here.questions} question${here.questions === 1 ? "" : "s"}`
          : here.questions
            ? `This request · ${here.questions} question${here.questions === 1 ? "" : "s"}`
            : "A new request";
      }
      const hide = $("#dk-hide"); const fin = $("#dk-finish"); const all = $("#dk-all");
      if (hide) hide.addEventListener("click", async () => {
        if (!confirm("Put this request away? It leaves this list. Nothing is deleted — it stays in the record.")) return;
        hide.disabled = true;
        try { await post(`/desks/${encodeURIComponent(code)}/threads/${here.id}/hide`, { hidden: true }); location.hash = `#/desk/${code}`; await deskPage(code, true); }
        catch (err) { $("#dk-err").textContent = err.message; hide.disabled = false; }
      });
      if (fin) fin.addEventListener("click", async () => {
        if (!confirm("Close this request? You can still read it, and your next question opens a new one.")) return;
        fin.disabled = true;
        try { await post(`/desks/${encodeURIComponent(code)}/close`); location.hash = `#/desk/${code}/new`; await deskPage(code, true, "new"); }
        catch (err) { $("#dk-err").textContent = err.message; fin.disabled = false; }
      });
      if (all) all.addEventListener("click", () => {
        const shut = [...box.querySelectorAll("details")].filter((x) => !x.open);
        const openThem = shut.length > 0;
        box.querySelectorAll("details").forEach((x) => { x.open = openThem; });
        all.textContent = openThem ? "Collapse all" : "Expand all";
      });
    };
    headActs();

    // A conversation you have finished is a record, not a place to work. The
    // rest of the page still draws — the keeper, the sources, the counters —
    // because a group reading an old thread still wants to know where it is.
    if (reading) $("#dk-form").hidden = true;
    // The desks meter questions AND space them: min_seconds_between is 5s for the
    // registry and 20s for the literature desk. So the state returned with a
    // successful answer is `too_soon` -- the turn just recorded started the
    // clock. The button was disabled on that and nothing ever re-enabled it,
    // which is why a follow-up needed a page reload: reloading re-fetched the
    // state after the wait had passed. Now the wait is a countdown that expires.
    let waitTimer = null;
    // Seconds still to run on the desk's enforced gap, and the question a team
    // pressed send on while it ran.
    let waitLeft = 0, queued = null;
    // Two caps, and they are not the same cap. `turn_cap` is per conversation
    // and the engine counts it in TURNS — a question and its answer are two —
    // so a cap of eight is four questions, not eight. `questions_total` is per
    // course and counted over every conversation the group has had here. The
    // old counter showed questions_total minus this thread's questions, which
    // was neither figure, and when a conversation filled up it disabled the
    // button and said "no questions left" — of a desk with a hundred and more
    // to give. Full means finish this one and start another.
    const perCourse = desk.questions_total || null;
    const courseLeft = () => (perCourse === null ? null : Math.max(0, perCourse - desk.asked));
    const threadFull = (state) => !!state && state.allowed === false && state.reason === "turn_cap_reached";
    const left = (state) => {
      const cap = state && state.turn_cap;
      const here = cap ? Math.max(0, Math.floor((cap - (state.turn ?? 0)) / 2)) : null;
      const course = courseLeft();
      const done = course === 0;
      const full = threadFull(state) || here === 0;
      const wait = state && state.allowed === false && state.reason === "too_soon"
        ? Math.max(0, Number(state.wait_seconds) || 0) : 0;
      clearInterval(waitTimer); waitTimer = null;
      const parts = [];
      if (here !== null) parts.push(`${here} left in this request`);
      if (course !== null) parts.push(`${course} left in the course`);
      const show = (secs) => {
        $("#dk-left").textContent = done ? "no questions left in the course"
          : full ? "this request is full"
          : secs > 0 ? `ready in ${secs}s${parts.length ? ` · ${parts.join(" · ")}` : ""}`
          : parts.join(" · ");
        // The gap between questions is a rate limit, not a lockout. The button
        // stays live through it: press it and the question is held for the few
        // seconds that remain and then sent. A dead button for twenty seconds
        // reads as a broken page, and the reload it invites does not help.
        waitLeft = secs;
        $("#dk-go").disabled = done || full
          || (!!state && state.allowed === false && state.reason !== "too_soon");
      };
      show(wait);
      // A full conversation is not a dead end: offer the way on, in place.
      $("#dk-full").hidden = !(full && !done);
      if (wait > 0 && !full && !done) {
        let secs = wait;
        waitTimer = setInterval(() => {
          secs -= 1;
          if (secs <= 0) { clearInterval(waitTimer); waitTimer = null; show(0); } else show(secs);
        }, 1000);
      }
    };
    $("#dk-onward").addEventListener("click", async () => {
      const b = $("#dk-onward"); b.disabled = true;
      try { await post(`/desks/${encodeURIComponent(code)}/close`); location.hash = `#/desk/${code}/new`; await deskPage(code, true, "new"); }
      catch (err) { $("#dk-err").textContent = err.message; b.disabled = false; }
    });
    left(d.state);
    const deskCap = perCourse;
    $("#dk-who").innerHTML = whoCard({
      name: desk.name, portrait_url: desk.portrait_url,
      role: desk.subtitle || (registry ? "the document registry" : "the literature desk"),
      facts: registry ? "the case archive" : `${desk.sources.length} source${desk.sources.length === 1 ? "" : "s"}`,
      state: deskCap ? `${Math.max(0, deskCap - desk.asked)} of ${deskCap} questions left in the course` : "",
    });

    sendOnEnter($("#dk-q"), "#dk-form");
    // A request to the archive is as worth dictating as a question to a person,
    // and it is the same composer, so it gets the same button.
    voiceFor(me, "dk-mic", "dk-q", "dk-mic-note");
    $("#dk-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = $("#dk-go"), q = $("#dk-q").value.trim();
      if (!q) return;
      const label = b.textContent;
      b.disabled = true;
      // Held rather than refused: the desk will not take a question yet, so
      // the page waits out the remainder and sends it. The team sees the
      // countdown on the button they just pressed.
      if (waitLeft > 0) {
        queued = q;
        for (let i = waitLeft; i > 0; i--) {
          b.textContent = `Sending in ${i}s…`;
          await new Promise((r) => setTimeout(r, 1000));
          if (queued !== q) return;                 // superseded or abandoned
        }
        queued = null;
      }
      b.textContent = registry ? "Searching…" : "Asking…";
      $("#dk-err").textContent = "";
      addDeskTurn(box, desk.name, { speaker: "interviewer", text: q, citations: [] });
      // A named, animated line so it is never ambiguous whether the desk is
      // working or has simply said nothing. It carries the elapsed seconds
      // because a desk that is thinking and a desk that has died look identical
      // for the first few of them.
      const waiting = working(box, registry ? `${desk.name} is searching the archive` : `${desk.name} is reading`);
      try {
        // Streamed, like the interview room: the desk's answer appears as it is
        // written. The registry desk is the one that most needs it — a search
        // followed by eight seconds of nothing looks exactly like a service
        // that has died — and the citations only arrive with `done`, since
        // what was handed over is not known until the answer is finished.
        let live = null;
        let r;
        try {
          r = await askStreamed(`/desks/${encodeURIComponent(code)}/ask/stream`, { question: q }, (chunk) => {
            if (!live) {
              waiting.stop();
              live = addTurn(box, desk.name, "");
              live.turn.classList.add("speaking");
            }
            live.body.textContent += chunk;
            live.turn.scrollIntoView({ block: "nearest" });
          });
        } catch (streamErr) {
          if (streamErr.code === "sign_in_required" || live) throw streamErr;
          console.warn("[desk] stream unavailable, falling back", streamErr);
          r = await post(`/desks/${encodeURIComponent(code)}/ask`, { question: q });
        }
        // The streamed text was a view. The turn is rebuilt from `done` so the
        // citations, the links into the case file and the paragraph breaks are
        // the same ones a reload would render.
        if (live) live.turn.remove();
        waiting.stop(); $("#dk-q").value = "";
        addDeskTurn(box, desk.name, { speaker: "persona", text: r.text, citations: r.citations });
        if (r.granted) S.docs = null;
        desk.asked += 1; left(r.state);
        // can_take_turn returns the reason alone while it is refusing, so the
        // state that comes back with an answer carries no turn_cap and the
        // per-request figure would vanish exactly when it changed. Read the
        // whole state from the engine instead of remembering the old one.
        try {
          const fresh = await api(`/desks/${encodeURIComponent(code)}/state`);
          if (fresh && fresh.state) left(fresh.state);
        } catch { /* the figure from the answer stands */ }
        // The blank page has become a real request. Correct the address
        // without re-rendering, so a reload reads the request rather than
        // offering another empty one.
        if (fresh) { fresh = false; history.replaceState(null, "", `#/desk/${code}`); }
      } catch (err) {
        waiting.stop();
        const m = (err.body && err.body.message) || err.message;
        $("#dk-err").textContent = m;
        // A failed answer costs nothing now, so the counter must not move.
        left(err.body && err.body.state);
      } finally {
        // left() is the only authority on whether the button is usable. The old
        // guard here read `if (!#dk-go.disabled)` -- but b IS #dk-go and had just
        // been disabled two lines above, so it could never fire.
        b.textContent = label;
      }
      box.scrollIntoView({ block: "end", behavior: "smooth" });
    });
  }

  /**
   * A visible "still working" row. Returns a handle whose stop() removes it.
   * The seconds counter matters: without it a slow answer and a dead service
   * are the same blank pause, which is exactly the confusion this fixes.
   */
  function working(box, what) {
    const d = document.createElement("div");
    d.className = "turn working";
    d.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="what"></span><span class="secs"></span>`;
    d.querySelector(".what").textContent = what;
    box.appendChild(d);
    d.scrollIntoView({ block: "end", behavior: "smooth" });
    const t0 = Date.now();
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      d.querySelector(".secs").textContent = s < 3 ? "" : ` · ${s}s`;
    }, 1000);
    return { stop() { clearInterval(tick); d.remove(); } };
  }

  /**
   * A desk request as exchanges rather than a flat run of turns. A question and
   * the answer to it belong together, and a course's worth of them does not fit
   * on a screen: each exchange collapses to the question it started with, and
   * they all start folded — a request you are reading back is an index of what
   * you asked, not a wall of prose. What is live is never in here: a question
   * asked now and the answer to it are appended to the page open.
   *
   * A question with no answer under it is shown as that. Four of them exist in
   * the live data, from the outage where record_turn refused the answer after
   * allowing the question, and a page that silently repeats the question three
   * times reads as a fault in the desk rather than a gap in the record.
   */
  function drawExchanges(box, name, turns) {
    const pairs = [];
    for (const t of turns) {
      if (t.speaker === "interviewer") pairs.push({ q: t, a: null });
      else if (pairs.length && !pairs.at(-1).a) pairs.at(-1).a = t;
      else pairs.push({ q: null, a: t });
    }
    pairs.forEach((p) => {
      const d = document.createElement("details");
      d.className = "xch";
      const q = (p.q ? p.q.text : "").replace(/\s+/g, " ");
      d.innerHTML = `<summary><span class="sp">${esc(p.q ? "You" : name)}</span>
          <span class="xq">${esc(q || "(no question recorded)")}</span>
          <span class="xst">${p.a ? "" : "not answered"}</span></summary>`;
      // The summary IS the question — truncated while folded, whole while open
      // — so the body carries the answer and nothing else. Rendering the
      // question again under it read as the desk being asked twice.
      const body = document.createElement("div");
      body.className = "xbody";
      if (p.a) addDeskTurn(body, name, p.a);
      else body.insertAdjacentHTML("beforeend",
        `<div class="turn sys">The desk never answered this one. It cost your team nothing.</div>`);
      d.appendChild(body);
      box.appendChild(d);
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
            // The title opens the record; the code shows where it landed in the
            // file. With no code there is no record to open, so the title is
            // not a link: `#/file/` routes to the whole case file, which looks
            // like the link working and is how a citation that had lost its
            // code went unnoticed until someone reloaded the page.
            const ttl = code ? `<a href="#/file/${esc(code)}">${esc(c.title)}</a>` : `<strong>${esc(c.title)}</strong>`;
            return `<li><span class="pos">▸</span><span>${ttl} <span class="prov">now in your case file${code ? ` · <a href="#/file/${esc(code)}/at">${esc(code)}</a>` : ""}</span></span></li>`;
          }
          return `<li><span class="pos">[${c.position}]</span><span>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.reference)}</a>` : esc(c.reference)}</span></li>`;
        }).join("")}</ul>`
      : "";
    d.innerHTML = `<div class="sp">${esc(who)}</div>${paras(t.text)}${cites}`;
    box.appendChild(d);
  }


  /**
   * The briefing. Everything a team needs to know before its first meeting,
   * and the reasons rather than the rules.
   *
   * Three passages are NOT written here: whether the team chooses its own
   * interviewees and how many it may hold, how long a conversation lasts, and
   * which desks are open with what they will take. All three are the
   * instructor's settings, and a page that asserted them would be wrong for
   * the next course and quietly wrong for this one. They are read from the
   * same responses every other page reads, so this page cannot drift from
   * what the engine will actually do.
   */
  async function how() {
    const me = await ensureMe(); nav("how"); render("t-how");
    const ps = await personas();
    const iv = S.interviews;

    // Dictation, only if this course run offers it. The page must not describe
    // a button that is not there, and it must not stay silent about where the
    // audio goes when it is — the browser's own recognition service is a third
    // party, and a student is entitled to know before they use it.
    if (me?.edition?.voice_input_enabled) {
      $("#how-voice").innerHTML = `<h2>You can speak instead of typing</h2>
        <p>There is a microphone beside the box. Press it, say your question, and the words appear
          in the box for you to read. Nothing is sent until you press Enter — so check it first,
          because it will mishear a surname, and the person you are talking to will answer the
          question it heard rather than the one you asked.</p>
        <p><strong>Say your punctuation.</strong> Nothing is added for you: say
          <em>comma</em>, <em>full stop</em>, <em>question mark</em>, <em>colon</em> or
          <em>new line</em> where you want one — <em>&ldquo;before ninety-five, comma, who held
          the shares, question mark&rdquo;</em>. Guessing where your sentences end from your
          pauses was tried and it got them wrong, which is worse than leaving them out.</p>
        <p>It listens in English, and it needs Chrome, Edge or Safari; Firefox cannot do it. If you
          would rather type, type — nothing about the exercise assumes you spoke.</p>
        <p class="prov">Your browser does the listening, and it sends the audio to its own
          recognition service to do it — Google for Chrome, Apple for Safari. It does not reach
          this platform and nothing here records it.</p>`;
    }

    // Whether choosing is even a thing on this course, and what it costs.
    const choose = $("#how-choose");
    if (iv && iv.selection === "open") {
      choose.innerHTML = `<p>You may hold <strong>${iv.budget}</strong> conversation${iv.budget === 1 ? "" : "s"},
        and there ${iv.available === 1 ? "is" : "are"} <strong>${iv.available}</strong> ${iv.available === 1 ? "person" : "people"}
        you could approach. You have used <strong>${iv.held + iv.pending}</strong>;
        <strong>${iv.left}</strong> remain${iv.left === 1 ? "s" : ""}. Choosing is part of the work — decide who is
        worth an hour before you knock.</p>`;
    } else if (iv) {
      const capped = iv.budget && iv.budget < iv.available;
      choose.innerHTML = `<p>Your team leader has named the <strong>${iv.available}</strong>
        ${iv.available === 1 ? "person" : "people"} you will meet.
        ${capped ? `You may hold <strong>${iv.budget}</strong> of those conversations, so the order matters twice over: ` : "See all of them, and plan the order: "}
        what you learn from one tells you what to ask the next.</p>`;
    }

    // One number if every person keeps the same appointment, and the truth if
    // they do not: a persona may be given its own clock, and a single figure
    // would then be a lie on every card but one.
    const mine = ps.filter((p) => p.budget && p.budget.virtual_minutes);
    const virt = [...new Set(mine.map((p) => p.budget.virtual_minutes))];
    const wall = [...new Set(mine.map((p) => p.budget.wall_minutes).filter(Boolean))];
    const same = virt.length === 1;
    // The figure, then the consequence — never the mechanism. How the clock is
    // metered is already said twice above ("you can sit with the documents for
    // an hour and spend none of it", and the window paragraph below), and a
    // third telling was what made this passage flabby: it explained a meter
    // where it should have given an instruction.
    $("#how-clocks").innerHTML =
      `<p>${same
        ? `Their time is <strong>${virt[0]}</strong> minutes.`
        : `How long each person will give you varies — the figure is on their card, and it runs from
           <strong>${Math.min(...virt)}</strong> to <strong>${Math.max(...virt)}</strong> minutes.`}
        With some people you will not reach the end of your list — not because you were slow, but
        because a person who answers at length is spending your meeting for you.</p>
       <p>Someone who answers in a line gives you room to chase a detail. Someone who answers in
        paragraphs makes every question a choice. Learn to stop them:
        <em>&ldquo;Can I hold you there — I want to be sure we get to the shareholders&rsquo;
        agreement.&rdquo;</em> Nobody minds it as much as you expect. But interrupt only when the
        answer is repeating or narrating what you already have; when it is telling you something
        new, let it run, even if it is not what you asked.</p>
       <p>Your window is ${same && wall.length === 1 ? `<strong>${wall[0]}</strong> minutes of ` : ""}real
        time and it starts with your first question, not when you open the page.</p>`;

    // Only the desks this course has opened, with what they will actually take.
    // Named from the response rather than from this file, and written without
    // a pronoun: another case's desks are other people.
    const ds = (await api("/desks")).desks;
    const box = $("#how-desks");
    if (!ds.length) {
      $("#how-desks-h").hidden = true;
      box.innerHTML = "";
      return;
    }
    // Registry first: it is the desk a team uses most, and the file section
    // below refers to it by the time the reader gets there.
    const order = { registry: 0, literature: 1 };
    box.innerHTML = [...ds].sort((a, b) => (order[a.desk_kind] ?? 9) - (order[b.desk_kind] ?? 9)).map((d) => {
      const who = `<strong>${esc(d.name)}</strong>`;
      if (d.desk_kind === "registry") {
        return `<p>${who} keeps the archive. Ask for a record by name and you will be told whether it
          exists, what kind of record it is, and whether this team may have it — and if you may, it
          goes into your file. Documents are not read out to you, and nothing is described that is
          not being released. Ask precisely; a vague request gets a vague answer.</p>`;
      }
      // Two different caps, and picking one of them says the wrong thing:
      // turn_cap is what one request will take, questions_total is what this
      // team has with the desk across every request it makes.
      const left = d.questions_total ? Math.max(0, d.questions_total - d.asked) : null;
      const limits = [
        d.turn_cap ? `one request takes up to <strong>${d.turn_cap}</strong> question${d.turn_cap === 1 ? "" : "s"}` : null,
        d.questions_total ? `this team has <strong>${d.questions_total}</strong> in all${left !== null && left !== d.questions_total ? `, of which <strong>${left}</strong> remain${left === 1 ? "s" : ""}` : ""}` : null,
        d.max_citations ? `at most <strong>${d.max_citations}</strong> source${d.max_citations === 1 ? "" : "s"} are cited at a time` : null,
      ].filter(Boolean);
      return `<p>${who} knows the field, not the family. Describe the problem you are facing and you
        will be given the vocabulary for it and pointed to where it has been written about.
        ${limits.length ? `There are limits: ${limits.length > 1 ? `${limits.slice(0, -1).join(", ")} and ${limits[limits.length - 1]}` : limits[0]}.` : ""}
        Nothing is known here about this company.</p>`;
    }).join("");
  }

  // ── router ──────────────────────────────────────────────────────────────
  async function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [a, b, c] = h.split("/");
    if (!store.get()) return signin();
    if (a !== "room") { stopPoll(); recording(null); }
    stopGate(); stopVoice();
    try {
      if (!a) return await landing();
      if (a === "people") return await people();
      if (a === "how") return await how();
      // #/file            the whole file
      // #/file/CODE       that document
      // #/file/CODE/at    the file, landed on that document's line
      if (a === "file") {
        if (!b) return await file();
        const code = decodeURIComponent(b);
        return c === "at" ? await file(code) : await doc(code);
      }
      if (a === "interview" && b) return await confirm_(b);
      if (a === "room" && b) return await room(b);
      if (a === "transcripts") return b ? await transcript(b) : await transcripts();
      // #/desk/CODE reads the request the group is working in;
      // #/desk/CODE/t/<id> reads one it has closed;
      // #/desk/CODE/new is the blank one, waiting for the first question.
      if (a === "desk") {
        if (!b) return await desks();
        const dk = decodeURIComponent(b);
        if (c === "new") return await deskPage(dk, true, "new");
        return c === "t" && h.split("/")[3] ? await deskPage(dk, true, h.split("/")[3]) : await deskPage(dk);
      }
      location.hash = "#/";
    } catch (err) {
      if (err.code === "sign_in_required") return signin();
      if (err.code === "no_active_group") return signin("This group is not active.");
      view.innerHTML = `<div class="empty"><span class="tag">something went wrong</span><p>${esc(err.message)}</p><p><a href="#/">Back to the case</a></p></div>`;
    }
  }
  /**
   * Which deployment the page came from. The footer used to carry a version
   * typed into the source, which meant it said whatever it said the last time
   * somebody remembered to change it. The number here is GitHub's own count of
   * Pages deployments of this repository, so it moves on its own every time the
   * site ships and nobody has to keep it honest.
   *
   * Best effort, and quiet about failing. The call is unauthenticated, which
   * GitHub rates at sixty an hour per address, and a lecture hall behind one
   * university address could spend that — so the answer is kept per tab, and
   * when there is no answer the footer falls back to the last-modified date of
   * the very script that is executing.
   *
   * The line also says when the browser is a deployment behind, because that
   * is the one thing it cannot be allowed to hide. GitHub Pages serves this
   * script with a ten-minute cache and no version in its name, so a tab left
   * open keeps running old code indefinitely while the footer, if it were only
   * reporting GitHub, would happily print the number of a deployment this page
   * has never seen.
   */
  async function stamp() {
    const el = $("#stamp"); if (!el || !C.REPO) return;
    const base = C.VERSION || "v0";
    const set = (extra, stale) => {
      el.textContent = extra ? `${base} · ${extra}` : base;
      if (stale) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "lnk stale"; b.textContent = "a newer version has shipped — reload";
        b.addEventListener("click", () => location.reload());
        el.append(document.createTextNode(" · "), b);
      }
    };
    set("");
    // The number is GitHub's own count of Pages deployments, so it moves on its
    // own every time the site ships. It is held in sessionStorage rather than
    // localStorage: an hour-long cache made the footer report a deployment
    // older than the page it was printed on, which is worse than no number,
    // because the one question this line exists to answer is "am I looking at
    // a stale copy?". Per tab is often enough to be polite to GitHub's sixty
    // unauthenticated calls an hour and fresh enough to be true.
    const KEY = "fb.deploy";
    try { localStorage.removeItem(KEY); } catch {}
    let got = null;
    try { got = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch {}
    if (!got) {
      try {
        const r = await fetch(`https://api.github.com/repos/${C.REPO}/actions/runs?per_page=1`, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (r.ok) {
          const run = ((await r.json()).workflow_runs || [])[0];
          if (run && run.run_number) {
            got = { n: run.run_number, when: run.updated_at };
            try { sessionStorage.setItem(KEY, JSON.stringify(got)); } catch {}
          }
        }
      } catch { /* offline, blocked, or rate-limited: the fallback covers it */ }
    }
    // Whether the code running here is the code that has been deployed. The
    // script in this browser carries the date it was served with, and GitHub
    // has just said when the newest deployment finished; if the script is
    // meaningfully older than the deployment, this tab is behind. Read from
    // the cache — force-cache returns the copy the page is running without
    // going to the network — so the check costs nothing.
    //
    // Five minutes of slack, because a deployment finishes a few seconds after
    // the file it publishes is stamped, and a difference of seconds means the
    // two agree.
    let stale = false;
    try {
      if (got && got.when) {
        const mine = (await fetch("app.js", { cache: "force-cache" })).headers.get("last-modified");
        if (mine) stale = new Date(got.when) - new Date(mine) > 300e3;
      }
    } catch { /* no date to compare says nothing either way */ }
    const day = (iso) => {
      const d = new Date(iso);
      return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    };
    if (got && got.n) return set(`deploy ${got.n}${got.when ? ` · ${day(got.when)}` : ""}`, stale);
    // No number to be had. Say when this script was published instead.
    try {
      const r = await fetch("app.js", { method: "HEAD" });
      const lm = r.headers.get("last-modified");
      if (lm) return set(day(lm), stale);
    } catch {}
    if (stale) set("", true);
  }

  window.addEventListener("hashchange", route);
  $("#out").addEventListener("click", () => { store.set(null); S.me = S.personas = S.docs = null; location.hash = "#/"; signin(); });
  route();
  stamp();
})();
