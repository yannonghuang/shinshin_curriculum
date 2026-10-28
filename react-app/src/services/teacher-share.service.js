import http from "../http-common";
import authHeader from "./auth-header";

// 教师分享 -- see backend routes/teacher-share.routes.js.
const fileHeaders = (extra = {}) => ({ ...authHeader(), ...extra });

export const ShareTopicDataService = {
  getAll: () => http.get("/share-topics", { headers: authHeader() }),
  create: (data) => http.post("/share-topics", data, { headers: authHeader() }),
  update: (id, data) => http.put(`/share-topics/${id}`, data, { headers: authHeader() }),
  delete: (id) => http.delete(`/share-topics/${id}`, { headers: authHeader() }),
};

export const ShareDataService = {
  getAll: (params) => http.get("/shares", { params, headers: authHeader() }),
  get: (id) => http.get(`/shares/${id}`, { headers: authHeader() }),
  // Admin-only: teachers to pick as a share's author.
  getTeachers: (keyword) => http.get("/shares/teachers", { params: { keyword }, headers: authHeader() }),
  create: (data) => http.post("/shares", data, { headers: authHeader() }),
  update: (id, data) => http.put(`/shares/${id}`, data, { headers: authHeader() }),
  delete: (id) => http.delete(`/shares/${id}?confirmDelete=true`, { headers: authHeader() }),
};

// The folderService/artifactService pair lesson-file-manager.component.js
// takes -- same method shapes as material-folder.service.js/
// material-artifact.service.js, with the share id passed as `planId`.
export const ShareFolderDataService = {
  getByPlan: (shareId) => http.get(`/shares/${shareId}/folders`, { headers: authHeader() }),
  create: (shareId, data) => http.post(`/shares/${shareId}/folders`, data, { headers: authHeader() }),
  update: (id, data) => http.put(`/share-folders/${id}`, data, { headers: authHeader() }),
  delete: (id, confirmDelete = false) =>
    http.delete(`/share-folders/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, { headers: authHeader() }),
};

export const ShareArtifactDataService = {
  getByPlan: (shareId) => http.get(`/shares/${shareId}/artifacts`, { headers: authHeader() }),
  get: (id) => http.get(`/share-artifacts/${id}`, { headers: authHeader() }),
  download: (id) => http.get(`/share-artifacts/${id}/download`, { headers: authHeader(), responseType: "arraybuffer" }),
  downloadSelection: (shareId, { artifactIds, folderIds }, onDownloadProgress) =>
    http.post(
      `/shares/${shareId}/artifacts/download-selection`,
      { artifactIds, folderIds },
      { headers: authHeader(), responseType: "arraybuffer", onDownloadProgress }
    ),
  create: (shareId, formData, onUploadProgress) =>
    http.post(`/shares/${shareId}/artifacts`, formData, {
      headers: fileHeaders({ "content-type": "multipart/form-data" }),
      onUploadProgress,
    }),
  update: (id, formData) =>
    http.put(`/share-artifacts/${id}`, formData, { headers: fileHeaders({ "content-type": "multipart/form-data" }) }),
  delete: (id, confirmDelete = false) =>
    http.delete(`/share-artifacts/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, { headers: authHeader() }),
};
