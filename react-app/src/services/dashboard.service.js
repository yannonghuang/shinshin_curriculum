import http from "../http-common";
import authHeader from "./auth-header";

class DashboardDataService {
  // { rows: [...one per plan], exportFields: [{ key, label, defaultOn }] }
  getAll() {
    return http.get("/dashboard", { headers: authHeader() });
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
