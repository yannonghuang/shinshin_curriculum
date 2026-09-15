// Reads a renewed JWT off the `x-access-token` response header (see
// authJwt.js#renewAndTrackActivity, which reissues a token with a fresh
// sliding-inactivity expiry on every authenticated request) and updates the
// stored user's accessToken + thisLogin -- AuthService.isValid()'s existing
// `thisLogin + validity > now` check then keeps reflecting "time since last
// activity", not just time since the original login. Needs cors's
// exposedHeaders (see server.js) for the browser to expose this header to
// JS at all.
//
// Attached to both axios references this app uses -- the raw `axios`
// singleton (auth.service.js's own /api/auth/* calls) and the separate
// instance http-common.js creates (every other service) -- since
// interceptors don't cross between them.
const attachTokenRenewalInterceptor = (axiosInstance) => {
  axiosInstance.interceptors.response.use(
    (response) => {
      const renewedToken = response.headers && response.headers["x-access-token"];
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
    (error) => Promise.reject(error)
  );
};

export default attachTokenRenewalInterceptor;
