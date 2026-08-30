import http from "../http-common";
import authHeader from "./auth-header";

class PlanDataService {
  getAll(params) {
    return http.get("/plans", { params, headers: authHeader() });
  }

  get(id) {
    return http.get(`/plans/${id}`, { headers: authHeader() });
  }

  getOptions() {
    return http.get("/plans/options");
  }

  create(data) {
    return http.post("/plans", data, { headers: authHeader() });
  }

  update(id, data) {
    return http.put(`/plans/${id}`, data, { headers: authHeader() });
  }

  delete(id, confirmCascade = false) {
    return http.delete(`/plans/${id}?confirmCascade=${confirmCascade ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }

  // Triggers backend planDocGenerator.js: renders plan_form_data into a .docx mirroring
  // curriculum_template/乡土课程设计方案模版.docx and registers it as a 课程设计文件 artifact.
  generateDoc(id) {
    return http.post(`/plans/${id}/generate-doc`, {}, { headers: authHeader() });
  }
}

export default new PlanDataService();
