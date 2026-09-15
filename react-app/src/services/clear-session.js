// Shared by token-renewal-interceptor.js (reactive: a request revealed the
// session is dead) and session-watchdog.js (proactive: no request needed to
// notice, a timer caught it) -- same end state either way. Full page reload
// (not client-side routing) is deliberate, so no stale in-memory React
// state from the now-invalid session lingers. Guards against redirect-
// looping if already on /login.
const clearSessionAndRedirectToLogin = () => {
  localStorage.removeItem("user");
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
};

export default clearSessionAndRedirectToLogin;
