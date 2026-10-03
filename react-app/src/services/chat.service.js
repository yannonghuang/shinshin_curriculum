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

  deleteConversation(id) {
    return http.delete(`/chat/conversations/${id}`, { headers: authHeader() });
  }

  // 确认执行/取消 on an action 欣欣助手 proposed -- see backend
  // chat.controller.js#confirmAction. Both resolve to { message, followUp }:
  // the proposing message with its action's status updated, plus a short
  // assistant follow-up recording the outcome.
  confirmAction(messageId, actionId) {
    return http.post(`/chat/messages/${messageId}/actions/${actionId}/confirm`, {}, { headers: authHeader() });
  }

  cancelAction(messageId, actionId) {
    return http.post(`/chat/messages/${messageId}/actions/${actionId}/cancel`, {}, { headers: authHeader() });
  }
}

export default new ChatDataService();
