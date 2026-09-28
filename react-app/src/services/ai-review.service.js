import http from "../http-common";
import authHeader from "./auth-header";

class AiReviewDataService {
  // { standard: <newest AI 点评标准 or null>, generating, lastError }
  getStandard() {
    return http.get("/ai-review/standard", { headers: authHeader() });
  }

  // Starts a background (re)generation from 学习资源库 -- poll getStandard()
  // until `generating` is false.
  generateStandard() {
    return http.post("/ai-review/standard/generate", {}, { headers: authHeader() });
  }

  listVersions() {
    return http.get("/ai-review/standard/versions", { headers: authHeader() });
  }

  getVersion(id) {
    return http.get(`/ai-review/standard/versions/${id}`, { headers: authHeader() });
  }

  // That version as a Word document (.docx bytes).
  exportVersion(id) {
    return http.get(`/ai-review/standard/versions/${id}/export`, { headers: authHeader(), responseType: "arraybuffer" });
  }

  // { content, cautions: { structural, ai }, signature } for a pending
  // override -- pass cautions+signature back to saveRevision unchanged.
  checkRevision(content, baseId) {
    return http.post("/ai-review/standard/check", { content, baseId }, { headers: authHeader() });
  }

  // { plans: [...AI-reviewed plans with newest score], job, standard }
  getScores() {
    return http.get("/ai-review/scores", { headers: authHeader() });
  }

  // Starts a background AI 打分 batch -- poll getScores() while job.running.
  runScoring() {
    return http.post("/ai-review/scores/run", {}, { headers: authHeader() });
  }

  // Bulk AI 点评 (admin only): { plans: [...submitted plans, each flagged
  // `matched` against criteria], job }
  getBulkCandidates(criteria) {
    return http.get("/ai-review/bulk", { params: criteria, headers: authHeader() });
  }

  // Starts a background bulk AI 点评 batch over the plans matching
  // criteria -- poll getBulkCandidates() while job.running.
  runBulkReview(criteria) {
    return http.post("/ai-review/bulk/run", criteria, { headers: authHeader() });
  }

  saveRevision({ content, baseId, changeNote, cautions, signature }) {
    return http.post(
      "/ai-review/standard/revisions",
      { content, baseId, changeNote, cautions, signature },
      { headers: authHeader() }
    );
  }
}

export default new AiReviewDataService();
