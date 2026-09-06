import http from "../http-common";
import authHeader from "./auth-header";

class ChatDataService {
  getCurrent() {
    return http.get("/chat/conversations/current", { headers: authHeader() });
  }

  startNew() {
    return http.post("/chat/conversations/new", {}, { headers: authHeader() });
  }

  sendMessage(content, pageContext) {
    return http.post("/chat/conversations/current/messages", { content, pageContext }, { headers: authHeader() });
  }
}

export default new ChatDataService();
