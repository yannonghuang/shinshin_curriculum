import http from "../http-common";
import authHeader from "./auth-header";

// Same method shape as artifact.service.js's ArtifactDataService, minus
// lessonIndex -- passed as the `artifactService` prop to
// lesson-file-manager.component.js when it's scoped to a material topic
// instead of a plan lesson.
class MaterialArtifactDataService {
  getByPlan(topicId) {
    return http.get(`/material-topics/${topicId}/artifacts`, { headers: authHeader() });
  }

  get(id) {
    return http.get(`/material-artifacts/${id}`, { headers: authHeader() });
  }

  downloadByPlan(topicId, _lessonIndex, onDownloadProgress) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/material-topics/${topicId}/artifacts/download`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
      onDownloadProgress,
    });
  }

  downloadSelection(topicId, { artifactIds, folderIds }, onDownloadProgress) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.post(
      `/material-topics/${topicId}/artifacts/download-selection`,
      { artifactIds, folderIds },
      {
        headers: {
          "x-access-token": user && user.accessToken ? user.accessToken : null,
        },
        responseType: "arraybuffer",
        onDownloadProgress,
      }
    );
  }

  download(id) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/material-artifacts/${id}/download`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }

  create(topicId, formData, onUploadProgress) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.post(`/material-topics/${topicId}/artifacts`, formData, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      onUploadProgress,
    });
  }

  bulkCreate(topicId, formData, onUploadProgress) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.post(`/material-topics/${topicId}/artifacts/bulk`, formData, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      onUploadProgress,
    });
  }

  update(id, formData) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.put(`/material-artifacts/${id}`, formData, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
    });
  }

  delete(id, confirmDelete = false) {
    return http.delete(`/material-artifacts/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }
}

export default new MaterialArtifactDataService();
