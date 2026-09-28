// AI 点评标准 -> .docx, for the page's 导出 Word button. Mirrors the page's
// own read-only view (ai-review-standard.component.js's StandardTable plus
// the version line above it): title, version info, overview, the
// 评分维度/分值/评分要点/等级描述 table, then 评分说明. Rendered on demand from the
// stored version, never persisted.
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  TableLayoutType,
  PageOrientation,
} = require("docx");

const MUTED = "666666";
const HEADER_SHADE = "E7EFE9";

// Landscape A4 (16838 x 11906 twips) at 1-inch margins leaves 13958 twips;
// the table stays a little narrower than that, same safety margin idea as
// teacherManualGenerator.js's TABLE_WIDTH.
const PAGE_MARGIN = 1440;
const TABLE_WIDTH = 13600;
// 评分维度 / 分值 / 评分要点 / 等级描述 -- same proportions as the page's table.
const COLUMN_RATIOS = [18, 8, 40, 34];

const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
};

const para = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: opts.after === undefined ? 80 : opts.after },
    alignment: opts.alignment,
    bullet: opts.bullet ? { level: 0 } : undefined,
    children: [new TextRun({ text: text || "", bold: opts.bold, size: opts.size, color: opts.color })],
  });

// "<bold label>：<text>" in one paragraph -- a level's descriptor, a
// dimension's 依据.
const labeled = (label, text, opts = {}) =>
  new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: label, bold: true, size: opts.size }),
      new TextRun({ text: `：${text || ""}`, size: opts.size, color: opts.color }),
    ],
  });

const heading = (text) =>
  new Paragraph({
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, size: 28 })],
  });

const versionLine = (standard) => {
  // Pinned to China time -- the server runs in UTC, but readers don't.
  const createdAt = new Date(standard.createdAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
  const parts = [`版本 #${standard.id}`, createdAt];
  if (standard.source === "human") {
    parts.push(`人工修订${standard.operator ? `：${standard.operator.name}` : ""}（基于版本 #${standard.baseId}）`);
  } else {
    parts.push(`AI 生成${standard.aiModel ? `（${standard.aiModel}）` : ""}`);
  }
  if (Array.isArray(standard.sourceTopicIds)) parts.push(`依据学习资源库 ${standard.sourceTopicIds.length} 个主题`);
  parts.push(`满分 ${standard.content.totalScore}`);
  return parts.join(" · ");
};

const buildTable = (dimensions) => {
  const total = COLUMN_RATIOS.reduce((a, b) => a + b, 0);
  const widths = COLUMN_RATIOS.map((r) => Math.floor((TABLE_WIDTH * r) / total));
  widths[widths.length - 1] += TABLE_WIDTH - widths.reduce((a, b) => a + b, 0);
  const cell = (i, children, shade) =>
    new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      borders: cellBorders,
      shading: shade ? { type: ShadingType.CLEAR, fill: HEADER_SHADE } : undefined,
      children: children.length ? children : [para("")],
    });

  const header = new TableRow({
    tableHeader: true,
    children: ["评分维度", "分值", "评分要点", "等级描述"].map((t, i) => cell(i, [para(t, { bold: true, after: 0 })], true)),
  });
  const rows = dimensions.map(
    (d) =>
      new TableRow({
        children: [
          cell(0, [
            para(d.name, { bold: true }),
            ...(d.description ? [para(d.description, { size: 18, color: MUTED })] : []),
            ...(d.basis ? [labeled("依据", d.basis, { size: 18 })] : []),
          ]),
          cell(1, [para(String(d.weight), { after: 0 })]),
          cell(2, (d.criteria || []).map((c) => para(c, { bullet: true }))),
          cell(3, (d.levels || []).map((lv) => labeled(`${lv.label}${lv.range ? `（${lv.range}）` : ""}`, lv.descriptor, { size: 20 }))),
        ],
      })
  );
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    // Declared on the table grid too, not just per cell -- LibreOffice/WPS
    // otherwise split the width evenly across the four columns.
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    rows: [header, ...rows],
  });
};

// `standard` is aiReviewStandard.js#getStandard's presented row.
async function generateStandardDoc(standard) {
  const content = standard.content;
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: content.title || "乡土课程 AI 点评评分标准", bold: true, size: 36 })],
    }),
    para(versionLine(standard), { alignment: AlignmentType.CENTER, size: 18, color: MUTED, after: 240 }),
  ];
  if (standard.changeNote) children.push(labeled("修订说明", standard.changeNote));
  if (content.overview) children.push(para(content.overview, { after: 200 }));
  children.push(buildTable(content.dimensions || []));
  if (Array.isArray(content.scoringNotes) && content.scoringNotes.length > 0) {
    children.push(heading("评分说明"));
    content.scoringNotes.forEach((n) => children.push(para(n, { bullet: true })));
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { size: 21, font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "宋体" } } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

module.exports = { generateStandardDoc };
