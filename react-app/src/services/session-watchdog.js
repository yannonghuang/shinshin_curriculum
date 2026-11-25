import AuthService from "./auth.service";
import clearSessionAndRedirectToLogin from "./clear-session";
import { hasUnsavedWork, saveUnsavedWork, stashUnsavedWork } from "../utils/sessionExpiryGuard";

// token-renewal-interceptor.js's expiry handling is entirely *reactive* --
// it only fires when some network request happens to go out and come back
// with a 401 or x-session-expired. A user who logs in and then just leaves
// the tab open with no clicks at all never triggers another request, so
// nothing would ever notice the session expired -- confirmed as a real gap:
// leaving /plans?mine=true idle past the inactivity window kept showing the
// page as if still logged in indefinitely, no request needed to reveal it.
//
// This is the proactive half: a plain client-side timer, independent of any
// API call, that periodically compares AuthService.isValid()'s existing
// `thisLogin + validity > now` check (kept current by the renewal
// interceptor on every request that *does* happen) against the clock, and
// redirects to /login the moment it lapses -- no network round-trip needed,
// since the whole point is this fires even when no request would otherwise
// go out. CHECK_INTERVAL_MS trades precision (how close to the true expiry
// the redirect actually happens) for polling overhead; 30s is comfortably
// precise for a 30-minute window at effectively zero cost.
const CHECK_INTERVAL_MS = 30 * 1000;

// The session times out after *inactivity*, and activity is the user doing
// something on the page -- but typing a long review or reading a plan sends
// no request, so the token (only renewed by requests, see authJwt.js) used
// to run out under a user who was busy the whole time: the auto-save below
// then saved their half-typed review and logged them out mid-sentence.
// User input now counts: on any keystroke/click/scroll/touch, the session
// is renewed with a ping once the token is at least this old -- often
// enough that an active user never gets near the auto-save window, rarely
// enough that typing doesn't send a request per keystroke. Timer-driven
// polls deliberately don't count (see auth-header.js#backgroundAuthHeader).
//
// Browsing counts too, not just typing/clicking: someone reading a long plan
// moves the mouse, drags the scrollbar (no wheel event), or scrolls with
// touch momentum, without ever pressing a key -- and was getting logged out
// mid-read. pointermove/scroll (captured, so scrolls of inner panes like the
// explorer content count as well), IME "input" (Chinese typing), focus and
// back/forward navigation are all activity now. Several of these fire very
// often, so onActivity is throttled to one look per ACTIVITY_THROTTLE_MS
// before it even reads localStorage.
const RENEW_AFTER_SECONDS = 5 * 60;
const ACTIVITY_THROTTLE_MS = 15 * 1000;
const ACTIVITY_EVENTS = ["keydown", "input", "pointerdown", "pointermove", "wheel", "scroll", "touchstart", "focus", "popstate"];

// How long before expiry to auto-save unsaved edits (see
// utils/sessionExpiryGuard.js) -- has to be comfortably wider than the check
// interval, including a background tab's throttled one (Chrome clamps a
// long-hidden tab's timers to roughly once a minute), or the whole window
// can slip by between two checks.
const AUTO_SAVE_LEAD_SECONDS = 120;

// Both of the above are tuned for the production 30-minute window, but are
// capped at a sixth of whatever validity the server actually issued -- with
// a short JWT_VALIDITY (e.g. 120s, to test the timeout without waiting half
// an hour) a fixed 5-minute renew threshold would never be reached before
// expiry, so even a busy user would be logged out. For 1800s both stay as is.
const renewAfterSeconds = (user) => Math.min(RENEW_AFTER_SECONDS, (user.validity || Infinity) / 6);
const autoSaveLeadSeconds = (user) => Math.min(AUTO_SAVE_LEAD_SECONDS, (user.validity || Infinity) / 6);

// A ping that never comes back (network dropped mid-request, laptop slept)
// used to leave `renewing` stuck at true forever, silently disabling renewal
// for the rest of that tab's life -- the user then got logged out 30 minutes
// later however busy they were. A ping is tiny; give up on it after this.
const PING_TIMEOUT_MS = 20 * 1000;

// File previews (lesson file manager, design/execution doc, templates) open
// in a separate tab: window.open("") then document.write / a blob: URL. A
// teacher reading a PDF or docx there for a while is browsing, but none of
// that tab's events reach this one -- so on returning to the app they were
// logged out. Windows registered here are watched from this tab: their own
// input events count (listeners re-attached whenever the window's document
// changes, since document.open and navigating to the blob replace it), and
// for a PDF/video/audio, whose built-in viewer swallows input, the preview
// being the focused window counts. Same-origin only (blank + blob: are);
// anything else just throws and is skipped.
const PREVIEW_POLL_MS = 5 * 1000;
const FOCUS_COUNTS_TYPES = /^(application\/pdf|video\/|audio\/)/;
const previewWindows = new Set();
let notifyActivity = () => {};
let previewPoll = null;

const pollPreviewWindows = () => {
  previewWindows.forEach((win) => {
    try {
      if (win.closed) {
        previewWindows.delete(win);
        return;
      }
      const doc = win.document;
      const root = doc && doc.documentElement;
      if (root && !root.__sessionWatchdog) {
        root.__sessionWatchdog = true;
        ACTIVITY_EVENTS.forEach((type) => doc.addEventListener(type, () => notifyActivity(), { capture: true, passive: true }));
      }
      if (FOCUS_COUNTS_TYPES.test(doc.contentType || "") && doc.hasFocus()) notifyActivity();
    } catch (e) {
      previewWindows.delete(win); // cross-origin or gone
    }
  });
  if (!previewWindows.size && previewPoll) {
    clearInterval(previewPoll);
    previewPoll = null;
  }
};

export const watchPreviewWindow = (win) => {
  if (!win) return win;
  previewWindows.add(win);
  pollPreviewWindows();
  if (!previewPoll) previewPoll = setInterval(pollPreviewWindows, PREVIEW_POLL_MS);
  return win;
};

const secondsUntilExpiry = (user) => {
  if (!user.thisLogin || !user.validity) return Infinity;
  return user.thisLogin + user.validity - Math.floor(Date.now() / 1000);
};

const startSessionWatchdog = () => {
  // Also catches the session vanishing out from under this tab (another tab
  // expired/logged out and cleared the shared localStorage "user") -- a
  // plain `getCurrentUser() && !isValid()` check skips that case entirely,
  // leaving this tab showing a logged-in page with no user behind it (every
  // owner-gated editor silently turns read-only). Only redirects a tab that
  // actually had a session, so an anonymous visitor on a public page is
  // never bounced to /login.
  let hadUser = !!AuthService.getCurrentUser();
  let autoSaving = false;

  const check = async () => {
    if (autoSaving) return;
    const user = AuthService.getCurrentUser();
    if (user) {
      hadUser = true;
      if (!AuthService.isValid()) {
        clearSessionAndRedirectToLogin();
      } else if (secondsUntilExpiry(user) <= autoSaveLeadSeconds(user) && hasUnsavedWork()) {
        // Save while the token still works, then end the session anyway --
        // the save itself renews the token (it's a request like any other),
        // but an idle user's session should still time out on schedule
        // rather than be kept alive by its own auto-save. Stash first so a
        // save that fails still leaves a local draft behind.
        autoSaving = true;
        stashUnsavedWork();
        await saveUnsavedWork();
        clearSessionAndRedirectToLogin();
      }
    } else if (hadUser) {
      hadUser = false;
      clearSessionAndRedirectToLogin();
    }
  };

  let renewing = false;
  let lastActivityCheck = 0;
  const onActivity = () => {
    if (renewing || autoSaving) return;
    const nowMs = Date.now();
    if (nowMs - lastActivityCheck < ACTIVITY_THROTTLE_MS) return;
    lastActivityCheck = nowMs;
    const user = AuthService.getCurrentUser();
    if (!user || !AuthService.isValid() || !user.thisLogin) return;
    if (Math.floor(Date.now() / 1000) - user.thisLogin < renewAfterSeconds(user)) return;
    renewing = true;
    AuthService.ping({ timeout: PING_TIMEOUT_MS })
      .catch(() => {}) // a 401 is already handled by the renewal interceptor
      .finally(() => {
        renewing = false;
      });
  };
  ACTIVITY_EVENTS.forEach((type) => window.addEventListener(type, onActivity, { capture: true, passive: true }));
  notifyActivity = onActivity;

  setInterval(check, CHECK_INTERVAL_MS);
  // Background tabs get their timers heavily throttled, so the interval
  // alone can lag well past the real expiry -- check immediately when the
  // tab comes back into view, and when another tab changes the session.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      check();
      onActivity();
    }
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "user" || e.key === null) check();
  });
};

export default startSessionWatchdog;
