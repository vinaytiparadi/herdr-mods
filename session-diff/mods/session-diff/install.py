#!/usr/bin/env python3
# Puts the Diff and Sessions panels (the mods session-diff and sessions, whichever are in mods/) into
# Herdr's tab bar. Both mods carry this same file; run either copy, and again after adding the other mod.
# Herdr's own layouts and mods are read-only, so this makes copies of this Herdr version's shipped ones:
#   mods/my-tabs          the tabs mod, with a Diff and/or a Sessions button after Changes
#   layouts/my-herdr.json the main layout, using my-tabs, with those panels in its side panel
# and adds their keys to keys.json where the key is free (Sessions popup, Diff dialog, Diff's copy keys).
#
# Run it once to install (it switches the window to my-herdr), and again whenever Herdr updates:
# my-tabs runs it by itself on the first start of a new version. When a new tab bar or layout no
# longer fits the edits, it changes nothing, says why and exits 1; the old copies keep working.
#   python3 ~/.config/herdr-app/mods/<sessions or session-diff>/install.py [--version <herdr version>]
import json
import os
import re
import shutil
import subprocess
import sys

HOME = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")
MODS, LAYOUTS = os.path.join(HOME, "mods"), os.path.join(HOME, "layouts")
TABS, LAYOUT = "my-tabs", "my-herdr"
MAC = sys.platform == "darwin"
MOD = "cmd" if MAC else "ctrl"
# Each mod: its tab-bar button (label, icon), its side-panel block and its keys.
PANELS = {
    "session-diff": {"label": "Diff", "icon": "mods/session-diff/diff.svg",
                     "block": {"id": "session-diff", "type": "block", "content": {"mod": "session-diff", "props": {"panel": True}}},
                     "keys": {"global": {MOD + "-shift-g": "mod.open:session-diff"},
                              "mod:session-diff": {MOD + "-c": "session-diff.copy", MOD + "-shift-c": "session-diff.copy-patch",
                                                   MOD + "-a": "session-diff.all"}}},
    "sessions": {"label": "Sessions", "icon": "mods/sessions/sessions.svg",
                 "block": {"id": "sessions", "type": "block", "content": {"mod": "sessions"}},
                 "keys": {"global": {MOD + "-shift-s": "mod.open:sessions"}}},
}
# Added to my-tabs: on the first start of another Herdr version, it runs this file again.
RESYNC = '''
// Added by install.py (in mods/sessions or mods/session-diff): after a Herdr update this copy re-makes itself.
function resync(cx) {
  cx.spawn(async () => {
    const now = updates().app.version;
    const mine = JSON.parse((await readTextFile(`${appHome()}/mods/my-tabs/mod.json`)) ?? "{}").cloned_from?.version;
    if (!now || !mine || mine === now) return;
    let script = null;
    for (const m of ["sessions", "session-diff"]) {
      const p = `${appHome()}/mods/${m}/install.py`;
      if (!script && (await readTextFile(p)) != null) script = p;
    }
    if (!script) return;
    const r = await exec("python3", [script, "--version", now]);
    if (r.code !== 0) notify({ title: "Diff and Sessions stay on the old tab bar", body: (r.stdout + r.stderr).trim().split("\\n").pop(), level: "warning" });
  });
}
'''


class Misfit(Exception):
    pass


def once(text, pattern, repl, what):
    out, n = re.subn(pattern, repl, text, count=1, flags=re.M)
    if n != 1:
        raise Misfit("the new tab bar has no %s" % what)
    return out


def herdr():
    for p in (shutil.which("herdr-app"), os.path.expanduser("~/.local/bin/herdr-app"), "/Applications/Herdr.app/Contents/MacOS/Herdr"):
        if p and os.path.exists(p):
            return p
    raise Misfit("herdr-app isn't installed")


def cli(*args):
    return subprocess.run([herdr(), *args], env=dict(os.environ, HERDR_APP_HOME=HOME), stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, universal_newlines=True, timeout=60)


def present():
    """The panel mods that are installed, in tab-bar order."""
    have = [m for m in PANELS if os.path.isfile(os.path.join(MODS, m, "main.js"))]
    if not have:
        raise Misfit("neither session-diff nor sessions is in %s" % MODS)
    return have


def tabs_mod(version, mods):
    """The shipped tabs mod with the buttons and the resync, as {file: text}."""
    src = os.path.join(MODS, "tabs")
    files = {}
    for name in os.listdir(src):
        with open(os.path.join(src, name), encoding="utf-8") as f:
            text = f.read()
        files[name] = text.replace("mods/tabs/", "mods/%s/" % TABS)
    js = files["main.js"]
    js = once(js, r'const enabled = (shared\("workspace\.panels"\) \?\? \[[^\]]*\]);',
              lambda m: '// %s (mods/%s) always on, after the panels the welcome chose.\n'
                        '    const enabled = [...(%s), %s];' % (" and ".join(PANELS[x]["label"] for x in mods), ", mods/".join(mods),
                                                          m.group(1), ", ".join('"%s"' % x for x in mods)), "panel list")
    js = once(js, r'^(\s*)(\.when\(enabled\.includes\("changes"\).*\n)',
              lambda m: m.group(1) + m.group(2) + "".join('%s.child(panelButton("%s", "%s", "%s"))\n'
                                                          % (m.group(1), x, PANELS[x]["label"], PANELS[x]["icon"]) for x in mods),
              "Changes button")
    m = re.search(r'^import \{([^}]*)\} from "herdr";', js, re.M)
    if not m:
        raise Misfit("the new tab bar doesn't import from herdr")
    names = [n.strip() for n in m.group(1).split(",") if n.strip()]
    names += [n for n in ("readTextFile", "appHome", "updates", "exec", "notify") if n not in names]
    js = js[:m.start()] + 'import { %s } from "herdr";' % ", ".join(names) + js[m.end():]
    js = once(js, r'^export default class ', lambda _m: RESYNC.lstrip("\n") + "\nexport default class ", "mod class")
    m = re.search(r'^  init\(([^)]*)\) \{\n', js, re.M)
    if not m:
        raise Misfit("the new tab bar has no init()")
    params = [p.strip() for p in m.group(1).split(",") if p.strip()]
    if len(params) < 2:
        params = (params + ["_props"])[:1] + ["cx"]
    js = js[:m.start()] + "  init(%s) {\n    resync(%s);\n" % (", ".join(params), params[1]) + js[m.end():]
    files["main.js"] = js
    meta = json.loads(files.get("mod.json", "{}"))
    meta["cloned_from"] = {"name": "tabs", "version": version}
    files["mod.json"] = json.dumps(meta, indent=2) + "\n"
    return files


def main_layout(version, mods):
    with open(os.path.join(LAYOUTS, "main.json"), encoding="utf-8") as f:
        tree = json.load(f)
    found = {"tabs": 0, "body": 0}

    def walk(n):
        if n.get("type") == "block" and (n.get("content") or {}).get("mod") == "tabs":
            n["content"]["mod"] = TABS
            found["tabs"] += 1
        if n.get("id") == "panel-body":
            have = {c.get("id") for c in n.get("children", [])}
            for block in (PANELS[x]["block"] for x in mods):
                if block["id"] not in have:
                    n.setdefault("children", []).append(block)
            found["body"] += 1
        for c in n.get("children", []):
            walk(c)

    walk(tree)
    if found["tabs"] != 1 or found["body"] != 1:
        raise Misfit("the new main layout has no tab bar block or side panel (panel-body)")
    tree["cloned_from"] = {"name": "main", "version": version}
    return json.dumps(tree, indent=2) + "\n"


def write(path, text):
    tmp = path + ".install-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def keys(mods):
    path = os.path.join(HOME, "keys.json")
    try:
        with open(path, encoding="utf-8") as f:
            have = json.load(f)
    except FileNotFoundError:
        return "keys.json isn't there yet (start Herdr once); keys not added"
    added = []
    for section, binds in ((s, b) for x in mods for s, b in PANELS[x]["keys"].items()):
        sec = have.setdefault(section, {})
        for key, action in binds.items():
            if key not in sec:
                sec[key] = action
                added.append(key)
    if added:
        write(path, json.dumps(have, indent=2) + "\n")
    return "keys added: %s" % ", ".join(added) if added else "keys already there"


def main():
    args = sys.argv[1:]
    version = args[args.index("--version") + 1] if "--version" in args else cli("--version").stdout.split()[-1]
    first = not os.path.exists(os.path.join(LAYOUTS, LAYOUT + ".json"))
    # Everything is made before anything is written, so a misfit changes nothing.
    mods = present()
    files, layout_text = tabs_mod(version, mods), main_layout(version, mods)

    new, old, live = os.path.join(MODS, "." + TABS + "-new"), os.path.join(MODS, "." + TABS + "-old"), os.path.join(MODS, TABS)
    for p in (new, old):
        shutil.rmtree(p, ignore_errors=True)
    os.makedirs(new)
    for name, text in files.items():
        write(os.path.join(new, name), text)
    r = cli("check", new)
    if r.returncode != 0:
        shutil.rmtree(new, ignore_errors=True)
        raise Misfit("the new my-tabs doesn't load: %s" % r.stdout.strip().splitlines()[-1:])
    if os.path.exists(live):
        os.rename(live, old)
    os.rename(new, live)
    shutil.rmtree(old, ignore_errors=True)
    write(os.path.join(LAYOUTS, LAYOUT + ".json"), layout_text)
    print("my-tabs and my-herdr made from Herdr %s with %s; %s" % (version, " and ".join(PANELS[x]["label"] for x in mods), keys(mods)))
    if first:
        cli("do", "layout.switch", json.dumps({"name": LAYOUT}))


try:
    main()
except (Misfit, OSError, ValueError, subprocess.SubprocessError) as e:
    print("Nothing changed: %s." % e)
    sys.exit(1)
