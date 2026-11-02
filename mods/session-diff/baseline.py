"""Diff's per-file baseline work, run by snapshot.sh where python3 is: one process for many files.

python3 -c "$code" snapshot <new> <prev> <byte limit> <file limit> < files
    Sorts out the text files (a NUL in the first 8 KiB makes a file binary) and clones them into
    <new>/tree. With a previous baseline <prev>, its tree is cloned whole and only what changed
    since is replaced, so a baseline costs about what listing the folder does. Writes <new>/list
    (the text files) and <new>/meta (each file's stat key and kind, for the next baseline and for
    status). Exits 4 over the file limit, 3 when files had to be really copied past the byte limit.

python3 -c "$code" status <snap> < files
    Writes <snap>/changes (kind, path) and prints total <n>, then <A|D|M> <added> <deleted> <path>.

python3 -c "$code" survey <snap>... < files
    The same for every baseline given, each after an id <id> line: the folder is read once and each
    baseline's manifest compared with it, so the panel can switch between them without waiting.

Each baseline keeps its +/- counts in <snap>/numstat by path and file state, so a file that hasn't
changed again isn't diffed again.
"""
import ctypes, filecmp, os, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

MAC = sys.platform == "darwin"
libc = ctypes.CDLL(None, use_errno=True) if MAC else None
FICLONE = 0x40049409


def key(path):
    """What changes whenever a file's content can have: ctime can't be set back by tools."""
    try:
        s = os.stat(path)
    except OSError:
        return None
    return f"{s.st_size}:{s.st_mtime_ns}:{s.st_ctime_ns}:{s.st_ino}"


def sniff(path):
    try:
        with open(path, "rb") as h:
            return "b" if b"\0" in h.read(8192) else "t"
    except OSError:
        return None


def clone(src, dst):
    """A copy-on-write clone where the disk can; else a real copy. Returns the bytes really copied."""
    if MAC:
        if libc.clonefile(os.fsencode(src), os.fsencode(dst), 0) == 0:
            return 0
    else:
        try:
            import fcntl
            with open(src, "rb") as a, open(dst, "wb") as b:
                fcntl.ioctl(b.fileno(), FICLONE, a.fileno())
            return 0
        except OSError:
            pass
    shutil.copy2(src, dst)
    return os.path.getsize(dst)


def clone_tree(src, dst):
    if MAC:
        return libc.clonefile(os.fsencode(src), os.fsencode(dst), 0) == 0
    return subprocess.run(["cp", "-a", "--reflink=auto", src, dst], stderr=subprocess.DEVNULL).returncode == 0


def read_lines(path):
    with open(path, encoding="utf-8", errors="surrogateescape") as h:
        return [line.rstrip("\n") for line in h if line.strip()]


def read_meta(snap):
    """A baseline's manifest: path -> (stat key, kind). One taken before manifests existed gets one
    made now: a file whose ctime and mtime are both older than the baseline is as it was then (the
    rule the shell comparison uses); any other gets the key "?", so its content is compared."""
    meta = {}
    try:
        with open(os.path.join(snap, "meta"), encoding="utf-8", errors="surrogateescape") as h:
            for line in h:
                path, k, kind = line.rstrip("\n").split("\t")
                meta[path] = (k, kind)
        return meta
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        return None
    try:
        text = read_lines(os.path.join(snap, "list"))
        stamp = os.stat(os.path.join(snap, "stamp")).st_mtime_ns
    except OSError:
        return None
    try:
        every = read_lines(os.path.join(snap, "all"))
    except OSError:
        every = text
    kinds = dict.fromkeys(every, "b")
    kinds.update(dict.fromkeys(text, "t"))
    for f, kind in kinds.items():
        try:
            st = os.stat(f)
            k = key(f) if st.st_mtime_ns < stamp and st.st_ctime_ns < stamp else "?"
        except OSError:
            k = "?"
        meta[f] = (k, kind)
    try:
        with open(os.path.join(snap, "meta"), "w", encoding="utf-8", errors="surrogateescape") as h:
            h.write("".join(f"{f}\t{k}\t{kind}\n" for f, (k, kind) in meta.items()))
    except OSError:
        pass
    return meta


def files_in():
    return [line.rstrip("\n") for line in sys.stdin if line.strip()]


def snapshot(new, prev, limit, most):
    files, tree = files_in(), os.path.join(new, "tree")
    keys = {f: key(f) for f in files}
    old = read_meta(prev) if prev else None
    kinds, todo = {}, []
    for f in files:
        if keys[f] is None:
            continue
        o = old.get(f) if old else None
        if o and o[0] == keys[f]:
            kinds[f] = o[1]
        else:
            todo.append(f)
    with ThreadPoolExecutor(8) as pool:
        for f, kind in zip(todo, pool.map(sniff, todo)):
            if kind:
                kinds[f] = kind
    text = sorted(f for f, kind in kinds.items() if kind == "t")
    if len(text) > most:
        sys.exit(4)
    keep = set()
    if old is not None and clone_tree(os.path.join(prev, "tree"), tree):
        # The last baseline's text files that are still the same stay; the rest go.
        for f, (k, kind) in old.items():
            if kind != "t":
                continue
            if kinds.get(f) == "t" and keys.get(f) == k:
                keep.add(f)
            else:
                try:
                    os.unlink(os.path.join(tree, f))
                except OSError:
                    pass
    os.makedirs(tree, exist_ok=True)
    need = [f for f in text if f not in keep]
    for d in sorted({os.path.dirname(os.path.join(tree, f)) for f in need}):
        os.makedirs(d, exist_ok=True)
    with ThreadPoolExecutor(8) as pool:
        copied = sum(pool.map(lambda f: clone(f, os.path.join(tree, f)), need))
    with open(os.path.join(new, "list"), "w", encoding="utf-8", errors="surrogateescape") as h:
        h.write("".join(f + "\n" for f in text))
    with open(os.path.join(new, "meta"), "w", encoding="utf-8", errors="surrogateescape") as h:
        h.write("".join(f"{f}\t{keys[f]}\t{kind}\n" for f, kind in kinds.items()))
    sys.exit(3 if copied > limit else 0)


def numstat(kind, path, snap):
    a = "/dev/null" if kind == "A" else os.path.join(snap, "tree", path)
    b = "/dev/null" if kind == "D" else path
    r = subprocess.run(["git", "diff", "--no-index", "--numstat", "--", a, b], capture_output=True, text=True, errors="replace")
    fields = r.stdout.split("\t")
    return (fields[0], fields[1]) if len(fields) >= 3 else ("0", "0")


def compare(snap, files, keys, sniffed, pool):
    """What changed since the baseline in snap. keys: every file's stat key now; sniffed: kinds read
    so far, shared between baselines so no file is read twice."""
    meta = read_meta(snap) or {}
    now, changes, fresh = set(files), [], []
    for f in files:
        o = meta.get(f)
        if o is None or o[1] == "b":
            if o is None or o[0] != keys[f]:
                fresh.append(f)
        elif o[0] != keys[f]:
            try:
                if not filecmp.cmp(f, os.path.join(snap, "tree", f), shallow=False):
                    changes.append(("M", f))
            except OSError:
                pass
    todo = [f for f in fresh if f not in sniffed]
    for f, kind in zip(todo, pool.map(sniff, todo)):
        sniffed[f] = kind
    changes += [("A", f) for f in fresh if sniffed.get(f) == "t"]
    changes += [("D", f) for f, (k, kind) in meta.items() if kind == "t" and f not in now]
    order = {"A": 0, "D": 1, "M": 2}
    changes.sort(key=lambda c: (order[c[0]], c[1]))
    with open(os.path.join(snap, "changes"), "w", encoding="utf-8", errors="surrogateescape") as h:
        h.write("".join(f"{kind}\t{f}\n" for kind, f in changes))
    # The +/- counts: from the cache where the file is in the same state, else git.
    cached = {}
    try:
        with open(os.path.join(snap, "numstat"), encoding="utf-8", errors="surrogateescape") as h:
            for line in h:
                f, k, add, delete = line.rstrip("\n").split("\t")
                cached[(f, k)] = (add, delete)
    except (OSError, ValueError):
        pass
    shown = changes[:1000]
    state = [(f, keys.get(f) or "gone") for _, f in shown]
    todo = [(c, st) for c, st in zip(shown, state) if st not in cached]
    for (c, st), stat in zip(todo, pool.map(lambda x: numstat(x[0][0], x[0][1], snap), todo)):
        cached[st] = stat
    with open(os.path.join(snap, "numstat"), "w", encoding="utf-8", errors="surrogateescape") as h:
        h.write("".join(f"{f}\t{k}\t{cached[(f, k)][0]}\t{cached[(f, k)][1]}\n" for f, k in state))
    return changes, [cached[st] for st in state]


def report(changes, stats):
    print(f"total\t{len(changes)}")
    for (kind, f), (add, delete) in zip(changes, stats):
        print(f"{kind}\t{add}\t{delete}\t{f}")


def status(snaps, every=False):
    files = files_in()
    keys = {f: key(f) or "gone" for f in files}
    sniffed = {}
    with ThreadPoolExecutor(8) as pool:
        for snap in snaps:
            if every:
                print(f"id\t{os.path.basename(snap.rstrip('/'))}")
            report(*compare(snap, files, keys, sniffed, pool))


if __name__ == "__main__":
    sys.stdout.reconfigure(errors="surrogateescape")
    if sys.argv[1] == "snapshot":
        snapshot(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]))
    elif sys.argv[1] == "survey":
        status([s for s in sys.argv[2:] if os.path.isfile(os.path.join(s, "list"))], every=True)
    else:
        status([sys.argv[2]])
