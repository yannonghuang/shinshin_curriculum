import http from "../http-common";
import authHeader from "./auth-header";

class MaterialTopicDataService {
  getAll() {
    return http.get("/material-topics", { headers: authHeader() });
  }

  get(id) {
    return http.get(`/material-topics/${id}`, { headers: authHeader() });
  }

  create(data) {
    return http.post("/material-topics", data, { headers: authHeader() });
  }

  update(id, data) {
    return http.put(`/material-topics/${id}`, data, { headers: authHeader() });
  }

  delete(id, confirmDelete = false) {
    return http.delete(`/material-topics/${id}?confirmDelete=${confirmDelete ? "true" : "false"}`, {
      headers: authHeader(),
    });
  }

  search(q) {
    return http.get("/material-topics/search", { params: { q }, headers: authHeader() });
  }

  // Bulk rename/delete the tree's first-level folder (every topic sharing
  // one `category` value) -- see material-topic.controller.js#renameCategory/
  // #deleteCategory.
  renameCategory(from, to) {
    return http.put("/material-topics/category", { from, to }, { headers: authHeader() });
  }

  deleteCategory(category, confirmDelete = false) {
    return http.delete("/material-topics/category", {
      params: { category, confirmDelete: confirmDelete ? "true" : "false" },
      headers: authHeader(),
    });
  }

  getSkill(topicId) {
    return http.get(`/material-topics/${topicId}/skill`, { headers: authHeader() });
  }

  updateSkill(topicId, data) {
    return http.put(`/material-topics/${topicId}/skill`, data, { headers: authHeader() });
  }

  regenerateSkill(topicId) {
    return http.post(`/material-topics/${topicId}/skill/regenerate`, null, { headers: authHeader() });
  }

  getSkillGenerating(topicId) {
    return http.get(`/material-topics/${topicId}/skill/generating`, { headers: authHeader() });
  }

  // Knowledge tree below the topic card: each source's summary + contents
  // inventory ({ sources, rebuilding, kindLabels }).
  getKnowledgeTree(topicId) {
    return http.get(`/material-topics/${topicId}/knowledge-tree`, { headers: authHeader() });
  }

  // Verbatim chunks of one source, optionally just chunk range [from, to].
  getKnowledgeChunks(topicId, { sourceType, sourceId, from, to }) {
    return http.get(`/material-topics/${topicId}/knowledge-tree/chunks`, {
      headers: authHeader(),
      params: { sourceType, sourceId, from, to },
    });
  }

  rebuildKnowledgeTree(topicId) {
    return http.post(`/material-topics/${topicId}/knowledge-tree/rebuild`, null, { headers: authHeader() });
  }
}

export default new MaterialTopicDataService();
