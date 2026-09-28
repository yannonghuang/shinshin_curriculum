import React, { useCallback, useEffect, useState } from "react";
import ReviewDataService from "../services/review.service";
import AuthService from "../services/auth.service";

// Migrated from shinshin's comments-list.component.js (inline textarea-submit + list-below
// pattern), extended with:
//  - a reviewer-role-aware score field shown only to expert/admin reviewers,
//  - a "请AI点评" trigger button (canTriggerAi prop, see plan-detail.component.js's
//    canTriggerAiReview) shown to the plan's owning teacher, and to admins/experts once the plan
//    is submitted -- matches review.controller.js#createAiReview's own check,
//  - AI-authored rows visually tagged distinctly (.pl-tag-ai) from expert rows (.pl-tag-expert).
//  - staleness, not threading: every review is shown newest-first in one flat table (no more
//    grouping/splitting by the plan.contentVersionAt snapshot each was created against) -- a row
//    instead carries its own "内容已更新" badge (isContentUpdated below) whenever the content it
//    was written against has since changed, exactly the same way for an AI row as for an expert
//    row. isCurrentVersion (review.planVersionAt === the plan's current contentVersionAt) still
//    gates deletion -- matches review.controller.js#delete's server-side lock on reviews for a
//    superseded version -- it just no longer drives a separate visual grouping.
// Review lists are scoped to a single plan (and, per-lesson, to a single lessonIndex), so
// unlike comments-list.component.js this renders a plain client-sorted table instead of
// a server-paginated react-table -- the plan's REST contract does not paginate this endpoint.
//
// Two distinct usages, driven by the sectionKey prop (lessonIndex further
// narrows either one to a single 课时):
//  - A segment mini-widget (sectionKey set: "WHY"/"WHAT"/"HOW" for 设计's top-level segments,
//    "LESSON_DESIGN" for 设计/分课时设计/课时N, "EXECUTION_RECORD" for 实施/课时N/实施记录 --
//    the latter two always paired with a lessonIndex prop to pick which lesson): embedded at the
//    end of that segment's own tab in plan-detail.component.js. No section picker -- the section
//    is simply whichever tab the widget lives in, and its list is pre-filtered to that section's
//    reviews (server-side by lessonIndex when given, client-side by sectionKey always). This
//    used to be a single "整体点评" list with a manual "点评模块" dropdown the reviewer had to
//    remember to set correctly; asking a reviewer to comment right where they're already reading
//    that section, rather than context-switch to a dropdown, is both more accurate and more
//    pleasant to use.
//  - An aggregate (sectionKey unset, i.e. 整体点评 itself -- 设计's own via aggregateScope="design"
//    (the default) or 实施's via aggregateScope="implementation"): shows every review in that
//    aggregate's scope together -- genuine whole-section comments (and AI reviews) written here
//    directly, tagged null for 设计 / "IMPLEMENTATION_OVERALL" for 实施, plus, read-only, every
//    segment review that falls under this aggregate's scope (tagged in a "模块" column) so a
//    reviewer sees the complete picture without clicking into each tab. 设计's aggregate covers
//    WHY/WHAT/HOW + LESSON_DESIGN; 实施's aggregate covers those PLUS EXECUTION_RECORD, since its
//    AI review is generated over combined design+execution content ("both sections" per the
//    comment-scoping spec). A segment-tagged row has no delete button here even for its own
//    author -- it's edited/deleted at its origin (the segment's own mini-widget), never from the
//    aggregate, so nothing you see on a section's own tab can vanish out from under it via an
//    edit made somewhere else.
// Content beyond this length starts collapsed (a truncated preview + a
// 展开/收起 toggle) -- an AI review in particular can run to several
// paragraphs, which used to blow up every row's height in a list that's
// meant to be scannable.
const CONTENT_PREVIEW_LENGTH = 150;

// 设计's own segment sectionKeys -- both aggregates show these; 实施's
// aggregate additionally shows EXECUTION_RECORD (see the file header
// comment). "WHY"/"WHAT"/"HOW" cover the hand-authored seed directly; a
// heading-style-parsed template's own anchors get auto-generated keys
// instead ("S0"/"S1"/... -- see plan-detail.component.js's anchorSections),
// so isDesignSegmentKey below also checks the current plan's own
// sectionLabels map (built from those same anchors) rather than relying on
// this fixed literal list alone.
const DESIGN_SEGMENT_KEYS = ["WHY", "WHAT", "HOW", "LESSON_DESIGN"];

// sectionKey is an internal, code-shaped constant -- fine to surface as-is
// for the hand-authored seed's own "WHY"/"WHAT"/"HOW" keys, but a heading-
// style-parsed template's anchor sections get auto-generated keys instead
// ("S0"/"S1"/"S2", from section.key.toUpperCase() -- see plan-detail.
// component.js's anchorSections), which are meaningless on their own. labels
// (a sectionKey -> real anchor-label map, e.g. {S0: "WHY ·学习目标"} --
// see plan-detail.component.js's planSectionLabels) resolves those to the
// same label already shown in that section's own sidebar tab; falls back to
// the raw key when no entry exists (a review tagged with a section the
// current schema no longer has, or a template whose real "WHY"/"WHAT"/"HOW"
// keys already read fine unresolved).
const sectionLabel = (key, lessonIdx, labels) => {
  if (key === "LESSON_DESIGN") return `分课时设计·课时${lessonIdx}`;
  if (key === "EXECUTION_RECORD") return `实施记录·课时${lessonIdx}`;
  if (key === "IMPLEMENTATION_OVERALL") return "实施整体";
  return (labels && labels[key]) || key;
};

// Mirrors backend/app/services/segmentVersion.js#segmentKeyForReview -- the
// key a review's sectionKey/lessonIndex resolves to in plan.segmentVersionAt.
// Must stay in sync with the backend convention, or the "edited since this
// review" comparison below silently never fires. Any plain sectionKey --
// "WHY"/"WHAT"/"HOW" for the hand-authored seed, or "S0"/"S1"/"S2"/... for a
// heading-style-parsed template's auto-keyed anchors (see plan-detail.
// component.js's anchorSections) -- maps to itself; the backend's
// diffPlanFormDataSegments is what actually populates segmentVersionAt under
// that same key for either shape. IMPLEMENTATION_OVERALL and plain 整体
// comments (sectionKey null) have no single segment, so they resolve to
// null and are never flagged here -- only the plan-wide 历史版本 grouping
// applies to those.
const segmentKeyForReview = (review) => {
  const { sectionKey, lessonIndex } = review;
  if (!sectionKey) return null;
  if ((sectionKey === "LESSON_DESIGN" || sectionKey === "EXECUTION_RECORD") && lessonIndex) {
    return `${sectionKey}:${lessonIndex}`;
  }
  if (sectionKey === "IMPLEMENTATION_OVERALL") return null;
  return sectionKey;
};

// Which of a plan's reviews a ReviewList shows -- a segment mini-widget
// only its own section's (the lessonIndex prop, when set, already narrowed
// the fetch server-side). An aggregate fetches every review for the plan (no
// lessonIndex sent -- see review.service.js) and keeps: its own directly-
// written comments/AI review (tagged with its write sectionKey, lessonIndex
// null), plus every segment review in its scope regardless of that
// segment's own lessonIndex -- 设计's aggregate scopes to
// DESIGN_SEGMENT_KEYS, 实施's additionally includes EXECUTION_RECORD and
// 计划's own AI review (sectionKey null, lessonIndex null, reviewerType "ai"
// -- 设计's aggregate's own AI-generated review) so a reviewer looking at
// 实施整体点评 also sees how the design itself was AI-reviewed. Exported so
// plan-detail.component.js's unseen-review flash covers exactly the reviews
// each 整体点评 view shows.
export const scopeReviews = (list, { sectionKey, aggregateScope, sectionLabels }) => {
  if (sectionKey) return list.filter((r) => r.sectionKey === sectionKey);
  const writeSectionKey = aggregateScope === "implementation" ? "IMPLEMENTATION_OVERALL" : null;
  return list.filter(
    (r) =>
      (r.sectionKey === writeSectionKey && (r.lessonIndex === null || r.lessonIndex === undefined)) ||
      // See DESIGN_SEGMENT_KEYS' comment -- recognizes a heading-parsed
      // template's own "S0"/"S1"/... anchor keys (via sectionLabels) in
      // addition to the fixed literal list, so a segment review on one of
      // those doesn't silently disappear from the aggregate view.
      DESIGN_SEGMENT_KEYS.includes(r.sectionKey) ||
      (sectionLabels && Object.prototype.hasOwnProperty.call(sectionLabels, r.sectionKey)) ||
      (aggregateScope === "implementation" &&
        (r.sectionKey === "EXECUTION_RECORD" ||
          (r.sectionKey == null && r.reviewerType === "ai" && (r.lessonIndex === null || r.lessonIndex === undefined))))
  );
};

const ReviewList = (props) => {
  const {
    planId,
    lessonIndex,
    sectionKey,
    sectionLabels,
    aggregateScope,
    embedded,
    planContentVersionAt,
    segmentVersionAt,
    canTriggerAi,
    canDiscussAi,
    onSelectSection,
    aiPending,
    setAiPending,
    trackSeen,
    onSeen,
  } = props;
  const [reviews, setReviews] = useState([]);
  const [text, setText] = useState("");
  const [score, setScore] = useState("");
  const [message, setMessage] = useState("");
  // aiPending/setAiPending are optional: when the caller lifts this into
  // state of its own (see plan-detail.component.js's two aggregate widgets),
  // the "AI点评生成中..." state survives navigating away and back -- a
  // request that outlives this component's own mount, unlike this local
  // fallback, which resets whenever the widget remounts.
  const [localAiLoading, setLocalAiLoading] = useState(false);
  const aiLoading = aiPending !== undefined ? aiPending : localAiLoading;
  const setAiLoading = setAiPending || setLocalAiLoading;
  const [expandedIds, setExpandedIds] = useState(new Set());
  // Reviews the plan's teacher hadn't seen before this view showed them --
  // tagged 新 for as long as this widget stays mounted, even though they're
  // marked seen server-side right away (see trackSeen below).
  const [newIds, setNewIds] = useState(new Set());

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

  // The aggregate 整体点评 usage: no fixed section -- see the aggregate-view
  // behavior described in the file header comment. aggregateScope only
  // matters here; segment mini-widgets always pass a sectionKey.
  const isAggregateView = !sectionKey;
  // The sectionKey an aggregate's own directly-written comments/AI review
  // get tagged with (see review.model.js's sectionKey comment) -- null for
  // 设计's aggregate (unchanged from before aggregateScope existed).
  const writeSectionKey = aggregateScope === "implementation" ? "IMPLEMENTATION_OVERALL" : null;

  const retrieveReviews = useCallback(async () => {
    if (!planId) return;
    try {
      const resp = await ReviewDataService.getByPlan(planId, lessonIndex);
      const list = Array.isArray(resp.data) ? resp.data : resp.data.rows || resp.data.reviews || [];
      // See scopeReviews above.
      const scoped = scopeReviews(list, { sectionKey, aggregateScope, sectionLabels });
      const sorted = [...scoped].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setReviews(sorted);
      // trackSeen: the viewer is the plan's own teacher, on a 整体点评 view --
      // showing a review here counts as the teacher having seen it (see
      // review.model.js's teacherSeenAt), which clears the sidebar flash in
      // plan-detail.component.js via onSeen.
      const unseenIds = trackSeen && !sectionKey ? sorted.filter((r) => !r.teacherSeenAt).map((r) => r.id) : [];
      if (unseenIds.length > 0) {
        setNewIds((prev) => new Set([...prev, ...unseenIds]));
        ReviewDataService.markSeen(planId, unseenIds)
          .then(() => onSeen && onSeen())
          .catch((e) => console.log(e));
      }
    } catch (e) {
      console.log(e);
      setMessage("加载点评列表失败。");
    }
  }, [planId, lessonIndex, sectionKey, aggregateScope, sectionLabels, trackSeen, onSeen]);

  // Also reruns whenever aiLoading flips (in either direction) -- when
  // aiPending is lifted to a parent that outlives this widget's own mount
  // (see the aiPending/setAiPending comment above), a remount can pick up an
  // AI review that finished while this widget was unmounted, and this makes
  // sure the newly-generated row actually appears once aiLoading goes back
  // to false instead of waiting for some unrelated re-render.
  useEffect(() => {
    retrieveReviews();
  }, [retrieveReviews, aiLoading]);

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
        // sectionKey is a fixed prop, never reviewer-chosen. A segment mini-widget
        // tags with its own sectionKey; an aggregate tags with writeSectionKey
        // (null for 设计, "IMPLEMENTATION_OVERALL" for 实施) so its own comments
        // stay distinguishable from the segment reviews it also displays.
        if (sectionKey) data.sectionKey = sectionKey;
        else if (writeSectionKey) data.sectionKey = writeSectionKey;
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
        scope: aggregateScope === "implementation" ? "implementation" : undefined,
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
  // Segment-level counterpart to the plan-wide 历史版本 grouping below: flags
  // a specific row when its own segment (not just some unrelated part of the
  // plan) was edited after this review was written -- see plan.model.js's
  // segmentVersionAt comment. Only resolvable for a review with a real
  // sectionKey+lessonIndex; a plain 整体/IMPLEMENTATION_OVERALL review has no
  // single segment and keeps relying on the group-level tag only.
  const isSegmentStale = (review) => {
    const key = segmentKeyForReview(review);
    if (!key || !segmentVersionAt) return false;
    const current = segmentVersionAt[key];
    if (!current) return false;
    // A review with no stored snapshot predates this tracking feature
    // entirely (segmentVersionAt didn't exist yet when it was created) --
    // any recorded edit for its segment necessarily happened after it, so
    // it's unconditionally stale rather than "unknown".
    if (!review.segmentVersionAt) return true;
    return new Date(current).getTime() !== new Date(review.segmentVersionAt).getTime();
  };
  // The one "内容已更新" signal shown per row, regardless of reviewer type:
  // a review with a real single segment (WHY/WHAT/HOW/a lesson's design or
  // execution record) uses isSegmentStale so unrelated edits elsewhere don't
  // flag it; a review with no single segment -- a plain 整体/
  // IMPLEMENTATION_OVERALL comment, or an AI review generated over the whole
  // scope -- falls back to the plan-wide version check instead, since there's
  // no narrower "its own part" to compare against. Applies equally to
  // AI/expert/admin rows -- previously only segment-tagged rows got this
  // per-row badge; a plan-wide-scoped row (most AI reviews) relied solely on
  // the now-removed per-version table grouping to convey the same thing.
  const isContentUpdated = (review) => {
    const key = segmentKeyForReview(review);
    return key ? isSegmentStale(review) : !isCurrentVersion(review);
  };
  // Groups reviews for the "only the latest carries the badge" rule below:
  // same reviewer type (AI/专家/管理员) writing about the same scope
  // (sectionKey+lessonIndex, i.e. the same thing segmentKeyForReview/moduleCell
  // already treat as "one spot"). Once a newer review exists for that exact
  // (type, scope) pair, an older one showing 内容已更新 too is redundant noise
  // -- the newer row already speaks for "this has changed since we last
  // weighed in here", the reader doesn't need every prior row to repeat it.
  const reviewGroupKey = (review) => `${review.reviewerType}|${review.sectionKey || ""}|${review.lessonIndex ?? ""}`;
  // reviews is already sorted newest-first (see retrieveReviews), so the
  // first row encountered per group here is that group's latest.
  const latestIdByGroup = new Map();
  for (const r of reviews) {
    const key = reviewGroupKey(r);
    if (!latestIdByGroup.has(key)) latestIdByGroup.set(key, r.id);
  }
  const showUpdatedBadge = (review) => isContentUpdated(review) && latestIdByGroup.get(reviewGroupKey(review)) === review.id;
  // A review is "this aggregate's own" iff it's tagged with this aggregate's
  // writeSectionKey and has no lessonIndex -- everything else shown in an
  // aggregate (a segment review, or, in 实施's aggregate, 设计's own AI
  // review) was written/generated elsewhere and is read-only here, never
  // editable/deletable from this aggregate (see the file header comment).
  const isOwnAggregateRow = (review) =>
    review.sectionKey === writeSectionKey && (review.lessonIndex === null || review.lessonIndex === undefined);
  const isSectionOrigin = (review) => isAggregateView && !isOwnAggregateRow(review);

  // What the 模块 column shows for a row, and whether/where clicking it
  // should navigate. A tagged segment row uses its own sectionKey as the
  // navigation target; an untagged (sectionKey null) row is normally this
  // aggregate's own genuine comment ("整体", not clickable) -- except inside
  // 实施's aggregate, where writeSectionKey is "IMPLEMENTATION_OVERALL", so a
  // null-sectionKey row there is never this aggregate's own -- it's always
  // 设计's own AI review, borrowed for visibility (see the file header
  // comment), so it's labeled distinctly and links back to 设计's aggregate.
  const moduleCell = (review) => {
    if (review.sectionKey) {
      return { label: sectionLabel(review.sectionKey, review.lessonIndex, sectionLabels), navKey: review.sectionKey, clickable: !isOwnAggregateRow(review) };
    }
    if (aggregateScope === "implementation") {
      return { label: "设计整体", navKey: "DESIGN_OVERALL", clickable: true };
    }
    return { label: "整体", clickable: false };
  };

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

  const headerLabel = sectionKey
    ? `点评（${sectionLabel(sectionKey, lessonIndex, sectionLabels)}）`
    : aggregateScope === "implementation"
    ? "点评（实施整体）"
    : "点评（整体）";

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
            placeholder={sectionKey ? `请针对 ${sectionLabel(sectionKey, lessonIndex, sectionLabels)} 部分填写点评...` : "请填写点评内容..."}
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

      {/* aiLoading takes priority over message: it's the one that must
          survive a remount (see the aiPending/setAiPending comment above),
          so it can't be baked into the local, mount-scoped message state. */}
      {(aiLoading || message) && <div className="alert alert-info py-2">{aiLoading ? "AI点评生成中…" : message}</div>}

      {reviews.length === 0 && <div className="pl-empty">暂无点评</div>}

      {reviews.length > 0 && (
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
            {reviews.map((review) => {
              const isLong = review.content && review.content.length > CONTENT_PREVIEW_LENGTH;
              const isExpanded = expandedIds.has(review.id);
              const updatedBadge = showUpdatedBadge(review) && (
                <span className="pl-tag pl-tag-warn ml-1" title="课程内容已在此点评后被修改">
                  内容已更新
                </span>
              );
              return (
                <tr key={review.id}>
                  <td>
                    {review.reviewerType === "ai" ? (
                      <span className="pl-tag-ai" title={[review.aiModel && `模型：${review.aiModel}`, review.standardId && `依据 AI 点评标准 #${review.standardId}`].filter(Boolean).join(" · ") || undefined}>
                        AI点评
                      </span>
                    ) : review.reviewerType === "admin" ? (
                      <span className="pl-tag-admin">管理员点评</span>
                    ) : (
                      <span className="pl-tag-expert">专家点评</span>
                    )}
                    {newIds.has(review.id) && <span className="pl-tag pl-tag-new ml-1">新</span>}
                    {!isAggregateView && updatedBadge}
                  </td>
                  {isAggregateView &&
                    (() => {
                      const { label, navKey, clickable } = moduleCell(review);
                      return (
                        <td>
                          {clickable && onSelectSection ? (
                            <button type="button" className="btn btn-link p-0" onClick={() => onSelectSection(navKey, review.lessonIndex)}>
                              {label}
                            </button>
                          ) : (
                            label
                          )}
                          {updatedBadge}
                        </td>
                      );
                    })()}
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
                    {/* Continuing an AI review's discussion with 欣欣助手 is
                        reserved to the plan's owning teacher (canDiscussAi
                        mirrors canEditPlan -- unlike canTriggerAi, which
                        admins/experts also get on submitted plans) --
                        not shown to an expert/admin/other-teacher viewer
                        reading the same review, matching chat.controller.js's
                        own ownership check on the review-scoped conversation
                        this button opens. */}
                    {review.reviewerType === "ai" && canDiscussAi && (
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
      )}
    </div>
  );
};

export default ReviewList;
