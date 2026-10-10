import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReviewDataService from "../services/review.service";
import AuthService from "../services/auth.service";
import { takeLocalDraft, isDraftStale } from "../utils/sessionExpiryGuard";
import { getPendingReviewEdit, setPendingReviewEdit, clearPendingReviewEdit, reviewPayload } from "../utils/pendingReviewEdits";
import { aiDesignScoreText } from "../utils/aiDesignScore";

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
//    directly, tagged null for 设计 / "IMPLEMENTATION_OVERALL" for 实施, plus every segment review
//    that falls under this aggregate's scope (tagged in a "模块" column) so a reviewer sees the
//    complete picture without clicking into each tab. 设计's aggregate covers WHY/WHAT/HOW +
//    LESSON_DESIGN; 实施's aggregate covers EXECUTION_RECORD only -- each segment review appears
//    in exactly one of the two (see scopeReviews). A submitted segment row is read-only here,
//    edited/deleted only at its origin (the segment's own mini-widget); the requester's own
//    saved segment draft is the exception -- editable and deletable here too (OtherSpotDraftRow),
//    as the same server draft and the same unsaved-edit entry as at its origin.
//
// Saved reviews (review.model.js's status), borrowed from a teacher's 保存草稿/提交待点评 on a
// plan: an expert/admin can 保存点评 instead of 提交点评, keeping a draft only they can see --
// one per spot (this widget's own write sectionKey + lessonIndex), listed with a 已保存·未提交 tag
// until submitted -- and listed already open for editing (EditableDraftRow): once a spot has a
// draft, its form lives in that draft's row instead of above the table. Unsaved form edits
// live in utils/pendingReviewEdits.js, so they survive switching sidebar sections, and are
// guarded like a plan's: PlanDetail's leave prompts, and a session-timeout auto-save to that
// draft, with a local stash restored on the next visit when even that couldn't reach the server.
// Content beyond this length starts collapsed (a truncated preview + a
// 展开/收起 toggle) -- an AI review in particular can run to several
// paragraphs, which used to blow up every row's height in a list that's
// meant to be scannable.
const CONTENT_PREVIEW_LENGTH = 150;
// An AI review's full-width body (see the reviewerType === "ai" rows below)
// starts collapsed to its first few lines when longer than this -- the CSS
// (.pl-review-ai-content.is-collapsed) does the actual clipping.
const isLongAiContent = (content) => !!content && (content.length > 240 || content.split("\n").length > 6);

// An AI 点评 row's AI 设计分数 view (opened from its 评分 column, see the AI row below): the AI 设计分数 scored
// alongside that review, itemized per dimension -- score/满分, level, the
// AI's own rationale -- next to the standard's 考察要点 it was scored
// against (shape: review.controller.js#attachAiScores).
const AiScorePanel = ({ score: s }) => {
  const scored = new Map((s.dimensionScores || []).map((d) => [d.name, d]));
  const dims = (s.criteria || []).length > 0 ? s.criteria : s.dimensionScores || [];
  return (
    <div>
      <div className="mb-2">
        <b>AI 设计分数：{aiDesignScoreText(s)}</b>
        <span className="text-muted small ml-2">
          评分标准：{s.standardTitle || "AI 点评标准"}（#{s.standardId}）
          {s.scoredAt && ` · 打分于 ${new Date(s.scoredAt).toLocaleString()}`}
        </span>
      </div>
      <table className="table table-sm table-bordered mb-2 pl-ai-score-table">
        <thead>
          <tr>
            <th style={{ width: "16%" }}>维度</th>
            <th style={{ width: "11%" }}>得分</th>
            <th style={{ width: "38%" }}>评分理由</th>
            <th>考察要点</th>
          </tr>
        </thead>
        <tbody>
          {dims.map((dim) => {
            const got = scored.get(dim.name);
            return (
              <tr key={dim.name}>
                <td>{dim.name}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {got ? `${got.score} / ${dim.weight}` : `- / ${dim.weight}`}
                  {got && got.level && <div className="text-muted small">{got.level}</div>}
                </td>
                <td>{(got && got.rationale) || "-"}</td>
                <td>
                  {(dim.criteria || []).length > 0 ? (
                    <ul className="mb-0 pl-3">
                      {dim.criteria.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {s.summary && <div>总评：{s.summary}</div>}
    </div>
  );
};

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
// lessonIndex sent -- see review.service.js) and keeps its own scope only:
// its directly-written comments/AI review (tagged with its write
// sectionKey, lessonIndex null) plus the segment reviews of its own section
// -- 计划整体点评 the design segments (DESIGN_SEGMENT_KEYS), 实施整体点评 the
// 实施记录 ones (EXECUTION_RECORD). A review appears in exactly one of the
// two, never repeated in the other. AI reviews are plan scope only (backend
// aiPlanEvaluation.js), so they live in 计划整体点评. Exported so
// plan-detail.component.js's unseen-review flash covers exactly the reviews
// each 整体点评 view shows.
export const scopeReviews = (list, { sectionKey, aggregateScope, sectionLabels }) => {
  if (sectionKey) return list.filter((r) => r.sectionKey === sectionKey);
  const isImplementation = aggregateScope === "implementation";
  const writeSectionKey = isImplementation ? "IMPLEMENTATION_OVERALL" : null;
  // See DESIGN_SEGMENT_KEYS' comment -- recognizes a heading-parsed
  // template's own "S0"/"S1"/... anchor keys (via sectionLabels) in addition
  // to the fixed literal list, so a segment review on one of those doesn't
  // silently disappear from the aggregate view.
  const isDesignSegment = (r) =>
    DESIGN_SEGMENT_KEYS.includes(r.sectionKey) ||
    (!!sectionLabels && Object.prototype.hasOwnProperty.call(sectionLabels, r.sectionKey));
  return list.filter(
    (r) =>
      (r.sectionKey === writeSectionKey && (r.lessonIndex === null || r.lessonIndex === undefined)) ||
      (isImplementation ? r.sectionKey === "EXECUTION_RECORD" : isDesignSegment(r))
  );
};

// The spot a form writes to (review.controller.js#create keys a saved
// draft on it) -- also its key in utils/pendingReviewEdits.js and the
// localStorage stash, hence the user id.
const writeSectionKeyFor = (sectionKey, aggregateScope) =>
  sectionKey || (aggregateScope === "implementation" ? "IMPLEMENTATION_OVERALL" : null);
const lessonIndexFor = (lessonIndex) =>
  lessonIndex !== undefined && lessonIndex !== null && lessonIndex !== "" ? Number(lessonIndex) : null;
const draftKey = (planId, writeKey, lessonIdx, userId) => `reviewDraft:${planId}:${writeKey || "OVERALL"}:${lessonIdx ?? ""}:${userId}`;
const spotKey = ({ planId, sectionKey, aggregateScope, lessonIndex }, userId) =>
  draftKey(planId, writeSectionKeyFor(sectionKey, aggregateScope), lessonIndexFor(lessonIndex), userId);
// A saved draft's spot key -- the same one that spot's own form uses.
const draftKeyOf = (review, userId) => draftKey(review.planId, review.sectionKey || null, lessonIndexFor(review.lessonIndex), userId);
const draftValues = (draft) => ({
  text: draft.content || "",
  score: draft.score === null || draft.score === undefined ? "" : String(Number(draft.score)),
});

// Grows with its content (between minRows and a cap, scrolling beyond
// it), so a long review is readable in full while it's being edited.
const MAX_EDITOR_HEIGHT_PX = 480;
const AutoGrowTextarea = ({ value, minRows = 6, ...rest }) => {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, MAX_EDITOR_HEIGHT_PX)}px`;
  }, [value]);
  return <textarea ref={ref} rows={minRows} value={value} {...rest} />;
};

// The requester's own 已保存·未提交 draft, shown as an editor right in its
// table row -- a saved draft is still being written, so it opens editable
// rather than as a read-only row the expert has to find a way back into.
// Two rows: the first keeps every value under its own column header
// (tags under 类型, score input under 评分, buttons under 操作, ...); the
// second gives the content editor the table's full width (colSpan) instead
// of squeezing it into the 内容 column. Holds no state of its own:
// text/score come from whoever owns them (ReviewList's own form for its
// spot, OtherSpotDraftRow below for a draft from another spot).
const EditableDraftRow = ({ meta, colSpan, showModule, showScore, text, score, setText, setScore, isDirty, onSave, onSubmit, onDelete }) => (
  <>
    <tr className="pl-review-draft-row pl-review-draft-meta">
      <td style={{ whiteSpace: "nowrap" }}>{meta.tags}</td>
      {showModule && <td>{meta.module}</td>}
      {showScore && (
        <td>
          <input
            className="form-control form-control-sm"
            style={{ width: 80 }}
            type="number"
            min="0"
            max="100"
            step="0.5"
            placeholder="可选"
            value={score}
            onChange={(e) => setScore(e.target.value)}
          />
        </td>
      )}
      {/* The 已保存·未提交 tag under 类型 already says the rest. */}
      <td className="text-muted small" style={{ whiteSpace: "nowrap" }}>
        {isDirty ? "有未保存的修改" : "已保存"}
      </td>
      <td style={{ whiteSpace: "nowrap" }}>{meta.reviewer}</td>
      <td>{meta.time}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        <button className="btn btn-outline-primary btn-sm mr-1" type="button" onClick={onSave} disabled={!isDirty}>
          保存
        </button>
        <button className="btn btn-primary btn-sm mr-1" type="button" onClick={onSubmit}>
          提交
        </button>
        <button className="btn btn-link btn-sm p-0 text-danger" type="button" onClick={onDelete}>
          删除
        </button>
      </td>
    </tr>
    <tr className="pl-review-draft-row pl-review-draft-editor">
      <td colSpan={colSpan}>
        <AutoGrowTextarea className="form-control" value={text} onChange={(e) => setText(e.target.value)} />
      </td>
    </tr>
  </>
);

// The requester's own saved draft for a *different* spot than this widget's
// form -- in an 整体点评 view, a segment's draft listed beside the
// aggregate's own reviews. Edited in place with the same unsaved-edit
// tracking (utils/pendingReviewEdits.js, under that segment's own key) as
// the segment's form, so leave prompts and the session-timeout auto-save
// cover it too, and the segment's form picks the edits up if opened next.
const OtherSpotDraftRow = ({ review, userId, onPersisted, onMessage, ...rowProps }) => {
  const key = draftKeyOf(review, userId);
  const sectionKey = review.sectionKey || null;
  const lessonIdx = lessonIndexFor(review.lessonIndex);
  const baseline = draftValues(review);
  const [initial] = useState(() => getPendingReviewEdit(key) || baseline);
  const [text, setText] = useState(initial.text);
  const [score, setScore] = useState(initial.score);
  const isDirty = text !== baseline.text || score !== baseline.score;

  useEffect(() => {
    if (isDirty) {
      setPendingReviewEdit(key, { planId: review.planId, sectionKey, lessonIndex: lessonIdx, text, score });
    } else {
      clearPendingReviewEdit(key);
    }
  }, [key, review.planId, sectionKey, lessonIdx, isDirty, text, score]);

  const persist = async (status) => {
    if (!text.trim()) {
      onMessage("请填写点评内容。");
      return;
    }
    try {
      await ReviewDataService.create(review.planId, reviewPayload({ sectionKey, lessonIndex: lessonIdx, text, score }, status));
      clearPendingReviewEdit(key);
      onMessage(status === "saved" ? "点评已保存（尚未提交，仅自己可见）。" : "");
      onPersisted();
    } catch (e) {
      onMessage(e?.response?.data?.message || (status === "saved" ? "保存点评失败。" : "提交点评失败。"));
    }
  };

  return (
    <EditableDraftRow
      {...rowProps}
      text={text}
      score={score}
      setText={setText}
      setScore={setScore}
      isDirty={isDirty}
      onSave={() => persist("saved")}
      onSubmit={() => persist("submitted")}
    />
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
  // Starts from this spot's unsaved edits, if any -- e.g. typed before
  // switching to another sidebar section and back.
  const [initialEdit] = useState(() => {
    const user = AuthService.getCurrentUser();
    return (user && getPendingReviewEdit(spotKey(props, user.id))) || { text: "", score: "" };
  });
  const [text, setText] = useState(initialEdit.text);
  const [score, setScore] = useState(initialEdit.score);
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
  // AI 点评 rows whose full-width body currently shows their AI 设计分数
  // (opened from the 评分 column) rather than the review text.
  const [scoreViewIds, setScoreViewIds] = useState(new Set());
  const showScoreView = (id, on) =>
    setScoreViewIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // Reviews the plan's teacher hadn't seen before this view showed them --
  // tagged 新 for as long as this widget stays mounted, even though they're
  // marked seen server-side right away (see trackSeen below).
  const [newIds, setNewIds] = useState(new Set());
  // The form's saved state: what's stored server-side for it -- the
  // requester's own draft for this spot, or empty when there's none. The
  // form is dirty whenever it differs from this.
  const [baseline, setBaseline] = useState({ text: "", score: "" });
  const [hasDraft, setHasDraft] = useState(false);

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
  // A teacher (any viewer who can't write reviews) doesn't see the 评分
  // column in the two 整体点评 views -- the written feedback is what's
  // meant for them there. Segment widgets keep it.
  // The plan's owner also gets the column in 计划整体点评 once an AI 点评
  // there carries an AI 设计分数 (attachAiScores only sends one to the
  // owner, experts and admins) -- AI scores only: other rows' scores stay
  // "-" for them (scoreColumnAiOnly), as above.
  const scoreColumnAiOnly = !(isExpertReviewer || !isAggregateView);
  const showScore = !scoreColumnAiOnly || reviews.some((r) => r.aiScore);
  // The sectionKey an aggregate's own directly-written comments/AI review
  // get tagged with (see review.model.js's sectionKey comment) -- null for
  // 设计's aggregate (unchanged from before aggregateScope existed).
  const writeSectionKey = aggregateScope === "implementation" ? "IMPLEMENTATION_OVERALL" : null;
  const ownSectionKey = writeSectionKeyFor(sectionKey, aggregateScope);
  const ownLessonIndex = lessonIndexFor(lessonIndex);
  const userId = currentUser && currentUser.id;
  const isOwnDraft = useCallback(
    (r) =>
      r.status === "saved" &&
      !!userId &&
      String(r.reviewerId) === String(userId) &&
      (r.sectionKey || null) === (ownSectionKey || null) &&
      (r.lessonIndex === null || r.lessonIndex === undefined ? null : Number(r.lessonIndex)) === ownLessonIndex,
    [userId, ownSectionKey, ownLessonIndex]
  );
  const localDraftKey = spotKey(props, userId);
  const isDirty = text !== baseline.text || score !== baseline.score;

  // Latest form state for retrieveReviews, which mustn't be re-created per
  // keystroke.
  const formRef = useRef({});
  formRef.current = { text, score, isDirty };
  const restoredRef = useRef(false);

  const retrieveReviews = useCallback(async () => {
    if (!planId) return;
    try {
      const resp = await ReviewDataService.getByPlan(planId, lessonIndex);
      const list = Array.isArray(resp.data) ? resp.data : resp.data.rows || resp.data.reviews || [];
      // See scopeReviews above.
      const scoped = scopeReviews(list, { sectionKey, aggregateScope, sectionLabels });
      // Newest first, except the requester's own saved drafts, which lead --
      // they're still being written (see EditableDraftRow).
      const isMineSaved = (r) => r.status === "saved" && !!userId && String(r.reviewerId) === String(userId);
      const sorted = [...scoped].sort((a, b) => isMineSaved(b) - isMineSaved(a) || new Date(b.createdAt) - new Date(a.createdAt));
      setReviews(sorted);
      if (isExpertReviewer) {
        const draft = sorted.find(isOwnDraft);
        // Read before any setState below: outside a React event handler
        // (React < 18) each one re-renders synchronously, and the first
        // (setBaseline) would already make the untouched form look dirty.
        const wasDirty = formRef.current.isDirty;
        const saved = draft ? draftValues(draft) : { text: "", score: "" };
        setBaseline(saved);
        setHasDraft(!!draft);
        // Never overwrite edits in progress; otherwise show what's saved.
        if (!wasDirty) {
          setText(saved.text);
          setScore(saved.score);
        }
        // Form content a session timeout couldn't get to the server (see the
        // session-expiry handler below) -- restored once, as unsaved, unless
        // the server draft changed after it was stashed.
        if (!restoredRef.current) {
          restoredRef.current = true;
          const stash = takeLocalDraft(localDraftKey);
          if (stash && !(draft && isDraftStale(stash, draft.updatedAt))) {
            setText(stash.text || "");
            setScore(stash.score || "");
            setMessage("已恢复登录超时前未保存的点评，请检查后保存或提交。");
          }
        }
      }
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
  }, [planId, lessonIndex, sectionKey, aggregateScope, sectionLabels, trackSeen, onSeen, isExpertReviewer, isOwnDraft, localDraftKey, userId]);

  // Also reruns whenever aiLoading flips (in either direction) -- when
  // aiPending is lifted to a parent that outlives this widget's own mount
  // (see the aiPending/setAiPending comment above), a remount can pick up an
  // AI review that finished while this widget was unmounted, and this makes
  // sure the newly-generated row actually appears once aiLoading goes back
  // to false instead of waiting for some unrelated re-render.
  useEffect(() => {
    retrieveReviews();
  }, [retrieveReviews, aiLoading]);

  // status "saved" (保存点评) keeps the form as the requester's draft;
  // "submitted" (提交点评) publishes it, replacing that draft server-side.
  const persist = async (status) => {
    if (!text.trim()) {
      setMessage("请填写点评内容。");
      return;
    }
    try {
      // sectionKey is a fixed prop, never reviewer-chosen. A segment mini-widget
      // tags with its own sectionKey; an aggregate tags with writeSectionKey
      // (null for 设计, "IMPLEMENTATION_OVERALL" for 实施) so its own comments
      // stay distinguishable from the segment reviews it also displays.
      const data = isExpertReviewer
        ? reviewPayload({ sectionKey: ownSectionKey, lessonIndex: ownLessonIndex, text, score }, status)
        : { content: text, lessonIndex: ownLessonIndex ?? undefined };
      await ReviewDataService.create(planId, data);
      if (status === "saved") {
        setBaseline({ text, score });
        setMessage("点评已保存（尚未提交，仅自己可见）。");
      } else {
        setText("");
        setScore("");
        setBaseline({ text: "", score: "" });
        setMessage("");
      }
      retrieveReviews();
    } catch (e) {
      setMessage(e?.response?.data?.message || (status === "saved" ? "保存点评失败。" : "提交点评失败。"));
    }
  };

  const submit = (e) => {
    e.preventDefault();
    persist("submitted");
  };

  const triggerAiReview = async () => {
    setAiLoading(true);
    setMessage("");
    try {
      const resp = await ReviewDataService.createAi(planId, {
        lessonIndex: lessonIndex !== undefined && lessonIndex !== null ? lessonIndex : undefined,
        scope: aggregateScope === "implementation" ? "implementation" : undefined,
      });
      const data = (resp && resp.data) || {};
      // The plan has one current AI evaluation (backend aiPlanEvaluation.js):
      // when its current content already has one under the standard in
      // effect -- from an earlier click or from AI 打分加点评 -- that one is
      // kept rather than generating another.
      setMessage(
        data.alreadyCurrent
          ? "当前课程内容已有按现行标准生成的 AI 点评（见下方列表），无需重复生成；修改课程内容后可再次请求。"
          : `AI 点评已生成${data.aiModel ? `（${data.aiModel}）` : ""}。`
      );
      retrieveReviews();
    } catch (e) {
      setMessage(e?.response?.data?.message || "AI 点评生成失败。");
    } finally {
      setAiLoading(false);
    }
  };

  // Mirror the form's unsaved edits into utils/pendingReviewEdits.js (see
  // there), which outlives this widget's mount.
  useEffect(() => {
    if (!isExpertReviewer || !planId || !userId) return;
    if (isDirty) {
      setPendingReviewEdit(localDraftKey, { planId, sectionKey: ownSectionKey, lessonIndex: ownLessonIndex, text, score });
    } else {
      clearPendingReviewEdit(localDraftKey);
    }
  }, [isExpertReviewer, planId, userId, localDraftKey, ownSectionKey, ownLessonIndex, isDirty, text, score]);

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
    if (r.status === "saved") continue;
    const key = reviewGroupKey(r);
    if (!latestIdByGroup.has(key)) latestIdByGroup.set(key, r.id);
  }
  const showUpdatedBadge = (review) =>
    review.status !== "saved" && isContentUpdated(review) && latestIdByGroup.get(reviewGroupKey(review)) === review.id;
  // A review is "this aggregate's own" iff it's tagged with this aggregate's
  // writeSectionKey and has no lessonIndex -- everything else shown in an
  // aggregate is a segment review, written at that segment's own tab and
  // read-only here once submitted (see the file header comment).
  const isOwnAggregateRow = (review) =>
    review.sectionKey === writeSectionKey && (review.lessonIndex === null || review.lessonIndex === undefined);
  const isSectionOrigin = (review) => isAggregateView && !isOwnAggregateRow(review);

  // What the 模块 column shows for a row, and whether/where clicking it
  // should navigate. A segment row links to its own section's tab; this
  // aggregate's own rows aren't clickable -- 实施's are tagged
  // "IMPLEMENTATION_OVERALL" (labeled 实施整体), 设计's untagged (整体).
  const moduleCell = (review) => {
    if (review.sectionKey) {
      return { label: sectionLabel(review.sectionKey, review.lessonIndex, sectionLabels), navKey: review.sectionKey, clickable: !isOwnAggregateRow(review) };
    }
    return { label: "整体", clickable: false };
  };

  const isMine = (review) => !!review.reviewerId && !!currentUser && String(review.reviewerId) === String(currentUser.id);
  // The requester's own saved draft for another spot (see OtherSpotDraftRow).
  const isMyOtherDraft = (review) => isExpertReviewer && review.status === "saved" && isMine(review) && !isOwnDraft(review);
  // A saved draft is outside the history lock (review.controller.js#delete),
  // and its author may delete it wherever it's shown -- it's edited in place
  // there too (see EditableDraftRow).
  const canDelete = (review) =>
    (review.status === "saved" && isMine(review)) ||
    (!isSectionOrigin(review) && (review.status === "saved" || isCurrentVersion(review)) && (AuthService.isAdmin() || isMine(review)));

  const deleteReview = async (review) => {
    if (!canDelete(review)) return;
    if (!window.confirm(review.status === "saved" ? "确定要删除该已保存的点评吗？" : "确定要删除该点评吗？")) return;
    try {
      await ReviewDataService.delete(review.id);
      if (isMyOtherDraft(review)) clearPendingReviewEdit(draftKeyOf(review, userId));
      retrieveReviews();
    } catch (e) {
      setMessage(e?.response?.data?.message || "删除失败。");
    }
  };

  // 类型/内容/点评人/时间/操作 + the optional 模块 and 评分 -- what a draft's
  // full-width editor row spans (see EditableDraftRow).
  const columnCount = 5 + (isAggregateView ? 1 : 0) + (showScore ? 1 : 0);

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

      {/* Once this spot has a saved draft, the form moves into that draft's
          own table row (see EditableDraftRow) -- same state, just shown
          where the draft is listed. */}
      {isExpertReviewer && !hasDraft && (
        <form onSubmit={submit} className="mb-3">
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
          <AutoGrowTextarea
            minRows={4}
            className="form-control mb-2"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={sectionKey ? `请针对 ${sectionLabel(sectionKey, lessonIndex, sectionLabels)} 部分填写点评...` : "请填写点评内容..."}
          />
          <button className="btn btn-outline-primary btn-sm mr-2" type="button" onClick={() => persist("saved")} disabled={!isDirty}>
            保存点评
          </button>
          <button className="btn btn-primary btn-sm" type="submit">
            提交点评
          </button>
          <small className="text-muted ml-2">{isDirty ? "有未保存的修改" : null}</small>
        </form>
      )}

      {!isExpertReviewer && !embedded && (
        <form onSubmit={submit} className="mb-3">
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
              {showScore && <th>评分</th>}
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
              const typeTags = (
                <>
                  {review.reviewerType === "ai" ? (
                    <span className="pl-tag-ai" title={[review.aiModel && `模型：${review.aiModel}`, review.standardId && `依据 AI 点评标准 #${review.standardId}`].filter(Boolean).join(" · ") || undefined}>
                      AI点评
                    </span>
                  ) : review.reviewerType === "admin" ? (
                    <span className="pl-tag-admin">管理员点评</span>
                  ) : (
                    <span className="pl-tag-expert">专家点评</span>
                  )}
                  {review.status === "saved" && (
                    <span className="pl-tag ml-1" title="仅自己可见，提交后教师与其他人才能看到">
                      已保存·未提交
                    </span>
                  )}
                  {newIds.has(review.id) && <span className="pl-tag pl-tag-new ml-1">新</span>}
                  {!isAggregateView && updatedBadge}
                </>
              );
              const moduleContent =
                isAggregateView &&
                (() => {
                  const { label, navKey, clickable } = moduleCell(review);
                  return (
                    <>
                      {clickable && onSelectSection ? (
                        <button type="button" className="btn btn-link p-0" onClick={() => onSelectSection(navKey, review.lessonIndex)}>
                          {label}
                        </button>
                      ) : (
                        label
                      )}
                      {updatedBadge}
                    </>
                  );
                })();
              const reviewerName = review.reviewerType === "ai" ? "AI智能体" : review.Reviewer ? review.Reviewer.chineseName || review.Reviewer.username : "-";
              const timeText = review.createdAt ? new Date(review.createdAt).toLocaleString("zh-cn") : "-";
              const meta = { tags: typeTags, module: moduleContent, reviewer: reviewerName, time: timeText };

              if (isExpertReviewer && isOwnDraft(review)) {
                return (
                  <EditableDraftRow
                    key={review.id}
                    meta={meta}
                    colSpan={columnCount}
                    showModule={isAggregateView}
                    showScore={showScore}
                    text={text}
                    score={score}
                    setText={setText}
                    setScore={setScore}
                    isDirty={isDirty}
                    onSave={() => persist("saved")}
                    onSubmit={() => persist("submitted")}
                    onDelete={() => deleteReview(review)}
                  />
                );
              }
              if (isMyOtherDraft(review)) {
                return (
                  <OtherSpotDraftRow
                    key={review.id}
                    review={review}
                    userId={userId}
                    onPersisted={retrieveReviews}
                    onMessage={setMessage}
                    meta={meta}
                    colSpan={columnCount}
                    showModule={isAggregateView}
                    showScore={showScore}
                    onDelete={() => deleteReview(review)}
                  />
                );
              }

              // AI 设计分数 from the same content version as this AI review
              // (review.controller.js#attachAiScores) -- sent to the plan's
              // owner and to experts/admins, never to a peer teacher. Its
              // total sits in the 评分 column; clicking it swaps the row's
              // full-width body from the review text to the itemized scores
              // (and back) -- 评分 and 内容 each drive their own content. The
              // row's 内容已更新 tag covers the score too.
              const scoreOpen = !!review.aiScore && scoreViewIds.has(review.id);
              const scoreContent = review.aiScore ? (
                <button
                  type="button"
                  className={`btn btn-link btn-sm p-0${scoreOpen ? " font-weight-bold" : ""}`}
                  title={scoreOpen ? "返回点评内容" : "查看各维度得分与评分标准"}
                  aria-pressed={scoreOpen}
                  onClick={() => showScoreView(review.id, !scoreOpen)}
                >
                  {aiDesignScoreText(review.aiScore)}
                </button>
              ) : !scoreColumnAiOnly && review.score !== null && review.score !== undefined ? (
                review.score
              ) : (
                "-"
              );
              const actions = (
                <>
                  {/* Continuing an AI review's discussion with 欣欣小助手 is
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
                      title="打开欣欣小助手，就这条点评继续提问"
                      onClick={() => window.dispatchEvent(new CustomEvent("copilot:open", { detail: { reviewId: review.id } }))}
                    >
                      讨论
                    </button>
                  )}
                  {canDelete(review) ? (
                    <button className="btn btn-link p-0 text-danger" onClick={() => deleteReview(review)}>
                      删除
                    </button>
                  ) : null}
                </>
              );

              // An AI review runs to several paragraphs -- same two-row shape
              // as a draft (EditableDraftRow): details under their own column
              // headers, then the text at the table's full width, where a
              // multi-paragraph review is actually readable. Starts collapsed
              // to its first few lines (faded out) when long.
              if (review.reviewerType === "ai") {
                // The score table is always long enough to collapse.
                const isLongAi = scoreOpen || isLongAiContent(review.content);
                const collapsed = isLongAi && !isExpanded;
                const toggle = isLongAi && (
                  <button type="button" className="btn btn-link btn-sm p-0" onClick={() => toggleExpanded(review.id)}>
                    {isExpanded ? "收起" : "展开全文"}
                  </button>
                );
                return (
                  <React.Fragment key={review.id}>
                    <tr className="pl-review-ai-row pl-review-ai-meta">
                      <td style={{ whiteSpace: "nowrap" }}>{typeTags}</td>
                      {isAggregateView && <td>{moduleContent}</td>}
                      {showScore && <td>{scoreContent}</td>}
                      <td className="small" style={{ whiteSpace: "nowrap" }}>
                        {scoreOpen ? (
                          <button type="button" className="btn btn-link btn-sm p-0" onClick={() => showScoreView(review.id, false)}>
                            查看点评
                          </button>
                        ) : (
                          toggle || <span className="text-muted">见下方</span>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{reviewerName}</td>
                      <td>{timeText}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{actions}</td>
                    </tr>
                    <tr className="pl-review-ai-row pl-review-ai-body">
                      <td colSpan={columnCount}>
                        <div
                          className={`pl-review-ai-content${scoreOpen ? " is-score" : ""}${collapsed ? " is-collapsed" : ""}`}
                        >
                          {scoreOpen ? <AiScorePanel score={review.aiScore} /> : review.content}
                        </div>
                        {toggle && <div className="mt-1">{toggle}</div>}
                      </td>
                    </tr>
                  </React.Fragment>
                );
              }

              return (
                <tr key={review.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{typeTags}</td>
                  {isAggregateView && <td>{moduleContent}</td>}
                  {showScore && <td>{scoreContent}</td>}
                  <td style={{ whiteSpace: "pre-wrap" }}>
                    {isLong && !isExpanded ? `${review.content.slice(0, CONTENT_PREVIEW_LENGTH)}...` : review.content}
                    {isLong && (
                      <button type="button" className="btn btn-link btn-sm p-0 ml-1" onClick={() => toggleExpanded(review.id)}>
                        {isExpanded ? "收起" : "展开"}
                      </button>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{reviewerName}</td>
                  <td>{timeText}</td>
                  <td>{actions}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

// Keyed by spot: plan-detail renders the same <ReviewList> element for
// sibling sections (WHY -> WHAT, 课时1 -> 课时2), and without a key React
// would keep one instance across them -- carrying one section's typed
// text into the next section's form.
const ReviewListBySpot = (props) => <ReviewList key={spotKey(props, "")} {...props} />;

export default ReviewListBySpot;
