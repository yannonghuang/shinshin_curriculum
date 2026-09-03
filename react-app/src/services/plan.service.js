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

  suspend(id) {
    return http.put(`/plans/${id}/suspend`, {}, { headers: authHeader() });
  }

  unsuspend(id) {
    return http.put(`/plans/${id}/unsuspend`, {}, { headers: authHeader() });
  }

  // Backend planDocGenerator.js renders plan_form_data into a .docx mirroring
  // curriculum_template/乡土课程设计方案模版.docx and streams it straight back --
  // nothing is persisted, so this always reflects current content. Used by
  // the 课程设计文件 panel's 下载/预览 commands alike; the caller decides what
  // to do with the bytes.
  downloadDesignDoc(id) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/plans/${id}/design-doc`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }
}

export default new PlanDataService();
