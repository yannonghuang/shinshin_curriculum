import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useHistory, useLocation } from "react-router-dom";
import Select from "react-select";
import PlanDataService from "../services/plan.service";
import AuthService from "../services/auth.service";
import PlanCard from "./plan-card.component";
import { PLAN_THEMES } from "../constants/plan-options";
import { SCHOOLS, schoolFilterOption } from "../constants/school-options";
import "../curriculum.css";

const formatSchoolOptionLabel = (option) => (
  <div>
    <div>{option.label}</div>
    {option.address && <div style={{ fontSize: "0.85em", color: "#6c757d" }}>{option.address}</div>}
  </div>
);

// Manager/expert plan browser: a 3-level 年份-学期 -> 学校 -> 教师 navigation
// tree (plans-list.component.js renders this in place of its own flat
// search/paginate/grid whenever isManagerOrExpertView is true), styled after
// plan-detail.component.js's own file-explorer split view (.pl-explorer-*)
// for visual consistency with the single-plan page -- same folder/leaf/
// chevron language. The 学校 layer reuses the .pl-explorer-subgroup /
// .pl-explorer-folder.pl-explorer-subfolder / .pl-explorer-children-nested
// classes already used for a second nesting level in
// materials-library.component.js.
//
// Unlike the flat view, this fetches every visible plan in one go (up to
// PAGE_SIZE) and builds the tree client-side -- there's no natural way to
// paginate a tree the user is meant to browse as a whole, and admin/expert
// plan counts are expected to stay well within one generous page for the
// scale this app targets (matches the existing "我的" view's same
// single-generous-page choice).
const PAGE_SIZE = 1000;

const seasonRank = (season) => (season === "秋季" ? 2 : season === "春季" ? 1 : 0);

// Plans whose teacher has no school on file (legacy data predating the
// school-required enforcement) are bucketed here rather than hidden.
const UNASSIGNED_SCHOOL_KEY = "__unassigned__";
const UNASSIGNED_SCHOOL_NAME = "未分配学校";

// Groups a flat plan list into { key, year, season, schoolList: [{ schoolKey,
// schoolName, teacherList: [{ teacherId, teacherName, plans }] }] }, sorted
// most-recent-学期 first, schools alphabetically (unassigned last), teachers
// alphabetically. season/teacher/school are read straight off each plan
// (season may be null for plans predating that field -- bucketed under
// "未设置学期" rather than guessed).
const buildHierarchy = (plans) => {
  const groups = new Map();
  for (const plan of plans) {
    const season = plan.season || null;
    const key = `${plan.year}|${season || ""}`;
    if (!groups.has(key)) groups.set(key, { key, year: plan.year, season, schools: new Map() });
    const group = groups.get(key);

    const school = plan.Teacher && plan.Teacher.School;
    const schoolKey = school ? String(school.code) : UNASSIGNED_SCHOOL_KEY;
    if (!group.schools.has(schoolKey)) {
      const schoolName = school ? school.name : UNASSIGNED_SCHOOL_NAME;
      group.schools.set(schoolKey, { schoolKey, schoolName, teachers: new Map() });
    }
    const schoolGroup = group.schools.get(schoolKey);

    const teacherId = plan.teacherId;
    if (!schoolGroup.teachers.has(teacherId)) {
      const teacherName = (plan.Teacher && (plan.Teacher.chineseName || plan.Teacher.username)) || `教师 #${teacherId}`;
      schoolGroup.teachers.set(teacherId, { teacherId, teacherName, plans: [] });
    }
    schoolGroup.teachers.get(teacherId).plans.push(plan);
  }

  const groupList = Array.from(groups.values());
  groupList.sort((a, b) => (a.year !== b.year ? b.year - a.year : seasonRank(b.season) - seasonRank(a.season)));
  for (const g of groupList) {
    g.schoolList = Array.from(g.schools.values()).sort((a, b) => {
      if (a.schoolKey === UNASSIGNED_SCHOOL_KEY) return 1;
      if (b.schoolKey === UNASSIGNED_SCHOOL_KEY) return -1;
      return a.schoolName.localeCompare(b.schoolName, "zh");
    });
    for (const s of g.schoolList) {
      s.teacherList = Array.from(s.teachers.values()).sort((a, b) => a.teacherName.localeCompare(b.teacherName, "zh"));
    }
  }
  return groupList;
};

const PlansHierarchy = ({ statusFilter, excellentOnly, onFilteredCountChange }) => {
  const history = useHistory();
  const location = useLocation();
  // Read once, at mount, into the various useState initializers below --
  // never re-parsed afterward (a plain top-level `new URLSearchParams
  // (location.search)` would re-run on every render, including the ones
  // this very state triggers via the sync effect further down). This is
  // what makes 返回/browser-back actually restore this page's filters and
  // tree selection, not just its URL: plan-detail.component.js's 返回
  // button does a real history.goBack() (see its own comment), which pops
  // back to this exact query string -- but only if something here reads it
  // back out on remount, since before this all of the state below was
  // plain component state that reset to its defaults on every fresh mount.
  const initialParams = useMemo(() => new URLSearchParams(location.search || ""), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [plans, setPlans] = useState([]);
  const [message, setMessage] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({});

  // The review-status toggles/search boxes make sense on any staff browsing
  // view -- admin/teacher's plain "全部乡土课程" (bare /plans, no
  // statusFilter) and the expert's own "待点评案例" queue (?status=submitted)
  // alike, both benefiting from narrowing a long tree down by teacher/
  // school/theme/AI-or-expert-reviewed the same way. Only the public
  // 优秀案例 gallery (excellentOnly, browsable logged-out) keeps a fixed set
  // with no filter bar -- a stranger browsing showcase cases has no "my
  // queue" to narrow down.
  const showReviewFilters = !excellentOnly;
  // "已提交" is admin-only: plan.controller.js#findAll's restrictToSubmitted
  // already excludes drafts server-side for expert/teacher, so the toggle
  // would be redundant (always-on and un-toggleable-off) for them -- only
  // admin, who still sees drafts, has a real "all statuses vs submitted
  // only" choice to make here.
  const showSubmittedToggle = showReviewFilters && AuthService.isAdmin();
  const [filterSubmitted, setFilterSubmitted] = useState(() => initialParams.get("submitted") === "1");
  const [filterAiReviewed, setFilterAiReviewed] = useState(() => initialParams.get("aiReviewed") === "1");
  const [filterExpertReviewed, setFilterExpertReviewed] = useState(() => initialParams.get("expertReviewed") === "1");
  // Teacher-name/school-name (partial match) and theme (exact match)
  // filters, applied client-side alongside the review-status toggles above --
  // consistent with this component's existing "fetch everything once, filter
  // client-side" design (see PAGE_SIZE), and simpler than adding new
  // server-side query params for a page that already has the full plan list
  // (with Teacher/School already eager-loaded) in hand.
  const [filterTeacherName, setFilterTeacherName] = useState(() => initialParams.get("teacherName") || "");
  const [filterSchoolName, setFilterSchoolName] = useState(() => initialParams.get("schoolName") || "");
  const [filterTheme, setFilterTheme] = useState(() => initialParams.get("theme") || "");
  // 乡土主题 dropdown options -- see plans-list.component.js's identical
  // themeOptions state for why (the active plan_design template's own
  // "附件"-derived list, falling back to the static PLAN_THEMES).
  const [themeOptions, setThemeOptions] = useState(PLAN_THEMES);
  useEffect(() => {
    PlanDataService.getOptions()
      .then((resp) => {
        if (Array.isArray(resp.data && resp.data.themes) && resp.data.themes.length > 0) setThemeOptions(resp.data.themes);
      })
      .catch(() => {});
  }, []);
  // Keyed by `${groupKey}|${schoolKey}` -- a school can appear under
  // multiple year/season groups, so its expand state must be scoped per
  // group, not global.
  const [expandedSchools, setExpandedSchools] = useState({});
  // teacherId is always kept as a string (both here and in selectTeacher
  // below) so a value round-tripped through the URL query string compares
  // equal to one read straight off a freshly-fetched plan -- plan.teacherId
  // itself may be a JS number or a string depending on how the BIGINT
  // column comes back through the driver, and a raw `===` would silently
  // never match once one side has been through String(...) turned into text.
  const [selected, setSelected] = useState(() => {
    const groupKey = initialParams.get("selGroup");
    const schoolKey = initialParams.get("selSchool");
    const teacherId = initialParams.get("selTeacher");
    return groupKey && schoolKey && teacherId ? { groupKey, schoolKey, teacherId } : null;
  }); // { groupKey, schoolKey, teacherId }

  const retrieveAll = useCallback(async () => {
    try {
      const resp = await PlanDataService.getAll({
        page: 0,
        size: PAGE_SIZE,
        status: statusFilter || undefined,
        isExcellentCase: excellentOnly ? true : undefined,
      });
      setPlans(resp.data.rows || []);
    } catch (e) {
      console.log(e);
      setMessage("加载课程设计数据失败。");
    }
  }, [statusFilter, excellentOnly]);

  useEffect(() => {
    retrieveAll();
  }, [retrieveAll]);

  // Same {value: code, label: name, address} shape as register.component.js's
  // own school picker, so typing a school's name OR code finds it here too
  // (schoolFilterOption checks both, plus address); onChange still only feeds
  // filterSchoolName (a name) below, since that's what filteredPlans matches
  // against, not the code. Narrowed down from the full 390-school master
  // directory (SCHOOLS) to just the ones with at least one plan in `plans` --
  // register.component.js's own picker still shows the full directory (any
  // school can sign up a teacher), but here the other 400-ish schools with no
  // submitted plans at all would just be dead-end search results. Built off
  // `plans` (this view's full fetch, before the school/teacher-name/theme
  // filters below are applied client-side) rather than `filteredPlans`, so
  // picking a school doesn't shrink the dropdown down to just itself.
  const schoolOptions = useMemo(() => {
    const codesWithPlans = new Set(
      plans
        .map((p) => p.Teacher && p.Teacher.School && p.Teacher.School.code)
        .filter((code) => code !== undefined && code !== null)
        .map(String)
    );
    return SCHOOLS.filter((s) => codesWithPlans.has(String(s.code))).map((s) => ({
      value: s.code,
      label: s.name,
      address: s.address,
    }));
  }, [plans]);

  // aiReviewed/expertReviewed come pre-computed from plan.controller.js#findAll
  // (derived, not stored -- see that controller's own comment); filtering
  // here is purely client-side over the already-fully-fetched `plans` array,
  // consistent with this component's "fetch everything once, browse the tree
  // client-side" design (see PAGE_SIZE above). Toggles AND together, same as
  // every other multi-filter bar in this app.
  const filteredPlans = useMemo(() => {
    if (!showReviewFilters) return plans;
    const teacherNameQuery = filterTeacherName.trim().toLowerCase();
    const schoolNameQuery = filterSchoolName.trim().toLowerCase();
    return plans.filter((p) => {
      const teacherName = ((p.Teacher && (p.Teacher.chineseName || p.Teacher.username)) || "").toLowerCase();
      // Unassigned-school plans match UNASSIGNED_SCHOOL_NAME (see
      // buildHierarchy above), so searching e.g. "未分配" finds them too.
      const schoolName = ((p.Teacher && p.Teacher.School && p.Teacher.School.name) || UNASSIGNED_SCHOOL_NAME).toLowerCase();
      return (
        (!filterSubmitted || p.status === "submitted") &&
        (!filterAiReviewed || p.aiReviewed) &&
        (!filterExpertReviewed || p.expertReviewed) &&
        (!teacherNameQuery || teacherName.includes(teacherNameQuery)) &&
        (!schoolNameQuery || schoolName.includes(schoolNameQuery)) &&
        (!filterTheme || p.theme === filterTheme)
      );
    });
  }, [
    plans,
    showReviewFilters,
    filterSubmitted,
    filterAiReviewed,
    filterExpertReviewed,
    filterTeacherName,
    filterSchoolName,
    filterTheme,
  ]);

  const groups = useMemo(() => buildHierarchy(filteredPlans), [filteredPlans]);

  // Reports the filtered count up to plans-list.component.js so it can show
  // it next to the page's own "全部乡土课程" title instead of duplicating it
  // here in the filter bar -- this component doesn't know the heading text
  // (that's the parent's own heading/excellentOnly/mineOnly logic), so the
  // count is the only thing worth lifting up.
  useEffect(() => {
    if (onFilteredCountChange) onFilteredCountChange(filteredPlans.length);
  }, [filteredPlans, onFilteredCountChange]);

  // Auto-expand and select the most recent 年份-学期 group's first school's
  // first teacher on first load (and whenever the previously-selected
  // group/school/teacher no longer exists, e.g. after a delete) -- an empty
  // right panel on first load would just be a dead end the user has to know
  // to click past.
  useEffect(() => {
    if (groups.length === 0) {
      setSelected(null);
      return;
    }
    const stillValid =
      selected &&
      groups.some((g) => {
        if (g.key !== selected.groupKey) return false;
        const s = g.schoolList.find((s) => s.schoolKey === selected.schoolKey);
        return s && s.teacherList.some((t) => String(t.teacherId) === selected.teacherId);
      });
    if (stillValid) return;

    const firstGroup = groups[0];
    setExpandedGroups((prev) => ({ ...prev, [firstGroup.key]: true }));
    const firstSchool = firstGroup.schoolList[0];
    if (firstSchool) {
      setExpandedSchools((prev) => ({ ...prev, [`${firstGroup.key}|${firstSchool.schoolKey}`]: true }));
    }
    if (firstSchool && firstSchool.teacherList.length > 0) {
      setSelected({ groupKey: firstGroup.key, schoolKey: firstSchool.schoolKey, teacherId: String(firstSchool.teacherList[0].teacherId) });
    } else {
      setSelected(null);
    }
    // Only re-run when the set of groups actually changes shape (plans
    // reloaded) -- not on every `selected`/`expandedGroups`/`expandedSchools`
    // update, which this effect itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  // A `selected` restored straight from the URL (see initialParams above)
  // arrives with no matching expandedGroups/expandedSchools entry -- without
  // this, the right panel would correctly show the restored teacher's plans
  // while the tree itself sat fully collapsed around it, hiding the very row
  // that's supposedly selected. The stillValid branch above already expands
  // its own first-group/first-school explicitly; this covers every other
  // path that can set `selected` (this one included, harmlessly redundant
  // there) with a single rule instead of repeating it at each call site.
  useEffect(() => {
    if (!selected) return;
    setExpandedGroups((prev) => (prev[selected.groupKey] ? prev : { ...prev, [selected.groupKey]: true }));
    const schoolExpandKey = `${selected.groupKey}|${selected.schoolKey}`;
    setExpandedSchools((prev) => (prev[schoolExpandKey] ? prev : { ...prev, [schoolExpandKey]: true }));
  }, [selected]);

  const toggleGroup = (key) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
    // Closing a group hides its school/teacher leaves, so a plan selected
    // from that group would otherwise keep showing on the right with no
    // corresponding visible/expanded entry in the nav -- clear it.
    setSelected((prev) => (prev && prev.groupKey === key && expandedGroups[key] ? null : prev));
  };
  const toggleSchool = (groupKey, schoolKey) => {
    const expandKey = `${groupKey}|${schoolKey}`;
    setExpandedSchools((prev) => ({ ...prev, [expandKey]: !prev[expandKey] }));
    // Same "closing hides the selection's home, so clear it" logic as
    // toggleGroup above, one level deeper.
    setSelected((prev) =>
      prev && prev.groupKey === groupKey && prev.schoolKey === schoolKey && expandedSchools[expandKey] ? null : prev
    );
  };
  const selectTeacher = (groupKey, schoolKey, teacherId) => setSelected({ groupKey, schoolKey, teacherId: String(teacherId) });

  // Keeps this page's own URL in sync with its filter/selection state (via
  // history.replace -- a silent swap of the current entry, not a new one, so
  // typing in a filter box doesn't pile up history entries) -- the other
  // half of what makes 返回 restore this state: plan-detail.component.js's
  // goBack() only has something to land back on if the entry it pops to
  // actually carries these params, which requires them to already be part of
  // the URL *before* the user ever clicked into a plan. Preserves whatever
  // params this route already had for other reasons (mine/status/
  // templateVersionId -- see plans-list.component.js) by starting from the
  // current search string rather than building a fresh one.
  useEffect(() => {
    const params = new URLSearchParams(location.search || "");
    const setOrDelete = (key, value) => {
      if (value) params.set(key, value);
      else params.delete(key);
    };
    setOrDelete("submitted", filterSubmitted ? "1" : "");
    setOrDelete("aiReviewed", filterAiReviewed ? "1" : "");
    setOrDelete("expertReviewed", filterExpertReviewed ? "1" : "");
    setOrDelete("teacherName", filterTeacherName);
    setOrDelete("schoolName", filterSchoolName);
    setOrDelete("theme", filterTheme);
    setOrDelete("selGroup", selected ? selected.groupKey : "");
    setOrDelete("selSchool", selected ? selected.schoolKey : "");
    setOrDelete("selTeacher", selected ? selected.teacherId : "");

    const nextSearch = params.toString();
    if (nextSearch !== (location.search || "").replace(/^\?/, "")) {
      history.replace({ pathname: location.pathname, search: nextSearch });
    }
    // Deliberately excludes `history`/`location` -- both are stable-enough
    // router objects that including them risks re-firing this effect off of
    // history.replace's own resulting location change (the nextSearch guard
    // above already prevents a real loop, but there's no reason to depend on
    // that guard when the actual state that should trigger a re-sync is
    // fully listed below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterSubmitted,
    filterAiReviewed,
    filterExpertReviewed,
    filterTeacherName,
    filterSchoolName,
    filterTheme,
    selected,
  ]);

  const currentUserId = () => {
    const user = AuthService.getCurrentUser();
    return user ? user.id : null;
  };
  const isOwnerOf = (item) => AuthService.isTeacher() && String(item.teacherId) === String(currentUserId());
  const canEditItem = (item) => !item.suspended && isOwnerOf(item);
  const canDeleteItem = (item) => AuthService.isAdmin() || isOwnerOf(item);

  const onDelete = async (item) => {
    const ok = window.confirm("此操作将永久删除该课程设计及其所有附件与点评，且无法撤销。确定继续吗？");
    if (!ok) return;
    try {
      await PlanDataService.delete(item.id, true);
      setMessage("课程设计删除成功。");
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "删除失败。");
    }
  };
  const toggleExcellent = async (item) => {
    try {
      await PlanDataService.update(item.id, { isExcellentCase: !item.isExcellentCase });
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };
  const toggleSuspend = async (item) => {
    if (!item.suspended) {
      const ok = window.confirm(`确定停用「${item.title}」吗？停用后该课程设计将从公开列表中隐藏，仅本人与管理员可见。`);
      if (!ok) return;
    }
    try {
      if (item.suspended) await PlanDataService.unsuspend(item.id);
      else await PlanDataService.suspend(item.id);
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };

  const selectedGroup = selected ? groups.find((g) => g.key === selected.groupKey) : null;
  const selectedSchool = selectedGroup ? selectedGroup.schoolList.find((s) => s.schoolKey === selected.schoolKey) : null;
  const selectedTeacher = selectedSchool ? selectedSchool.teacherList.find((t) => String(t.teacherId) === selected.teacherId) : null;

  return (
    <>
      {showReviewFilters && (
        <div className="mb-3">
          <div className="form-row">
            <div className="form-group col-md-4">
              <label>教师姓名筛选</label>
              <input
                className="form-control"
                placeholder="按教师姓名搜索"
                value={filterTeacherName}
                onChange={(e) => setFilterTeacherName(e.target.value)}
              />
            </div>
            <div className="form-group col-md-4">
              <label htmlFor="schoolFilter">学校名称筛选</label>
              <Select
                inputId="schoolFilter"
                options={schoolOptions}
                value={schoolOptions.find((o) => o.label === filterSchoolName) || null}
                onChange={(option) => setFilterSchoolName(option ? option.label : "")}
                placeholder="搜索并选择学校（支持名称/代码）..."
                formatOptionLabel={formatSchoolOptionLabel}
                filterOption={schoolFilterOption}
                isClearable
              />
            </div>
            <div className="form-group col-md-4">
              <label>主题筛选</label>
              <select className="form-control" value={filterTheme} onChange={(e) => setFilterTheme(e.target.value)}>
                <option value="">全部主题</option>
                {themeOptions.map((theme) => (
                  <option key={theme} value={theme}>
                    {theme}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
      {showReviewFilters && (
        <div className="pl-filter-bar mb-3">
          {showSubmittedToggle && (
            <button
              type="button"
              className={`pl-filter-toggle ${filterSubmitted ? "is-active" : ""}`}
              onClick={() => setFilterSubmitted((prev) => !prev)}
            >
              已提交
            </button>
          )}
          <button
            type="button"
            className={`pl-filter-toggle pl-filter-toggle-ai ${filterAiReviewed ? "is-active" : ""}`}
            onClick={() => setFilterAiReviewed((prev) => !prev)}
          >
            AI已点评
          </button>
          <button
            type="button"
            className={`pl-filter-toggle pl-filter-toggle-expert ${filterExpertReviewed ? "is-active" : ""}`}
            onClick={() => setFilterExpertReviewed((prev) => !prev)}
          >
            专家已点评
          </button>
        </div>
      )}
      <div className="pl-explorer">
      <button
        type="button"
        className="pl-explorer-hide-toggle"
        onClick={() => setNavCollapsed((prev) => !prev)}
        title={navCollapsed ? "显示导航" : "隐藏导航"}
      >
        <i className={`fas fa-${navCollapsed ? "angle-double-right" : "angle-double-left"}`}></i>
      </button>

      {!navCollapsed && (
        <div className="pl-explorer-nav">
          {groups.length === 0 && <div className="pl-explorer-empty">暂无课程设计</div>}
          {groups.map((g) => (
            <div className="pl-explorer-group" key={g.key}>
              <button type="button" className="pl-explorer-folder" onClick={() => toggleGroup(g.key)}>
                <i className={`fas fa-chevron-${expandedGroups[g.key] ? "down" : "right"} pl-explorer-chevron`}></i>
                <i className="fas fa-folder-open pl-folder-icon mr-1"></i> {g.year}年 {g.season || "未设置学期"}
              </button>
              {expandedGroups[g.key] && (
                <div className="pl-explorer-children">
                  {g.schoolList.map((s) => {
                    const schoolExpandKey = `${g.key}|${s.schoolKey}`;
                    return (
                      <div className="pl-explorer-subgroup" key={s.schoolKey}>
                        <button
                          type="button"
                          className="pl-explorer-folder pl-explorer-subfolder"
                          onClick={() => toggleSchool(g.key, s.schoolKey)}
                        >
                          <i className={`fas fa-chevron-${expandedSchools[schoolExpandKey] ? "down" : "right"} pl-explorer-chevron`}></i>
                          <i className="fas fa-school mr-1"></i> {s.schoolName}
                        </button>
                        {expandedSchools[schoolExpandKey] && (
                          <div className="pl-explorer-children pl-explorer-children-nested">
                            {s.teacherList.map((t) => (
                              <button
                                key={t.teacherId}
                                type="button"
                                className={`pl-explorer-leaf pl-explorer-leaf-teacher ${
                                  selected &&
                                  selected.groupKey === g.key &&
                                  selected.schoolKey === s.schoolKey &&
                                  selected.teacherId === String(t.teacherId)
                                    ? "is-active"
                                    : ""
                                }`}
                                onClick={() => selectTeacher(g.key, s.schoolKey, t.teacherId)}
                              >
                                {t.teacherName}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="pl-explorer-content">
        {message && <div className="alert alert-info py-2">{message}</div>}
        {!selectedTeacher ? (
          <div className="pl-empty">请选择左侧的教师，查看其课程设计</div>
        ) : (
          <div className="pl-card">
            <h6>
              {selectedTeacher.teacherName} 的{excellentOnly ? "优秀案例" : "乡土课程"} -- {selectedGroup.year}年{" "}
              {selectedGroup.season || "未设置学期"}
              （共 {selectedTeacher.plans.length} 项）
            </h6>
            <div className="pl-plan-grid mt-3">
              {selectedTeacher.plans.map((item) => (
                <PlanCard
                  key={item.id}
                  item={item}
                  canEdit={canEditItem(item)}
                  canDelete={canDeleteItem(item)}
                  onDelete={onDelete}
                  onToggleExcellent={toggleExcellent}
                  onToggleSuspend={toggleSuspend}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
};

export default PlansHierarchy;
