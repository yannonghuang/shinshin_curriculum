import React, { useCallback, useEffect, useState } from "react";
import ReviewDataService from "../services/review.service";
import AuthService from "../services/auth.service";

// Migrated from shinshin's comments-list.component.js (inline textarea-submit + list-below
// pattern), extended with:
//  - a reviewer-role-aware score field shown only to expert/admin reviewers,
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
//
// Three distinct usages, driven by the sectionKey/lessonIndex props:
//  - A segment mini-widget (sectionKey="WHY"/"WHAT"/"HOW", lessonIndex unset): embedded at the
//    end of that segment's own tab in plan-detail.component.js. No section picker -- the section
//    is simply whichever tab the widget lives in, and its list is pre-filtered to that section's
//    reviews. This used to be a single "整体点评" list with a manual "点评模块" dropdown the
//    reviewer had to remember to set correctly; asking a reviewer to comment right where they're
//    already reading that section, rather than context-switch to a dropdown, is both more
//    accurate and more pleasant to use.
//  - A lesson widget (lessonIndex set, no sectionKey): unchanged from before, just the section
//    picker removed -- lessonIndex is already the review's whole scope, a WHY/WHAT/HOW section
//    within a single 课时 never applied.
//  - The whole-plan aggregate (neither prop set, i.e. 整体点评 itself): shows every plan-level
//    review together -- both genuine whole-plan comments written here directly, and, read-only,
//    every WHY/WHAT/HOW segment review (tagged in a "模块" column) so a reviewer looking at 整体
//    点评 sees the complete picture without having to click into each tab. A segment-tagged row
//    has no delete button here even for its own author -- it's edited/deleted at its origin (the
//    segment's own mini-widget), never from the aggregate, so nothing you see on a section's own
//    tab can vanish out from under it via an edit made somewhere else.
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

// Content beyond this length starts collapsed (a truncated preview + a
// 展开/收起 toggle) -- an AI review in particular can run to several
// paragraphs, which used to blow up every row's height in a list that's
// meant to be scannable.
const CONTENT_PREVIEW_LENGTH = 150;

const ReviewList = (props) => {
  const { planId, lessonIndex, sectionKey, embedded, planContentVersionAt, canTriggerAi, onSelectSection } = props;
  const [reviews, setReviews] = useState([]);
  const [text, setText] = useState("");
  const [score, setScore] = useState("");
  const [message, setMessage] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [expandedIds, setExpandedIds] = useState(new Set());

  const toggleExpanded = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isExpertReviewer = AuthService.isExpert() || AuthService.isAdmin();
  const currentUser = AuthService.getCurrentUser();

  // The whole-plan 整体点评 usage: no fixed section, no lesson -- see the
  // aggregate-view behavior described in the file header comment.
  const isAggregateView = !sectionKey && (lessonIndex === undefined || lessonIndex === null);

  const retrieveReviews = useCallback(async () => {
    if (!planId) return;
    try {
      const resp = await ReviewDataService.getByPlan(planId, lessonIndex);
      const list = Array.isArray(resp.data) ? resp.data : resp.data.rows || resp.data.reviews || [];
      // A segment mini-widget only ever shows its own section's reviews.
      // The aggregate view passes no lessonIndex to getByPlan (null doesn't
      // become a query param -- see review.service.js), so the fetch itself
      // returns every review for the plan, lesson-scoped ones included;
      // filter those back out here so 整体点评 only ever shows genuine
      // whole-plan comments plus section reviews, tagged, matching the file
      // header comment -- a 课时's own reviews stay on that 课时's own tab.
      const scoped = sectionKey
        ? list.filter((r) => r.sectionKey === sectionKey)
        : isAggregateView
        ? list.filter((r) => r.lessonIndex === null || r.lessonIndex === undefined)
        : list;
      const sorted = [...scoped].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setReviews(sorted);
    } catch (e) {
      console.log(e);
      setMessage("加载点评列表失败。");
    }
  }, [planId, lessonIndex, sectionKey, isAggregateView]);

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
        // sectionKey is a fixed prop, never reviewer-chosen -- omitted entirely
        // for a lesson widget or a genuine whole-plan comment written directly
        // in 整体点评.
        if (sectionKey) data.sectionKey = sectionKey;
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
      const resp = await ReviewDataService.createAi(planId, {
        lessonIndex: lessonIndex !== undefined && lessonIndex !== null ? lessonIndex : undefined,
      });
      const model = resp && resp.data && resp.data.aiModel;
      setMessage(`AI 点评已生成${model ? `（${model}）` : ""}。`);
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
  // A review with a sectionKey only ever got it from that section's own
  // mini-widget -- shown here in the aggregate 整体点评 view for visibility,
  // but not editable/deletable from here at all (see the file header comment).
  const isSectionOrigin = (review) => isAggregateView && !!review.sectionKey;
  const canDelete = (review) =>
    !isSectionOrigin(review) &&
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

  const headerLabel = sectionKey ? `点评（${sectionKey}）` : lessonIndex ? `点评（课时${lessonIndex}）` : "点评（整体）";

  return (
    <div className={embedded ? "" : "pl-card"}>
      <div className="d-flex justify-content-between align-items-center mb-2">
        <h6 className="mb-0">{headerLabel}</h6>
        {canTriggerAi && (
          <button type="button" className="btn btn-sm btn-outline-primary" onClick={triggerAiReview} disabled={aiLoading}>
            {aiLoading ? "AI点评生成中..." : "请AI点评"}
          </button>
        )}
      </div>

      {isExpertReviewer && (
        <form onSubmit={save} className="mb-3">
          <div className="form-row">
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
          <textarea
            rows="3"
            className="form-control mb-2"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={sectionKey ? `请针对 ${sectionKey} 部分填写点评...` : "请填写点评内容..."}
          />
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
                  {isAggregateView && <th>模块</th>}
                  <th>评分</th>
                  <th>内容</th>
                  <th>点评人</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((review) => {
                  const isLong = review.content && review.content.length > CONTENT_PREVIEW_LENGTH;
                  const isExpanded = expandedIds.has(review.id);
                  return (
                  <tr key={review.id}>
                    <td>
                      {review.reviewerType === "ai" ? (
                        <span className="pl-tag-ai" title={review.aiModel ? `模型：${review.aiModel}` : undefined}>
                          AI点评
                        </span>
                      ) : review.reviewerType === "admin" ? (
                        <span className="pl-tag-admin">管理员点评</span>
                      ) : (
                        <span className="pl-tag-expert">专家点评</span>
                      )}
                    </td>
                    {isAggregateView && (
                      <td>
                        {review.sectionKey && onSelectSection ? (
                          <button type="button" className="btn btn-link p-0" onClick={() => onSelectSection(review.sectionKey)}>
                            {review.sectionKey}
                          </button>
                        ) : (
                          review.sectionKey || "整体"
                        )}
                      </td>
                    )}
                    <td>{review.score !== null && review.score !== undefined ? review.score : "-"}</td>
                    <td style={{ whiteSpace: "pre-wrap" }}>
                      {isLong && !isExpanded ? `${review.content.slice(0, CONTENT_PREVIEW_LENGTH)}...` : review.content}
                      {isLong && (
                        <button type="button" className="btn btn-link btn-sm p-0 ml-1" onClick={() => toggleExpanded(review.id)}>
                          {isExpanded ? "收起" : "展开"}
                        </button>
                      )}
                    </td>
                    <td>{review.reviewerType === "ai" ? "AI智能体" : review.Reviewer ? review.Reviewer.chineseName || review.Reviewer.username : "-"}</td>
                    <td>{review.createdAt ? new Date(review.createdAt).toLocaleString("zh-cn") : "-"}</td>
                    <td>
                      {review.reviewerType === "ai" && (
                        <button
                          type="button"
                          className="btn btn-link p-0 mr-2"
                          title="打开欣欣助手，就这条点评继续提问"
                          onClick={() =>
                            window.dispatchEvent(new CustomEvent("copilot:open", { detail: { reviewId: review.id } }))
                          }
                        >
                          讨论
                        </button>
                      )}
                      {canDelete(review) ? (
                        <button className="btn btn-link p-0 text-danger" onClick={() => deleteReview(review)}>
                          删除
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
};

export default ReviewList;
