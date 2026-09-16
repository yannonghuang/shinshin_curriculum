import http from "../http-common";
import authHeader from "./auth-header";

class TemplateDataService {
  getActive(templateKey) {
    return http.get(`/templates/${templateKey}/active`, { headers: authHeader() });
  }

  getVersion(id) {
    return http.get(`/templates/versions/${id}`, { headers: authHeader() });
  }

  // A blank .docx rendered from whichever version is currently active --
  // always in sync with the admin/manager's latest published template, no
  // separate static file to fall out of date. Backs the plans-list page's
  // "下载乡土课程设计方案模版"/"下载乡土课程实施记录模版" buttons.
  downloadBlank(templateKey) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/templates/${templateKey}/blank-doc`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }

  // Admin-only.
  list(templateKey) {
    return http.get(`/admin/templates/${templateKey}`, { headers: authHeader() });
  }

  // The actual file behind one version row (the original upload, or a
  // regenerated blank doc for the hand-authored seed versions that have none
  // on disk -- see template.controller.js#download).
  download(templateKey, id) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/admin/templates/${templateKey}/versions/${id}/download`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }

  upload(templateKey, file) {
    const user = JSON.parse(localStorage.getItem("user"));
    const formData = new FormData();
    formData.append("file", file);
    return http.post(`/admin/templates/${templateKey}`, formData, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
    });
  }

  activate(templateKey, id) {
    return http.put(`/admin/templates/${templateKey}/versions/${id}/activate`, {}, { headers: authHeader() });
  }

  // Starts a migration campaign for one old (non-active) version -- flags
  // every plan still pinned to it; the owning teacher then migrates their
  // own flagged plans via plan.service.js#migrateMine.
  migrate(templateKey, id) {
    return http.put(`/admin/templates/${templateKey}/versions/${id}/migrate`, {}, { headers: authHeader() });
  }

  updateNote(templateKey, id, notes) {
    return http.put(`/admin/templates/${templateKey}/versions/${id}/note`, { notes }, { headers: authHeader() });
  }

  delete(templateKey, id, confirmDelete = false) {
    return http.delete(`/admin/templates/${templateKey}/versions/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }
}

export default new TemplateDataService();
