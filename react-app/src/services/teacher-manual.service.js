import http from "../http-common";
import authHeader from "./auth-header";

class TeacherManualDataService {
  // Always freshly regenerated server-side -- see
  // teacherManualGenerator.js -- never a stale cached file.
  download() {
    const user = JSON.parse(localStorage.getItem("user"));
    return http.get("/admin/teacher-manual/download", {
      headers: {
        "x-access-token": user && user.accessToken ? user.accessToken : null,
      },
      responseType: "arraybuffer",
    });
  }

  // Regenerates the manual and files it into 学习资源库 under 使用指南/教师手册
  // (creating that topic on first use, overwriting the same entry on later
  // publishes).
  publish() {
    return http.put("/admin/teacher-manual/publish", {}, { headers: authHeader() });
  }
}

export default new TeacherManualDataService();
