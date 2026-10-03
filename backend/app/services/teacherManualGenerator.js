// Generates the teacher-facing manual (.docx) for 乡土智课系统, entirely
// on the fly from a hardcoded outline -- there is no source .docx this
// reads from, unlike dynamicDocGenerator.js's template-driven rendering.
// Content here describes real, current app behavior (button labels, confirm
// dialogs, status values, etc.) captured from the actual components/
// controllers at the time this was written -- see teacherManual.controller.js
// for the two ways it's surfaced to an admin (plain download, or publish
// into 学习资源库 as a 使用指南/教师手册 topic so teachers can find it
// themselves). Keep this file (not a one-off script) so the manual can be
// regenerated after a real UI/workflow change instead of silently going
// stale.
//
// Screenshots (see the screenshot() helper below) are real PNGs captured
// from a running instance by scripts/captureManualScreenshots.js (Playwright,
// a devDependency, never present in the production image) against real
// existing accounts and real existing content on that server (see
// scripts/prepareManualScreenshotState.js), checked into
// assets/manual-screenshots/ -- generation here only ever *reads* whatever
// is on disk at request time, it never launches a browser itself.
const fs = require("fs");
const path = require("path");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  TableLayoutType,
  Bookmark,
  InternalHyperlink,
  UnderlineType,
  ImageRun,
} = require("docx");

const GREEN = "1F4E2C";
const GRAY = "555555";
const RED = "B03A2E";
const MUTED = "666666";
const HEADER_SHADE = "E7EFE9";
const LINK_COLOR = "0563C1"; // Word's own default hyperlink theme color

// Every H1/H2 heading gets its own auto-generated bookmark id and a
// tocEntries[] entry as a side effect of being created (see registerHeading
// below) -- the 目录 (table of contents, spliced in near the top once the
// whole document has been built, see tocInsertIndex) and 索引 (the back-
// matter index, whose entries link to a heading via its *exact* text, see
// bmFor) both read off this single list instead of a hand-maintained
// id map, so a heading's wording can't drift out of sync with what the TOC/
// index actually link to.
let bmSeq = 0;
const tocEntries = [];
const registerHeading = (level, text) => {
  const id = `bm${++bmSeq}`;
  tocEntries.push({ level, text, id });
  return id;
};

// Looks up the bookmark id for a heading by its exact text -- used when
// building 索引's term -> location links. Throws at generation time (rather
// than silently linking nowhere) if a heading's wording here and the text
// passed to h1()/h2() above ever drift apart.
const bmFor = (headingText) => {
  const entry = tocEntries.find((e) => e.text === headingText);
  if (!entry) throw new Error(`teacherManualGenerator: no heading found for index entry "${headingText}"`);
  return entry.id;
};

// A4 usable width at the default 1440-twip (1in) margins on every side
// (11906 page width - 2*1440, see server-verified default in
// Packer.toBuffer's own pgSz/pgMar output) minus a deliberate safety margin
// -- tables are sized a bit narrower than the exact usable width, not flush
// against it, so column borders never visually crowd the page margin even
// under a viewer that rounds/renders slightly differently than Word.
const PAGE_MARGIN = 1440;
const TABLE_WIDTH = 8500;

const children = [];
const push = (...items) => children.push(...items);

const title = (text) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, bold: true, size: 60, color: GREEN })],
  });

const subtitle = (text) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200 },
    children: [new TextRun({ text, bold: true, size: 40 })],
  });

const centeredMuted = (text) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 400 },
    children: [new TextRun({ text, size: 22, color: MUTED })],
  });

// Explicit spacing (in twips, 240 = 12pt) on every heading/body paragraph
// rather than relying on Word's own built-in Heading1/2/3 style defaults --
// those vary noticeably between Word/LibreOffice/WPS, so pinning them here
// keeps the same visual rhythm (a clear gap above each heading, a tighter
// one below it before the body text starts) in every viewer. First heading
// of each chapter also carries pageBreakBefore so every "一、二、三..."
// chapter starts on its own page, without a separate explicit PageBreak
// paragraph between every section.
//
// Every heading's text is wrapped in a Bookmark (registerHeading -- see
// above) instead of being passed as a plain `text` shorthand, so 目录/索引
// can link straight to it via InternalHyperlink.
const h1 = (text) => {
  const id = registerHeading(1, text);
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: true,
    spacing: { after: 240 },
    children: [new Bookmark({ id, children: [new TextRun(text)] })],
  });
};
const h2 = (text) => {
  const id = registerHeading(2, text);
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 160 },
    children: [new Bookmark({ id, children: [new TextRun(text)] })],
  });
};

const p = (text) => new Paragraph({ text, spacing: { after: 160 } });

const bulletItem = (text) => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 100 } });

const numberedItem = (text, n) =>
  new Paragraph({ text: `${n}. ${text}`, indent: { left: 360 }, spacing: { after: 100 } });

const note = (text) =>
  new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text: `提示：${text}`, italics: true, color: GRAY })],
  });

const warn = (text) =>
  new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text: `注意：${text}`, bold: true, color: RED })],
  });

const italicLine = (text) =>
  new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text, italics: true })] });

const spacer = () => new Paragraph({ text: "" });

// Info table with a shaded, bold header row, fixed to TABLE_WIDTH (safely
// inside the page margins -- see above) with FIXED layout so a viewer can't
// widen it past that based on content, plus a little cell padding so text
// never touches the border. `ratios` (optional, same length as `headers`)
// gives proportional column widths instead of an even split -- most tables
// here pair a short label column with a much longer description column, and
// an even split either cramps the label or leaves the description column
// wrapping far more than it needs to.
const table = (headers, rows, ratios) => {
  const weights = ratios || headers.map(() => 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const colWidths = weights.map((w) => Math.floor((TABLE_WIDTH * w) / totalWeight));
  // Rounding from the floor() above can leave a few stray twips short of
  // TABLE_WIDTH -- folded into the last column so the declared per-cell
  // widths always sum to exactly the table's own declared width.
  colWidths[colWidths.length - 1] += TABLE_WIDTH - colWidths.reduce((a, b) => a + b, 0);

  const cellBorders = {
    top: { style: BorderStyle.SINGLE, size: 2, color: "BBBBBB" },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: "BBBBBB" },
    left: { style: BorderStyle.SINGLE, size: 2, color: "BBBBBB" },
    right: { style: BorderStyle.SINGLE, size: 2, color: "BBBBBB" },
  };
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (text, i) =>
        new TableCell({
          width: { size: colWidths[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: HEADER_SHADE },
          borders: cellBorders,
          children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })],
        })
    ),
  });
  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (text, i) =>
            new TableCell({
              width: { size: colWidths[i], type: WidthType.DXA },
              borders: cellBorders,
              children: [new Paragraph({ text: String(text) })],
            })
        ),
      })
  );
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    rows: [headerRow, ...bodyRows],
  });
};

// PNG width/height sit at fixed byte offsets (16/20, both 4-byte
// big-endian) right after the 8-byte signature + IHDR chunk header --
// reading them directly avoids pulling in an image-dimensions dependency
// just for this one, PNG-only, need (captureManualScreenshots.js only ever
// produces PNGs).
const readPngDimensions = (buffer) => {
  const isPng = buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a;
  if (!isPng) throw new Error("not a PNG file");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const SCREENSHOT_DIR = path.join(__dirname, "..", "..", "assets", "manual-screenshots");
// 560px ~= 5.83in at the standard 96dpi docx.js assumes for ImageRun's plain
// pixel width/height -- comfortably inside TABLE_WIDTH's own "safely inside
// the page margins" usable-width budget (see its own comment above).
const SCREENSHOT_DISPLAY_WIDTH = 560;
// 420px ~= 4.375in -- a second, independent cap on the *other* dimension.
// Width alone isn't enough: a tall/narrow capture (欣欣助手's portrait panel,
// 360x520 natively) stays comfortably under SCREENSHOT_DISPLAY_WIDTH on
// width but would still render ~5.4in tall at that width, often forcing it
// onto a page of its own. Whichever bound is tighter wins (see the scale
// computation below), so every screenshot -- whatever its native aspect
// ratio -- ends up sized to actually sit within a page alongside its own
// caption and the surrounding text, not just technically inside the left/
// right margins.
const SCREENSHOT_MAX_HEIGHT = 420;

// Embeds assets/manual-screenshots/<name>.png (captured by
// scripts/captureManualScreenshots.js -- see this file's header comment) at
// its natural aspect ratio, scaled down to SCREENSHOT_DISPLAY_WIDTH, with an
// optional italic caption underneath. Missing files are skipped silently
// (just a console.warn, not a thrown error) rather than failing the whole
// generation -- a manual with a few not-yet-captured screenshots is still
// far more useful than no manual at all, and this runs on every admin
// download/publish request, not just in a controlled build step.
const screenshot = (name, caption) => {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  if (!fs.existsSync(filePath)) {
    console.warn(
      `teacherManualGenerator: screenshot "${name}.png" not found -- run scripts/captureManualScreenshots.js to generate it. Skipping.`
    );
    return [];
  }
  const buffer = fs.readFileSync(filePath);
  let width;
  let height;
  try {
    ({ width, height } = readPngDimensions(buffer));
  } catch (e) {
    console.warn(`teacherManualGenerator: "${name}.png" isn't a readable PNG (${e.message}). Skipping.`);
    return [];
  }
  const scale = Math.min(1, SCREENSHOT_DISPLAY_WIDTH / width, SCREENSHOT_MAX_HEIGHT / height);
  const displayWidth = Math.round(width * scale);
  const displayHeight = Math.round(height * scale);
  const items = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: caption ? 40 : 160 },
      children: [new ImageRun({ data: buffer, transformation: { width: displayWidth, height: displayHeight } })],
    }),
  ];
  if (caption) {
    items.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
        children: [new TextRun({ text: caption, italics: true, size: 18, color: MUTED })],
      })
    );
  }
  return items;
};

// ============================================================
// 封面
// ============================================================
push(
  title("乡土智课系统"),
  subtitle("教师使用手册"),
  spacer(),
  centeredMuted("适用对象：教师用户　|　文档版本：2026 年 9 月")
);

// 目录 (see the very end of this file, after every heading has registered
// itself) is spliced in right here -- after the cover page, before 前言 --
// once its entries are actually known.
const tocInsertIndex = children.length;

// ============================================================
// 前言
// ============================================================
push(
  h1("前言"),
  p(
    "本手册面向「乡土智课系统」（乡土课程项目实施与案例分享系统）的教师用户，" +
      "介绍课程设计与实施全流程中最常用的功能：创建、编辑、保存、提交、上传、下载、删除课程设计，" +
      "专家评审与 AI 点评的查看方式，点评历史与轨迹，AI 讨论，AI 聊天助手「欣欣助手」（含代办操作），" +
      "课程实施阶段的支撑材料管理，以及模板更新后的迁移流程。"
  ),
  p("本手册所有界面文案、按钮名称均以系统当前实际界面为准；如系统后续升级，个别措辞可能略有差异。"),
  h2("常用导航入口"),
  table(
    ["菜单名称", "说明"],
    [
      ["我的乡土课程", "仅教师可见。教师本人创建的全部课程设计列表，是创建/编辑/提交/删除课程设计的主要入口。"],
      ["全部乡土课程", "教师与管理员可见。按「学年学期 → 学校 → 教师」层级展示的全部课程设计。"],
      ["待点评案例", "仅专家可见。已提交、等待点评的课程设计列表。"],
      ["学习资源库", "全体登录用户可见。按分类/主题组织的共享学习材料，参见本手册末章。"],
      ["课程案例库", "面向公众的优秀案例展示页，无需登录也可浏览。"],
      ["欣欣助手", "右下角悬浮按钮，任意页面均可打开，可答疑也可代办操作，参见本手册「AI 聊天助手」一章。"],
    ],
    [1, 3]
  ),
  spacer(),
  ...screenshot("nav-bar", "顶部导航栏")
);

// ============================================================
// 1. 创建课程设计
// ============================================================
push(
  h1("一、创建课程设计"),
  p(
    "在「我的乡土课程」页面点击左上角的「新增乡土课程」按钮，系统会立即创建一份空白课程设计并直接进入其详情页，" +
      "无需先填写任何表单。"
  ),
  numberedItem("进入「我的乡土课程」（导航栏）。", 1),
  numberedItem("点击「新增乡土课程」按钮。", 2),
  numberedItem("系统自动生成标题为「未命名课程设计」的新课程设计，并跳转到其详情页面。", 3),
  numberedItem("在详情页的「基本信息」中补充真实的标题、乡土主题、年级、年份、学季、学生人数、执教人、预计课时等信息。", 4),
  spacer(),
  ...screenshot("plans-list", "「我的乡土课程」列表 -- 左上角「新增乡土课程」按钮"),
  note(
    "新课程设计默认采用「在线填写」模式（planMode=online），即通过页面表单直接填写 WHY/WHAT/HOW 各部分及分课时设计；" +
      "也可以改为「上传文件」模式，通过上传已经填好的 Word 文档来提供内容（详见「五、上传文件」）。"
  ),
  p(
    "如果希望先在电脑上用 Word 离线填写，可以在「我的乡土课程」页面点击「乡土课程设计方案模版」或「乡土课程实施记录模版」的" +
      "下载/预览按钮，获取当前启用模板的空白 .docx 文件，填写完成后再通过「上传」功能导入系统。"
  )
);

// ============================================================
// 2. 删除课程设计
// ============================================================
push(
  h1("二、删除课程设计"),
  p("在课程设计卡片上点击「删除」按钮（教师仅可删除本人名下的课程设计，管理员可删除任意课程设计）。"),
  warn(
    "确认对话框会明确提示：「此操作将永久删除该课程设计及其所有附件与点评，且无法撤销，确定继续吗？」" +
      "这是彻底删除，会级联删除该课程设计下的全部支撑材料与点评记录，请谨慎操作。"
  ),
  p(
    "如果只是暂时不希望该课程设计出现在列表或案例库中，但不想永久删除，可以请管理员使用「停用」功能——" +
      "停用不会删除任何内容，只是隐藏该课程设计并暂时锁定教师的编辑权限，管理员可随时重新启用。"
  )
);

// ============================================================
// 3. 保存
// ============================================================
push(
  h1("三、保存（保存草稿）"),
  p(
    "课程设计详情页顶部（课程标题栏右上角）有一组「保存草稿」与「提交待点评」按钮，该标题栏固定在页面顶部，滚动时始终可见。" +
      "这组按钮统一作用于所有可在线填写的部分——「基本信息」、WHY/WHAT/HOW 对应板块、每个课时的「分课时设计」和「实施记录」——" +
      "点击一次即可保存所有板块中尚未保存的修改。"
  ),
  bulletItem("只有任一板块内容发生改动后，「保存草稿」按钮才可点击。"),
  bulletItem("在左侧导航中切换板块不会丢失尚未保存的修改，可以连续修改多个板块后再统一点击一次「保存草稿」。"),
  bulletItem("点击「保存草稿」只会保存内容，不会改变课程设计的状态（草稿/已提交/已点评）。"),
  bulletItem("教师可以在提交之后继续编辑并保存——系统不会因为已提交而锁定内容，可随时补充完善。"),
  warn(
    "如果修改后未保存就尝试离开当前页面或关闭浏览器标签页，系统会弹出提示：" +
      "「有未保存的内容，确定要离开吗？」请留意该提示，避免内容丢失。"
  ),
  ...screenshot("save-submit-buttons", "页面顶部的「保存草稿」「提交待点评」按钮")
);

// ============================================================
// 4. 提交
// ============================================================
push(
  h1("四、提交（提交待点评）"),
  p("填写完成后，点击页面顶部的「提交待点评」按钮（会同时保存所有未保存的修改），将课程设计的状态标记为「已提交」，以便专家/管理员进行点评。"),
  h2("状态说明"),
  table(
    ["界面显示", "说明"],
    [
      ["草稿", "课程设计的初始状态，教师仍在编辑中。"],
      ["已提交", "教师点击「提交待点评」后的状态，出现在专家的「待点评案例」列表中。"],
      [
        "已点评",
        "状态枚举中存在该值，但目前系统内暂无自动或手动将课程设计状态更新为「已点评」的操作——" +
          "是否已被点评，请以「基本信息」页面的「AI已点评」「专家已点评」标签为准，不要依赖状态本身判断。",
      ],
    ],
    [1, 3]
  ),
  spacer(),
  note(
    "「提交待点评」按钮只在课程设计状态仍为「草稿」时显示；一旦提交，此按钮会消失（不是变灰禁用），" +
      "状态只会向前推进，不会因为再次编辑而退回「草稿」。"
  ),
  note("如果课程设计和实施记录都尚无任何内容，「提交待点评」按钮会保持不可点击状态，需要先填写内容。"),
  p("专家点击导航栏「待点评案例」，看到的正是各教师已提交（status=submitted）的课程设计列表。")
);

// ============================================================
// 5. 上传
// ============================================================
push(
  h1("五、上传"),
  p("系统中共有三类「上传」，分别对应不同内容，教师需要根据实际需求选择正确的上传入口，避免误覆盖已填写的内容。"),
  h2("1. 课程设计文件上传（覆盖 WHY/WHAT/HOW 及分课时设计）"),
  bulletItem("入口：课程设计详情页「课程设计文件」板块的「上传」区域。"),
  bulletItem("仅支持 .docx 文件；其他格式会提示「仅支持上传 .docx 文件。」"),
  warn(
    "上传前会弹出确认框：「上传新文件将覆盖当前课程设计方案的全部在线内容（WHY/WHAT/HOW 及分课时设计），" +
      "且无法撤销，确定继续吗？」——这是整份覆盖，不是合并，请务必确认文件内容无误后再上传。"
  ),
  p("系统会自动解析上传的 Word 文档内容，并按当前课程设计所使用的模板结构提取各字段，写入在线表单。"),
  ...screenshot("upload-dropzone", "「课程设计文件」上传区域（拖拽或点击上传）"),
  h2("2. 课程实施文件上传（覆盖某一课时的实施记录）"),
  bulletItem("入口：对应课时「实施记录」板块的「上传」区域，同样仅支持 .docx。"),
  warn(
    "确认提示为：「上传新文件将覆盖本课时当前的实施记录内容，且无法撤销，确定继续吗？」" +
      "只影响该课时自己的实施记录，不影响其他课时或课程设计部分。"
  ),
  h2("3. 支撑材料上传（执行阶段辅助材料，可多文件/整文件夹）"),
  p(
    "每个课时的「支撑材料」板块提供类似网盘的文件管理器，点击「上传」可一次选择多个文件，" +
      "也可以直接将文件或整个文件夹拖拽到面板中（拖拽文件夹时会保留原有的目录结构）。"
  ),
  bulletItem("对文件类型没有限制，也没有单文件大小限制。"),
  bulletItem(
    '若上传的文件与已有文件重名，会提示「"文件名" 已存在，是否替换？」，可选择替换或跳过；' +
      "拖拽文件夹时若同名文件夹已存在，则会自动合并内容。"
  ),
  bulletItem("系统会依据扩展名自动识别文件类别（视频/图片/课件PPT等），仅用于图标展示，不影响存放位置。"),
  note("支撑材料的详细管理方式（新建文件夹、移动、重命名等）见本手册「十三、执行阶段支撑材料管理」一章。")
);

// ============================================================
// 6. 下载
// ============================================================
push(
  h1("六、下载"),
  h2("课程设计文件 / 课程实施文件"),
  p(
    "在对应板块点击「下载」或「预览」：系统会根据当前在线内容实时生成一份 .docx 文件，" +
      "而不是读取某个固定存档，因此下载结果永远反映最新保存的内容。「预览」会在新标签页中将文档转换为网页形式直接查看，" +
      "无需下载到本地。"
  ),
  h2("支撑材料"),
  bulletItem(
    "选中单个文件可直接下载；若勾选内容中包含文件夹，系统会自动打包为压缩包" +
      "（文件名形如「课时{课时号}-支撑材料.zip」）后下载。"
  ),
  h2("空白模板"),
  p(
    "在「我的乡土课程」页面可下载/预览当前启用的「乡土课程设计方案模版」「乡土课程实施记录模版」空白文件，" +
      "用于离线填写。该文件同样是根据模板结构实时生成，字体、编号、主题样式与真实模板保持一致，" +
      "且填写提示不会再带有多余的「-」符号前缀。"
  )
);

// ============================================================
// 7. 编辑
// ============================================================
push(
  h1("七、编辑"),
  p(
    "课程设计的所有在线填写内容对教师本人始终保持可编辑状态，不存在需要切换的「编辑模式」，也不会因为已提交而被锁定" +
      "（停用状态除外）。"
  ),
  bulletItem(
    "只有课程设计的所有者（创建该课程设计的教师）可以编辑内容，管理员没有编辑课程内容的权限" +
      "（管理员只能停用/删除/标记优秀案例/撰写点评）。"
  ),
  bulletItem("若课程设计已被管理员停用，页面会提示「该课程设计已被管理员停用，如需修改请联系管理员」，此时无法编辑。"),
  bulletItem(
    "「基本信息」中的标题、年份、学季、乡土主题、年级、学生人数、执教人、预计课时等字段可直接在页面上编辑，" +
      "与其他板块的修改一样，通过页面顶部的「保存草稿」统一保存。"
  ),
  note("部分字段的输入框中会显示模板自带的填写提示文字；开始输入后提示文字会被替换，不影响已保存内容。")
);

// ============================================================
// 8. 专家评审
// ============================================================
push(
  h1("八、专家评审"),
  p(
    "专家（或管理员）可以针对课程设计的各个部分——WHY/WHAT/HOW 各板块、每个课时的分课时设计、每个课时的实施记录，" +
      "以及「计划整体点评」「实施整体点评」两个整体入口——分别撰写点评。"
  ),
  bulletItem("点评表单包含评分（0–100，步长 0.5，可不填）与点评内容文本框，点击「提交点评」保存。"),
  bulletItem(
    '由专家账号提交的点评标记为「专家点评」；由管理员账号提交的点评标记为「管理员点评」——' +
      "二者在界面上以不同标签区分，即使同一人同时拥有专家与管理员角色，系统也会按「专家」身份记录。"
  ),
  bulletItem("课程设计「基本信息」页面会显示「专家已点评」标签（一旦存在任意一条专家点评即会显示）。"),
  bulletItem(
    "点评作者本人可以删除自己撰写的点评；但如果该课程设计的相关内容在点评之后被教师修改过，" +
      "该点评会被锁定为历史记录，任何人（含作者与管理员）都无法再删除，以保留完整的评审轨迹。"
  ),
  note("如果某条点评所对应的内容在点评完成后又被教师编辑，该点评行会显示「内容已更新」标签，提示这是一条可能已过时的点评。"),
  ...screenshot("review-panel", "「计划整体点评」板块 -- 专家点评、AI点评、请AI点评与讨论入口")
);

// ============================================================
// 9. AI 评审
// ============================================================
push(
  h1("九、AI 评审（AI 点评）"),
  p(
    '在「计划整体点评」（设计范围）或「实施整体点评」（设计+全部课时实施内容的综合范围）板块，' +
      "课程设计的所有者可以点击「请AI点评」按钮，由系统调用 AI 模型自动生成一份点评。"
  ),
  bulletItem("生成过程中按钮会显示「AI点评生成中...」并保持不可点击状态；即使切换到其他页面再切回来，仍会正确显示生成状态。"),
  bulletItem(
    "AI 会结合该课程设计的具体主题、年级、学校地区给出建议，并在需要时自动检索学习资源库中的相关共享材料作为参考" +
      "（回复下方会显示「参考资料：...」引用列表）。"
  ),
  bulletItem("AI 每次生成点评时都会参考该课程设计此前的全部点评历史，避免给出与已有点评脱节或重复的建议。"),
  bulletItem("生成结果会以「AI点评」标签显示（鼠标悬停可查看具体模型名称），与专家点评、管理员点评分列展示。"),
  bulletItem("「基本信息」页面会显示「AI已点评」标签，只要存在任意一条 AI 点评即会显示。"),
  warn("请求 AI 点评是所有者本人的操作（其他教师、专家、管理员无法为别人的课程设计触发 AI 点评）。")
);

// ============================================================
// 10. 评审轨迹/历史
// ============================================================
push(
  h1("十、评审轨迹与历史"),
  p(
    "每个点评板块内的点评列表均按「时间倒序」展示该部分收到的全部点评（AI点评/专家点评/管理员点评），" +
      "包含评分、点评内容（较长内容可点击「展开」/「收起」）、点评人、点评时间等信息，构成该部分的完整评审轨迹。"
  ),
  bulletItem(
    "「计划整体点评」「实施整体点评」这两个整体入口还会额外显示「模块」一列，标明每条点评具体对应哪个板块/课时，" +
      "点击可直接跳转到对应内容。"
  ),
  bulletItem(
    '若某条点评对应的内容后来被编辑过，会显示「内容已更新」标签，提示这条历史点评可能已不完全反映当前内容——' +
      "这正是系统用来标记评审轨迹「新旧」关系的方式，而不是把点评按内容版本分组折叠。"
  ),
  note("系统没有单独的「评审历史」页面，所有评审轨迹都直接展示在课程设计详情页对应板块内，无需另外查找。")
);

// ============================================================
// 11. AI 讨论
// ============================================================
push(
  h1("十一、AI 讨论"),
  p(
    "针对某一条 AI 点评（不包括专家点评/管理员点评），课程设计所有者可以点击该条点评右侧的「讨论」链接" +
      "（鼠标悬停提示：「打开欣欣助手，就这条点评继续提问」），系统会打开「欣欣助手」聊天面板，" +
      "并自动加载该条点评的具体内容作为上下文，教师可以直接针对这条点评继续追问。"
  ),
  bulletItem("该讨论是一段独立的对话线程，与该课程设计的一般性对话线程互不干扰，可通过「欣欣助手」的「历史」列表分别查看。"),
  warn(
    "如果课程设计在这条 AI 点评生成之后又被编辑过，欣欣助手会在回答时主动提醒：" +
      "「该点评基于该课程设计的旧版本，课程内容可能已发生变化」，请留意这一提示，必要时重新请求一次 AI 点评。"
  ),
  note("「讨论」链接仅对课程设计所有者本人可见，其他教师、专家、管理员查看同一条 AI 点评时不会看到此按钮。")
);

// ============================================================
// 12. AI 聊天助手「欣欣助手」
// ============================================================
push(
  h1("十二、AI 聊天助手「欣欣助手」"),
  p(
    "「欣欣助手」是一个悬浮在页面右下角的智能助手面板，既可以回答问题，也可以按您的要求代办系统操作（见下文「代办操作」），" +
      "任意页面、任意登录用户均可使用，" +
      "点击圆形按钮即可展开或收起，面板大小可通过左上角的拖拽手柄调整。"
  ),
  h2("使用范围与上下文"),
  bulletItem(
    '浏览某个课程设计详情页（网址形如 "/plans/数字"）时打开欣欣助手，对话会自动关联到该课程设计，' +
      "教师可以直接询问与这份课程设计相关的问题。" +
      "例外：如果这份课程设计是欣欣助手刚在另一段对话中为您新建或修改的，打开它时会接着那段对话继续（见下文「代办操作」）。"
  ),
  bulletItem("通过某条 AI 点评的「讨论」链接打开时，对话会关联到该条具体点评（见上一章）。"),
  bulletItem("不在上述任何场景下打开时，则是一条通用对话，不关联具体课程设计。"),
  bulletItem("欣欣助手可以在需要时自动检索学习资源库中的共享材料作为参考依据，回复下方会显示引用来源。"),
  h2("代办操作"),
  p(
    "除了回答问题，欣欣助手还可以按您的要求直接在系统中办理操作，省去手动填写和点击。" +
      "助手的权限与您本人完全相同：您本人在系统中能做的，才能请助手代办；您做不了的，助手也做不了。"
  ),
  bulletItem(
    "例如，与助手讨论出一份课程设计草案后，直接说「把这个草案建成一个新的课程设计」，" +
      "助手会按当前模板把草案内容逐项填入对应栏目（含分课时设计），新建一份草稿。"
  ),
  bulletItem(
    "也可以请助手「修改基本信息里的年级和课时数」「把第二课时的实施记录填上……」「请 AI 点评这份课程设计」" +
      "「列出我还没提交的课程设计」「把讨论内容整理成 Word 文档」等。"
  ),
  bulletItem(
    "新建或修改您本人的草稿内容会直接完成，「我的乡土课程」列表会自动刷新显示新建的课程设计，回复下方还会出现「打开《课程标题》」链接。" +
      "之后无论通过该链接还是从「我的乡土课程」列表打开这份课程设计，欣欣助手都会接着当前这段对话继续，不会另起一段新对话（如需全新对话，可点击「新对话」）。" +
      "如果您正在浏览该课程设计，页面会自动刷新显示助手修改后的内容；" +
      "若页面上有您尚未保存的修改，则不会自动刷新，而是提示您——此时保存会覆盖助手的修改。"
  ),
  bulletItem(
    "提交待点评、删除，以及其他会被他人看到或无法撤销的操作，助手不会直接执行，" +
      "而是在回复下方生成一张「待确认」卡片，写明将要执行的具体操作；" +
      "您核对无误后点击「确认执行」才会真正执行，点击「取消」则不执行。卡片随后会显示「已执行」「已取消」或「执行失败」及原因。"
  ),
  note("助手代为新建或填写的内容，建议到课程设计页面核对一遍后再提交待点评。"),
  ...screenshot("copilot-action-confirm", "欣欣助手生成的「待确认」操作卡片"),
  h2("上传附件"),
  p("可以把文件或图片交给欣欣助手阅读，再就其内容提问或请它代办操作，无需先把内容复制成文字。添加附件有三种方式："),
  bulletItem("点击输入框左侧的回形针按钮，从电脑中选择文件（可一次选择多个）。"),
  bulletItem("把截图直接粘贴到输入框中（例如用截图工具截图后按 Ctrl+V / ⌘+V）。"),
  bulletItem("把文件从电脑中直接拖到欣欣助手面板上。"),
  p(
    "支持的格式：Word（.docx）、PowerPoint（.pptx）、PDF、Excel（.xlsx）、文本（.txt / .md / .csv）以及常见图片格式；" +
      "单个文件不超过 20MB，每条消息最多 5 个附件。"
  ),
  bulletItem(
    "附件会先显示在输入框上方，系统随即读取其中的文字（图片则由 AI 识别其中的文字和内容），完成前显示「上传」「解析中...」或「识别中...」，此时暂不能发送。" +
      "点击附件右侧的「×」可在发送前移除。"
  ),
  bulletItem("可以只发送附件而不输入文字，助手会先概括附件内容，再询问您需要如何处理；也可以同时写明要求，例如「把这份教案建成一个新的课程设计」。"),
  bulletItem(
    "旧版 Office 格式（.doc / .ppt / .xls）无法读取，请先在 Office 或 WPS 中另存为 .docx / .pptx / .xlsx 再上传；" +
      "扫描版 PDF 中没有可提取的文字，附件上会显示警告图标，助手将无法阅读其内容。"
  ),
  note("篇幅很长的文件，助手每次只会读取前面的一部分，并会在回答中说明。附件随所在对话一起保存，删除对话时一并删除。"),
  ...screenshot("copilot-attachments", "已添加附件（一个 Word 文件和一张粘贴的截图）、准备发送的欣欣助手面板"),
  h2("导出对话"),
  p("可以把与欣欣助手的对话导出为文档，便于保存、打印或分享。点击面板顶部的「导出」后："),
  bulletItem("选择「整段对话」导出当前对话的全部内容（包括面板中没有显示的较早消息），或选择「选择部分消息」后勾选需要的消息（点击消息即可勾选或取消，可用「全选」「清空」）。"),
  bulletItem(
    "点击「Word」或「Markdown」下载对应格式的文件；点击「PDF」会打开浏览器的打印对话框，在其中选择「另存为 PDF」即可保存。" +
      "导出内容包含每条消息的发送时间、表格与列表等格式、附件名称（Word 和 PDF 中还会显示上传的图片）、操作卡片的执行状态以及参考资料来源。"
  ),
  bulletItem("点击「取消」或再次点击「导出」可退出导出状态。"),
  bulletItem(
    "也可以直接在对话中提出要求，例如「请用对话内容产生 Word 文档」（原样导出到目前为止的对话），" +
      "或「把上面的讨论整理成一份教学活动方案，生成 Word 文档」（由助手撰写一份正式文档）。" +
      "助手回复下方会出现文档卡片，点击「下载」即可获取文件（PDF 则点击「打印 / 另存为 PDF」）。"
  ),
  ...screenshot("copilot-export", "导出对话：选择部分消息"),
  h2("面板操作"),
  table(
    ["按钮/区域", "作用"],
    [
      [
        "历史",
        "查看此前的历史对话列表（按最近活动时间排序），可点击进入某条历史对话继续查看，" +
          "也可删除不再需要的历史对话（删除前会二次确认，且无法撤销）。",
      ],
      ["新对话", "结束当前浏览的历史对话、开始一条全新的对话。"],
      ["导出", "将当前对话的全部或部分消息导出为 Word、Markdown 或 PDF（见上文「导出对话」）。"],
      ["返回当前对话", "查看某条历史对话时出现的链接，点击可返回当前页面对应的最新对话。"],
      ["回形针按钮", "选择文件作为附件；也可直接在输入框中粘贴截图，或把文件拖到面板上（见上文「上传附件」）。"],
      ["输入框 + 发送按钮", "输入问题后按 Enter 键或点击输入框右侧的圆形向上箭头按钮发送；需要换行时按 Shift+Enter（使用拼音等输入法选字时按 Enter 不会发送）。输入框会随内容自动增高。发送过程中按钮会显示转圈图标并暂时禁用，助手回复前会显示「思考中...」。附件尚在解析时暂不能发送。"],
      ["确认执行 / 取消", "出现在「待确认」操作卡片上，用于执行或放弃助手提出的操作（见上文「代办操作」）。"],
      ["打开《课程标题》", "助手新建或修改课程设计后出现的链接，点击直接打开该课程设计，对话保持不变。"],
    ],
    [1, 2]
  ),
  spacer(),
  note("离开当前页面（切换到其他课程设计或其他功能页）不会清空对话内容，只会在再次打开时按新的上下文加载「当前」对话。"),
  ...screenshot("copilot-panel", "「欣欣助手」面板（打开状态）")
);

// ============================================================
// 13. 执行阶段支撑材料管理
// ============================================================
push(
  h1("十三、执行阶段支撑材料管理"),
  p(
    '每个课时的「实施」板块下都有一个「支撑材料」子页面（页面标题会显示为「支撑材料 · 课时 N」），' +
      "提供功能较完整的文件管理器，供教师存放该课时实施过程中产生的课件、图片、视频等辅助材料。"
  ),
  h2("主要功能"),
  table(
    ["功能", "说明"],
    [
      ["上传", "点击「上传」按钮多选文件，或将文件/文件夹直接拖拽到面板中（拖拽文件夹会保留原有目录结构）。"],
      ["新建文件夹", "点击「新建文件夹」创建子文件夹，支持任意层级嵌套。"],
      ["预览", "选中单个文件时可用，在新标签页中查看内容。"],
      ["下载", "支持多选下载；若选中内容包含文件夹，会自动打包为压缩包下载。"],
      ["重命名", "仅支持对单个文件夹重命名。"],
      ["移动到...", "通过文件夹选择弹窗，将选中的文件/文件夹移动到目标位置。"],
      ["删除", "支持批量删除；若选中内容包含文件夹，会连同文件夹内全部内容一并删除，删除前会二次确认，且无法撤销。"],
    ],
    [1, 3]
  ),
  spacer(),
  bulletItem("列表/图标两种查看方式可自由切换；支持表头「全选」多选操作。"),
  bulletItem("文件图标与分类会依据扩展名自动识别（视频/图片/课件PPT等），仅影响展示，不影响实际存放位置。"),
  bulletItem(
    "课程设计所有者拥有全部操作权限；管理员即使不是所有者，也可以下载支撑材料，但不能上传/移动/删除/重命名" +
      "（这些操作仅限所有者本人）。"
  ),
  ...screenshot("lesson-file-manager", "「支撑材料」文件管理器")
);

// ============================================================
// 14. 模板迁移
// ============================================================
push(
  h1("十四、模板迁移"),
  p(
    "当管理员发布了新版本的「乡土课程设计方案」模板，并针对旧版本发起迁移后，仍使用旧版本模板的教师会在系统中看到" +
      "醒目的迁移提示，需要教师主动确认迁移，系统不会自动、静默地修改已有课程设计内容。"
  ),
  h2("什么时候会看到迁移提示"),
  bulletItem("「我的乡土课程」页面顶部会出现闪烁的橙色「迁移课程计划（N）」按钮，N 为受影响的课程设计数量。"),
  bulletItem("受影响的每份课程设计卡片上会出现闪烁的「待迁移」标签。"),
  ...screenshot("plans-list", "闪烁的「迁移课程计划」按钮与课程设计卡片上的「待迁移」标签"),
  h2("点击迁移后会发生什么"),
  numberedItem("系统会将该教师名下全部标记为「待迁移」的课程设计，逐一从旧模板结构迁移到当前启用的新模板结构。", 1),
  numberedItem(
    '迁移采用「字段标签文字匹配」的方式：优先精确匹配字段名称，其次按同一分组匹配，' +
      "再按最长公共前缀匹配（例如旧字段「公开展示方式」可以匹配到新字段「公开展示方式（真实受众）」）。",
    2
  ),
  numberedItem("原字段中为空、或者只包含填写提示文字、或者是系统占位符「（未填写）」的内容，不会被当作有效内容迁移。", 3),
  numberedItem("迁移完成后，系统会提示「已迁移 N 个乡土课程设计，其中 M 个有内容需手动整理。」", 4),
  h2("「手动迁移内容」板块"),
  p(
    "如果旧模板中的某些已填写内容在新模板里找不到对应字段，系统不会丢弃这些内容，而是将其完整保留，" +
      "并在课程设计详情页侧边栏新增一个闪烁的「手动迁移内容」入口，页面提示："
  ),
  italicLine(
    "「以下内容来自旧版模板，新版模板中没有对应字段，请手动将需要保留的内容复制到相应板块后删除本板块。" +
      "本板块不会包含在下载的文档中。」"
  ),
  bulletItem("教师需要自行判断这部分内容是否还有保留价值，如有价值请手动复制粘贴到新模板对应的字段中。"),
  warn(
    '确认没有需要保留的内容后，点击「删除本板块」按钮清除该提示区域（确认框："确定删除手动迁移板块吗？' +
      '此操作无法撤销。"），课程设计卡片上的「待手动整理」标签也会随之消失。'
  ),
  note(
    "「待迁移」与「待手动整理」是两个先后出现、不会同时存在的标签：点击迁移会立即清除「待迁移」，" +
      "只有当迁移后确实留有未匹配内容时，才会转为出现「待手动整理」。"
  ),
  ...screenshot("manual-migration-panel", "「手动迁移内容」板块")
);

// ============================================================
// 15. 学习资源库
// ============================================================
push(
  h1("十五、学习资源库"),
  note(
    '系统导航栏中的正式名称是「学习资源库」，供全体登录用户浏览共享学习材料；本手册后续如提到「资料库」，' +
      "均指同一入口。"
  ),
  p("学习资源库由管理员按「分类 → 主题」两级组织和维护，教师、专家、管理员均可浏览与下载，教师无法自行新增分类或主题。"),
  h2("每个主题下的四个标签页"),
  table(
    ["标签页", "内容"],
    [
      ["基本信息", "分类、主题、主讲人、备注等信息（管理员维护）。"],
      ["材料内容", "与「支撑材料」相同的文件管理器，用于存放该主题下的 Word 文档、课件、图片、视频等材料，可直接下载。"],
      ["视频链接", "该主题相关的视频链接列表（描述 + 链接地址）。"],
      ["知识卡片", "由 AI 自动生成（也可人工编辑）的内容摘要卡片，包含标题、摘要、要点、标签。"],
    ],
    [1, 3]
  ),
  spacer(),
  ...screenshot("materials-library-content", "某主题的「材料内容」标签页 -- 文件列表"),
  p("页面顶部提供「搜索材料库...」搜索框，可按关键字快速定位到相关主题。"),
  note("欣欣助手与 AI 点评在生成回答时，也会在需要时自动检索学习资源库中的内容作为参考依据。")
);

// A clickable term -> location link, shared shape by both 目录 entries and
// 索引 entries below -- an InternalHyperlink jumping to the target
// heading's Bookmark id, styled like a conventional blue/underlined link so
// it visually reads as clickable even before a viewer's own hyperlink cursor
// confirms it.
const linkParagraph = (text, anchorId, opts = {}) =>
  new Paragraph({
    indent: opts.indent ? { left: opts.indent } : undefined,
    spacing: { after: opts.after || 80 },
    children: [
      new InternalHyperlink({
        anchor: anchorId,
        children: [
          new TextRun({
            text,
            bold: !!opts.bold,
            color: LINK_COLOR,
            underline: { type: UnderlineType.SINGLE },
          }),
        ],
      }),
    ],
  });

// ============================================================
// 索引 (back-matter term index) -- grouped by pinyin initial, each term
// linking to the exact heading (by its exact text, via bmFor) where that
// topic is covered. Deliberately built from real heading text rather than a
// separate hand-maintained id map, so a later heading reword breaks this
// loudly (bmFor throws) instead of silently linking to the wrong place.
// ============================================================
const INDEX_GROUPS = [
  {
    letter: "A",
    terms: [
      ["AI 点评", "九、AI 评审（AI 点评）"],
      ["AI 讨论", "十一、AI 讨论"],
    ],
  },
  {
    letter: "B",
    terms: [
      ["保存草稿", "三、保存（保存草稿）"],
      ["编辑", "七、编辑"],
    ],
  },
  {
    letter: "C",
    terms: [
      ["草稿 / 已提交 / 已点评（状态）", "状态说明"],
      ["创建课程设计", "一、创建课程设计"],
    ],
  },
  {
    letter: "D",
    terms: [
      ["待迁移标签", "什么时候会看到迁移提示"],
      ["待手动整理标签", "「手动迁移内容」板块"],
      ["导出对话（欣欣助手）", "导出对话"],
      ["点评轨迹与历史", "十、评审轨迹与历史"],
    ],
  },
  { letter: "G", terms: [["管理员点评", "八、专家评审"]] },
  {
    letter: "K",
    terms: [
      ["课程设计文件上传", "1. 课程设计文件上传（覆盖 WHY/WHAT/HOW 及分课时设计）"],
      ["课程实施文件上传", "2. 课程实施文件上传（覆盖某一课时的实施记录）"],
    ],
  },
  { letter: "M", terms: [["模板迁移", "十四、模板迁移"]] },
  { letter: "N", terms: [["内容已更新标签", "十、评审轨迹与历史"]] },
  { letter: "Q", terms: [["全选", "主要功能"]] },
  {
    letter: "S",
    terms: [
      ["删除课程设计", "二、删除课程设计"],
      ["手动迁移内容", "「手动迁移内容」板块"],
    ],
  },
  {
    letter: "T",
    terms: [
      ["停用", "二、删除课程设计"],
      ["提交待点评", "四、提交（提交待点评）"],
      ["讨论（与欣欣助手讨论点评）", "十一、AI 讨论"],
    ],
  },
  {
    letter: "X",
    terms: [
      ["下载（课程设计 / 实施文件）", "课程设计文件 / 课程实施文件"],
      ["学习资源库", "十五、学习资源库"],
      ["学习资源库·标签页", "每个主题下的四个标签页"],
      ["新建文件夹", "主要功能"],
      ["欣欣助手", "十二、AI 聊天助手「欣欣助手」"],
      ["欣欣助手·历史对话", "面板操作"],
      ["欣欣助手·使用范围", "使用范围与上下文"],
      ["欣欣助手·代办操作", "代办操作"],
      ["欣欣助手·上传附件", "上传附件"],
      ["欣欣助手·导出对话", "导出对话"],
    ],
  },
  {
    letter: "Y",
    terms: [
      ["移动到...", "主要功能"],
      ["优秀案例", "二、删除课程设计"],
      ["预览", "六、下载"],
    ],
  },
  {
    letter: "Z",
    terms: [
      ["专家评审", "八、专家评审"],
      ["支撑材料", "十三、执行阶段支撑材料管理"],
      ["支撑材料上传", "3. 支撑材料上传（执行阶段辅助材料，可多文件/整文件夹）"],
      ["支撑材料下载", "支撑材料"],
      ["状态说明", "状态说明"],
    ],
  },
];

push(
  h1("索引"),
  p("按拼音首字母分组；点击词条可跳转到手册中对应位置。"),
  ...INDEX_GROUPS.flatMap((group) => [
    new Paragraph({
      heading: HeadingLevel.HEADING_3,
      spacing: { before: 200, after: 80 },
      children: [new TextRun({ text: group.letter, bold: true, color: GREEN })],
    }),
    ...group.terms.map(([term, targetHeading]) => linkParagraph(term, bmFor(targetHeading), { indent: 200 })),
  ])
);

// ============================================================
// 目录 -- spliced in at tocInsertIndex (right after the cover page, before
// 前言), built only now that every heading in the document (索引's own
// included) has registered itself. H2 entries render indented and smaller
// than their parent H1.
// ============================================================
const tocChildren = [
  new Paragraph({ pageBreakBefore: true, heading: HeadingLevel.HEADING_1, spacing: { after: 240 }, text: "目录" }),
  p("点击章节标题可跳转到手册中对应位置。"),
  ...tocEntries.map((entry) =>
    linkParagraph(entry.text, entry.id, {
      indent: entry.level === 2 ? 400 : 0,
      after: entry.level === 2 ? 60 : 120,
      bold: entry.level === 1,
    })
  ),
];
children.splice(tocInsertIndex, 0, ...tocChildren);

// Page margins set explicitly (rather than left to docx's own default) so
// TABLE_WIDTH's "safely inside the margins" comment above stays true even
// if that default ever changes.
const buildTeacherManualDocument = () =>
  new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN } },
        },
        children,
      },
    ],
  });

const generateTeacherManualBuffer = async () => Packer.toBuffer(buildTeacherManualDocument());

module.exports = { generateTeacherManualBuffer };
