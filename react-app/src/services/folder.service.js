import http from "../http-common";
import authHeader from "./auth-header";

class FolderDataService {
  getByPlan(planId, lessonIndex) {
    return http.get(`/plans/${planId}/folders`, {
      params: { lessonIndex },
      headers: authHeader(),
    });
  }

  create(planId, data) {
    return http.post(`/plans/${planId}/folders`, data, { headers: authHeader() });
  }

  update(id, data) {
    return http.put(`/folders/${id}`, data, { headers: authHeader() });
  }

  delete(id, confirmDelete = false) {
    return http.delete(`/folders/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }
}

export default new FolderDataService();
