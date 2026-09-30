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

  // AI 打分加点评 (experts read, admins run): { plans: [...submitted plans
  // with their current AI score/review and needsScore/needsReview], job,
  // standard }
  getScoreReview() {
    return http.get("/ai-review/score-review", { headers: authHeader() });
  }

  // Starts the background AI 打分加点评 batch over `planIds` (the plans the
  // page shows) -- poll getScoreReview() while job.running.
  runScoreReview(planIds) {
    return http.post("/ai-review/score-review/run", { planIds }, { headers: authHeader() });
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
