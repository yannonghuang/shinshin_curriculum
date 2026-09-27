const dashboard = require("../services/dashboard");

// GET /api/dashboard -- every plan's dashboard row plus the Excel export's
// selectable fields.
exports.list = async (req, res) => {
  try {
    const rows = await dashboard.buildRows();
    return res.send({ rows, exportFields: dashboard.exportFieldOptions() });
  } catch (err) {
    return res.status(500).send({ message: err.message || "加载数据看板时发生错误。" });
  }
};

// POST /api/dashboard/export { planIds, fields, origin } -- .xlsx of the
// given plans (in that order) with the given columns. `origin` is the
// browser's own, for the optional 课程链接 column.
exports.exportExcel = async (req, res) => {
  try {
    const { planIds, fields, origin } = req.body || {};
    const buffer = await dashboard.buildWorkbook({
      planIds,
      fieldKeys: fields,
      origin: typeof origin === "string" && /^https?:\/\/[^/\s]+$/.test(origin) ? origin : "",
    });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="dashboard.xlsx"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "导出 Excel 时发生错误。" });
  }
};
