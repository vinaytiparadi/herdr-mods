#!/usr/bin/env python3
# Puts the Diff and Sessions panels (the personal mods session-diff and sessions) into Herdr's tab bar.
# Herdr's own layouts and mods are read-only, so this makes copies of this Herdr version's shipped ones:
#   mods/my-tabs          the tabs mod, with a Diff and a Sessions button after Changes
#   layouts/my-herdr.json the main layout, using my-tabs, with the two panels in its side panel
# and adds their keys to keys.json where the key is free (Sessions popup, Diff's copy keys).
#
# Run it once to install (it switches the window to my-herdr), and again whenever Herdr updates:
# my-tabs runs it by itself on the first start of a new version. When a new tab bar or layout no
# longer fits the edits, it changes nothing, says why and exits 1; the old copies keep working.
#   python3 ~/.config/herdr-app/mods/sessions/install.py [--version <herdr version>]
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
KEYS = {
    "global": {("cmd" if MAC else "ctrl") + "-shift-s": "mod.open:sessions"},
    "mod:session-diff": {("cmd" if MAC else "ctrl") + "-c": "session-diff.copy",
                         ("cmd" if MAC else "ctrl") + "-shift-c": "session-diff.copy-patch",
                         ("cmd" if MAC else "ctrl") + "-a": "session-diff.all"},
}
# Added to my-tabs: on the first start of another Herdr version, it runs this file again.
RESYNC = '''
// Personal (mods/sessions/install.py): after a Herdr update this copy re-makes itself from the new tab bar.
function resync(cx) {
  cx.spawn(async () => {
    const now = updates().app.version;
    const mine = JSON.parse((await readTextFile(`${appHome()}/mods/my-tabs/mod.json`)) ?? "{}").cloned_from?.version;
    if (!now || !mine || mine === now) return;
    const r = await exec("python3", [`${appHome()}/mods/sessions/install.py`, "--version", now]);
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


def tabs_mod(version):
    """The shipped tabs mod with the two buttons and the resync, as {file: text}."""
    src = os.path.join(MODS, "tabs")
    files = {}
    for name in os.listdir(src):
        with open(os.path.join(src, name), encoding="utf-8") as f:
            text = f.read()
        files[name] = text.replace("mods/tabs/", "mods/%s/" % TABS)
    js = files["main.js"]
    js = once(js, r'const enabled = (shared\("workspace\.panels"\) \?\? \[[^\]]*\]);',
              r'// Diff and Sessions (personal mods) are always on, after the panels the welcome chose.\n'
              r'    const enabled = [...(\1), "session-diff", "sessions"];', "panel list")
    js = once(js, r'^(\s*)(\.when\(enabled\.includes\("changes"\).*\n)',
              r'\1\2\1.child(panelButton("session-diff", "Diff", "mods/session-diff/diff.svg"))\n'
              r'\1.child(panelButton("sessions", "Sessions", "mods/sessions/sessions.svg"))\n', "Changes button")
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


def main_layout(version):
    with open(os.path.join(LAYOUTS, "main.json"), encoding="utf-8") as f:
        tree = json.load(f)
    found = {"tabs": 0, "body": 0}

    def walk(n):
        if n.get("type") == "block" and (n.get("content") or {}).get("mod") == "tabs":
            n["content"]["mod"] = TABS
            found["tabs"] += 1
        if n.get("id") == "panel-body":
            have = {c.get("id") for c in n.get("children", [])}
            for block in ({"id": "session-diff", "type": "block", "content": {"mod": "session-diff", "props": {"panel": True}}},
                          {"id": "sessions", "type": "block", "content": {"mod": "sessions"}}):
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


def keys():
    path = os.path.join(HOME, "keys.json")
    try:
        with open(path, encoding="utf-8") as f:
            have = json.load(f)
    except FileNotFoundError:
        return "keys.json isn't there yet (start Herdr once); keys not added"
    added = []
    for section, binds in KEYS.items():
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
    files, layout_text = tabs_mod(version), main_layout(version)

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
    print("my-tabs and my-herdr made from Herdr %s; %s" % (version, keys()))
    if first:
        cli("do", "layout.switch", json.dumps({"name": LAYOUT}))


try:
    main()
except (Misfit, OSError, ValueError, subprocess.SubprocessError) as e:
    print("Nothing changed: %s." % e)
    sys.exit(1)
