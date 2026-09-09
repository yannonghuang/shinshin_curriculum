import React, { useCallback, useEffect, useMemo, useState } from "react";
import PlanDataService from "../services/plan.service";
import TemplateDataService from "../services/template.service";
import AuthService from "../services/auth.service";
import Pagination from "@material-ui/lab/Pagination";
import PlanCard from "./plan-card.component";
import PlansHierarchy from "./plans-hierarchy.component";
import { PLAN_THEMES, PLAN_GRADES, currentSeason } from "../constants/plan-options";
import "../curriculum.css";

const currentUserId = () => {
  const user = AuthService.getCurrentUser();
  return user ? user.id : null;
};

// Migrated from shinshin's cases-list.component.js: functional component, server-side
// pagination via @material-ui/lab Pagination, card-grid layout, slide-in drawer
// create/edit form, and the `stylishPublic` unauthenticated-view styling (here also
// forced on for the public "优秀案例库" gallery via props.excellentOnly).
//
// One component/route serves every /plans context (a teacher's own plans, an admin's
// full list, an expert's 待点评 queue, the public gallery) rather than separate pages --
// "mine vs all" is a live toggle (admin only, who's the sole role with legitimate
// access to both) instead of a route distinction, so there's exactly one layout to
// maintain instead of two.
const PlansList = (props) => {
  const location = props.location || window.location;
  const queryParams = useMemo(() => new URLSearchParams(location.search || ""), [location.search]);
  const mineOnly = queryParams.get("mine") === "true";
  const statusFilter = queryParams.get("status") || "";
  const excellentOnly = !!props.excellentOnly;

  const [plans, setPlans] = useState([]);
  const [message, setMessage] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalPages, setTotalPages] = useState(0);
  const [totalItems, setTotalItems] = useState(0);
  const [searchTheme, setSearchTheme] = useState("");
  // 乡土主题 filter options -- see plan-detail.component.js's identical
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
  const [searchGrade, setSearchGrade] = useState("");
  const [searchYear, setSearchYear] = useState("");

  // Only teachers author a new plan -- managers/experts manage existing
  // cases (suspend/delete/promote/review) but don't create their own, matching
  // plan.routes.js's isTeacher-only gate on POST /api/plans.
  const canCreate = !excellentOnly && AuthService.isTeacher();
  // A teacher never has a legitimate reason to browse "all plans" -- the
  // backend only ever shows them their own plans plus 优秀案例 (see
  // plan.controller.js#findAll's visibility rule), so treat any /plans visit
  // as "mine" for a teacher regardless of the mine= query param, not just the
  // ?mine=true landing link. Otherwise a teacher who reaches bare /plans
  // (e.g. by editing the URL) sees their own just-created ordinary plan
  // vanish, since it isn't excellent and isn't "mine" without this. Excluded
  // when excellentOnly (the public gallery) or statusFilter (an expert's
  // 待点评 queue) is in play -- neither of those is about plan ownership.
  // A manager is only ever interested in all plans, so there's no "只看我的"
  // toggle to offer them either (removed; previously shown to admin only).
  const effectiveMineOnly = mineOnly || (!excellentOnly && !statusFilter && AuthService.isTeacher());

  // Manager's bare /plans, expert's /plans?status=submitted, and the public
  // 优秀案例 gallery (excellentOnly) all land here, and all three get the
  // year-学期 -> teacher explorer (plans-hierarchy.component.js) instead of
  // this component's own flat search/paginate/grid -- one view for every
  // audience on the gallery (admin, expert, teacher, or a logged-out
  // visitor), not just staff. Only a teacher's own list (effectiveMineOnly)
  // is unaffected, since that's a small, non-hierarchical set by nature.
  // TODO: the flat view's search/filter (title keyword, year/grade/theme)
  // has no equivalent here yet -- the tree has no search of its own, so a
  // gallery visitor can currently only browse by year-学期/teacher, not
  // search across all excellent cases. Planned as a future addition.
  const isManagerOrExpertView = excellentOnly || ((AuthService.isAdmin() || AuthService.isExpert()) && !effectiveMineOnly);
  // stylishPublic (green pl-hero header, KPI cards, search/filter bar,
  // pagination) is the flat view's own chrome -- never shown alongside the
  // hierarchy view above, which has its own plain heading and conveys scale
  // via its own tree instead of totalItems/page counters that this
  // component's own paginated fetch (skipped entirely when
  // isManagerOrExpertView, see retrieveAll) would leave stuck at 0. Since
  // excellentOnly now always implies isManagerOrExpertView, this is only
  // ever true for a logged-out visitor on bare /plans.
  const stylishPublic = !isManagerOrExpertView && !AuthService.isLogin();

  const isOwnerOf = (item) => AuthService.isTeacher() && String(item.teacherId) === String(currentUserId());
  // Editing a plan's content is owner-only, no admin bypass -- managers can
  // suspend/delete/promote/leave notes (see below), but not edit case content.
  const canEditItem = (item) => !item.suspended && isOwnerOf(item);
  const canDeleteItem = (item) => AuthService.isAdmin() || isOwnerOf(item);

  const retrieveAll = useCallback(async () => {
    // The hierarchy view (see isManagerOrExpertView) fetches its own data
    // independently -- this component's own paginated fetch would just be
    // wasted work when its result is never rendered.
    if (isManagerOrExpertView) return;
    try {
      // No pagination UI in the mine=true view (a teacher's own plan count is
      // small by nature) -- fetch a generous single page instead of paging.
      const resp = await PlanDataService.getAll({
        page: effectiveMineOnly ? 0 : page - 1,
        size: effectiveMineOnly ? 200 : pageSize,
        keyword: keyword || undefined,
        year: searchYear || undefined,
        theme: searchTheme || undefined,
        grade: searchGrade || undefined,
        mine: effectiveMineOnly ? true : undefined,
        status: statusFilter || undefined,
        isExcellentCase: excellentOnly ? true : undefined,
      });
      setPlans(resp.data.rows || []);
      setTotalPages(resp.data.totalPages || 0);
      setTotalItems(resp.data.totalItems || 0);
    } catch (e) {
      console.log(e);
      setMessage("加载课程设计数据失败。");
    }
  }, [page, pageSize, keyword, searchYear, searchTheme, searchGrade, effectiveMineOnly, statusFilter, excellentOnly, isManagerOrExpertView]);

  useEffect(() => {
    retrieveAll();
  }, [retrieveAll]);

  // 新增乡土课程 creates an empty plan immediately (no upfront form) and
  // takes the user straight into it -- 基本信息 there (manual edit + upload,
  // see plan-detail.component.js) is now the only place that fills in
  // title/theme/grade/year/season/预计课时, whether typed by hand or
  // extracted from an uploaded .docx. title/year/planMode are the only
  // fields plan.controller.js#create actually requires; the rest default to
  // null/"draft" server-side.
  const createEmptyPlan = async () => {
    setMessage("");
    try {
      const resp = await PlanDataService.create({
        title: "未命名课程设计",
        year: new Date().getFullYear(),
        season: currentSeason(),
        planMode: "online",
      });
      props.history.push(`/plans/${resp.data.id}`);
    } catch (err) {
      setMessage(err?.response?.data?.message || "创建失败。");
    }
  };

  // Rendered on the fly from whichever template_versions row is currently
  // active for that key (see template.controller.js#downloadBlank) --
  // always matches what an admin last published in 模板管理, no static file
  // in public/ to fall out of sync with it.
  const downloadTemplateFile = async (templateKey) => {
    try {
      // Real uploaded templates should download under their own original
      // filename (see template.controller.js#downloadBlank/#upload's
      // sourceFileName) -- the hardcoded generic name below is only a
      // fallback for a hand-authored seed version, which has no uploaded
      // file of its own to name itself after.
      const [activeResp, blankResp] = await Promise.all([
        TemplateDataService.getActive(templateKey),
        TemplateDataService.downloadBlank(templateKey),
      ]);
      const fileName =
        (activeResp.data && activeResp.data.sourceFileName) ||
        `${templateKey === "plan_design" ? "乡土课程设计方案模版" : "课时实施记录模版"}.docx`;
      const url = window.URL.createObjectURL(
        new Blob([blankResp.data], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.log(e);
      setMessage("模板下载失败。");
    }
  };

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
      if (item.suspended) {
        await PlanDataService.unsuspend(item.id);
      } else {
        await PlanDataService.suspend(item.id);
      }
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "操作失败。");
    }
  };

  const onSearch = () => {
    setPage(1);
    retrieveAll();
  };

  const heading = excellentOnly
    ? "优秀案例库"
    : effectiveMineOnly
    ? "我的乡土课程"
    : statusFilter === "submitted"
    ? "待点评案例"
    : "全部乡土课程";

  return (
    <div className={`container ${stylishPublic ? "pl-page" : ""}`}>
      {stylishPublic ? (
        <div className="pl-hero">
          <h4 className="pl-title">{heading}</h4>
          <p className="pl-subtitle">按乡土主题与年级筛选浏览乡土课程设计。</p>
          <div className="pl-kpis">
            <span className="pl-kpi">总数：{totalItems}</span>
            <span className="pl-kpi">
              当前页：{page}/{totalPages || 1}
            </span>
          </div>
        </div>
      ) : (
        <h4>
          {heading}
          {/* totalItems tracks this component's own paginated fetch, which
              isManagerOrExpertView skips entirely (see retrieveAll) -- the
              hierarchy view's own tree conveys scale instead. */}
          {!isManagerOrExpertView && `（总数：${totalItems}）`}
        </h4>
      )}

      {isManagerOrExpertView ? (
        <PlansHierarchy statusFilter={statusFilter} excellentOnly={excellentOnly} />
      ) : (
        <>
      {/* A teacher's own plans list is small by nature -- search/filter/pagination
          are noise there, not a tool; every other view (admin's 全部, the public
          gallery, the expert queue) keeps them since those lists can be long. */}
      {!effectiveMineOnly && (
        <>
      <div className={stylishPublic ? "pl-card" : "mb-3"}>
        <div className="input-group">
          <input
            className="form-control"
            placeholder="按标题搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="input-group-append">
            <button className="btn btn-outline-secondary" type="button" onClick={onSearch}>
              搜索
            </button>
          </div>
        </div>
      </div>

      <div className={stylishPublic ? "pl-card" : "mb-3"}>
        <div className="form-row">
          <div className="form-group col-md-4">
            <label>年份筛选</label>
            <input
              className="form-control"
              type="number"
              min="1900"
              max="2100"
              placeholder="例如 2026"
              value={searchYear}
              onChange={(e) => setSearchYear(e.target.value)}
            />
          </div>
          <div className="form-group col-md-4">
            <label>年级筛选</label>
            <select className="form-control" value={searchGrade} onChange={(e) => setSearchGrade(e.target.value)}>
              <option value="">全部年级</option>
              {PLAN_GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group col-md-4">
            <label>主题筛选</label>
            <select
              className="form-control"
              value={searchTheme}
              onChange={(e) => {
                setSearchTheme(e.target.value);
                setPage(1);
              }}
            >
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
        </>
      )}

      {canCreate && (
        <div className={stylishPublic ? "pl-card" : "mb-3"}>
          <button className="btn btn-primary mr-3" type="button" onClick={createEmptyPlan}>
            新增乡土课程
          </button>
          <button className="btn btn-link p-0 mr-3" type="button" onClick={() => downloadTemplateFile("plan_design")}>
            下载乡土课程设计方案模版
          </button>
          <button className="btn btn-link p-0" type="button" onClick={() => downloadTemplateFile("lesson_execution")}>
            下载乡土课程实施记录模版
          </button>
        </div>
      )}

      {message && <div className="alert alert-info py-2">{message}</div>}

      {plans.length === 0 ? (
        <div className="pl-empty">暂无数据</div>
      ) : (
        <div className="pl-plan-grid">
          {plans.map((item) => (
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
      )}

      {!effectiveMineOnly && (
        <>
          <div className="mt-2 d-flex align-items-center">
            <label className="mr-2 mb-0">每页条数</label>
            <select
              className="form-control form-control-sm"
              style={{ width: "100px" }}
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </div>
          <Pagination
            className="my-3"
            count={totalPages || 1}
            page={page}
            siblingCount={1}
            boundaryCount={1}
            onChange={(event, value) => setPage(value)}
          />
        </>
      )}
        </>
      )}

    </div>
  );
};

export default PlansList;
