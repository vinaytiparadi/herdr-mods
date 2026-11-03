#!/bin/sh
# Installs the Diff and/or Sessions mods into a stock Herdr app and puts their buttons in the tab bar.
#   ./install.sh                  both
#   ./install.sh session-diff     just Diff
#   ./install.sh sessions         just Sessions
# Safe to re-run: it replaces the mod folders (the old ones are kept in a backup) and rebuilds
# my-tabs / my-herdr from the installed Herdr's own tab bar and layout, with every mod that's installed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
if [ ! -d "$home/mods" ]; then
  echo "No $home/mods: install Herdr and start it once first (or set HERDR_APP_HOME)." >&2
  exit 1
fi
command -v python3 >/dev/null || { echo "python3 is needed." >&2; exit 1; }
[ $# -gt 0 ] || set -- session-diff sessions

backup=$HOME/.cache/herdr-mods-backup/$(date +%Y%m%d-%H%M%S)
for m in "$@"; do
  case $m in session-diff|sessions) ;; *) echo "Unknown mod: $m (session-diff or sessions)" >&2; exit 1 ;; esac
  if [ -e "$home/mods/$m" ]; then
    mkdir -p "$backup"
    mv "$home/mods/$m" "$backup/$m"
  fi
  cp -R "$here/$m/mods/$m" "$home/mods/$m"
done
[ -d "$backup" ] && echo "Previous copies moved to $backup"

HERDR_APP_HOME=$home python3 "$home/mods/$1/install.py"
