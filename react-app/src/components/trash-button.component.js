import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PlanDataService from "../services/plan.service";
import { PLAN_TRASH_RETENTION_DAYS } from "../constants/plan-options";

// Fired after a plan is moved to the 回收站 from a list page, so the button
// below can refresh its count without the list having to know about it.
export const TRASH_CHANGED_EVENT = "plans:trash-changed";
export const announceTrashChanged = () => window.dispatchEvent(new Event(TRASH_CHANGED_EVENT));

// The 回收站 entry on 我的乡土课程 / 全部乡土课程: a muted hollow icon when
// empty, a solid icon plus a count badge once something is in it -- so a
// teacher who just deleted something can see at a glance where it went.
const TrashButton = ({ className = "" }) => {
  const [count, setCount] = useState(null);

  const refresh = useCallback(() => {
    PlanDataService.getTrash()
      .then((resp) => setCount((resp.data.rows || []).length))
      .catch(() => setCount(null));
  }, []);

  useEffect(() => {
    refresh();
    // 欣欣小助手 may delete a plan too (see copilot-panel.component.js).
    window.addEventListener(TRASH_CHANGED_EVENT, refresh);
    window.addEventListener("copilot:data-changed", refresh);
    return () => {
      window.removeEventListener(TRASH_CHANGED_EVENT, refresh);
      window.removeEventListener("copilot:data-changed", refresh);
    };
  }, [refresh]);

  const hasItems = count > 0;
  return (
    <Link
      to="/plans/trash"
      className={`btn ${hasItems ? "btn-outline-danger" : "btn-outline-secondary pl-trash-empty"} ${className}`}
      title={
        hasItems
          ? `回收站中有 ${count} 个课程设计，${PLAN_TRASH_RETENTION_DAYS} 天内可恢复`
          : "回收站为空"
      }
    >
      <i className={`${hasItems ? "fas" : "far"} fa-trash-alt mr-1`} />
      回收站
      {hasItems && <span className="badge badge-danger ml-1">{count}</span>}
    </Link>
  );
};

export default TrashButton;
