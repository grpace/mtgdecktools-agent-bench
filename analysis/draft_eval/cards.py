"""Card metadata (colors, pips, mana value, types, rarity) for a set.

Sources, in order:
  1. phase-rs card data (data/card-data.slim.json): mana cost, type line, oracle text.
  2. phase-rs booster sheets (data/draft-pools.json): rarity, cmc, colors, type line.
Names are matched exactly, then by front face ("A // B" -> "A").
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache

from . import config

COLORS = "WUBRG"
PAIRS = [a + b for i, a in enumerate(COLORS) for b in COLORS[i + 1:]]  # WU WB WR WG UB UR UG BR BG RG
BASICS = {"Plains": "W", "Island": "U", "Swamp": "B", "Mountain": "R", "Forest": "G", "Wastes": ""}
RARITY_ORDER = {"common": 0, "uncommon": 1, "rare": 2, "mythic": 3, "special": 2, "bonus": 2}


def canon(name: str) -> str:
    return name.split(" // ")[0].strip()


def wubrg(s: str) -> str:
    return "".join(c for c in COLORS if c in s)


@dataclass
class Card:
    name: str
    pips: dict = field(default_factory=dict)   # hard colored pips: color -> count
    hybrid: list = field(default_factory=list)  # list of color-sets, each satisfied by any color in it
    soft: set = field(default_factory=set)      # phyrexian / 2-hybrid colors (castable without the color)
    mv: float = 0.0
    creature: bool = False
    land: bool = False
    basic: bool = False
    legendary: bool = False
    produces: str = ""
    rarity: str = "common"
    known: bool = False

    @property
    def colors(self) -> str:
        cs = set(self.pips)
        for h in self.hybrid:
            cs |= set(h)
        cs |= self.soft
        return wubrg("".join(cs))

    @property
    def gold(self) -> bool:
        return len(self.pips) >= 2

    def castability(self, pair: str) -> float:
        """1 = castable in a deck of these colors, ~0.35 = splashable (one off-color pip), 0 = not."""
        if self.basic:
            return 1.0
        if self.land:
            if not self.produces:
                return 1.0
            return 1.0 if set(self.produces) & set(pair) else 0.25
        off = {c: n for c, n in self.pips.items() if c not in pair}
        hyb_ok = all(set(h) & set(pair) for h in self.hybrid)
        if not off and hyb_ok:
            return 1.0
        if hyb_ok and len(off) == 1 and sum(off.values()) == 1:
            return 0.35
        return 0.0


_TOKEN = re.compile(r"\{([^}]+)\}")


def parse_cost(cost: str, card: Card) -> None:
    mv = 0.0
    for tok in _TOKEN.findall(cost or ""):
        t = tok.upper()
        if t.isdigit():
            mv += int(t)
        elif t in COLORS:
            card.pips[t] = card.pips.get(t, 0) + 1
            mv += 1
        elif "/" in t:
            parts = t.split("/")
            cols = [p for p in parts if p in COLORS]
            if "P" in parts or any(p.isdigit() for p in parts):
                card.soft |= set(cols)
                mv += max([int(p) for p in parts if p.isdigit()] + [1])
            elif cols:
                card.hybrid.append("".join(cols))
                mv += 1
        elif t in ("X", "Y", "Z"):
            pass
        else:  # C, S, etc.
            mv += 1
    card.mv = mv


@lru_cache(maxsize=1)
def _slim() -> dict:
    p = config.data_dir() / "card-data.slim.json"
    out = {}
    if p.exists():
        for c in json.load(open(p)):
            out.setdefault(c["name"], c)
            out.setdefault(canon(c["name"]), c)
    return out


@lru_cache(maxsize=16)
def _pool_cards(set_code: str) -> dict:
    p = config.data_dir() / "draft-pools.json"
    out: dict = {}
    if not p.exists():
        return out
    d = json.load(open(p)).get(set_code.lower(), {})
    for sheet in d.get("sheets", {}).values():
        for c in sheet.get("cards", []):
            prev = out.get(c["name"])
            if prev is None or RARITY_ORDER.get(c.get("rarity"), 0) < RARITY_ORDER.get(prev.get("rarity"), 0):
                out[c["name"]] = c
                out.setdefault(canon(c["name"]), c)
    for pr in d.get("prints", []):
        out.setdefault(pr["name"], {"name": pr["name"], "rarity": pr.get("rarity", "common")})
    return out


_ADD = re.compile(r"[Aa]dd ([^.]*)")


def card_meta(name: str, set_code: str, rarity_hint: str | None = None) -> Card:
    c = Card(name=name)
    slim = _slim()
    pc = _pool_cards(set_code)
    s = slim.get(name) or slim.get(canon(name))
    p = pc.get(name) or pc.get(canon(name))
    if canon(name) in BASICS:
        c.land = c.basic = True
        c.produces = BASICS[canon(name)]
        c.known = True
        return c
    if s:
        c.known = True
        parse_cost(s.get("cost", ""), c)
        tl = s.get("typeLine", "")
        c.creature = "Creature" in tl.split("//")[0]
        c.land = "Land" in tl.split("//")[0]
        c.legendary = "Legendary" in tl
        if c.land:
            prod = "".join(_ADD.findall(s.get("oracle", "")))
            c.produces = wubrg("".join(t for t in _TOKEN.findall(prod) if t in COLORS))
            if "any color" in s.get("oracle", "") or "any one color" in s.get("oracle", ""):
                c.produces = COLORS
    if p:
        c.rarity = p.get("rarity", c.rarity)
        if not s:
            c.known = True
            tl = p.get("type_line", "")
            c.creature = "Creature" in tl
            c.land = "Land" in tl
            c.legendary = "Legendary" in tl
            c.mv = float(p.get("cmc", 0) or 0)
            for col in p.get("colors", []):
                c.pips[col] = 1
        elif p.get("cmc") is not None and not c.land:
            c.mv = float(p["cmc"])
    if rarity_hint:
        c.rarity = rarity_hint
    return c
