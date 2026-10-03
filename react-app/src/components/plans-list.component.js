import React, { useCallback, useEffect, useMemo, useState } from "react";
import mammoth from "mammoth";
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
// forced on for the public "课程案例库" gallery via props.excellentOnly).
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
  // Set only via the 模板管理 page's "相关课程计划" count link
  // (/plans?templateVersionId=X) -- forces the flat/paginated view (see
  // isManagerOrExpertView below) instead of the year/school/teacher
  // hierarchy tree, since a template-filtered list is naturally small and
  // flat, same reasoning as effectiveMineOnly.
  const templateVersionIdFilter = queryParams.get("templateVersionId") || "";

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
  // Reported up from plans-hierarchy.component.js's own review-status
  // filter toggles (only meaningful on the admin's plain "全部乡土课程" view --
  // see showHierarchyCount below) so the count can sit next to this page's
  // own title instead of living inside the filter bar.
  const [hierarchyFilteredCount, setHierarchyFilteredCount] = useState(null);

  // Only teachers author a new plan -- managers/experts manage existing
  // cases (suspend/delete/promote/review) but don't create their own, matching
  // plan.routes.js's isTeacher-only gate on POST /api/plans.
  const canCreate = !excellentOnly && AuthService.isTeacher();
  // Only the explicit ?mine=true landing link puts a teacher into "my
  // plans" mode now -- bare /plans instead lands a teacher on the same
  // 全部乡土课程 hierarchy view admin/expert get (see isManagerOrExpertView
  // below and plan.controller.js#findAll's requesterIsTeacher, which grants
  // teachers the same cross-school visibility as an expert). A manager is
  // only ever interested in all plans, so there's no "只看我的" toggle to
  // offer them either (removed; previously shown to admin only).
  const effectiveMineOnly = mineOnly;

  // Manager/expert/teacher's bare /plans, expert's /plans?status=submitted,
  // and the public 优秀案例 gallery (excellentOnly) all land here, and all
  // of them get the year-学期 -> school -> teacher explorer
  // (plans-hierarchy.component.js) instead of this component's own flat
  // search/paginate/grid -- one view for every audience on the gallery
  // (admin, expert, teacher, or a logged-out visitor), not just staff. Only
  // a teacher's own list (effectiveMineOnly, via ?mine=true) is unaffected,
  // since that's a small, non-hierarchical set by nature.
  const isManagerOrExpertView =
    !templateVersionIdFilter &&
    (excellentOnly || ((AuthService.isAdmin() || AuthService.isExpert() || AuthService.isTeacher()) && !effectiveMineOnly));
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
        templateVersionId: templateVersionIdFilter || undefined,
      });
      setPlans(resp.data.rows || []);
      setTotalPages(resp.data.totalPages || 0);
      setTotalItems(resp.data.totalItems || 0);
    } catch (e) {
      console.log(e);
      setMessage("加载课程设计数据失败。");
    }
  }, [
    page,
    pageSize,
    keyword,
    searchYear,
    searchTheme,
    searchGrade,
    effectiveMineOnly,
    statusFilter,
    excellentOnly,
    isManagerOrExpertView,
    templateVersionIdFilter,
  ]);

  useEffect(() => {
    retrieveAll();
  }, [retrieveAll]);

  // 欣欣小助手 created/edited/submitted/deleted a plan (see copilot-panel.
  // component.js#announceChanges) -- reload so e.g. a draft it just built
  // shows up in 我的乡土课程 without a manual refresh. Any change counts, not
  // just ids already on screen: a newly created plan isn't in the list yet.
  useEffect(() => {
    window.addEventListener("copilot:data-changed", retrieveAll);
    return () => window.removeEventListener("copilot:data-changed", retrieveAll);
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

  // Opens a blank window synchronously, before the first await, so the
  // browser attributes it to this click and doesn't treat it as a
  // popup-blocked async open -- then fills it in once the doc's converted.
  // Same pattern as plan-detail.component.js's DesignDocPanel#handlePreview.
  const previewTemplateFile = async (templateKey) => {
    const label = templateKey === "plan_design" ? "乡土课程设计方案模版" : "乡土课程实施记录模版";
    const win = window.open("", "_blank");
    if (win) win.document.write(`<title>预览：${label}</title><body>预览加载中...</body>`);
    try {
      const blankResp = await TemplateDataService.downloadBlank(templateKey);
      const result = await mammoth.convertToHtml({ arrayBuffer: blankResp.data });
      if (win) {
        win.document.open();
        win.document.write(
          `<!doctype html><html><head><meta charset="utf-8"><title>预览：${label}</title>` +
            `<style>body{max-width:800px;margin:24px auto;padding:0 16px;font-family:sans-serif;line-height:1.6;}</style>` +
            `</head><body>${result.value || "<p>文档内容为空。</p>"}</body></html>`
        );
        win.document.close();
      }
    } catch (e) {
      console.log(e);
      setMessage("模板预览失败。");
      if (win) win.close();
    }
  };

  // Plans an admin has started a migration campaign for (see
  // template-admin.component.js's 发起迁移 button) and this teacher hasn't
  // migrated yet -- drives the flashing 迁移 button below. `plans` here is
  // already this teacher's full own list (effectiveMineOnly's retrieveAll
  // fetches up to 200, unpaginated), so no extra request is needed just to
  // find out whether any need migrating.
  const plansNeedingMigration = plans.filter((p) => p.needsMigration);

  const handleMigrate = async () => {
    setMessage("");
    try {
      const resp = await PlanDataService.migrateMine();
      setMessage(resp.data && resp.data.message ? resp.data.message : "迁移完成。");
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "迁移失败。");
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
    ? "课程案例库"
    : templateVersionIdFilter
    ? "相关课程计划"
    : effectiveMineOnly
    ? "我的乡土课程"
    : statusFilter === "submitted"
    ? "待点评案例"
    : "全部乡土课程";

  // Every staff hierarchy view (admin/teacher's 全部乡土课程, the expert's
  // 待点评案例 queue) offers the review-status filter toggles and reports a
  // filtered count up -- see plans-hierarchy.component.js's own identical
  // showReviewFilters condition. Only the public 优秀案例 gallery never
  // reports one, so this stays null there.
  const showHierarchyCount = isManagerOrExpertView && !excellentOnly && hierarchyFilteredCount !== null;

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
          {showHierarchyCount && `（总数：${hierarchyFilteredCount}）`}
        </h4>
      )}

      {isManagerOrExpertView ? (
        <PlansHierarchy
          statusFilter={statusFilter}
          excellentOnly={excellentOnly}
          onFilteredCountChange={setHierarchyFilteredCount}
        />
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
          {plansNeedingMigration.length > 0 && (
            <button
              className="btn btn-warning mr-3 pl-flash-migrate"
              type="button"
              onClick={handleMigrate}
              title={`有 ${plansNeedingMigration.length} 个乡土课程设计使用旧版模板，点击迁移到最新模板`}
            >
              迁移课程计划（{plansNeedingMigration.length}）
            </button>
          )}
          <button className="btn btn-primary mr-3" type="button" onClick={createEmptyPlan}>
            新增乡土课程
          </button>
          <span className="mr-3">
            乡土课程设计方案模版：
            <button className="btn btn-link p-0 ml-1 mr-2" type="button" onClick={() => downloadTemplateFile("plan_design")}>
              下载
            </button>
            <button className="btn btn-link p-0" type="button" onClick={() => previewTemplateFile("plan_design")}>
              预览
            </button>
          </span>
          <span>
            乡土课程实施记录模版：
            <button
              className="btn btn-link p-0 ml-1 mr-2"
              type="button"
              onClick={() => downloadTemplateFile("lesson_execution")}
            >
              下载
            </button>
            <button className="btn btn-link p-0" type="button" onClick={() => previewTemplateFile("lesson_execution")}>
              预览
            </button>
          </span>
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
              showTeacher={!effectiveMineOnly}
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
