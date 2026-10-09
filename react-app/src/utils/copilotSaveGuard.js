// Lets a page with unsaved edits (PlanDetail) get them saved before 欣欣小助手
// looks at it: the assistant reads the plan from the server, so a question
// asked over unsaved edits would see different content than the page shows
// (e.g. 预计课时 10 on screen, 4 in the database). Run by AskAiMenu before
// it opens the panel, and by the panel before each send. A module-level
// slot rather than React context: the panel lives outside the page's tree.
let handler = null;

// fn(): Promise<bool> -- true once nothing is left unsaved (or there was
// nothing to save), false if the save failed (the page reports why).
export const registerCopilotSaveHandler = (fn) => {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
};

export const saveBeforeCopilot = async () => {
  if (!handler) return true;
  try {
    return await handler();
  } catch (e) {
    console.log(e);
    return false;
  }
};
