import clearSessionAndRedirectToLogin from "./clear-session";

// Three-way sliding-session contract with authJwt.js, all driven by
// response headers/status since this interceptor has no visibility into
// what each route actually does:
//  - success + x-access-token: the request's token was valid and just got
//    reissued with a fresh expiry (see authJwt.js#renewAndTrackActivity, run
//    by both verifyToken and attachUserIfPresent). Update the stored user's
//    accessToken + thisLogin -- AuthService.isValid()'s existing
//    `thisLogin + validity > now` check then keeps reflecting "time since
//    last activity", not just time since the original login.
//  - success + x-session-expired: a *soft-auth* route (attachUserIfPresent,
//    e.g. GET /api/plans/:id -- must stay viewable to an anonymous visitor)
//    got a present-but-invalid/expired token. The request still succeeded
//    (as an anonymous view), so there's no error for the branch below to
//    catch -- confirmed as a real gap: refreshing a plan page after the
//    token expired kept showing the stale "logged in" chrome indefinitely,
//    since this route never 401s. This header is attachUserIfPresent's own
//    signal for that case (see its comment).
//  - error 401 (with the failed request having carried a token in the first
//    place): a *hard-auth* route (verifyToken) rejected an invalid/expired
//    token outright. Without this, the frontend never notices either --
//    confirmed as a real bug: an admin's session expired mid-use and the
//    user list just showed "加载用户列表失败" instead of returning to the
//    login page. Gated on the request having actually carried
//    x-access-token so this never fires for signin's own 401 (wrong
//    password, see auth.controller.js#signin) -- that request never carries
//    a token in the first place, since there's no session yet to attach one
//    from, and login.component.js's own .catch() already handles showing
//    that error inline.
//
// All three need cors's exposedHeaders (see server.js) for the browser to
// read these custom headers cross-origin at all, and are attached to both
// axios references this app uses -- the raw `axios` singleton
// (auth.service.js's own /api/auth/* calls) and the separate instance
// http-common.js creates (every other service) -- since interceptors don't
// cross between them.
const attachTokenRenewalInterceptor = (axiosInstance) => {
  axiosInstance.interceptors.response.use(
    (response) => {
      const headers = response.headers || {};
      if (headers["x-session-expired"]) {
        clearSessionAndRedirectToLogin();
        return response;
      }
      const renewedToken = headers["x-access-token"];
      if (renewedToken) {
        try {
          const stored = localStorage.getItem("user");
          if (stored) {
            const user = JSON.parse(stored);
            user.accessToken = renewedToken;
            user.thisLogin = Math.floor(Date.now() / 1000);
            localStorage.setItem("user", JSON.stringify(user));
          }
        } catch (e) {
          // Corrupt/missing localStorage entry -- nothing to renew, not fatal.
        }
      }
      return response;
    },
    (error) => {
      const requestHadToken = !!(error.config && error.config.headers && error.config.headers["x-access-token"]);
      if (requestHadToken && error.response && error.response.status === 401) {
        clearSessionAndRedirectToLogin();
      }
      return Promise.reject(error);
    }
  );
};

export default attachTokenRenewalInterceptor;
