import React from "react";
import { Link } from "react-router-dom";
import AuthService from "../services/auth.service";
import { tr, LOCALE } from "../i18n";

const STATUS_LABELS = { draft: tr("草稿"), submitted: tr("已提交"), reviewed: tr("已点评") };

// Shared plan summary card -- originally inline in plans-list.component.js's
// flat grid, extracted so plans-hierarchy.component.js (the manager/expert
// year-学期 -> teacher navigation view) can render the exact same card in its
// right-hand panel without duplicating the markup/actions. canEdit/canDelete
// are pre-computed booleans (the caller's own canEditItem(item)/
// canDeleteItem(item)), not functions, keeping this component a plain
// presentational one; the 优秀案例/停用 admin toggles stay gated on
// AuthService.isAdmin() directly here since that's a fixed, caller-independent
// rule, not something either caller needs to vary.
//
// showTeacher: the card omits the teacher's name by default, since most
// callers already establish whose plans these are via their own navigation
// path (plans-hierarchy.component.js's selected-teacher panel header, or
// plans-list.component.js's ?mine=true "我的乡土课程" view). Pass true from a
// caller whose list can mix plans from different teachers with no such
// context of its own (template-admin.component.js's 相关课程计划 modal, and
// plans-list.component.js's own flat grid when it's showing that same
// cross-teacher ?templateVersionId list rather than ?mine=true).
//
// searchHit: { rank, label, snippet } while 全部乡土课程's 语义搜索 filter is
// on (plans-hierarchy.component.js) -- the plan's rank and the field that
// matched.
const PlanCard = ({ item, canEdit, canDelete, onDelete, onToggleExcellent, onToggleSuspend, showTeacher, searchHit }) => (
  <div className="pl-plan-card">
    {item.isExcellentCase && <span className="pl-plan-card-excellent">{tr("优秀案例")}</span>}
    {item.suspended && <span className="pl-plan-card-suspended">{tr("已停用")}</span>}
    <div className="pl-plan-card-head">
      <div className="pl-plan-card-badge">
        <i className="fas fa-seedling"></i>
      </div>
      <div>
        <h6 className="pl-plan-card-title">{item.title}</h6>
        <div className="pl-plan-card-year">
          {item.year || "-"} {tr("年")}{item.season ? ` · ${tr(item.season)}` : ""}
          {showTeacher && <> · {(item.Teacher && (item.Teacher.chineseName || item.Teacher.username)) || tr("教师未知")}</>}
        </div>
      </div>
    </div>

    <div className="pl-plan-card-tags">
      {item.theme && <span className="pl-tag">{tr(item.theme)}</span>}
      <span className={`pl-plan-card-status status-${item.status || "draft"}`}>{STATUS_LABELS[item.status] || STATUS_LABELS.draft}</span>
      {/* Two distinct flashing states, never both at once (migrateMine
          clears needsMigration on the same write that may set
          needsManualMigrationReview) -- see curriculum.css's
          .pl-flash-migrate/-manual and plan.model.js's comments on both
          flags. */}
      {item.needsMigration && <span className="pl-plan-card-migrate-flag pl-flash-migrate">{tr("待迁移")}</span>}
      {item.needsManualMigrationReview && <span className="pl-plan-card-manual-flag pl-flash-manual">{tr("待手动整理")}</span>}
    </div>

    {searchHit && (
      <div className="pl-plan-card-hit">
        <span className="pl-semantic-rank mr-1">{searchHit.rank}</span>
        <span className="pl-semantic-field">{searchHit.label}</span>
        {searchHit.snippet}
      </div>
    )}

    <div className="pl-plan-card-meta">
      <span>
        <i className="fas fa-graduation-cap"></i> {tr(item.grade) || tr("年级未定")}
      </span>
      <span>
        <i className="fas fa-clock"></i> {item.plannedLessonCount ? tr("{item.plannedLessonCount} 课时", { "item.plannedLessonCount": item.plannedLessonCount }) : tr("课时未定")}
      </span>
    </div>

    {/* item.myReviews: set only by an expert's 我的点评 list (plan.controller.js
        #findAll's reviewedByMe) -- the requester's own reviews on this plan. */}
    {item.myReviews && (
      <div className="pl-plan-card-meta mt-1">
        <span>
          <i className="fas fa-comment-dots"></i> {tr("已提交 {item.myReviews.submitted} 条", { "item.myReviews.submitted": item.myReviews.submitted })}
          {item.myReviews.saved > 0 && tr(" · 未提交 {item.myReviews.saved} 条", { "item.myReviews.saved": item.myReviews.saved })}
        </span>
        {item.myReviews.lastAt && <span>{tr("最近")} {new Date(item.myReviews.lastAt).toLocaleDateString(LOCALE)}</span>}
      </div>
    )}

    <div className="pl-plan-card-footer">
      {/* Basic-info editing now lives entirely on the plan detail page's own
          基本信息 leaf -- this link is the sole entry point into a plan, so
          it reads "编辑" for the owner (same destination either way) rather
          than offering a separate list-level edit action. */}
      <Link className="btn btn-link p-0" to={item.myReviews ? `/plans/${item.id}?view=reviews` : `/plans/${item.id}`}>
        {canEdit ? tr("编辑") : item.myReviews ? tr("查看点评") : tr("查看详情")}
      </Link>
      <div>
        {AuthService.isAdmin() && (
          <button className="btn btn-link p-0 mr-2" onClick={() => onToggleExcellent(item)}>
            {item.isExcellentCase ? tr("取消优秀案例") : tr("设为优秀案例")}
          </button>
        )}
        {AuthService.isAdmin() && (
          <button className="btn btn-link p-0 mr-2" onClick={() => onToggleSuspend(item)}>
            {item.suspended ? tr("启用") : tr("停用")}
          </button>
        )}
        {canDelete && (
          <button className="btn btn-link p-0 text-danger" onClick={() => onDelete(item)}>
            {tr("删除")}
          </button>
        )}
      </div>
    </div>
  </div>
);

export default PlanCard;
