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

  saveRevision({ content, baseId, changeNote, cautions, signature }) {
    return http.post(
      "/ai-review/standard/revisions",
      { content, baseId, changeNote, cautions, signature },
      { headers: authHeader() }
    );
  }
}

export default new AiReviewDataService();
