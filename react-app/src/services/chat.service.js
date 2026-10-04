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

  // attachmentIds: uploads from uploadAttachment below, claimed by this
  // message server-side (see chat.controller.js#appendTurn).
  sendMessage(content, pageContext, attachmentIds) {
    return http.post("/chat/conversations/current/messages", { content, pageContext, attachmentIds }, { headers: authHeader() });
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

  sendMessageToConversation(id, content, attachmentIds) {
    return http.post(`/chat/conversations/${id}/messages`, { content, attachmentIds }, { headers: authHeader() });
  }

  // Import -- one file per request; the server extracts its text (or, for an
  // image, transcribes it) before answering, so this can take a while for an
  // image. width/height are an image's post-downscale size, for a Word
  // export to embed it at the right aspect ratio.
  uploadAttachment(file, { width, height } = {}, onUploadProgress) {
    const formData = new FormData();
    formData.append("file", file, file.name);
    if (width) formData.append("width", width);
    if (height) formData.append("height", height);
    return http.post("/chat/attachments", formData, {
      headers: { ...authHeader(), "Content-Type": "multipart/form-data" },
      onUploadProgress,
    });
  }

  deleteAttachment(id) {
    return http.delete(`/chat/attachments/${id}`, { headers: authHeader() });
  }

  getAttachmentImage(id) {
    return http.get(`/chat/attachments/${id}/image`, { headers: authHeader(), responseType: "blob" });
  }

  // 新建为课程设计 on a drafted plan (draft_plan) -- see backend
  // chat.controller.js#createPlanFromDraft.
  createPlanFromDraft(messageId, draftId) {
    return http.post(`/chat/messages/${messageId}/drafts/${draftId}/create`, {}, { headers: authHeader() });
  }

  // Background turns (backend chatTasks.js): a reply that takes longer than
  // a few seconds is a task -- polled for progress, cancellable, retryable.
  getTask(id) {
    return http.get(`/chat/tasks/${id}`, { headers: authHeader() });
  }

  cancelTask(id) {
    return http.post(`/chat/tasks/${id}/cancel`, {}, { headers: authHeader() });
  }

  retryTask(id) {
    return http.post(`/chat/tasks/${id}/retry`, {}, { headers: authHeader() });
  }

  // A document 欣欣小助手 generated in a reply (generate_document) -- see
  // backend chat.controller.js#downloadDocument.
  downloadDocument(messageId, docId) {
    return http.post(`/chat/messages/${messageId}/documents/${docId}`, {}, { headers: authHeader(), responseType: "blob" });
  }

  // Export -- format: "docx" | "md" | "html"; messageIds omitted = the
  // whole conversation (including messages older than the panel's window).
  exportConversation(id, format, messageIds) {
    return http.post(`/chat/conversations/${id}/export`, { format, messageIds }, { headers: authHeader(), responseType: "blob" });
  }

  deleteConversation(id) {
    return http.delete(`/chat/conversations/${id}`, { headers: authHeader() });
  }

  // 确认执行/取消 on an action 欣欣小助手 proposed -- see backend
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
