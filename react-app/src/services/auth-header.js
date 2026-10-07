export default function authHeader() {
  const user = JSON.parse(localStorage.getItem('user'));

  if (user && user.accessToken) {
    // for Node.js Express back-end
    return { 'x-access-token': user.accessToken };
  } else {
    return {};
  }
}

// For requests fired by a timer (a status poll while some job runs) rather
// than by the user: still authenticated, but the backend doesn't treat them
// as activity, so they don't keep an idle session alive (see authJwt.js's
// isBackgroundRequest).
export function backgroundAuthHeader() {
  return { ...authHeader(), 'x-background-request': '1' };
}
