import ReviewDataService from "../services/review.service";
import { registerSessionExpiryHandler, writeLocalDraft, takeLocalDraft } from "./sessionExpiryGuard";

// Unsaved edits in expert/admin review forms (review-list.component.js),
// held outside the component so they outlive its mount: plan-detail shows
// one sidebar section at a time, and switching sections unmounts that
// section's ReviewList -- which used to silently drop whatever was typed.
// A form writes its edits here whenever it's dirty and clears them once
// it's back in sync with the server; a remounted form starts from them.
// PlanDetail's own unsaved-changes guards (<Prompt>, beforeunload) and
// the session-timeout auto-save cover these edits through this store, even
// for a section that isn't on screen anymore.
//
// key -> { planId, sectionKey, lessonIndex, text, score }. The key also
// names the localStorage stash (see ReviewList's localDraftKey), so it
// includes the user's id.
const pending = new Map();
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const getPendingReviewEdit = (key) => pending.get(key);

export const setPendingReviewEdit = (key, entry) => {
  const had = pending.has(key);
  pending.set(key, entry);
  if (!had) notify();
};

export const clearPendingReviewEdit = (key) => {
  if (pending.delete(key)) notify();
};

export const hasPendingReviewEdits = (planId) => [...pending.values()].some((e) => String(e.planId) === String(planId));

// The teacher-style "leave and discard" -- PlanDetail calls this on
// unmount, after its <Prompt> was answered "leave".
export const discardPendingReviewEdits = (planId) => {
  [...pending.entries()].forEach(([key, e]) => {
    if (String(e.planId) === String(planId)) pending.delete(key);
  });
  notify();
};

export const subscribePendingReviewEdits = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const reviewPayload = (entry, status) => {
  const data = { content: entry.text, status };
  if (entry.sectionKey) data.sectionKey = entry.sectionKey;
  if (entry.lessonIndex !== null && entry.lessonIndex !== undefined) data.lessonIndex = entry.lessonIndex;
  if (entry.score !== "") data.score = Number(entry.score);
  return data;
};

// Only an edit with content can be saved (the server rejects an empty
// review); an emptied-out form still guards navigation, just isn't saved.
const savable = () => [...pending.entries()].filter(([, e]) => e.text.trim());

// Session-timeout auto-save (see utils/sessionExpiryGuard.js): each edit
// goes to its author's saved draft for that spot -- never submitted, an
// expert's review only goes public when they say so.
registerSessionExpiryHandler({
  hasUnsaved: () => savable().length > 0,
  stash: () => savable().forEach(([key, e]) => writeLocalDraft(key, { text: e.text, score: e.score })),
  save: () =>
    Promise.all(
      savable().map(async ([key, e]) => {
        try {
          await ReviewDataService.create(e.planId, reviewPayload(e, "saved"));
          pending.delete(key);
          takeLocalDraft(key);
        } catch (err) {
          console.log(err);
        }
      })
    ).then(notify),
});
