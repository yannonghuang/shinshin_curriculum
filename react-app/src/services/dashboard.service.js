import http from "../http-common";
import authHeader from "./auth-header";

class DashboardDataService {
  // { rows: [...one per plan], exportFields: [{ key, label, defaultOn }] }
  // seedOnly: only 种子教师' plans (filtered server-side).
  getAll(seedOnly = false) {
    return http.get("/dashboard", { headers: authHeader(), params: seedOnly ? { seedTeacher: 1 } : undefined });
  }

  // .xlsx of the given plans (in that order) with the given columns.
  exportExcel(planIds, fields) {
    return http.post(
      "/dashboard/export",
      { planIds, fields, origin: window.location.origin },
      { headers: authHeader(), responseType: "arraybuffer" }
    );
  }
}

export default new DashboardDataService();
