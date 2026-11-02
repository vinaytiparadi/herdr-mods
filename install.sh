#!/bin/sh
# Installs the Diff and Sessions mods into a stock Herdr app and puts their buttons in the tab bar.
# Safe to re-run: it replaces the two mod folders (the old ones are kept in a backup) and rebuilds
# my-tabs / my-herdr from the installed Herdr's own tab bar and layout.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
if [ ! -d "$home/mods" ]; then
  echo "No $home/mods: install Herdr and start it once first (or set HERDR_APP_HOME)." >&2
  exit 1
fi
command -v python3 >/dev/null || { echo "python3 is needed." >&2; exit 1; }

backup=$HOME/.cache/herdr-mods-backup/$(date +%Y%m%d-%H%M%S)
for m in session-diff sessions; do
  if [ -e "$home/mods/$m" ]; then
    mkdir -p "$backup"
    mv "$home/mods/$m" "$backup/$m"
  fi
  cp -R "$here/mods/$m" "$home/mods/$m"
done
[ -d "$backup" ] && echo "Previous copies moved to $backup"

HERDR_APP_HOME=$home python3 "$home/mods/sessions/install.py"
