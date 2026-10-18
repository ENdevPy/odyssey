#!/usr/bin/env python3
"""Odyssey route preferences — reference implementation.

This module mirrors the routing-side preference logic in
../odyssey-app/app.js (edgeMultiplier / explanationFactors) 1:1, so the
Python and JavaScript paths can be tested against identical fixtures
(see test at the bottom and test_core.js in the app).

Design: preferences NEVER touch the Athena crime model (model.json
"design_choice"). The model predicts reported street crime; these
multipliers only reweight edge costs inside the router so the user can
trade comfort (lighting, stairs, terrain, shelter) against risk and
distance. Segments whose attribute is unknown in OSM are never
penalised — the coverage percentages shown in the app's preferences
dialog are computed by build_odyssey_data.py and written to
data_manifest.json.
"""
from dataclasses import dataclass, asdict


@dataclass
class UserPrefs:
    well_lit: bool = True          # penalise segments known to be unlit
    avoid_stairs: bool = False     # penalise mapped steps
    avoid_steep: bool = False      # penalise mapped steep inclines
    sheltered: bool = False        # prefer covered/sheltered segments
    terrain: str = "mixed"         # "paved" | "mixed" | "any"
    avoid_waterside: bool = False  # set live near high tide / local flood warning
    green: str = "reduce"          # parks and woods: "avoid" | "reduce" | "any"

    @staticmethod
    def load(raw=None):
        """Build prefs from a JSON dict (localStorage payload); defaults fill gaps."""
        p = UserPrefs()
        if raw:
            for k, v in raw.items():
                if hasattr(p, k):
                    setattr(p, k, v)
        return p

    def asdict(self):
        return asdict(self)


# Multipliers must match app.js edgeMultiplier exactly.
PREFS_MULTS = {
    "lit_no": 3.0,          # well_lit && lighting == "no"
    "stairs": 4.0,          # avoid_stairs && highway_type == "steps"
    "steep": 3.0,           # avoid_steep && steep is True
    "shelter_bonus": 0.55,  # sheltered && covered is True (bonus)
    "paved_unpaved": 2.5,   # terrain == "paved" && surface == "unpaved"
    "mixed_unpaved": 1.3,   # terrain == "mixed" && surface == "unpaved"
    "waterside": 4.0,       # avoid_waterside && tide_exposed is True
    "green_avoid": 6.0,     # green == "avoid" && in_green is True
    "green_reduce": 2.0,    # green == "reduce" && in_green is True
}


def edge_multiplier(edge_data: dict, prefs: UserPrefs) -> float:
    """Combined preference multiplier for one edge. Unknown attributes never
    penalise (multiplier 1.0)."""
    m = 1.0
    if prefs.well_lit and edge_data.get("lighting") == "no":
        m *= PREFS_MULTS["lit_no"]
    if prefs.avoid_stairs and edge_data.get("highway_type") == "steps":
        m *= PREFS_MULTS["stairs"]
    if prefs.avoid_steep and edge_data.get("steep") is True:
        m *= PREFS_MULTS["steep"]
    if prefs.sheltered and edge_data.get("covered") is True:
        m *= PREFS_MULTS["shelter_bonus"]
    if prefs.terrain == "paved" and edge_data.get("surface") == "unpaved":
        m *= PREFS_MULTS["paved_unpaved"]
    elif prefs.terrain == "mixed" and edge_data.get("surface") == "unpaved":
        m *= PREFS_MULTS["mixed_unpaved"]
    if prefs.avoid_waterside and edge_data.get("tide_exposed") is True:
        m *= PREFS_MULTS["waterside"]
    if prefs.green == "avoid" and edge_data.get("in_green") is True:
        m *= PREFS_MULTS["green_avoid"]
    if prefs.green == "reduce" and edge_data.get("in_green") is True:
        m *= PREFS_MULTS["green_reduce"]
    return m


def explanation_factors(route_segments: list, prefs: UserPrefs) -> list:
    """Human-readable chips for a computed route: which preferences actually
    shaped it (and where they could not be satisfied)."""
    has = lambda f: any(f(s) for s in route_segments)  # noqa: E731
    out = []
    if prefs.well_lit:
        out.append("unlit stretch unavoidable" if has(lambda s: s.get("lighting") == "no")
                   else "avoided unlit")
    if prefs.avoid_stairs:
        out.append("stairs unavoidable" if has(lambda s: s.get("highway_type") == "steps")
                   else "no stairs")
    if prefs.avoid_steep:
        out.append("steep unavoidable" if has(lambda s: s.get("steep") is True)
                   else "no steep gradients")
    if prefs.sheltered:
        out.append("sheltered stretch" if has(lambda s: s.get("covered") is True)
                   else "no sheltered cover mapped")
    if prefs.terrain == "paved":
        out.append("unpaved unavoidable" if has(lambda s: s.get("surface") == "unpaved")
                   else "paved terrain")
    if prefs.green in ("avoid", "reduce"):
        out.append("park or wood unavoidable" if has(lambda s: s.get("in_green") is True)
                   else "no parks or woods")
    return out


# ---------------------------------------------------------------- self-test
# Fixture vectors shared with test_core.js — keep both in sync.
FIXTURES = [
    ({"lighting": "no", "highway_type": "path", "steep": None, "covered": None, "surface": None},
     {"well_lit": True}, 3.0),
    ({"lighting": "unknown", "highway_type": "path", "steep": None, "covered": None, "surface": None},
     {"well_lit": True}, 1.0),
    ({"lighting": "yes", "highway_type": "steps", "steep": False, "covered": False, "surface": "paved"},
     {"avoid_stairs": True, "well_lit": False}, 4.0),
    ({"lighting": "yes", "highway_type": "path", "steep": True, "covered": None, "surface": None},
     {"avoid_steep": True}, 3.0),
    ({"lighting": "yes", "highway_type": "path", "steep": None, "covered": True, "surface": None},
     {"sheltered": True}, 0.55),
    ({"lighting": "yes", "highway_type": "footway", "steep": None, "covered": None, "surface": "unpaved"},
     {"terrain": "paved"}, 2.5),
    ({"lighting": "yes", "highway_type": "footway", "steep": None, "covered": None, "surface": "unpaved"},
     {"terrain": "mixed"}, 1.3),
    ({"lighting": "no", "highway_type": "steps", "steep": True, "covered": True, "surface": "unpaved"},
     {}, 3.9),          # defaults: well_lit on (x3) + mixed terrain (x1.3)
    ({"lighting": "yes", "highway_type": "footway", "steep": None, "covered": None, "surface": "unpaved"},
     {"well_lit": False, "terrain": "any"}, 1.0),
    ({"lighting": "yes", "highway_type": "footway", "steep": None, "covered": None, "surface": "paved", "in_green": True},
     {"green": "avoid"}, 6.0),
    ({"lighting": "yes", "highway_type": "footway", "steep": None, "covered": None, "surface": "paved", "in_green": True},
     {}, 2.0),          # default: parks and woods "reduce"
    ({"lighting": "yes", "highway_type": "footway", "steep": None, "covered": None, "surface": "paved", "in_green": True},
     {"green": "any"}, 1.0),
]


def _selftest():
    for edge, raw, want in FIXTURES:
        got = edge_multiplier(edge, UserPrefs.load(raw))
        assert abs(got - want) < 1e-9, (edge, raw, got, want)
    segs = [{"lighting": "yes", "highway_type": "residential"},
            {"lighting": "no", "highway_type": "footway", "surface": "unpaved"}]
    p = UserPrefs.load({"well_lit": True, "terrain": "paved", "green": "any"})
    assert explanation_factors(segs, p) == ["unlit stretch unavoidable", "unpaved unavoidable"], \
        explanation_factors(segs, p)
    print(f"preferences.py self-test OK: {len(FIXTURES)} multiplier vectors + explanations")


if __name__ == "__main__":
    _selftest()
