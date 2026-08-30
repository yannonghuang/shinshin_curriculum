import http from "../http-common";
import authHeader from "./auth-header";

class ArtifactDataService {
  getByPlan(planId, lessonIndex) {
    return http.get(`/plans/${planId}/artifacts`, {
      params: lessonIndex !== undefined && lessonIndex !== null ? { lessonIndex } : {},
      headers: authHeader(),
    });
  }

  get(id) {
    return http.get(`/artifacts/${id}`, { headers: authHeader() });
  }

  downloadByPlan(planId, lessonIndex, onDownloadProgress) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/plans/${planId}/artifacts/download`, {
      params: lessonIndex !== undefined && lessonIndex !== null ? { lessonIndex } : {},
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
      onDownloadProgress,
    });
  }

  download(id) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/artifacts/${id}/download`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }

  create(planId, formData, onUploadProgress) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.post(`/plans/${planId}/artifacts`, formData, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      onUploadProgress,
    });
  }

  bulkCreate(planId, formData, onUploadProgress) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.post(`/plans/${planId}/artifacts/bulk`, formData, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      onUploadProgress,
    });
  }

  update(id, formData) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.put(`/artifacts/${id}`, formData, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
    });
  }

  delete(id, confirmDelete = false) {
    return http.delete(`/artifacts/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }
}

export default new ArtifactDataService();
