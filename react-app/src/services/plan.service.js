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

  // Bulk-migrates every one of the caller's own plans flagged needsMigration
  // onto the currently-active plan_design template version. Backs the
  // flashing 迁移 button in 我的乡土课程.
  migrateMine() {
    return http.put("/plans/migrate-my-plans", {}, { headers: authHeader() });
  }

  // Clears the manual-migration leftovers migrateMine stashed on a plan
  // (planFormData._manualMigration) once the teacher has manually copied
  // over whatever they still needed -- stops its "flashing manual
  // migration" styling.
  removeManualMigration(id) {
    return http.delete(`/plans/${id}/manual-migration`, { headers: authHeader() });
  }

  suspend(id) {
    return http.put(`/plans/${id}/suspend`, {}, { headers: authHeader() });
  }

  unsuspend(id) {
    return http.put(`/plans/${id}/unsuspend`, {}, { headers: authHeader() });
  }

  // Backend dynamicDocGenerator.js renders plan_form_data into a .docx
  // against whichever plan_design template version this plan is pinned to
  // and streams it straight back -- nothing is persisted, so this always
  // reflects current content. Used by the 课程设计文件 panel's 下载/预览
  // commands alike; the caller decides what to do with the bytes.
  downloadDesignDoc(id) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/plans/${id}/design-doc`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }

  // Same on-the-fly, nothing-persisted shape as downloadDesignDoc above, but
  // for one 课时's 实施记录 -- used by 课程实施文件's 下载/预览 commands.
  downloadExecutionDoc(id, lessonIndex) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/plans/${id}/lessons/${lessonIndex}/execution-doc`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }

  // Upload counterparts of the two above -- the file's extraction now runs
  // entirely server-side (backend/app/services/planDocExtract.js), so this
  // just ships the raw bytes and gets back the updated plan (same shape #get
  // returns) with planFormData/basic-info already applied.
  uploadDesignDoc(id, file) {
    const formData = new FormData();
    formData.append("file", file);
    return http.post(`/plans/${id}/design-doc`, formData, { headers: authHeader() });
  }

  uploadExecutionDoc(id, lessonIndex, file) {
    const formData = new FormData();
    formData.append("file", file);
    return http.post(`/plans/${id}/lessons/${lessonIndex}/execution-doc`, formData, { headers: authHeader() });
  }
}

export default new PlanDataService();
