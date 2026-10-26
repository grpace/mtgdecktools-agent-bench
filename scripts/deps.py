#!/usr/bin/env python3
"""Keep the benchmark's external dependencies current: one manifest, one command.

    npm run deps -- check [--json OUT] [--no-network]
    npm run deps -- update phase [--tag latest] [--dry-run]
    npm run deps -- update 17lands [--set X ...] [--all] [--featured-and-new] [--max-sets N]
                                   [--steps ratings,archetypes,model,norms] [--keep-raw] [--force]
    npm run deps -- update set-context [--repo PATH | --from-site]
    npm run deps -- update all
    npm run deps -- manifest            # recompute deps/manifest.json from the files on disk (no network)
    npm run deps -- verify              # do the derived files match the manifest hashes? (CI, no network)

`check` also flags card overrides (engine/overrides) that may be stale: written for another phase-rs build, or the card
changed upstream, or its upstream issue was closed (scripts/card_overrides.py check).

(`npm run deps --` is `python3 -I scripts/deps.py`; standard library only.)

deps/manifest.json is the single answer to "what versions of everything are we on?": the phase-rs pin
(engine/phase.lock.json, referenced by hash) and the card/booster data copied from it, one 17Lands snapshot
per set (source URLs, ETag, Last-Modified, rows, date range, sha256 of every derived file), the MTG Deck
Tools set contexts, the model registry version, and what isn't pinned (Scryfall images). deps/set-codes.json
maps set codes between sources. docs/UPGRADING.md is the guide.

`check` changes nothing. `update` refreshes, rebuilds the derived files, rewrites the manifest and prints a
summary (`--summary FILE` also writes it as Markdown, for pull requests). 17Lands rules: only the public S3
files, sequential downloads, retries with backoff, a User-Agent naming the project, raw files deleted after
deriving unless --keep-raw.
"""
from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "deps" / "manifest.json"
CODES = ROOT / "deps" / "set-codes.json"
LOCK = ROOT / "engine" / "phase.lock.json"
DATA = ROOT / "data"
SETS = ROOT / "sets"
L17_DIR = DATA / "17lands"
USER_AGENT = "mtgdecktools-agent-bench/0.1 (dependency check)"
PHASE_REPO = "phase-rs/phase"
PHASE_IMAGE_REPO = "phase-rs/phase-server"
PROTOCOL_FILE = "crates/lobby-broker/src/protocol.rs"
SET_CONTEXT_URL = "https://www.mtgdecktools.com/agent-bench/set-contexts/{code}.md"
SET_CONTEXT_HEADER = ("<!-- Exported from MTG Deck Tools (mtgdecktools.com) set context {file}. Edit it there, then rerun "
                      "scripts/export-mtgdt-primers.ts. Public domain (CC0 1.0).{note} -->\n\n")
SET_CONTEXT_FILTER_NOTE = (" Wording about the AI Deck Builder's per-card scores was filtered for the benchmark "
                           "(packages/director/src/set-context-filter.ts); agents get no such scores.")


def filter_set_context(text: str) -> str:
    """The tier-score filter every Set Context copy goes through (packages/director/src/set-context-filter.ts)."""
    r = subprocess.run(["npx", "--no-install", "tsx", "scripts/export-mtgdt-primers.ts", "--filter"], cwd=ROOT,
                       input=text, capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise RuntimeError(f"set-context filter failed: {(r.stderr or r.stdout)[-300:]}")
    return r.stdout
# Derived files per set, in pipeline order. The analysis ones need the uv environment in analysis/.
OUTPUTS = {
    "ratings": ["sets/{s}/17lands.json", "sets/{s}/ratings.tsv"],
    "archetypes": ["sets/{s}/17lands-archetypes.json"],
    "model": ["analysis/models/{s}.json", "analysis/results/validation-{s}.json"],
    "norms": ["sets/{s}/deck-norms.json", "analysis/results/build-quality-{s}.json"],
}
STEPS = list(OUTPUTS)


def log(msg: str = "") -> None:
    print(msg, flush=True)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p)


def builder():
    """scripts/build-17lands-ratings.py as a module (its HEAD/format/code helpers are the single implementation)."""
    spec = importlib.util.spec_from_file_location("build17", ROOT / "scripts" / "build-17lands-ratings.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def http_json(url: str, headers: dict | None = None, method: str = "GET", tries: int = 3):
    """(status, headers, parsed body or None). Retries network errors with backoff; HTTP errors are returned."""
    delay = 3
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read() if method != "HEAD" else b""
                try:
                    parsed = json.loads(body) if body else None
                except ValueError:
                    parsed = body.decode("utf-8", "replace")
                return r.status, r.headers, parsed
        except urllib.error.HTTPError as e:
            return e.code, e.headers, None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == tries:
                raise RuntimeError(f"{method} {url}: {e!r}")
            time.sleep(delay)
            delay *= 3


# ---------------------------------------------------------------------------------------------------------
# Manifest


def featured() -> list[str]:
    rot = read_json(SETS / "rotation.json", {})
    return [s["code"].upper() for s in rot.get("featured", rot.get("active", []))]


_NAMES: dict | None = None


def set_names() -> dict:
    """phase-rs set names by upper-case code (from data/draft-pools.json, when present)."""
    global _NAMES
    if _NAMES is None:
        p = DATA / "draft-pools.json"
        _NAMES = {c.upper(): v.get("name") for c, v in json.loads(p.read_text()).items()} if p.exists() else {}
    return _NAMES


def phase_sets_local() -> list[str] | None:
    p = DATA / "draft-pools.json"
    if not p.exists():
        return None
    return sorted(c.upper() for c in json.loads(p.read_text()))


def registry_version() -> dict | None:
    """The model registry's own version (packages/registry registryVersion(); owned by the registry)."""
    try:
        out = subprocess.run(
            ["npx", "--no-install", "tsx", "-e",
             "import { registryVersion } from './packages/registry/src/index.ts'; console.log(JSON.stringify(registryVersion()))"],
            cwd=ROOT, capture_output=True, text=True, timeout=120)
        line = [x for x in out.stdout.splitlines() if x.startswith("{")]
        return json.loads(line[-1]) if line else None
    except Exception:
        return None


def outputs_for(s: str) -> dict:
    out = {}
    for files in OUTPUTS.values():
        for f in files:
            p = ROOT / f.format(s=s)
            if p.exists():
                out[f.format(s=s)] = sha256_file(p)
    return out


def set_entry(s: str, prev: dict | None) -> dict | None:
    """Manifest entry for one set from sets/<SET>/17lands.json (+ the previous entry's analysis status)."""
    doc = read_json(SETS / s / "17lands.json")
    if not doc:
        return None
    prev = prev or {}
    files = {}
    for kind, f in (doc.get("source_files") or {}).items():
        files[kind] = f
    entry = {
        "name": set_names().get(s) or prev.get("name"),
        "code": doc.get("source_code", s),
        "format": doc.get("format"),
        "snapshot": doc.get("snapshot"),
        "files": files,
        "date_range": [doc.get("date_range", {}).get("first"), doc.get("date_range", {}).get("last")],
        "games": doc.get("games"),
        "drafts": doc.get("drafts"),
        "cards": len(doc.get("cards", {})),
        "rated_cards": doc.get("rated_cards"),
        "sampled": doc.get("sampled"),
        "generator": doc.get("generator"),
        "derived_at": doc.get("generated_at"),
        "outputs": outputs_for(s),
    }
    for k in ("analysis", "skipped"):
        if prev.get(k):
            entry[k] = prev[k]
    return entry


def build_manifest(prev: dict | None = None, *, registry: bool = True) -> dict:
    """The manifest from what is on disk, keeping network-derived facts (probe results, sources) from `prev`."""
    prev = prev or {}
    lock = read_json(LOCK, {})
    pr_prev = prev.get("phase_rs", {})
    data = dict(pr_prev.get("data", {}))
    for key, name in (("card_data", "card-data.json"), ("booster_data", "draft-pools.json"), ("unsupported", "unsupported-cards.json")):
        p = DATA / name
        if key == "card_data" and p.exists() and (DATA / "card-data.upstream.json").exists():
            # Local card overrides applied (docs/CARD-OVERRIDES.md): the manifest records the upstream file.
            side = read_json(DATA / "card-overrides.json", {}) or {}
            if side.get("sha256") == sha256_file(p):
                p, name = DATA / "card-data.upstream.json", "card-data.upstream.json"
        if p.exists():
            info = {"file": f"data/{name}", "sha256": sha256_file(p), "bytes": p.stat().st_size}
            if key == "unsupported":
                u = read_json(p, {})
                info.update({"count": len(u.get("unsupported", [])), "generated": u.get("generated"),
                             "sources": "this build's card-data markers + https://data.phase-rs.dev/coverage-data.json"})
            data[key] = info
    booster_sets = phase_sets_local() or pr_prev.get("booster_sets", [])
    if "booster_data" in data:
        data["booster_data"]["sets"] = len(booster_sets)
    if "card_data" in data:
        data["card_data"]["cards"] = lock.get("cards")
    phase = {
        "_comment": "The pin itself is engine/phase.lock.json (image digest, server version, build, protocol). Update with `npm run deps -- update phase`.",
        "lock_file": "engine/phase.lock.json",
        "lock_sha256": sha256_file(LOCK) if LOCK.exists() else None,
        "server_version": lock.get("server_version"),
        "protocol_version": lock.get("protocol_version"),
        "data": data,
        "booster_sets": booster_sets,
    }
    for k in ("history", "archived"):
        if pr_prev.get(k):
            phase[k] = pr_prev[k]

    l17_prev = prev.get("17lands", {})
    prev_sets = l17_prev.get("sets", {})
    sets = {}
    for d in sorted(SETS.iterdir()):
        if d.is_dir():
            e = set_entry(d.name, prev_sets.get(d.name))
            if e:
                sets[d.name] = e
    b = builder()
    l17 = {
        "_comment": "One snapshot per set. Raw files are not in git (data/17lands/). Codes: deps/set-codes.json. Refresh: `npm run deps -- update 17lands`.",
        "source": b.BASE,
        "license": "CC BY 4.0 (17Lands public datasets page); derived aggregates, credited, not endorsed by 17Lands (sets/README.md)",
        "codes_file": "deps/set-codes.json",
        "generators": {"ratings": b.GENERATOR, "analysis": "analysis/draft_eval (uv.lock sha256 %s)" % (
            sha256_file(ROOT / "analysis" / "uv.lock")[:12] if (ROOT / "analysis" / "uv.lock").exists() else "?")},
        "thresholds": analysis_thresholds(),
        "checked_at": l17_prev.get("checked_at"),
        "sets": sets,
        "no_public_data": l17_prev.get("no_public_data", []),
        "unmapped": l17_prev.get("unmapped", {}),
    }

    sc_prev = prev.get("set_context", {})
    sc_sets = {}
    for code in featured():
        p = SETS / code / "primer.md"
        if p.exists():
            first = p.read_text(encoding="utf-8").split("\n", 1)[0]
            m = re.search(r"set context (\S+?\.ts)", first)
            sc_sets[code] = {"file": f"sets/{code}/primer.md", "sha256": sha256_file(p), "source_file": m.group(1) if m else None}
    set_context = {
        "_comment": "MTG Deck Tools set contexts (knowledge level `primer`), exported from Magic-Deck-Builder src/setContexts. The Director prefers the published copy at the URL below and logs its sha256 per event. Refresh: `npm run deps -- update set-context`.",
        "source_repo": "Magic-Deck-Builder (private), src/setContexts/<CODE>.ts",
        "published_url": SET_CONTEXT_URL,
        "source_commit": sc_prev.get("source_commit"),
        "exported_at": sc_prev.get("exported_at"),
        "sets": sc_sets,
    }

    reg = registry_version() if registry else None
    reg = reg or prev.get("registry", {}).get("current")
    return {
        "schema": "deps-manifest/1",
        "_comment": "What versions of everything we're on. Written by scripts/deps.py (npm run deps -- manifest|update); don't edit by hand. Guide: docs/UPGRADING.md.",
        "updated_at": prev.get("updated_at") or now(),
        "phase_rs": phase,
        "17lands": l17,
        "set_context": set_context,
        "registry": {
            "_comment": "Owned by the model registry (registry/, packages/registry). Its version is a content hash computed by registryVersion().",
            "files": ["registry/models.json", "registry/harnesses.json"],
            "current": reg,
        },
        "scryfall": {
            "_comment": "Not pinned: the report site loads card images from Scryfall at view time. Card text and booster data come from phase-rs (built from MTGJSON/Scryfall upstream), pinned above.",
            "pinned": False,
        },
    }


def analysis_thresholds() -> dict:
    cfg = (ROOT / "analysis" / "draft_eval" / "config.py").read_text()
    out = {"ratings_min_game_rows": builder().MIN_GAMES, "card_min_gih_games": 200, "card_min_picks_for_ata": 30}
    for k in ("MIN_GAMES_ARCHETYPES", "MIN_EXPERT_DRAFTS", "MIN_DECKS_BUILDEVAL"):
        m = re.search(rf"^{k} = ([\d_]+)", cfg, re.M)
        if m:
            out[k.lower()] = int(m.group(1).replace("_", ""))
    return out


def coverage_table(m: dict) -> str:
    """The sets/README.md coverage block: which sets have 17Lands data and what was built from it."""
    l17 = m.get("17lands", {})
    sets = l17.get("sets", {})
    n_phase = len(m.get("phase_rs", {}).get("booster_sets", []))
    lines = [f"Of the {n_phase} sets with phase-rs booster data, **{len(sets)} have 17Lands data** "
             f"(last probed {str(l17.get('checked_at') or 'never')[:10]}). Model and norms: ✓ built, – skipped (reason in the manifest).", "",
             "| Set | Name | 17Lands | Games | Drafts | Rated cards | Game dates | Pick model | Deck norms |",
             "| --- | --- | --- | ---: | ---: | ---: | --- | :---: | :---: |"]
    order = sorted(sets, key=lambda s: str((sets[s].get("date_range") or [None])[0] or ""), reverse=True)
    for s in order:
        e = sets[s]
        out = e.get("outputs", {})
        model = "✓" if f"analysis/models/{s}.json" in out else "–"
        norms = "✓" if f"sets/{s}/deck-norms.json" in out else "–"
        dr = e.get("date_range") or [None, None]
        lines.append(f"| {s} | {e.get('name') or ''} | {e.get('code')} {e.get('format')} | {e.get('games') or 0:,} | {e.get('drafts') or 0:,} | "
                     f"{e.get('rated_cards')}/{e.get('cards')} | {str(dr[0] or '')[:10]} to {str(dr[1] or '')[:10]} | {model} | {norms} |")
    if l17.get("unmapped"):
        lines += ["", "Left out on purpose (`deps/set-codes.json`): " + "; ".join(f"**{k}**" for k in sorted(l17["unmapped"])) + "."]
    return "\n".join(lines)


def write_coverage(m: dict) -> None:
    p = SETS / "README.md"
    if not p.exists():
        return
    text = p.read_text(encoding="utf-8")
    m1 = re.search(r"(<!-- coverage:start[^>]*-->\n)(.*?)(<!-- coverage:end -->)", text, re.S)
    if not m1:
        return
    new = text[: m1.end(1)] + coverage_table(m) + "\n" + text[m1.start(3):]
    if new != text:
        p.write_text(new, encoding="utf-8")


def save_manifest(m: dict, touched: bool = True) -> None:
    old = read_json(MANIFEST)
    if touched or not old:
        m["updated_at"] = now()
    if old and {k: v for k, v in old.items() if k != "updated_at"} == {k: v for k, v in m.items() if k != "updated_at"}:
        m["updated_at"] = old["updated_at"]
    write_json(MANIFEST, m)
    write_coverage(m)


# ---------------------------------------------------------------------------------------------------------
# Checks (read-only)


def check_phase() -> dict:
    """Newest phase-server image vs the pin, and its protocol version when it can be read from the tag's source."""
    lock = read_json(LOCK, {})
    res: dict = {"pinned": {k: lock.get(k) for k in ("server_version", "protocol_version", "digest", "build_commit")}}
    st, _, tok = http_json(f"https://ghcr.io/token?scope=repository:{PHASE_IMAGE_REPO}:pull")
    if st != 200:
        return {**res, "error": f"ghcr token: HTTP {st}"}
    auth = {"Authorization": f"Bearer {tok['token']}",
            "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"}

    def amd64_digest(ref: str) -> str | None:
        st, _, idx = http_json(f"https://ghcr.io/v2/{PHASE_IMAGE_REPO}/manifests/{ref}", auth)
        if st != 200 or not isinstance(idx, dict):
            return None
        for m in idx.get("manifests", []):
            if m.get("platform", {}).get("architecture") == "amd64" and m.get("platform", {}).get("os") == "linux":
                return m["digest"]
        return None

    latest = amd64_digest("latest")
    res["latest_digest"] = latest
    # Newest release tag on GitHub, its image, and the protocol version in its source.
    st, _, tags = http_json(f"https://api.github.com/repos/{PHASE_REPO}/tags?per_page=30",
                            {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"} if os.environ.get("GITHUB_TOKEN") else None)
    versions = sorted((t["name"] for t in (tags or []) if isinstance(tags, list) and re.fullmatch(r"v\d+\.\d+\.\d+", t["name"])),
                      key=lambda v: tuple(int(x) for x in v[1:].split(".")))
    if versions:
        newest = versions[-1]
        res["newest_release"] = newest
        res["newest_release_digest"] = amd64_digest(newest)
        st, _, src = http_json(f"https://raw.githubusercontent.com/{PHASE_REPO}/{newest}/{PROTOCOL_FILE}")
        m = re.search(r"pub const PROTOCOL_VERSION: u32 = (\d+);", src) if isinstance(src, str) else None
        res["newest_release_protocol"] = int(m.group(1)) if m else None
    res["update_available"] = bool(latest and latest != lock.get("digest"))
    if res.get("newest_release_protocol") and res["newest_release_protocol"] != lock.get("protocol_version"):
        res["protocol_change"] = f"{lock.get('protocol_version')} -> {res['newest_release_protocol']}"
    # New phase-rs sets: local booster data (after a data refresh) vs the manifest.
    man = read_json(MANIFEST, {})
    known = set(man.get("phase_rs", {}).get("booster_sets", []))
    local = phase_sets_local()
    if local is not None and known:
        res["new_sets_in_local_data"] = sorted(set(local) - known)
    return res


def probe_17lands(candidates: list[str], known: dict, delay: float = 0.1) -> dict:
    """HEAD the public files. Returns {set: {status: same|changed|new|none|unmapped, ...}}."""
    b = builder()
    out = {}
    for s in candidates:
        code17, why = b.code17_for(str(ROOT), s)
        if code17 is None:
            out[s] = {"status": "unmapped", "reason": why}
            continue
        entry = known.get(s)
        if entry:
            fmt = entry.get("format") or "PremierDraft"
            files = {k: b.head(b.url_for(k, code17, fmt)) for k in ("game_data", "draft_data")}
        else:
            fmt, files = b.pick_format(code17)
        time.sleep(delay)
        if not fmt or not any(files.values()):
            out[s] = {"status": "gone" if entry else "none"}
            continue
        remote = {k: ({"etag": v["etag"], "last_modified": v["last_modified"], "bytes": v["bytes"]} if v else None) for k, v in files.items()}
        if not entry:
            out[s] = {"status": "new", "code": code17, "format": fmt, "files": remote}
            continue
        changed = []
        for k, v in remote.items():
            old = (entry.get("files") or {}).get(k)
            if (v is None) != (old is None) or (v and old and (v["etag"] != old.get("etag") or v["last_modified"] != old.get("last_modified"))):
                changed.append(k)
        out[s] = {"status": "changed" if changed else "same", "code": code17, "format": fmt, "files": remote,
                  **({"changed_files": changed} if changed else {})}
    return out


def l17_candidates(man: dict) -> list[str]:
    sets = set(man.get("phase_rs", {}).get("booster_sets", []) or phase_sets_local() or [])
    sets |= set(man.get("17lands", {}).get("sets", {}))
    return sorted(sets)


def check_set_context(man: dict, repo: Path | None, site: bool = True) -> dict:
    res: dict = {}
    if repo and (repo / "src" / "setContexts").is_dir():
        r = subprocess.run(["npx", "--no-install", "tsx", "scripts/export-mtgdt-primers.ts", str(repo), "--check"],
                           cwd=ROOT, capture_output=True, text=True, timeout=300)
        line = [x for x in r.stdout.splitlines() if x.startswith("{")]
        if line:
            rep = json.loads(line[-1])
            res["repo"] = {"path": str(repo), "commit": git_commit(repo, "src/setContexts"),
                           "recorded_commit": man.get("set_context", {}).get("source_commit"), "sets": rep}
            res["changed"] = sorted(c for c, v in rep.items() if v["status"] in ("changed", "new"))
            res["not_featured"] = sorted(c for c, v in rep.items() if v["status"] == "not_featured")
        else:
            res["repo_error"] = (r.stderr or r.stdout)[-500:]
    site = {}
    for code in (featured() if site else []):
        st, hdr, body = http_json(SET_CONTEXT_URL.format(code=code))
        ctype = (hdr.get("Content-Type", "") if hdr else "")
        if st != 200 or "html" in ctype or not isinstance(body, str):
            site[code] = "not published"
            continue
        p = SETS / code / "primer.md"
        local = p.read_text(encoding="utf-8").split("\n\n", 1)[-1] if p.exists() else None
        # The repo copy is the filtered text (tier-score wording rewritten), so compare against the filtered site copy.
        site[code] = "same" if local is not None and local.strip() == filter_set_context(body.strip()).strip() else "changed"
    res["site"] = site
    res["site_changed"] = sorted(c for c, v in site.items() if v == "changed")
    return res


def git_commit(repo: Path, path: str = ".") -> str | None:
    r = subprocess.run(["git", "-C", str(repo), "log", "-1", "--format=%H %cs", "--", path], capture_output=True, text=True)
    return r.stdout.strip() or None


def cmd_check(a) -> int:
    man = read_json(MANIFEST, {}) or build_manifest(registry=False)
    report: dict = {"checked_at": now()}
    if a.no_network:
        report["note"] = "--no-network: only local comparisons"
    else:
        log("== phase-rs")
        try:
            report["phase"] = check_phase()
        except Exception as e:
            report["phase"] = {"error": repr(e)}
        ph = report["phase"]
        log(f"   pinned {ph.get('pinned', {}).get('server_version')} (protocol {ph.get('pinned', {}).get('protocol_version')})")
        if ph.get("error"):
            log(f"   could not check: {ph['error']}")
        elif ph.get("update_available"):
            log(f"   NEWER IMAGE: latest = {ph.get('latest_digest')}; newest release {ph.get('newest_release')} "
                f"(protocol {ph.get('newest_release_protocol') or 'unknown'}){'; PROTOCOL CHANGE ' + ph['protocol_change'] if ph.get('protocol_change') else ''}")
        else:
            log("   up to date")
        if ph.get("new_sets_in_local_data"):
            log(f"   sets in data/draft-pools.json not yet in the manifest: {', '.join(ph['new_sets_in_local_data'])}")

        log("== 17Lands (HEAD requests to the public S3 files)")
        known = man.get("17lands", {}).get("sets", {})
        cands = l17_candidates(man)
        if a.set:
            cands = [s.upper() for s in a.set]
        probe = probe_17lands(cands, known)
        report["17lands"] = {
            "probed": len(probe),
            "changed": sorted(s for s, v in probe.items() if v["status"] == "changed"),
            "new": sorted(s for s, v in probe.items() if v["status"] == "new"),
            "gone": sorted(s for s, v in probe.items() if v["status"] == "gone"),
            "unchanged": sorted(s for s, v in probe.items() if v["status"] == "same"),
            "no_public_data": sorted(s for s, v in probe.items() if v["status"] == "none"),
            "unmapped": {s: v["reason"] for s, v in probe.items() if v["status"] == "unmapped"},
            "detail": {s: v for s, v in probe.items() if v["status"] in ("changed", "new", "gone")},
        }
        r = report["17lands"]
        log(f"   {len(r['unchanged'])} unchanged, {len(r['changed'])} changed {r['changed'] or ''}, "
            f"{len(r['new'])} new {r['new'] or ''}, {len(r['no_public_data'])} phase-rs sets without public data"
            + (f", gone: {r['gone']}" if r["gone"] else ""))
        for s, why in r["unmapped"].items():
            log(f"   {s}: unmapped ({why[:90]}…)")

    log("== Set Context")
    repo = Path(a.repo or os.environ.get("MTGDT_REPO") or ROOT.parent / "Magic-Deck-Builder")
    sc = check_set_context(man, repo, site=not a.no_network)
    report["set_context"] = sc
    if "repo" in sc:
        rc = sc["repo"]
        log(f"   Magic-Deck-Builder src/setContexts at {rc['commit']} (manifest: {rc['recorded_commit']}); "
            f"changed: {sc['changed'] or 'none'}; not featured: {sc['not_featured'] or 'none'}")
    elif sc.get("repo_error"):
        log(f"   repo check failed: {sc['repo_error']}")
    else:
        log(f"   no Magic-Deck-Builder checkout at {repo} (set MTGDT_REPO); checked the published copies only")
    if sc.get("site"):
        pub = {v for v in sc["site"].values()}
        log(f"   published copies: {', '.join(sorted(pub))}" + (f"; changed: {sc['site_changed']}" if sc.get("site_changed") else ""))

    log("== Card overrides (engine/overrides; docs/CARD-OVERRIDES.md)")
    try:
        spec = importlib.util.spec_from_file_location("card_overrides", ROOT / "scripts" / "card_overrides.py")
        co = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(co)
        report["card_overrides"] = co.check(no_network=a.no_network,
                                            newest_release=(report.get("phase") or {}).get("newest_release"))
        co.print_check(report["card_overrides"])
    except Exception as e:  # never let this section break the rest of the check
        report["card_overrides"] = {"error": repr(e)[:300], "flags": 1}
        log(f"   could not check: {e!r}"[:300])

    log("== Model registry (owned by the registry; reference only)")
    reg = registry_version()
    rec = man.get("registry", {}).get("current") or {}
    report["registry"] = {"current": reg, "recorded": rec.get("version")}
    log(f"   {reg and reg.get('version')} (manifest: {rec.get('version')})")

    log("== Manifest")
    mismatches = verify(man)
    report["manifest_mismatches"] = mismatches
    if mismatches:
        log(f"   {len(mismatches)} derived files differ from their recorded hash ({', '.join(mismatches[:4])}{', …' if len(mismatches) > 4 else ''}): "
            "run `npm run deps -- manifest` after a deliberate edit")
    else:
        log("   derived files match")

    report["actions"] = actions(report)
    log("== Suggested")
    for x in report["actions"] or ["nothing to do"]:
        log(f"   {x}")
    if a.json:
        write_json(Path(a.json), report)
    return 0


def actions(report: dict) -> list[str]:
    out = []
    ph = report.get("phase", {})
    if ph.get("update_available"):
        out.append("npm run deps -- update phase --dry-run   # then without --dry-run (own pull request)")
    r = report.get("17lands", {})
    sets = r.get("changed", []) + r.get("new", [])
    if sets:
        out.append(f"npm run deps -- update 17lands {' '.join('--set ' + s for s in sets)}")
    sc = report.get("set_context", {})
    if sc.get("changed") or sc.get("site_changed"):
        out.append("npm run deps -- update set-context")
    if report.get("manifest_mismatches"):
        out.append("npm run deps -- manifest")
    if (report.get("card_overrides") or {}).get("flags"):
        out.append("npm run overrides -- test   # then retire or re-pin each flagged override (docs/CARD-OVERRIDES.md)")
    return out


def verify(man: dict) -> list[str]:
    bad = []
    for s, e in (man.get("17lands", {}).get("sets") or {}).items():
        for f, h in (e.get("outputs") or {}).items():
            p = ROOT / f
            if not p.exists():
                bad.append(f"{f} (missing)")
            elif sha256_file(p) != h:
                bad.append(f)
        for f in outputs_for(s):
            if f not in (e.get("outputs") or {}):
                bad.append(f"{f} (not in the manifest)")
    for code, e in (man.get("set_context", {}).get("sets") or {}).items():
        p = ROOT / e["file"]
        if not p.exists() or sha256_file(p) != e["sha256"]:
            bad.append(e["file"])
    if LOCK.exists() and man.get("phase_rs", {}).get("lock_sha256") not in (None, sha256_file(LOCK)):
        bad.append("engine/phase.lock.json")
    return bad


def cmd_verify(a) -> int:
    man = read_json(MANIFEST)
    if not man:
        log("deps/manifest.json is missing")
        return 1
    bad = verify(man)
    for f in bad:
        log(f"differs from deps/manifest.json: {f}")
    if bad:
        log("Derived files changed without the manifest. If the change is deliberate: npm run deps -- manifest")
        return 1
    log(f"deps/manifest.json matches {sum(len(e.get('outputs', {})) for e in man['17lands']['sets'].values())} derived 17Lands files, "
        f"{len(man['set_context']['sets'])} set contexts and the engine lock.")
    return 0


def cmd_manifest(a) -> int:
    m = build_manifest(read_json(MANIFEST, {}))
    save_manifest(m)
    log(f"wrote deps/manifest.json: {len(m['17lands']['sets'])} 17Lands sets, {len(m['phase_rs']['booster_sets'])} phase-rs sets")
    return 0


# ---------------------------------------------------------------------------------------------------------
# Updates


def short(err, n: int = 300) -> str:
    """One readable line of an error (17Lands parse errors can quote megabytes of NUL bytes)."""
    text = re.sub(r"(\\x00)+|\x00+", "", str(err or ""))
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def top_moves(old: dict | None, new: dict, n: int = 5, min_games: int = 500) -> list[str]:
    if not old:
        return []
    moves = []
    for name, c in new.get("cards", {}).items():
        o = old.get("cards", {}).get(name)
        if not o or c.get("gih_wr") is None or o.get("gih_wr") is None:
            continue
        if min(c.get("gih_games", 0), o.get("gih_games", 0)) < min_games:
            continue
        if abs(c["gih_wr"] - o["gih_wr"]) >= 0.001:
            moves.append((c["gih_wr"] - o["gih_wr"], name, o["gih_wr"], c["gih_wr"]))
    moves.sort(key=lambda x: -abs(x[0]))
    return [f"{nm}: {a * 100:.1f}% -> {b * 100:.1f}% ({d * 100:+.1f})" for d, nm, a, b in moves[:n]]


def raw_files(s: str) -> list[Path]:
    doc = read_json(SETS / s / "17lands.json", {})
    code, fmt = doc.get("source_code", s), doc.get("format", "PremierDraft")
    return [L17_DIR / f"{k}_public.{code}.{fmt}.csv.gz" for k in ("game_data", "draft_data")]


def run_ratings(s: str, force_format: str | None = None) -> dict:
    st_file = ROOT / "tmp" / "deps" / f"ratings-{s}.json"
    st_file.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-I", str(ROOT / "scripts" / "build-17lands-ratings.py"), s, "--status-json", str(st_file)]
    if force_format:
        cmd += ["--format", force_format]
    subprocess.run(cmd, cwd=ROOT)
    return (read_json(st_file, {}) or {}).get(s, {"status": "failed", "reason": "no status written"})


def ensure_slim() -> None:
    """The analysis reads data/card-data.slim.json (the Director's card index); build it if only card-data.json exists."""
    if (DATA / "card-data.slim.json").exists() or not (DATA / "card-data.json").exists():
        return
    log("== building data/card-data.slim.json")
    subprocess.run(["npx", "--no-install", "tsx", "-e",
                    "import { CardDb } from './packages/director/src/cards.ts'; new CardDb('data/card-data.json')"], cwd=ROOT, check=True)


def run_analysis(s: str, steps: list[str], keep_raw: bool) -> dict:
    st_file = ROOT / "tmp" / "deps" / f"analysis-{s}.json"
    cmd = ["uv", "run", "--project", str(ROOT / "analysis"), "python", "-m", "draft_eval", "pipeline", s,
           "--json", str(st_file), "--steps", ",".join(steps)]
    if not keep_raw:
        cmd.append("--drop-cache")
    if st_file.exists():
        st_file.unlink()
    subprocess.run(cmd, cwd=ROOT / "analysis")
    return (read_json(st_file, {}) or {}).get(s, {"error": "pipeline wrote no status"})


def cmd_update_17lands(a) -> tuple[int, list[str]]:
    t_start = time.time()
    man = read_json(MANIFEST, {}) or build_manifest(registry=False)
    known = man.get("17lands", {}).get("sets", {})
    steps = [x for x in a.steps.split(",") if x]
    lines: list[str] = []
    if a.set:
        targets = [s.upper() for s in a.set]
        probe = None
    else:
        log("== probing 17Lands for changed and new sets")
        cands = l17_candidates(man)
        probe = probe_17lands(cands, known)
        changed = sorted(s for s, v in probe.items() if v["status"] == "changed")
        new = sorted(s for s, v in probe.items() if v["status"] == "new")
        if a.all:
            targets = sorted(s for s, v in probe.items() if v["status"] in ("changed", "new", "same"))
        elif a.featured_and_new:
            feat = set(featured())
            targets = sorted(s for s in changed if s in feat) + new
            later = [s for s in changed if s not in feat]
            if later:
                lines.append(f"- Changed upstream but not refreshed here (not featured; run locally): {', '.join(later)}")
        else:
            targets = changed + new
        l17 = man.setdefault("17lands", {})
        l17["checked_at"] = now()
        l17["no_public_data"] = sorted(s for s, v in probe.items() if v["status"] == "none")
        l17["unmapped"] = {s: v["reason"] for s, v in probe.items() if v["status"] == "unmapped"}
    if a.max_sets and len(targets) > a.max_sets:
        lines.append(f"- {len(targets) - a.max_sets} more sets are due; this run stopped at --max-sets {a.max_sets}: {', '.join(targets[a.max_sets:])}")
        targets = targets[: a.max_sets]
    if not targets:
        log("nothing to refresh")
        save_manifest(build_manifest(man), touched=False)
        return 0, lines
    log(f"== refreshing {len(targets)} sets: {' '.join(targets)} (steps: {','.join(steps)})")
    if any(x != "ratings" for x in steps):
        if not (DATA / "draft-pools.json").exists():
            log("warning: data/draft-pools.json is missing: card colors and rarities for the analysis come from phase-rs data "
                "(copy it from the pinned phase-server; see docs/UPGRADING.md)")
        ensure_slim()
    size_before = sum((ROOT / f).stat().st_size for e in known.values() for f in e.get("outputs", {}) if (ROOT / f).exists())
    downloaded = 0
    failures = 0
    for i, s in enumerate(targets, 1):
        t0 = time.time()
        log(f"\n===== [{i}/{len(targets)}] {s} =====")
        old_doc = read_json(SETS / s / "17lands.json")
        prev_entry = known.get(s, {})
        if probe and probe.get(s, {}).get("status") == "same" and not a.force and prev_entry.get("outputs"):
            log(f"[{s}] unchanged upstream; skipping (use --force)")
            continue
        st = run_ratings(s) if "ratings" in steps else {"status": "ok" if old_doc else "missing"}
        entry_extra: dict = {}
        if st["status"] != "ok":
            log(f"[{s}] ratings: {st}")
            if st["status"] == "failed":
                failures += 1
            lines.append(f"- {s}: not built ({st.get('status')}: {st.get('reason')})")
            if st["status"] == "thin":
                man.setdefault("17lands", {}).setdefault("thin", {})[s] = st.get("reason")
            continue
        downloaded += st.get("downloaded_bytes", 0)
        analysis_steps = [x for x in steps if x != "ratings"]
        if analysis_steps:
            res = run_analysis(s, analysis_steps, a.keep_raw)
            entry_extra["analysis"] = {k: v for k, v in res.items() if isinstance(v, dict)}
            skipped = {k: v.get("reason") for k, v in res.items() if isinstance(v, dict) and v.get("status") == "skipped"}
            fails = {k: short(v.get("error")) for k, v in res.items() if isinstance(v, dict) and v.get("status") == "failed"}
            if fails:
                failures += 1
            entry_extra["skipped"] = {**skipped, **{k: f"failed: {v}" for k, v in fails.items()}}
        if not a.keep_raw:
            for p in raw_files(s):
                if p.exists():
                    p.unlink()
        # manifest after every set, so a long backfill can stop and resume
        prev = man.get("17lands", {}).get("sets", {}).get(s, {})
        merged_prev = {**prev, **entry_extra}
        if "analysis" in entry_extra and "analysis" in prev:
            merged_prev["analysis"] = {**prev["analysis"], **entry_extra["analysis"]}
        if "skipped" in entry_extra:
            sk = {k: v for k, v in (prev.get("skipped") or {}).items() if k not in analysis_steps}
            sk.update({k: v for k, v in entry_extra["skipped"].items() if v})
            merged_prev["skipped"] = sk
        man.setdefault("17lands", {}).setdefault("sets", {})[s] = merged_prev
        man = build_manifest(man, registry=False)
        save_manifest(man)
        new_doc = read_json(SETS / s / "17lands.json", {})
        e = man["17lands"]["sets"][s]
        desc = (f"- **{s}** {'updated' if old_doc else 'added'}: {e['snapshot']} ({e['games']:,} games, {e['drafts']:,} drafts, "
                f"{e['rated_cards']}/{e['cards']} cards rated; data {str(e['date_range'][0])[:10]} to {str(e['date_range'][1])[:10]})")
        if old_doc and old_doc.get("snapshot") and old_doc.get("snapshot") != e["snapshot"]:
            desc += f"; was {old_doc.get('snapshot')}"
        if e.get("skipped"):
            desc += "; skipped: " + "; ".join(f"{k} ({v})" for k, v in e["skipped"].items())
        lines.append(desc)
        for mv in top_moves(old_doc, new_doc):
            lines.append(f"  - {mv}")
        log(f"[{s}] done in {time.time() - t0:.0f}s")
    man = build_manifest(man)
    save_manifest(man)
    size_after = sum((ROOT / f).stat().st_size for e in man["17lands"]["sets"].values() for f in e.get("outputs", {}) if (ROOT / f).exists())
    lines.append(f"- Downloaded {downloaded / 1e9:.2f} GB in {(time.time() - t_start) / 60:.0f} min; derived files {size_before / 1e6:.1f} MB -> {size_after / 1e6:.1f} MB"
                 + ("" if a.keep_raw else "; raw files deleted"))
    return (1 if failures else 0), lines


def archive_booster_data() -> list[str]:
    """Copy the outgoing draft-pools.json / unsupported-cards.json to the Hub booster archive as <sha256>.json."""
    dest = Path(os.environ.get("HUB_BOOSTER_ARCHIVE") or DATA / "booster-archive")
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for name in ("draft-pools.json", "unsupported-cards.json"):
        p = DATA / name
        if p.exists():
            h = sha256_file(p)
            target = dest / f"{h}.json"
            if not target.exists():
                shutil.copyfile(p, target)
            out.append(str(target))
    return out


def cmd_update_phase(a) -> tuple[int, list[str]]:
    lines = []
    before_lock = read_json(LOCK, {})
    before_sets = set(phase_sets_local() or [])
    archived = [] if a.dry_run else archive_booster_data()
    for p in archived:
        log(f"archived outgoing booster data: {p}")
    cmd = [str(ROOT / "scripts" / "upgrade-phase.sh"), a.tag] + (["--dry-run"] if a.dry_run else [])
    rc = subprocess.run(cmd, cwd=ROOT).returncode
    if rc != 0:
        return rc, [f"- phase-rs upgrade to `{a.tag}` blocked (smoke test or pull failed); pin unchanged"]
    after = read_json(LOCK, {})
    if a.dry_run or after.get("digest") == before_lock.get("digest"):
        return 0, [f"- phase-rs: no change ({'dry run' if a.dry_run else 'already on the newest image'})"]
    after_sets = set(phase_sets_local() or [])
    man = read_json(MANIFEST, {})
    # Earlier pins stay accepted by the Hub (packages/hub/src/config.ts previousEngineDigests).
    # The outgoing card data too: the Hub's provenance.card_data check keeps vouching for events that ran on it.
    outgoing_card_data = man.get("phase_rs", {}).get("data", {}).get("card_data", {}).get("sha256")
    man.setdefault("phase_rs", {}).setdefault("history", []).append({
        **{k: before_lock.get(k) for k in ("digest", "server_version", "build_commit", "protocol_version", "verified_at")},
        **({"card_data_sha256": outgoing_card_data} if outgoing_card_data else {}),
        "replaced_at": now()[:10],
    })
    if archived:
        man.setdefault("phase_rs", {}).setdefault("archived", [])
        for p in archived:
            nm = Path(p).name
            if nm not in man["phase_rs"]["archived"]:
                man["phase_rs"]["archived"].append(nm)
    man = build_manifest(man)
    save_manifest(man)
    lines.append(f"- phase-rs {before_lock.get('server_version')} -> {after.get('server_version')} (build {after.get('build_commit')}, "
                 f"protocol {before_lock.get('protocol_version')} -> {after.get('protocol_version')}, digest {after.get('digest')})")
    lines.append(f"- cards {before_lock.get('cards')} -> {after.get('cards')}; draft sets {before_lock.get('draft_sets')} -> {after.get('draft_sets')}")
    new = sorted(after_sets - before_sets)
    if new:
        lines.append(f"- new phase-rs sets: {', '.join(new)} (17Lands data is picked up by the next `deps check` / `update 17lands`)")
    if archived:
        lines.append(f"- outgoing booster data archived for the Hub ({', '.join(Path(p).name[:12] for p in archived)}); "
                     "copy them into the production Hub's HUB_BOOSTER_ARCHIVE before deploying (docs/UPGRADING.md)")
    return 0, lines


def cmd_update_set_context(a) -> tuple[int, list[str]]:
    man = read_json(MANIFEST, {}) or build_manifest(registry=False)
    repo = Path(a.repo or os.environ.get("MTGDT_REPO") or ROOT.parent / "Magic-Deck-Builder")
    before = {c: e["sha256"] for c, e in (man.get("set_context", {}).get("sets") or {}).items()}
    lines = []
    if not a.from_site and (repo / "src" / "setContexts").is_dir():
        r = subprocess.run(["npx", "--no-install", "tsx", "scripts/export-mtgdt-primers.ts", str(repo)], cwd=ROOT)
        if r.returncode:
            return r.returncode, ["- set-context export failed"]
        sc = man.setdefault("set_context", {})
        sc["source_commit"] = git_commit(repo, "src/setContexts")
        sc["exported_at"] = now()
        sc["exported_from"] = "repo"
    else:
        log(f"== no Magic-Deck-Builder checkout at {repo}; using the published copies")
        for code in featured():
            st, hdr, body = http_json(SET_CONTEXT_URL.format(code=code))
            if st != 200 or "html" in (hdr.get("Content-Type", "") if hdr else "") or not isinstance(body, str):
                continue
            p = SETS / code / "primer.md"
            first = p.read_text(encoding="utf-8").split("\n", 1)[0] if p.exists() else ""
            m = re.search(r"set context (\S+?\.ts)", first)
            filtered = filter_set_context(body.strip()).strip()
            note = SET_CONTEXT_FILTER_NOTE if filtered != body.strip() else ""
            text = SET_CONTEXT_HEADER.format(file=m.group(1) if m else f"{code}.ts", note=note) + filtered + "\n"
            if not p.exists() or p.read_text(encoding="utf-8") != text:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text, encoding="utf-8")
        sc = man.setdefault("set_context", {})
        sc["exported_at"] = now()
        sc["exported_from"] = SET_CONTEXT_URL
    man = build_manifest(man)
    save_manifest(man)
    after = {c: e["sha256"] for c, e in man["set_context"]["sets"].items()}
    for c in sorted(set(before) | set(after)):
        if before.get(c) != after.get(c):
            lines.append(f"- Set Context {c}: {'added' if c not in before else 'removed' if c not in after else 'updated'}")
    if not lines:
        lines.append("- Set Context: no changes")
    return 0, lines


def cmd_update(a) -> int:
    what = a.what
    rc = 0
    lines: list[str] = []
    if what in ("phase", "all"):
        r, l = cmd_update_phase(a)
        rc |= r
        lines += l
    if what in ("17lands", "all"):
        r, l = cmd_update_17lands(a)
        rc |= r
        lines += l
    if what in ("set-context", "all"):
        r, l = cmd_update_set_context(a)
        rc |= r
        lines += l
    text = "\n".join(lines)
    log("\n== Summary\n" + text)
    if a.summary:
        summary = Path(a.summary)
        summary.parent.mkdir(parents=True, exist_ok=True)
        summary.write_text(text + "\n", encoding="utf-8")
    return rc


def main() -> int:
    ap = argparse.ArgumentParser(prog="npm run deps --", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("check", help="report available updates; changes nothing")
    p.add_argument("--json", help="also write the report as JSON")
    p.add_argument("--set", action="append", help="limit the 17Lands probe to these sets")
    p.add_argument("--repo", help="Magic-Deck-Builder checkout (default ../Magic-Deck-Builder or $MTGDT_REPO)")
    p.add_argument("--no-network", action="store_true")
    p = sub.add_parser("update", help="refresh a dependency and its derived files")
    p.add_argument("what", choices=["phase", "17lands", "set-context", "all"])
    p.add_argument("--set", action="append", help="17lands: only these sets (repeatable)")
    p.add_argument("--all", action="store_true", help="17lands: every set with public data, even unchanged ones (with --force)")
    p.add_argument("--featured-and-new", action="store_true", help="17lands: changed featured sets and new sets only (CI)")
    p.add_argument("--max-sets", type=int, default=0)
    p.add_argument("--steps", default=",".join(STEPS), help="17lands: subset of " + ",".join(STEPS))
    p.add_argument("--keep-raw", action="store_true", help="17lands: keep the downloaded CSVs and parquet cache")
    p.add_argument("--force", action="store_true", help="17lands: rebuild sets whose upstream files are unchanged")
    p.add_argument("--tag", default="latest", help="phase: image tag (default latest)")
    p.add_argument("--dry-run", action="store_true", help="phase: full check against the candidate, never switch")
    p.add_argument("--repo", help="set-context: Magic-Deck-Builder checkout")
    p.add_argument("--from-site", action="store_true", help="set-context: use the published copies on mtgdecktools.com")
    p.add_argument("--summary", help="write the summary as Markdown here")
    sub.add_parser("manifest", help="recompute deps/manifest.json from the files on disk")
    sub.add_parser("verify", help="check derived files against the manifest (no network)")
    a = ap.parse_args()
    if a.cmd == "check":
        return cmd_check(a)
    if a.cmd == "update":
        return cmd_update(a)
    if a.cmd == "manifest":
        return cmd_manifest(a)
    return cmd_verify(a)


if __name__ == "__main__":
    sys.exit(main())
