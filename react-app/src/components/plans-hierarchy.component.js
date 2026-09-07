import React, { useCallback, useEffect, useMemo, useState } from "react";
import PlanDataService from "../services/plan.service";
import AuthService from "../services/auth.service";
import PlanCard from "./plan-card.component";
import "../curriculum.css";

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

const PlansHierarchy = ({ statusFilter, excellentOnly }) => {
  const [plans, setPlans] = useState([]);
  const [message, setMessage] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({});
  // Keyed by `${groupKey}|${schoolKey}` -- a school can appear under
  // multiple year/season groups, so its expand state must be scoped per
  // group, not global.
  const [expandedSchools, setExpandedSchools] = useState({});
  const [selected, setSelected] = useState(null); // { groupKey, schoolKey, teacherId }

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

  const groups = useMemo(() => buildHierarchy(plans), [plans]);

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
        return s && s.teacherList.some((t) => t.teacherId === selected.teacherId);
      });
    if (stillValid) return;

    const firstGroup = groups[0];
    setExpandedGroups((prev) => ({ ...prev, [firstGroup.key]: true }));
    const firstSchool = firstGroup.schoolList[0];
    if (firstSchool) {
      setExpandedSchools((prev) => ({ ...prev, [`${firstGroup.key}|${firstSchool.schoolKey}`]: true }));
    }
    if (firstSchool && firstSchool.teacherList.length > 0) {
      setSelected({ groupKey: firstGroup.key, schoolKey: firstSchool.schoolKey, teacherId: firstSchool.teacherList[0].teacherId });
    } else {
      setSelected(null);
    }
    // Only re-run when the set of groups actually changes shape (plans
    // reloaded) -- not on every `selected`/`expandedGroups`/`expandedSchools`
    // update, which this effect itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

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
  const selectTeacher = (groupKey, schoolKey, teacherId) => setSelected({ groupKey, schoolKey, teacherId });

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
  const selectedTeacher = selectedSchool ? selectedSchool.teacherList.find((t) => t.teacherId === selected.teacherId) : null;

  return (
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
                                  selected.teacherId === t.teacherId
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
  );
};

export default PlansHierarchy;
