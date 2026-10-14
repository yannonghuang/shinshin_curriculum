// 课外读物推荐 -> .xlsx / .docx, for the page's 导出 buttons. Rendered on
// demand from a finished run (bookRecommendation.js#getRun), never stored.
const ExcelJS = require("exceljs");
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
} = require("docx");

const DECISION_LABELS = { recommend: "推荐", exclude: "不推荐", review: "待人工复核" };
const ratingText = (b) => (b.rating !== null && b.rating !== undefined ? `${b.rating}（${b.ratingCount || 0}人）` : "");
const isbnText = (b) => `${b.isbn || ""}${b.isbnMismatch && b.foundIsbn ? `（检索到新ISBN ${b.foundIsbn}）` : ""}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("zh-CN") : "");

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

async function buildWorkbook(run) {
  const wb = new ExcelJS.Workbook();
  const addSheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map(([header, key, width]) => ({ header, key, width }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    rows.forEach((r) => ws.addRow(r));
    ws.eachRow((row) => (row.alignment = { vertical: "top", wrapText: true }));
  };
  const bookCols = [
    ["书名", "title", 30],
    ["ISBN", "isbn", 22],
    ["作者", "author", 20],
    ["出版社", "publisher", 20],
    ["出版年", "year", 10],
    ["豆瓣评分", "rating", 14],
  ];
  const bookRow = (b) => ({ title: b.title, isbn: isbnText(b), author: b.author, publisher: b.publisher, year: b.year, rating: ratingText(b) });

  const recommended = run.result.stages.flatMap((s) => s.books.map((b, i) => ({ stage: s.label, no: i + 1, ...bookRow(b), reason: b.reason })));
  addSheet("推荐书目", [["学段", "stage", 20], ["序号", "no", 6], ...bookCols, ["推荐理由", "reason", 50]], recommended);
  addSheet(
    "不推荐",
    [...bookCols, ["依据条款", "rule", 10], ["原因", "reason", 50]],
    run.result.excluded.map((b) => ({ ...bookRow(b), rule: b.rule, reason: b.reason }))
  );
  addSheet("待人工复核", [...bookCols, ["说明", "reason", 50]], run.result.review.map((b) => ({ ...bookRow(b), reason: b.reason })));

  if (run.guidance) {
    const c = run.guidance.content;
    const rows = [
      ...c.documents.map((d) => ({ type: "依据文件", text: `${d.level ? `[${d.level}] ` : ""}《${d.title}》${d.issuer ? ` ${d.issuer}` : ""}${d.year ? ` ${d.year}` : ""}` })),
      ...c.redLines.map((r, i) => ({ type: `红线 R${i + 1}`, text: r })),
      ...c.principles.map((p) => ({ type: "推荐原则", text: p })),
      ...c.localNotes.map((n) => ({ type: "本省要求", text: n })),
    ];
    addSheet("依据规定", [["类别", "type", 14], ["内容", "text", 100]], rows);
  }
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

const TABLE_WIDTH = 9600;
const border = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
const borders = { top: border, bottom: border, left: border, right: border };

const para = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: opts.after === undefined ? 80 : opts.after },
    alignment: opts.alignment,
    heading: opts.heading,
    children: [new TextRun({ text: text || "", bold: opts.bold, size: opts.size, color: opts.color })],
  });

const cell = (text, width, header = false) =>
  new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    shading: header ? { type: ShadingType.CLEAR, fill: "E7EFE9", color: "auto" } : undefined,
    children: String(text || "")
      .split("\n")
      .map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: header, size: 20 })] })),
  });

const table = (headers, ratios, rows) => {
  const total = ratios.reduce((a, b) => a + b, 0);
  const widths = ratios.map((r) => Math.floor((TABLE_WIDTH * r) / total));
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, widths[i], true)) }),
      ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, widths[i])) })),
    ],
  });
};

const bookLine = (b) => [b.title, b.author && `作者：${b.author}`, b.publisher && `${b.publisher}${b.year ? ` ${b.year}` : ""}`, b.isbn && `ISBN ${isbnText(b)}`].filter(Boolean).join("\n");

async function buildDocument(run) {
  const children = [
    para(`${run.schoolName}课外读物推荐书目`, { heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, after: 200 }),
    para(
      `省份：${run.province}　学段：${run.result.stages.map((s) => s.label).join("、")}　生成日期：${fmtDate(run.finishedAt || run.createdAt)}`,
      { color: "666666", alignment: AlignmentType.CENTER }
    ),
    para(
      `共检查 ${run.result.counts.total} 本：推荐 ${run.result.counts.recommended} 本，不推荐 ${run.result.counts.excluded} 本，待人工复核 ${run.result.counts.review} 本。` +
        "本书目由 AI 依据教育主管部门的课外读物进校园规定检索与评估生成，正式使用前请人工审核。",
      { color: "666666", after: 240 }
    ),
  ];

  run.result.stages.forEach((s) => {
    children.push(para(`${s.label}（${s.books.length} 本）`, { heading: HeadingLevel.HEADING_1 }));
    if (s.books.length === 0) children.push(para("无", { color: "666666" }));
    else children.push(table(["序号", "图书", "豆瓣评分", "推荐理由"], [6, 38, 12, 44], s.books.map((b, i) => [String(i + 1), bookLine(b), ratingText(b), b.reason])));
    children.push(para("", { after: 120 }));
  });

  if (run.result.excluded.length) {
    children.push(para(`附一：不推荐（${run.result.excluded.length} 本）`, { heading: HeadingLevel.HEADING_1 }));
    children.push(table(["图书", "依据条款", "原因"], [40, 12, 48], run.result.excluded.map((b) => [bookLine(b), b.rule, b.reason])));
    children.push(para("", { after: 120 }));
  }
  if (run.result.review.length) {
    children.push(para(`附二：待人工复核（${run.result.review.length} 本）`, { heading: HeadingLevel.HEADING_1 }));
    children.push(table(["图书", "说明"], [45, 55], run.result.review.map((b) => [bookLine(b), b.reason])));
    children.push(para("", { after: 120 }));
  }
  if (run.guidance) {
    const c = run.guidance.content;
    children.push(para("附三：依据规定", { heading: HeadingLevel.HEADING_1 }));
    c.documents.forEach((d) => children.push(para(`${d.level ? `[${d.level}] ` : ""}《${d.title}》${d.issuer ? ` ${d.issuer}` : ""}${d.year ? ` ${d.year}` : ""}`)));
    children.push(para("禁止进校园的情形：", { bold: true }));
    c.redLines.forEach((r, i) => children.push(para(`R${i + 1}. ${r}`)));
    if (c.localNotes.length) {
      children.push(para("本省特别要求：", { bold: true }));
      c.localNotes.forEach((n) => children.push(para(`· ${n}`)));
    }
    children.push(para(`（规定检索于 ${fmtDate(run.guidance.fetchedAt)}）`, { color: "666666" }));
  }

  const doc = new Document({ sections: [{ properties: { page: { margin: { top: 1200, bottom: 1200, left: 1100, right: 1100 } } }, children }] });
  return Packer.toBuffer(doc);
}

module.exports = { buildWorkbook, buildDocument, DECISION_LABELS };
