// Sets req.lang ("zh" | "en") and translates JSON response messages for
// English requests -- see app/i18n/index.js. Wraps res.json, which
// res.send(object) also goes through.
const { translateBody, detectLang } = require("../i18n");

module.exports = function lang(req, res, next) {
  req.lang = detectLang(req);
  if (req.lang !== "zh") {
    const json = res.json.bind(res);
    res.json = (body) => json(translateBody(body, req.lang));
  }
  next();
};
