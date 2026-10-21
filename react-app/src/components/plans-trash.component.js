import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PlanDataService from "../services/plan.service";
import AuthService from "../services/auth.service";
import { PLAN_TRASH_RETENTION_DAYS } from "../constants/plan-options";
import "../curriculum.css";

const formatDateTime = (value) => new Date(value).toLocaleString("zh-cn", { hour12: false });
const daysLeft = (purgeAt) => Math.max(0, Math.ceil((new Date(purgeAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

// 回收站 (/plans/trash): plans deleted from 我的乡土课程 / 全部乡土课程 land
// here instead of being removed outright (backend plan.model.js is paranoid,
// services/planTrash.js sweeps them after TRASH_RETENTION_DAYS). A teacher
// sees their own, an admin everyone's -- the backend decides which.
const PlansTrash = () => {
  const isAdmin = AuthService.isAdmin();
  const [rows, setRows] = useState([]);
  const [retentionDays, setRetentionDays] = useState(PLAN_TRASH_RETENTION_DAYS);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");

  const retrieve = useCallback(async () => {
    try {
      const resp = await PlanDataService.getTrash();
      setRows(resp.data.rows || []);
      if (resp.data.retentionDays) setRetentionDays(resp.data.retentionDays);
    } catch (err) {
      setMessage(err?.response?.data?.message || "加载回收站失败。");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    retrieve();
  }, [retrieve]);

  const onRestore = async (item) => {
    try {
      const resp = await PlanDataService.restore(item.id);
      setMessage(resp.data?.message || "已恢复。");
      retrieve();
    } catch (err) {
      setMessage(err?.response?.data?.message || "恢复失败。");
    }
  };

  const onPurge = async (item) => {
    if (!window.confirm(`此操作将永久删除「${item.title}」及其所有附件与点评，且无法撤销。确定继续吗？`)) return;
    try {
      const resp = await PlanDataService.purge(item.id);
      setMessage(resp.data?.message || "已永久删除。");
      retrieve();
    } catch (err) {
      setMessage(err?.response?.data?.message || "永久删除失败。");
    }
  };

  if (!AuthService.isTeacher() && !isAdmin) {
    return <div className="container">仅教师和管理员可使用回收站。</div>;
  }

  return (
    <div className="container">
      <h4>回收站</h4>
      <p className="text-muted">
        已删除的课程设计会在这里保留 {retentionDays} 天，期间可随时恢复（附件与点评一并恢复）；超过 {retentionDays}{" "}
        天后将自动永久删除。
        <Link to={isAdmin ? "/plans" : "/plans?mine=true"} className="ml-2">
          返回{isAdmin ? "全部乡土课程" : "我的乡土课程"}
        </Link>
      </p>

      {message && <div className="alert alert-info py-2">{message}</div>}

      {loaded && rows.length === 0 ? (
        <div className="pl-empty">回收站为空</div>
      ) : (
        <table className="table table-sm table-bordered">
          <thead>
            <tr>
              <th>课程标题</th>
              {isAdmin && <th>教师</th>}
              <th>年份/学期</th>
              <th>删除时间</th>
              <th>剩余天数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.id}>
                <td>{item.title}</td>
                {isAdmin && <td>{item.Teacher ? item.Teacher.chineseName || item.Teacher.username : "-"}</td>}
                <td>
                  {item.year}
                  {item.season ? ` ${item.season}` : ""}
                </td>
                <td>{formatDateTime(item.deletedAt)}</td>
                <td>{daysLeft(item.purgeAt)} 天</td>
                <td>
                  <button className="btn btn-sm btn-outline-primary mr-2" type="button" onClick={() => onRestore(item)}>
                    恢复
                  </button>
                  <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => onPurge(item)}>
                    永久删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default PlansTrash;
