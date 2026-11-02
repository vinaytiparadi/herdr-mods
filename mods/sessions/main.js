// Sessions: the coding-agent sessions saved on this computer and on every connected machine
// (Claude Code, Codex, Kiro), newest first, for the shown space's repo, its machine or everywhere.
// Type to search titles, folders and every prompt typed; click a session to resume it in a new tab
// on its machine, in the folder it worked in; shift-click forks it (Claude Code, Codex). The trash
// button on a hovered row deletes it, after a confirm.
// Each machine lists its own with scan.py, which keeps a cache in ~/.cache/herdr-sessions there.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, spaces, panes, terminals, run, theme, appHome, readTextFile, props, closeOverlay, nextCommand, layout } from "herdr";

const REFRESH = 60000;     // while shown; a hidden panel doesn't poll
const STALE = 15000;       // showing a panel again refreshes it when older than this
const PAGE = 50;           // rows drawn at first, and added by "Show more"
const SEARCH_WAIT = 250;   // ms of no typing before every machine searches its prompts
const RECENT = 10 * 60000; // a session this fresh may still be running somewhere: say so before deleting

const AGENTS = {
  claude: { name: "Claude Code", icon: "icons/claude.svg", resume: (s) => ["claude", "--resume", s.id], fork: (s) => ["claude", "--resume", s.id, "--fork-session"] },
  codex: { name: "Codex", icon: "icons/codex.svg", resume: (s) => ["codex", "resume", s.id], fork: (s) => ["codex", "fork", s.id] },
  kiro: { name: "Kiro", icon: "icons/kiro.svg", resume: (s) => ["kiro-cli", "chat", "--agent-engine", s.engine ?? "v2", "--resume-id", s.id] },
};

const base = (path) => path.replace(/\/+$/, "").split("/").pop() || path;
const inside = (dir, root) => dir === root || dir.startsWith(`${root}/`);
const keyOf = (s) => `${s.on ?? ""}|${s.agent}|${s.id}`;
const titleOf = (s) => s.title || s.first || "(untitled)";
const machineName = (on) => on ?? "This computer";

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 60 ? `${d}d` : `${Math.floor(d / 30)}mo`;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// scan.py runs with the machine's own python3; its code goes along as an argument.
let code = null;
async function scan(on, args) {
  code ??= await readTextFile(`${appHome()}/mods/sessions/scan.py`);
  if (!code) throw new Error("mods/sessions/scan.py is missing");
  const r = await exec("python3", ["-c", code, ...args], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `scan.py exited ${r.code}`);
  return JSON.parse(r.stdout);
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A folder's repo root, else the folder, symlinks resolved, as scan.py records sessions' folders.
const ROOT = 'cd "$1" 2>/dev/null && { git rev-parse --show-toplevel 2>/dev/null || pwd -P; }';

export default class Sessions extends View {
  init(_props, cx) {
    this.m = {};          // machine ("" here) -> { rows, sig, bots, total, scripted, error, loading, loaded, partial }
    this.remotes = [];
    this.found = {};      // machine -> rows whose prompts matched the query there
    this.roots = {};      // "machine|folder" -> its repo root
    this.version = 0;     // bumped whenever rows or search hits change, for the memo in rows()
    this.query = "";
    this.list = [];
    this.gen = 0;
    this.at = 0;
    this.limit = PAGE;
    this.hover = null;    // the hovered row's key: it shows the trash button
    this.confirm = null;  // the row asking "Delete?"
    this.deleting = {};   // key -> true while its delete runs, or the error it gave
    this.scope = localStorage.getItem("scope") ?? "space";
    this.hidden = new Set(JSON.parse(localStorage.getItem("hidden") ?? "[]"));
    this.scripted = localStorage.getItem("scripted") === "1";
    this.input = InputState.new({ placeholder: "Search titles, folders and prompts…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.reset();
      this.search(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => {
      const s = this.list[this.at];
      if (s) this.open(s, false, cx);
    });
    this.handle = cx.focus_handle();
    if (props()?.overlay) {
      this.input.focus();
      cx.timer.after(300, () => this.input.focus());
    }
    this.refresh(cx);
    cx.timer.every(REFRESH, (cx) => {
      if (this.visible()) this.refresh(cx);
    });
    // keys.json: "sessions.next" / "prev" / "open" / "fork" / "delete" / "more" / "refresh" / "space" / "machine" / "all" (scopes) / "scripted".
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const s = this.list[this.at];
        if (c === "next") this.move(1);
        else if (c === "prev") this.move(-1);
        else if ((c === "open" || c === "fork") && s) this.open(s, c === "fork", cx);
        // Once asks, again (while it asks) deletes.
        else if (c === "delete" && s) {
          if (this.confirm === keyOf(s) && !this.liveTerminals()(s)) this.remove(s, cx);
          else this.confirm = keyOf(s);
        }
        else if (c === "more") this.limit += PAGE;
        else if (c === "refresh") this.refresh(cx);
        else if (c === "space" || c === "machine" || c === "all") this.setScope(c);
        else if (c === "scripted") this.toggleScripted(cx);
        cx.notify();
      }
    });
  }

  // A filter changed: back to the first page, nothing selected or asking.
  reset() {
    this.at = 0;
    this.limit = PAGE;
    this.confirm = null;
  }

  move(by) {
    this.at = Math.max(0, Math.min(this.at + by, this.list.length - 1));
    if (this.at >= this.limit) this.limit += PAGE;
  }

  setScope(id) {
    this.scope = id;
    this.reset();
    localStorage.setItem("scope", id);
  }

  toggleScripted(cx) {
    this.scripted = !this.scripted;
    this.reset();
    localStorage.setItem("scripted", this.scripted ? "1" : "0");
    // Scripted runs are only sent when asked for.
    if (this.scripted) this.refresh(cx);
  }

  // Shown on screen: a popup always; in the main layout's side panel, only while it shows Sessions.
  visible() {
    if (props()?.overlay) return true;
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body || !find(body, "sessions")) return true;
    return !panel.hidden && body.active === "sessions";
  }

  refresh(cx) {
    this.refreshed = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.remotes = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      for (const on of [null, ...this.remotes]) this.load(on, cx);
      cx.notify();
    });
  }

  load(on, cx) {
    const m = (this.m[on ?? ""] ??= { rows: [], loaded: false });
    if (m.loading) return;
    m.loading = true;
    cx.spawn(async (cx) => {
      try {
        const args = ["list"];
        if (this.scripted) args.push("--scripted");
        // Unchanged since the last list: the machine says so instead of sending it again.
        if (m.sig && m.bots === this.scripted) args.push("--since", m.sig);
        const d = await scan(on, args);
        if (!d.same) {
          m.rows = d.rows.map((r) => ({ ...r, on }));
          m.sig = d.sig;
          m.bots = this.scripted;
          this.version++;
        }
        Object.assign(m, { total: d.total, scripted: d.scripted, partial: d.partial, error: d.errors?.length ? d.errors.join("; ") : null });
      } catch (e) {
        m.error = String(e.message ?? e);
      }
      m.loading = false;
      m.loaded = true;
      // A first scan of a long history goes on where the last run stopped.
      if (m.partial) cx.timer.after(200, (cx) => this.load(on, cx));
      cx.notify();
    });
  }

  // Loaded rows filter as you type; every machine also searches all its prompts once you pause.
  search(cx) {
    const words = this.query.trim().split(/\s+/).filter(Boolean), gen = ++this.gen;
    this.found = {};
    this.version++;
    if (!words.length) return;
    cx.timer.after(SEARCH_WAIT, (cx) => {
      if (gen !== this.gen) return;
      for (const on of [null, ...this.remotes]) {
        cx.spawn(async (cx) => {
          try {
            const d = await scan(on, ["search", ...words]);
            if (gen !== this.gen) return;
            this.found[on ?? ""] = d.rows.map((r) => ({ ...r, on, hit: true }));
            this.version++;
            cx.notify();
          } catch {}
        });
      }
    });
  }

  // The repo root of a space's folder on its machine, looked up once.
  root(on, dir, cx) {
    const k = `${on ?? ""}|${dir}`;
    if (k in this.roots) return this.roots[k];
    this.roots[k] = dir;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", ROOT, "sessions", dir], { on });
        if (r.code === 0 && r.stdout.trim()) {
          this.roots[k] = r.stdout.trim();
          cx.notify();
        }
      } catch {}
    });
    return dir;
  }

  // Live terminals already running a session (one this panel resumed names it in its argv).
  liveTerminals() {
    const live = terminals().filter((t) => t.state === "live" || t.state === "running").map((t) => [t.address, JSON.stringify([t.argv, t.foreground?.argv])]);
    return (s) => live.find(([, argv]) => argv.includes(s.id))?.[0] ?? null;
  }

  // Resume in a new tab: in the shown space when it's on the session's machine, else in a space
  // there (one in the session's folder first), else in a new space there.
  open(s, fork, cx) {
    const close = () => props()?.overlay && closeOverlay(props().overlay);
    const running = this.liveTerminals()(s);
    if (running && !fork) {
      run("pane.focus", { terminal: running });
      close();
      return;
    }
    const spec = AGENTS[s.agent];
    const argv = (fork && spec.fork ? spec.fork : spec.resume)(s);
    const name = titleOf(s).slice(0, 28);
    const ps = panes(), mine = spaces().filter((x) => (x.machine ?? null) === (s.on ?? null));
    const space = mine.find((x) => x.active) ?? mine.find((x) => s.cwd && inside(s.cwd, place(x, ps))) ?? mine[0];
    cx.spawn(async () => {
      let has = false;
      try {
        has = Boolean(s.cwd) && (await exec("test", ["-d", s.cwd], { on: s.on })).code === 0;
      } catch {}
      const folder = has ? s.cwd : undefined;
      if (space) {
        if (!space.active) run("space.select", { id: space.id });
        run("tab.new", { space: space.id, name, folder, argv });
      } else run("space.new", { ...(s.on ? { machine: s.on } : {}), folder, tab: name, argv });
      // Last: closing the popup ends this copy and its tasks.
      close();
    });
  }

  // Deletes it on its machine for good (scan.py uses the agent's own command where it has one).
  remove(s, cx) {
    const k = keyOf(s);
    this.deleting[k] = true;
    cx.spawn(async (cx) => {
      let d;
      try {
        d = await scan(s.on, ["delete", s.agent, s.id, s.engine ?? "", s.cwd ?? ""]);
      } catch (e) {
        d = { error: String(e.message ?? e) };
      }
      if (d.ok) {
        delete this.deleting[k];
        if (this.confirm === k) this.confirm = null;
        const m = this.m[s.on ?? ""];
        if (m) {
          m.rows = m.rows.filter((r) => keyOf(r) !== k);
          m.sig = null;
          if (!s.scripted) m.total = Math.max(0, (m.total ?? 1) - 1);
        }
        for (const f of Object.keys(this.found)) this.found[f] = this.found[f].filter((r) => keyOf(r) !== k);
        this.version++;
      } else this.deleting[k] = d.error || "couldn't delete it";
      cx.notify();
    });
  }

  // Every shown session, filtered and sorted once per change, not on every redraw.
  rows(here, on) {
    const memo = [this.version, this.query, [...this.hidden].join(","), this.scripted, here, on, this.remotes.join(",")].join("\u0001");
    if (this.memo?.key === memo) return this.memo.value;
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set(), all = [];
    let scripted = 0;
    for (const m of [null, ...this.remotes]) {
      const st = this.m[m ?? ""];
      scripted += st?.scripted ?? 0;
      const pool = [...(st?.rows ?? []), ...(words.length ? this.found[m ?? ""] ?? [] : [])];
      for (const s of pool) {
        const k = keyOf(s);
        if (seen.has(k)) continue;
        if (!this.scripted && s.scripted) continue;
        if (this.hidden.has(s.agent)) continue;
        if (words.length && !s.hit) {
          const hay = [s.title, s.first, s.last, s.cwd, s.model, s.branch, s.id, AGENTS[s.agent]?.name, s.on].join(" ").toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
        }
        seen.add(k);
        all.push(s);
      }
    }
    all.sort((a, b) => b.updated - a.updated);
    const machine = all.filter((s) => (s.on ?? null) === on);
    const space = here ? machine.filter((s) => s.cwd && inside(s.cwd, here)) : [];
    const value = { all, machine, space, scripted };
    this.memo = { key: memo, value };
    return value;
  }

  chip(t, id, label, on) {
    return div()
      .id(`scope-${id}`)
      .px(8)
      .h(22)
      .rounded(6)
      .flex()
      .flex_none()
      .items_center()
      .text_size(11.5)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.raised))
      .hover((el) => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        this.setScope(id);
        cx.notify();
      })
      .child(label);
  }

  // One button per agent: shown (its icon on a raised square) or left out (the icon faded).
  agentToggle(t, agent) {
    const off = this.hidden.has(agent), spec = AGENTS[agent];
    return div()
      .id(`agent-${agent}`)
      .size(22)
      .rounded(5)
      .flex()
      .items_center()
      .justify_center()
      .when(!off, (el) => el.bg(t.raised))
      .hover((el) => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        if (off) this.hidden.delete(agent);
        else this.hidden.add(agent);
        localStorage.setItem("hidden", JSON.stringify([...this.hidden]));
        this.reset();
        cx.notify();
      })
      .child(image(spec.icon).w(13).h(13).opacity(off ? 0.3 : 1));
  }

  header(t, label, counts, on) {
    const busy = Object.values(this.m).some((m) => m.loading);
    return v_flex()
      .flex_none()
      .px(10)
      .pt(10)
      .pb(6)
      .gap(7)
      .child(h_flex().items_center().gap(4)
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child("Sessions"))
        .children(Object.keys(AGENTS).map((a) => this.agentToggle(t, a)))
        .child(div()
          .id("refresh")
          .size(22)
          .rounded(5)
          .flex()
          .items_center()
          .justify_center()
          .text_color(t.muted)
          .hover((el) => el.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.refresh(cx))
          .when(busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)))
          .when(!busy, (el) => el.child(svg("mods/sessions/refresh.svg").size(13)))))
      .child(h_flex().h(30).px(9).gap(7).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(13).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(4).overflow_hidden()
        .child(this.chip(t, "space", `${label ? base(label) : "This space"} (${counts.space})`, this.scope === "space"))
        .child(this.chip(t, "machine", `${machineName(on)} (${counts.machine})`, this.scope === "machine"))
        .child(this.chip(t, "all", `All (${counts.all})`, this.scope === "all")));
  }

  button(t, id, label, color, bg, action) {
    return div()
      .id(id)
      .flex_none()
      .px(8)
      .h(20)
      .rounded(5)
      .flex()
      .items_center()
      .text_size(11)
      .text_color(color)
      .when(Boolean(bg), (el) => el.bg(bg))
      .hover((el) => el.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.pressed = Date.now();
        action(cx);
        cx.notify();
      })
      .child(label);
  }

  // The second line while a row asks "Delete?": why it may not be a good idea, and the buttons.
  asking(t, s, k, running) {
    const state = this.deleting[k];
    if (state === true) {
      return h_flex().pl(21).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900))
        .child("Deleting…");
    }
    const why = typeof state === "string" ? state
      : running ? "It's open in a tab; close it there first."
      : Date.now() - s.updated < RECENT ? `Active ${ago(s.updated)} ago; an agent may still be running it.`
      : `Delete for good${s.on ? ` on ${s.on}` : ""}?`;
    return h_flex().pl(21).gap(6).items_center().text_size(11)
      .child(div().flex_1().truncate().text_color(typeof state === "string" || running ? t.blocked : t.muted).child(why))
      .when(!running, (el) => el.child(this.button(t, `del-${k}`, "Delete", t.blocked, null, (cx) => this.remove(s, cx))))
      .child(this.button(t, `keep-${k}`, "Cancel", t.muted, null, () => {
        this.confirm = null;
        delete this.deleting[k];
      }));
  }

  row(t, s, i, liveOf) {
    const spec = AGENTS[s.agent], k = keyOf(s);
    const bits = [spec.name, s.model, s.prompts ? `${s.prompts} prompt${s.prompts === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
    const where = [this.scope !== "space" && s.cwd ? base(s.cwd) : null, this.scope === "all" && s.on ? s.on : null].filter(Boolean).join(" · ");
    const running = liveOf(s), asking = this.confirm === k, hovered = this.hover === k;
    return v_flex()
      .id(`s-${k}`)
      .flex_none()
      .px(8)
      .py(5)
      .gap(2)
      .rounded(7)
      .cursor_pointer()
      .when(i === this.at || asking, (el) => el.bg(t.hover))
      .hover((el) => el.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hover = k;
        else if (this.hover === k) this.hover = null;
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => {
        // Not when the press was on its own trash, Delete or Cancel button.
        if (this.confirm !== k && Date.now() - (this.pressed ?? 0) > 400) this.open(s, e.modifiers.shift, cx);
      })
      .child(h_flex().gap(7).items_center()
        .child(image(spec.icon).w(14).h(14).flex_none())
        .child(div().flex_1().truncate().text_color(t.foreground).child(titleOf(s)))
        .when(Boolean(running), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.accent).child("open")))
        .when(hovered && !asking, (el) => el.child(div()
          .id(`trash-${k}`)
          .flex_none()
          .size(18)
          .rounded(4)
          .flex()
          .items_center()
          .justify_center()
          .text_color(t.dim)
          .hover((h) => h.text_color(t.blocked).bg(t.raised))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.pressed = Date.now();
            this.confirm = k;
            delete this.deleting[k];
            cx.notify();
          })
          .child(svg("mods/sessions/trash.svg").size(12))))
        .when(!hovered || asking, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(s.updated)))))
      .child(asking ? this.asking(t, s, k, running) : h_flex().pl(21).gap(5).items_center().text_size(11).text_color(t.dim)
        .child(div().truncate().child(bits))
        .when(Boolean(where), (el) => el
          .child(div().flex_none().child("·"))
          .child(div().flex_shrink_0().max_w(150).truncate().text_color(t.muted).child(where))));
  }

  note(t, text, color) {
    return div().px(12).py(6).text_size(11.5).text_color(color ?? t.dim).child(text);
  }

  render(cx) {
    const t = theme(), ps = panes();
    // Coming back into view refreshes a stale list; out of view, nothing polls.
    const shown = this.visible();
    if (shown && !this.shown && Date.now() - (this.refreshed ?? 0) > STALE) this.refresh(cx);
    this.shown = shown;

    const space = spaces().find((s) => s.active);
    const on = space?.machine ?? null;
    const dir = space ? place(space, ps) : null;
    const here = dir ? this.root(on, dir, cx) : null;
    const r = this.rows(here, on);
    const list = (this.list = r[this.scope] ?? r.all);
    this.at = Math.max(0, Math.min(this.at, list.length - 1));

    const notes = [];
    for (const m of [null, ...this.remotes]) {
      const st = this.m[m ?? ""];
      if (st?.error) notes.push(this.note(t, `${machineName(m)}: ${st.error}`, t.blocked));
      else if (!st?.loaded) notes.push(this.note(t, `Reading ${machineName(m)}'s sessions…`));
      else if (st.partial) notes.push(this.note(t, `Still reading ${machineName(m)}'s history (first run)…`));
    }

    let body;
    const loaded = Object.values(this.m).some((m) => m.loaded);
    if (!list.length && loaded) {
      const off = Object.keys(AGENTS).filter((a) => this.hidden.has(a)).map((a) => AGENTS[a].name);
      const what = this.query.trim() ? `No sessions match “${this.query.trim()}”.` : this.scope === "space" ? `No sessions in ${here ? base(here) : "this space"} yet.` : "No sessions yet.";
      const hint = off.length ? ` ${off.join(", ")} ${off.length === 1 ? "is" : "are"} hidden; click ${off.length === 1 ? "its icon" : "their icons"} above to show ${off.length === 1 ? "it" : "them"}.` : "";
      body = this.note(t, what + hint);
    } else {
      const liveOf = this.liveTerminals(), left = list.length - this.limit;
      body = v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(6)
        .children(list.slice(0, this.limit).map((s, i) => this.row(t, s, i, liveOf)))
        .when(left > 0, (el) => el.child(h_flex()
          .id("more")
          .flex_none()
          .mx(4)
          .mt(4)
          .h(28)
          .rounded(7)
          .justify_center()
          .items_center()
          .text_size(11.5)
          .text_color(t.muted)
          .cursor_pointer()
          .border_1()
          .border_color(t.border)
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            this.limit += PAGE;
            cx.notify();
          })
          .child(`Show ${Math.min(PAGE, left)} more · ${left} left`)));
    }
    const hiddenBots = this.scripted ? 0 : r.scripted;

    return v_flex()
      .id("root")
      .track_focus(this.handle)
      .size_full()
      .bg(props()?.overlay ? t.popover : t.chrome)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.confirm) this.confirm = null;
        else if (e.key === "escape" && props()?.overlay) return closeOverlay(props().overlay);
        if (e.key === "down") this.move(1);
        else if (e.key === "up") this.move(-1);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.header(t, here, { space: r.space.length, machine: r.machine.length, all: r.all.length }, on))
      .children(notes)
      .child(div().flex_1().min_h(0).flex().flex_col().child(body))
      .child(h_flex()
        .id("scripted")
        .flex_none()
        .px(12)
        .py(6)
        .border_t(1)
        .border_color(t.border)
        .text_size(11)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((el) => el.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          this.toggleScripted(cx);
          cx.notify();
        })
        .child(div().flex_1().truncate().child(this.scripted ? "Showing scripted runs · hide" : `${hiddenBots} scripted run${hiddenBots === 1 ? "" : "s"} hidden · show`))
        .child(div().flex_none().child("⇧-click forks")));
  }
}
