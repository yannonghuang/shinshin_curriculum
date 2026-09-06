import http from "../http-common";
import authHeader from "./auth-header";

class ChatDataService {
  // pageContext ({ planId?, reviewId? }) picks which scoped conversation
  // "current" resolves to server-side (see chat.controller.js#deriveScopeKey)
  // -- passed as query params here since this is a GET.
  getCurrent(pageContext) {
    return http.get("/chat/conversations/current", { params: pageContext || {}, headers: authHeader() });
  }

  startNew(pageContext) {
    return http.post("/chat/conversations/new", { pageContext }, { headers: authHeader() });
  }

  sendMessage(content, pageContext) {
    return http.post("/chat/conversations/current/messages", { content, pageContext }, { headers: authHeader() });
  }
}

export default new ChatDataService();
