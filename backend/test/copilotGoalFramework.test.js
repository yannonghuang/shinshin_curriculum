// Run: npm test (node --test). Guards the 社会情感目标 drift fix: a focus on
// a 学习目标 field must carry the library's definition (社会情感 = SEL /
// CASEL five), and the drafter must use the same categories.
const test = require("node:test");
const assert = require("node:assert");
const { describeFocus, normalizeFocus } = require("../app/services/copilotFocus");
const { goalCategoryOf, GOAL_CATEGORY_NAMES } = require("../app/services/curriculumGlossary");

// Shaped like template version 36: goal fields with null hints.
const plan = {
  id: 267,
  title: "探索敦煌飞天线描艺术",
  teacherId: 1,
  PlanTemplateVersion: {
    schemaJson: {
      sections: [
        {
          key: "why",
          ownFields: [
            { key: "f0", label: "认知思维目标：", hint: null },
            { key: "f2", label: "社会情感目标：", hint: null },
          ],
        },
        { key: "what", ownFields: [{ key: "w0", label: "项目介绍：", hint: null }] },
      ],
    },
  },
  planFormData: { why: { f2: "建立对家乡文化遗产的认同感与自豪感" } },
};

const focusOn = (fieldKey, labelPath) => normalizeFocus({ kind: "planSection", fieldKey, labelPath }, plan.id);

test("社会情感目标 focus carries the SEL / CASEL definition first", () => {
  const text = describeFocus(plan, focusOn("f2", ["WHY ·学习目标", "社会情感目标"]));
  for (const term of ["SEL", "自我意识", "自我管理", "社会意识", "关系技能", "负责任的决策", "只写 SEL 目标", "应写入「其他目标」"]) {
    assert.ok(text.includes(term), `missing ${term}`);
  }
  assert.ok(text.indexOf("社会情感目标：即社会情感学习") < text.indexOf("认知思维目标："), "focused category listed first");
});

test("学习目标 section focus carries the framework; unrelated fields don't", () => {
  assert.ok(describeFocus(plan, focusOn(undefined, ["WHY ·学习目标"])).includes("课程框架术语"));
  assert.ok(!describeFocus(plan, focusOn("w0", ["WHAT · 项目简介", "项目介绍"])).includes("课程框架术语"));
});

test("goal labels map to categories", () => {
  assert.strictEqual(goalCategoryOf("社会情感目标："), "社会情感");
  assert.strictEqual(goalCategoryOf("其他目标："), "其它");
  assert.strictEqual(goalCategoryOf("项目介绍："), null);
  assert.deepStrictEqual(GOAL_CATEGORY_NAMES, ["认知思维", "实践技能", "社会情感", "跨学科融合", "其它"]);
});
