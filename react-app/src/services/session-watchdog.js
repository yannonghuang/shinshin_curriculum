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
// go out. CHECK_INTERVAL_MS trades precision (how close to the true 15-
// minute mark the redirect actually happens) for polling overhead; 30s is
// comfortably precise for a 900s window at effectively zero cost.
const CHECK_INTERVAL_MS = 30 * 1000;

// How long before expiry to auto-save unsaved edits (see
// utils/sessionExpiryGuard.js) -- has to be comfortably wider than the check
// interval, including a background tab's throttled one (Chrome clamps a
// long-hidden tab's timers to roughly once a minute), or the whole window
// can slip by between two checks.
const AUTO_SAVE_LEAD_SECONDS = 120;

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
      } else if (secondsUntilExpiry(user) <= AUTO_SAVE_LEAD_SECONDS && hasUnsavedWork()) {
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

  setInterval(check, CHECK_INTERVAL_MS);
  // Background tabs get their timers heavily throttled, so the interval
  // alone can lag well past the real expiry -- check immediately when the
  // tab comes back into view, and when another tab changes the session.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "user" || e.key === null) check();
  });
};

export default startSessionWatchdog;
