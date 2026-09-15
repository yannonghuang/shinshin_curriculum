import AuthService from "./auth.service";
import clearSessionAndRedirectToLogin from "./clear-session";

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

const startSessionWatchdog = () => {
  setInterval(() => {
    if (AuthService.getCurrentUser() && !AuthService.isValid()) {
      clearSessionAndRedirectToLogin();
    }
  }, CHECK_INTERVAL_MS);
};

export default startSessionWatchdog;
