const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  ExternalHyperlink,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  LevelFormat,
} = require("docx");
const { Marked } = require("marked");

// On-the-fly export of a 欣欣小助手 transcript (all of a conversation, or the
// messages the teacher ticked) as Word (.docx), Markdown (.md), or a
// printable HTML page the panel prints to PDF. Nothing is stored -- each
// request renders from chat_messages/chat_attachments as they are.
//
// Assistant replies are Markdown (the panel renders them with react-markdown
// + remark-gfm), so .docx goes through marked's lexer and maps its tokens to
// docx paragraphs/runs/tables; .md is the content as-is; HTML is marked's own
// renderer with raw HTML escaped (see htmlMarked below).

const ROLE_NAMES = { user: "我", assistant: "欣欣小助手" };
const ACTION_STATUS_LABELS = { pending: "待确认", confirmed: "已执行", cancelled: "已取消", failed: "执行失败" };

// Same zone the users are in -- the server/container runs in UTC.
const formatTime = (date) =>
  new Date(date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

// The 待确认/已执行 action cards and 参考资料 footer the panel shows under an
// assistant reply -- same derivation as copilot-panel.component.js's
// renderActions/renderCitations, flattened to text lines.
const actionLines = (message) =>
  (Array.isArray(message.retrievedChunkIds) ? message.retrievedChunkIds : [])
    .filter((e) => e && e.output && e.output.pendingConfirmation)
    .map((e) => `操作（${ACTION_STATUS_LABELS[e.output.status] || e.output.status}）：${e.output.summary}`);

const citationLine = (message) => {
  const log = Array.isArray(message.retrievedChunkIds) ? message.retrievedChunkIds : [];
  const titles = log.flatMap((call) => {
    const out = call && call.output;
    if (out && Array.isArray(out.sources)) return out.sources.map((s) => `《${s.title}》${s.locator || ""}`);
    return [];
  });
  return titles.length > 0 ? `参考资料：${[...new Set(titles)].join("、")}` : null;
};

// Normalizes what every format renders from: { title, subtitle, exportedAt,
// entries: [{ role, time, content, attachments, actions, citations }] }.
function buildTranscript({ title, subtitle, messages, attachmentsByMessage }) {
  return {
    title,
    subtitle,
    exportedAt: formatTime(new Date()),
    entries: messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        time: formatTime(m.createdAt),
        content: m.content || "",
        attachments: attachmentsByMessage.get(m.id) || [],
        actions: m.role === "assistant" ? actionLines(m) : [],
        citations: m.role === "assistant" ? citationLine(m) : null,
      })),
  };
}

// ------------------------------------------------------------------
// Markdown
// ------------------------------------------------------------------
function toMarkdown(t) {
  const out = [`# ${t.title}`, ""];
  if (t.subtitle) out.push(`> ${t.subtitle}`);
  out.push(`> 导出时间：${t.exportedAt}`, "");
  for (const e of t.entries) {
    out.push("---", "", `### ${ROLE_NAMES[e.role]} · ${e.time}`, "");
    // A user's own text is plain text, not Markdown -- keep its line breaks.
    out.push(e.role === "user" ? e.content.split("\n").join("  \n") : e.content, "");
    for (const a of e.attachments) out.push(`> 📎 附件${a.kind === "image" ? "图片" : "文件"}：${a.name}`);
    if (e.attachments.length) out.push("");
    for (const line of e.actions) out.push(`> ${line}`);
    if (e.citations) out.push(`> ${e.citations}`);
    if (e.actions.length || e.citations) out.push("");
  }
  return out.join("\n");
}

// ------------------------------------------------------------------
// HTML (printed to PDF by the panel)
// ------------------------------------------------------------------
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Raw HTML inside a reply is shown as text, never rendered, and only
// http(s)/mailto links survive -- a reply can echo content from an uploaded
// file, which nobody vetted.
const SAFE_HREF = /^(https?:|mailto:)/i;
const htmlMarked = new Marked({ gfm: true, breaks: false });
htmlMarked.use({
  renderer: {
    html(token) {
      return escapeHtml(typeof token === "string" ? token : token.text || token.raw || "");
    },
    link(href, title, text) {
      const h = typeof href === "object" ? href.href : href;
      const label = typeof href === "object" ? escapeHtml(href.text) : text;
      return SAFE_HREF.test(h || "") ? `<a href="${escapeHtml(h)}">${label}</a>` : label;
    },
    image(href, title, text) {
      return escapeHtml(typeof href === "object" ? href.text : text || "");
    },
  },
});

const HTML_STYLE = `
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; color: #222; line-height: 1.6; max-width: 760px; margin: 24px auto; padding: 0 16px; }
  h1.doc-title { font-size: 22px; text-align: center; margin-bottom: 4px; }
  .doc-meta { text-align: center; color: #666; font-size: 13px; margin-bottom: 24px; }
  .entry { border-top: 1px solid #ddd; padding: 12px 0; break-inside: avoid-page; }
  .entry-head { font-weight: 600; color: #444; font-size: 13px; margin-bottom: 6px; }
  .entry-user .entry-head { color: #1f6feb; }
  .entry-body { font-size: 14px; }
  .entry-user .entry-body { white-space: pre-wrap; }
  .entry-body table { border-collapse: collapse; margin: 8px 0; }
  .entry-body th, .entry-body td { border: 1px solid #bbb; padding: 4px 8px; }
  .entry-body pre { background: #f5f5f5; padding: 8px; white-space: pre-wrap; }
  .entry-body blockquote { border-left: 3px solid #ccc; margin: 8px 0; padding-left: 10px; color: #555; }
  .entry-attachment { font-size: 12px; color: #555; margin-top: 6px; }
  .entry-attachment img { display: block; max-width: 100%; max-height: 360px; margin-top: 4px; border: 1px solid #ddd; }
  .entry-note { font-size: 12px; color: #777; margin-top: 4px; }
  @media print { body { margin: 0 auto; } }
`;

function toHtml(t) {
  const entries = t.entries
    .map((e) => {
      const body = e.role === "assistant" ? htmlMarked.parse(e.content) : escapeHtml(e.content);
      const attachments = e.attachments
        .map((a) => {
          const img =
            a.kind === "image" && a.imageData
              ? `<img src="data:${escapeHtml(a.mime || "image/png")};base64,${Buffer.from(a.imageData).toString("base64")}" alt="">`
              : "";
          return `<div class="entry-attachment">📎 附件${a.kind === "image" ? "图片" : "文件"}：${escapeHtml(a.name)}${img}</div>`;
        })
        .join("");
      const notes = [...e.actions, ...(e.citations ? [e.citations] : [])]
        .map((line) => `<div class="entry-note">${escapeHtml(line)}</div>`)
        .join("");
      return (
        `<section class="entry entry-${e.role}">` +
        `<div class="entry-head">${ROLE_NAMES[e.role]} · ${escapeHtml(e.time)}</div>` +
        `<div class="entry-body">${body}</div>${attachments}${notes}</section>`
      );
    })
    .join("\n");
  return (
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(t.title)}</title>` +
    `<style>${HTML_STYLE}</style></head><body>` +
    `<h1 class="doc-title">${escapeHtml(t.title)}</h1>` +
    `<div class="doc-meta">${t.subtitle ? `${escapeHtml(t.subtitle)} · ` : ""}导出时间：${escapeHtml(t.exportedAt)}</div>` +
    `${entries}</body></html>`
  );
}

// ------------------------------------------------------------------
// Word (.docx)
// ------------------------------------------------------------------
const MONO_FONT = "Consolas";
const SEGMENT_SPACING = { after: 120 };
// Message-level headings are H2 (see toDocx), so a reply's own "# …" starts
// one level below that.
const DOCX_HEADINGS = [
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];
// Usable page width at docx's default A4 portrait margins, in pixels at 96dpi
// -- images wider than this are scaled down to fit.
const MAX_IMAGE_WIDTH_PX = 600;
const DOCX_IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/bmp"];

const docxLexer = new Marked({ gfm: true });

// marked's inline tokens -> TextRun/ExternalHyperlink children, carrying
// bold/italic/strike/code down through nesting.
function inlineRuns(tokens, style = {}) {
  const runs = [];
  for (const tok of tokens || []) {
    switch (tok.type) {
      case "strong":
        runs.push(...inlineRuns(tok.tokens, { ...style, bold: true }));
        break;
      case "em":
        runs.push(...inlineRuns(tok.tokens, { ...style, italics: true }));
        break;
      case "del":
        runs.push(...inlineRuns(tok.tokens, { ...style, strike: true }));
        break;
      case "codespan":
        runs.push(new TextRun({ ...style, text: decodeEntities(tok.text), font: MONO_FONT }));
        break;
      case "br":
        runs.push(new TextRun({ ...style, text: "", break: 1 }));
        break;
      case "link":
        if (SAFE_HREF.test(tok.href || "")) {
          runs.push(
            new ExternalHyperlink({
              link: tok.href,
              children: inlineRuns(tok.tokens, { ...style, style: "Hyperlink" }),
            })
          );
        } else {
          runs.push(...inlineRuns(tok.tokens, style));
        }
        break;
      case "text":
        if (tok.tokens && tok.tokens.length) runs.push(...inlineRuns(tok.tokens, style));
        else runs.push(new TextRun({ ...style, text: decodeEntities(tok.text) }));
        break;
      default:
        // escape, html, image alt text, anything unknown: show as plain text
        runs.push(new TextRun({ ...style, text: decodeEntities(tok.text || tok.raw || "") }));
    }
  }
  return runs;
}

// marked's lexer keeps text HTML-escaped (&amp; &lt; &quot; &#39;) -- Word
// needs the literal characters back.
const decodeEntities = (s) =>
  String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const cellBorders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
};

// A standalone document (generate_document's source=content) starts its own
// "# …" at Heading 1 -- nothing sits above it.
const DOCUMENT_HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

// Ordered lists restart at 1 for each list -- docx numbering instances do
// that, one per <ol> encountered across the whole document.
function createDocxBuilder(headings = DOCX_HEADINGS) {
  let olInstance = 0;

  const blocks = (tokens, ctx = { listLevel: -1 }) => {
    const out = [];
    for (const tok of tokens || []) {
      switch (tok.type) {
        case "space":
          break;
        case "heading":
          out.push(
            new Paragraph({
              heading: headings[Math.min(tok.depth, headings.length) - 1],
              children: inlineRuns(tok.tokens),
            })
          );
          break;
        case "paragraph":
          out.push(new Paragraph({ children: inlineRuns(tok.tokens), spacing: SEGMENT_SPACING }));
          break;
        case "text":
          // A "tight" list item's body -- inline content without a paragraph.
          out.push(new Paragraph({ children: inlineRuns(tok.tokens || [tok]), spacing: SEGMENT_SPACING }));
          break;
        case "code":
          for (const line of tok.text.split("\n")) {
            out.push(
              new Paragraph({
                children: [new TextRun({ text: line, font: MONO_FONT, size: 20 })],
                shading: { type: ShadingType.CLEAR, fill: "F3F3F3", color: "auto" },
              })
            );
          }
          out.push(new Paragraph({ text: "", spacing: SEGMENT_SPACING }));
          break;
        case "blockquote":
          for (const p of blocks(tok.tokens, ctx)) out.push(p);
          break;
        case "hr":
          out.push(
            new Paragraph({
              text: "",
              border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 } },
              spacing: SEGMENT_SPACING,
            })
          );
          break;
        case "list": {
          const level = Math.min(ctx.listLevel + 1, 8);
          const instance = tok.ordered ? ++olInstance : null;
          for (const item of tok.items) {
            // First block of the item carries the bullet/number; any further
            // blocks (a second paragraph, a nested list) follow unmarked.
            const itemBlocks = item.tokens.filter((t) => t.type !== "list" && t.type !== "space");
            const nested = item.tokens.filter((t) => t.type === "list");
            const [first, ...rest] = itemBlocks;
            const firstRuns = first ? inlineRuns(first.tokens || [first]) : [];
            if (item.task) firstRuns.unshift(new TextRun({ text: item.checked ? "☑ " : "☐ " }));
            out.push(
              new Paragraph({
                children: firstRuns,
                ...(tok.ordered
                  ? { numbering: { reference: "copilot-ol", level, instance } }
                  : { bullet: { level } }),
              })
            );
            for (const p of blocks(rest, { listLevel: level })) out.push(p);
            for (const p of blocks(nested, { listLevel: level })) out.push(p);
          }
          out.push(new Paragraph({ text: "", spacing: { after: 60 } }));
          break;
        }
        case "table": {
          const row = (cells, header) =>
            new TableRow({
              tableHeader: header,
              children: cells.map(
                (c) =>
                  new TableCell({
                    borders: cellBorders,
                    shading: header ? { type: ShadingType.CLEAR, fill: "EDEDED", color: "auto" } : undefined,
                    children: [new Paragraph({ children: inlineRuns(c.tokens, header ? { bold: true } : {}) })],
                  })
              ),
            });
          out.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: [row(tok.header, true), ...tok.rows.map((r) => row(r, false))],
            })
          );
          out.push(new Paragraph({ text: "", spacing: SEGMENT_SPACING }));
          break;
        }
        default:
          if (tok.text || tok.raw) out.push(new Paragraph({ text: decodeEntities(tok.text || tok.raw) }));
      }
    }
    return out;
  };

  return { blocks };
}

const noteParagraph = (text) =>
  new Paragraph({ children: [new TextRun({ text, size: 18, color: "777777" })], spacing: { after: 60 } });

function imageParagraphs(a) {
  if (!a.imageData || !DOCX_IMAGE_MIMES.includes((a.mime || "").toLowerCase())) return [];
  let width = a.width || MAX_IMAGE_WIDTH_PX;
  let height = a.height || Math.round(width * 0.75);
  if (width > MAX_IMAGE_WIDTH_PX) {
    height = Math.round((height * MAX_IMAGE_WIDTH_PX) / width);
    width = MAX_IMAGE_WIDTH_PX;
  }
  return [
    new Paragraph({
      children: [new ImageRun({ data: Buffer.from(a.imageData), transformation: { width, height } })],
      spacing: SEGMENT_SPACING,
    }),
  ];
}

const titleParagraph = (text) =>
  new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, bold: true, size: 40 })],
  });

const ORDERED_LIST_NUMBERING = {
  config: [
    {
      reference: "copilot-ol",
      levels: Array.from({ length: 9 }, (_, level) => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: 420 * (level + 1), hanging: 360 } } },
      })),
    },
  ],
};

async function toDocx(t) {
  const { blocks } = createDocxBuilder();
  const children = [
    titleParagraph(t.title),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: `${t.subtitle ? `${t.subtitle} · ` : ""}导出时间：${t.exportedAt}`, size: 18, color: "666666" }),
      ],
      spacing: { after: 300 },
    }),
  ];

  for (const e of t.entries) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: `${ROLE_NAMES[e.role]} · ${e.time}` }));
    if (e.role === "user") {
      // Plain text, line breaks preserved -- not parsed as Markdown.
      const lines = e.content.split("\n");
      children.push(
        new Paragraph({
          children: lines.map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : 0 })),
          spacing: SEGMENT_SPACING,
        })
      );
    } else {
      children.push(...blocks(docxLexer.lexer(e.content)));
    }
    for (const a of e.attachments) {
      children.push(noteParagraph(`📎 附件${a.kind === "image" ? "图片" : "文件"}：${a.name}`));
      if (a.kind === "image") children.push(...imageParagraphs(a));
    }
    for (const line of e.actions) children.push(noteParagraph(line));
    if (e.citations) children.push(noteParagraph(e.citations));
  }

  const doc = new Document({ numbering: ORDERED_LIST_NUMBERING, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ------------------------------------------------------------------
// Standalone documents -- a Markdown body 欣欣小助手 wrote itself via
// generate_document (source=content), e.g. a discussion organized into a
// proposal. Same Markdown handling as a reply, minus the transcript framing.
// ------------------------------------------------------------------
// The tool asks for the body without its title, but the model often opens
// with "# <title>" anyway -- drop that heading rather than print the title
// twice. Compared loosely (spaces and 《》 brackets ignored).
const normalizeTitle = (s) => String(s || "").replace(/[\s《》"“”]/g, "");
const stripLeadingTitle = (title, content) => {
  const body = String(content || "").replace(/^\s+/, "");
  const match = /^#{1,2}\s+(.+)\n?/.exec(body);
  return match && title && normalizeTitle(match[1]) === normalizeTitle(title) ? body.slice(match[0].length) : body;
};

async function documentToDocx({ title, content: rawContent }) {
  const content = stripLeadingTitle(title, rawContent);
  const { blocks } = createDocxBuilder(DOCUMENT_HEADINGS);
  const children = [...(title ? [titleParagraph(title)] : []), ...blocks(docxLexer.lexer(content || ""))];
  const doc = new Document({ numbering: ORDERED_LIST_NUMBERING, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

const documentToMarkdown = ({ title, content }) =>
  title ? `# ${title}\n\n${stripLeadingTitle(title, content)}` : content || "";

const documentToHtml = ({ title, content: rawContent }) => {
  const content = stripLeadingTitle(title, rawContent);
  return (
  `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title || "文档")}</title>` +
  `<style>${HTML_STYLE}</style></head><body>` +
  `${title ? `<h1 class="doc-title">${escapeHtml(title)}</h1>` : ""}` +
  `<div class="entry-body">${htmlMarked.parse(content || "")}</div></body></html>`
  );
};

module.exports = { buildTranscript, toMarkdown, toHtml, toDocx, documentToDocx, documentToMarkdown, documentToHtml };
