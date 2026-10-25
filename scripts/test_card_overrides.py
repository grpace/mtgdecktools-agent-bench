"""Unit tests for scripts/card_overrides.py (no network, no containers, no data/ needed).

    python3 -I scripts/test_card_overrides.py

The scripted-game tests of each override need phase-server: `npm run overrides -- test`.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import card_overrides as co  # noqa: E402

ENTRY = {
    "name": "Test Spell", "oracle_text": "Deal 6. You may exile. If you do, deal 2 to its controller.",
    "abilities": [{"kind": "Spell", "effect": {"type": "DealDamage", "amount": {"type": "Fixed", "value": 6}},
                   "sub_ability": {"effect": {"type": "ChangeZone"}, "optional": True,
                                   "sub_ability": {"effect": {"type": "DealDamage", "target": {"type": "ParentTargetController"}}}}}],
}


def override(**kw) -> dict:
    o = {
        "card": "Test Spell", "status": "active", "kind": "parser", "upstream_issue": None,
        "applies_to": {"server_version": "0.115.0", "build_commit": "6485512", "card_data_sha256": "x" * 64,
                       "entry_sha256": co.entry_sha256(ENTRY)},
        "rules": {"oracle": ENTRY["oracle_text"], "cr": ["608.2c"]},
        "patch": [{"op": "test", "path": "/abilities/0/sub_ability/sub_ability/effect/target", "value": {"type": "ParentTargetController"}},
                  {"op": "replace", "path": "/abilities/0/sub_ability/sub_ability/effect/target", "value": {"type": "Fixed"}}],
        "tests": [{"name": "bug", "setup": [], "cast": {"card": "Test Spell"}, "expect": {"fixed": {"life": [20, 18]}, "bug": {"life": [18, 20]}}}],
    }
    o.update(kw)
    b = json.dumps(o).encode()
    o.update({"_slug": kw.get("_slug", "test-spell"), "_path": Path("/dev/null"), "_sha256": hashlib.sha256(b).hexdigest()})
    return o


class Patch(unittest.TestCase):
    def test_ops(self):
        doc = {"a": [1, 2], "b": {"c": 1}}
        out = co.apply_patch(doc, [
            {"op": "add", "path": "/a/1", "value": 9}, {"op": "remove", "path": "/b/c"}, {"op": "replace", "path": "/a/0", "value": 0},
            {"op": "copy", "from": "/a", "path": "/d"}, {"op": "move", "from": "/d", "path": "/b/d"}, {"op": "add", "path": "/a/-", "value": 3},
            {"op": "test", "path": "/b/d", "value": [0, 9, 2]},
        ])
        self.assertEqual(out, {"a": [0, 9, 2, 3], "b": {"d": [0, 9, 2]}})
        self.assertEqual(doc, {"a": [1, 2], "b": {"c": 1}}, "the input is not modified")

    def test_failed_test_op_and_missing_paths(self):
        with self.assertRaises(co.OverrideError):
            co.apply_patch({"a": 1}, [{"op": "test", "path": "/a", "value": 2}])
        with self.assertRaises(co.OverrideError):
            co.apply_patch({"a": 1}, [{"op": "replace", "path": "/b", "value": 2}])
        with self.assertRaises(co.OverrideError):
            co.apply_patch({"a": 1}, [{"op": "remove", "path": "/b"}])

    def test_pointer_escapes(self):
        self.assertEqual(co.apply_patch({"a/b": {"~": 1}}, [{"op": "replace", "path": "/a~1b/~0", "value": 2}]), {"a/b": {"~": 2}})


class Apply(unittest.TestCase):
    def data(self) -> dict:
        return {"test spell": copy.deepcopy(ENTRY), "mountain": {"name": "Mountain", "abilities": []}}

    def test_applies_only_a_matching_entry(self):
        data, applied, skipped = co.patch_card_data(self.data(), [override()])
        self.assertEqual([o["_slug"] for o in applied], ["test-spell"])
        self.assertEqual(data["test spell"]["abilities"][0]["sub_ability"]["sub_ability"]["effect"]["target"], {"type": "Fixed"})
        self.assertEqual(skipped, [])

    def test_stale_entry_is_skipped_not_applied(self):
        d = self.data()
        d["test spell"]["oracle_text"] += " (errata)"
        data, applied, skipped = co.patch_card_data(d, [override()])
        self.assertEqual(applied, [])
        self.assertIn("stale", skipped[0]["reason"])
        self.assertEqual(data["test spell"], d["test spell"])

    def test_retired_is_never_applied(self):
        _, applied, skipped = co.patch_card_data(self.data(), [override(status="retired")])
        self.assertEqual((applied, skipped), ([], []))

    def test_fingerprint(self):
        a, b = override(_slug="a-card"), override(_slug="b-card")
        self.assertEqual(co.fingerprint([a, b]), co.fingerprint([b, a]))
        self.assertNotEqual(co.fingerprint([a]), co.fingerprint([b]))
        self.assertEqual(co.fingerprint([]), hashlib.sha256(b"").hexdigest())

    def test_round_trip_is_byte_exact(self):
        raw = co.dump_card_data(self.data())
        self.assertEqual(co.dump_card_data(json.loads(raw)), raw)

    def test_build_is_deterministic_and_tracks_upstream(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            upstream = co.dump_card_data(self.data())
            (d / co.CARD_DATA).write_bytes(upstream)
            side1 = co.build(d, [override()])
            self.assertEqual(side1["upstream_sha256"], hashlib.sha256(upstream).hexdigest())
            self.assertEqual((d / co.UPSTREAM_COPY).read_bytes(), upstream, "the pristine copy is kept")
            self.assertEqual([o["slug"] for o in side1["overrides"]], ["test-spell"])
            self.assertEqual(co.build(d, [override()]), side1, "re-applying reads the pristine copy and changes nothing")
            # A fresh upstream copy lands on top (a new phase-rs build): it becomes the new pristine copy.
            newer = self.data()
            newer["mountain"]["abilities"] = ["changed"]
            (d / co.CARD_DATA).write_bytes(co.dump_card_data(newer))
            side2 = co.build(d, [override()])
            self.assertNotEqual(side2["upstream_sha256"], side1["upstream_sha256"])
            self.assertEqual(json.loads((d / co.UPSTREAM_COPY).read_bytes())["mountain"]["abilities"], ["changed"])
            # No overrides: card-data.json is the upstream bytes, and the fingerprint is the empty set's.
            side3 = co.build(d, [])
            self.assertEqual(side3["sha256"], side3["upstream_sha256"])
            self.assertEqual(side3["overrides_sha256"], hashlib.sha256(b"").hexdigest())


class Supported(unittest.TestCase):
    """Overrides that make a card supported take it off the unsupported-card list (and putting it back works)."""

    def test_adjust_takes_off_and_restores(self):
        base = {"generated": "2026-10-23", "sources": {"x": 1}, "unsupported": ["Zeta", "alpha", "Molten Tide", "Essence Burn"]}
        out, changed = co.adjust_unsupported(base, ["essence burn", "Not Listed"])
        self.assertTrue(changed)
        self.assertEqual(out["unsupported"], ["alpha", "Molten Tide", "Zeta"])
        self.assertEqual(out["removed_by_overrides"], ["Essence Burn"])
        self.assertEqual((out["generated"], out["sources"]), ("2026-10-23", {"x": 1}), "other fields kept")
        self.assertEqual(co.adjust_unsupported(out, ["Essence Burn"]), (out, False), "idempotent")
        back, changed = co.adjust_unsupported(out, [])
        self.assertTrue(changed)
        self.assertEqual(back["unsupported"], ["alpha", "Essence Burn", "Molten Tide", "Zeta"])
        self.assertNotIn("removed_by_overrides", back)
        self.assertEqual(co.adjust_unsupported(base, []), (base, False), "nothing to take off: the input as is")

    def test_build_writes_supported_and_adjusts_the_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / co.CARD_DATA).write_bytes(co.dump_card_data({"test spell": copy.deepcopy(ENTRY)}))
            listed = json.dumps({"generated": "x", "unsupported": ["Test Spell", "Other"]}).encode()
            (d / co.UNSUPPORTED).write_bytes(listed)
            side = co.build(d, [override(marks_supported=True)])
            self.assertEqual(side["supported"], ["Test Spell"])
            self.assertEqual(json.loads((d / co.UNSUPPORTED).read_bytes())["unsupported"], ["Other"])
            arch = d / co.ARCHIVE_DIR / f"{hashlib.sha256(listed).hexdigest()}.json"
            self.assertEqual(arch.read_bytes(), listed, "the list events ran on is archived by its hash")
            side = co.build(d, [override()])
            self.assertEqual(side["supported"], [], "without marks_supported nothing comes off")
            self.assertEqual(json.loads((d / co.UNSUPPORTED).read_bytes())["unsupported"], ["Other", "Test Spell"])
            stale = override(marks_supported=True)
            stale["applies_to"] = {**stale["applies_to"], "entry_sha256": "0" * 64}
            self.assertEqual(co.build(d, [stale])["supported"], [], "a skipped override supports nothing")


class Validate(unittest.TestCase):
    def test_required_fields(self):
        o = override()
        self.assertEqual(co.validate(o), [])
        bad = override(status="maybe", rules={"oracle": "x"}, tests=[{"name": "guard only", "expect": {"fixed": {}}}])
        problems = " ".join(co.validate(bad))
        for want in ("status", "rules.cr", "reproduce the bug"):
            self.assertIn(want, problems)

    def test_repo_overrides_are_valid(self):
        for o in co.load_overrides():
            self.assertEqual(co.validate(o), [], o["_slug"])
            for t in o["tests"]:
                plays = (t.get("cast") or {}).get("card") or isinstance(t.get("steps"), list)
                self.assertTrue(t["setup"] and plays and t["expect"]["fixed"], f"{o['_slug']}: {t['name']}")
            self.assertIsInstance(o.get("marks_supported", False), bool)

    def test_coverage_overrides_only_pin(self):
        guard = [{"name": "plays as printed", "setup": [], "cast": {"card": "Test Spell"}, "expect": {"fixed": {"life": [20, 18]}}}]
        pin = [{"op": "test", "path": "/name", "value": "Test Spell"}]
        self.assertEqual(co.validate(override(kind="coverage", marks_supported=True, patch=pin, tests=guard)), [])
        problems = " ".join(co.validate(override(kind="coverage", patch=pin + [{"op": "remove", "path": "/x"}])))
        for want in ("test ops", "marks_supported", "no case can show a bug"):
            self.assertIn(want, problems)

    def test_marks_supported_is_a_boolean(self):
        self.assertIn("marks_supported", " ".join(co.validate(override(marks_supported="yes"))))
        self.assertEqual(co.validate(override(marks_supported=True)), [])


class Triage(unittest.TestCase):
    def write_run(self, root: Path, name: str, reports: list[dict], seats=("seat-a", "seat-b")) -> None:
        d = root / name
        d.mkdir()
        lines = [{"type": "event_start", "id": name, "seats": [{"name": s, "kind": "agent"} for s in seats]}]
        lines += [{"type": "rules_issue", "card": r["card"], "seat": r["seat"], "game": r.get("game"), "turn": 3, "note": "x"} for r in reports]
        (d / "events.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n")

    def test_independence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_run(root, "ev1", [
                {"card": "Heated Argument", "seat": "seat-a", "game": "g1"}, {"card": "Heated Argument", "seat": "seat-a", "game": "g2"},
                {"card": "Other Card", "seat": "seat-a", "game": "g1"}, {"card": "Other Card", "seat": "seat-b", "game": "g1"},
                {"card": "Third Card", "seat": "seat-a", "game": "g1"}, {"card": "Third Card", "seat": "seat-b", "game": "g2"},
            ])
            self.write_run(root, "ev2", [{"card": "Fake", "seat": "rand-1", "game": "g1"}, {"card": "Fake", "seat": "rand-2", "game": "g2"}],
                           seats=("rand-1", "rand-2"))
            by = co.collect_reports([root])
            self.assertFalse(co.independent(by["heated argument"]), "one seat, twice")
            self.assertFalse(co.independent(by["other card"]), "two seats, one game")
            self.assertTrue(co.independent(by["third card"]), "two seats, two games")
            self.assertNotIn("fake", by, "scripted runs file fake reports")
            self.assertIn("fake", co.collect_reports([root], include_tests=True))


class Clean(unittest.TestCase):
    def test_terminal_safe(self):
        self.assertEqual(co.clean("a\x1b[31mb\x9b\u202e\u200bc\nd", 100), "a [31mb   c d")
        self.assertEqual(len(co.clean("x" * 50, 10)), 10)


class Upstream(unittest.TestCase):
    def test_draft_names_no_private_project(self):
        o = override(upstream_issue="https://github.com/phase-rs/phase/issues/1")
        text = co.draft_upstream(o, copy.deepcopy(ENTRY))
        self.assertIn("### Steps to reproduce", text)
        self.assertIn("```diff", text)
        self.assertIsNone(co.PRIVATE_WORDS.search(text))
        with self.assertRaises(co.OverrideError):
            co.draft_upstream(override(rules={"oracle": "x", "cr": ["1"], "actual": "seen in Agent Bench games"}), None)


if __name__ == "__main__":
    unittest.main(verbosity=1)
