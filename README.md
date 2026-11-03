# herdr-mods

Two personal mods for the [Herdr](https://herdr.dev) app, plus an installer that adds them to a stock Herdr:

- **Diff** ([`session-diff/`](session-diff/RECIPE.md)): shows what an agent changed in any folder, including folders that aren't git repos. It
  compares against snapshot baselines and has syntax highlighting, a side-by-side view and a baseline history.
- **Sessions** ([`sessions/`](sessions/RECIPE.md)): lists Claude Code, Codex and Kiro sessions on every machine Herdr knows. You can
  resume, fork or delete them.

## Works on every machine, nothing to install

Both mods work on remote machines too, not just this computer. Diff follows a terminal's folder wherever that folder is,
and Sessions lists the sessions on every machine you've added to Herdr. Neither needs anything installed: no Atuin, no
daemon, no package, on this computer or the others. Their scripts are sent along each time and run with tools the
machines already have:
- **Diff:** `sh`, `python3` and `git`. Git is used only as a diff tool; the folder doesn't need to be a repo.
- **Sessions:** `python3` 3.9 or newer. To delete Codex or Kiro sessions it uses their own CLIs (`codex`, `kiro-cli`),
  which are there if you use those agents.

## Using Diff

Diff shows the folder of the focused terminal. The first time it sees a folder, it saves a baseline, and every change
made after that shows up. **New baseline** starts a fresh comparison, and the `since …` menu switches to an older baseline
or deletes one.

**As a side panel:** click **Diff** in the tab bar, top right. Click it again to hide the panel. It stays next to your
terminals and updates as files change. Drag the panel's edge to make it wider; from about 760px it shows the file list and
the diff side by side, as the dialog does.

![Diff in the side panel](screenshots/diff-panel.png)

**As a separate dialog:** press `cmd-shift-g` (`ctrl-shift-g` on Linux) to open Diff as a large window over everything.
Press it again, press `Esc` or click `×` to close it.

![Diff as a dialog](session-diff/preview.png)

Inside Diff:
- Pick a file in the list, or **All changes**. **Diff**, **Before** and **After** choose what's shown, and the grid
  button next to them switches between unified and side-by-side. Side by side, each half takes half the width and the
  code in both scrolls sideways together.

![Diff side by side](screenshots/diff-split.png)

- `cmd-c` copies the selection, `cmd-shift-c` copies the patch, and `cmd-a` selects all.
- Drag to select text, double-click to select a word, and triple-click to select a line.

From a script or an agent:

```sh
herdr-app do layout.select --stack panel-body --child session-diff && herdr-app do layout.show --id panel  # side panel
herdr-app do layout.hide --id panel                                                                        # hide it
herdr-app do mod.open '{"name":"session-diff"}'                                                            # dialog (again: close)
```

## Using Sessions

Click **Sessions** in the tab bar to open it as a side panel, or press `cmd-shift-s` (`ctrl-shift-s` on Linux) to open
it as a popup. The tabs choose the scope: the current folder, this computer, or all machines. Click a session to
resume it in a new tab, or shift-click to fork it. Hover a session for its delete button.

![Sessions popup, session names blurred](sessions/preview.png)

## Install

Requires Herdr 0.1.10 or newer (started at least once) and `python3`.

```sh
git clone https://github.com/vinaytiparadi/herdr-mods.git ~/herdr-mods   # gh repo clone vinaytiparadi/herdr-mods works too
~/herdr-mods/install.sh                 # both; or: install.sh session-diff / install.sh sessions
```

Each mod is also a folder in Herdr's mod-sharing format (`RECIPE.md`, `preview.png`, `keys.json`, `mods/<name>/`), so an
agent can add one the way herdr.dev/mods describes: copy `mods/<name>/`, merge `keys.json`, then run that mod's
`install.py` to get the tab-bar button.

What `install.sh` does, under `~/.config/herdr-app` (or `$HERDR_APP_HOME`):

1. Copies `session-diff/mods/session-diff` and/or `sessions/mods/sessions` into `mods/`. Copies already there are moved to
   `~/.cache/herdr-mods-backup/<time>/`.
2. Runs the mod's `install.py` (both mods carry the same file, which handles whichever mods are installed). Herdr's
   shipped layouts and mods are read-only, so this builds:
   - `mods/my-tabs`: a copy of this Herdr version's `tabs` mod, with Diff and Sessions buttons after Changes.
   - `layouts/my-herdr.json`: a copy of the `main` layout that uses `my-tabs` and has both panels in the side panel.
   - Key bindings in `keys.json`, added only where the key is free: `cmd-shift-s` (Sessions), `cmd-shift-g` (Diff
     dialog) and the copy keys inside Diff.
3. Switches the window to the `my-herdr` layout the first time.

If a new Herdr's tab bar no longer fits the edits, `install.py` changes nothing, says why, and exits 1.

## Herdr updates

Nothing to do. The first time a new Herdr version starts, `my-tabs` notices that its `cloned_from.version` is out of
date and re-runs `install.py`. If that fails you get a warning toast, and the old copies keep working.

## What they touch

Neither mod uses the network. Both run programs and read files outside their own folder:
- **Diff** runs `sh` and `python3` (`snapshot.sh`, `baseline.py`) on the folder's machine. It reads the folder and keeps
  baselines in `~/.cache/herdr-session-diff/` there.
- **Sessions** runs `python3` (`scan.py`) on each machine. It reads `~/.claude/projects`, `~/.codex` and `~/.kiro`, keeps
  an index in `~/.cache/herdr-sessions/`, and deletes a session only when you confirm it (with `codex delete`,
  `kiro-cli … --delete-session`, or by removing a Claude Code session's files).
- **install.py** writes `mods/my-tabs/`, `layouts/my-herdr.json` and new keys in `keys.json`, and runs `herdr-app check`.

## Notes for agents

- The mods run inside the Herdr app on the Mac. Remote machines need nothing installed; the scripts (`snapshot.sh`,
  `baseline.py`, `scan.py`) are sent over with Herdr's `exec(…, {on: machine})`. `scan.py` must stay Python
  3.9-compatible.
- Check a mod after an edit with `HERDR_APP_HOME=~/.config/herdr-app herdr-app check ~/.config/herdr-app/mods/<mod>`.
  It takes one mod folder, not the app home. Saving a file in a mod folder reloads that mod.
- `gpui-kit.d.ts` and `jsconfig.json` are generated by Herdr and gitignored.
- Internal ids stay `session-diff` (commands `session-diff.*`, the layout block, the cache dir) even though the UI says "Diff".

## Publishing local edits back to this repo

The live copies are in `~/.config/herdr-app/mods/`. To push changes made there:

```sh
cd ~/herdr-mods
for m in session-diff sessions; do
  rsync -a --delete --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude __pycache__ \
    ~/.config/herdr-app/mods/$m/ $m/mods/$m/
done
cmp session-diff/mods/session-diff/install.py sessions/mods/sessions/install.py   # keep the two copies identical
git add -A && git commit -m "..." && git push
```

## Uninstall

```sh
herdr-app do layout.switch '{"name":"main"}'
rm -rf ~/.config/herdr-app/mods/{session-diff,sessions,my-tabs} ~/.config/herdr-app/layouts/my-herdr.json
```

Then remove the `mod.open:sessions` and `mod.open:session-diff` keys and the `mod:session-diff` section from
`~/.config/herdr-app/keys.json`.
Baseline and index caches live in `~/.cache/herdr-session-diff` and `~/.cache/herdr-sessions` on each machine.

## License

[MIT](LICENSE)
