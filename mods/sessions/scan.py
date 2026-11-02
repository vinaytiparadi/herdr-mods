# Sessions' scanner: lists the coding-agent sessions saved on this machine (Claude Code, Codex,
# Kiro), newest first, as one JSON document on stdout. main.js runs it on each machine with
# `python3 -c <this file> <action> ...`; it must run on the system python3 (3.9 on AL2023).
#   list [--scripted] [--since <sig>]   every session (scripted runs too with --scripted); just
#                                       {"same": true} when the list's sig is still <sig>
#   search <words...>                   sessions whose title, folder or prompts hold every word
#   delete <agent> <id> <engine> <cwd>  deletes one session, with the agent's own command if it has one
#
# Each transcript is read once: ~/.cache/herdr-sessions/index.json keeps, per file, how far it was
# read and what it held, so a later run reads only what was appended, and only the lines that
# matter (found with a C-speed search over the mapped file, not line by line). The prompts typed
# in each session are kept beside it in text/<key>.txt (capped) for `search`.
import glob
import hashlib
import json
import mmap
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime

VERSION = 4
HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "herdr-sessions")
INDEX = os.path.join(CACHE, "index.json")
TEXT = os.path.join(CACHE, "text")
LIST_LIMIT = 5000      # newest rows `list` prints
SEARCH_LIMIT = 300
SNIP = 200             # chars of a prompt kept on a row
TEXT_CAP = 8000        # chars of prompts kept per session for search
PROMPT_CAP = 1000      # chars of one prompt kept for search
# Scripted runs (headless agents, bots driving an agent) are marked so the panel can hide them:
# those started in a temp folder, or whose first prompt is an injected system prompt.
TMP = ("/tmp", "/private/tmp", "/var/folders/", "/private/var/folders/")
INJECTED = re.compile(r"^(\[AGENT SYSTEM PROMPT\]|\[Previous chat history|<!--|<context_entry>)")
# A first scan of a big history reads gigabytes; past this many seconds a run stops reading,
# saves how far it got and says "partial", and the next run goes on from there.
BUDGET = 12
START = time.time()
partial = False

MODEL = re.compile(rb'"model":"([^"]+)"')
STAMP = re.compile(rb'"timestamp":"([^"]+)"')
ID = re.compile(r"^(sess_)?[0-9A-Fa-f][0-9A-Fa-f-]{7,63}$")
# The start of a JSON string, at most PROMPT_CAP characters (escapes whole): prompts can be
# megabytes (a bot pasting a whole chat back in), and only their start is kept.
STR = re.compile(rb'"((?:[^"\\]|\\.){0,%d})' % PROMPT_CAP)


def jstr(buf, at, end):
    """The JSON string whose opening quote is at buf[at], decoded, cut at PROMPT_CAP."""
    m = STR.match(buf, at, end)
    if not m:
        return ""
    try:
        return json.loads(b'"' + m.group(1) + b'"')
    except ValueError:  # cut inside a character
        return m.group(1).decode("utf-8", "ignore")


def first_text(buf, a, b, keys):
    """The first text block of a line, read in place: after the first of `keys` (bytes such as
    b'"data":') that is followed by a string. None when the line holds none of them."""
    for k in keys:
        at = buf.find(k, a, b)
        if at >= 0:
            at += len(k)
            if buf[at:at + 1] == b'"':
                return jstr(buf, at, b)
    return None


def ms(iso):
    """An ISO time (with Z, up to 9 fraction digits) as ms since the epoch, or 0."""
    if not iso:
        return 0
    try:
        s = iso.replace("Z", "+00:00")
        m = re.match(r"(.*\.\d{6})\d*(.*)", s)
        if m:
            s = m.group(1) + m.group(2)
        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return 0


def one_line(s):
    return re.sub(r"\s+", " ", s or "").strip()


def scripted(r):
    cwd, first = r["cwd"], r["first"] or ""
    if not cwd or cwd == "/" or any(cwd == t or cwd.startswith(t if t.endswith("/") else t + "/") for t in TMP):
        return True
    return bool(INJECTED.match(first)) or first.startswith(("You are a ", "You are an "))


class Index:
    def __init__(self):
        self.files = {}
        try:
            with open(INDEX) as f:
                d = json.load(f)
            if d.get("version") == VERSION:
                self.files = d.get("files", {})
        except Exception:
            pass
        self.seen = set()
        self.dirty = False

    def save(self):
        gone = set(self.files) - self.seen
        for k in gone:
            key = self.files[k].get("key")
            del self.files[k]
            if key:
                try:
                    os.remove(text_path(key))
                except OSError:
                    pass
        if not (self.dirty or gone):
            return
        os.makedirs(CACHE, exist_ok=True)
        tmp = "%s.%d" % (INDEX, os.getpid())
        with open(tmp, "w") as f:
            json.dump({"version": VERSION, "files": self.files}, f, separators=(",", ":"))
        os.replace(tmp, INDEX)


def text_path(key):
    return os.path.join(TEXT, re.sub(r"[^A-Za-z0-9_.-]", "_", key) + ".txt")


class Tail:
    """Reads what was appended to a JSONL file since the last run; `state` is the file's entry."""

    def __init__(self, idx, path, key, fresh):
        self.idx, self.path, self.key = idx, path, key
        idx.seen.add(path)
        st = os.stat(path)
        old = idx.files.get(path)
        sig = [st.st_ino, st.st_dev]
        if old and old.get("sig") == sig and old.get("off", 0) <= st.st_size and old.get("key") == key:
            self.state = old
            self.changed = old.get("off") != st.st_size or old.get("mtime") != int(st.st_mtime)
        else:
            self.state = dict(fresh, sig=sig, off=0, key=key, chars=0)
            idx.files[path] = self.state
            self.changed = True
            try:
                os.remove(text_path(key))
            except OSError:
                pass
        self.state["mtime"] = int(st.st_mtime)
        self.size = st.st_size
        self.text = []

    def lines(self, marker):
        """(buffer, start, end) of each complete, unread line `marker` (a bytes regex) matches.
        `self.span` is the (start, end) of the bytes read this time, for looking backwards."""
        global partial
        self.span = None
        if not self.changed:
            return
        off = self.state["off"]
        if self.size <= off:
            return
        if time.time() - START > BUDGET:
            partial = True  # left for the next run, as it is
            return
        self.idx.dirty = True
        with open(self.path, "rb") as f:
            mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            end = mm.rfind(b"\n", off, self.size) + 1
            if end <= off:
                return  # the last line is still being written; read it next time
            pat, pos, n = re.compile(marker), off, 0
            while True:
                m = pat.search(mm, pos, end)
                if not m:
                    pos = end
                    break
                s = max(off, mm.rfind(b"\n", off, m.start()) + 1)
                e = mm.find(b"\n", m.end(), end) + 1
                yield mm, s, e
                pos = e
                n += 1
                if n % 64 == 0 and time.time() - START > BUDGET:
                    partial = True
                    break
            self.span = (mm, off, pos)
            self.state["off"] = pos
        finally:
            if self.span is None:
                mm.close()

    def last(self, needle, tries=1):
        """The last lines read this time that hold `needle`, newest first, at most `tries`."""
        if not self.span:
            return
        mm, s, e = self.span
        for _ in range(tries):
            at = mm.rfind(needle, s, e)
            if at < 0:
                return
            start = max(s, mm.rfind(b"\n", s, at) + 1)
            yield mm[start:mm.find(b"\n", at, e) + 1]
            e = start

    def prompt(self, text):
        text = one_line(text)
        if not text:
            return
        s = self.state
        s["n"] = s.get("n", 0) + 1
        if not s.get("first"):
            s["first"] = text[:SNIP]
        s["last"] = text[:SNIP]
        if s["chars"] < TEXT_CAP:
            piece = text[:PROMPT_CAP]
            self.text.append(piece)
            s["chars"] += len(piece) + 1

    def close(self):
        if self.span:
            self.span[0].close()
            self.span = None
        if self.text:
            os.makedirs(TEXT, exist_ok=True)
            with open(text_path(self.key), "a") as f:
                f.write("\n".join(self.text) + "\n")


def blocks_text(content, kinds=("text",)):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") in kinds and isinstance(b.get("text"), str):
            out.append(b["text"])
    return "\n".join(out)


# Claude Code: ~/.claude/projects/<folder>/<session>.jsonl; subagents sit in <session>/subagents/.
def claude(idx, rows):
    for path in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        sid = os.path.basename(path)[:-6]
        t = Tail(idx, path, "claude:" + sid, {})
        s = t.state
        for mm, a, b in t.lines(rb'"type":"(?:user|custom-title|ai-title|summary)"'):
            if mm.find(b'"type":"user"', a, b) >= 0:
                # Tool results are user lines too, the most and the longest: skip them unread.
                if mm.find(b'"tool_result"', a, b) >= 0 or mm.find(b'"isMeta":true', a, b) >= 0 or mm.find(b'"isSidechain":true', a, b) >= 0:
                    continue
                try:
                    o = json.loads(mm[a:b])
                except ValueError:
                    continue
                if o.get("type") != "user":
                    continue
                if not s.get("cwd"):
                    s["cwd"] = o.get("cwd")
                if o.get("gitBranch"):
                    s["branch"] = o["gitBranch"]
                if o.get("entrypoint"):
                    s["entry"] = s.get("entry") or o["entrypoint"]
                text = blocks_text((o.get("message") or {}).get("content"))
                # Hooks' reminders ride along as their own blocks; slash commands, shell escapes
                # and interruptions are tagged and aren't prompts.
                text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S).strip()
                if text and not text.startswith("<") and not text.startswith("[Request interrupted"):
                    t.prompt(text)
            else:
                try:
                    o = json.loads(mm[a:b])
                except ValueError:
                    continue
                if o.get("type") == "custom-title" and o.get("customTitle"):
                    s["named"] = o["customTitle"]
                elif o.get("type") == "ai-title" and o.get("aiTitle"):
                    s["title"] = o["aiTitle"]
                elif o.get("type") == "summary" and o.get("summary"):
                    s.setdefault("title", o["summary"])
        # The model and the time come from the last of what was read, not from every line.
        # (Claude Code's own notes, such as an interruption, are "<synthetic>": step past them.)
        for line in t.last(b'"type":"assistant"', 20):
            m = MODEL.search(line, 0, 4000)
            if m and m.group(1) != b"<synthetic>":
                s["model"] = m.group(1).decode("utf-8", "replace")
                break
        for line in t.last(b'"timestamp":"'):
            m = STAMP.search(line)
            if m:
                s["at"] = max(s.get("at", 0), ms(m.group(1).decode()))
        t.close()
        if not s.get("n") or str(s.get("entry", "")).startswith("sdk"):
            continue
        rows.append(row("claude", sid, s, s.get("named") or s.get("title"), s.get("cwd"), s.get("at") or s["mtime"] * 1000))


# Codex: its own index, the threads table of ~/.codex/state_<n>.sqlite; the prompts for search
# come from ~/.codex/history.jsonl.
def codex(idx, rows):
    dbs = sorted(glob.glob(os.path.join(HOME, ".codex", "state_*.sqlite")), key=lambda p: int(re.sub(r"\D", "", os.path.basename(p)) or 0))
    if not dbs:
        return
    texts = {}
    hist = os.path.join(HOME, ".codex", "history.jsonl")
    if os.path.exists(hist):
        t = Tail(idx, hist, "codex-history", {"counts": {}})
        for mm, a, b in t.lines(rb'"session_id"'):
            try:
                o = json.loads(mm[a:b])
            except ValueError:
                continue
            sid, text = o.get("session_id"), one_line(o.get("text"))
            if sid and text:
                t.state["counts"][sid] = t.state["counts"].get(sid, 0) + 1
                texts.setdefault(sid, []).append(text[:PROMPT_CAP])
        t.close()
        counts = t.state["counts"]
    else:
        counts = {}
    con = sqlite3.connect("file:%s?mode=ro" % dbs[-1], uri=True, timeout=2)
    try:
        cols = {r[1] for r in con.execute("pragma table_info(threads)")}
        want = [c for c in ("id", "cwd", "title", "first_user_message", "model", "updated_at", "updated_at_ms", "git_branch") if c in cols]
        q = "select %s from threads where archived = 0 and source in ('cli', 'vscode')" % ", ".join(want)
        for r in con.execute(q):
            d = dict(zip(want, r))
            sid = d["id"]
            first = one_line(d.get("first_user_message"))
            if not first and not counts.get(sid):
                continue
            s = {"first": first[:SNIP], "model": d.get("model"), "branch": d.get("git_branch"), "n": counts.get(sid)}
            title = one_line(d.get("title"))
            updated = d.get("updated_at_ms") or (d.get("updated_at") or 0) * 1000
            rows.append(row("codex", sid, s, title if title and title != first else None, d.get("cwd"), updated))
            if sid in texts or first:
                key = "codex:" + sid
                p = text_path(key)
                new = not os.path.exists(p)
                if new or sid in texts:
                    os.makedirs(TEXT, exist_ok=True)
                    with open(p, "a") as f:
                        f.write("\n".join(([first] if new and first else []) + texts.get(sid, [])) + "\n")
                idx.seen.add(p)
                idx.files.setdefault(p, {"key": key})
    finally:
        con.close()


def kiro_prompt(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if isinstance(b, dict):
            v = b.get("data") if b.get("kind") == "text" else b.get("text") if b.get("type") == "text" else None
            if isinstance(v, str):
                out.append(v)
    return "\n".join(out)


def kiro_meta(idx, path):
    """A Kiro session's own JSON, parsed again only when it changes."""
    st = os.stat(path)
    old = idx.files.get(path)
    sig = [int(st.st_mtime * 1000), st.st_size]
    idx.seen.add(path)
    if old and old.get("sig") == sig:
        return old["meta"]
    try:
        with open(path) as f:
            d = json.load(f)
    except Exception:
        d = {}
    idx.files[path] = {"sig": sig, "meta": trim_kiro(d)}
    idx.dirty = True
    return idx.files[path]["meta"]


def trim_kiro(d):
    info = ((d.get("session_state") or {}).get("rts_model_state") or {}).get("model_info") or {}
    paths = d.get("rootPaths") or d.get("workspacePaths") or []
    return {
        "cwd": d.get("cwd") or (paths[0] if paths else None),
        "title": d.get("title"),
        "updated": d.get("updated_at") or d.get("lastModifiedAt"),
        "model": info.get("model_id") or d.get("modelId"),
    }


# Kiro: v3 sessions in ~/.kiro/sessions/<folder hash>/sess_*/ (session.json, messages.jsonl);
# v2 sessions in ~/.kiro/sessions/cli/<id>.json with <id>.jsonl.
def kiro(idx, rows):
    base = os.path.join(HOME, ".kiro", "sessions")
    for d in glob.glob(os.path.join(base, "*", "sess_*")):
        sid = os.path.basename(d)
        meta_p, msgs = os.path.join(d, "session.json"), os.path.join(d, "messages.jsonl")
        if not (os.path.exists(meta_p) and os.path.exists(msgs)):
            continue
        meta = kiro_meta(idx, meta_p)
        t = Tail(idx, msgs, "kiro:" + sid, {})
        for mm, a, b in t.lines(rb'"type":"user"'):
            # {"payload":{"type":"user","content":"<text>" | [{"type":"text","text":"<text>"}]}}
            text = first_text(mm, a, b, (b'"type":"user","content":', b'"type":"text","text":'))
            if text is not None:
                t.prompt(text)
                continue
            try:
                p = json.loads(mm[a:b]).get("payload") or {}
            except ValueError:
                continue
            if p.get("type") == "user":
                t.prompt(kiro_prompt(p.get("content")))
        t.close()
        if t.state.get("n"):
            title = meta.get("title")
            s = dict(t.state, model=meta.get("model"), engine="v3")
            rows.append(row("kiro", sid, s, None if title in (None, "New Session") else title, meta.get("cwd"), ms(meta.get("updated")) or t.state["mtime"] * 1000))
    for meta_p in glob.glob(os.path.join(base, "cli", "*.json")):
        sid = os.path.basename(meta_p)[:-5]
        msgs = meta_p[:-5] + ".jsonl"
        if not os.path.exists(msgs):
            continue
        meta = kiro_meta(idx, meta_p)
        t = Tail(idx, msgs, "kiro:" + sid, {})
        for mm, a, b in t.lines(rb'"kind":"Prompt"'):
            # {"kind":"Prompt","data":{"content":[{"kind":"text","data":"<text>"}, ...]}}
            text = first_text(mm, a, b, (b'"kind":"text","data":',))
            if text is not None:
                t.prompt(text)
                continue
            try:
                o = json.loads(mm[a:b])
            except ValueError:
                continue
            if o.get("kind") == "Prompt":
                t.prompt(kiro_prompt((o.get("data") or {}).get("content")))
        t.close()
        if t.state.get("n"):
            s = dict(t.state, model=meta.get("model"), engine="v2")
            rows.append(row("kiro", sid, s, meta.get("title"), meta.get("cwd"), ms(meta.get("updated")) or t.state["mtime"] * 1000))


REAL = {}


def real(cwd):
    """The folder with symlinks resolved (/home -> /local/home on a dev desktop), as git and
    `pwd -P` give a space's folder; as recorded when it no longer exists."""
    if cwd and cwd not in REAL:
        REAL[cwd] = os.path.realpath(cwd) if os.path.isdir(cwd) else cwd
    return REAL.get(cwd, cwd)


def row(agent, sid, s, title, cwd, updated):
    cwd = real(cwd)
    r = {"agent": agent, "id": sid, "title": one_line(title)[:SNIP] or None, "first": s.get("first"), "last": s.get("last"),
         "cwd": cwd, "updated": int(updated or 0), "model": s.get("model"), "prompts": s.get("n"), "branch": s.get("branch")}
    if s.get("engine"):
        r["engine"] = s["engine"]
    return r


def scan():
    idx = Index()
    rows, errors = [], []
    for name, fn in (("claude", claude), ("codex", codex), ("kiro", kiro)):
        try:
            fn(idx, rows)
        except Exception as e:  # one agent's surprise shouldn't hide the others
            errors.append("%s: %s" % (name, e))
    try:
        idx.save()
    except Exception as e:
        errors.append("cache: %s" % e)
    for r in rows:
        if scripted(r):
            r["scripted"] = True
    rows.sort(key=lambda r: -r["updated"])
    return rows, errors


def run(argv, cwd):
    try:
        r = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
    except FileNotFoundError:
        raise RuntimeError("%s isn't on this machine's PATH" % argv[0])
    lines = [x for x in (r.stderr + "\n" + r.stdout).splitlines() if x.strip() and not x.startswith("[")]
    if r.returncode != 0:
        raise RuntimeError(lines[-1] if lines else "%s exited %d" % (argv[0], r.returncode))


def delete(agent, sid, engine, cwd):
    """Deletes one session for good: Codex and Kiro with their own commands (which also fix their
    indexes), Claude Code (which has none per session) by removing what `claude purge` would."""
    if not ID.match(sid):
        raise ValueError("not a session id: %r" % sid)
    where = cwd if cwd and os.path.isdir(cwd) else HOME
    if agent == "claude":
        claude_dir = os.path.join(HOME, ".claude")
        found = glob.glob(os.path.join(claude_dir, "projects", "*", sid + ".jsonl"))
        if not found:
            raise RuntimeError("no Claude Code session %s here" % sid)
        for p in found + glob.glob(os.path.join(claude_dir, "projects", "*", sid)) + [
                os.path.join(claude_dir, d, sid) for d in ("file-history", "session-env", "tasks")] + glob.glob(os.path.join(claude_dir, "todos", sid + "-*")):
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            elif os.path.lexists(p):
                os.remove(p)
    elif agent == "codex":
        run(["codex", "delete", "--force", sid], where)
    elif agent == "kiro":
        base = os.path.join(HOME, ".kiro", "sessions")
        left = lambda: glob.glob(os.path.join(base, "*", sid)) if engine == "v3" else [p for p in [os.path.join(base, "cli", sid + ".json")] if os.path.exists(p)]
        if not left():
            raise RuntimeError("no Kiro session %s here" % sid)
        run(["kiro-cli", "chat", "--agent-engine", "v3" if engine == "v3" else "v2", "--delete-session", sid], where)
        # It says "Deleted" whatever happened.
        if left():
            raise RuntimeError("kiro-cli didn't delete it")
    else:
        raise ValueError("unknown agent %r" % agent)


def main():
    start = time.time()
    args = sys.argv[1:]
    action = args[0] if args else "list"
    if action == "delete":
        try:
            delete(*(args[1:5] + [""] * (5 - len(args)))[:4])
            out = {"ok": True}
        except Exception as e:
            out = {"error": str(e)}
        sys.stdout.write(json.dumps(out))
        return
    rows, errors = scan()
    mine = [r for r in rows if not r.get("scripted")]
    bots = [r for r in rows if r.get("scripted")]
    out = {"home": HOME, "total": len(mine), "scripted": len(bots), "errors": errors, "partial": partial}
    if action == "search":
        words = [w for w in " ".join(args[1:]).lower().split() if w]
        hits = []
        for r in mine + bots:
            key = "%s:%s" % (r["agent"], r["id"])
            hay = " ".join(x or "" for x in (r["title"], r["cwd"], r["model"], r["branch"], r["id"])).lower()
            if not all(w in hay for w in words):
                try:
                    with open(text_path(key), errors="replace") as f:
                        hay += " " + f.read().lower()
                except OSError:
                    pass
            if all(w in hay for w in words):
                hits.append(r)
                if len(hits) >= SEARCH_LIMIT:
                    break
        out["rows"] = hits
    else:
        out["rows"] = (mine + (bots if "--scripted" in args else []))[:LIST_LIMIT]
        # Nothing new since the caller's copy: say so instead of sending it all again.
        out["sig"] = hashlib.md5(json.dumps(out["rows"], separators=(",", ":")).encode()).hexdigest()
        if "--since" in args and args[args.index("--since") + 1:][:1] == [out["sig"]] and not partial:
            del out["rows"]
            out["same"] = True
    out["ms"] = int((time.time() - start) * 1000)
    sys.stdout.write(json.dumps(out, separators=(",", ":")))


main()
