import http from "../http-common";
import authHeader from "./auth-header";

class MaterialLinkDataService {
  getByTopic(topicId) {
    return http.get(`/material-topics/${topicId}/links`, { headers: authHeader() });
  }

  create(topicId, data) {
    return http.post(`/material-topics/${topicId}/links`, data, { headers: authHeader() });
  }

  update(id, data) {
    return http.put(`/material-links/${id}`, data, { headers: authHeader() });
  }

  delete(id) {
    return http.delete(`/material-links/${id}`, { headers: authHeader() });
  }
}

export default new MaterialLinkDataService();
