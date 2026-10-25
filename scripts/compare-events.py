"""Compare agent seats across events (e.g. a knowledge-level ablation on the same seed).

Usage: python3 -I scripts/compare-events.py runs/<event-a> runs/<event-b> ... [--transcripts DIR ...]
Transcript dirs (with transcript-<seat>.jsonl) are matched to events by order; event dirs are searched too.
Prints a table per seat: knowledge, draft agreement with 17Lands, pick regret, deck colors, record,
mana handling, primer lookups, latency and API-equivalent cost.
"""
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(path: Path) -> list[dict]:
    out = []
    for line in path.open():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def transcript_stats(path: Path) -> dict:
    tools: dict[str, int] = {}
    result = None
    for o in load(path):
        if o.get("type") == "assistant":
            for c in o.get("message", {}).get("content", []):
                if c.get("type") == "tool_use":
                    name = c["name"].removeprefix("mcp__mtg__")
                    tools[name] = tools.get(name, 0) + 1
        if o.get("type") == "result":
            result = o
    return {
        "tools": tools,
        "cost": result.get("total_cost_usd") if result else None,
        "minutes": result["duration_ms"] / 60000 if result else None,
    }


def main(argv: list[str]) -> None:
    events, tdirs, mode = [], [], "events"
    for a in argv:
        if a == "--transcripts":
            mode = "t"
        elif mode == "t":
            tdirs.append(Path(a))
        else:
            events.append(Path(a))
    rows = []
    for i, ev in enumerate(events):
        log = load(ev / "events.jsonl")
        start = next(x for x in log if x["type"] == "event_start")
        code = start["set"]["code"].upper()
        ratings = json.load((ROOT / "sets" / code / "17lands.json").open())["cards"] if (ROOT / "sets" / code / "17lands.json").exists() else {}
        gih = lambda n: (ratings.get(n) or {}).get("gih_wr")
        knowledge = start.get("knowledge", {}).get("level", "?")
        summary = json.load((ev / "summary.json").open()) if (ev / "summary.json").exists() else None
        for seat in [s["name"] for s in start["seats"] if s["kind"] == "agent"]:
            picks = [x for x in log if x["type"] == "draft_pick" and x["seat"] == seat and x["by"] == "agent"]
            top = sum(1 for p in picks if p["pick"] == max(p["pack"], key=lambda c: gih(c) or 0))
            regret = [max(gih(c) or 0 for c in p["pack"]) - gih(p["pick"]) for p in picks if gih(p["pick"])]
            deck = next((x for x in log if x["type"] == "deck_built" and x["seat"] == seat), {})
            decisions = [x for x in log if x["type"] == "agent_decision" and x["seat"] == seat]
            lat = [x["latency_ms"] for x in decisions if "latency_ms" in x]
            games = [x for x in log if x["type"] == "game_over" and seat in (x.get("stats") or {})]
            stats = [g["stats"][seat] for g in games]
            won = sum(1 for g in games if g.get("winner") == seat)
            t = {}
            for d in ([tdirs[i]] if i < len(tdirs) else []) + [ev]:
                f = d / f"transcript-{seat}.jsonl"
                if f.exists() and f.stat().st_size:
                    t = transcript_stats(f)
                    break
            rows.append({
                "event": ev.name[-14:], "knowledge": knowledge, "seat": seat,
                "top17L": f"{top}/{len(picks)}", "regret": f"{statistics.mean(regret) * 100:.2f}pp" if regret else "-",
                "deck": f"{deck.get('by', '?')}",
                "games": f"{won}-{len(games) - won}",
                "manual$": sum(s.get("manual_payments", 0) for s in stats), "autotap": sum(s.get("auto_tapper", 0) for s in stats),
                "rejects": sum(s.get("rejections", 0) for s in stats),
                "lat_s": f"{statistics.median(lat) / 1000:.1f}" if lat else "-",
                "primer_calls": t.get("tools", {}).get("get_set_primer", 0), "card_calls": t.get("tools", {}).get("get_card", 0),
                "cost": f"${t['cost']:.2f}" if t.get("cost") is not None else "-",
            })
        if summary:
            rows.append({"event": ev.name[-14:], "knowledge": knowledge, "seat": "→ " + ", ".join(f"{s['name']} {s['gameWins']}-{s['gameLosses']}" for s in summary["standings"])})
    cols = ["event", "knowledge", "seat", "top17L", "regret", "deck", "games", "manual$", "autotap", "rejects", "lat_s", "primer_calls", "card_calls", "cost"]
    widths = {c: max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    print("  ".join(c.ljust(widths[c]) for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, "")).ljust(widths[c]) for c in cols))


if __name__ == "__main__":
    main(sys.argv[1:])
