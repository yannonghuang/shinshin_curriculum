// Run: npm test. 全部乡土课程's 语义搜索 (planSearch.js): question parsing
// and which plan text gets indexed -- the ranking itself needs the
// embedding API and was measured on prod (see the file header).
const test = require("node:test");
const assert = require("node:assert");
const { parseCount, categoryIn, planParts } = require("../app/services/planSearch");
const { goalSearchProfile } = require("../app/services/curriculumGlossary");

test("count parsing", () => {
  assert.strictEqual(parseCount("请找出5个设置社会情感目标较好的项目"), 5);
  assert.strictEqual(parseCount("找出五个"), 5);
  assert.strictEqual(parseCount("前十"), 10);
  assert.strictEqual(parseCount("列出十二个项目"), 12);
  assert.strictEqual(parseCount("二十个"), 20);
  assert.strictEqual(parseCount("哪些项目采访了老人"), null);
});

test("goal category in the question", () => {
  assert.strictEqual(categoryIn("社会情感目标较好的"), "社会情感");
  assert.strictEqual(categoryIn("SEL 目标写得好的"), "社会情感");
  assert.strictEqual(categoryIn("实践技能目标"), "实践技能");
  assert.strictEqual(categoryIn("其他目标写得好的"), "其它");
  assert.strictEqual(categoryIn("其他项目"), null);
});

test("社会情感 search contrasts culture goals, without the placement rule", () => {
  const p = goalSearchProfile("社会情感");
  assert.ok(p.positive.includes("CASEL") && !p.positive.includes("本项目约定"));
  assert.ok(p.contrast.includes("文化认同"));
  assert.strictEqual(goalSearchProfile("认知思维").contrast, null);
  assert.strictEqual(goalSearchProfile("项目介绍"), null);
});

test("indexed parts: real answers only, deduplicated, lessons labelled", () => {
  const plan = {
    id: 1,
    PlanTemplateVersion: {
      schemaJson: {
        sections: [
          { key: "s0", fields: [{ key: "f2", label: "社会情感目标：" }] },
          {
            key: "s2",
            fields: [{ key: "f14", label: "探究问题：", hint: "围绕主题设计探究问题链" }],
            subsections: [{ key: "s4", ownFields: [{ key: "f14", label: "探究问题：", hint: "围绕主题设计探究问题链" }] }],
          },
        ],
        lessonSchema: { ownFields: [{ key: "f4", label: "5.教学活动流程：" }] },
      },
    },
    planFormData: {
      s0: { f2: "在小组合作中学会倾听同伴意见" },
      s2: { f14: "围绕主题设计探究问题链" },
      lessons: [{ index: 2, f4: "学生分组采访村里的老人，记录他们的童年游戏。" }],
    },
  };
  assert.deepStrictEqual(
    planParts(plan).map((p) => [p.partKey, p.label]),
    [
      ["s0.f2", "社会情感目标"],
      ["L2.f4", "第2课时·教学活动流程"],
    ]
  );
});

test("vectors round-trip through the binary column, normalized", () => {
  const { encodeVectors, decodeVectors } = require("../app/services/planSearch");
  const { vectors, dims } = encodeVectors([
    [3, 4, 0],
    [0, 0, 2],
  ]);
  // A driver Buffer can sit at an odd offset inside a larger allocation.
  const padded = Buffer.concat([Buffer.from([7]), vectors]).subarray(1);
  const out = decodeVectors(padded, dims).map((v) => Array.from(v).map((x) => Math.round(x * 100) / 100));
  assert.deepStrictEqual(out, [
    [0.6, 0.8, 0],
    [0, 0, 1],
  ]);
});
