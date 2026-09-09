import http from "../http-common";
import authHeader from "./auth-header";

// Admin user-management (create admin / suspend / delete / list-search).
// All endpoints are authJwt.isAdmin-gated on the backend -- see
// backend/app/routes/auth.routes.js.
class AdminUserDataService {
  getAll(params) {
    return http.get("/auth/users", { params, headers: authHeader() });
  }

  // Creates a user with any role (including "admin"/"super"). Public signup can
  // never do this -- see backend/app/middleware/verifySignUp.checkOnlyTeacherRole.
  create(data) {
    return http.post("/auth/admin/users", data, { headers: authHeader() });
  }

  // Same PUT /api/auth/users/:id endpoint profile.component.js uses for
  // self-edit -- authJwt.isSelfOrSuper allows a super user to target any id, and
  // auth.controller.js#update additionally unlocks roles/emailVerified when
  // the requester is super (isSuperActor).
  update(id, data) {
    return http.put(`/auth/users/${id}`, data, { headers: authHeader() });
  }

  suspend(id) {
    return http.put(`/auth/users/${id}/suspend`, {}, { headers: authHeader() });
  }

  unsuspend(id) {
    return http.put(`/auth/users/${id}/unsuspend`, {}, { headers: authHeader() });
  }

  delete(id) {
    return http.delete(`/auth/users/${id}`, { headers: authHeader() });
  }
}

export default new AdminUserDataService();
