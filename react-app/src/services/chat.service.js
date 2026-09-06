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

  // "Revisit all threads" -- list every retained conversation, open one by
  // id, continue it (its own stored scope decides context, not whatever
  // page happens to be open -- see chat.controller.js#sendMessageToConversation).
  listConversations() {
    return http.get("/chat/conversations", { headers: authHeader() });
  }

  getConversationById(id) {
    return http.get(`/chat/conversations/${id}`, { headers: authHeader() });
  }

  sendMessageToConversation(id, content) {
    return http.post(`/chat/conversations/${id}/messages`, { content }, { headers: authHeader() });
  }
}

export default new ChatDataService();
