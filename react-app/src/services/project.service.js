import http from "../http-common";
import authHeader from "./auth-header";

// 项目管理 -- see backend routes/project.routes.js. Admin/super only.
//
// The folderService/artifactService pair lesson-file-manager.component.js
// takes -- same method shapes as teacher-share.service.js's. 项目管理 is one
// app-wide file space, so the `planId` argument the file manager passes is
// ignored.
const fileHeaders = (extra = {}) => ({ ...authHeader(), ...extra });

export const ProjectFolderDataService = {
  getByPlan: () => http.get("/project-folders", { headers: authHeader() }),
  create: (_planId, data) => http.post("/project-folders", data, { headers: authHeader() }),
  update: (id, data) => http.put(`/project-folders/${id}`, data, { headers: authHeader() }),
  delete: (id, confirmDelete = false) =>
    http.delete(`/project-folders/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, { headers: authHeader() }),
};

export const ProjectArtifactDataService = {
  getByPlan: () => http.get("/project-artifacts", { headers: authHeader() }),
  get: (id) => http.get(`/project-artifacts/${id}`, { headers: authHeader() }),
  download: (id) => http.get(`/project-artifacts/${id}/download`, { headers: authHeader(), responseType: "arraybuffer" }),
  downloadSelection: (_planId, { artifactIds, folderIds }, onDownloadProgress) =>
    http.post(
      "/project-artifacts/download-selection",
      { artifactIds, folderIds },
      { headers: authHeader(), responseType: "arraybuffer", onDownloadProgress }
    ),
  create: (_planId, formData, onUploadProgress) =>
    http.post("/project-artifacts", formData, {
      headers: fileHeaders({ "content-type": "multipart/form-data" }),
      onUploadProgress,
    }),
  update: (id, formData) =>
    http.put(`/project-artifacts/${id}`, formData, { headers: fileHeaders({ "content-type": "multipart/form-data" }) }),
  delete: (id, confirmDelete = false) =>
    http.delete(`/project-artifacts/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, { headers: authHeader() }),
};
