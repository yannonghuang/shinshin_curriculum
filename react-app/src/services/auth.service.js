import axios from "axios";

const API_URL = "/api/auth/";

class AuthService {
  signup(username, email, password, roles, chineseName) {
    return axios.post(API_URL + "signup", {
      username,
      email,
      password,
      roles,
      chineseName,
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
