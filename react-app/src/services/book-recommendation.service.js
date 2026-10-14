import http from "../http-common";
import authHeader, { backgroundAuthHeader } from "./auth-header";

// 课外读物推荐 (super-only) -- see backend services/bookRecommendation.js.
class BookRecommendationDataService {
  // { stages, schools: [{ code, name, address, province, stages }] }
  getOptions() {
    return http.get("/book-recommendations/options", { headers: authHeader() });
  }

  listRuns({ background } = {}) {
    return http.get("/book-recommendations/runs", { headers: background ? backgroundAuthHeader() : authHeader() });
  }

  getRun(id, { background } = {}) {
    return http.get(`/book-recommendations/runs/${id}`, { headers: background ? backgroundAuthHeader() : authHeader() });
  }

  // Starts a background run -- poll getRun(id) while status is "running".
  // The province is the school's own (server-side), not sent.
  startRun({ file, schoolCode, stages }) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("schoolCode", schoolCode);
    formData.append("stages", JSON.stringify(stages));
    return http.post("/book-recommendations/runs", formData, {
      headers: { ...authHeader(), "content-type": "multipart/form-data" },
    });
  }

  rerun(id) {
    return http.post(`/book-recommendations/runs/${id}/rerun`, {}, { headers: authHeader() });
  }

  deleteRun(id) {
    return http.delete(`/book-recommendations/runs/${id}`, { headers: authHeader() });
  }

  // format: "xlsx" | "docx" -- file bytes.
  exportRun(id, format) {
    return http.get(`/book-recommendations/runs/${id}/export`, {
      params: { format },
      headers: authHeader(),
      responseType: "arraybuffer",
    });
  }

  listGuidances({ background } = {}) {
    return http.get("/book-recommendations/guidances", { headers: background ? backgroundAuthHeader() : authHeader() });
  }

  refreshGuidance(province) {
    return http.post("/book-recommendations/guidances/refresh", { province }, { headers: authHeader() });
  }

  getSkillNotes() {
    return http.get("/book-recommendations/skills", { headers: authHeader() });
  }
}

export default new BookRecommendationDataService();
