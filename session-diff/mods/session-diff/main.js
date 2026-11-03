// Diff: what changed in the focused pane's text files since a baseline, git repo or not.
// Baselines are copies kept on the folder's machine (snapshot.sh), taken the first time this panel
// sees the folder and whenever "New baseline" is clicked. A folder keeps its history of them.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, closeOverlay, appHome, nextCommand, window } from "herdr";
import { highlight, languageOf } from "./highlight.js";


const ROW = 20, MAX_LINES = 3000;
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const SYNTAX = { keyword: "ansi5", string: "ansi2", comment: "dim", function: "ansi4", type: "ansi3", number: "ansi1", constant: "ansi6" };
const zoom = () => Number(settings().zoom) || 1;
// A theme color at alpha `a` (two hex digits); theme colors may already carry one (#rrggbbaa).
const alpha = (c, a) => (c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c.slice(0, 7)) + a;
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const VIEWS = [["diff", "Diff"], ["before", "Before"], ["after", "After"]];
const ALL = "\0all";   // this.open for "All changes", every file's diff in one

// snapshot.sh runs on the folder's machine, with baseline.py's code for python3 to run there.
let script = null, code = null;
async function run(loc, action, id) {
  script ??= await readTextFile(`${appHome()}/mods/session-diff/snapshot.sh`);
  code ??= (await readTextFile(`${appHome()}/mods/session-diff/baseline.py`)) ?? "";
  if (!script) throw new Error("mods/session-diff/snapshot.sh is missing");
  return exec("sh", ["-c", script, "session-diff", loc.cwd, action, id ?? "", code], { on: loc.on });
}

const change = (f) => ({ status: f[0], add: Number(f[1]) || 0, del: Number(f[2]) || 0, binary: f[1] === "-", path: f.slice(3).join("\t").replace(/^\.\//, "") });
const byPath = (a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase());

// Every baseline compared with the folder in one go: id -> { id, snap, taken, total, changes }.
async function survey(loc) {
  const r = await run(loc, "survey");
  const out = new Map(), taken = {};
  let home = "", cur = null;
  for (const line of r.stdout.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "base") taken[f[1]] = Number(f[2]) * 1000;
    else if (f[0] === "home") home = f[1];
    else if (f[0] === "id") out.set(f[1], cur = { id: f[1], snap: `${home}/${f[1]}`, taken: taken[f[1]], total: 0, changes: [] });
    else if (f[0] === "total" && cur) cur.total = Number(f[1]);
    else if (cur && (f[0] === "A" || f[0] === "D" || f[0] === "M")) cur.changes.push(change(f));
  }
  for (const v of out.values()) v.changes.sort(byPath);
  return out;
}

async function snapshot(loc, action, id) {
  const r = await run(loc, action, id);
  const out = { changes: [], total: 0, bases: [] };
  for (const line of r.stdout.split("\n")) {
    const [kind, ...f] = line.split("\t");
    if (kind === "snap") out.snap = f.join("\t");
    else if (kind === "base") out.bases.push({ id: f[0], taken: Number(f[1]) * 1000, files: Number(f[2]) || 0 });
    else if (kind === "id") out.id = f[0];
    else if (kind === "taken") out.taken = Number(f[0]) * 1000;
    else if (kind === "none") out.none = true;
    else if (kind === "error") out.error = f.join("\t");
    else if (kind === "total") out.total = Number(f[0]);
    else if (kind === "A" || kind === "D" || kind === "M") out.changes.push(change([kind, ...f]));
  }
  if (r.code !== 0 && !out.error) out.error = r.stderr.trim() || `snapshot.sh exited ${r.code}`;
  return out;
}

// Side by side: a hunk's removed and added lines face each other; context sits on both sides.
function pair(rows) {
  const out = [];
  let dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = []; adds = [];
  };
  for (const r of rows) {
    if (r.kind === "-") dels.push(r);
    else if (r.kind === "+") adds.push(r);
    else { flush(); out.push(r.kind === " " ? { kind: "pair", left: r, right: r } : r); }
  }
  flush();
  return out;
}

// A display column (a tab shows as four) to an index in the line's own text.
function rawAt(raw, col) {
  let w = 0;
  for (let k = 0; k < raw.length; k++) { if (w >= col) return k; w += raw[k] === "\t" ? 4 : 1; }
  return raw.length;
}

// When a baseline was taken, for the history list: "Oct 29 23:17:05 · 12 min ago".
function stamp(ms) {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0"), m = Math.round((Date.now() - ms) / 60000);
  const ago = m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} · ${ago}`;
}

function since(ms) {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0"), time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

export default class SessionDiff extends View {
  init(_props, cx) {
    this.changes = []; this.rows = []; this.view = "diff"; this.size = null; this.top = 0; this.left = 0; this.viewH = 0; this.viewW = 0;
    this.charW = 7.2; this.digits = 1; this.longest = 0;
    this.handle = cx.focus_handle();
    this.split = localStorage.getItem("split") === "1";
    if (props()?.overlay) cx.timer.after(50, () => this.handle.focus());
    this.refresh(cx);
    // keys.json: "session-diff.next" / "prev" / "diff" / "before" / "after" / "baseline" / "all" / "split" / "copy" / "copy-patch" / "history" / "everything" (All changes) / "older" / "newer" (baselines).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1, cx);
        else if (VIEWS.some(([v]) => v === c)) this.show(c, cx);
        else if (c === "baseline") this.rebase(cx);
        else if (c === "all") this.selectAll(cx);
        else if (c === "split") this.toggleSplit(cx);
        else if (c === "history") { this.history = !this.history; this.deleting = null; if (this.history) this.surveyAll(cx); }
        else if (c === "everything" && this.changes.length) this.select(ALL, cx);
        else if (c === "older" || c === "newer") {
          const real = this.bases.filter((b) => !b.pending), at = real.findIndex((b) => b.id === this.baseId);
          const next = real[Math.max(0, Math.min(real.length - 1, at + (c === "older" ? -1 : 1)))];
          if (next && next.id !== this.baseId) this.useBase(next.id, cx);
        }
        else if (c === "copy" || c === "copy-patch") this.copy(c === "copy-patch", cx);
        cx.notify();
      }
    });
    // Local folders are watched; another machine's are polled.
    cx.timer.every(5000, (cx) => { if (this.loc?.on || Date.now() - (this.polled ?? 0) > 30000) this.refresh(cx); });
  }

  // The folder: props' if given, else the focused terminal's. A focused mod pane (this one) keeps it.
  where() {
    const p = props() ?? {};
    if (p.folder) return { cwd: p.folder, on: p.machine ?? null };
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    if (pane && !pane.terminal) return this.loc ?? null;
    const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
    const cwd = pane?.cwd || f?.cwd || space?.folder;
    return cwd ? { cwd, on } : this.loc ?? null;
  }

  reset(loc) {
    this.loc = loc; this.context = JSON.stringify(loc); this.changes = []; this.total = 0; this.snap = null; this.taken = null;
    this.error = null; this.note = null; this.auto = false; this.none = false; this.watched = null;
    this.bases = []; this.baseId = null; this.want = null; this.history = false; this.deleting = null;
    this.cache = new Map(); this.gen = 0; this.reading = 0; this.writing = false; this.queued = []; this.after = false;
    this.select(null); this.closed = false;
  }

  // action: status, snapshot (a new baseline) or delete (baseline id). Status compares with this.want,
  // the baseline picked from the history, else the newest.
  // Writes (snapshot, delete, drop) change the history, so they go one at a time, and a read asked
  // for meanwhile follows them. Reads (status) from a click go out at once and the newest answer
  // wins; automatic ones (file changes, polling) wait for the one in flight and then go as one.
  refresh(cx, action = "status", id = null, urgent = false) {
    const loc = this.where();
    if (!loc) return;
    if (JSON.stringify(loc) !== this.context) this.reset(loc);
    const write = action !== "status";
    if (this.writing) { if (write) this.queued.push({ action, id }); else this.after = true; return; }
    if (!write && this.reading && !urgent) { this.again = true; return; }
    const context = this.context, gen = ++this.gen;
    if (write) this.writing = true; else this.reading++;
    this.polled = Date.now();
    cx.spawn(async (cx) => {
      try {
        let r = await snapshot(loc, action, write ? id : this.want);
        if (r.none && !this.auto && !r.error && action === "status") {
          this.auto = true;
          r = await snapshot(loc, "snapshot");
          if (!r.error) this.note = "Baseline saved: changes from now on show here.";
        }
        if (this.context !== context) return;
        if (action === "drop") { if (!r.error) this.bases = r.bases; return; }
        if (gen !== this.gen && !write) return;
        // A baseline that couldn't be taken: the list and the view stay as they were.
        if (action === "snapshot" && r.error) { this.note = r.error; this.bases = this.bases.filter((b) => !b.pending); this.after = true; return; }
        if (action === "snapshot") this.note = "New baseline saved.";
        if (action === "delete") this.note = r.none ? "Baseline deleted: none left, take one to compare with." : null;
        this.apply(r);
        this.watch(loc, context, cx);
        if (this.open) await this.load(context).catch((e) => { if (this.context === context) this.setRows([`Cannot show this diff: ${e?.message ?? e}`], "plain"); });
      } catch (e) { if (this.context === context) this.error = String(e?.message ?? e); }
      finally {
        if (write) this.writing = false; else this.reading--;
        cx.notify();
        if (write && this.queued.length) { const q = this.queued.shift(); this.refresh(cx, q.action, q.id); }
        else if (write) {
          if (this.after) { this.after = false; this.refresh(cx); }
          if (this.history) this.surveyAll(cx);
        } else if (this.again && !this.reading) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // Shows a result: from a refresh, or from the cache when switching baselines.
  apply(r) {
    this.bases = r.bases ?? this.bases; this.baseId = r.id ?? null;
    if (this.want && this.want !== this.baseId) this.want = null;
    this.snap = r.snap ?? null; this.taken = r.taken ?? null; this.error = r.error ?? null; this.none = Boolean(r.none);
    this.total = r.total ?? 0; this.changes = [...(r.changes ?? [])].sort(byPath);
    if (r.id && r.id !== "…" && !r.error) this.cache.set(r.id, { id: r.id, snap: r.snap, taken: r.taken, total: this.total, changes: this.changes });
    if (this.open && this.open !== ALL && !this.changes.some((c) => c.path === this.open)) this.select(null);
    if (this.open === ALL && !this.changes.length) this.select(null);
    if (!this.open && !this.closed && this.changes.length) this.open = this.changes[0].path;
  }

  // Compares every baseline at once, so switching between them shows a ready answer.
  surveyAll(cx) {
    const loc = this.loc, context = this.context;
    if (!loc || this.surveying) return;
    this.surveying = true;
    cx.spawn(async (cx) => {
      try {
        const all = await survey(loc);
        if (this.context === context) for (const [id, v] of all) this.cache.set(id, v);
      } catch {}
      finally { this.surveying = false; cx.notify(); }
    });
  }

  watch(loc, context, cx) {
    if (loc.on || this.watched === context) return;
    this.watched = context;
    cx.spawn(async (cx) => {
      try { while (this.watched === context) { await watchFolder(loc.cwd); if (this.watched === context) this.refresh(cx); } }
      catch { if (this.watched === context) this.watched = null; }
    });
  }

  async load(context) {
    const path = this.open, file = this.changes.find((c) => c.path === path), { cwd, on } = this.loc;
    if (path === ALL) {
      const r = await run(this.loc, "patch", this.want);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("F\t"));
      if (this.context !== context || this.open !== path) return;
      let lines = first < 0 ? ["\\ No changes"] : all.slice(first);
      if (lines.length > 20000) lines = [...lines.slice(0, 20000), "\\ Showing the first 20000 lines"];
      this.setRows(lines, "plain");
      return;
    }
    if (!file) return;
    let lines;
    if (file.binary) lines = ["Binary file changed"];
    else {
      const before = file.status === "A" ? "/dev/null" : `${this.snap}/tree/${path}`, after = file.status === "D" ? "/dev/null" : path;
      const r = await exec("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--", before, after], { cwd, on })
        .catch(() => exec("diff", ["-u", before, after], { cwd, on }));
      if (r.code > 1) throw new Error(r.stderr.trim() || `diff exited ${r.code}`);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [/^Binary/m.test(r.stdout) ? "Binary file changed" : "No text changes"] : all.slice(first);
      if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES), `\\ Showing the first ${MAX_LINES} lines`];
    }
    if (this.context !== context || this.open !== path) return;
    this.setRows(lines, languageOf(path));
    if (this.view !== "diff") await this.loadText(context);
  }

  // Numbers and highlights each line once, so a frame only draws the rows on screen.
  setRows(lines, lang) {
    let old = 0, now = 0, openOld = null, openNew = null, longest = 0;
    this.rows = lines.map((line) => {
      // "All changes": a file begins; its code highlights in its own language.
      if (line.startsWith("F\t")) {
        const [, status, path] = line.split("\t");
        lang = languageOf(path); openOld = openNew = null;
        return { kind: "F", status, path, text: path, line: `diff --git a/${path} b/${path}` };
      }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (hunk) { old = +hunk[1]; now = +hunk[2]; openOld = openNew = null; return { kind: "@", text: line, line }; }
      const kind = line[0];
      if (kind !== "-" && kind !== "+" && kind !== " ") return { kind: "!", text: line.replace(/^\\ /, ""), line };
      let text = line.slice(1).replace(/\t/g, "    ");
      if (text.length > 2000) text = text.slice(0, 2000) + " …";
      longest = Math.max(longest, text.length);
      const h = highlight(text, lang, kind === "-" ? openOld : openNew);
      if (kind === "-") { openOld = h.open; return { kind, old: old++, parts: h.parts, line, text }; }
      if (kind === "+") { openNew = h.open; return { kind, now: now++, parts: h.parts, line, text }; }
      openOld = openNew = h.open;
      return { kind, old: old++, now: now++, parts: h.parts, line, text };
    });
    // One line-number column when only one side changed (an added file reads 1, 2, 3…).
    const del = this.rows.some((r) => r.kind === "-"), add = this.rows.some((r) => r.kind === "+");
    this.cols = del && add ? "both" : del ? "old" : "now";
    this.digits = String(this.rows.reduce((n, r) => Math.max(n, r.old ?? 0, r.now ?? 0), 0)).length;
    this.longest = longest;
    this.pairs = pair(this.rows);
    if (this.sel && Math.max(this.sel.a.row, this.sel.b.row) >= this.list().length) this.sel = null;
    this.scroll(0);
  }

  // Before / After: the whole file in the editor, with its full highlighting.
  async loadText(context) {
    const path = this.open, view = this.view, file = this.changes.find((c) => c.path === path);
    if (!file) return;
    const source = view === "before" ? (file.status === "A" ? null : `${this.snap}/tree/${path}`) : (file.status === "D" ? null : `${this.loc.cwd}/${path}`);
    const text = source ? await readTextFile(source, { on: this.loc.on }).catch(() => null) : null;
    if (this.context !== context || this.open !== path || this.view !== view) return;
    const key = `${view}:${path}`;
    this.textNote = !source ? (view === "before" ? "New file: there was nothing before" : "Deleted since the baseline")
      : text === null ? "Cannot preview this file (too large or unreadable)" : text.includes("\0") ? "Binary file · no text preview" : null;
    if (this.textNote) { this.editor?.release(); this.editor = null; this.editorKey = null; return; }
    if (this.editor && this.editorKey === key) { if (this.editor.value() !== text) this.editor.set_value(text); return; }
    const t = theme(), ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
    this.editor?.release();
    this.editorKey = key;
    this.editor = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: text, font_family: settings().font_family, font_size: 12,
      syntax: Object.fromEntries(Object.entries(SYNTAX).map(([k, c]) => [k, t[c]])) });
  }

  select(path, cx) {
    this.open = path; this.rows = []; this.textNote = null;
    if (path === ALL) this.view = "diff"; this.sel = null; this.top = 0; this.left = 0;
    this.editor?.release(); this.editor = null; this.editorKey = null;
    this.closed = !path;
    if (!path || !cx) return;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.load(context); }
      catch (e) { if (this.context === context && this.open === path) this.setRows([`Cannot show this diff: ${e?.message ?? e}`], "plain"); }
      cx.notify();
    });
    cx.notify();
  }

  show(view, cx) {
    if (this.view === view) return;
    this.view = view; this.editor?.release(); this.editor = null; this.editorKey = null; this.textNote = null; this.sel = null;
    const context = this.context;
    if (view !== "diff" && this.open) cx.spawn(async (cx) => { await this.load(context).catch(() => {}); cx.notify(); });
    cx.notify();
  }

  // A new baseline joins the history and becomes the one compared with.
  // Shows at once as the newest, with nothing changed yet; the folder catches up in under a second.
  // The history list closes: the new baseline is the one being looked at now.
  rebase(cx) {
    this.note = null; this.want = null; this.select(null); this.closed = false; this.history = false; this.deleting = null;
    const now = Date.now();
    this.bases = [...this.bases, { id: "…", taken: now, files: null, pending: true }];
    this.apply({ bases: this.bases, id: "…", taken: now, total: 0, changes: [], snap: this.snap });
    this.refresh(cx, "snapshot");
    cx.notify();
  }

  // From the cache at once when this baseline was compared before; a refresh follows.
  useBase(id, cx) {
    if (id === "…") return;
    this.want = id === this.bases.at(-1)?.id ? null : id; this.note = null;
    const known = this.cache.get(id);
    if (known) { this.apply({ ...known, bases: this.bases }); this.want = id === this.bases.at(-1)?.id ? null : id; if (this.open) this.select(this.open, cx); }
    this.refresh(cx, "status", null, true);
    cx.notify();
  }

  // Deleting asks first: the first click arms it, a second one (not a double-click) deletes.
  remove(id, cx) {
    if (this.deleting !== id) { this.deleting = id; this.deletingAt = Date.now(); cx.notify(); return; }
    if (Date.now() - this.deletingAt < 500) return;
    this.deleting = null;
    // Gone from the list at once. Deleting the one shown switches to the newest left (from the
    // cache when it's there); deleting another changes nothing else, so no comparison is needed.
    const shown = id === this.baseId;
    this.bases = this.bases.filter((b) => b.id !== id);
    this.cache.delete(id);
    if (this.want === id) this.want = null;
    if (shown) {
      const next = this.cache.get(this.bases.at(-1)?.id);
      if (next) this.apply({ ...next, bases: this.bases });
      this.refresh(cx, "delete", id);
    } else this.refresh(cx, "drop", id);
    cx.notify();
  }

  historyList(t) {
    const newest = this.bases.at(-1)?.id;
    return v_flex().id("session-diff-history").flex_none().h(Math.min(200, 36 + 32 * this.bases.length)).overflow_y_scrollbar().p(6).gap(2).border_b(1).border_color(t.border)
      .on_hover((h, cx) => { if (!h && this.deleting) { this.deleting = null; cx.notify(); } })
      .child(div().px(8).py(2).text_size(11).text_color(t.dim).child("Baselines: click one to compare with it"))
      .children([...this.bases].reverse().map((b) => h_flex().id(`base-${b.id}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .when(b.id === this.baseId, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.useBase(b.id, cx))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(b.pending ? "Taking a baseline…" : stamp(b.taken)))
        .when(b.id === newest, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("newest")))
        .when(!b.pending, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${b.files} files`))
          .child(this.button(`del-${b.id}`, this.deleting === b.id ? "Delete?" : "Delete", t, (cx) => this.remove(b.id, cx), { danger: this.deleting === b.id })))));
  }

  step(by, cx) {
    if (!this.changes.length) return;
    const at = this.changes.findIndex((c) => c.path === this.open);
    this.select(this.changes[Math.max(0, Math.min(this.changes.length - 1, at < 0 ? 0 : at + by))].path, cx);
  }

  // The diff scrolls itself and draws only the rows on screen, so it always knows which row is
  // under the pointer: press and drag selects lines, shift-click extends; cmd-c copies the code,
  // cmd-shift-c the patch. The right edge is the scrollbar.
  list() { return this.split ? this.pairs ?? [] : this.rows; }

  // The diff draws and scrolls itself, so it knows the row and column under the pointer: press and
  // drag selects text, double-click a word, triple-click a line, shift-click extends. Text is
  // monospaced; a column is charW wide, measured from the font. The edges are the scrollbars.
  numW() { return 14 + this.digits * this.charW; }
  both() { return this.cols === "both" && (this.size?.width ?? 1000) >= 520; }
  // Side by side, the rows are as wide as the view: each half keeps its place, and the code in both
  // halves scrolls sideways together, as far as the longest line needs. scrollW is that scroll range.
  contentW() {
    if (this.split) return this.viewW;
    return Math.max(this.viewW, this.numW() * (this.both() ? 2 : 1) + 40 + this.longest * this.charW);
  }
  scrollW() { return this.split ? this.viewW + Math.max(0, this.numW() + 40 + this.longest * this.charW - this.half()) : this.contentW(); }
  half() { return (this.contentW() - 1) / 2; }
  codeX(side) { return side === "right" ? this.half() + 1 + this.numW() + 16 : this.numW() * (!this.split && this.both() ? 2 : 1) + 16; }

  scroll(dy, dx = 0) {
    this.top = Math.max(0, Math.min(this.top + dy, this.list().length * ROW - this.viewH));
    this.left = Math.max(0, Math.min(this.left + dx, this.scrollW() - this.viewW));
  }

  // The row, column and side under the pointer. A selection being made stays on its side.
  pointAt(e) {
    const x = (e.local_position?.x ?? 0) / zoom() + this.left, y = (e.local_position?.y ?? 0) / zoom();
    const row = Math.max(0, Math.min(this.list().length - 1, Math.floor((this.top + y) / ROW)));
    const side = !this.split ? null : this.dragging && this.side ? this.side : x - this.left < this.half() ? "left" : "right";
    return { row, col: Math.max(0, Math.round((x - this.codeX(side)) / this.charW)), side };
  }

  // A row's code on the selection's side, or null for hunk headers and empty halves.
  cell(r, side = this.side) { return r.kind === "pair" ? (side === "left" ? r.left : r.right) : "+- ".includes(r.kind) ? r : null; }

  thumbTo(e, axis) {
    const x = (e.local_position?.x ?? 0) / zoom(), y = (e.local_position?.y ?? 0) / zoom();
    if (axis === "y") { this.top = 0; this.scroll((y / this.viewH) * this.list().length * ROW - this.viewH / 2); }
    else { this.left = 0; this.scroll(0, (x / this.viewW) * this.scrollW() - this.viewW / 2); }
  }

  press(e, cx) {
    // The mod runtime blurs on any press that reaches it; stopping here keeps the keyboard, so cmd-c
    // works. Mouse-up focuses again in case it didn't.
    cx.stop_propagation();
    this.handle.focus();
    if (!this.list().length) return;
    const x = (e.local_position?.x ?? 0) / zoom(), y = (e.local_position?.y ?? 0) / zoom();
    if (x > this.viewW - 12 && this.list().length * ROW > this.viewH) { this.thumb = "y"; this.thumbTo(e, "y"); cx.notify(); return; }
    if (y > this.viewH - 12 && this.scrollW() > this.viewW + 1) { this.thumb = "x"; this.thumbTo(e, "x"); cx.notify(); return; }
    const p = this.pointAt(e);
    if (e.modifiers.shift && this.sel) this.sel = { a: this.sel.a, b: p };
    else {
      this.side = p.side;
      const text = this.cell(this.list()[p.row])?.text ?? "";
      if (e.click_count === 2) {
        // A word: a run of word characters, or of other non-space characters.
        const word = (ch) => /\w/.test(ch), at = Math.min(p.col, Math.max(0, text.length - 1)), kind = word(text[at] ?? " ");
        let a = at, b = at;
        while (a > 0 && text[a - 1] !== " " && word(text[a - 1]) === kind) a--;
        while (b < text.length && text[b] !== " " && word(text[b]) === kind) b++;
        this.sel = { a: { row: p.row, col: a }, b: { row: p.row, col: b } };
      } else if (e.click_count >= 3) this.sel = { a: { row: p.row, col: 0 }, b: { row: p.row, col: text.length } };
      else this.sel = { a: p, b: p };
    }
    this.dragging = true;
    cx.notify();
  }

  drag(e, cx) {
    if (this.thumb) { this.thumbTo(e, this.thumb); cx.notify(); return; }
    if (!this.dragging || !this.sel) return;
    // Near an edge, the drag scrolls on to what's off screen.
    const x = e.local_position.x / zoom(), y = e.local_position.y / zoom();
    this.scroll(y < ROW ? -ROW / 2 : y > this.viewH - ROW ? ROW / 2 : 0, x < 24 ? -2 * this.charW : x > this.viewW - 24 ? 2 * this.charW : 0);
    this.sel = { a: this.sel.a, b: this.pointAt(e) };
    cx.notify();
  }

  release() { this.dragging = false; this.thumb = null; }

  // The selection in reading order, or null when it's empty.
  span() {
    if (!this.sel) return null;
    const { a, b } = this.sel, [s, e] = a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
    return s.row === e.row && s.col === e.col ? null : { s, e };
  }

  // Row i's selected display columns [from, to), and whether the selection runs on past the line.
  cut(i) {
    const sp = this.span();
    if (!sp || i < sp.s.row || i > sp.e.row) return null;
    return { from: i === sp.s.row ? sp.s.col : 0, to: i === sp.e.row ? sp.e.col : Infinity, on: i < sp.e.row };
  }

  // The selected code as its lines (tabs as they are), or, for a patch, the whole lines with markers.
  selected(patch) {
    const sp = this.span();
    if (!sp) return [];
    const rows = this.list().slice(sp.s.row, sp.e.row + 1);
    if (patch) return rows.flatMap((r) => r.kind !== "pair" ? [r.line] : r.left === r.right ? [r.left.line] : [r.left, r.right].filter(Boolean).map((c) => c.line));
    return rows.flatMap((r, k) => {
      const c = this.cell(r), cut = this.cut(sp.s.row + k);
      if (!c) return [];
      const raw = c.line.slice(1);
      return [raw.slice(rawAt(raw, cut.from), cut.to === Infinity ? raw.length : rawAt(raw, cut.to))];
    });
  }

  selectAll(cx) {
    const n = this.list().length;
    if (this.view !== "diff" || !n) return;
    if (this.split) this.side ??= "right";
    this.sel = { a: { row: 0, col: 0 }, b: { row: n - 1, col: Infinity } };
    cx.notify();
  }

  toggleSplit(cx) {
    this.split = !this.split; this.sel = null; this.left = 0;
    localStorage.setItem("split", this.split ? "1" : "");
    this.scroll(0);
    cx.notify();
  }

  copy(patch, cx) {
    const lines = this.selected(patch), text = lines.join("\n");
    if (!text) return;
    cx.write_to_clipboard(patch ? text + "\n" : text);
    this.note = lines.length > 1 ? `Copied ${lines.length} lines${patch ? " as a patch" : ""}` : `Copied ${text.length} characters`;
    cx.notify();
  }

  button(id, label, t, onClick, { primary = false, active = false, danger = false } = {}) {
    return div().id(id).h(26).px(10).flex().items_center().flex_none().rounded(7).text_size(12).cursor_pointer()
      .bg(danger ? alpha(t.ansi1, "33") : primary ? t.solid : active ? t.selected : t.raised)
      .text_color(danger ? t.ansi1 : primary ? t.solid_foreground : active ? t.foreground : t.muted)
      .hover((s) => s.bg(danger ? alpha(t.ansi1, "4d") : primary ? t.solid : t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const color = f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked;
    return h_flex().id(`f-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.handle.focus(); this.select(this.open === f.path ? null : f.path, cx); })
      .child(div().w(14).flex_none().text_size(11).text_color(color).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? parts.join("/") + "/" : ""))
        .child(div().flex_none().max_w(260).truncate().when(f.status === "D", (e) => e.line_through()).child(name)))
      .when(f.binary, (e) => e.child(div().text_size(11).text_color(t.dim).child("bin")))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  diffRow(r, t, i) {
    const row = (el) => el.w_full().h(ROW).flex_none();
    if (r.kind === "F") {
      const file = this.changes.find((c) => c.path === r.path);
      return row(h_flex()).px(10).gap(8).items_center().bg(t.surface).border_t(1).border_color(t.border).font_semibold()
        .child(div().w(12).flex_none().text_color(r.status === "A" ? t.ansi2 : r.status === "D" ? t.ansi1 : t.blocked).child(r.status))
        .child(div().flex_none().whitespace_nowrap().child(r.path))
        .when(Boolean(file?.add), (e) => e.child(div().flex_none().font_normal().text_color(t.ansi2).child(`+${file.add}`)))
        .when(Boolean(file?.del), (e) => e.child(div().flex_none().font_normal().text_color(t.ansi1).child(`−${file.del}`)));
    }
    if (r.kind === "@" || r.kind === "!") return row(div()).px(12).flex().items_center().text_color(t.dim).whitespace_nowrap()
      .when(r.kind === "@", (e) => e.bg(t.raised)).child(r.text);
    // Both line numbers only when both sides changed and there's room.
    const both = this.both();
    return this.tint(row(h_flex()).items_center(), r, t)
      .when(both, (e) => e.child(this.num(r.old, t)))
      .child(this.num(both ? r.now : this.cols === "old" ? r.old : r.now ?? r.old, t))
      .child(this.sign(r, t)).child(this.code(r, t, this.cut(i)));
  }

  // Side by side: before on the left, after on the right.
  splitRow(r, t, i) {
    const cut = this.cut(i);
    const half = (c, side) => !c ? div().flex_1().min_w(0).h_full().bg(alpha(t.border, "30"))
      : this.tint(h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden(), c, t)
        .child(h_flex().flex_none().h_full().items_center().relative().left(-this.left)
          .child(this.num(side === "left" ? c.old : c.now, t)).child(this.sign(c, t)).child(this.code(c, t, this.side === side ? cut : null)));
    return h_flex().w_full().h(ROW).flex_none().child(half(r.left, "left")).child(div().w(1).h_full().flex_none().bg(t.border)).child(half(r.right, "right"));
  }

  tint(el, r, t) {
    return el.when(r.kind === "+", (e) => e.bg(alpha(t.ansi2, "1f"))).when(r.kind === "-", (e) => e.bg(alpha(t.ansi1, "1f")));
  }

  num(n, t) { return div().w(this.numW()).flex_none().pr(8).text_right().text_color(t.dim).child(n === undefined ? "" : String(n)); }

  sign(r, t) {
    return div().w(16).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === "+" ? "+" : r.kind === "-" ? "−" : "");
  }

  // The highlighted code, with the selected columns painted behind it.
  code(r, t, cut) {
    const out = [];
    let at = 0;
    for (const p of r.parts) {
      const end = at + p.t.length, clip = (x) => Math.min(Math.max(x, at), end) - at;
      const pieces = cut ? [[0, clip(cut.from), false], [clip(cut.from), clip(cut.to), true], [clip(cut.to), p.t.length, false]] : [[0, p.t.length, false]];
      for (const [a, b, picked] of pieces) if (b > a) out.push(div().flex_none().when(Boolean(p.c), (e) => e.text_color(t[SYNTAX[p.c]])).when(picked, (e) => e.bg(t.selection)).child(p.t.slice(a, b)));
      at = end;
    }
    // A selection running on past the line marks the line break.
    if (cut?.on) out.push(div().flex_none().w(this.charW).h(ROW - 4).bg(t.selection));
    return h_flex().flex_none().whitespace_nowrap().children(out);
  }

  detail(t) {
    const sp = this.view === "diff" ? this.span() : null, lines = sp ? this.selected(false) : [];
    const picked = !sp ? "" : lines.length > 1 ? `${lines.length} lines` : `${lines[0]?.length ?? 0} chars`;
    const all = this.open === ALL;
    const file = all ? { path: `All changes · ${this.changes.length} files` } : this.changes.find((c) => c.path === this.open);
    const bar = h_flex().h(38).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(file ? file.path : ""))
      .when(Boolean(picked), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${picked} · ⌘C`))
        .child(this.button("copy", "Copy", t, (cx) => this.copy(false, cx))))
      .when(this.view === "diff", (e) => e.child(div().id("split").size(26).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
        .bg(this.split ? t.selected : t.raised).text_color(this.split ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .tooltip(this.split ? "One column" : "Side by side: before and after").on_click((_e, cx) => this.toggleSplit(cx))
        .child(svg("mods/session-diff/split.svg").size(14))))
      .children((all ? [] : VIEWS).map(([v, label]) => this.button(`view-${v}`, label, t, (cx) => this.show(v, cx), { active: this.view === v })));
    const message = (text) => div().p(14).text_color(t.dim).child(text);
    if (!file) return v_flex().flex_1().min_h(0).child(message(this.changes.length ? "Pick a file to see what changed" : ""));
    if (this.view !== "diff") return v_flex().flex_1().min_h(0).child(bar)
      .child(this.editor ? Editor.new(this.editor).flex_1().min_h(0) : message(this.textNote || "Loading…"));
    const rows = this.list(), first = Math.floor(this.top / ROW), shown = rows.slice(first, first + Math.ceil(this.viewH / ROW) + 1);
    const total = rows.length * ROW, thumbH = Math.max(24, this.viewH * this.viewH / Math.max(total, 1));
    const wide = this.contentW(), sw = this.scrollW(), thumbW = Math.max(24, this.viewW * this.viewW / Math.max(sw, 1));
    return v_flex().flex_1().min_h(0).child(bar)
      .child(div().id("session-diff-view").flex_1().min_h(0).relative().overflow_hidden().cursor_text()
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .on_size_change((size, cx) => { this.viewH = size.height / zoom(); this.viewW = size.width / zoom(); this.scroll(0); cx.notify(); })
        .on_scroll_wheel((e, cx) => {
          let dx = e.delta.x, dy = e.delta.y;
          if (e.modifiers.shift && Math.abs(dx) < Math.abs(dy)) { dx = dy; dy = 0; }
          this.scroll(-dy / zoom(), -dx / zoom()); cx.stop_propagation(); cx.notify();
        })
        .on_mouse_down("left", (e, cx) => this.press(e, cx))
        .on_mouse_move((e, cx) => this.drag(e, cx))
        .on_mouse_up("left", () => { this.release(); this.handle.focus(); })
        .on_hover((h) => { if (!h) this.release(); })
        // A hidden run of 100 columns: its width is the font's column width, which the pointer maths uses.
        .child(div().id("session-diff-measure").absolute().left(0).top(0).h(0).overflow_hidden().whitespace_nowrap()
          .on_size_change((size, cx) => { const w = size.width / zoom() / 100; if (w > 0 && Math.abs(w - this.charW) > 0.01) { this.charW = w; cx.notify(); } })
          .child("0".repeat(100)))
        .child(v_flex().absolute().left(this.split ? 0 : -this.left).top(-(this.top % ROW)).w(wide)
          .children(shown.map((r, k) => r.kind === "pair" ? this.splitRow(r, t, first + k) : this.diffRow(r, t, first + k))))
        .when(total > this.viewH, (e) => e.child(div().absolute().right(2).w(6).rounded(3).bg(t.border)
          .top((this.top / Math.max(total - this.viewH, 1)) * (this.viewH - thumbH)).h(thumbH)))
        .when(sw > this.viewW + 1, (e) => e.child(div().absolute().bottom(2).h(6).rounded(3).bg(t.border)
          .left((this.left / Math.max(sw - this.viewW, 1)) * (this.viewW - thumbW)).w(thumbW)))
        .when(!this.rows.length, (e) => e.child(div().absolute().top(0).child(message("Loading…")))));
  }

  render(cx) {
    const loc = this.where();
    if (loc && JSON.stringify(loc) !== this.context) this.refresh(cx);
    const t = theme(), overlay = props()?.overlay, wide = (this.size?.width ?? 0) >= 760;
    const add = this.changes.reduce((n, f) => n + f.add, 0), del = this.changes.reduce((n, f) => n + f.del, 0);
    const folder = this.loc?.cwd?.split("/").filter(Boolean).pop() ?? "";
    const empty = !this.loc ? "Focus a terminal to pick its folder"
      : this.error ? this.error
      : this.none ? "No baseline yet: click Take baseline"
      : (this.reading || this.writing) && !this.taken ? "Taking a baseline…"
      : this.changes.length ? null : `No changes since ${this.taken ? since(this.taken) : "the baseline"}`;
    const list = v_flex().id("session-diff-files").p(6).overflow_y_scrollbar()
      .on_mouse_down("left", () => this.handle.focus())
      .when(this.changes.length > 1, (e) => e.child(h_flex().id("f-all").h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .when(this.open === ALL, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.handle.focus(); this.select(this.open === ALL ? null : ALL, cx); })
        .child(div().w(14).flex_none().text_size(11).text_color(t.dim).child("∑"))
        .child(div().flex_1().min_w(0).truncate().child(`All changes · ${this.changes.length} files`))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))))
      .children(this.changes.map((f) => this.fileRow(f, t)))
      .when(this.total > this.changes.length, (e) => e.child(div().p(8).text_size(11).text_color(t.dim).child(`Showing ${this.changes.length} of ${this.total} changed files`)));
    return v_flex().id("session-diff").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .when(Boolean(props()?.panel), (e) => e.rounded(10).border_1().border_color(t.border))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const k = e.key, cmd = e.modifiers.platform || e.modifiers.control;
        if (cmd) return;
        if (k === "s" && this.view === "diff") this.toggleSplit(cx);
        else if (k === "escape" && this.sel) { this.sel = null; cx.notify(); }
        else if (this.view === "diff" && (k === "pageup" || k === "pagedown" || k === "home" || k === "end")) {
          this.scroll(k === "pageup" ? -this.viewH : k === "pagedown" ? this.viewH : k === "home" ? -Infinity : Infinity); cx.notify();
        }
        else if (k === "down" || k === "j") this.step(1, cx);
        else if (k === "up" || k === "k") this.step(-1, cx);
        else if (k === "d" || k === "b" || k === "a") this.show({ d: "diff", b: "before", a: "after" }[k], cx);
        else if (k === "escape" && overlay) closeOverlay(overlay);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Diff"))
        .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(folder))
        .when(Boolean(this.taken), (e) => e.child(div().id("history").flex_none().text_size(12).cursor_pointer().rounded(5).px(4)
          .text_color(this.history ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground)).tooltip("Baseline history")
          .on_click((_e, cx) => { this.history = !this.history; this.deleting = null; if (this.history) this.surveyAll(cx); cx.notify(); })
          .child(`since ${since(this.taken)}${this.want ? " (older)" : ""}${this.bases.length > 1 ? ` · ${this.bases.length}` : ""} ▾`)))
        .when(this.reading > 0 || this.writing, (e) => e.child(div().text_size(12).text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(div().flex_1())
        .when(add > 0, (e) => e.child(div().text_size(12).text_color(t.ansi2).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().text_size(12).text_color(t.ansi1).child(`−${del}`)))
        .when(Boolean(this.loc && this.taken), (e) => e.child(div().id("refresh").size(26).flex_none().flex().items_center().justify_center().rounded(7)
          .cursor_pointer().bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Compare with the baseline now")
          .on_click((_e, cx) => { this.note = null; this.refresh(cx, "status", null, true); if (this.history) this.surveyAll(cx); }).child(svg("mods/session-diff/refresh.svg").size(14))))
        .when(Boolean(this.loc), (e) => e.child(this.button("rebase", this.taken ? "New baseline" : "Take baseline", t, (cx) => this.rebase(cx), { primary: !this.taken })))
        .when(Boolean(overlay), (e) => e.child(this.button("close", "×", t, () => closeOverlay(overlay)))))
      .when(this.history && this.bases.length > 0, (e) => e.child(this.historyList(t)))
      .when(Boolean(empty), (e) => e.child(v_flex().flex_1().min_h(0).items_center().justify_center().px(24).gap(6)
        .child(div().text_center().text_color(this.error ? t.ansi1 : t.dim).child(empty))))
      .when(!empty, (e) => e.child(wide
        ? h_flex().flex_1().min_h(0).child(list.w(300).flex_none().h_full().border_r(1).border_color(t.border)).child(this.detail(t).h_full())
        : v_flex().flex_1().min_h(0).child(list.flex_none().h(Math.min(220, 12 + 28 * (this.changes.length + (this.changes.length > 1 ? 1 : 0)))).border_b(1).border_color(t.border)).child(this.detail(t))))
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(14).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(this.note)));
  }

  async close() {
    this.watched = null;
    this.editor?.release();
    this.handle.release();
  }
}
