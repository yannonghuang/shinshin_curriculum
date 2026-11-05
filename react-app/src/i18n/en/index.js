// English UI strings, keyed by the Chinese source text (see ./index.js).
// Split by page area only to keep each file reviewable; a later part wins on
// a duplicate key.
import p1 from "./part1";
import p2 from "./part2";
import p3 from "./part3";
import p4 from "./part4";
import p5 from "./part5";
import p6 from "./part6";

export default { ...p1, ...p2, ...p3, ...p4, ...p5, ...p6 };
