# Diff: baselines a folder's text files, then lists what changed in them since.
# sh -c "$script" session-diff <folder> <status|snapshot|delete|drop|patch> [baseline id] [baseline.py code].
# drop deletes a baseline and prints only the history (for one that isn't being compared with).
# survey prints the history, home <dir>, then for every baseline id <id>, total <n> and its changes.
# Runs on the folder's machine. A folder keeps a history of baselines, each in a folder named by when
# it was taken; status compares with the id given, else the newest. Prints tab-separated lines:
# base <id> <taken> <files> (the history, oldest first), snap <dir>, id <id>, taken <epoch>, none,
# error <text>, total <n>, then one <A|D|M> <added> <deleted> <path> per change. patch prints,
# instead, F <A|D|M> <path> before each changed file's diff (from its first @@).
# With python3 and baseline.py's code, the per-file work happens there (much faster); else in sh.
dir=$1
action=$2
want=$3
code=$4
limit=20000   # text files in a baseline
limit_mb=50   # their size, only where the disk can't clone them (a real copy)
[ -n "$HOME" ] || { echo "error	HOME is not set"; exit 0; }
base="$HOME/.cache/herdr-session-diff"
home="$base/$(printf %s "$dir" | cksum | awk '{print $1 "-" $2}')"
case $want in *[!0-9]*) want= ;; esac
cd "$dir" 2>/dev/null || { echo "error	Folder not found: $dir"; exit 0; }

# Regular files under 1 MiB, skipping VCS, dependency, environment and build output folders (a
# build workspace's env/ alone can be hundreds of thousands of files; its code is in src/).
files() {
  find . \( -name .git -o -name .hg -o -name .svn -o -name node_modules -o -name .venv -o -name venv \
    -o -name env -o -name __pycache__ -o -name .gradle -o -name .idea -o -name build -o -name target \
    -o -name dist -o -name .next -o -name .cache -o -name .DS_Store -o -name .brazil -o -name .bemol \
    -o -name cdk.out -o -name .terraform -o -name .tox -o -name .mypy_cache -o -name .pytest_cache \
    -o -name .ruff_cache \) -prune -o -type f -size -1024k "$@" -print
}

# python3, where it's there and won't ask for anything: on macOS, /usr/bin/python3 without the
# Command Line Tools asks to install them.
py=
if [ -n "$code" ] && command -v python3 >/dev/null 2>&1; then
  if [ "$(uname)" != Darwin ] || [ "$(command -v python3)" != /usr/bin/python3 ] || xcode-select -p >/dev/null 2>&1; then py=1; fi
fi
python() { python3 -I -c "$code" "$@"; }

# Without python3: the text files among the paths on stdin (grep -I in the C locale: a NUL makes a
# file binary; empty files are text).
text() {
  tr '\n' '\0' | LC_ALL=C xargs -0 sh -c '[ $# -gt 0 ] || exit 0
    for f; do [ -s "$f" ] || printf "%s\n" "$f"; done
    grep -Il "" "$@"' text 2>/dev/null
}

# Without python3: copies the files listed in $1 into $2, cloning them where the disk can.
copy() {
  listf=$1 dest=$2
  if cp --help 2>&1 | grep -q reflink; then
    tr '\n' '\0' < "$listf" | xargs -0 sh -c '[ $# -gt 0 ] || exit 0; d=$0; exec cp --reflink=auto --parents -t "$d" "$@"' "$dest"
    return
  fi
  # macOS: cp -c clones, but has no --parents: make the folders, then copy a folder's files at a time.
  sed 's|/[^/]*$||' "$listf" | sort -u | (cd "$dest" && tr '\n' '\0' | xargs -0 mkdir -p 2>/dev/null)
  last= ; set --
  while IFS= read -r f; do
    if [ "${f%/*}" != "$last" ] || [ $# -ge 200 ]; then
      [ $# -gt 0 ] && { cp -c "$@" "$dest/$last/" 2>/dev/null || cp "$@" "$dest/$last/"; }
      set --; last=${f%/*}
    fi
    set -- "$@" "$f"
  done < "$listf"
  [ $# -gt 0 ] && { cp -c "$@" "$dest/$last/" 2>/dev/null || cp "$@" "$dest/$last/"; }
}

# Built-ins only: this runs on every refresh.
history() {
  for d in "$home"/*/; do
    [ -f "$d/taken" ] || continue
    read -r t < "$d/taken"; n=0
    if [ -f "$d/count" ]; then read -r n < "$d/count"; else n=$(wc -l < "$d/list" | tr -d ' '); fi
    d=${d%/}
    printf 'base\t%s\t%s\t%s\n' "${d##*/}" "$t" "$n"
  done
}

# A folder with one baseline straight inside it (before there was a history) makes that its first.
if [ -f "$home/taken" ]; then
  old=$(cat "$home/taken")
  mkdir -p "$home/$old" && mv "$home/tree" "$home/list" "$home/all" "$home/stamp" "$home/taken" "$home/$old/" 2>/dev/null
  rm -f "$home/now" "$home/changes"
fi

# Deleting moves the baseline aside at once; the files go in the background.
if [ "$action" = delete ] || [ "$action" = drop ]; then
  [ -n "$want" ] && [ -d "$home/$want" ] && mv "$home/$want" "$home/.gone-$want-$$"
  want=
fi
for g in "$home"/.gone-*; do [ -e "$g" ] && { nohup rm -rf "$home"/.gone-* >/dev/null 2>&1 & } ; break; done
[ "$action" = drop ] && { history; exit 0; }

if [ "$action" = snapshot ]; then
  case $dir in
    "$HOME" | "$HOME/" | /) echo "error	Pick a project folder: your home folder is too big to baseline"; exit 0 ;;
  esac
  big="error	${dir##*/} has over $limit_mb MB of text and this disk can't clone files: focus a terminal in a project folder"
  many="error	${dir##*/} has over $limit text files, too many to baseline: focus a terminal in a project folder"
  new="$home/.new"
  rm -rf "$new" && mkdir -p "$new" || { echo "error	Cannot write $base"; exit 0; }
  touch "$new/stamp"
  # Stops listing past the limit, so an oversized folder is refused at once.
  files | head -n $((limit * 5 + 1)) > "$new/found"
  [ "$(wc -l < "$new/found")" -le $((limit * 5)) ] || { rm -rf "$new"; echo "error	${dir##*/} has over $((limit * 5)) files, too many to baseline: focus a terminal in a project folder"; exit 0; }
  LC_ALL=C sort "$new/found" > "$new/all"; rm -f "$new/found"
  if [ -n "$py" ]; then
    # The newest baseline is where this one starts from: only what changed since is copied.
    prev=
    for d in "$home"/*/; do [ -f "$d/list" ] && prev=${d%/}; done
    python snapshot "$new" "$prev" $((limit_mb * 1024 * 1024)) "$limit" < "$new/all"
    rc=$?
    [ "$rc" = 4 ] && { rm -rf "$new"; echo "$many"; exit 0; }
    [ "$rc" = 3 ] && { rm -rf "$new"; echo "$big"; exit 0; }
    [ "$rc" = 0 ] || { rm -rf "$new"; echo "error	Taking the baseline failed (python3 exited $rc)"; exit 0; }
  else
    mkdir -p "$new/tree"
    text < "$new/all" | LC_ALL=C sort > "$new/list"
    [ "$(wc -l < "$new/list")" -le "$limit" ] || { rm -rf "$new"; echo "$many"; exit 0; }
    first=$(head -n 1 "$new/list")
    if [ -n "$first" ] && ! { cp --reflink=always "$first" "$new/probe" 2>/dev/null || cp -c "$first" "$new/probe" 2>/dev/null; }; then
      kb=$(tr '\n' '\0' < "$new/list" | xargs -0 du -k 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')
      [ "$kb" -le $((limit_mb * 1024)) ] || { rm -rf "$new"; echo "$big"; exit 0; }
    fi
    rm -f "$new/probe"
    copy "$new/list" "$new/tree"
  fi
  wc -l < "$new/list" | tr -d ' ' > "$new/count"
  printf %s "$dir" > "$home/folder"
  taken=$(date +%s); id=$taken
  while [ -e "$home/$id" ]; do id=$((id + 1)); done
  echo "$taken" > "$new/taken"
  mv "$new" "$home/$id"
  history
  # Just taken: nothing has changed yet, so no comparison (the next refresh makes one).
  printf 'snap\t%s\nid\t%s\ntaken\t%s\ntotal\t0\n' "$home/$id" "$id" "$taken"
  touch "$home/used"
  # Folders whose baselines nobody looked at for 30 days go.
  for old in "$base"/*/; do
    [ -f "$old/used" ] && [ -n "$(find "$old/used" -mtime +30)" ] && { nohup rm -rf "$old" >/dev/null 2>&1 & }
  done
  exit 0
fi

# The history, oldest first; the one to compare with is the id asked for, else the newest.
history
if [ "$action" = survey ]; then
  echo "home	$home"
  [ -n "$py" ] || exit 0
  set --
  for d in "$home"/*/; do [ -f "$d/list" ] && set -- "$@" "${d%/}"; done
  [ $# -gt 0 ] && files | python survey "$@"
  exit 0
fi
snap=
for d in "$home"/*/; do [ -f "$d/taken" ] && snap=${d%/}; done
[ -n "$want" ] && [ -f "$home/$want/taken" ] && snap="$home/$want"
[ -n "$snap" ] || { echo none; exit 0; }
touch "$home/used"
echo "snap	$snap"
echo "id	${snap##*/}"
echo "taken	$(cat "$snap/taken")"

if [ -n "$py" ] && [ -f "$snap/list" ]; then
  files | python status "$snap" > "$snap/result" || { echo "error	Comparing failed"; exit 0; }
  if [ "$action" != patch ]; then cat "$snap/result"; exit 0; fi
  head -n 1 "$snap/result"
else
  [ -f "$snap/all" ] || cp "$snap/list" "$snap/all"
  files | LC_ALL=C sort > "$snap/now"
  {
    # New files count when they're text; binaries never do.
    LC_ALL=C comm -13 "$snap/all" "$snap/now" | text | LC_ALL=C sort | sed 's/^/A	/'
    LC_ALL=C comm -23 "$snap/list" "$snap/now" | sed 's/^/D	/'
    # Only files written since the baseline can differ from it; cmp confirms.
    files -newer "$snap/stamp" | while IFS= read -r f; do
      [ -f "$snap/tree/$f" ] && ! cmp -s "$snap/tree/$f" "$f" && printf 'M\t%s\n' "$f"
    done
  } > "$snap/changes"
  echo "total	$(wc -l < "$snap/changes" | tr -d ' ')"
  if [ "$action" != patch ]; then
    head -n 1000 "$snap/changes" | while IFS='	' read -r kind f; do
      case $kind in
        A) a=/dev/null; b=$f ;;
        D) a=$snap/tree/$f; b=/dev/null ;;
        *) a=$snap/tree/$f; b=$f ;;
      esac
      stat=$(git diff --no-index --numstat -- "$a" "$b" 2>/dev/null | head -n 1 | cut -f 1-2)
      [ -n "$stat" ] || stat="0	0"
      printf '%s\t%s\t%s\n' "$kind" "$stat" "$f"
    done
    exit 0
  fi
fi

# patch: every changed file's diff, each after an F line.
head -n 300 "$snap/changes" | while IFS='	' read -r kind f; do
  case $kind in
    A) a=/dev/null; b=$f ;;
    D) a=$snap/tree/$f; b=/dev/null ;;
    *) a=$snap/tree/$f; b=$f ;;
  esac
  printf 'F\t%s\t%s\n' "$kind" "${f#./}"
  git diff --no-index --no-color --no-ext-diff --no-textconv -U3 -- "$a" "$b" 2>/dev/null \
    | awk 'on || /^@@/ { on = 1; print } END { if (!on) print "\\ No text diff (binary, or only its mode changed)" }'
done | head -n 20000
