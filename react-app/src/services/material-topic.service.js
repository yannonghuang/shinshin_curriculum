import http from "../http-common";
import authHeader from "./auth-header";

class MaterialTopicDataService {
  getAll() {
    return http.get("/material-topics", { headers: authHeader() });
  }

  get(id) {
    return http.get(`/material-topics/${id}`, { headers: authHeader() });
  }

  create(data) {
    return http.post("/material-topics", data, { headers: authHeader() });
  }

  update(id, data) {
    return http.put(`/material-topics/${id}`, data, { headers: authHeader() });
  }

  delete(id, confirmDelete = false) {
    return http.delete(`/material-topics/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }

  search(q) {
    return http.get("/material-topics/search", { params: { q }, headers: authHeader() });
  }

  getSkill(topicId) {
    return http.get(`/material-topics/${topicId}/skill`, { headers: authHeader() });
  }

  updateSkill(topicId, data) {
    return http.put(`/material-topics/${topicId}/skill`, data, { headers: authHeader() });
  }
}

export default new MaterialTopicDataService();
