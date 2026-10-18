/* Odyssey — standalone app logic. Navigation engine: Athena.
 * All scoring is done by the trained Athena model (entities/model.json).
 * Live Environment Agency data is fetched in the browser (CORS-enabled API).
 * No build step, no backend, no keys. Core is exported for Node testing.
 */
"use strict";

/* ----------------------------- constants ------------------------------ */
const BAND_RANK = { low: 0, medium: 1, high: 2 };
const WALK_M_PER_MIN = 80;

// Athena risk-penalty profiles: metres cost more on risky segments
const PROFILES = {
  shortest: { low: 0, medium: 0, high: 0, unknown: 0 },
  safest:   { low: 0, medium: 6, high: 60, unknown: 5 },
  balanced: { low: 0, medium: 3, high: 30, unknown: 3 },
};
// docks/parking access ways: allowed in the graph (they close gated-area
// gaps) but every profile discourages them.
const SERVICE_MULT = 3.0;
// how strongly the continuous model probability adds to segment cost
const RISK_W = { safest: 30, balanced: 15, shortest: 0 };

const PRESETS = [
  ["University of Southampton (Highfield)", 50.9362, -1.3957],
  ["Portswood shops", 50.9285, -1.3995],
  ["City centre (Above Bar)", 50.9045, -1.4025],
  ["Southampton Central station", 50.9085, -1.4115],
  ["Town Quay / ferries", 50.8998, -1.4005],
  ["Ocean Village", 50.9040, -1.3930],
  ["St Denys", 50.9215, -1.3905],
  ["Bitterne Park (Cobden Bridge)", 50.9245, -1.3780],
  ["Bevois Valley Road", 50.9200, -1.4045],
  ["Shirley High Street", 50.9105, -1.4325],
];

const EA_BASE = "https://environment.data.gov.uk/flood-monitoring";
const EA_TIDE_GAUGE = "E12660";   // Woolston tide gauge (live, OGL v3)

/* ------------------------------ utils --------------------------------- */
function distM(a, b) {
  const r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const key = (c) => c[0].toFixed(5) + "," + c[1].toFixed(5);
const esc = (s) => String(s).replace(/[&<>"]/g,
  (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]));

/* ------------------------- graph + routing ---------------------------- */
/* ------------------------- user preferences ----------------------------
 * Separated from the crime model on purpose (see model.json design_choice):
 * the model predicts reported street crime; these multipliers let the user
 * weigh comfort attributes (lighting, stairs, terrain, shelter) when
 * choosing between routes. Mirrored 1:1 in odyssey-city-data/preferences.py
 * ---------------------------------------------------------------------- */
const DEFAULT_PREFS = {
  well_lit: true,          // penalise segments known to be unlit
  avoid_stairs: false,     // penalise mapped steps
  avoid_steep: false,      // penalise mapped steep inclines
  sheltered: false,        // prefer covered/sheltered segments
  terrain: "mixed",        // "paved" | "mixed" | "any"
  avoid_waterside: false,  // set live by the app near high tide or during a local flood warning
  green: "reduce",         // footpaths through parks and woods: "avoid" | "reduce" | "any"
};
function loadPrefs() {
  try {
    const raw = localStorage.getItem("odyssey_prefs");
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_PREFS }; }
}
function edgeMultiplier(seg, prefs) {
  let m = 1;
  if (prefs.well_lit && seg.lighting === "no") m *= 3.0;
  if (prefs.avoid_stairs && seg.highway_type === "steps") m *= 4.0;
  if (prefs.avoid_steep && seg.steep === true) m *= 3.0;
  if (prefs.sheltered && seg.covered === true) m *= 0.55;
  if (prefs.terrain === "paved" && seg.surface === "unpaved") m *= 2.5;
  if (prefs.terrain === "mixed" && seg.surface === "unpaved") m *= 1.3;
  if (prefs.avoid_waterside && seg.tide_exposed === true) m *= 4.0;
  // in_green: a footpath through a park or wood (marked by the app from the OSM basemap)
  if (prefs.green === "avoid" && seg.in_green === true) m *= 6.0;
  if (prefs.green === "reduce" && seg.in_green === true) m *= 2.0;
  return m;                       // unknown values are never penalised
}
function explanationFactors(segments, prefs) {
  const has = f => segments.some(f);
  const out = [];
  if (prefs.well_lit)
    out.push(has(s => s.lighting === "no") ? "unlit stretch unavoidable" : "avoided unlit");
  if (prefs.avoid_stairs)
    out.push(has(s => s.highway_type === "steps") ? "stairs unavoidable" : "no stairs");
  if (prefs.avoid_steep)
    out.push(has(s => s.steep === true) ? "steep unavoidable" : "no steep gradients");
  if (prefs.sheltered)
    out.push(has(s => s.covered === true) ? "sheltered stretch" : "no sheltered cover mapped");
  if (prefs.terrain === "paved")
    out.push(has(s => s.surface === "unpaved") ? "unpaved unavoidable" : "paved terrain");
  if (prefs.green === "avoid" || prefs.green === "reduce")
    out.push(has(s => s.in_green === true) ? "park or wood unavoidable" : "no parks or woods");
  return out;
}

function buildGraph(segments) {
  const nodes = new Map();
  function node(c) {
    const k = key(c);
    if (!nodes.has(k)) nodes.set(k, { c, adj: [] });
    return k;
  }
  const byId = new Map(segments.map(s => [s.id, s]));
  for (const s of segments) {
    const cs = s.coordinates;
    for (let i = 0; i < cs.length - 1; i++) {
      const a = node(cs[i]), b = node(cs[i + 1]);
      const len = distM(cs[i], cs[i + 1]) || 1;
      nodes.get(a).adj.push({ to: b, len, seg: s.id });
      nodes.get(b).adj.push({ to: a, len, seg: s.id });
    }
  }
  return { nodes, byId };
}

function snap(graph, latlng) {
  let best = null, bestD = Infinity;
  for (const n of graph.nodes.values()) {
    const d = distM(n.c, latlng);
    if (d < bestD) { bestD = d; best = n; }
  }
  return { key: key(best.c), coord: best.c, dist: bestD };
}

class MinHeap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0;
      for (;;) { const l = 2*i+1, r = l+1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top; }
  get size() { return this.a.length; }
}

/* Dijkstra over a per-segment penalty profile. Returns:
 * { segments: unique segs in order, chainLen: metres actually walked,
 *   steps: [{from,to,seg,len}] node hops } or null. */
const MAX_EXTRA_MIN = 12;   // a safer route is only offered if the detour
                            // stays within this many extra walking minutes

function findRoute(graph, startKey, destKey, profile, prefs) {
  const isNamed = typeof profile === "string";
  const pen = isNamed ? PROFILES[profile] : profile;
  const rw = profile.rw ?? (isNamed ? RISK_W[profile] : RISK_W.safest);
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();
  const heap = new MinHeap(); heap.push([0, startKey]);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === destKey) break;
    for (const e of graph.nodes.get(u).adj) {
      if (done.has(e.to)) continue;
      const seg = graph.byId.get(e.seg);
      const cost = e.len * (1 + pen[seg.risk_band]
        + rw * (seg.risk_score ?? 0)) *
        (seg.highway_type === "service" ? SERVICE_MULT : 1) *
        edgeMultiplier(seg, prefs || DEFAULT_PREFS);
      const nd = d + cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { node: u, seg: e.seg, len: e.len });
        heap.push([nd, e.to]);
      }
    }
  }
  if (!done.has(destKey)) return null;
  const back = [];
  let cur = destKey;
  while (cur !== startKey) {
    const p = prev.get(cur);
    if (!p) return null;
    back.push({ from: p.node, to: cur, seg: p.seg, len: p.len });
    cur = p.node;
  }
  back.reverse();
  const segments = [];
  let chainLen = 0, lastSeg = null;
  for (const st of back) {
    chainLen += st.len;
    if (st.seg !== lastSeg) { segments.push(graph.byId.get(st.seg)); lastSeg = st.seg; }
  }
  return { segments, chainLen, steps: back };
}

function routeStats(route) {
  const len = route.chainLen;
  let worst = "low", unknownCount = 0;
  for (const s of route.segments) {
    if (s.risk_band === "unknown") { unknownCount++; continue; }
    if (BAND_RANK[s.risk_band] > BAND_RANK[worst]) worst = s.risk_band;
  }
  return { len, minutes: len / WALK_M_PER_MIN, band: worst, unknownCount };
}

/* Full route triad with the detour bound applied. Returns
 * { shortest, safest, safestNote, balanced } (any may be null). */
function planTriad(graph, startKey, destKey, prefs) {
  const P = prefs || DEFAULT_PREFS;
  const shortest = findRoute(graph, startKey, destKey, "shortest", P);
  const shortMin = shortest ? routeStats(shortest).minutes : 0;
  let safest = null, safestNote = "";
  for (const f of [1, 0.5, 0.25]) {
    const pen = {};
    for (const [band, p] of Object.entries(PROFILES.safest)) pen[band] = p * f;
    const r = findRoute(graph, startKey, destKey, { ...pen, rw: RISK_W.safest * f }, P);
    if (!r) continue;
    safest = safest || r;
    if (routeStats(r).minutes - shortMin <= MAX_EXTRA_MIN) {
      safest = r;
      if (f < 1) safestNote =
        `Best risk reduction Athena can offer within a ${MAX_EXTRA_MIN}-minute detour.`;
      break;
    }
  }
  const balanced = findRoute(graph, startKey, destKey, "balanced", P);
  return { shortest, safest, safestNote, balanced, prefs: P };
}

function etaTime(minutes) {
  return new Date(Date.now() + minutes * 60000)
    .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/* ----------------------- plain-English explanation ---------------------
 * Template-based, deterministic: the same route always reads the same.
 * All crime numbers are real Police UK data (see entities/incidents.json).
 * --------------------------------------------------------------------- */
function explain(route, altRoutes, crimes, havens, label) {
  const st = routeStats(route);
  const segIds = new Set(route.segments.map(s => s.id));
  const parts = [];

  const shortest = altRoutes.find(r => r.label === "Shortest");
  if (shortest && label !== "Shortest") {
    const dMin = Math.round(st.minutes - routeStats(shortest.route).minutes);
    const lead = label === "Safest" ? "Takes the lit streets" : "Balances distance and safety";
    parts.push(dMin < 3
      ? `${lead}, for much the same walking time as the shortest option.`
      : `${lead}; about ${dMin} min longer than the shortest option.`);
  } else {
    parts.push("The most direct route Athena found.");
  }

  // what this route avoids vs the shortest route
  if (shortest && label !== "Shortest") {
    const shortIds = new Set(shortest.route.segments.map(s => s.id));
    const avoided = shortest.route.segments.filter(s => !segIds.has(s.id) &&
      (s.risk_band === "high" || s.risk_band === "unknown"));
    if (avoided.length) {
      const s = avoided[0];
      const what = s.lighting === "no" ? "unlit" :
        (s.lighting === "unknown" ? "no-lighting-data" : "higher-risk");
      const nm = s.name === "unnamed path" ? "path" : s.name +
        ((s.highway_type === "footway" || s.highway_type === "path") ? " path" : "");
      parts.push(`Avoids the ${what} ${nm}.`);
    }
  }

  // real crime history on this route (Police UK)
  const withCrime = route.segments.filter(s => s.crime_count_90d > 0)
    .sort((a, b) => b.crime_count_90d - a.crime_count_90d);
  if (withCrime.length) {
    const s = withCrime[0];
    const nm = s.name === "unnamed path" ? "this route" : s.name;
    parts.push(`${s.crime_count_90d} street crimes were reported on or near ` +
      `${nm} in the last 3 months (Police UK, to ${s.last_crime_month}).`);
  }

  // unknowns — the honesty case
  if (st.unknownCount > 0) {
    parts.push(`${st.unknownCount} segment${st.unknownCount > 1 ? "s" : ""} on this ` +
      `route have no lighting or crime data, so risk is unknown there.`);
  }

  // safe havens
  const near = havens.filter(h => route.segments.some(s =>
    s.coordinates.some(c => distM(c, [h.lat, h.lng]) < 150)));
  const haven = near.find(h => /24\/7/.test(h.hours)) || near[0];
  if (haven) parts.push(`Passes ${haven.name}${/24\/7/.test(haven.hours) ? " (staffed 24/7)" : ""}.`);

  // tidal paths
  const tidal = route.segments.find(s => s.tide_exposed);
  if (tidal) parts.push("Uses a tidal waterside path that can flood at high tide.");

  // honesty: if the safest option doesn't actually reduce exposure, say so
  if (label === "Safest" && shortest) {
    const exposure = (rr) => rr.segments.reduce((t, s) => t + (s.crime_count_90d || 0), 0);
    if (exposure(route) >= exposure(shortest.route))
      parts.push("In this area reported crime is similar on all reasonable options — Athena cannot reduce it further here.");
  }

  return parts.slice(0, 3).join(" ");
}

/* Google Maps handoff: origin and destination only, travelmode=walking.
   Google draws one continuous route with no intermediate stops; Athena's
   chosen path stays visible in-app. */
function routeToGmapsUrl(graph, route) {
  const first = graph.nodes.get(route.steps[0].from).c;
  const last = graph.nodes.get(route.steps[route.steps.length - 1].to).c;
  const ll = c => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
  const q = new URLSearchParams({
    api: 1, origin: ll(first), destination: ll(last),
    travelmode: "walking",
  });
  console.debug(`[athena] gmaps: single continuous route, ` +
    `${route.steps.length} hops kept in-app, no intermediate stops`);
  return "https://www.google.com/maps/dir/?" + q.toString();
}

if (typeof module !== "undefined")
  module.exports = {
    buildGraph, snap, planTriad, findRoute, routeStats, explain,
    routeToGmapsUrl, distM, PRESETS, PROFILES, MAX_EXTRA_MIN,
    edgeMultiplier, explanationFactors, DEFAULT_PREFS, loadPrefs, etaTime,
  };

/* The browser interface lives in ui.js (loaded after this file by index.html).
   This file stays a pure routing/scoring core so test_core.js can require it. */
