import http from "../http-common";
import authHeader from "./auth-header";

class ReviewDataService {
  getByPlan(planId, lessonIndex) {
    return http.get(`/plans/${planId}/reviews`, {
      params: lessonIndex !== undefined && lessonIndex !== null ? { lessonIndex } : {},
      headers: authHeader(),
    });
  }

  // Expert-authored review. data: { content, score, sectionKey, lessonIndex }
  create(planId, data) {
    return http.post(`/plans/${planId}/reviews`, data, { headers: authHeader() });
  }

  // Triggers a synchronous server-side AI review via services/llmClient.js (DashScope / qwen3.8-max).
  // data: { lessonIndex } (omit/null for a whole-plan review).
  createAi(planId, data) {
    return http.post(`/plans/${planId}/reviews/ai`, data, { headers: authHeader() });
  }

  delete(id) {
    return http.delete(`/reviews/${id}`, { headers: authHeader() });
  }
}

export default new ReviewDataService();
