import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mammoth from "mammoth/mammoth.browser";
import PlanDataService from "../services/plan.service";
import AuthService from "../services/auth.service";
import Pagination from "@material-ui/lab/Pagination";
import PlanCard from "./plan-card.component";
import PlansHierarchy from "./plans-hierarchy.component";
import { PLAN_THEMES, PLAN_GRADES, PLAN_SEASONS, currentSeason, EMPTY_WHY_WHAT_HOW, WHY_WHAT_HOW_FIELD_LABELS } from "../constants/plan-options";
import "../curriculum.css";

const emptyForm = {
  title: "",
  theme: "",
  grade: "",
  year: "",
  season: "",
  plannedLessonCount: "",
};

const UPLOAD_FIELD_LABELS = { title: "标题", grade: "年级", plannedLessonCount: "预计课时" };

const GRADE_DIGIT_TO_LABEL = {
  "1": "一年级", "2": "二年级", "3": "三年级", "4": "四年级", "5": "五年级", "6": "六年级",
  "一": "一年级", "二": "二年级", "三": "三年级", "四": "四年级", "五": "五年级", "六": "六年级",
};

// Best-effort field extraction against curriculum_template/乡土课程设计方案模版.docx's
// labeled header (课程名称/任教年级/预计课时 -- 乡土主题 and 年份 aren't labeled in
// the template at all, so those are never guessed, only ever filled in by hand).
const extractPlanFieldsFromText = (text) => {
  const result = {};

  // [ \t]* rather than \s* after the colon -- \s* also matches a newline, so a
  // field left completely blank (just "课程名称：" with nothing else on the
  // line) would otherwise have its regex spill across the paragraph break and
  // capture the next line's label ("任教年级：") as this field's value.
  const titleMatch = text.match(/课程名称[：:][ \t]*([^\n]+)/);
  if (titleMatch && titleMatch[1].trim()) result.title = titleMatch[1].trim();

  const gradeMatch = text.match(/任教年级[：:][ \t]*([^\n]+)/);
  if (gradeMatch) {
    const raw = gradeMatch[1];
    // Real submissions don't always spell the grade out as "五年级" -- e.g.
    // "小学5—6年" -- so fall back to mapping a bare digit/Chinese numeral to
    // its PLAN_GRADES label (first one found, for a range like "5—6年").
    const found = PLAN_GRADES.find((g) => raw.includes(g)) || GRADE_DIGIT_TO_LABEL[(raw.match(/[1-6一二三四五六]/) || [])[0]];
    if (found) result.grade = found;
  }

  const lessonMatch = text.match(/预计课时[：:]\s*(\d+)/);
  if (lessonMatch) result.plannedLessonCount = lessonMatch[1];

  return result;
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches a label at the start of a paragraph line, optionally preceded by the
// template's own numbering ("2.驱动问题", "4公开展示方式") -- anchoring to a line
// start (not "anywhere in the text") is what lets this tell an actual field
// heading apart from the same words showing up mid-sentence in someone's answer
// (e.g. a real submission's 知识探究 content included the prose "...师生共创驱动
// 问题、确定最终成果..." -- an unanchored search would mistake that for the
// what.drivingQuestion heading and steal its neighbor's content). Also matches a
// label wrapped across a line break by Word/mammoth (a real submission had
// "反思与迭代" split into two paragraphs, "反思" then "与迭代") since \s* between
// each of the label's characters absorbs the newline. Returns the matched span
// (idx + length), not just label.length, since a wrapped/prefixed match is
// longer than the label itself.
const findLabel = (text, label) => {
  const pattern = label.split("").map(escapeRegExp).join("\\s*");
  const m = text.match(new RegExp(`^[\\d.．\\s]{0,6}(${pattern})`, "m"));
  if (!m) return null;
  return { idx: m.index + m[0].indexOf(m[1]), length: m[1].length };
};

// Section/sub-section headings that aren't fields themselves but mark hard
// content boundaries, used only as a fallback when the upload isn't shaped like
// the template's table (see extractWhyWhatHowFromText) and there's no row/cell
// structure to bound content instead.
const HARD_SECTION_BOUNDARIES = ["WHY", "WHAT", "HOW", "活动设计", "探究与制作", "三、出项", "第二部分：分课时设计"];

// Finds every known label's position within one block of text (in document
// order, not list order) and takes each field's content as the text up to
// whichever position comes next -- boundaryLabels (if any) are extra stop
// points that cap content but never become a field's own value, for callers
// with no other way to bound a field whose neighbor is missing or empty.
const extractFieldsFromBlock = (text, boundaryLabels = []) => {
  const fieldPositions = WHY_WHAT_HOW_FIELD_LABELS.map(([path, label]) => ({ path, ...findLabel(text, label) })).filter(
    (p) => p.idx != null
  );
  const boundaryPositions = boundaryLabels
    .map((label) => findLabel(text, label))
    .filter(Boolean)
    .map((m) => ({ path: null, ...m }));
  const positions = [...fieldPositions, ...boundaryPositions].sort((a, b) => a.idx - b.idx);

  const result = {};
  positions.forEach((p, i) => {
    if (!p.path) return;
    const contentStart = p.idx + p.length;
    const contentEnd = i + 1 < positions.length ? positions[i + 1].idx : text.length;
    let content = text.slice(contentStart, contentEnd);
    content = content.replace(/^[（(][^）)]*[）)]/, ""); // e.g. trailing "（为什么做这个乡土主题？）" right after a label
    content = content.replace(/^[：:]/, "");
    // Strip stray leading whitespace/bullets/tab/ideographic-comma noise, but not a
    // leading "1."/"1)" -- a real multi-item answer (e.g. cognitiveGoals' "1. .../2.
    // .../3. ...") needs its first item's number kept, since only the first item
    // sits right after the label match and would otherwise be the one item silently
    // missing its number while every later "2."/"3." in the same block stays intact.
    content = content.replace(/^[\s•·\t、]+/, "");
    content = content.trim();
    if (content) result[p.path] = content;
  });
  return result;
};

// Splits mammoth's table HTML into one flattened text block per <tr>, cell by
// cell, paragraph by paragraph -- i.e. the same per-paragraph text
// extractRawText would produce, just grouped by which table row each paragraph
// physically belongs to. Returns null if there's no table to find (e.g. an
// upload that isn't shaped like the template at all), so callers can fall back
// to treating the whole document as one block.
const tableRowTexts = (html) => {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;
  const cellText = (cell) => {
    const paras = Array.from(cell.querySelectorAll(":scope > p, :scope > ul > li, :scope > ol > li"));
    return (paras.length ? paras.map((p) => p.textContent || "") : [cell.textContent || ""]).join("\n");
  };
  return Array.from(table.querySelectorAll("tr")).map((tr) => Array.from(tr.querySelectorAll("td, th")).map(cellText).join("\n"));
};

// Best-effort extraction of the WHY/WHAT/HOW body into the same shape the
// online-fill form uses (EMPTY_WHY_WHAT_HOW), so an uploaded plan renders
// through the same section-by-section presentation as one filled in online,
// not just an attached file.
//
// The template (curriculum_template/乡土课程设计方案模版.docx) is a single table,
// one field (or a handful of related fields) per row, and real submissions keep
// that same row layout since authors type directly into the template's cells.
// So rather than pattern-matching over the entire document flattened into one
// string, this processes each table row as its own independent block (see
// tableRowTexts) -- a table row is *by construction* the field boundary the old
// flat-text approach had to fake with a hardcoded HARD_SECTION_BOUNDARIES list
// (a field can only ever swallow noise from within its own row/cell now, never
// bleed into an unrelated section several rows away just because its neighbor
// label was missing or left empty). A real filled-in document still mixes two
// styles within a row -- "标签：内容" inline (WHY's four goals) and "标题\n内容段落"
// (HOW's activities) -- extractFieldsFromBlock's position-based boundary works
// for both uniformly. Falls back to the old whole-document/HARD_SECTION_BOUNDARIES
// approach if mammoth can't find a table at all. Fields whose label isn't found
// are left blank rather than guessed; if the same field label were somehow
// matched in more than one row, the first (in document order) wins.
const extractWhyWhatHowFromText = (text, html) => {
  const rowTexts = html && tableRowTexts(html);
  if (!rowTexts || !rowTexts.length) return extractFieldsFromBlock(text, HARD_SECTION_BOUNDARIES);

  const result = {};
  for (const rowText of rowTexts) {
    const rowResult = extractFieldsFromBlock(rowText);
    for (const [path, value] of Object.entries(rowResult)) {
      if (!(path in result)) result[path] = value;
    }
  }
  return result;
};

const buildPlanFormData = (extracted, lessons) => {
  const data = { why: { ...EMPTY_WHY_WHAT_HOW.why }, what: { ...EMPTY_WHY_WHAT_HOW.what }, how: { ...EMPTY_WHY_WHAT_HOW.how }, lessons: lessons || [] };
  for (const [path, value] of Object.entries(extracted)) {
    const [section, field] = path.split(".");
    data[section][field] = value;
  }
  return data;
};

// Leading-whitespace class used by the Part 2 regexes below (not \s -- \s also
// matches a newline, which would let e.g. "第一课时：" with nothing else on the
// line swallow the blank line after it and capture the *next* heading as this
// one's inline title, the same class of bug findLabel had to avoid for Part 1's
// labels). A real submission's lesson headings are inconsistently indented --
// some with a couple of regular spaces, one with a literal U+00A0 non-breaking
// space -- so this covers ordinary spaces/tabs plus the common Unicode space
// variants, not just " ".
const PART2_LEADING_WS = "[ \\t\\u00a0\\u2000-\\u200a\\u3000]*";
const PART2_HEADING_RE = new RegExp(`^${PART2_LEADING_WS}第二部分[：:]?${PART2_LEADING_WS}分课时设计`, "m");
const LESSON_HEADING_RE = new RegExp(`^${PART2_LEADING_WS}第[0-9一二三四五六七八九十百]+课时[：:]?${PART2_LEADING_WS}([^\\n]*)`, "gm");
const PART3_HEADING_RE = new RegExp(`^${PART2_LEADING_WS}第三部分`, "m");

// Best-effort extraction of "第二部分：分课时设计" into the same
// [{ index, title, content }] shape planDocGenerator.js renders it from (see
// EMPTY_LESSON). This section lives entirely outside the template's table (see
// extractWhyWhatHowFromText's table-row approach for Part 1), as a flat run of
// paragraphs with no structure of its own beyond the "第N课时：" headings
// themselves, so it's handled independently over the whole flattened text
// rather than through tableRowTexts. Each "第N课时" heading may carry an inline
// title on the same line (e.g. "第1课时：入项激趣——认识一种...的米饼"); the
// i-th heading found becomes lesson i, by position rather than by parsing the
// heading's own numeral (Arabic and Chinese numerals are both used across the
// template/real submissions, and document order is always sequential in
// practice, so trusting position sidesteps numeral-parsing edge cases
// entirely). Content runs from right after one heading to the next, capped at
// "第三部分" for the last lesson if present (otherwise end of document) so it
// doesn't swallow the materials/resources section that can follow.
const extractLessonsFromText = (text) => {
  const part2Idx = text.search(PART2_HEADING_RE);
  if (part2Idx === -1) return [];
  const part2Text = text.slice(part2Idx);
  const matches = [...part2Text.matchAll(LESSON_HEADING_RE)];
  if (matches.length === 0) return [];
  const part3Idx = part2Text.search(PART3_HEADING_RE);
  const end = part3Idx === -1 ? part2Text.length : part3Idx;

  return matches
    .map((m, i) => {
      const contentStart = m.index + m[0].length;
      const contentEnd = i + 1 < matches.length ? matches[i + 1].index : end;
      if (contentEnd <= m.index) return null;
      const title = (m[1] || "").trim();
      const content = part2Text.slice(contentStart, contentEnd).trim();
      return { index: i + 1, title, content };
    })
    .filter((l) => l && (l.title || l.content));
};

const currentUserId = () => {
  const user = AuthService.getCurrentUser();
  return user ? user.id : null;
};

// Migrated from shinshin's cases-list.component.js: functional component, server-side
// pagination via @material-ui/lab Pagination, card-grid layout, slide-in drawer
// create/edit form, and the `stylishPublic` unauthenticated-view styling (here also
// forced on for the public "优秀案例展示" gallery via props.excellentOnly).
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
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalPages, setTotalPages] = useState(0);
  const [totalItems, setTotalItems] = useState(0);
  const [searchTheme, setSearchTheme] = useState("");
  const [searchGrade, setSearchGrade] = useState("");
  const [searchYear, setSearchYear] = useState("");
  // "从文件导入" is purely an initialization convenience, not a persisted plan
  // state -- every plan is always planMode='online' (see onSubmit), so it can
  // always be edited section-by-section afterward regardless of how it started.
  // Toggled by a button (see JSX below) rather than tied to any saved field.
  // The picked file only ever seeds form fields and the WHY/WHAT/HOW body
  // (best-effort, see extractPlanFieldsFromText/extractWhyWhatHowFromText) --
  // it's never itself attached as an artifact; 课程设计文件 is populated only by
  // generating a doc from the plan's (possibly pre-filled) online content.
  const [showFileImport, setShowFileImport] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadFormData, setUploadFormData] = useState(null);
  const uploadFileInputRef = useRef(null);

  // Only teachers author a new plan -- managers/experts manage existing
  // cases (suspend/delete/promote/review) but don't create their own, matching
  // plan.routes.js's isTeacher-only gate on POST /api/plans.
  const canCreate = !excellentOnly && AuthService.isTeacher();
  const stylishPublic = excellentOnly || !AuthService.isLogin();
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

  // Manager's bare /plans and expert's /plans?status=submitted both land
  // here, and both get the year-学期 -> teacher explorer (plans-hierarchy.
  // component.js) instead of this component's own flat search/paginate/grid
  // -- a teacher's own list (effectiveMineOnly) and the public 优秀案例
  // gallery (excellentOnly) are unaffected, they keep the flat view.
  const isManagerOrExpertView = (AuthService.isAdmin() || AuthService.isExpert()) && !excellentOnly && !effectiveMineOnly;

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

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    try {
      const payload = {
        title: form.title,
        theme: form.theme || null,
        grade: form.grade || null,
        year: Number(form.year),
        season: form.season || null,
        plannedLessonCount: form.plannedLessonCount ? Number(form.plannedLessonCount) : null,
        // Always 'online' -- 从文件导入 (see showFileImport) is only ever how a
        // plan gets its initial content, never a persisted state, so every plan
        // stays section-by-section editable regardless of how it started.
        planMode: "online",
      };
      if (!editingId && uploadFormData) {
        payload.planFormData = uploadFormData;
      }
      if (editingId) {
        await PlanDataService.update(editingId, payload);
        setMessage("课程设计更新成功。");
      } else {
        await PlanDataService.create(payload);
        setMessage("课程设计创建成功。");
      }
      setEditingId(null);
      setForm(emptyForm);
      setShowFileImport(false);
      setUploadFile(null);
      setUploadStatus("");
      setUploadFormData(null);
      setIsEditorOpen(false);
      retrieveAll();
    } catch (err) {
      setMessage(err?.response?.data?.message || "保存失败。");
    }
  };

  const handleUploadFile = async (file) => {
    if (!file) return;
    setUploadFile(file);
    setUploadStatus("正在解析文件...");
    const ext = (file.name || "").toLowerCase().split(".").pop();
    if (ext !== "docx") {
      setUploadStatus("已选择文件；仅支持自动识别 .docx 的内容，其余字段请手动填写。");
      return;
    }
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = result.value || "";
      // Also converted to HTML so extractWhyWhatHowFromText can walk the
      // template's actual table structure instead of just the flattened text --
      // see tableRowTexts.
      const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
      const html = htmlResult.value || "";

      const extracted = extractPlanFieldsFromText(text);
      const matchedLabels = Object.keys(extracted).map((k) => UPLOAD_FIELD_LABELS[k]);
      setForm((prev) => ({ ...prev, ...extracted }));

      const bodyExtracted = extractWhyWhatHowFromText(text, html);
      const bodyFieldCount = Object.keys(bodyExtracted).length;
      const lessons = extractLessonsFromText(text);
      const hasOnlineContent = bodyFieldCount > 0 || lessons.length > 0;
      setUploadFormData(hasOnlineContent ? buildPlanFormData(bodyExtracted, lessons) : null);

      const parts = [];
      if (matchedLabels.length > 0) parts.push(matchedLabels.join("、"));
      if (bodyFieldCount > 0) parts.push(`课程设计方案 WHY/WHAT/HOW 共 ${bodyFieldCount} 项内容`);
      if (lessons.length > 0) parts.push(`分课时设计共 ${lessons.length} 课时`);
      setUploadStatus(
        parts.length > 0
          ? `已从文件中识别：${parts.join("；")}${hasOnlineContent ? "，课程设计将以在线填写形式创建" : ""}，请核对后提交。`
          : "未能从文件中自动识别课程信息，请手动填写。"
      );
    } catch (err) {
      console.log(err);
      setUploadStatus("文件解析失败，请手动填写课程信息。");
    }
  };

  const openCreateEditor = () => {
    setEditingId(null);
    setForm({ ...emptyForm, year: String(new Date().getFullYear()), season: currentSeason(), theme: searchTheme });
    setShowFileImport(false);
    setUploadFile(null);
    setUploadStatus("");
    setUploadFormData(null);
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowFileImport(false);
    setUploadFile(null);
    setUploadStatus("");
    setUploadFormData(null);
    setIsEditorOpen(false);
  };

  const onEdit = (item) => {
    setEditingId(item.id);
    setForm({
      title: item.title || "",
      theme: item.theme || "",
      grade: item.grade || "",
      year: item.year ? String(item.year) : "",
      season: item.season || "",
      plannedLessonCount: item.plannedLessonCount ? String(item.plannedLessonCount) : "",
    });
    setShowFileImport(false);
    setUploadFile(null);
    setUploadStatus("");
    setUploadFormData(null);
    setIsEditorOpen(true);
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
    ? "优秀案例展示"
    : effectiveMineOnly
    ? "我的乡土课程"
    : statusFilter === "submitted"
    ? "待点评案例"
    : "乡土课程设计";

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
        <PlansHierarchy statusFilter={statusFilter} />
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
              {PLAN_THEMES.map((theme) => (
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
          <button className="btn btn-primary mr-3" type="button" onClick={openCreateEditor}>
            新增乡土课程设计
          </button>
          <a href="/templates/乡土课程设计方案模版.docx" download>
            下载乡土课程设计方案模版
          </a>
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
              onEdit={onEdit}
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

      {canCreate && isEditorOpen && (
        <div className="pl-drawer-layer">
          <button className="pl-drawer-mask" type="button" onClick={closeEditor} aria-label="close editor" />
          <div className="pl-drawer-panel">
            <div className="pl-drawer-head">
              <h5 className="mb-0">{editingId ? "编辑乡土课程设计" : "新增乡土课程设计"}</h5>
              <button className="btn btn-link p-0" type="button" onClick={closeEditor}>
                关闭
              </button>
            </div>
            <form onSubmit={onSubmit}>
              <div className="form-group">
                <label>标题</label>
                <input className="form-control" name="title" value={form.title} onChange={onChange} required />
              </div>
              <div className="form-group">
                <label>年份</label>
                <input
                  className="form-control"
                  name="year"
                  type="number"
                  min="1900"
                  max="2100"
                  value={form.year}
                  onChange={onChange}
                  required
                />
              </div>
              <div className="form-group">
                <label>学期</label>
                {/* No blank/required option -- season is nullable at the
                    backend (existing plans predate this field), always
                    defaulted to the current 学期 for a new plan (see
                    openCreateEditor), so there's nothing meaningful for a
                    blank choice to represent here. */}
                <select className="form-control" name="season" value={form.season} onChange={onChange}>
                  {PLAN_SEASONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>乡土主题</label>
                <select className="form-control" name="theme" value={form.theme} onChange={onChange}>
                  <option value="">请选择主题</option>
                  {PLAN_THEMES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>年级</label>
                <select className="form-control" name="grade" value={form.grade} onChange={onChange}>
                  <option value="">请选择年级</option>
                  {PLAN_GRADES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>预计课时</label>
                <input
                  className="form-control"
                  name="plannedLessonCount"
                  type="number"
                  min="1"
                  max="60"
                  value={form.plannedLessonCount}
                  onChange={onChange}
                />
              </div>
              {!editingId && (
                <div className="form-group">
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    onClick={() => setShowFileImport((v) => !v)}
                  >
                    {showFileImport ? "取消从文件导入" : "从文件导入内容"}
                  </button>
                </div>
              )}
              {showFileImport && !editingId && (
                <div className="form-group">
                  <label>上传乡土课程设计文件（可选，自动识别课程信息）</label>
                  <div
                    className={`pl-file-drop-zone ${uploadDragActive ? "is-dragover" : ""}`}
                    onClick={() => uploadFileInputRef.current && uploadFileInputRef.current.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setUploadDragActive(true);
                    }}
                    onDragLeave={() => setUploadDragActive(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setUploadDragActive(false);
                      handleUploadFile(e.dataTransfer?.files?.[0]);
                    }}
                  >
                    {uploadFile ? uploadFile.name : "拖拽课程设计文件到这里，或点击选择文件"}
                  </div>
                  <input
                    ref={uploadFileInputRef}
                    type="file"
                    className="d-none"
                    onChange={(e) => handleUploadFile(e.target.files[0])}
                  />
                  {uploadStatus && <small className="form-text text-muted">{uploadStatus}</small>}
                </div>
              )}
              <div className="d-flex">
                <button className="btn btn-primary mr-2" type="submit">
                  {editingId ? "更新" : "新增"}
                </button>
                <button className="btn btn-secondary" type="button" onClick={closeEditor}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default PlansList;
