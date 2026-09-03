import React from "react";
import { Link } from "react-router-dom";
import AuthService from "../services/auth.service";

const STATUS_LABELS = { draft: "草稿", submitted: "已提交", reviewed: "已点评" };

// Shared plan summary card -- originally inline in plans-list.component.js's
// flat grid, extracted so plans-hierarchy.component.js (the manager/expert
// year-学期 -> teacher navigation view) can render the exact same card in its
// right-hand panel without duplicating the markup/actions. canEdit/canDelete
// are pre-computed booleans (the caller's own canEditItem(item)/
// canDeleteItem(item)), not functions, keeping this component a plain
// presentational one; the 优秀案例/停用 admin toggles stay gated on
// AuthService.isAdmin() directly here since that's a fixed, caller-independent
// rule, not something either caller needs to vary.
const PlanCard = ({ item, canEdit, canDelete, onEdit, onDelete, onToggleExcellent, onToggleSuspend }) => (
  <div className="pl-plan-card">
    {item.isExcellentCase && <span className="pl-plan-card-excellent">优秀案例</span>}
    {item.suspended && <span className="pl-plan-card-suspended">已停用</span>}
    <div className="pl-plan-card-head">
      <div className="pl-plan-card-badge">
        <i className="fas fa-seedling"></i>
      </div>
      <div>
        <h6 className="pl-plan-card-title">{item.title}</h6>
        <div className="pl-plan-card-year">
          {item.year || "-"} 年{item.season ? ` · ${item.season}` : ""}
        </div>
      </div>
    </div>

    <div className="pl-plan-card-tags">
      {item.theme && <span className="pl-tag">{item.theme}</span>}
      <span className={`pl-plan-card-status status-${item.status || "draft"}`}>{STATUS_LABELS[item.status] || STATUS_LABELS.draft}</span>
    </div>

    <div className="pl-plan-card-meta">
      <span>
        <i className="fas fa-graduation-cap"></i> {item.grade || "年级未定"}
      </span>
      <span>
        <i className="fas fa-clock"></i> {item.plannedLessonCount ? `${item.plannedLessonCount} 课时` : "课时未定"}
      </span>
    </div>

    <div className="pl-plan-card-footer">
      <Link className="btn btn-link p-0" to={`/plans/${item.id}`}>
        查看详情
      </Link>
      <div>
        {AuthService.isAdmin() && (
          <button className="btn btn-link p-0 mr-2" onClick={() => onToggleExcellent(item)}>
            {item.isExcellentCase ? "取消优秀案例" : "设为优秀案例"}
          </button>
        )}
        {AuthService.isAdmin() && (
          <button className="btn btn-link p-0 mr-2" onClick={() => onToggleSuspend(item)}>
            {item.suspended ? "启用" : "停用"}
          </button>
        )}
        {canEdit && (
          <button className="btn btn-link p-0 mr-2" onClick={() => onEdit(item)}>
            编辑
          </button>
        )}
        {canDelete && (
          <button className="btn btn-link p-0 text-danger" onClick={() => onDelete(item)}>
            删除
          </button>
        )}
      </div>
    </div>
  </div>
);

export default PlanCard;
