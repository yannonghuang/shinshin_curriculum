import http from "../http-common";
import authHeader from "./auth-header";

// Same method shape as folder.service.js's FolderDataService, minus
// lessonIndex -- passed as the second `folderService` prop to
// lesson-file-manager.component.js when it's scoped to a material topic
// instead of a plan lesson.
class MaterialFolderDataService {
  getByPlan(topicId) {
    return http.get(`/material-topics/${topicId}/folders`, { headers: authHeader() });
  }

  create(topicId, data) {
    return http.post(`/material-topics/${topicId}/folders`, data, { headers: authHeader() });
  }

  update(id, data) {
    return http.put(`/material-folders/${id}`, data, { headers: authHeader() });
  }

  delete(id, confirmDelete = false) {
    return http.delete(`/material-folders/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }
}

export default new MaterialFolderDataService();
