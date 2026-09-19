/**
 * The case's colours, applied before the page paints.
 *
 * Loaded synchronously in <head>, ahead of everything, because the alternative
 * is a flash of the platform's own palette every time a student opens a page —
 * and a night-time flash of a light page is not a cosmetic complaint, it is
 * the thing people who use dark mode actually mind about.
 *
 * The palette a group was served is cached in this browser, so it is available
 * on the first paint of a return visit, before /me has answered. Everything
 * cached here is a colour, one of four policy words, and two hours of the day:
 * there is nothing about a case in it, which is why it may sit in a student's
 * own storage at all.
 *
 * Three decisions, in order of authority:
 *   this device's own choice   a student who has set one always gets it
 *   the instructor's policy    off | on | system | night, per case
 *   the stylesheet             when nothing has been served yet
 *
 * The night window mirrors app/core/src/theme-colours.ts (darkNow). Two copies
 * of eight lines, deliberately: this one has to run before any module loads
 * and cannot import, and the server's has to answer for the console's preview.
 * They are the same four cases in the same order, and the wrap across midnight
 * is the case both exist to get right.
 */
(function () {
  var KEY = "fb.theme", MINE = "fb.theme.mine";
  var TOKEN = /^[a-z][a-z0-9-]{1,30}$/, HEX = /^#[0-9a-fA-F]{6}$/;
  var timer = null, watching = false, painted = [];

  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  function stored() {
    try { var t = JSON.parse(read(KEY) || "null"); return t && t.light && t.dark ? t : null; } catch (e) { return null; }
  }
  function prefersDark() {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  }
  /** "light" | "dark" | null — this device's own answer, which outranks the policy. */
  function mine() { var v = read(MINE); return v === "dark" || v === "light" ? v : null; }

  function byPolicy(t, hour, dev) {
    switch (t.dark_mode) {
      case "on": return true;
      case "system": return dev;
      case "night":
        var a = t.night_from, b = t.night_to;
        return a === b ? false : a < b ? hour >= a && hour < b : hour >= a || hour < b;
      default: return false;
    }
  }
  function wanted(t) {
    var m = mine();
    return m ? m === "dark" : byPolicy(t, new Date().getHours(), prefersDark());
  }

  /**
   * Set the eighteen custom properties, or leave the stylesheet's own alone.
   *
   * Each key and each value is checked before it goes anywhere near a style
   * declaration. The server checks them too, and the database has a constraint
   * of its own; this is the third of three because the value arrives from the
   * network and is written into the page, and a palette is the one piece of
   * server data this site interpolates rather than escapes.
   */
  function paint() {
    var r = document.documentElement, t = stored();
    // No palette: take back the one that was painted as well as the flag. These
    // are inline properties on the root and nothing else clears them, so
    // dropping only the attribute left a signed-out page still wearing the
    // case's night colours while every rule keyed on data-dark had stopped
    // firing — a dark card with the light-ground lock-up on it. The stylesheet
    // owns the default; the way back to it is to remove what was set over it.
    if (!t) { unpaint(r); r.removeAttribute("data-dark"); return false; }
    var dark = wanted(t), p = dark ? t.dark : t.light, k;
    unpaint(r);
    for (k in p) if (TOKEN.test(k) && HEX.test(p[k])) { r.style.setProperty("--" + k, p[k]); painted.push(k); }
    if (dark) r.setAttribute("data-dark", ""); else r.removeAttribute("data-dark");
    return dark;
  }

  /** Remove every property this file set, so a repaint never leaves a mixture. */
  function unpaint(r) {
    for (var i = 0; i < painted.length; i++) r.style.removeProperty("--" + painted[i]);
    painted.length = 0;
  }

  /** Keep what the API served, for the next first paint. */
  function cache(t) {
    if (!t || !t.light || !t.dark) return;
    write(KEY, JSON.stringify({
      light: t.light, dark: t.dark, dark_mode: t.dark_mode,
      night_from: t.night_from, night_to: t.night_to,
    }));
  }

  /**
   * Re-decide without a reload: on the hour, when the device's own setting
   * changes, and when a tab comes back after being away — which on a phone is
   * how most of a day passes.
   */
  function watch() {
    if (watching) return; watching = true;
    var again = function () {
      var now = new Date();
      var ms = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000 + 1500;
      timer = setTimeout(function () { paint(); again(); }, Math.max(30000, ms));
    };
    again();
    if (typeof matchMedia === "function") {
      var q = matchMedia("(prefers-color-scheme: dark)");
      if (q.addEventListener) q.addEventListener("change", function () { paint(); });
      else if (q.addListener) q.addListener(function () { paint(); });
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") paint();
    });
  }

  window.FBTheme = {
    paint: paint,
    cache: cache,
    /** Forget the case's palette — on sign-out, so the next group starts clean. */
    forget: function () { write(KEY, null); paint(); },
    /** "auto" | "light" | "dark": what this device is doing. */
    choice: function () { return mine() || "auto"; },
    /** Set it; "auto" hands the decision back to the instructor's policy. */
    set: function (v) { write(MINE, v === "light" || v === "dark" ? v : null); return paint(); },
    /** Whether a palette has been served at all, and what the policy says. */
    policy: function () { var t = stored(); return t ? t.dark_mode : null; },
    isDark: function () { return document.documentElement.hasAttribute("data-dark"); },
  };

  paint();
  watch();
})();
