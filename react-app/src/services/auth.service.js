import axios from "axios";
import authHeader from "./auth-header";

const API_URL = "/api/auth/";

class AuthService {
  // schoolCode/schoolName: only meaningful when roles includes "teacher" --
  // the backend rejects them otherwise (see auth.controller.js#validateSchoolFields).
  signup({ username, email, password, roles, chineseName, schoolCode, schoolName }) {
    return axios.post(API_URL + "signup", {
      username,
      email,
      password,
      roles,
      chineseName,
      schoolCode,
      schoolName,
    });
  }

  signin(username, password) {
    return axios.post(API_URL + "signin", {
      username,
      password,
    });
  }

  signout() {
    if (!localStorage.getItem("user")) return;

    const username = JSON.parse(localStorage.getItem("user")).username;
    localStorage.clear();

    return axios
      .post(API_URL + "signout", { username })
      .then((response) => response.data)
      .catch((err) => {
        console.log(err);
      });
  }

  reset(email, password) {
    return axios.post(API_URL + "reset", {
      email,
      password,
    });
  }

  findByEmail(email, emailVerified = false) {
    return axios.post(API_URL + "findByEmail", {
      email,
      emailVerified,
    });
  }

  getRoles() {
    return axios.get(API_URL + "roles");
  }

  // Self-or-admin: PUT /api/auth/users/:id (authJwt.isSelfOrAdmin-gated).
  // Used by profile.component.js for "everyone can edit their own user data
  // except id" -- id is simply never a writable field server-side, so
  // there's no way to alter it through this endpoint regardless of payload.
  getProfile(id) {
    return axios.get(API_URL + "users/" + id, { headers: authHeader() });
  }

  updateProfile(id, data) {
    return axios.put(API_URL + "users/" + id, data, { headers: authHeader() });
  }

  getCurrentUser() {
    return JSON.parse(localStorage.getItem("user"));
  }

  isValid() {
    if (!localStorage.getItem("user")) return false;

    const user = JSON.parse(localStorage.getItem("user"));

    if (!user.thisLogin || !user.validity) return true;

    return user.thisLogin + user.validity > Math.floor(Date.now() / 1000);
  }

  isLogin() {
    return this.getCurrentUser();
  }

  isTeacher() {
    const user = this.getCurrentUser();
    return !!(user && user.roles && user.roles.includes("ROLE_TEACHER"));
  }

  isExpert() {
    const user = this.getCurrentUser();
    return !!(user && user.roles && user.roles.includes("ROLE_EXPERT"));
  }

  isAdmin() {
    const user = this.getCurrentUser();
    return !!(user && user.roles && user.roles.includes("ROLE_ADMIN"));
  }
}

export default new AuthService();
