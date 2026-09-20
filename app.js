/* The case room. Static; talks only to Supabase Auth and the student API.
   Nothing about time, caps or entitlement is computed here: every figure
   comes from the API, which reads it from the engine. */
(function () {
  const C = window.FB;
  const $ = (s, r = document) => r.querySelector(s);
  const view = $("#view");
  const S = { me: null, personas: null, interviews: null, docs: null, poll: null, age: null, wake: null, voice: null, kb: null };

  // A finger, not a pointer. Everything that differs on a phone or a tablet —
  // what Enter does, what the keyboard covers, how big a target has to be —
  // is decided here once rather than guessed from the screen width, because a
  // narrow window on a laptop is still a laptop.
  const COARSE = !!(window.matchMedia && window.matchMedia("(pointer:coarse)").matches);

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
  /**
   * A closed course leaves the case page and nothing else. Every other
   * destination is taken away rather than offered and then refused: the
   * exercise is over, and a link that answers "this course has closed" three
   * times in a row is worse than no link.
   *
   * Cosmetic only. The rule is the server's — the API answers `course_closed`
   * on everything but the case page and the onboarding pack — because this is
   * a static file and an address bar is not a locked door.
   */
  const SHUT = (m) => !!m && (m.edition.status === "closed" || m.edition.status === "archived");
  function nav(key) {
    menu.show(true);
    const shut = SHUT(S.me);
    document.querySelectorAll("[data-nav]").forEach((a) => {
      a.toggleAttribute("aria-current", a.dataset.nav === key);
      const off = shut && a.dataset.nav !== "landing";
      a.classList.toggle("off", off);
      if (off) { a.setAttribute("aria-disabled", "true"); a.setAttribute("tabindex", "-1"); }
      else { a.removeAttribute("aria-disabled"); a.removeAttribute("tabindex"); }
    });
  }
  function recording(name) { const r = $("#rec"); r.hidden = !name; $("#rec-name").textContent = name || ""; menu.show(!name); }

  /**
   * The navigation, and on a phone the button that holds it.
   *
   * One owner for both: the links and the button are shown and hidden
   * together, because there is no state in which one of them is right on its
   * own — signed out there is nowhere to go, and while an interview is live
   * the destinations are deliberately taken away rather than offered beside a
   * conversation that does not reopen.
   *
   * Whether the button is USED is the stylesheet's decision, not this code's:
   * it is displayed by the breakpoint alone. So there is no width to test
   * here and nothing to recompute on a resize — only the open class to clear
   * on the way out of the phone layout, so a rotation into landscape cannot
   * leave the pointer bar carrying a phone's state.
   */
  const menu = (() => {
    const btn = $("#navtoggle"), bar = $(".hdr"), panel = $("#nav");
    const open = () => btn.getAttribute("aria-expanded") === "true";
    const set = (on) => { bar.classList.toggle("navopen", on); btn.setAttribute("aria-expanded", on ? "true" : "false"); };
    btn.addEventListener("click", () => set(!open()));
    // Anything acted on in the panel closes it — including a link to the page
    // already on screen, which changes no hash and so fires no route.
    panel.addEventListener("click", (e) => { if (e.target.closest("a,button")) set(false); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !open()) return;
      set(false); btn.focus();            // back to what was pressed, not to the top of the page
    });
    // A tap anywhere off the masthead is a dismissal, the way a menu behaves
    // everywhere else. The panel is a child of the header, so its own taps
    // are excluded by the same test.
    document.addEventListener("pointerdown", (e) => { if (open() && !e.target.closest(".hdr")) set(false); });
    window.matchMedia("(max-width:720px)").addEventListener("change", (e) => { if (!e.matches) set(false); });
    return {
      close: () => set(false),
      show: (on) => { btn.hidden = !on; panel.hidden = !on; if (!on) set(false); },
    };
  })();
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
  /**
   * The year after a record's name, unless the name already says it. Half of
   * this case's papers are titled "… at 30 August 2026", and appending the year
   * to those gave "… at 30 August 2026 · 2026".
   */
  const yearTail = (d) => (d.doc_year && !String(nameEn(d)).includes(String(d.doc_year)) ? ` \u00b7 ${d.doc_year}` : "");

  /**
   * A record's name with a trailing date clause taken off.
   *
   * For a row of links only. Three titles ending "at 30 August 2026" side by
   * side is three-quarters date and none of it distinguishes them — and the
   * one paper in the row that has no date, the family tree, is the one a
   * reader's eye then goes to for the wrong reason. The record's own page and
   * the case file keep the filed title whole, because that is what is printed
   * on the paper and what a team will quote.
   */
  const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
  const shortName = (d) => String(docName(d) || d.code || "")
    .replace(new RegExp(String.raw`\s+(?:at|as at|as of|of)\s+\d{1,2}\s+(?:${MONTHS})\s+\d{4}\s*$`, "i"), "")
    // The day has to be part of this pattern too: without it "…the advisers,
    // 8 September 2026" lost the month and the year and kept the 8.
    .replace(new RegExp(String.raw`,?\s+(?:\d{1,2}\s+)?(?:${MONTHS})\s+\d{4}\s*$`, "i"), "")
    .replace(/[,;:\s]+$/, "")
    .trim();
  // The strip on the interviews page reads four names in a row, so each is the
  // head of its title: what stands before the first comma, once the date is
  // gone. "Share register, Wästberg Transport AB, extract at …" is one paper
  // among four there, and "Share register" is what a team scans for. The
  // full title stays on the record's page and in the case file.
  const headName = (d) => shortName(d).split(",")[0].trim() || shortName(d);
  /**
   * The opening of a brief, cut at a sentence where there is one and at a word
   * where there is not. The card carries enough to choose on; the whole brief
   * is one click away, on the page before the conversation.
   */
  const snippet = (t, n) => {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    if (stop > n * 0.45) return cut.slice(0, stop + 1);
    const word = cut.lastIndexOf(" ");
    return (word > 0 ? cut.slice(0, word) : cut) + "\u2026";
  };
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
    // The case's palette rides down with this row. Caching it is what lets the
    // NEXT first paint be right — this one has already happened — and
    // repainting now is what makes a palette an instructor changed mid-seminar
    // arrive within fifteen seconds rather than at the next reload.
    if (window.FBTheme && S.me.theme) { window.FBTheme.cache(S.me.theme); window.FBTheme.paint(); }
    lightswitch();
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

  /**
   * The footer's light switch.
   *
   * Hidden until a palette has been served, because until then there is no
   * dark one to switch to and a dead control is worse than no control. Three
   * states rather than two: a student can take the decision (light, dark) or
   * hand it back to the course (auto), and handing it back matters most under
   * the "after dark" policy, where the right answer changes during the
   * evening a team is working.
   *
   * The label says what pressing it will do. The current state needs no label:
   * it is the page.
   */
  /**
   * Appearance, as three named choices.
   *
   * It was one button that cycled and showed the NEXT state — "· the course
   * setting" — which reads as a label for what is currently true and is not.
   * Three choices with the current one marked says the same thing without
   * anyone having to work out which it means.
   *
   * "Default" rather than "auto" or "the course setting": what it does is hand
   * the decision back, and the instructor's setting is the default in the
   * ordinary sense of the word.
   */
  function lightswitch() {
    const wrap = $("#appearance"); if (!wrap || !window.FBTheme) return;
    const policy = window.FBTheme.policy();
    // Hidden until a palette has been served: until then there is no dark one
    // to switch to, and a dead control is worse than no control.
    wrap.hidden = !policy;
    if (!policy) return;
    const now = window.FBTheme.choice();
    const opts = [["auto", "default"], ["dark", "dark"], ["light", "light"]];
    wrap.innerHTML = `<span class="aplabel">Appearance</span>`
      + opts.map(([v, lab]) =>
          `<button type="button" class="lightswitch${v === now ? " on" : ""}" data-v="${v}"`
          + ` aria-pressed="${v === now}">${lab}</button>`).join("");
    wrap.title = now === "auto"
      ? `Following the course, which right now is ${window.FBTheme.isDark() ? "dark" : "light"}.`
      : `This device is set to ${now}, whatever the course says.`;
    wrap.onclick = (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      window.FBTheme.set(b.dataset.v); lightswitch();
    };
  }
  function stopPoll() {
    if (S.poll) { clearInterval(S.poll); S.poll = null; }
    if (S.age) { clearInterval(S.age); S.age = null; }
    if (S.wake) {
      document.removeEventListener("visibilitychange", S.wake);
      window.removeEventListener("focus", S.wake);
      S.wake = null;
    }
  }


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
   * Accuracy on names is poor and there is no vocabulary hint in the API, which
   * is why the transcript lands in an editable box rather than going to the
   * persona, and why pressing stop sends the dictated span to the server for a
   * pass against the case's own vocabulary (see the tidy pass below). The
   * listening itself is still the browser's; if the recognition ever moves
   * server-side, neither this flag nor the admin toggle changes.
   */
  const VOICE = {
    idle: "Please speak in English. Chrome, Edge and Safari can listen; Firefox cannot.",
    listening: "Listening. Your words arrive punctuated, a moment behind your voice — press the button again when you have finished.",
    // Failure used to say nothing at all, which is how a correction that never
    // ran looked identical to one that ran and found nothing to change. These
    // name what happened, so "it doesn't work" has an answer — and either way
    // the words still reach the box, only rough.
    rough: "Words are landing uncorrected — punctuation and names are not being checked. Read it before you send.",
    tidyOff: "The words land as heard: this course run has voice correction switched off.",
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
          if (res.isFinal) hear(res[0].transcript); else pending += res[0].transcript;
        }
        say(pending || VOICE.listening, pending ? "interim" : "live");
      };
      r.onerror = (ev) => {
        if (ev.error === "aborted" || ev.error === "no-speech") return;
        manualStop = true;
        // The words heard before it failed are still the student's, so they are
        // still worth correcting: ended() runs the tidy pass, and its own
        // notice replaces this one only if it has something to say.
        ended(ev.error === "not-allowed" || ev.error === "service-not-allowed" ? VOICE.blocked
          : ev.error === "network" ? VOICE.network : VOICE.failed);
      };
      r.onend = () => {
        if (manualStop) { ended(); return; }
        // Not the student's doing: the engine gave up on a silence. Restart it,
        // and if the restart will not take, the run is over and the words in
        // the box need the same tidy as a run the student ended themselves.
        try { r.start(); } catch { ended(); }
      };
      manualStop = false;
      try {
        r.start(); rec = r; listening = true; say(VOICE.listening, "live");
        placed = ""; held = null;
      } catch { say(VOICE.failed, "bad"); }
      paint();
    }
    // ── the correction, which the student never has to think about ────────
    //
    // A phrase is NOT written into the box as it is heard. It is sent to the
    // server — which knows the case's names — and only the corrected version
    // is appended. So the box holds finished text at every moment: nothing
    // appears wrong and is then fixed, there is no second step to press and
    // nothing to undo.
    //
    // That is the third design here and the first intuitive one. Correcting on
    // stop meant a student watched raw words pile up and then change under
    // them, and the honest answer to "when does it land?" was "when you press
    // the button again" — which is a thing to learn, and therefore wrong.
    // People expect dictation to put correct words on the screen while they
    // talk, so that is what this does.
    //
    // The cost is that the box lags a second or so behind the voice. What is
    // being heard right now shows in the line underneath, where interim text
    // has always gone — so the lag reads as the transcript catching up rather
    // than as nothing happening.
    //
    // A phrase is held until the NEXT one arrives, because the end of a
    // fragment cannot be punctuated without knowing what follows it. A
    // recogniser finalises "who signed the agreement" as a complete-looking
    // question; only "in nineteen ninety five" reveals that it was not one.
    // Punctuating on arrival produced exactly that — "Who signed the
    // agreement? in 1995?" — so each phrase is sent with the corrected text
    // before it AND the raw phrase after it, and the last one is released when
    // the student stops, which is when "nothing follows" becomes true.
    //
    // The cost is that the box trails one phrase behind rather than one
    // second. The gain is that it is right, and that nothing ever changes once
    // it is on the screen.
    //
    // A phrase whose correction fails is appended exactly as heard: a word is
    // never lost to a network.
    let placed = "";        // what this run has put in the box, corrected
    let held = null;        // a phrase waiting to learn what comes after it
    let queue = Promise.resolve();

    function hear(phrase) {
      const raw = phrase.trim();
      if (!raw) return;
      if (held !== null) release(held, raw);
      held = raw;
    }

    /** Send one phrase, knowing both sides of it, and append what comes back. */
    function release(raw, next) {
      const context = placed;
      queue = queue.then(async () => {
        let text = raw;
        try {
          const r = await post("/dictation/tidy", { text: raw, context, next });
          const clean = (r && typeof r.text === "string" ? r.text : "").trim();
          if (clean) text = clean;
          else say(VOICE.rough, "bad");
        } catch (e) {
          // The words still reach the box; only the polish is missing, and the
          // student is told which it was rather than left to wonder.
          say(e && e.code === "voice_disabled" ? VOICE.tidyOff : VOICE.rough, "bad");
        }
        append(text);
        placed = (placed ? placed + " " : "") + text;
      });
    }

    /**
     * The run is over, however it ended — the button, the engine giving up on
     * a silence and refusing to restart, or an error. All three land here so
     * the button always releases and the notice always settles.
     *
     * Corrections still in flight are left alone: they will put their words in
     * the box on their own, and the notice waits for them rather than
     * announcing "ready" over the top of a phrase still arriving.
     */
    function ended(note) {
      listening = false; rec = null; paint();
      // Stopping is what makes "nothing follows" true, so the held phrase can
      // finally be closed — with a full stop or a question mark, as it needs.
      if (held !== null) { release(held, ""); held = null; }
      queue.then(() => { if (!listening) say(note || VOICE.idle, note ? "bad" : undefined); });
    }

    function stop() {
      manualStop = true;
      if (rec) { try { rec.stop(); } catch {} }
      ended();
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
      rec = null; listening = false; placed = ""; held = null; say(null);
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
    stopPoll(); recording(null); menu.show(false);
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
        ? "<strong>This course is closed.</strong> The onboarding pack below stays open to read. Everything else \u2014 the interviews, the desks, the rest of your file and your transcripts \u2014 has been put away."
        : "<strong>This course has not opened yet.</strong> Your file and the interviews open when your instructor opens it.";
    }
    // The notice the instructor's press produces. It says what the documents
    // are, not only that they exist — a team that has not met them yet has no
    // way to know an "engagement document" is the advisers' own report — and
    // it links to the place they are, filtered to them, so the sentence and
    // the click agree.
    //
    // It stays until it is dismissed. A notice that goes away on its own is
    // one a team can miss entirely by reloading at the wrong moment, and this
    // is the one announcement in the course that changes what they can read.
    // The dismissal is remembered per edition, so a second release in another
    // course is announced again.
    if (me.engagement_released) {
      const box = $("#ld-released");
      const key = `fb.seen.engagement.${me.edition.code}`;
      let seen = false; try { seen = localStorage.getItem(key) === "1"; } catch {}
      box.hidden = seen;
      box.innerHTML = `<div class="notice-body"><strong>The engagement documents have been released.</strong>`
        + ` These are the advisers' own memoranda: what the engagement found, written up question by question.`
        + ` <a href="#/file/stage/engagement_only">Read them in your case file</a>.</div>`
        + `<button type="button" class="notice-x" aria-label="Dismiss this notice">\u00d7</button>`;
      box.querySelector(".notice-x").addEventListener("click", () => {
        box.hidden = true;
        try { localStorage.setItem(key, "1"); } catch {}
      });
    }
    $("#ld-films").innerHTML = p.videos.length
      ? `<div class="films">${p.videos.map((v) => `<figure class="film">${v.title ? `<div class="ttl">${esc(v.title)}</div>` : ""}<div class="embed"><iframe src="${esc(v.embed_url)}" title="${esc(v.title || "Film")}" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin"></iframe></div>${v.caption ? `<figcaption class="cap">${esc(v.caption)}</figcaption>` : ""}</figure>`).join("")}</div>`
      : "";
    $("#ld-history").innerHTML = p.history ? prose(p.history) : "";
    const total = d.pack.reduce((a, x) => a + x.n, 0);
    if (total) {
      $("#ld-pack").hidden = false;
      $("#ld-packnote").textContent = p.pack_note || "What the family, its companies and the public registers would hand you on the first day.";
      // The papers themselves, not a count of them. A team lands here and the
      // pack is the first thing it is meant to read; a folder name with a
      // number beside it tells them something is there and makes them go and
      // look for it. Each row goes to the record's own page, where the blurb
      // and the provenance are and where opening it signs a URL — so this
      // names what the team already holds and grants nothing.
      const byFolder = new Map();
      for (const doc of d.pack_docs || []) {
        const key = doc.folder || "Papers";
        if (!byFolder.has(key)) byFolder.set(key, []);
        byFolder.get(key).push(doc);
      }
      // Folded, and shut. Eleven papers listed open is a wall on the page a
      // team lands on; three folders they can open is an index. The count
      // stays on the summary so a shut folder still says how much is in it.
      $("#ld-packlist").innerHTML = byFolder.size
        ? [...byFolder].map(([folder, docs]) => `<li class="packgrp"><details>
            <summary><span class="fname">${esc(folder)}</span><span class="n">${docs.length}</span></summary>
            <ul class="packdocs">${docs.map((doc) => `<li><a href="#/file/${esc(doc.code)}">
              <span class="code">${esc(doc.code)}</span>
              <span class="ttl">${esc(docName(doc))}${yearTail(doc)}</span>
            </a></li>`).join("")}</ul></details></li>`).join("")
        // No per-document list served: fall back to what the page used to show
        // rather than an empty box.
        : d.pack.map((x) => `<li><span>${esc(x.folder || "Papers")}</span><span class="n">${x.n}</span></li>`).join("");
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
      ? "This course has closed. The onboarding pack on the case page stays open to read; nothing else does."
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
    // On a soft keyboard there is no Shift+Enter, so taking Enter for send
    // would leave a student with no way to write a second paragraph — and the
    // Send button is already under their thumb. Enter stays a newline there.
    if (COARSE) return;
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

  /**
   * The composer, kept above the keyboard.
   *
   * A phone does not resize the page when the keyboard comes up: it shrinks
   * the visual viewport and leaves the layout alone, so the Send button ends
   * up behind the keys with nothing on screen saying so. visualViewport is
   * the only thing that reports the change, so the field is brought back into
   * view on focus and on every resize while it holds focus.
   *
   * One listener at a time: a team moves between rooms all session, and a
   * listener per visit would still be running after the tenth.
   */
  function keyboardAware(el) {
    if (S.kb) { window.visualViewport?.removeEventListener("resize", S.kb); S.kb = null; }
    if (!COARSE || !el) return;
    const bring = () => el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.addEventListener("focus", () => setTimeout(bring, 260));
    S.kb = () => { if (document.activeElement === el) bring(); };
    window.visualViewport?.addEventListener("resize", S.kb);
  }

  /**
   * Hold the screen awake while a person is speaking.
   *
   * An answer takes the better part of a minute to arrive. A phone left alone
   * for that long locks itself, the stream is suspended mid-sentence and the
   * turn is lost — so the lock is held for exactly as long as the answer is
   * being spoken, and released the moment it lands. Unsupported everywhere it
   * matters less; unsupported browsers get the old behaviour.
   */
  async function holdScreen() {
    try { return await navigator.wakeLock?.request("screen") || null; } catch { return null; }
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
    const cls = p.state === "in_progress" ? "live" : p.state === "completed" || p.state === "declined" ? "spent" : shut ? "shut" : "";
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
      : { not_started: "not yet interviewed", in_progress: "conversation running", completed: "conversation held", declined: "declined to be interviewed" }[p.state] || p.state;
    const mins = p.budget && p.budget.virtual_minutes ? `${p.budget.virtual_minutes} minutes` : "";
    // A conversation that is running is the one case where the card goes
    // straight through: mid-interview the room is where a team wants to be,
    // and a preparation page in front of it costs them the clock. Every other
    // state lands on the person's own page, because that page carries the
    // dossier — the records the case says bear on this person, which are as
    // worth reading after a conversation as before one, and are the only
    // thing the page can give a team about someone who refused. The transcript
    // is one click on from there.
    const href = p.state === "in_progress" ? `#/room/${p.session_id}` : `#/interview/${p.code}`;
    // "Transcript" and not "Records and transcript": two words wrapped the row,
    // and the records are the page this lands on rather than a second place to
    // go. A refusal has no transcript, so that one says what it does have.
    const label = { in_progress: "Return to the room", completed: "Transcript", declined: "The records" }[p.state]
      || "Begin the interview";
    const action = shut
      ? `<span class="pbtn off">${interviewsOpen ? "None left" : "Not open yet"}</span>`
      // A refusal has no primary action to offer, so its door is a quiet one:
      // there is nothing to begin and no conversation to return to, only the
      // papers. The other three states each have something to do.
      : `<a class="pbtn${p.state === "declined" ? " quiet" : ""}" href="${href}"${p.state === "declined" && p.declined && p.declined.message ? ` title="${esc(p.declined.message)}"` : ""}>${label}</a>`;
    // Direct access: the CV of someone you may interview is yours, so the button
    // fetches the file rather than sending you to a desk to ask for it.
    const cv = p.cv
      ? `<button type="button" class="pbtn quiet cv-get" data-code="${esc(p.cv.code)}" data-name="${esc(p.name)}">CV (PDF)</button>`
      : "";
    return `<article class="person ${cls}" data-group="${esc(groupOf(p))}" data-branch="${esc(p.branch || "")}">
      ${face}
      <div class="pbody">
        <h3 class="pname">${esc(p.name)}</h3>
        ${facts.length ? `<p class="pfacts">${facts.map(esc).join(" · ")}</p>` : ""}
        ${p.role ? `<p class="prole">${esc(p.role)}</p>` : ""}
        ${p.brief ? `<p class="pbrief">${esc(snippet(p.brief, 210))}</p>` : ""}
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
          + ` — one conversation each, and none of them reopens, so choose before you knock.`
        : `Everyone the family has agreed you may speak with. Your team may hold <strong>${bs.budget}</strong> of these conversations`
          + ` — one with each person, and none of them reopens, so choose before you knock.`;
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
      const declined = ps.filter((p) => p.state === "declined").length;
      $("#n-people").textContent = ps.length;
      $("#n-held").textContent = held;
      $("#n-left").textContent = ps.length - held - declined;
    }

    // Two filters rather than one, because a team choosing twelve of
    // twenty-six is asking two different questions: who is of this generation,
    // and who sits in this branch. They combine — a chip in each bar narrows to
    // the intersection, and "everyone" in a bar drops that question again.
    // Both are built from the people who are actually there: one chip per
    // generation the case knows, and one for everybody outside the family tree
    // — the board and the management, who belong to no generation of it.
    let fGen = "", fBranch = "";
    const applyFilter = () => {
      document.querySelectorAll("#roster .person").forEach((el) => {
        el.hidden = (!!fGen && el.dataset.group !== fGen)
                 || (!!fBranch && el.dataset.branch !== fBranch);
      });
    };
    const chipbar = (bar, chips, all, pick) => {
      if (!bar || !chips.length) return;
      bar.hidden = false;
      bar.innerHTML = `<button type="button" class="gen on" data-v="">${esc(all)}</button>`
        + chips.map(([v, lab]) => `<button type="button" class="gen" data-v="${esc(v)}">${esc(lab)}</button>`).join("");
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("button.gen"); if (!b) return;
        bar.querySelectorAll("button.gen").forEach((x) => x.classList.toggle("on", x === b));
        pick(b.dataset.v || ""); applyFilter();
      });
    };
    const gens = [...new Set(ps.map((p) => p.generation).filter(Boolean))];
    const independents = ps.filter((p) => !p.generation).length;
    if (gens.length > 1 || (gens.length && independents)) {
      chipbar($("#gen-filter"),
        gens.map((g) => [`gen:${g}`, /^\d+$/.test(String(g)) ? `Generation ${g}` : String(g)])
          .concat(independents ? [["independent", "Independent"]] : []),
        "Everyone", (v) => { fGen = v; });
    }
    // Branch is the other axis the case is built on, and it is already on the
    // card. One branch is not a filter, so the bar appears only where there are
    // several.
    const branches = [...new Set(ps.map((p) => p.branch).filter(Boolean))].map(String).sort();
    if (branches.length > 1) {
      chipbar($("#branch-filter"),
        branches.map((b) => [b, /^(branch|gren)\b/i.test(b) ? b : `Branch ${b}`]),
        "Every branch", (v) => { fBranch = v; });
    }

    // The orientation papers, one click from the roster. The family tree first,
    // because twenty-odd people across several branches and six generations is
    // not a list anybody holds in their head; then the papers filed beside it,
    // because choosing whom to spend an hour with is a question about who owns
    // what and who sits where, and those are the pages that answer it. Links
    // are safe on this page — it is only in the room that leaving would cost a
    // team what it has heard.
    //
    // Derived as "the pack's papers filed with the family tree" rather than
    // named here. This site runs whatever case it is pointed at, and a list of
    // four codes would be four codes about one case; a case that files its
    // genogram alongside its structure papers gets all of them, and a case
    // that files it alone gets just the tree.
    orientationDocs().then((docs) => {
      const el = $("#case-tree"); if (!el || !docs.length) return;
      el.innerHTML = `<p class="label">The papers to read first</p>`
        // A record with no English title would otherwise render an empty link.
        // A case may give the strip its own word for a paper; else the head of the title.
        + docs.map((d) => `<a href="#/file/${esc(d.code)}">${esc((d.read_first_label || "").trim() || headName(d))}</a>`)
              .join('<span class="sep">\u00b7</span>');
      el.hidden = false;
    });

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
  async function file(at, atStage) {
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
      `<div class="docitem" id="row-${esc(d.code)}" data-find="${esc(findable(d))}" data-kind="${esc(d.doc_class || "other")}" data-stage="${esc(d.release_stage || "")}" data-new="${d.first_opened ? "" : "1"}">${
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
    // The engagement is a chip of its own, beside the kinds rather than among
    // them. It is not a kind of record — the advisers' memoranda happen to be
    // memoranda, and a case could write them as letters — it is the one
    // release the instructor makes by hand, and after the press it is the
    // thing a team goes looking for. Offered only once the file holds some,
    // which is the same as saying only once it has been released.
    const engaged = rows.filter((r) => r.dataset.stage === "engagement_only").length;
    // The stage the notice's link asks for, if it asked for one it can fill.
    let pick = atStage && rows.some((r) => r.dataset.stage === atStage) ? `stage:${atStage}` : "";
    if (rows.length) {
      const bar = $("#doc-kinds");
      if (kinds.length > 1) {
        bar.hidden = false;
        const chip = (v, label, n) =>
          `<button type="button" class="gen${v === pick ? " on" : ""}" data-pick="${esc(v)}">${esc(label)} · ${n}</button>`;
        bar.innerHTML = chip("", "Everything", rows.length)
          + kinds.map((k) => chip(`kind:${k}`, kindName[k] || k.replace(/_/g, " "), tally[k])).join("")
          + (engaged ? chip("stage:engagement_only", stage.engagement_only, engaged) : "")
          + (unopened && unopened < rows.length ? chip("new", "Not yet opened", unopened) : "");
      }
      $("#doc-filter").hidden = false;
      const q = $("#doc-q");
      const apply = () => {
        const terms = fold(q.value).split(/\s+/).filter(Boolean);
        let shown = 0;
        for (const r of rows) {
          const kindOk = !pick
            || (pick === "new" ? !!r.dataset.new
              : pick.startsWith("stage:") ? r.dataset.stage === pick.slice(6)
              : r.dataset.kind === pick.slice(5));
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
    // The registrar is not on this page. She had a card in the right-hand
    // column, and before that an inline form for writing to her; both are gone
    // now that the document desk is a section of the site in its own right.
    // A team asks her for a record at her desk, in a conversation she
    // remembers, and the papers she releases arrive in this list. The page is
    // the list, and the lede says where to go when what you want is not on it.
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

  /**
   * The case's family tree, if it has one and the team holds it. Matched on the
   * code and on the title rather than named here: this site runs whatever case
   * it is pointed at, and not every case has a tree.
   */
  async function genoDoc() {
    try { return (await documents()).find((d) => /genogram/i.test(d.code) || /genogram/i.test(docName(d))) || null; }
    catch { return null; }
  }

  /**
   * What a team should read before it chooses whom to interview: the family
   * tree, and whatever the case files with it.
   *
   * The tree leads because it is the one paper nobody can hold in their head.
   * The rest are its folder-mates — in the reference case the boards, the group
   * structure and the shareholder schedule, which is exactly the set — found by
   * the folder rather than by name so that this stays true of a case nobody has
   * written yet. Empty when the case has no tree, in which case the row does
   * not appear at all.
   */
  async function orientationDocs() {
    const ds = await documents();
    // A case that names its papers (documents.read_first, in order) is taken
    // at its word. The list is already what this team can reach, so a paper
    // named but not yet released simply is not here. A case that names none
    // keeps the older rule: the tree and whatever is filed beside it — a rule
    // that gave a case filing its tree alone, with the will, a strip of one.
    const named = ds.filter((d) => Number.isInteger(d.read_first) && d.read_first > 0)
      .sort((a, b) => a.read_first - b.read_first || String(a.code).localeCompare(String(b.code)));
    if (named.length) return named;
    const tree = await genoDoc();
    if (!tree) return [];
    const kin = tree.folder ? ds.filter((d) => d.folder === tree.folder && d.code !== tree.code) : [];
    return [tree, ...kin];
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
      const tree = await genoDoc();
      if (tree) bits.push(`<a href="#/file/${esc(tree.code)}">${esc(docName(tree) || "The family tree")}</a>`);
      el.innerHTML = bits.length ? bits.join('<span class="sep">·</span>') : "";
    })();
    // The same portrait and the same few facts as the roster: this is the last
    // page before a conversation that does not reopen.
    $("#c-portrait").innerHTML = p.portrait_url
      ? `<img class="portrait" src="${esc(p.portrait_url)}" alt="${esc(p.name)}">`
      : `<div class="portrait none" aria-hidden="true">${esc(initials(p.name))}</div>`;
    $("#c-facts").textContent = personFacts(p).join(" · ");
    // The engine's two numbers, and only while the block that names them is on
    // the page: after a conversation the block is rewritten and they are gone.
    const put = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    put("#c-virtual", p.budget.virtual_minutes ?? "–"); put("#c-wall", p.budget.wall_minutes ?? "–");
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

    // A refusal already given: the answer stands, and the button is not offered
    // twice. The words are the person's own, as recorded the first time.
    const declined = (msg) => {
      // Not a greyed-out "Begin the conversation": there is no conversation to
      // begin, and a disabled button still offers one. It goes.
      $("#c-go").hidden = true; $("#c-go").disabled = true;
      $("#c-err").innerHTML = `<span class="declined">${esc(p.name)} has declined to be interviewed.</span>`
        + (msg ? ` <q>${esc(msg)}</q>` : "")
        + ` <span class="muted">Nothing was spent. What you learn about ${esc(p.name.split(" ")[0])} comes from the others, and from the records.</span>`;
    };
    if (p.state === "declined") declined(p.declined && p.declined.message);

    // A conversation that is already running, or already held, is not an error
    // to report on this page: it is a door. The button becomes that door
    // rather than offering to open a room that cannot be opened twice.
    //
    // The page is NOT skipped for it. Its records list — what the case says is
    // worth putting to this person, and what the team would have to ask the
    // registry for by name — is worth as much during a conversation as before
    // one, and a redirect would take it away to fix a button.
    const going = p.session_id && (p.state === "in_progress" ? `#/room/${p.session_id}`
      : p.state === "completed" ? `#/transcripts/${p.session_id}` : null);
    if (going) {
      $("#c-go").textContent = p.state === "in_progress" ? "Return to the room" : "Read the transcript";
      $("#c-go").dataset.go = going;
      // A team that has spent its last conversation had this button disabled a
      // few lines up, which is right while it opens a room and wrong now that
      // it is a door to something already held. Spending the budget does not
      // take back what the team heard.
      $("#c-go").disabled = false;
    }
    // Three states, three headings, and a block that is true in each. The
    // "before" copy stays in the template because that is the state a team
    // meets first and most often; the other two are written over it. What the
    // page says about the conversation changes; what it holds about the person
    // does not, and that is the point of coming back to it.
    if (p.state === "completed" || p.state === "in_progress" || p.state === "declined") {
      put("#c-kicker", p.state === "in_progress" ? "The conversation"
        : p.state === "declined" ? "Instead of the conversation" : "After the conversation");
      put("#c-back", "Back to the people");
      // What is left of the team's budget is a sentence about a room that will
      // open. No room opens from here any more, so it is not one of the things
      // this page still has to say.
      put("#c-budget", "");
      // The refusal is the message of this page, not a complaint about a click,
      // so on arrival it reads before the way out rather than under it. The
      // element keeps its place in the template for the other case: a refusal
      // discovered at the moment of opening, which belongs after the button
      // that was just pressed.
      if (p.state === "declined") {
        const err = $("#c-err"), bar = err && err.parentNode.querySelector(".toolbar");
        if (err && bar) bar.parentNode.insertBefore(err, bar);
      }
      const box = $("#c-prose");
      if (box) box.innerHTML = p.state === "in_progress"
        ? "<p>Your team's conversation with this person is open. The room is where the clock is —"
          + " this page is not, so read what you need here and go back to it.</p>"
          + "<p>There is no live transcript: take notes.</p>"
        : p.state === "declined"
        // The refusal, and that nothing was spent for it, are both stated below
        // in this person's own words. Neither is said twice here. This block is
        // about the one thing the page still has to offer: the papers.
        ? "<p>The records below are what the case says bears on this person — still yours to read,"
          + " and still yours to ask the registry for by name.</p>"
        : "<p>Your team's one conversation with this person has been held. It does not reopen, and the"
          + " transcript was released when it ended.</p>"
          + "<p>The records below stay with you. What the case says is worth putting to this person is"
          + " worth as much once you have heard them as it was before — and anything you did not ask for"
          + " then, you can still ask the registry for by name.</p>";
    }

    $("#c-go").addEventListener("click", async () => {
      const b = $("#c-go");
      if (b.dataset.go) { location.hash = b.dataset.go; return; }
      b.disabled = true;
      try {
        const r = await post("/sessions", { persona_code: code }); S.personas = null;
        try { if (r.opening_line) sessionStorage.setItem(`fb.opening.${r.session_id}`, r.opening_line); } catch {}
        location.hash = `#/room/${r.session_id}`;
      }
      catch (err) {
        if (err.code === "declined" || err.code === "declined_closed") { S.personas = null; declined(err.message); return; }
        // The roster this tab is holding can be older than the truth — a
        // teammate on another device opens the room, and this tab still thinks
        // nothing has started. The engine says which session it means, so go
        // there rather than printing a sentence with no way out of it. The
        // roster is dropped on the way so the next page is drawn from the
        // state that just corrected us.
        const sid = err.body && err.body.session_id;
        if (sid && (err.code === "already_open" || err.code === "already_held")) {
          S.personas = null;
          location.hash = err.code === "already_open" ? `#/room/${sid}` : `#/transcripts/${sid}`;
          return;
        }
        $("#c-err").textContent = err.message; b.disabled = false;
      }
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

  /**
   * The line under the window figure that cannot go stale.
   *
   * "76 min" is only true at the instant the server computed it, and a phone
   * that sleeps through a coffee break wakes holding that number as though it
   * were now. A closing time is a fact about the appointment rather than about
   * the reading, so it stays true however long the tab was away — and when the
   * reading itself is old, because a poll failed or the tab was suspended, the
   * line says so rather than let a confident figure stand in for a current
   * one. The age is the only arithmetic the page does here: how old its own
   * reading is, which is a fact about the page and not about the interview.
   */
  function clockLine(clock) {
    if (!clock) return "";
    const bits = [];
    if (clock.closesAt) bits.push(`closes ${clock.closesAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`);
    const age = Math.round((Date.now() - clock.readAt) / 1000);
    if (age >= 90) bits.push(`read ${Math.max(2, Math.round(age / 60))} min ago`);
    return bits.join(" · ");
  }

  function ring(id, frac) {
    const el = $(id); const r = Number(el.getAttribute("r")); const c = 2 * Math.PI * r;
    el.setAttribute("stroke-dasharray", c.toFixed(1)); el.setAttribute("stroke-dashoffset", (c * (1 - Math.max(0, Math.min(1, frac)))).toFixed(1));
  }
  function showState(st, name, wallTotal, clock) {
    const note = $("#k-note"); if (!note) return;
    const closes = $("#k-closes");
    if (closes) closes.textContent = st.allowed ? clockLine(clock) : "";
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
    // The two papers a team wants open while it talks, and neither may cost it
    // the room: there is no live transcript, so a navigation away loses the
    // turns on screen. These arrive as files rather than routing to the case
    // file. Neither clock moves — the window is the server's, and virtual time
    // is spent only by asking.
    (async () => {
      const acts = $("#r-papers-acts"), card = $("#r-papers");
      if (!acts || !card) return;
      const papers = [];
      if (p.cv && p.cv.code) papers.push([p.cv.code, `${p.name} CV.pdf`, "Their CV (PDF)"]);
      const tree = await genoDoc();
      if (tree) papers.push([tree.code, `${docName(tree) || tree.code}.pdf`, "Family tree (PDF)"]);
      if (!papers.length) return;
      acts.innerHTML = papers.map(([, , lab], i) => `<button type="button" class="pbtn quiet" data-i="${i}">${esc(lab)}</button>`).join("");
      acts.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-i]"); if (!b) return;
        const [code, file] = papers[Number(b.dataset.i)];
        downloadDoc(code, file.replace(/[^\p{L}\p{N} .-]/gu, ""), b);
      });
      card.hidden = false;
    })();

    const box = $("#turns");
    // The conversation as it stands, so coming back to your own room is not the
    // same as losing it. A reload, a phone that dropped the tab, a teammate
    // arriving on another device: none of those taught anyone to take notes,
    // and the room already showed each exchange as it happened.
    //
    // Its own route, and not the transcript's: /sessions/:id/turns serves an
    // OPEN session only, so the transcripts page still cannot render a
    // conversation that has not ended. That distinction is the whole of rule 5
    // here, and it is the server that keeps it.
    //
    // The opening line is a turn row on the server, so the copy this tab
    // stashed when it opened the room would be a duplicate of the first thing
    // in this list. It is the fallback for when the read fails, not an
    // addition to it.
    let served = false;
    try {
      const t = await api(`/sessions/${id}/turns`);
      for (const tr of t.turns || []) {
        addTurn(box, tr.speaker === "interviewer" ? "you" : tr.speaker === "persona" ? (t.name || p.name) : "sys", tr.text);
      }
      served = true;
    } catch (err) {
      // The one refusal that is not a failure: the conversation ended between
      // the state read a moment ago and this one. Its transcript exists, so go
      // there rather than sit under a line that says the room is running and
      // wait thirty seconds for the poll to notice.
      if (err && err.code === "session_closed") { stopPoll(); S.personas = null; location.hash = `#/transcripts/${id}`; return; }
      console.warn("[room] scrollback unavailable", err && err.message);
    }
    if (!served) {
      let opening = null; try { opening = sessionStorage.getItem(`fb.opening.${id}`); } catch {}
      if (opening) addTurn(box, p.name, opening);
    }
    addTurn(box, "sys", served
      ? "The conversation so far is above. The transcript \u2014 searchable, and yours to download \u2014 is released when this one ends."
      : "The conversation is running. Take notes: the transcript is released when it ends.");
    const wallTotal = p.budget.wall_minutes || null;
    // ── the clock ────────────────────────────────────────────────────────
    // How much time is left is the server's to say and never the browser's to
    // work out, so the room re-reads it rather than counting down locally.
    // What changed is when it re-reads: every thirty seconds while the tab is
    // actually in front of someone, and once immediately on coming back,
    // because a phone suspends its timers the moment it is put in a pocket and
    // the figure it wakes holding is as old as the nap. The deadline itself
    // comes down with the reading, so the line beneath the number survives a
    // sleep that the number cannot.
    const clock = { closesAt: null, readAt: Date.now() };
    const takeClock = (env) => {
      if (env && "wall_expires_at" in env) clock.closesAt = env.wall_expires_at ? new Date(env.wall_expires_at) : null;
      clock.readAt = Date.now();
    };
    takeClock(st);
    showState(st.state, p.name, wallTotal, clock);
    let reading = false;
    const refresh = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        st = await api(`/sessions/${id}/state`);
        takeClock(st);
        showState(st.state, p.name, wallTotal, clock);
        if (st.session_state !== "open") { stopPoll(); S.personas = null; location.hash = `#/transcripts/${id}`; }
      } catch (err) {
        // The last reading stays on screen and is allowed to age. A figure
        // labelled old is honest; a blanked meter is alarming; a stale one
        // presenting itself as current is the only unacceptable one of the
        // three, and it is what this used to do — the failure was swallowed
        // and the clock simply stopped without saying so.
        console.warn("[room] clock read failed", err);
        showState(st.state, p.name, wallTotal, clock);
      } finally { reading = false; }
    };
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
    keyboardAware(q);
    // The hint belongs to the keyboard that has the keys for it.
    if (!COARSE) q.placeholder = "Your question — Enter sends, Shift+Enter for a new line";
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
      // Declared out here so the release in `finally` can reach it.
      let awake = null;
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
        awake = await holdScreen();
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
          //
          // This is the common failure on a phone — a locked screen, a call, a
          // tunnel — so it is answered precisely rather than with the generic
          // error. The partial answer stays on screen and is marked as partial,
          // and the student is told what they cannot see from here: the turn
          // reached the engine, so asking again spends a second question for an
          // answer they may already have.
          if (live) {
            // The student is told what it means for them; the console keeps
            // what it was, because since v1.12 every failure path here names
            // its own failure and a report of "it cut off" is otherwise
            // indistinguishable from a network drop, a 502 and a bad frame.
            console.warn("[room] stream cut mid-answer", streamErr);
            live.turn.classList.remove("speaking");
            live.turn.classList.add("cut");
            throw Object.assign(new Error(
              "The connection dropped while the answer was being spoken. What is above is partial \u2014 the rest is in the transcript when this interview ends. Asking again spends another question."),
              { code: "stream_cut" });
          }
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
        clock.readAt = Date.now();
        showState(r.state, p.name, wallTotal, clock); lastAnswerAt = Date.now();
        // The window opens with the first question, so until one is asked
        // there is no deadline to print. Read it now rather than leave the
        // line empty for the next half-minute.
        if (!clock.closesAt) void refresh();
        if (r.kind === "closed" || (r.state && !r.state.allowed && String(r.state.reason || "").startsWith("session_"))) setTimeout(() => { location.hash = `#/transcripts/${id}`; }, 1500);
      } catch (err) { $("#r-err").textContent = err.message; }
      finally {
        try { await awake?.release(); } catch { /* already gone with the tab */ }
        b.disabled = !st.state.allowed ? true : false;
        // Focusing the box on a phone throws the keyboard back up over the
        // answer that just arrived. Let them read it first.
        if (!COARSE) q.focus();
      }
    });
    $("#end").addEventListener("click", async () => {
      if (!confirm("End the conversation? It does not reopen. The transcript is released when it ends.")) return;
      try { await post(`/sessions/${id}/close`); S.personas = null; location.hash = `#/transcripts/${id}`; } catch (err) { $("#r-err").textContent = err.message; }
    });
    stopPoll();
    S.poll = setInterval(refresh, 30000);
    // Ageing the reading is cheap and touches one line of text, so it runs
    // whether or not the reads are succeeding — which is the case that needs
    // it.
    S.age = setInterval(() => { const el = $("#k-closes"); if (el && st.state.allowed) el.textContent = clockLine(clock); }, 15000);
    S.wake = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", S.wake);
    window.addEventListener("focus", S.wake);
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
    const list = $("#tr-list");
    const row = (s, hit) => `<a class="docrow" href="#/transcripts/${s.id}"><span class="code">${esc(s.closed_at ? s.closed_at.slice(0, 16).replace("T", " ") : "")}</span><span><div class="ttl">${esc(s.name)}</div><div class="prov">${s.turn_count} turns · ${esc(mins(Math.round(s.virtual_seconds / 60)))}</div>${hit || ""}</span><span></span><span class="st">${esc(s.state.replace("_", " "))}</span></a>`;
    if (!iv.length) {
      list.innerHTML = `<div class="empty"><span class="tag">none yet</span><p>A transcript appears here when a conversation ends.</p></div>`;
      return;
    }
    list.innerHTML = `<div class="doclist">${iv.map((s) => row(s)).join("")}</div>`;
    $("#tr-tools").hidden = false;

    // Every transcript, fetched once and kept for the visit. A team writing its
    // report holds a dozen of these and needs the one place somebody said
    // "Vetlanda" — which is a search, not twelve readings. The fetch waits until
    // the team asks for it, so arriving at this page stays one request. Four at
    // a time: enough to be quick, few enough not to queue behind itself.
    let all = null;
    const note = (t) => { const el = $("#tr-count"); if (el) el.textContent = t; };
    async function loadAll(saying) {
      if (all) return all;
      note(saying);
      const out = [];
      for (let i = 0; i < iv.length; i += 4) {
        out.push(...await Promise.all(iv.slice(i, i + 4).map((s) =>
          api(`/sessions/${s.id}/transcript`).then((t) => ({ s, t })).catch(() => ({ s, t: null })))));
      }
      all = out;
      return all;
    }

    // The line the word appears in, cut around the match rather than from the
    // start of the turn: a persona's answer runs to a paragraph and the match is
    // rarely in its first clause.
    const excerpt = (h, needle) => {
      const pad = 72;
      const from = Math.max(0, h.at - pad);
      const to = Math.min(h.text.length, h.at + needle.length + pad);
      // Cut at a word on both sides: a fragment ending "Peopl…" reads as a bug.
      let pre = h.text.slice(from, h.at), post = h.text.slice(h.at + needle.length, to);
      if (from) pre = pre.slice(pre.indexOf(" ") + 1);
      if (to < h.text.length) post = post.slice(0, post.lastIndexOf(" ") + 1 || undefined);
      const head = (from ? "\u2026" : "") + pre;
      const tail = post.replace(/\s+$/, "") + (to < h.text.length ? "\u2026" : "");
      return `<span class="who">${esc(h.who)}</span> ${esc(head)}<mark>${esc(h.text.slice(h.at, h.at + needle.length))}</mark>${esc(tail)}`;
    };

    let timer = null;
    $("#tr-q").addEventListener("input", (e) => {
      const term = e.target.value.trim();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (term.length < 2) {
          list.innerHTML = `<div class="doclist">${iv.map((s) => row(s)).join("")}</div>`;
          note(""); return;
        }
        const data = await loadAll("reading your transcripts\u2026");
        const needle = term.toLowerCase();
        const rows = []; let total = 0;
        for (const { s, t } of data) {
          if (!t) continue;
          // Every occurrence, not every turn that has one: a persona's answer
          // often says the word twice and a team counting mentions is counting
          // the word.
          let n = 0, first = null, said = null;
          for (const tr of t.turns) {
            const hay = tr.text.toLowerCase();
            const mine = tr.speaker === "interviewer";
            for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
              n++;
              const h = { who: mine ? "You:" : `${t.name}:`, at, text: tr.text };
              if (!first) first = h;
              // What they said outranks what you asked: a team searching a
              // transcript is looking for the answer, and the word is usually
              // in the question that prompted it as well.
              if (!said && !mine) said = h;
            }
          }
          if (!n) continue;
          total += n;
          rows.push(row(s, `<div class="trhit"><span class="n">${n} mention${n === 1 ? "" : "s"}</span>${excerpt(said || first, needle)}</div>`));
        }
        list.innerHTML = rows.length
          ? `<div class="doclist">${rows.join("")}</div>`
          : `<div class="empty"><span class="tag">nothing matches</span><p>No transcript carries that word. It may be a thing nobody said, or a thing you did not ask.</p></div>`;
        note(rows.length ? `${total} in ${rows.length} transcript${rows.length === 1 ? "" : "s"}` : "nothing");
      }, 220);
    });

    // One file, all of it, in the order they were held. What a team opens beside
    // its draft.
    $("#tr-all").addEventListener("click", async (e) => {
      const b = e.currentTarget, was = b.textContent;
      b.disabled = true; b.textContent = "Collecting\u2026";
      try {
        const data = await loadAll("collecting\u2026");
        const parts = data.filter((x) => x.t).map(({ s, t }) => {
          const when = s.closed_at ? s.closed_at.slice(0, 16).replace("T", " ") : "";
          const head = `${t.name}\n${when} \u00b7 ${t.session.turn_count} turns \u00b7 ${(t.session.virtual_seconds / 60).toFixed(0)} minutes of their time`;
          const body = t.turns.map((tr) => `${tr.speaker === "interviewer" ? "You" : t.name}: ${tr.text}`).join("\n\n");
          return `${head}\n${"\u2500".repeat(58)}\n\n${body}`;
        });
        const txt = `Interview transcripts \u2014 ${S.me.group.code}\n`
          + `${parts.length} conversation${parts.length === 1 ? "" : "s"}\n\n\n`
          + parts.join("\n\n\n\n");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" }));
        a.download = `transcripts-${S.me.group.code}.txt`; a.click();
        note("");
      } catch (err) { note("could not collect them"); }
      finally { b.disabled = false; b.textContent = was; }
    });
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
  /**
   * The document desk, by a name that does not change with the case.
   *
   * The registrar's desk has a different code in every case — she is a person
   * with a name, and the code is hers — so the menu cannot link straight to
   * it. This resolves the registry desk from /desks and forwards, which keeps
   * one stable address in the menu and works in any case the site is pointed
   * at without the site knowing anything about which.
   *
   * It is a forward and not a page: the desk's own address stays the one a
   * team sees and can return to, so a reload or a shared link lands on the
   * desk itself rather than going through here again.
   */
  async function registryDesk() {
    const me = await ensureMe(); nav("registry");
    const shut = courseGate(me);
    if (shut) { render("t-desks"); $("#desk-list").innerHTML = gateBanner(shut); watchGate((m) => !!courseGate(m), registryDesk); return; }
    let reg = null;
    try { reg = (await api("/desks")).desks.find((d) => d.desk_kind === "registry") || null; }
    catch (err) {
      render("t-desks");
      $("#desk-list").innerHTML = `<div class="empty"><span class="tag">not reachable</span><p>${esc(err.message)}</p></div>`;
      return;
    }
    if (!reg) {
      render("t-desks");
      $("#desk-list").innerHTML = `<div class="empty"><span class="tag">no document desk</span><p>This course has no document desk. Records reach your team as the case releases them.</p><p><a href="#/file">Your case file</a></p></div>`;
      return;
    }
    location.hash = `#/desk/${reg.code}`;
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
    // The greeting, where the desk carries one. Not invented if it does not:
    // a desk with nothing authored simply does not greet, which is the same
    // rule the rest of this page follows about a field the case leaves empty.
    const hello = $("#di-hello");
    if (hello) {
      const line = (desk.opening_line || "").trim();
      hello.textContent = line;
      hello.hidden = !line;
    }
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
    // The menu entry is set again once the desk is known: which of the two it
    // is decides which entry is current, and that cannot be told from the code.
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
    nav(d.desk.desk_kind === "registry" ? "registry" : "desk");
    // Nothing asked yet, and the course is open: meet the desk first.
    if (!skipIntro && !threadId && !d.turns.length && !courseGate(S.me)) return deskIntro(d, code);
    render("t-desk");
    const desk = d.desk;
    const registry = desk.desk_kind === "registry";
    // The page's own head, in the shape every other page uses: a kicker and a
    // title. Named for what the desk IS and not for who keeps it — the keeper's
    // name is on her card, and these two words have to be the same in every
    // case, because they are what the menu calls the page.
    $("#dk-kicker").textContent = registry ? "The archive" : "The literature";
    $("#dk-title").textContent = registry ? "Document desk" : "Research desk";
    const deskBrief = desk.brief || (registry
      ? "Ask for a record by name. If the archive holds it, it goes into your case file."
      : "Ask about the literature. The desk answers from what it reads, and cites it.");
    $("#dk-q").placeholder = registry
      ? "e.g. the will of the founder, or the articles of association from the year the holding company was formed"
      : "Ask about the literature, not about the family";
    $("#dk-go").textContent = registry ? "Ask for it" : "Ask the desk";
    $("#dk-srclabel").textContent = registry ? "What this desk holds" : "What this desk reads";
    $("#dk-brief").innerHTML = `<p>${esc(deskBrief)}</p>`;
    // The column's head, for the one state that has none: a desk opened with
    // nothing asked yet has no request on screen, so neither the request list
    // nor the request head is showing. It used to be the desk's subtitle, which
    // the card beside it already prints — and on a phone, where the card is
    // hoisted above this column, printed twice in consecutive lines.
    $("#dk-label").hidden = !!d.thread;
    if (!d.thread) $("#dk-label").textContent = "A new request";
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
    keyboardAware($("#dk-q"));
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
      // Declared out here so the release in `finally` can reach it. A desk
      // answer takes as long as an interviewee's and often longer — a search
      // and then a reading — and a phone left alone that long locks itself and
      // suspends the stream mid-sentence. Same treatment the room gets.
      let awake = await holdScreen();
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
          if (streamErr.code === "sign_in_required") throw streamErr;
          // Something was already on screen: the question reached the desk and
          // the answer was being written when the connection went. Falling
          // back would ask it twice.
          //
          // This was leaving the partial answer sitting under a blinking
          // caret — the page claiming the desk was still writing, for ever —
          // and reporting the generic error beside it. It is marked as cut
          // instead, and the remedy is the desk's own and better than the
          // room's: a desk thread is on the server the moment it is answered
          // and is redrawn from `done` on every load, so the whole answer AND
          // its citations — which only arrive with `done`, and so are always
          // lost by a cut — are there as soon as the page is reloaded. Asking
          // again would spend a second question for something already filed.
          if (live) {
            console.warn("[desk] stream cut mid-answer", streamErr);
            live.turn.classList.remove("speaking");
            live.turn.classList.add("cut");
            throw Object.assign(new Error(
              "The connection dropped while the answer was being written. What is above is partial and its sources are missing \u2014 reload this request and the whole answer will be there. Asking again spends another question."),
              { code: "stream_cut" });
          }
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
        try { await awake?.release(); } catch { /* already gone with the tab */ }
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
          // Only the address is a link. A reference is authors, year, title
          // and journal, and it ends with where the paper is: the DOI, or a
          // publisher's page. Underlining the whole line said nothing about
          // where a click would go; the address says it, and a DOI in the
          // text is followed in preference to whatever the record's own link
          // column held, which for most papers was an aggregator's page.
          const ref = String(c.reference ?? "");
          const m = /\s*(https?:\/\/\S+?)[.,;)]*\s*$/.exec(ref);
          const href = m ? m[1] : c.url;
          const text = m ? ref.slice(0, m.index) : ref;
          const link = href ? ` <a href="${esc(href)}" target="_blank" rel="noopener">${esc(m ? m[1] : href)}</a>` : "";
          return `<li><span class="pos">[${c.position}]</span><span>${esc(text)}${link}</span></li>`;
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
        <p>Your words arrive in the box already punctuated, a second or so behind your voice,
          with the names in this case spelled the way the case spells them. What is being heard
          right now shows in the line underneath, so the pause reads as the transcript catching up.
          Press the button again when you have finished. You can also say a mark where you want
          one — <em>&ldquo;before ninety-five, comma, who held the shares&rdquo;</em> — and
          <em>comma</em>, <em>full stop</em>, <em>question mark</em>, <em>colon</em> and
          <em>new line</em> all work that way.</p>
        <p><strong>Read it before you send it.</strong> It is good with a name it knows and
          useless with a word it never heard, so a sentence can still come out saying something
          you did not say. A name it could not place is left in lower case — that is the tell.
          Anything you typed yourself is left alone.
        <p>It listens in English, and it needs Chrome, Edge or Safari; Firefox cannot do it. If you
          would rather type, type — nothing about the exercise assumes you spoke.</p>
        <p class="prov">Your browser does the listening, and it sends the audio to its own
          recognition service to do it — Google for Chrome, Apple for Safari. It does not reach
          this platform and nothing here records it.</p>`;
    }

    // Whether choosing is even a thing on this course, and what it costs.
    // The people are counted from the roster on the page, not from the
    // engine's `available`: that figure leaves out anyone who declines to be
    // interviewed, and a team still meets that person — formally, and on the
    // roster — even if the meeting is a refusal.
    const choose = $("#how-choose");
    if (iv && iv.selection === "open") {
      choose.innerHTML = `<p>You may hold <strong>${iv.budget}</strong> conversation${iv.budget === 1 ? "" : "s"},
        and there ${ps.length === 1 ? "is" : "are"} <strong>${ps.length}</strong> ${ps.length === 1 ? "person" : "people"}
        you could approach. You have used <strong>${iv.held + iv.pending}</strong>;
        <strong>${iv.left}</strong> remain${iv.left === 1 ? "s" : ""}. Choosing is part of the work — decide who is
        worth an hour before you knock.</p>`;
    } else if (iv) {
      const capped = iv.budget && iv.budget < ps.length;
      choose.innerHTML = `<p>Your team leader has named the <strong>${ps.length}</strong>
        ${ps.length === 1 ? "person" : "people"} you will meet.
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
  /**
   * Dictation, end to end, on the device that is having the trouble.
   *
   * This exists because a voice fault took four rounds to find, and every one
   * of them was spent guessing: the transcript is the browser's, the
   * correction is the server's, and from a report saying "it doesn't work"
   * there was no way to tell which half had failed, or whether the phone had
   * even reached the route. A screenshot of this page answers all of that at
   * once — which build, whether the engine exists, what it heard, what was
   * sent, what came back, and how long each leg took.
   *
   * It runs against the real API as the signed-in group, so it proves the
   * whole chain rather than a model of it. It is not linked from anywhere:
   * #/voice-check, given out when it is needed.
   */
  async function voiceCheck() {
    const me = await ensureMe(); nav(null);
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    view.innerHTML = `<h1>Dictation check</h1>
      <p class="lede">Press the button and read the sentence aloud. Everything the page learns is
        printed below — send that whole screen to whoever is looking at the problem.</p>
      <div class="card">
        <p class="label">read this aloud</p>
        <p style="font-family:var(--read);font-size:19px;margin:4px 0 16px">
          &ldquo;Hello, we work for CeFEO in Jönköping and we would like to ask about ownership.&rdquo;</p>
        <button class="btn" id="vc-go">Start</button>
        <button class="btn quiet" id="vc-stop" disabled>Stop</button>
      </div>
      <pre id="vc-log" class="vclog"></pre>`;

    const log = $("#vc-log");
    const t0 = Date.now();
    const lines = [];
    const put = (s) => { lines.push(`${String(Date.now() - t0).padStart(6)}ms  ${s}`); log.textContent = lines.join("\n"); };

    put(`site ${C.VERSION}  ·  group ${me?.group?.code ?? "?"}  ·  voice ${me?.edition?.voice_input_enabled ? "on" : "OFF for this course run"}`);
    put(`speech engine: ${Ctor ? (window.SpeechRecognition ? "SpeechRecognition" : "webkitSpeechRecognition") : "ABSENT — this browser cannot listen"}`);
    try {
      const h = await fetch(`${C.API_BASE}/health`).then((r) => r.json());
      put(`api ${h.version} ${h.commit}  ·  tidy calls so far ${JSON.stringify(h.tidy ?? {})}`);
    } catch (e) { put(`api /health UNREACHABLE: ${e.message}`); }

    if (!Ctor) return;
    let rec = null, placed = "";
    $("#vc-go").addEventListener("click", () => {
      const r = new Ctor();
      r.lang = "en-US"; r.continuous = true; r.interimResults = true;
      r.onresult = async (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (!res.isFinal) continue;
          const heard = res[0].transcript.trim();
          put(`heard:  "${heard}"`);
          const at = Date.now();
          try {
            const out = await post("/dictation/tidy", { text: heard, context: placed, next: "" });
            put(`tidied: "${out.text}"   (changed ${out.changed}, ${Date.now() - at}ms)`);
            placed = (placed ? placed + " " : "") + (out.text || heard);
          } catch (e) {
            put(`TIDY FAILED after ${Date.now() - at}ms: ${e.code || ""} ${e.message}`);
          }
        }
      };
      r.onerror = (ev) => put(`engine error: ${ev.error}`);
      r.onend = () => put("engine ended the session");
      try { r.start(); rec = r; put("listening…"); $("#vc-go").disabled = true; $("#vc-stop").disabled = false; }
      catch (e) { put(`could not start: ${e.message}`); }
    });
    $("#vc-stop").addEventListener("click", () => {
      if (rec) { try { rec.stop(); } catch {} }
      put(`stopped. final text: "${placed}"`);
      $("#vc-go").disabled = false; $("#vc-stop").disabled = true;
    });
  }

  async function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [a, b, c] = h.split("/");
    if (!store.get()) return signin();
    if (a !== "room") { stopPoll(); recording(null); }
    stopGate(); stopVoice();
    try {
      if (!a) return await landing();
      // The same rule as the API's, so a typed address lands on the page that
      // explains itself instead of on a page that fails. One exception, and
      // it is the one the case page needs: a single record, because the pack
      // is listed there and offering a paper that cannot be opened is worse
      // than not listing it. Which papers those are is the server's to say —
      // a closed course reaches the onboarding pack and nothing else.
      if (SHUT(await ensureMe()) && !(a === "file" && b && b !== "stage")) {
        location.hash = "#/";
        return await landing();
      }
      if (a === "people") return await people();
      if (a === "how") return await how();
      // Unlinked, deliberately: a diagnostic, not a page of the course.
      if (a === "voice-check") return await voiceCheck();
      // #/file                    the whole file
      // #/file/CODE               that document
      // #/file/CODE/at            the file, landed on that document's line
      // #/file/stage/STAGE        the file, filtered to one release stage
      //
      // "stage" as the second segment rather than a query string: the router
      // splits the hash on "/" and a "?" would land inside a segment. No
      // record code is the word stage, so the two forms cannot collide.
      if (a === "file") {
        if (!b) return await file();
        if (b === "stage" && c) return await file(null, decodeURIComponent(c));
        const code = decodeURIComponent(b);
        return c === "at" ? await file(code) : await doc(code);
      }
      if (a === "interview" && b) return await confirm_(b);
      if (a === "room" && b) return await room(b);
      if (a === "transcripts") return b ? await transcript(b) : await transcripts();
      // #/desk/CODE reads the request the group is working in;
      // #/desk/CODE/t/<id> reads one it has closed;
      // #/desk/CODE/new is the blank one, waiting for the first question.
      // One address for the document desk whatever the case calls its keeper.
      if (a === "registry") return await registryDesk();
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
    // Whether the code running in this tab is the code the site is serving.
    //
    // This used to compare GitHub's deployment timestamp against app.js's
    // last-modified header with five minutes of slack — and it fetched
    // "app.js", which is not the file the page loaded: the page loads
    // "app.js?v=1.24", a different cache entry. So the two dates could sit more
    // than five minutes apart for reasons having nothing to do with this tab
    // being behind, and the notice then never cleared however often somebody
    // reloaded. That is the worst way for this line to fail: a true-sounding
    // claim with a remedy that cannot work.
    //
    // The version is what is being asked about, so the version is what is
    // compared: what this tab is RUNNING against what the site is SERVING.
    // Exact, needs no clock and no slack, and it clears itself on reload —
    // afterwards the tab IS the served version, so the test cannot stick.
    let stale = false;
    try {
      // The query defeats the ten-minute Pages cache; no-store defeats the
      // browser's. Both are needed to be reading the live file.
      const r = await fetch(`config.js?stamp=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        const served = (await r.text()).match(/VERSION:\s*["']([^"']+)["']/);
        if (served && served[1] && served[1] !== base) stale = true;
      }
    } catch { /* offline or blocked: say nothing rather than guess */ }
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

  // The panel closes on anything pressed inside it; this catches the rest —
  // a back gesture, a hash typed in, one of the redirects the room does.
  window.addEventListener("hashchange", () => { menu.close(); route(); });
  $("#out").addEventListener("click", () => {
    store.set(null); S.me = S.personas = S.docs = null;
    // A shared laptop is the normal case in a seminar room. The next group may
    // be on a different case, and its palette is not this one's to inherit.
    if (window.FBTheme) window.FBTheme.forget();
    lightswitch();
    location.hash = "#/"; signin();
  });
  /**
   * Replace a stale shell, once.
   *
   * Every `?v=` cache-buster on this site lives INSIDE index.html, and Pages
   * serves index.html with a ten-minute max-age that a phone — a home-screen
   * web app above all — will outlive by days. A stale shell then asks for the
   * stylesheet and script versions it remembers and is handed them from its
   * own cache, so a team can be several versions behind the seminar it is
   * sitting in with no way to tell. Reloading does not help: the reload is
   * served the same cached document.
   *
   * So the page checks itself. config.js is read from the network, and if the
   * version there is not the one this page booted with, the shell is stale.
   * The only way to get past a cached document is to ask for a URL the cache
   * has never seen, so the navigation carries a one-time query, stripped again
   * below once the new shell is running.
   *
   * Loop safety matters more here than freshness, because a tab that reloads
   * forever during an interview is far worse than a tab that is a version
   * behind. The navigation happens AT MOST ONCE per tab: the guard is written
   * to sessionStorage before navigating and never cleared, and a browser that
   * will not give us sessionStorage at all gets no navigation whatsoever.
   */
  const FRESH = "fb.freshened";
  async function freshen() {
    let tried;
    try { tried = sessionStorage.getItem(FRESH); } catch { return; }
    if (tried) return;
    try {
      const r = await fetch(`config.js?fresh=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const m = (await r.text()).match(/VERSION:\s*"([^"]+)"/);
      if (!m || m[1] === C.VERSION) return;
      sessionStorage.setItem(FRESH, m[1]);
      console.info(`[fb] shell is ${C.VERSION}, the site is ${m[1]} — reloading once`);
      location.replace(`${location.pathname}?fresh=${Date.now()}${location.hash}`);
    } catch { /* offline, or blocked: the page it has is the page it keeps */ }
  }
  // The one-time query has done its job by the time anything runs; take it out
  // of the address bar so a shared or bookmarked link never carries it.
  if (/[?&]fresh=/.test(location.search)) {
    try { history.replaceState(null, "", location.pathname + location.hash); } catch {}
  }

  // The palette was already applied by theme.js, before any of this ran; the
  // switch only needs to catch up with what it did.
  lightswitch();
  route();
  stamp();
  freshen();
})();
