import PlanDataService from "../services/plan.service";

// Where a user lands after logging in (or on visiting "/" / "/login" while
// already logged in), by role. An expert lands on their own 我的点评 once
// they have reviewed anything -- that's where they pick up their work --
// and on 待点评案例 until then (or if the lookup fails). Needs the user's
// token already in localStorage (PlanDataService's authHeader reads it).
export const landingPathForRoles = async (roles) => {
  const r = roles || [];
  if (r.includes("ROLE_TEACHER")) return "/plans?mine=true";
  if (r.includes("ROLE_EXPERT")) {
    try {
      const resp = await PlanDataService.getAll({ reviewedByMe: true, page: 0, size: 1 });
      if ((resp.data && resp.data.totalItems) > 0) return "/plans?reviewed=mine";
    } catch (e) {
      // fall through to the review queue
    }
    return "/plans?status=submitted";
  }
  if (r.includes("ROLE_ADMIN") || r.includes("ROLE_SUPER")) return "/plans";
  return "/";
};
