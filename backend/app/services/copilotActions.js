const db = require("../models");
const registry = require("./copilotRouteRegistry");
const { searchKnowledgeTree, searchKnowledgeBaseToolDef } = require("./knowledgeRetrieve");
const { buildPlanContentText } = require("./planContext");
const planForm = require("./copilotPlanForm");

// 欣欣助手's action layer: lets the co-pilot do on a user's behalf anything
// that user could otherwise do by hand -- and nothing more. Nothing here is
// a static snapshot of the API: the set of endpoints, who may call each, and
// what each takes all come from copilotRouteRegistry.js's runtime discovery
// of the live Express router, and every call runs that route's own guard
// chain + handler. Two layers sit on top of it:
//
//   - Generic: list_available_apis + call_api reach every discovered
//     endpoint the user's roles admit. A route added tomorrow is usable
//     tomorrow; a removed one simply stops being listed.
//   - Curated: a few higher-level tools for workflows a raw endpoint can't
//     express well -- chiefly turning a drafted plan into the template's own
//     field keys (create_plan/update_plan). Each declares the routes it is
//     built on (`routes`), is only offered while all of them exist and the
//     user's roles pass their guards, and calls them through the registry
//     too -- so curated tools follow route/guard changes automatically as
//     well, rather than carrying their own copy of the permission rules.
//
// Two tiers of write:
//   - Curated writes on the user's own work-in-progress (create/edit a draft
//     plan, fill in 实施记录, request an AI review) run immediately -- the
//     user asked for them in chat and can see/undo them on the plan page.
//   - `confirm` actions -- every non-GET call_api, plus curated submit_plan
//     -- never run inside the agent loop. The tool only validates and
//     returns a pending action; the panel renders 确认执行/取消 and only the
//     user's own click (POST /api/chat/messages/:messageId/actions/
//     :actionId/confirm) executes it. The model can't confirm on the user's
//     behalf no matter what it's told.

const MAX_LIST_ROWS = 20;
const MAX_RESULT_CHARS = 8000;

const getUserRoles = async (userId) => {
  const user = await db.user.findByPk(userId);
  if (!user) return [];
  const roles = await user.getRoles();
  return roles.map((r) => r.name);
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const requirePositiveInt = (value, label) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label}无效。`);
  return n;
};

// ctx = { userId, roles } -- bound per turn by buildToolset.
const call = (ctx, method, concretePath, opts) => registry.invoke(ctx.userId, ctx.roles, method, concretePath, opts);

// GET /api/plans/:id through its own visibility check -- every curated tool
// that reads or edits a specific plan loads it this way first, so the
// co-pilot can't surface another teacher's draft just by being handed its id.
const loadVisiblePlan = (ctx, planId) => call(ctx, "GET", `/api/plans/${requirePositiveInt(planId, "课程设计 ID ")}`);

const loadActiveSchema = async (ctx, templateKey) => {
  const version = await call(ctx, "GET", `/api/templates/${templateKey}/active`);
  return version && version.schemaJson;
};

const planLink = (plan) => ({ type: "plan", id: plan.id, title: plan.title });

const BASIC_INFO_KEYS = ["title", "theme", "grade", "studentCount", "instructorName", "year", "season", "plannedLessonCount"];

const pickBasicInfo = (args) => {
  const out = {};
  for (const key of BASIC_INFO_KEYS) {
    if (args[key] !== undefined && args[key] !== null) out[key] = args[key];
  }
  return out;
};

const currentSeason = () => {
  const month = new Date().getMonth() + 1;
  return month >= 2 && month <= 7 ? "春季" : "秋季";
};

const unknownKeysError = (unknownKeys) =>
  new Error(`以下字段键不存在：${unknownKeys.join("、")}。请先调用 get_plan_template 获取正确的字段键后重试。`);

const maxLessonIndex = (lessons) => (Array.isArray(lessons) ? lessons.reduce((m, l) => Math.max(m, Number(l.index) || 0), 0) : 0);

const plainPlanRow = (p) => ({
  id: p.id,
  title: p.title,
  theme: p.theme,
  grade: p.grade,
  year: p.year,
  season: p.season,
  status: p.status,
  isExcellentCase: p.isExcellentCase,
  suspended: p.suspended,
  teacher: p.Teacher ? p.Teacher.chineseName || p.Teacher.username : undefined,
  school: p.Teacher && p.Teacher.School ? p.Teacher.School.name : undefined,
});

// Keeps a raw API response from blowing up the model's context.
const capResult = (data) => {
  const text = JSON.stringify(data === undefined ? null : data);
  if (text.length <= MAX_RESULT_CHARS) return data === undefined ? { ok: true } : data;
  return { truncated: true, preview: `${text.slice(0, MAX_RESULT_CHARS)}…` };
};

// Which plan a generic call touched, inferred from its path -- lets the
// panel refresh/link the affected plan for call_api too, without a per-
// endpoint table.
const PLAN_PATH_RE = /^\/api\/plans\/(\d+)(\/|$)/;
const describeGenericChange = (method, concretePath, result) => {
  const match = PLAN_PATH_RE.exec(concretePath);
  if (match) {
    const planId = Number(match[1]);
    const deleted = method === "DELETE" && /^\/api\/plans\/\d+\/?$/.test(concretePath);
    return { changed: { planIds: [planId], deleted } };
  }
  if (method === "POST" && concretePath === "/api/plans" && result && result.id) {
    return { changed: { planIds: [result.id] }, link: planLink(result) };
  }
  return {};
};

// JSON-schema fragments reused across tool definitions.
const BASIC_INFO_PROPS = {
  title: { type: "string", description: "课程标题" },
  theme: { type: "string", description: "乡土主题（须为 get_plan_template 返回的 themeOptions 之一）" },
  grade: { type: "string", description: "年级（须为 get_plan_template 返回的 grades 之一）" },
  year: { type: "number", description: "年份，如 2026" },
  season: { type: "string", enum: ["秋季", "春季"], description: "学期" },
  studentCount: { type: "number", description: "学生人数" },
  instructorName: { type: "string", description: "执教人" },
  plannedLessonCount: { type: "number", description: "预计课时数" },
};
const FIELDS_PROP = {
  type: "object",
  description: "在线填写字段内容：键为 get_plan_template 返回的 planFields[].key，值为该字段的文字内容。只需包含要填写/修改的字段。",
  additionalProperties: { type: "string" },
};
const LESSONS_PROP = {
  type: "array",
  description: "分课时设计：每项为一个课时，index 从 1 开始；fields 的键为 get_plan_template 返回的 lessonFields[].key。",
  items: {
    type: "object",
    properties: {
      index: { type: "number", description: "第几课时（从 1 开始）" },
      fields: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["index", "fields"],
  },
};

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
//
// Each entry: { def, label, routes, confirm?, run(ctx, args), precheck? }
//   routes   -- "METHOD /pattern" keys this tool is built on. Offered only
//               when every one is currently registered *and* admits the
//               user's roles; `routes: []` = no API dependency at all.
//   confirm  -- see the file header; precheck(ctx, args) validates up front
//               (so the user is never shown a 确认 button for something that
//               would just fail) and returns the human-readable summary.

const TOOLS = [
  {
    label: "检索学习资源库",
    routes: [],
    def: searchKnowledgeBaseToolDef,
    // Knowledge-tree retrieval over the whole library, 使用指南 included
    // (欣欣助手 answers "how do I use the system" questions from it), with
    // topics' 主讲人/备注 visible so "谁讲过…" questions stay answerable.
    run: (ctx, args) => searchKnowledgeTree(args.query, { excludeCategories: [], includeTopicMeta: true }),
  },

  // ---- Generic API access ----------------------------------------------------
  {
    label: "查询可用接口",
    routes: [],
    def: fn(
      "list_available_apis",
      "列出当前用户有权调用的全部系统接口（方法、路径、说明、参数）。当没有专用工具能完成用户要求的操作时，先用它找到合适的接口，再用 call_api 调用。",
      { keyword: { type: "string", description: "按路径或说明过滤的关键词（可选），如 plans、review、material、users" } }
    ),
    run: async (ctx, args) => {
      const keyword = String(args.keyword || "").trim().toLowerCase();
      const apis = registry
        .listRoutes(ctx.roles)
        .filter((r) => !keyword || `${r.key} ${r.doc}`.toLowerCase().includes(keyword))
        .map((r) => ({
          method: r.method,
          path: r.path,
          description: r.doc || undefined,
          pathParams: r.params.path.length ? r.params.path : undefined,
          queryParams: r.params.query.length ? r.params.query : undefined,
          bodyParams: r.method !== "GET" && r.params.body.length ? r.params.body : undefined,
          needsConfirmation: r.method !== "GET" || undefined,
        }));
      return { count: apis.length, apis };
    },
  },
  {
    label: "调用系统接口",
    routes: [],
    // Only GET runs inside the agent loop; anything else becomes a pending
    // action the user confirms -- see confirmFor below.
    confirmFor: (args) => String(args.method || "").toUpperCase() !== "GET",
    def: fn(
      "call_api",
      "调用一个系统接口（须是 list_available_apis 列出的）。GET 直接执行并返回结果；POST/PUT/DELETE 等修改操作不会立即执行，而是生成待确认操作，需用户在对话框中点击「确认执行」。" +
        "只传接口说明中写明含义的参数；含义或取值不确定的可选参数请省略，不要猜测。" +
        "例外：名为 confirmCascade、confirmDelete 等 confirm 开头的查询参数是危险操作的二次确认开关，用户要求执行该操作时传 true（用户仍需点击「确认执行」）。",
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "具体路径，路径参数需替换为实际值，如 /api/plans/12/reviews" },
        query: { type: "object", description: "查询参数（可选）" },
        body: { type: "object", description: "请求体（可选，仅修改操作）" },
        summary: { type: "string", description: "用一句中文向用户说明此操作要做什么（修改操作必填，会显示在确认按钮旁）" },
      },
      ["method", "path"]
    ),
    precheck: async (ctx, args) => {
      const method = String(args.method || "").toUpperCase();
      const resolved = registry.resolve(method, args.path);
      if (!resolved || !registry.isAllowed(resolved.route, ctx.roles)) {
        throw new Error(`接口不存在或当前账号无权调用：${method} ${args.path}`);
      }
      const query = args.query && Object.keys(args.query).length ? `?${new URLSearchParams(args.query).toString()}` : "";
      const bodyPreview = args.body && Object.keys(args.body).length ? ` ${JSON.stringify(args.body).slice(0, 200)}` : "";
      return `${args.summary || "调用系统接口"}（${method} ${String(args.path).split("?")[0]}${query}${bodyPreview}）`;
    },
    run: async (ctx, args) => {
      const method = String(args.method || "").toUpperCase();
      const concretePath = String(args.path || "").split("?")[0];
      const result = await call(ctx, method, concretePath, { query: args.query, body: args.body });
      return { result: capResult(result), ...(method === "GET" ? {} : describeGenericChange(method, concretePath, result)) };
    },
  },

  // ---- Curated: plans ----------------------------------------------------------
  {
    label: "查看课程设计",
    routes: ["GET /api/plans/:id"],
    def: fn(
      "get_plan_details",
      "获取指定乡土课程设计的详细内容（基本信息、WHY/WHAT/HOW 在线填写内容或已上传文件的文字内容等）。",
      { planId: { type: "number", description: "课程设计 ID" } },
      ["planId"]
    ),
    run: async (ctx, args) => {
      const visible = await loadVisiblePlan(ctx, args.planId);
      // Rendered from a fresh, fully-included load -- buildPlanContentText
      // needs Sequelize instances (and the Teacher->School locality), not
      // the JSON the route returned.
      const plan = await db.plan.findByPk(visible.id, {
        include: [
          { model: db.templateVersion, as: "PlanTemplateVersion" },
          { model: db.templateVersion, as: "ExecutionTemplateVersion" },
          { model: db.user, as: "Teacher", include: [{ model: db.school, as: "School" }] },
        ],
      });
      const artifacts = plan.planFormData ? [] : await db.artifact.findAll({ where: { planId: plan.id, lessonIndex: null } });
      const content = await buildPlanContentText(plan, null, artifacts);
      return { planId: plan.id, title: plan.title, status: plan.status, content, link: planLink(plan) };
    },
  },
  {
    label: "查询课程设计列表",
    routes: ["GET /api/plans"],
    def: fn("list_plans", "按条件查询乡土课程设计列表（仅返回当前用户有权查看的）。mine=true 只看本人创建的。", {
      mine: { type: "boolean", description: "只看本人创建的课程设计" },
      keyword: { type: "string", description: "标题或主题关键词" },
      status: { type: "string", enum: ["draft", "submitted", "reviewed"], description: "状态：draft 草稿 / submitted 已提交 / reviewed 已点评" },
      theme: { type: "string" },
      grade: { type: "string" },
      year: { type: "number" },
      isExcellentCase: { type: "boolean", description: "只看优秀案例" },
      page: { type: "number", description: "页码，从 0 开始" },
    }),
    run: async (ctx, args) => {
      const query = { size: MAX_LIST_ROWS };
      for (const key of ["keyword", "status", "theme", "grade", "year", "page"]) {
        if (args[key] !== undefined && args[key] !== null && args[key] !== "") query[key] = args[key];
      }
      if (args.mine) query.mine = true;
      if (args.isExcellentCase !== undefined) query.isExcellentCase = !!args.isExcellentCase;
      const data = await call(ctx, "GET", "/api/plans", { query });
      return { totalItems: data.totalItems, currentPage: data.currentPage, totalPages: data.totalPages, rows: data.rows.map(plainPlanRow) };
    },
  },
  {
    label: "查看课程设计模板",
    routes: ["GET /api/plans/options", "GET /api/templates/:templateKey/active", "GET /api/plans/:id"],
    def: fn(
      "get_plan_template",
      "获取课程设计在线填写模板的字段清单（planFields / lessonFields / executionFields 的 key 与标题）以及可选的主题、年级、学期。" +
        "创建或填写课程设计前必须先调用。传 planId 时返回该课程设计所使用的模板版本；不传时返回当前启用的模板（用于新建）。",
      { planId: { type: "number", description: "已有课程设计 ID（可选）" } }
    ),
    run: async (ctx, args) => {
      let planSchema;
      let executionSchema;
      if (args.planId) {
        const plan = await loadVisiblePlan(ctx, args.planId);
        planSchema = plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson;
        executionSchema = plan.ExecutionTemplateVersion && plan.ExecutionTemplateVersion.schemaJson;
      } else {
        [planSchema, executionSchema] = await Promise.all([
          loadActiveSchema(ctx, "plan_design"),
          loadActiveSchema(ctx, "lesson_execution").catch(() => null),
        ]);
      }
      if (!planSchema) throw new Error("未找到启用的课程设计模板，请联系管理员。");
      const options = await call(ctx, "GET", "/api/plans/options");
      return {
        planFields: planForm.listPlanFields(planSchema),
        lessonFields: planForm.listLessonFields(planSchema),
        lessonBreakdownLabel: planSchema.lessonBreakdownLabel || "分课时设计",
        executionFields: executionSchema ? planForm.listPlanFields(executionSchema) : [],
        themeOptions: options.themes,
        grades: options.grades,
        seasons: options.seasons,
      };
    },
  },
  {
    label: "新建课程设计",
    routes: ["GET /api/templates/:templateKey/active", "POST /api/plans"],
    def: fn(
      "create_plan",
      "以在线填写方式新建一份乡土课程设计（草稿），可同时填入基本信息、各字段内容与分课时设计。" +
        "调用前须先调用 get_plan_template 获取字段 key。适用于用户要求「把刚才的草案建成一个新的课程设计」等场景。",
      { ...BASIC_INFO_PROPS, fields: FIELDS_PROP, lessons: LESSONS_PROP },
      ["title"]
    ),
    run: async (ctx, args) => {
      // Same version POST /api/plans pins the new plan to (the active one).
      const schema = await loadActiveSchema(ctx, "plan_design");
      if (!schema) throw new Error("未找到启用的课程设计模板，请联系管理员。");

      const { data: formData, unknownKeys } = planForm.applyFieldAnswers(schema, {}, args.fields);
      const { lessons, unknownKeys: unknownLessonKeys } = planForm.applyLessonAnswers(schema, [], args.lessons);
      const allUnknown = [...unknownKeys, ...unknownLessonKeys];
      if (allUnknown.length > 0) throw unknownKeysError(allUnknown);
      formData.lessons = lessons;

      const basic = pickBasicInfo(args);
      const body = {
        ...basic,
        year: basic.year || new Date().getFullYear(),
        season: basic.season || currentSeason(),
        plannedLessonCount: basic.plannedLessonCount || maxLessonIndex(lessons) || undefined,
        planMode: "online",
        planFormData: formData,
        status: "draft",
      };
      const plan = await call(ctx, "POST", "/api/plans", { body });
      return { planId: plan.id, title: plan.title, status: plan.status, link: planLink(plan), changed: { planIds: [plan.id] } };
    },
  },
  {
    label: "修改课程设计",
    routes: ["GET /api/plans/:id", "PUT /api/plans/:id"],
    def: fn(
      "update_plan",
      "修改本人的乡土课程设计：基本信息、在线填写字段内容、分课时设计。只会修改传入的字段，未传入的保持不变。调用前须先调用 get_plan_template（带 planId）获取字段 key。",
      { planId: { type: "number", description: "课程设计 ID" }, ...BASIC_INFO_PROPS, fields: FIELDS_PROP, lessons: LESSONS_PROP },
      ["planId"]
    ),
    run: async (ctx, args) => {
      const plan = await loadVisiblePlan(ctx, args.planId);
      const schema = plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson;
      const body = pickBasicInfo(args);

      if (args.fields || args.lessons) {
        if (plan.planMode !== "online") throw new Error("该课程设计为上传文件方式，不能在线填写内容。");
        const existing = plan.planFormData || {};
        const { data: formData, unknownKeys } = planForm.applyFieldAnswers(schema, existing, args.fields);
        const { lessons, unknownKeys: unknownLessonKeys } = planForm.applyLessonAnswers(schema, existing.lessons, args.lessons);
        const allUnknown = [...unknownKeys, ...unknownLessonKeys];
        if (allUnknown.length > 0) throw unknownKeysError(allUnknown);
        formData.lessons = lessons;
        body.planFormData = formData;
        const needed = maxLessonIndex(lessons);
        if (body.plannedLessonCount === undefined && needed > (plan.plannedLessonCount || 0)) body.plannedLessonCount = needed;
      }
      if (Object.keys(body).length === 0) throw new Error("没有需要修改的内容。");

      await call(ctx, "PUT", `/api/plans/${plan.id}`, { body });
      return { planId: plan.id, title: body.title || plan.title, updated: Object.keys(body), link: planLink(plan), changed: { planIds: [plan.id] } };
    },
  },
  {
    label: "填写课时实施记录",
    routes: ["GET /api/plans/:id", "PUT /api/plans/:id"],
    def: fn(
      "update_execution_record",
      "填写或修改本人课程设计中某一课时的实施记录。只会修改传入的字段。调用前须先调用 get_plan_template（带 planId）获取 executionFields 的 key。",
      {
        planId: { type: "number", description: "课程设计 ID" },
        lessonIndex: { type: "number", description: "第几课时（从 1 开始）" },
        fields: { ...FIELDS_PROP, description: "实施记录字段内容：键为 executionFields[].key。" },
      },
      ["planId", "lessonIndex", "fields"]
    ),
    run: async (ctx, args) => {
      const plan = await loadVisiblePlan(ctx, args.planId);
      const lessonIndex = requirePositiveInt(args.lessonIndex, "课时序号");
      const schema = plan.ExecutionTemplateVersion && plan.ExecutionTemplateVersion.schemaJson;
      const records = Array.isArray(plan.executionFormData) ? plan.executionFormData.map((r) => ({ ...r })) : [];
      const idx = records.findIndex((r) => Number(r.index) === lessonIndex);
      const existing = idx >= 0 ? records[idx] : { index: lessonIndex };
      const { data, unknownKeys } = planForm.applyFieldAnswers(schema, existing, args.fields);
      if (unknownKeys.length > 0) throw unknownKeysError(unknownKeys);
      data.index = lessonIndex;
      if (idx >= 0) records[idx] = data;
      else records.push(data);
      records.sort((a, b) => Number(a.index) - Number(b.index));

      const body = { executionFormData: records };
      if (lessonIndex > (plan.plannedLessonCount || 0)) body.plannedLessonCount = lessonIndex;
      await call(ctx, "PUT", `/api/plans/${plan.id}`, { body });
      return { planId: plan.id, lessonIndex, link: planLink(plan), changed: { planIds: [plan.id] } };
    },
  },
  {
    label: "提交待点评",
    routes: ["GET /api/plans/:id", "PUT /api/plans/:id"],
    confirm: true,
    def: fn(
      "submit_plan",
      "将本人的草稿课程设计「提交待点评」（提交后其他教师、专家可见，且不能撤回为草稿）。需用户在对话框中点击确认后才会执行。",
      { planId: { type: "number", description: "课程设计 ID" } },
      ["planId"]
    ),
    // The same not-blank gate as the page's own 提交待点评 button
    // (plan-detail.component.js's planNotEmpty/executionNotEmpty) -- the
    // PUT route itself doesn't check it.
    precheck: async (ctx, args) => {
      const plan = await loadVisiblePlan(ctx, args.planId);
      if (plan.teacherId !== ctx.userId) throw new Error("只能提交本人创建的乡土课程设计。");
      if (plan.status !== "draft") throw new Error("该课程设计已提交，无需重复提交。");
      const planSchema = plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson;
      const execSchema = plan.ExecutionTemplateVersion && plan.ExecutionTemplateVersion.schemaJson;
      const lessons = (plan.planFormData && plan.planFormData.lessons) || [];
      const notEmpty =
        planForm.hasAnyContent(planSchema, plan.planFormData) ||
        lessons.some((l) => Object.keys(l).some((k) => k !== "index" && l[k] != null && String(l[k]).trim() !== "")) ||
        (Array.isArray(plan.executionFormData) && plan.executionFormData.some((r) => planForm.hasAnyContent(execSchema, r)));
      if (!notEmpty) throw new Error("该课程设计尚无填写内容，不能提交。");
      return `提交课程设计《${plan.title}》待点评`;
    },
    run: async (ctx, args) => {
      const planId = requirePositiveInt(args.planId, "课程设计 ID ");
      await call(ctx, "PUT", `/api/plans/${planId}`, { body: { status: "submitted" } });
      return { planId, status: "submitted", changed: { planIds: [planId] } };
    },
  },
  {
    label: "请求 AI 点评",
    routes: ["GET /api/plans/:id", "POST /api/plans/:planId/reviews/ai"],
    def: fn(
      "request_ai_review",
      "为课程设计生成（或获取已有的）AI 计划整体点评。本人的课程设计可随时请求；专家/管理员只能为已提交的课程设计请求。",
      { planId: { type: "number", description: "课程设计 ID" } },
      ["planId"]
    ),
    run: async (ctx, args) => {
      const plan = await loadVisiblePlan(ctx, args.planId);
      const review = await call(ctx, "POST", `/api/plans/${plan.id}/reviews/ai`, { body: {} });
      return {
        planId: plan.id,
        alreadyCurrent: !!review.alreadyCurrent,
        review: review.content,
        link: planLink(plan),
        changed: { planIds: [plan.id] },
      };
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.def.function.name, t]));

const needsConfirmation = (tool, args) => !!tool.confirm || (tool.confirmFor ? tool.confirmFor(args) : false);

// Offered iff every route it's built on is registered right now and admits
// these roles -- evaluated per turn against the live router.
const isOffered = (tool, roles) =>
  tool.routes.every((key) => {
    const [method, pattern] = key.split(" ");
    const route = registry.listRoutes(roles).find((r) => r.method === method && r.path === pattern);
    return !!route;
  });

// Builds the per-turn toolset for one user: { tools, executors } ready for
// agentLoop.runAgentLoop. A confirm-tier call's executor never runs the
// action -- it validates (precheck) and returns a pending descriptor; see
// runConfirmedAction below.
const buildToolset = async (userId) => {
  const roles = await getUserRoles(userId);
  const ctx = { userId, roles };
  const offered = TOOLS.filter((t) => isOffered(t, roles));
  const executors = {};
  let pendingCounter = 0;
  for (const tool of offered) {
    executors[tool.def.function.name] = async (args) => {
      if (!needsConfirmation(tool, args)) return tool.run(ctx, args);
      const summary = await tool.precheck(ctx, args);
      pendingCounter += 1;
      return {
        pendingConfirmation: true,
        actionId: `${Date.now().toString(36)}-${pendingCounter}`,
        status: "pending",
        label: tool.label,
        summary,
        note: "该操作尚未执行。请告诉用户：请在对话框中核对后点击「确认执行」按钮（或「取消」）。不要声称操作已完成。",
      };
    };
  }
  // A short capability digest for the system prompt: curated tools by
  // label, plus how many raw endpoints call_api can reach for this user.
  const apiCount = registry.listRoutes(roles).length;
  const labels = offered.map((t) => t.label);
  return { roles, tools: offered.map((t) => t.def), executors, labels, apiCount };
};

// Runs a previously-proposed confirm action, after the user clicked 确认执行.
// Roles are re-resolved now (not trusted from when it was proposed) and the
// route's own guard chain re-checks everything anyway.
const runConfirmedAction = async (userId, name, args) => {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool || !needsConfirmation(tool, args)) throw new Error("未知的待确认操作。");
  const roles = await getUserRoles(userId);
  if (!isOffered(tool, roles)) {
    const err = new Error("当前账号没有执行该操作的权限。");
    err.status = 403;
    throw err;
  }
  return { label: tool.label, result: await tool.run({ userId, roles }, args) };
};

module.exports = { buildToolset, runConfirmedAction };
