import React, { useCallback, useEffect, useState } from "react";
import ReviewDataService from "../services/review.service";
import AuthService from "../services/auth.service";
import { REVIEW_SECTIONS } from "../constants/plan-options";

// Migrated from shinshin's comments-list.component.js (inline textarea-submit + list-below
// pattern), extended with:
//  - a reviewer-role-aware section picker (WHY/WHAT/HOW/自由文本 + score) shown only to
//    expert/admin reviewers,
//  - a "请AI点评" trigger button shown only to the plan's owning teacher (canTriggerAi prop,
//    passed down from plan-detail.component.js's canEditPlan) that calls the AI-review endpoint
//    -- matches review.controller.js#createAiReview's owner-only check, no admin bypass,
//  - AI-authored rows visually tagged distinctly (.pl-tag-ai) from expert rows (.pl-tag-expert).
//  - threading: reviews are grouped by the exact plan.contentVersionAt snapshot they were
//    created against (review.planVersionAt, set server-side -- see review.controller.js and
//    plan.model.js's contentVersionAt comment). Two reviews land in the same group iff no
//    content edit happened between them, i.e. they're both replies "on the same spot". Only
//    the newest group (matching the plan's current planContentVersionAt prop) is "current";
//    older groups are read-only history once the plan moves on -- matches
//    review.controller.js#delete's server-side lock on superseded reviews.
// Review lists are scoped to a single plan (and, per-lesson, to a single lessonIndex), so
// unlike comments-list.component.js this renders plain client-sorted/grouped tables instead of
// a server-paginated react-table -- the plan's REST contract does not paginate this endpoint.
const groupByVersion = (sortedReviews) => {
  const groups = [];
  const byKey = new Map();
  for (const review of sortedReviews) {
    const key = review.planVersionAt || "unknown";
    let group = byKey.get(key);
    if (!group) {
      group = { key, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(review);
  }
  return groups;
};

const ReviewList = (props) => {
  const { planId, lessonIndex, embedded, planContentVersionAt, canTriggerAi } = props;
  const [reviews, setReviews] = useState([]);
  const [text, setText] = useState("");
  const [sectionKey, setSectionKey] = useState("WHY");
  const [score, setScore] = useState("");
  const [message, setMessage] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  const isExpertReviewer = AuthService.isExpert() || AuthService.isAdmin();
  const currentUser = AuthService.getCurrentUser();

  const retrieveReviews = useCallback(async () => {
    if (!planId) return;
    try {
      const resp = await ReviewDataService.getByPlan(planId, lessonIndex);
      const list = Array.isArray(resp.data) ? resp.data : resp.data.rows || resp.data.reviews || [];
      const sorted = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setReviews(sorted);
    } catch (e) {
      console.log(e);
      setMessage("加载点评列表失败。");
    }
  }, [planId, lessonIndex]);

  useEffect(() => {
    retrieveReviews();
  }, [retrieveReviews]);

  const save = async (e) => {
    e.preventDefault();
    if (!text.trim()) {
      setMessage("请填写点评内容。");
      return;
    }
    try {
      const data = {
        content: text,
        lessonIndex: lessonIndex !== undefined && lessonIndex !== null ? lessonIndex : undefined,
      };
      if (isExpertReviewer) {
        data.sectionKey = sectionKey;
        if (score !== "") data.score = Number(score);
      }
      await ReviewDataService.create(planId, data);
      setText("");
      setScore("");
      setMessage("");
      retrieveReviews();
    } catch (e) {
      setMessage(e?.response?.data?.message || "提交点评失败。");
    }
  };

  const triggerAiReview = async () => {
    setAiLoading(true);
    setMessage("");
    try {
      await ReviewDataService.createAi(planId, {
        lessonIndex: lessonIndex !== undefined && lessonIndex !== null ? lessonIndex : undefined,
      });
      setMessage("AI 点评已生成。");
      retrieveReviews();
    } catch (e) {
      setMessage(e?.response?.data?.message || "AI 点评生成失败。");
    } finally {
      setAiLoading(false);
    }
  };

  // Mirrors review.controller.js#delete's two server-side rules: must be the
  // review's own author (or admin) AND the review must still belong to the
  // plan's current content version -- once superseded by a later edit, it's
  // locked as history for everyone, admin included.
  const isCurrentVersion = (review) => review.planVersionAt === planContentVersionAt;
  const canDelete = (review) =>
    isCurrentVersion(review) &&
    (AuthService.isAdmin() || (review.reviewerId && currentUser && String(review.reviewerId) === String(currentUser.id)));

  const deleteReview = async (review) => {
    if (!canDelete(review)) return;
    if (!window.confirm("确定要删除该点评吗？")) return;
    try {
      await ReviewDataService.delete(review.id);
      retrieveReviews();
    } catch (e) {
      setMessage(e?.response?.data?.message || "删除失败。");
    }
  };

  return (
    <div className={embedded ? "" : "pl-card"}>
      <div className="d-flex justify-content-between align-items-center mb-2">
        <h6 className="mb-0">点评{lessonIndex ? `（课时${lessonIndex}）` : "（整体）"}</h6>
        {canTriggerAi && (
          <button type="button" className="btn btn-sm btn-outline-primary" onClick={triggerAiReview} disabled={aiLoading}>
            {aiLoading ? "AI点评生成中..." : "请AI点评"}
          </button>
        )}
      </div>

      {isExpertReviewer && (
        <form onSubmit={save} className="mb-3">
          <div className="form-row">
            <div className="form-group col-md-3">
              <label>点评模块</label>
              <select className="form-control form-control-sm" value={sectionKey} onChange={(e) => setSectionKey(e.target.value)}>
                {REVIEW_SECTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group col-md-2">
              <label>评分（可选）</label>
              <input
                className="form-control form-control-sm"
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={score}
                onChange={(e) => setScore(e.target.value)}
              />
            </div>
          </div>
          <textarea rows="3" className="form-control mb-2" value={text} onChange={(e) => setText(e.target.value)} placeholder="请填写点评内容..." />
          <button className="btn btn-primary btn-sm" type="submit">
            提交点评
          </button>
        </form>
      )}

      {!isExpertReviewer && !embedded && (
        <form onSubmit={save} className="mb-3">
          <textarea rows="3" className="form-control mb-2" value={text} onChange={(e) => setText(e.target.value)} placeholder="请填写留言..." />
          <button className="btn btn-primary btn-sm" type="submit">
            提交
          </button>
        </form>
      )}

      {message && <div className="alert alert-info py-2">{message}</div>}

      {reviews.length === 0 && <div className="pl-empty">暂无点评</div>}

      {groupByVersion(reviews).map((group, idx) => {
        const isCurrent = group.key === planContentVersionAt;
        return (
          <div key={group.key} className={idx > 0 ? "mt-3" : ""}>
            <div className="d-flex align-items-center mb-1">
              {isCurrent ? (
                <span className="pl-tag mr-2">当前版本</span>
              ) : (
                <span className="pl-tag pl-tag-warn mr-2">历史版本（课程内容已被后续修改）</span>
              )}
            </div>
            <table className="table table-sm table-bordered mb-0">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>模块</th>
                  <th>评分</th>
                  <th>内容</th>
                  <th>点评人</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((review) => (
                  <tr key={review.id}>
                    <td>
                      {review.reviewerType === "ai" ? (
                        <span className="pl-tag-ai">AI点评{review.aiModel ? `（${review.aiModel}）` : ""}</span>
                      ) : (
                        <span className="pl-tag-expert">专家点评</span>
                      )}
                    </td>
                    <td>{review.sectionKey || "-"}</td>
                    <td>{review.score !== null && review.score !== undefined ? review.score : "-"}</td>
                    <td style={{ whiteSpace: "pre-wrap" }}>{review.content}</td>
                    <td>{review.reviewerType === "ai" ? "AI智能体" : review.reviewer ? review.reviewer.chineseName || review.reviewer.username : "-"}</td>
                    <td>{review.createdAt ? new Date(review.createdAt).toLocaleString("zh-cn") : "-"}</td>
                    <td>
                      {canDelete(review) && (
                        <button className="btn btn-link p-0 text-danger" onClick={() => deleteReview(review)}>
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
};

export default ReviewList;
