import http from "../http-common";
import authHeader from "./auth-header";

class LearningMaterialDataService {
  getAll(params) {
    return http.get("/learning-materials", { params, headers: authHeader() });
  }

  get(id) {
    return http.get(`/learning-materials/${id}`, { headers: authHeader() });
  }

  // data may be a FormData (material_type='file', multipart upload with progress) or a
  // plain JSON object (material_type='link', { title, description, externalUrl, theme, grade }).
  create(data, onUploadProgress) {
    const isFormData = typeof FormData !== "undefined" && data instanceof FormData;
    if (!isFormData) {
      return http.post("/learning-materials", data, { headers: authHeader() });
    }
    const user = JSON.parse(localStorage.getItem("user"));
    return http.post("/learning-materials", data, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      onUploadProgress,
    });
  }

  update(id, data, onUploadProgress) {
    const isFormData = typeof FormData !== "undefined" && data instanceof FormData;
    if (!isFormData) {
      return http.put(`/learning-materials/${id}`, data, { headers: authHeader() });
    }
    const user = JSON.parse(localStorage.getItem("user"));
    return http.put(`/learning-materials/${id}`, data, {
      headers: {
        "content-type": "multipart/form-data",
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      onUploadProgress,
    });
  }

  delete(id, confirmDelete = false) {
    return http.delete(`/learning-materials/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }

  download(id) {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get(`/learning-materials/${id}/download`, {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }
}

export default new LearningMaterialDataService();
