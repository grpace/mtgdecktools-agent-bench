#!/usr/bin/env python3
"""Local fixes for cards phase-rs scripts wrongly, the known-issues list, and the path upstream.

    npm run overrides -- list
    npm run overrides -- apply [DATA_DIR]            # card-data.json = upstream + active overrides (default data/)
    npm run overrides -- install [--container mtgdt-phase] [--force]
                                                     # apply to data/, copy into a running phase-server, restart, verify
    npm run overrides -- test [SLUG ...] [--keep]    # each override's scripted games: bug on upstream, fixed with it
    npm run overrides -- check [--no-network]        # stale overrides: the pin moved, the card changed upstream, issue closed
    npm run overrides -- fingerprint [DATA_DIR]      # what event_start.provenance.card_data will say
    npm run overrides -- triage [RUNS_DIR ...] [--write]
                                                     # agent rules reports -> suspected cards in engine/known-issues.json
    npm run overrides -- draft-upstream SLUG [--out FILE]
                                                     # a bug report or comment draft in phase-rs's form; never posts
    npm run overrides -- upstream [--set FRA] [--refresh] [--json]
                                                     # swapped cards in the featured sets vs phase-rs PRs, issues,
                                                     # the newest release and the coverage report (read-only)

(`npm run overrides --` is `python3 -I scripts/card_overrides.py`; standard library only.)

An override (engine/overrides/<slug>.json) is a JSON Patch (RFC 6902) against one card's entry in phase-rs's
card-data.json, pinned to the exact upstream entry it was written against (`applies_to.entry_sha256`). It applies only
while that entry is unchanged: a newer phase-rs build that touches the card turns the override stale (skipped, and
flagged by `check`) until a person re-tests it and retires or re-pins it. Agents never write or apply overrides; their
reports only feed the "suspected" list. docs/CARD-OVERRIDES.md is the guide.

An override with `marks_supported: true` makes a card the engine couldn't run work as printed: while it is applied, the
card comes off the unsupported-card list (the sidecar's `supported`; `adjust_unsupported`), so it stops being swapped
out of packs. Events record the exact list they ran on (event_start.boosters.unsupported_sha256), so older events keep
regenerating their own packs.
"""
from __future__ import annotations

import argparse
import copy
import difflib
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERRIDES = ROOT / "engine" / "overrides"
KNOWN_ISSUES = ROOT / "engine" / "known-issues.json"
LOCK = ROOT / "engine" / "phase.lock.json"
MANIFEST = ROOT / "deps" / "manifest.json"
DATA = ROOT / "data"
RUNS = ROOT / "runs"
CARD_DATA = "card-data.json"
UPSTREAM_COPY = "card-data.upstream.json"
SIDECAR = "card-overrides.json"
STATUSES = ("active", "submitted-upstream", "retired")
APPLIED = ("active", "submitted-upstream")
KINDS = ("card-data", "parser", "engine", "coverage")
ISSUE_STATUSES = ("suspected", "confirmed", "not-a-bug", "fixed")
RELEASE_MANIFEST = "https://data.phase-rs.dev/desktop/release-server-v{version}.json"
PHASE_REPO = "phase-rs/phase"
USER_AGENT = "mtgdecktools-agent-bench/0.1 (card overrides)"
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
# Outward-facing drafts must not name the project while it is private (docs/CARD-OVERRIDES.md, "Upstream").
PRIVATE_WORDS = re.compile(r"agent[ -]?bench|mtgdecktools|mtg deck tools|benchmark", re.I)


def log(msg: str = "") -> None:
    print(msg, flush=True)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical(obj) -> bytes:
    """Bytes that identify a JSON value regardless of key order (used for one card's entry)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def entry_sha256(entry) -> str:
    return sha256_bytes(canonical(entry))


def dump_card_data(data: dict) -> bytes:
    """phase-rs's own serialization of card-data.json: compact, UTF-8, one trailing newline. Loading and dumping an
    unmodified upstream file reproduces it byte for byte, so the only bytes that differ are the overridden cards."""
    return (json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def read_json(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p)


def write_bytes_atomic(p: Path, b: bytes) -> None:
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_bytes(b)
    os.chmod(tmp, 0o644)
    tmp.replace(p)


def lock() -> dict:
    return read_json(LOCK, {}) or {}


def http(url: str, accept_json: bool = True, timeout: int = 60):
    headers = {"User-Agent": USER_AGENT}
    if "api.github.com" in url and os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return json.loads(body) if accept_json else body


# ---------------------------------------------------------------------------------------------------------
# Override files


class OverrideError(Exception):
    pass


def load_overrides(slugs: list[str] | None = None, tolerant: bool = False) -> list[dict]:
    """Every override file (or the named ones), validated, sorted by slug. Each gets `_slug`, `_path` and `_sha256` (of
    the file bytes). `tolerant`: an invalid file is reported and left out instead of stopping everything."""
    out = []
    for p in sorted(OVERRIDES.glob("*.json")):
        if slugs and p.stem not in slugs:
            continue
        b = p.read_bytes()
        try:
            o = json.loads(b)
        except json.JSONDecodeError as e:
            if tolerant:
                log(f"(skipping {p.relative_to(ROOT)}: {e})")
                continue
            raise OverrideError(f"{p.relative_to(ROOT)}: not JSON ({e})") from None
        o["_slug"], o["_path"], o["_sha256"] = p.stem, p, sha256_bytes(b)
        problems = validate(o)
        if problems:
            if tolerant:
                log(f"(skipping {p.relative_to(ROOT)}: {'; '.join(problems)})")
                continue
            raise OverrideError(f"{p.relative_to(ROOT)}: " + "; ".join(problems))
        out.append(o)
    if slugs:
        known = {o["_slug"] for o in out}
        missing = [s for s in slugs if s not in known]
        if missing:
            raise OverrideError(f"no override named {', '.join(missing)} (see `npm run overrides -- list`)")
        out = [o for o in out if o["_slug"] in slugs]
    return out


def validate(o: dict) -> list[str]:
    bad = []
    if not SLUG_RE.match(o["_slug"]):
        bad.append("file name must be a lowercase slug (heated-argument.json)")
    if not isinstance(o.get("card"), str) or not o["card"]:
        bad.append("card: the card's name, as in card-data.json")
    if o.get("status") not in STATUSES:
        bad.append(f"status: one of {', '.join(STATUSES)}")
    if o.get("kind") not in KINDS:
        bad.append(f"kind: where upstream should fix it, one of {', '.join(KINDS)}")
    at = o.get("applies_to") or {}
    for k in ("server_version", "build_commit", "card_data_sha256", "entry_sha256"):
        if not isinstance(at.get(k), str) or not at[k]:
            bad.append(f"applies_to.{k} is required")
    if not isinstance(o.get("upstream_issue"), (str, type(None))):
        bad.append("upstream_issue: a URL or null")
    if not isinstance(o.get("marks_supported", False), bool):
        bad.append("marks_supported: true or false")
    rules = o.get("rules") or {}
    if not rules.get("oracle") or not rules.get("cr"):
        bad.append("rules.oracle and rules.cr (Comprehensive Rules references) are required")
    if not isinstance(o.get("patch"), list) or not o["patch"]:
        bad.append("patch: a JSON Patch (list of operations) against the card's entry")
    tests = o.get("tests")
    coverage = o.get("kind") == "coverage"
    if coverage:
        # phase-rs's coverage report flags the card, but its card data already runs as printed: the override changes
        # nothing (test ops only, pinning what was verified), and its cases show the printed behavior on upstream data.
        if isinstance(o.get("patch"), list) and any(op.get("op") != "test" for op in o["patch"]):
            bad.append("patch: a coverage override only pins the verified values (test ops)")
        if o.get("marks_supported") is not True:
            bad.append("marks_supported: a coverage override exists to mark its card supported")
    if not isinstance(tests, list) or not tests:
        bad.append("tests: at least one scripted case")
    elif coverage and any((t.get("expect") or {}).get("bug") for t in tests):
        bad.append("tests: a coverage override changes nothing, so no case can show a bug")
    elif not coverage and not any((t.get("expect") or {}).get("bug") for t in tests):
        bad.append("tests: at least one case must reproduce the bug (expect.bug)")
    return bad


# RFC 6902 JSON Patch (add, remove, replace, move, copy, test) with RFC 6901 pointers.


def _pointer(path: str) -> list[str]:
    if path == "":
        return []
    if not path.startswith("/"):
        raise OverrideError(f"bad JSON pointer {path!r}")
    return [t.replace("~1", "/").replace("~0", "~") for t in path[1:].split("/")]


def _walk(doc, tokens: list[str]):
    cur = doc
    for t in tokens:
        if isinstance(cur, list):
            cur = cur[int(t)]
        elif isinstance(cur, dict):
            cur = cur[t]
        else:
            raise OverrideError(f"cannot descend into {type(cur).__name__} at {t!r}")
    return cur


def _get(doc, path: str):
    try:
        return _walk(doc, _pointer(path))
    except (KeyError, IndexError, ValueError) as e:
        raise OverrideError(f"path {path} not found ({e})") from None


def _remove(doc, path: str):
    toks = _pointer(path)
    parent = _walk(doc, toks[:-1])
    try:
        if isinstance(parent, list):
            return parent.pop(int(toks[-1]))
        return parent.pop(toks[-1])
    except (KeyError, IndexError, ValueError):
        raise OverrideError(f"remove: path {path} not found") from None


def _add(doc, path: str, value):
    toks = _pointer(path)
    if not toks:
        return value
    parent = _walk(doc, toks[:-1])
    last = toks[-1]
    if isinstance(parent, list):
        idx = len(parent) if last == "-" else int(last)
        if idx > len(parent):
            raise OverrideError(f"add: index {idx} out of range at {path}")
        parent.insert(idx, value)
    elif isinstance(parent, dict):
        parent[last] = value
    else:
        raise OverrideError(f"add: {path} has no container parent")
    return doc


def apply_patch(doc, ops: list[dict]):
    doc = copy.deepcopy(doc)
    for op in ops:
        kind, path = op.get("op"), op.get("path", "")
        if kind == "test":
            if canonical(_get(doc, path)) != canonical(op.get("value")):
                raise OverrideError(f"test failed at {path}: upstream no longer has the value this override expects")
        elif kind == "remove":
            _remove(doc, path)
        elif kind == "add":
            doc = _add(doc, path, copy.deepcopy(op["value"]))
        elif kind == "replace":
            _get(doc, path)
            if path == "":
                doc = copy.deepcopy(op["value"])
            else:
                _remove(doc, path)
                doc = _add(doc, path, copy.deepcopy(op["value"]))
        elif kind == "move":
            value = _remove(doc, op["from"])
            doc = _add(doc, path, value)
        elif kind == "copy":
            doc = _add(doc, path, copy.deepcopy(_get(doc, op["from"])))
        else:
            raise OverrideError(f"unsupported patch op {kind!r}")
    return doc


def card_key(name: str) -> str:
    return name.lower()


def patch_card_data(data: dict, overrides: list[dict]) -> tuple[dict, list[dict], list[dict]]:
    """Apply the active overrides to card data in place. Returns (data, applied, skipped)."""
    applied, skipped = [], []
    for o in overrides:
        if o["status"] not in APPLIED:
            continue
        key = card_key(o["card"])
        entry = data.get(key)
        if entry is None:
            skipped.append({"slug": o["_slug"], "reason": f"{o['card']} is not in this card data"})
            continue
        have = entry_sha256(entry)
        if have != o["applies_to"]["entry_sha256"]:
            skipped.append({"slug": o["_slug"], "reason": f"stale: upstream changed {o['card']} since the override was "
                                                           f"written (entry {have[:12]}, override pins "
                                                           f"{o['applies_to']['entry_sha256'][:12]}); re-test, then retire or re-pin"})
            continue
        try:
            data[key] = apply_patch(entry, o["patch"])
        except OverrideError as e:
            skipped.append({"slug": o["_slug"], "reason": str(e)})
            continue
        applied.append(o)
    return data, applied, skipped


def fingerprint(applied: list[dict]) -> str:
    """sha256 over the applied override files (slug and file bytes), like prompt_sha256 for prompts. The empty set
    hashes to sha256("")."""
    h = hashlib.sha256()
    for o in sorted(applied, key=lambda o: o["_slug"]):
        h.update(o["_slug"].encode() + b"\0" + bytes.fromhex(o["_sha256"]) + b"\0")
    return h.hexdigest()


# ---------------------------------------------------------------------------------------------------------
# The unsupported-card list with the overrides that make cards supported (packages/director/src/card-overrides.ts
# adjustUnsupported is the same algorithm)

UNSUPPORTED = "unsupported-cards.json"
ARCHIVE_DIR = "booster-archive"


def supported_by(applied: list[dict]) -> list[str]:
    """Card names the applied overrides make supported (marks_supported), sorted (code points of the lower-cased
    name, then the name)."""
    return sorted({o["card"] for o in applied if o.get("marks_supported")}, key=lambda n: (n.lower(), n))


def adjust_unsupported(doc: dict, supported: list[str]) -> tuple[dict, bool]:
    """The unsupported-card list without the cards active overrides make supported. The base list is the file's
    `unsupported` plus its `removed_by_overrides` (what an earlier adjustment took off), so adjusting again for another
    set of overrides (or none) restores the base first. Returns (doc, changed); unchanged input is returned as is.
    A changed list is sorted (lower-cased name, then name); `removed_by_overrides` is present only when non-empty."""
    base = list(doc.get("unsupported") or []) + list(doc.get("removed_by_overrides") or [])
    want = {n.lower() for n in supported}
    removed = sorted({n for n in base if n.lower() in want}, key=lambda n: (n.lower(), n))
    if removed == list(doc.get("removed_by_overrides") or []):
        return doc, False
    out = {k: v for k, v in doc.items() if k not in ("unsupported", "removed_by_overrides")}
    out["unsupported"] = sorted({n for n in base if n.lower() not in want}, key=lambda n: (n.lower(), n))
    if removed:
        out["removed_by_overrides"] = removed
    return out, True


def adjust_unsupported_file(data_dir: Path, supported: list[str]) -> bool:
    """Adjust data_dir/unsupported-cards.json (when present) for the applied overrides. The previous bytes are kept in
    data_dir/booster-archive/<sha256>.json first: events that ran on that list regenerate their packs from it."""
    p = data_dir / UNSUPPORTED
    if not p.exists():
        return False
    raw = p.read_bytes()
    doc, changed = adjust_unsupported(json.loads(raw), supported)
    if not changed:
        return False
    arch = data_dir / ARCHIVE_DIR / f"{sha256_bytes(raw)}.json"
    if not arch.exists():
        arch.parent.mkdir(parents=True, exist_ok=True)
        arch.write_bytes(raw)
    write_bytes_atomic(p, json.dumps(doc).encode())
    log(f"   {UNSUPPORTED}: {len(doc['unsupported'])} unsupported cards; taken off by overrides: "
        f"{', '.join(doc.get('removed_by_overrides') or []) or 'none'} (previous list archived as {arch.name[:12]}…)")
    return True


# ---------------------------------------------------------------------------------------------------------
# apply / install


def pristine_path(data_dir: Path) -> Path:
    """The pristine upstream card data in a data dir, read-only. card-data.json is our patched output only when the
    sidecar says so (its sha256 matches and the upstream copy is intact); anything else in card-data.json is a fresh
    upstream copy (a new phase-rs build, a data refresh, a copy out of a container)."""
    cur, up, side = data_dir / CARD_DATA, data_dir / UPSTREAM_COPY, read_json(data_dir / SIDECAR)
    if not cur.exists():
        if up.exists():
            return up
        raise OverrideError(f"no {CARD_DATA} in {data_dir}")
    if side and up.exists() and side.get("sha256") == sha256_file(cur) and side.get("upstream_sha256") == sha256_file(up):
        return up
    return cur


def upstream_source(data_dir: Path) -> Path:
    """pristine_path, keeping the pristine bytes as card-data.upstream.json so card-data.json can be overwritten."""
    src, up = pristine_path(data_dir), data_dir / UPSTREAM_COPY
    if src != up:
        shutil.copyfile(src, up.with_name(UPSTREAM_COPY + ".tmp"))
        up.with_name(UPSTREAM_COPY + ".tmp").replace(up)
    return up


def build(data_dir: Path, overrides: list[dict]) -> dict:
    """Write data_dir/card-data.json = upstream + overrides, and the sidecar describing it. Deterministic."""
    src = upstream_source(data_dir)
    raw = src.read_bytes()
    up_sha = sha256_bytes(raw)
    data, applied, skipped = patch_card_data(json.loads(raw), overrides)
    out = dump_card_data(data) if applied else raw
    write_bytes_atomic(data_dir / CARD_DATA, out)
    side = {
        "_comment": "Written by scripts/card_overrides.py apply. card-data.json = card-data.upstream.json + these overrides.",
        "format": 1,
        "upstream_sha256": up_sha,
        "sha256": sha256_bytes(out),
        "overrides_sha256": fingerprint(applied),
        "overrides": [{"slug": o["_slug"], "card": o["card"], "status": o["status"], "file_sha256": o["_sha256"],
                       "upstream_issue": o.get("upstream_issue")} for o in applied],
        "supported": supported_by(applied),
        "skipped": skipped,
    }
    write_json(data_dir / SIDECAR, side)
    adjust_unsupported_file(data_dir, side["supported"])
    pinned = (read_json(MANIFEST, {}) or {}).get("phase_rs", {}).get("data", {}).get("card_data", {}).get("sha256")
    if pinned and pinned != up_sha:
        log(f"   note: upstream card data {up_sha[:12]} is not the pinned build's ({pinned[:12]}, deps/manifest.json)")
    return side


def report_side(side: dict) -> None:
    log(f"   upstream {side['upstream_sha256'][:12]} -> card-data.json {side['sha256'][:12]}; "
        f"overrides {side['overrides_sha256'][:12]} ({len(side['overrides'])} applied)")
    for o in side["overrides"]:
        log(f"   + {o['slug']} ({o['card']}, {o['status']})")
    for s in side["skipped"]:
        log(f"   SKIPPED {s['slug']}: {s['reason']}")


def cmd_apply(a) -> int:
    data_dir = Path(a.data_dir or DATA).resolve()
    log(f"== applying card overrides to {data_dir}")
    side = build(data_dir, load_overrides())
    report_side(side)
    return 1 if side["skipped"] and a.strict else 0


def container_engine() -> str:
    e = os.environ.get("CONTAINER_ENGINE")
    if e:
        return e
    for c in ("podman", "docker"):
        if shutil.which(c):
            return c
    raise OverrideError("needs podman or docker")


def run(cmd: list[str], check: bool = True, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, capture_output=True, text=True, **kw)


def wait_health(port: int, seconds: int = 120) -> bool:
    for _ in range(seconds):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2)
            return True
        except Exception:
            time.sleep(1)
    return False


def live_events(minutes: int = 30) -> list[str]:
    """Events that look like they are running here: a log written in the last N minutes and no summary yet."""
    out = []
    if not RUNS.is_dir():
        return out
    cutoff = time.time() - minutes * 60
    for d in RUNS.iterdir():
        log_file = d / "events.jsonl"
        if log_file.exists() and not (d / "summary.json").exists() and log_file.stat().st_mtime > cutoff:
            out.append(d.name)
    return out


def cmd_install(a) -> int:
    """Local dev: phase-server reads card-data.json from its data volume once, at start. Copy the patched file in and
    restart it; then read the file back and check the server did not swap it for a download (it replaces a file it
    can't load from its signed release manifest unless started with --no-data-download)."""
    live = live_events()
    if live and not a.force:
        log(f"Refusing: event(s) look live ({', '.join(live)}). Restarting phase-server drops their games, and overrides "
            "never change mid-event. Finish them first (or --force if they are dead).")
        return 1
    engine = container_engine()
    data_dir = Path(a.data).resolve() if a.data else DATA
    log(f"== applying to {data_dir}")
    side = build(data_dir, load_overrides())
    report_side(side)
    c = a.container
    if run([engine, "container", "exists", c] if engine == "podman" else [engine, "inspect", c], check=False).returncode != 0:
        log(f"No container {c}. {data_dir} is ready; start phase-server on a volume holding it (docs/CARD-OVERRIDES.md).")
        return 1
    log(f"== installing into {c} and restarting it")
    run([engine, "cp", str(data_dir / CARD_DATA), f"{c}:/var/lib/phase-server/{CARD_DATA}"])
    run([engine, "cp", str(data_dir / SIDECAR), f"{c}:/var/lib/phase-server/{SIDECAR}"])
    run([engine, "restart", c])
    ports = run([engine, "port", c, "9374/tcp"], check=False).stdout.strip().splitlines()
    m = re.search(r":(\d+)$", ports[0]) if ports else None
    if m and not wait_health(int(m.group(1))):
        log("phase-server did not come back healthy; see its logs")
        return 1
    got = run([engine, "exec", c, "sha256sum", f"/var/lib/phase-server/{CARD_DATA}"]).stdout.split()[0]
    if got != side["sha256"]:
        log(f"MISMATCH: phase-server's card-data.json is {got[:12]}, expected {side['sha256'][:12]}. It probably could "
            "not load the patched file and replaced it from its release manifest. Check its logs.")
        return 1
    log(f"   phase-server runs card data {got[:12]} (overrides {side['overrides_sha256'][:12]})")
    return 0


# ---------------------------------------------------------------------------------------------------------
# test: every override's scripted games against upstream and patched card data, on throwaway servers


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    """A throwaway phase-server (pinned image) on its own volume holding the given card-data.json."""

    def __init__(self, engine: str, name: str, card_data: bytes):
        self.engine, self.name, self.volume, self.port = engine, name, name + "-data", free_port()
        image = f"{lock()['image']}@{lock()['digest']}"
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / CARD_DATA
            f.write_bytes(card_data)
            os.chmod(f, 0o644)
            run([engine, "volume", "create", self.volume])
            # --no-data-download: a card-data.json the server can't load is a hard failure, never a silent download.
            run([engine, "create", "--name", name, "-p", f"127.0.0.1:{self.port}:9374",
                 "-v", f"{self.volume}:/var/lib/phase-server", image, "--no-data-download"])
            run([engine, "cp", str(f), f"{name}:/var/lib/phase-server/{CARD_DATA}"])
        run([engine, "start", name])
        if not wait_health(self.port):
            logs = run([engine, "logs", name], check=False)
            raise OverrideError(f"{name} did not start: {(logs.stdout + logs.stderr)[-800:]}")

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/ws"

    def remove(self) -> None:
        run([self.engine, "rm", "-f", self.name], check=False)
        run([self.engine, "volume", "rm", "-f", self.volume], check=False)


def scenario(o: dict, url: str, data: str) -> dict:
    r = run(["node", str(ROOT / "scripts" / "card-scenario.mjs"), str(o["_path"]), "--phase", url, "--data", data, "--json"],
            check=False, cwd=ROOT, timeout=900)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return {"ok": False, "error": (r.stderr or r.stdout)[-800:]}


def cmd_test(a) -> int:
    overrides = load_overrides(a.slugs or None)
    if not a.slugs:
        overrides = [o for o in overrides if o["status"] in APPLIED]
    if not overrides:
        log("no active overrides to test")
        return 0
    src = Path(a.upstream).resolve() if a.upstream else pristine_path(DATA)
    raw = src.read_bytes()
    upstream = json.loads(raw)
    engine = container_engine()
    tag = f"mtgdt-overrides-test-{os.getpid()}"
    servers: list[Server] = []
    failed = 0
    try:
        log(f"== upstream card data {sha256_bytes(raw)[:12]} ({src.relative_to(ROOT) if src.is_relative_to(ROOT) else src})")
        up = Server(engine, f"{tag}-upstream", raw)
        servers.append(up)
        for o in overrides:
            # Each override is tested alone: upstream + this one.
            data, applied, skipped = patch_card_data(copy.deepcopy(upstream), [{**o, "status": "active"}])
            log(f"== {o['_slug']} ({o['card']})")
            if skipped:
                log(f"   cannot apply: {skipped[0]['reason']}")
                failed += 1
                continue
            res_up = scenario(o, up.url, "upstream")
            if o["kind"] == "coverage":
                # Nothing to patch: the cases show the printed behavior on the upstream data itself.
                fixed, runs = None, (("upstream", res_up),)
            else:
                fixed = Server(engine, f"{tag}-{o['_slug']}", dump_card_data(data))
                servers.append(fixed)
                runs = (("upstream", res_up), ("override", scenario(o, fixed.url, "patched")))
            for label, res in runs:
                if "results" not in res:
                    log(f"   {label}: harness error: {res.get('error')}")
                    failed += 1
                    continue
                for r in res["results"]:
                    mark = "ok  " if r["ok"] else "FAIL"
                    log(f"   {mark} {label:8} {r['name']}: {r['verdict']} (want {r['want']}; life {'/'.join(map(str, r['outcome']['life']))})")
                    for p in r.get("problems", []) if not r["ok"] else []:
                        log(f"          - {p}")
                    if not r["ok"]:
                        # Enough to tell an engine quirk from a harness race without rerunning.
                        log(f"          zones: {json.dumps(r['outcome'].get('zones', {}), sort_keys=True)}")
                        for t in r.get("trace", [])[-8:]:
                            log(f"          trace: {clean(t, 300)}")
                failed += 0 if res["ok"] else 1
            if fixed and not a.keep:
                fixed.remove()
                servers.remove(fixed)
    finally:
        if not a.keep:
            for s in servers:
                s.remove()
        elif servers:
            log("kept: " + ", ".join(f"{s.name} ({s.url})" for s in servers))
    log("== " + ("all overrides behave as tested" if not failed else f"{failed} failing run(s)"))
    return 1 if failed else 0


# ---------------------------------------------------------------------------------------------------------
# check: is an override stale?


def release_card_data(version: str, cache: Path) -> tuple[str, Path | None]:
    """sha256 of a phase-rs release's card-data.json (from its release data manifest) and a local copy (downloaded
    once into tmp/, verified against that sha256)."""
    man = http(RELEASE_MANIFEST.format(version=version))
    entry = next(d for d in man["data"] if d["name"] == CARD_DATA)
    sha = entry["sha256"]
    path = cache / f"card-data-{sha[:16]}.json"
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        body = http(entry["url"], accept_json=False, timeout=600)
        if sha256_bytes(body) != sha:
            raise OverrideError(f"download of {entry['url']} does not match its manifest sha256")
        path.write_bytes(body)
    return sha, path


def has_markers(entry: dict) -> bool:
    """Whether a card's parsed rules hold an Unimplemented or Unknown node (scripts/refresh-phase-data.py's test)."""
    blob = json.dumps(entry)
    return "Unimplemented" in blob or '"Unknown"' in blob


COVERAGE_URL = "https://data.phase-rs.dev/coverage-data.json"


def coverage_support(cache: Path, max_age_s: int = 12 * 3600, refresh: bool = False) -> dict[str, bool]:
    """phase-rs's published coverage report (it tracks their main branch): lower-cased card name -> supported.
    Downloaded at most every 12 hours (about 65 MB) into tmp/."""
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / "coverage-data.json"
    if refresh or not path.exists() or time.time() - path.stat().st_mtime > max_age_s:
        body = http(COVERAGE_URL, accept_json=False, timeout=600)
        json.loads(body)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(body)
        tmp.replace(path)
    cov = json.loads(path.read_bytes())
    return {c["card_name"].lower(): bool(c["supported"]) for c in cov.get("cards", [])}


def newest_release_tag() -> str | None:
    tags = http(f"https://api.github.com/repos/{PHASE_REPO}/tags?per_page=30")
    vs = sorted((t["name"] for t in tags if re.fullmatch(r"v\d+\.\d+\.\d+", t["name"])),
                key=lambda v: tuple(int(x) for x in v[1:].split(".")))
    return vs[-1] if vs else None


def check(no_network: bool = False, newest_release: str | None = None) -> dict:
    """Flags per override (read-only). `newest_release` (vX.Y.Z) lets deps.py pass what it already looked up."""
    lk = lock()
    report: dict = {"pinned": lk.get("build_commit"), "overrides": [], "flags": 0}
    try:
        overrides = load_overrides()
    except OverrideError as e:
        return {**report, "error": str(e), "flags": 1}
    local = None
    try:
        local = json.loads(pristine_path(DATA).read_bytes())
    except OverrideError:
        pass
    newer = None
    coverage = None
    if not no_network and any(o.get("marks_supported") and o["status"] != "retired" for o in overrides):
        try:
            coverage = coverage_support(ROOT / "tmp" / "phase-coverage")
        except Exception as e:  # network trouble never fails a check
            report["network_error"] = repr(e)[:300]
    if not no_network:
        try:
            if not newest_release:
                newest_release = newest_release_tag()
            if newest_release and newest_release.lstrip("v") != lk.get("server_version"):
                sha, path = release_card_data(newest_release.lstrip("v"), ROOT / "tmp" / "phase-card-data")
                newer = {"version": newest_release, "card_data_sha256": sha, "data": json.loads(path.read_bytes())}
                report["newest_release"] = newest_release
        except Exception as e:  # network trouble never fails a check
            report["network_error"] = repr(e)[:300]
    for o in overrides:
        flags = []
        at = o["applies_to"]
        if o["status"] == "retired":
            report["overrides"].append({"slug": o["_slug"], "status": "retired", "flags": []})
            continue
        if at["build_commit"] != lk.get("build_commit"):
            flags.append(f"written for phase-rs {at['server_version']} ({at['build_commit']}); pinned now "
                         f"{lk.get('server_version')} ({lk.get('build_commit')}): re-test, then re-pin or retire")
        if local is not None:
            e = local.get(card_key(o["card"]))
            if e is None:
                flags.append("card missing from the local upstream card data")
            elif entry_sha256(e) != at["entry_sha256"]:
                flags.append("the local upstream entry differs from the one the override pins: it is SKIPPED until re-pinned")
        if newer:
            e = newer["data"].get(card_key(o["card"]))
            if e is not None and entry_sha256(e) != at["entry_sha256"]:
                flags.append(f"phase-rs {newer['version']} changed this card's data: test it without the override "
                             f"(npm run overrides -- test {o['_slug']} --upstream <that card-data.json>); retire if fixed")
        if newer and o.get("marks_supported"):
            e = newer["data"].get(card_key(o["card"]))
            if e is not None and not has_markers(e):
                flags.append(f"phase-rs {newer['version']} parses {o['card']} with no Unimplemented/Unknown node: an "
                             f"upstream fix may have shipped; test without the override (npm run overrides -- test "
                             f"{o['_slug']} --upstream <that card-data.json>) and retire it if every case is fixed")
        if coverage is not None and o.get("marks_supported") and coverage.get(card_key(o["card"])) is True:
            flags.append(f"phase-rs's coverage report (their main branch) lists {o['card']} as supported: a fix is on "
                         "main and ships with the next release; retire the override once that release is pinned and "
                         "its test passes without it")
        issue = o.get("upstream_issue") or ""
        m = re.match(r"https://github\.com/([^/]+/[^/]+)/(issues|pull)/(\d+)$", issue)
        if m and not no_network:
            try:
                if m.group(2) == "pull":
                    st = http(f"https://api.github.com/repos/{m.group(1)}/pulls/{m.group(3)}")
                    if st.get("merged_at"):
                        flags.append(f"upstream PR #{m.group(3)} was merged ({st['merged_at'][:10]}): the fix ships in the "
                                     "first release after that; test without the override on it, then retire")
                    elif st.get("state") == "closed":
                        flags.append(f"upstream PR #{m.group(3)} was closed without merging: look for another fix, or "
                                     "file an issue")
                else:
                    st = http(f"https://api.github.com/repos/{m.group(1)}/issues/{m.group(3)}")
                    if st.get("state") == "closed":
                        flags.append(f"upstream issue #{m.group(3)} is closed ({st.get('state_reason') or 'closed'}): check "
                                     "which release has the fix, then retire after its test passes without the override")
            except Exception as e:
                report.setdefault("network_error", repr(e)[:300])
        report["overrides"].append({"slug": o["_slug"], "status": o["status"], "flags": flags})
        report["flags"] += len(flags)
    return report


def print_check(rep: dict, indent: str = "   ") -> None:
    if rep.get("error"):
        log(f"{indent}ERROR: {rep['error']}")
        return
    if not rep["overrides"]:
        log(f"{indent}no overrides")
    for o in rep["overrides"]:
        state = "ok" if not o["flags"] else "NEEDS A LOOK"
        log(f"{indent}{o['slug']} ({o['status']}): {state}")
        for f in o["flags"]:
            log(f"{indent}  - {f}")
    if rep.get("network_error"):
        log(f"{indent}(network checks incomplete: {rep['network_error']})")


def cmd_check(a) -> int:
    log("== Card overrides")
    rep = check(no_network=a.no_network)
    print_check(rep)
    return 0


def cmd_list(a) -> int:
    for o in load_overrides():
        log(f"{o['_slug']:28} {o['status']:19} {o['kind']:10} {o['card']}  {o.get('upstream_issue') or ''}")
    side = read_json(DATA / SIDECAR)
    if side:
        log(f"data/: overrides {side['overrides_sha256'][:12]} applied ({', '.join(x['slug'] for x in side['overrides']) or 'none'})")
    return 0


def cmd_fingerprint(a) -> int:
    data_dir = Path(a.data_dir or DATA)
    side = read_json(data_dir / SIDECAR)
    cur = data_dir / CARD_DATA
    sha = sha256_file(cur) if cur.exists() else None
    if side and side.get("sha256") == sha:
        log(json.dumps({"sha256": sha, "upstream_sha256": side["upstream_sha256"], "overrides_sha256": side["overrides_sha256"],
                        "overrides": [o["slug"] for o in side["overrides"]]}, indent=2))
    else:
        log(json.dumps({"sha256": sha, "overrides": [], "note": "no sidecar for this file: upstream as far as we know"}, indent=2))
    return 0


# ---------------------------------------------------------------------------------------------------------
# triage: agent reports -> suspected cards


def clean(s, n: int) -> str:
    """Agent text made safe for a terminal: no C0/C1 controls (ANSI and OSC escapes), bidi overrides or zero-width
    characters (docs/SECURITY.md; older logs predate the Director's own cleaning)."""
    return re.sub(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]", " ", str(s or ""))[:n]


def test_run(p: Path, start: dict) -> bool:
    """Scripted runs (smoke events, bot-filled dev events) whose random agents file fake reports on purpose."""
    src = read_json(p.parent / "source.json") or {}
    return bool(start.get("dev_bot_fill")) or src.get("label") == "smoke" or all(
        str(s.get("name", "")).startswith("rand-") for s in start.get("seats", []) if s.get("kind") == "agent")


def collect_reports(dirs: list[Path], include_tests: bool = False) -> dict[str, list[dict]]:
    """rules_issue records per card (lower-case name) from every events.jsonl under the given run dirs."""
    by_card: dict[str, list[dict]] = {}
    for root in dirs:
        logs = [root / "events.jsonl"] if (root / "events.jsonl").exists() else sorted(root.glob("*/events.jsonl"))
        for p in logs:
            event_id = None
            skip = False
            with open(p, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"rules_issue"' not in line and event_id is not None:
                        continue
                    try:
                        r = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if r.get("type") == "event_start":
                        event_id = clean(r.get("id"), 80)
                        skip = not include_tests and test_run(p, r)
                    if skip or r.get("type") != "rules_issue" or not isinstance(r.get("card"), str):
                        continue
                    if not include_tests and str(r.get("seat", "")).startswith("rand-"):
                        continue
                    by_card.setdefault(r["card"].strip().lower(), []).append({
                        "event": event_id or p.parent.name, "seat": clean(r.get("seat"), 40),
                        "game": clean(r.get("game"), 120) or None, "turn": r.get("turn") if isinstance(r.get("turn"), int) else None,
                        "note": clean(r.get("note"), 600),
                    })
    return by_card


def independent(reports: list[dict]) -> bool:
    """At least two different seats, in at least two different games (a seat's repeated reports count once)."""
    seats = {(r["event"], r["seat"]) for r in reports if r["game"]}
    games = {(r["event"], r["game"]) for r in reports if r["game"]}
    return len(seats) >= 2 and len(games) >= 2


def cmd_triage(a) -> int:
    dirs = [Path(d) for d in a.runs] or [RUNS]
    by_card = collect_reports(dirs, a.include_tests)
    names = {}
    try:
        names = {k: v.get("name", k) for k, v in json.loads(pristine_path(DATA).read_bytes()).items()}
    except OverrideError:
        pass
    ki = read_json(KNOWN_ISSUES) or {"format": 1, "issues": []}
    issues = {card_key(i["card"]): i for i in ki["issues"]}
    overrides = {card_key(o["card"]): o for o in load_overrides()}
    changed = False
    log(f"== {sum(len(v) for v in by_card.values())} rules reports on {len(by_card)} card names")
    for key, reps in sorted(by_card.items(), key=lambda kv: -len(kv[1])):
        name = names.get(key)
        if names and not name:
            log(f"   ? {clean(key, 60)!r}: not a card name in the card data ({len(reps)} report(s)); ignored")
            continue
        name = name or reps[0].get("card") or key
        indep = independent(reps)
        cur = issues.get(key)
        label = cur["status"] if cur else ("SUSPECTED (new)" if indep else "watch: one seat or one game so far")
        log(f"   {name}: {len(reps)} report(s), {len({(r['event'], r['seat']) for r in reps})} seat(s), "
            f"{len({(r['event'], r['game']) for r in reps if r['game']})} game(s) -> {label}")
        for r in reps[:3]:
            log(f"      [{r['event']} {r['seat']} turn {r['turn']}] {r['note'][:200]}")
        refs = [{k: r[k] for k in ("event", "seat", "game", "turn")} for r in reps]
        if cur:
            seen = {json.dumps(x, sort_keys=True) for x in cur.get("reports", [])}
            new = [x for x in refs if json.dumps(x, sort_keys=True) not in seen]
            if new:
                cur.setdefault("reports", []).extend(new)
                changed = True
        elif indep:
            o = overrides.get(key)
            issues[key] = {"card": name, "status": "suspected", "upstream_issue": o.get("upstream_issue") if o else None,
                           "override": o["_slug"] if o else None,
                           "summary": "Flagged automatically: independent agent reports. Not verified; agents can agree and still be wrong.",
                           "first_seen": refs[0]["event"][:10], "reports": refs}
            changed = True
    if changed and a.write:
        ki["issues"] = sorted(issues.values(), key=lambda i: i["card"].lower())
        write_json(KNOWN_ISSUES, ki)
        log(f"== wrote {KNOWN_ISSUES.relative_to(ROOT)}")
    elif changed:
        log("== engine/known-issues.json would change; rerun with --write")
    else:
        log("== engine/known-issues.json is up to date")
    return 0


# ---------------------------------------------------------------------------------------------------------
# draft-upstream: an issue (or issue comment) draft in phase-rs's card-bug form. Never posts anything.


def ability_outline(ab, depth: int = 0) -> list[str]:
    out = []
    while ab:
        eff = ab.get("effect", {})
        tgt = eff.get("target") or {}
        bits = [eff.get("type", "?")]
        if eff.get("amount", {}).get("type") == "Fixed":
            bits.append(str(eff["amount"]["value"]))
        if eff.get("origin") or eff.get("destination"):
            bits.append(f"{eff.get('origin')}->{eff.get('destination')}")
        bits.append(f"target={tgt.get('type')}{'(' + ','.join(tgt.get('type_filters', [])) + ')' if tgt.get('type_filters') else ''}")
        if ab.get("optional"):
            bits.append("optional")
        if ab.get("condition"):
            bits.append(f"if {ab['condition'].get('signal') or ab['condition'].get('type')}")
        if ab.get("sub_link"):
            bits.append(f"[{ab['sub_link']}]")
        out.append("  " * depth + ("└ " if depth else "") + " ".join(bits))
        ab, depth = ab.get("sub_ability"), depth + 1
    return out


def sel_text(sel: dict) -> str:
    who = {0: "yours", 1: "the opponent's"}
    if "player" in sel:
        return {0: "you", 1: "the opponent"}.get(sel["player"], f"player {sel['player']}")
    owner = sel.get("owner", sel.get("controller"))
    return f"{sel.get('card')}" + (f" ({who.get(owner, owner)})" if owner is not None else "")


def describe_case(tc: dict) -> list[str]:
    who = {0: "you", 1: "the opponent"}
    lines = []
    for s in tc["setup"]:
        n = s.get("count", 1)
        where = {"Battlefield": "on the battlefield", "Hand": "in hand"}.get(s["zone"], f"in {s['zone'].lower()}")
        extra = []
        if s.get("counters"):
            extra.append("with " + ", ".join(f"{v} {k} counter(s)" for k, v in s["counters"].items()))
        if s.get("tapped"):
            extra.append("tapped")
        if s.get("prepared"):
            extra.append("prepared")
        lines.append(f"{who.get(s.get('owner', 0), s.get('owner'))}: {n}x {s['card']} {where}" + (f" ({', '.join(extra)})" if extra else ""))
    if tc.get("phase"):
        lines.append(f"Go to {tc['phase']['phase']} of {'your' if tc['phase'].get('active', 0) == 0 else 'the opponent’s'} turn")
    steps = tc.get("steps") if isinstance(tc.get("steps"), list) else ([{"cast": {**tc["cast"], "respond": tc.get("respond")}}] if tc.get("cast") else [])
    for st in steps:
        if "cast" in st:
            c = st["cast"]
            tg = ", ".join(sel_text(t) for t in c.get("targets") or [])
            lines.append(f"{'You cast' if c.get('by', 0) == 0 else 'The opponent casts'} {c['card']}" + (f" targeting {tg}" if tg else ""))
            for r in c.get("respond") or []:
                lines.append(f"In response: {r['object']['card']} moves to {r['data'].get('to_zone', '?').lower()}")
        elif "activate" in st:
            c = st["activate"]
            what = f"ability {c['ability']}" if "ability" in c else (f"“{c['text']}”" if "text" in c else "its ability")
            tg = ", ".join(sel_text(t) for t in c.get("targets") or [])
            lines.append(f"{'You activate' if c.get('by', 0) == 0 else 'The opponent activates'} {c['card']}'s {what}" + (f" targeting {tg}" if tg else "")
                         + (f" if it is offered ({c.get('label') or 'activate ' + c['card']})" if c.get("if_offered") else ""))
        elif "advance" in st:
            lines.append(f"Pass priority until {st['advance']['phase']} of {'your' if st['advance'].get('active', 0) == 0 else 'the opponent’s'} turn")
        elif "attack" in st:
            lines.append("Attack with " + ", ".join(sel_text(x) for x in st["attack"]))
        elif "block" in st:
            lines.append("Block: " + ", ".join(f"{sel_text(b['blocker'])} blocks {sel_text(b['attacker'])}" for b in st["block"]))
        elif "resolve" in st:
            lines.append("Let everything on the stack resolve")
        elif "offered" in st:
            q = st["offered"]
            k = next((x for x in ("cast", "activate", "play") if x in q), None)
            a = q.get(k) or {}
            what = {"cast": "casting", "play": "playing", "activate": "activating"}.get(k, "the action")
            ab = f" ability “{a['text']}”" if a.get("text") else (f" ability {a['ability']}" if "ability" in a else "")
            lines.append(f"Check whether {what} {a.get('card', '?')}{ab} is offered ({q.get('label')})")
        elif "play" in st:
            lines.append(f"{'You play' if st['play'].get('by', 0) == 0 else 'The opponent plays'} {st['play']['card']}")
        elif "sneak" in st:
            lines.append(f"Cast {st['sneak']['card']} for its sneak cost, returning {sel_text(st['sneak'].get('return') or {})}")
        elif "crew" in st:
            lines.append(f"Crew {st['crew']['card']} with " + ", ".join(sel_text(x) for x in st["crew"].get("with") or []))
        elif "debug" in st:
            lines.append(f"(sandbox) {st['debug']}" + (f" on {sel_text(st['object'])}" if st.get("object") else "") + (f" {json.dumps(st.get('data'))}" if st.get("data") else ""))
    ans = tc.get("answers") or {}
    opt = ans.get("optional")
    if opt is not None:
        lines.append("Optional choice: " + ", ".join("yes" if x else "no" for x in (opt if isinstance(opt, list) else [opt])))
    if ans.get("targets"):
        lines.append("Triggered ability targets: " + ", ".join("none" if t is None else sel_text(t) for t in ans["targets"]))
    return lines


def life_text(life: list[int]) -> str:
    return f"caster {life[0]} life, opponent {life[1]} life (both started at 20)"


def outcome_text(want: dict) -> str:
    """An expectation in words (life, objects, zones, hand sizes, winner)."""
    bits = []
    if want.get("life"):
        bits.append(life_text(want["life"]))
    for o in want.get("objects") or []:
        props = [f"{k} {o[k]}" for k in ("loyalty", "power", "toughness") if o.get(k) is not None]
        if o.get("counters") is not None:
            props.append("counters " + (", ".join(f"{v} {k}" for k, v in o["counters"].items() if v) or "none"))
        if o.get("tapped") is not None:
            props.append("tapped" if o["tapped"] else "untapped")
        props += [f"has {k}" for k in o.get("keywords") or []] + [f"no {k}" for k in o.get("no_keywords") or []]
        n = o.get("count", 1)
        bits.append(f"{n if n != 1 else ''}{'x ' if n != 1 else ''}{sel_text(o)}{' in ' + o['zone'].lower() if o.get('zone') else ''}"
                    + (f": {', '.join(props)}" if props else ""))
    for z in want.get("zones") or []:
        bits.append(f"{z.get('count', 1)}x {sel_text(z)} in {z['zone'].lower()}")
    for k in ("hand", "library"):
        if want.get(k):
            bits.append(f"cards in {k}: you {want[k][0]}, the opponent {want[k][1]}")
    if "winner" in want:
        bits.append("the game is not over" if want["winner"] is None else f"{'you win' if want['winner'] == 0 else 'the opponent wins'}")
    for label, v in (want.get("offered") or {}).items():
        bits.append(f"{label}: {'offered' if v else 'not offered'}")
    return "; ".join(bits) or "(see the case)"


ABILITY_LISTS = ("abilities", "triggers", "static_abilities", "replacements")


def changed_parts(before: dict, after: dict) -> list[tuple[str, int]]:
    """(list, index) of the top-level abilities, triggers, statics and replacements a patch changed."""
    out = []
    for k in ABILITY_LISTS:
        a, b = before.get(k) or [], after.get(k) or []
        for i in range(max(len(a), len(b))):
            if (a[i] if i < len(a) else None) != (b[i] if i < len(b) else None):
                out.append((k, i))
    return out


def part_outline(entry: dict, k: str, i: int) -> list[str]:
    items = entry.get(k) or []
    if i >= len(items):
        return [f"{k}[{i}]: (none)"]
    x = items[i]
    if k == "triggers":
        head = [f"{k}[{i}]: trigger {x.get('mode') if isinstance(x.get('mode'), str) else json.dumps(x.get('mode'))}"
                + (f", zones {x.get('trigger_zones')}" if x.get("trigger_zones") else "")
                + (f", if {json.dumps(x['condition'])}" if x.get("condition") else "")]
        return head + ["  " + line for line in ability_outline(x.get("execute"))]
    if k == "abilities":
        return [f"{k}[{i}]: {x.get('kind')}" + (f", cost {json.dumps(x.get('cost'))}" if x.get("cost") else "")
                + (f", restrictions {json.dumps(x.get('activation_restrictions'))}" if x.get("activation_restrictions") else "")] + ["  " + line for line in ability_outline(x)]
    return [f"{k}[{i}]: {json.dumps(x)[:400]}"]


def draft_coverage(o: dict) -> str:
    """A note for phase-rs that their coverage report lists a card as unsupported although it plays as printed."""
    at = o["applies_to"]
    lines = [f"<!-- DRAFT for {('a comment on ' + o['upstream_issue']) if o.get('upstream_issue') else 'a new phase-rs issue'}. "
             "Needs the owner's OK before posting; delete this line when posting. -->",
             f"**Title:** Coverage report: {o['card']} is listed as unsupported, but it plays as printed", "",
             "### Card(s)", "", o["card"], "", "### Build/version", "", f"v{at['server_version']} {at['build_commit']}", "",
             "### What the coverage report says", "", o["rules"].get("actual") or "Unsupported.", "",
             "### What the engine does", "", f"Oracle text: *\"{o['rules']['oracle']}\"*", ""]
    if o["rules"].get("expected"):
        lines += [o["rules"]["expected"], ""]
    if o["rules"].get("diagnosis"):
        lines += [o["rules"]["diagnosis"], ""]
    lines += ["Scripted sandbox games on that build (all behave as printed):", ""]
    for t in o["tests"]:
        lines += [f"- **{t['name']}**: " + "; ".join(describe_case(t)) + f". Result: {outcome_text(t['expect']['fixed'])}."]
    lines += [""]
    if o["rules"].get("suggested_fix"):
        lines += [f"Possible fix: {o['rules']['suggested_fix']}", ""]
    text = "\n".join(lines).rstrip() + "\n"
    leak = PRIVATE_WORDS.search(text)
    if leak:
        raise OverrideError(f"the draft mentions {leak.group(0)!r}; outward-facing text must not name the project yet")
    return text


def draft_upstream(o: dict, upstream_entry: dict | None) -> str:
    lk = lock()
    at = o["applies_to"]
    if o["kind"] == "coverage":
        return draft_coverage(o)
    repro = next(t for t in o["tests"] if t["expect"].get("bug"))
    lines: list[str] = []
    existing = o.get("upstream_issue")
    is_pr = bool(existing and "/pull/" in existing)
    lines.append(f"<!-- DRAFT for {('a comment on ' + existing) if existing else 'a new phase-rs card-bug issue'}. Needs the owner's OK before posting; "
                 "delete this line when posting. -->")
    if existing:
        lines += [f"Additional detail{' for this PR' if is_pr else ' for this issue'}, from a minimal scripted reproduction on v{at['server_version']} "
                  f"{at['build_commit']}.", ""]
    else:
        lines += [f"**Title:** [Card Bug] {o['card']}: {o.get('title', 'behaves differently from its Oracle text')}", ""]
    lines += ["### Card(s)", "", o["card"], "",
              "### Build/version", "", f"v{at['server_version']} {at['build_commit']} (phase-server, protocol {lk.get('protocol_version')})", "",
              "### Game mode", "", "P2P", "",
              "### Actual behavior", "", o["rules"].get("actual") or f"{outcome_text(repro['expect']['bug'])}.", "",
              "### Expected behavior", "", f"Oracle text: *\"{o['rules']['oracle']}\"*", ""]
    if o["rules"].get("expected"):
        lines += [o["rules"]["expected"], ""]
    lines += [f"Rules: {', '.join('CR ' + c for c in o['rules']['cr'])}.", "",
              "### Steps to reproduce", "", "Sandbox game (debug card creation), no other permanents:", ""]
    lines += [f"{i}. {s}" for i, s in enumerate(describe_case(repro), 1)]
    lines += ["", f"Result: {outcome_text(repro['expect']['bug'])}.", f"Expected: {outcome_text(repro['expect']['fixed'])}.", ""]
    others = [t for t in o["tests"] if t is not repro]
    if others:
        lines += ["Other cases (worth keeping in a regression test):", ""]
        lines += [f"- {t['name']}: {outcome_text(t['expect']['fixed'])}" for t in others]
        lines += [""]
    lines += ["### Logs/screenshots/game-state", ""]
    if upstream_entry is not None:
        patched = apply_patch(upstream_entry, o["patch"])
        parts = changed_parts(upstream_entry, patched)
        lines += ["Generated card data (the parts that differ):", "", "```"] + [line for k, i in parts for line in part_outline(upstream_entry, k, i)] + ["```", ""]
        lines += [o["rules"].get("diagnosis", ""), ""] if o["rules"].get("diagnosis") else []
        lines += [f"Hand-editing the card data to this makes every case above behave as the Oracle text says "
                  f"({'a workaround, not the fix: the parser should emit it, or the engine should resolve the reference correctly' if o['kind'] != 'card-data' else 'a data fix'}):",
                  "", "```"] + [line for k, i in parts for line in part_outline(patched, k, i)] + ["```", ""]
        a_txt = json.dumps({k: upstream_entry.get(k) for k in ABILITY_LISTS}, indent=1).splitlines()
        b_txt = json.dumps({k: patched.get(k) for k in ABILITY_LISTS}, indent=1).splitlines()
        diff = list(difflib.unified_diff(a_txt, b_txt, "generated", "working", lineterm="", n=2))
        lines += ["<details><summary>JSON diff</summary>", "", "```diff"] + diff + ["```", "", "</details>", ""]
    if o["rules"].get("suggested_fix"):
        lines += [f"Possible fix ({o['kind']}): {o['rules']['suggested_fix']}", ""]
    text = "\n".join(lines).rstrip() + "\n"
    leak = PRIVATE_WORDS.search(text)
    if leak:
        raise OverrideError(f"the draft mentions {leak.group(0)!r}; outward-facing text must not name the project yet")
    return text


def cmd_draft_upstream(a) -> int:
    (o,) = load_overrides([a.slug])
    entry = None
    try:
        e = json.loads(pristine_path(DATA).read_bytes()).get(card_key(o["card"]))
    except OverrideError:
        e = None
    if e is not None and entry_sha256(e) == o["applies_to"]["entry_sha256"]:
        entry = e
    if entry is None:
        log("note: the pinned upstream entry is not in data/; the draft has no ability chain")
    text = draft_upstream(o, entry)
    out = Path(a.out) if a.out else ROOT / "tmp" / "upstream-drafts" / f"{o['_slug']}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    log(text)
    log(f"== draft written to {out} (nothing was posted; the owner posts it, or doesn't)")
    return 0


# ---------------------------------------------------------------------------------------------------------
# upstream: which swapped cards phase-rs is working on (read-only; never posts)

ROTATION = ROOT / "sets" / "rotation.json"
SEARCH_CACHE = ROOT / "tmp" / "upstream-search.json"


def expected_copies(pool: dict) -> dict[str, float]:
    """Expected copies of each sheet card in one booster of a set (packages/director/src/boosters.ts: a weighted pack
    variant, a weighted sheet per slot, `count` weighted draws per slot, every card of a fixed sheet)."""
    exp: dict[str, float] = {}
    tw = sum(v["weight"] for v in pool["pack_variants"]) or 1
    for v in pool["pack_variants"]:
        pv = v["weight"] / tw
        for slot in v["contents"]:
            cw = sum(c["weight"] for c in slot["choices"]) or 1
            for ch in slot["choices"]:
                sheet = pool["sheets"].get(ch["sheet"])
                if not sheet:
                    continue
                pc = pv * ch["weight"] / cw
                for c in sheet["cards"]:
                    share = 1 if sheet["fixed"] else slot["count"] * c["weight"] / (sheet["total_weight"] or 1)
                    exp[c["name"]] = exp.get(c["name"], 0) + pc * share
    return exp


def swapped_cards(pools: dict, unsupported: set[str], code: str, packs: int = 24) -> list[dict]:
    """The cards of a set's booster sheets the generator swaps out (boosters-v2: any unsupported face), most-opened
    first, with expected swaps per draft of `packs` boosters."""
    pool = pools[code.lower()]
    rarity = {c["name"]: c["rarity"] for sh in pool["sheets"].values() for c in sh["cards"]}
    out = []
    for name, e in expected_copies(pool).items():
        faces = [f.strip() for f in name.split(" // ")]
        bad = [f for f in faces if f.lower() in unsupported] or ([name] if name.lower() in unsupported else [])
        if bad:
            out.append({"name": name, "faces": bad, "rarity": rarity.get(name), "per_draft": round(packs * e, 3)})
    return sorted(out, key=lambda c: (-c["per_draft"], c["name"]))


def gh_search(kind: str, name: str, cache: dict, refresh: bool) -> list[dict] | None:
    """`gh search prs|issues --repo phase-rs/phase "<name>"`, cached for a day; None when gh isn't usable."""
    key = f"{kind}:{name.lower()}"
    hit = cache.get(key)
    if hit and not refresh and time.time() - hit["at"] < 24 * 3600:
        return hit["items"]
    if not shutil.which("gh"):
        return None
    time.sleep(2.2)  # the search API allows 30 requests a minute
    r = run(["gh", "search", kind, "--repo", PHASE_REPO, f'"{name}"', "--limit", "10",
             "--json", "number,title,state,url,updatedAt" + (",isDraft" if kind == "prs" else "")], check=False)
    if r.returncode != 0:
        return None
    items = json.loads(r.stdout or "[]")
    if kind == "prs":
        for it in items:  # merged or closed: the search reports "closed" for both
            if it.get("state") == "closed":
                v = run(["gh", "pr", "view", str(it["number"]), "--repo", PHASE_REPO, "--json", "mergedAt"], check=False)
                if v.returncode == 0 and (json.loads(v.stdout or "{}").get("mergedAt")):
                    it["state"] = "merged"
                    it["mergedAt"] = json.loads(v.stdout)["mergedAt"]
    cache[key] = {"at": time.time(), "items": items}
    return items


def cmd_upstream(a) -> int:
    rotation = read_json(ROTATION, {}) or {}
    codes = [c.strip().upper() for x in (a.set or []) for c in x.split(",") if c.strip()] or [s["code"] for s in rotation.get("featured", [])]
    pools = read_json(DATA / "draft-pools.json")
    lst = read_json(DATA / UNSUPPORTED)
    if not pools or not lst:
        raise OverrideError("needs data/draft-pools.json and data/unsupported-cards.json (copy them from phase-server: README)")
    unsupported = {n.lower() for n in lst.get("unsupported", [])}
    overrides = {card_key(o["card"]): o for o in load_overrides(tolerant=True)}
    lk = lock()
    newer = None
    coverage = None
    try:
        tag = newest_release_tag()
        if tag and tag.lstrip("v") != lk.get("server_version"):
            sha, path = release_card_data(tag.lstrip("v"), ROOT / "tmp" / "phase-card-data")
            newer = {"version": tag, "data": json.loads(path.read_bytes())}
    except Exception as e:
        log(f"(newest release not checked: {e!r:.200})")
    try:
        coverage = coverage_support(ROOT / "tmp" / "phase-coverage", refresh=a.refresh)
    except Exception as e:
        log(f"(coverage report not checked: {e!r:.200})")
    cache = read_json(SEARCH_CACHE, {}) or {}
    report = {"pinned": lk.get("server_version"), "newest_release": newer["version"] if newer else lk.get("server_version"), "sets": {}}
    try:
        for code in codes:
            if code.lower() not in pools:
                log(f"== {code}: no booster data")
                continue
            cards = swapped_cards(pools, unsupported, code)
            total = round(sum(c["per_draft"] for c in cards), 2)
            log(f"== {code}: {len(cards)} swapped card(s), about {total} swaps per 24-pack draft "
                f"(pinned {lk.get('server_version')}{'; newest ' + newer['version'] if newer else ''})")
            for c in cards:
                faces = c["faces"]
                o = next((overrides[f.lower()] for f in faces if f.lower() in overrides), None)
                rel = None
                if newer:
                    es = [newer["data"].get(f.lower()) for f in faces]
                    rel = all(e is not None and not has_markers(e) for e in es)
                cov = None if coverage is None else all(coverage.get(f.lower()) is True for f in faces)
                prs, issues = [], []
                for f in faces:
                    for kind, acc in (("prs", prs), ("issues", issues)):
                        items = gh_search(kind, f, cache, a.refresh)
                        if items is None:
                            continue
                        for it in items:
                            if all(x["number"] != it["number"] for x in acc):
                                acc.append(it)
                c.update({"override": (o["_slug"] + f" ({o['status']})") if o else None, "newest_release_supports": rel,
                          "coverage_supports": cov, "prs": prs, "issues": issues})
                bits = [f"{c['per_draft']:6.2f}  {c['rarity'] or '?':9} {c['name']}"]
                if c["override"]:
                    bits.append(f"override {c['override']}")
                if rel:
                    bits.append(f"supported in {newer['version']}")
                if cov:
                    bits.append("supported on phase-rs main (coverage report)")
                # A result whose title names the card first; others only mention it (often a shared parser fix).
                named = lambda it: any(f.lower() in str(it.get("title", "")).lower() for f in faces)  # noqa: E731
                for kind, items in (("PR", prs), ("issue", issues)):
                    for it in sorted(items, key=lambda it: (not named(it), -it["number"])):
                        bits.append(f"{'' if named(it) else 'mentioned in '}{kind} #{it['number']} {it['state']}"
                                    f"{' draft' if it.get('isDraft') else ''}: {clean(it['title'], 70)}")
                log("   " + "\n        ".join(bits))
            report["sets"][code] = {"swaps_per_draft": total, "cards": cards}
    finally:
        SEARCH_CACHE.parent.mkdir(parents=True, exist_ok=True)
        write_json(SEARCH_CACHE, cache)
    if a.json:
        print(json.dumps(report, indent=1, default=str))
    log("== read-only: nothing was posted (gh search results are cached for a day in tmp/upstream-search.json)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="npm run overrides --", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="every override and its status")
    p = sub.add_parser("apply", help="card-data.json = upstream + active overrides, in a data dir")
    p.add_argument("data_dir", nargs="?")
    p.add_argument("--strict", action="store_true", help="exit 1 when an active override was skipped")
    p = sub.add_parser("install", help="apply to data/ and install into a running phase-server container (local dev)")
    p.add_argument("--container", default="mtgdt-phase")
    p.add_argument("--data", help="data dir to apply to (default data/, which the local Director reads)")
    p.add_argument("--force", action="store_true", help="even if an event looks live")
    p = sub.add_parser("test", help="scripted games: the bug on upstream data, fixed with the override")
    p.add_argument("slugs", nargs="*")
    p.add_argument("--upstream", help="test against this card-data.json instead of data/'s upstream copy")
    p.add_argument("--keep", action="store_true", help="keep the throwaway servers")
    p = sub.add_parser("check", help="flag stale overrides (read-only)")
    p.add_argument("--no-network", action="store_true")
    p = sub.add_parser("fingerprint", help="the card data provenance an event would record")
    p.add_argument("data_dir", nargs="?")
    p = sub.add_parser("triage", help="rules reports -> suspected cards (engine/known-issues.json)")
    p.add_argument("runs", nargs="*")
    p.add_argument("--write", action="store_true", help="update engine/known-issues.json")
    p.add_argument("--include-tests", action="store_true", help="also read scripted runs (their random agents file fake reports)")
    p = sub.add_parser("draft-upstream", help="draft a phase-rs bug report from an override (never posts)")
    p.add_argument("slug")
    p.add_argument("--out")
    p = sub.add_parser("upstream", help="swapped cards in the featured sets vs phase-rs PRs, issues, newest release, coverage")
    p.add_argument("--set", action="append", help="set code(s), e.g. FRA or FRA,SOS (default: the featured sets)")
    p.add_argument("--refresh", action="store_true", help="ignore the cached searches and coverage report")
    p.add_argument("--json", action="store_true")
    a = ap.parse_args()
    try:
        return {"list": cmd_list, "apply": cmd_apply, "install": cmd_install, "test": cmd_test, "check": cmd_check,
                "fingerprint": cmd_fingerprint, "triage": cmd_triage, "draft-upstream": cmd_draft_upstream,
                "upstream": cmd_upstream}[a.cmd](a)
    except OverrideError as e:
        log(f"error: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
