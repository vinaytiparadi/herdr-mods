// A small line-by-line highlighter for diff rows. The Before/After tabs use the
// editor's full one; this only has to make a diff readable at a glance.

const SLASH = "js jsx ts tsx mjs cjs mts cts java kt kts scala groovy gradle go c h cc cpp cxx hpp hh cs swift dart php m mm proto zig smithy fs sc";
const HASH = "py pyi rb sh bash zsh fish ps1 pl r mk cmake dockerfile nix ex exs coffee";
const KEYVALUE = "yaml yml toml ini cfg conf properties env";
const DASH = "sql lua hs elm";
const MARKUP = "html htm xml xhtml svg vue svelte plist";
const BLOCK = "css scss less";
const NO_COMMENT = "json";

const family = {};
for (const [list, name] of [[SLASH, "slash"], ["rs", "rust"], [HASH, "hash"], [KEYVALUE, "keyvalue"], [DASH, "dash"],
  [MARKUP, "markup"], [BLOCK, "block"], [NO_COMMENT, "data"]]) for (const ext of list.split(" ")) family[ext] = name;

const STYLE = {
  slash: { line: "//", block: ["/*", "*/"], quotes: "\"'`" },
  // Rust: 'a is a lifetime, so only 'x' and '\n' are quoted.
  rust: { line: "//", block: ["/*", "*/"], quotes: "\"", chars: true },
  hash: { line: "#", quotes: "\"'`", triple: true },
  keyvalue: { line: "#", quotes: "\"'", keys: true },
  dash: { line: "--", block: ["/*", "*/"], quotes: "\"'" },
  markup: { block: ["<!--", "-->"], quotes: "\"'", tags: true },
  block: { block: ["/*", "*/"], quotes: "\"'" },
  data: { quotes: "\"" },
  plain: { quotes: "\"" },
};

const KEYWORDS = new Set(`abstract and as assert async await break case catch class const continue def default defer
del delete do done elif else end enum esac except export extends extern fi final finally fn for foreach from func
function go goto if impl implements import in instanceof interface is lambda let local loop match mod module mut
namespace new not of or override package pass private protected pub public raise readonly ref return select static
struct super switch then throw throws trait try type typeof union unless unsafe until use using val var virtual
when where while with yield`.split(/\s+/));
const TYPES = new Set(`int long short float double char byte bool boolean string str void usize isize u8 u16 u32 u64
u128 i8 i16 i32 i64 i128 f32 f64 any number unknown never object dict list tuple set`.split(/\s+/));
const CONSTANTS = new Set("true false null nil none None True False undefined NaN this self Self".split(" "));

const IDENT = /[A-Za-z_$][\w$]*/y, NUMBER = /0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z]*/y;
const CHAR = /'(?:\\[^']{1,10}|[^\\'])'/y, KEY = /^(\s*-?\s*)([\w.\-]+|"[^"]*"|'[^']*')(\s*[:=])/, TAG = /<\/?[A-Za-z][\w:.-]*/y;

/** The highlighting family for a file name. */
export function languageOf(path) {
  const name = path.split("/").pop().toLowerCase();
  if (name === "dockerfile" || name === "makefile") return "hash";
  if (name === "config" || name.startsWith(".")) return "hash";
  return family[name.includes(".") ? name.split(".").pop() : ""] ?? "plain";
}

/**
 * Splits one line into [{ t: text, c: class | null }], classes being keyword, string, comment,
 * number, function, type and constant. `open` carries an unfinished block comment or triple
 * string from the line before (its closing text), and the result's `open` carries it on.
 */
export function highlight(line, lang, open = null) {
  const s = STYLE[lang] ?? STYLE.plain, out = [];
  let plain = "", i = 0;
  const push = (t, c) => {
    if (!t) return;
    if (!c) { plain += t; return; }
    if (plain) { out.push({ t: plain, c: null }); plain = ""; }
    out.push({ t, c });
  };
  const at = (text) => line.startsWith(text, i);
  const until = (close, c) => {
    const end = line.indexOf(close, i);
    if (end < 0) { push(line.slice(i), c); i = line.length; return close; }
    push(line.slice(i, end + close.length), c); i = end + close.length; return null;
  };
  if (open) open = until(open.close, open.c) ? open : null;
  if (!open && s.keys && i === 0) {
    const m = KEY.exec(line);
    if (m) { push(m[1], null); push(m[2], "function"); push(m[3], null); i = m[0].length; }
  }
  while (i < line.length) {
    const ch = line[i];
    if (s.line && at(s.line) && (s.line !== "#" || i === 0 || /\s/.test(line[i - 1]))) { push(line.slice(i), "comment"); break; }
    if (s.block && at(s.block[0])) {
      push(s.block[0], "comment"); i += s.block[0].length;
      if (until(s.block[1], "comment")) { open = { close: s.block[1], c: "comment" }; break; }
      continue;
    }
    if (s.triple && (at('"""') || at("'''"))) {
      const q = line.slice(i, i + 3);
      push(q, "string"); i += 3;
      if (until(q, "string")) { open = { close: q, c: "string" }; break; }
      continue;
    }
    if (s.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      // An unclosed quote is an apostrophe or a lifetime, not a string.
      if (j < line.length) { push(line.slice(i, j + 1), "string"); i = j + 1; continue; }
    }
    if (s.chars && ch === "'") {
      CHAR.lastIndex = i;
      const m = CHAR.exec(line);
      if (m) { push(m[0], "string"); i += m[0].length; continue; }
    }
    if (s.tags && ch === "<") {
      TAG.lastIndex = i;
      const m = TAG.exec(line);
      if (m) { push(m[0], "keyword"); i += m[0].length; continue; }
    }
    if (ch >= "0" && ch <= "9") {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(line);
      push(m[0], "number"); i += m[0].length; continue;
    }
    IDENT.lastIndex = i;
    const id = IDENT.exec(line);
    if (id) {
      const w = id[0], after = line.slice(i + w.length).trimStart()[0];
      const c = s.tags || lang === "data" || lang === "plain" ? (CONSTANTS.has(w) ? "constant" : null)
        : KEYWORDS.has(w) ? "keyword" : CONSTANTS.has(w) ? "constant" : TYPES.has(w) ? "type"
        : after === "(" ? "function" : /^[A-Z][a-z0-9]\w*$/.test(w) ? "type" : /^[A-Z][A-Z0-9_]+$/.test(w) ? "constant" : null;
      push(w, c); i += w.length; continue;
    }
    push(ch, null); i++;
  }
  if (plain) out.push({ t: plain, c: null });
  return { parts: out, open };
}
