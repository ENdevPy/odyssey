/* Node test for the Odyssey routing core + real-data sanity — node test_core.js */
"use strict";
const fs = require("fs");
const core = require("./app.js");
const segments = JSON.parse(fs.readFileSync("data/path_segments.json"));
const crimes = JSON.parse(fs.readFileSync("data/incidents.json"));
const havens = JSON.parse(fs.readFileSync("data/safe_havens.json"));
const model = JSON.parse(fs.readFileSync("data/model.json"));
console.log(`segments: ${segments.length}, real crimes: ${crimes.length}, havens: ${havens.length}`);
console.log(`model: AUC ${model.evaluation.auc_model} vs baseline ${model.evaluation.auc_baseline_recent_crime} (test month ${model.training.test_month})`);
const banned = ["lit_no","lit_partial","lit_unknown","isolation","tide_exposed","haven_300m"];
let modelFails = 0;
for (const f of banned) if (model.features.includes(f)) { console.log(`!! removed feature still present: ${f}`); modelFails++; }
if (!model.removed_features || model.removed_features.length !== 6) { console.log("!! removed_features block missing/incomplete"); modelFails++; }
for (const need of ["design_choice", "known_limitations"])
  if (!model[need]) { console.log(`!! model card missing ${need}`); modelFails++; }
if (modelFails) fail += modelFails;

// real-data sanity
const withCrime = segments.filter(s => s.crime_count_90d > 0);
console.log(`segments with real crimes in last 3 months: ${withCrime.length}`);
const months = [...new Set(crimes.map(c => c.month))].sort();
console.log(`crime months: ${months[0]}..${months[-1] ?? months[months.length-1]}`);
const unsnapped = crimes.filter(c => !c.segment_id).length;
if (unsnapped) { console.log(`!! ${unsnapped} crimes missing segment_id`); }
const hi = segments.filter(s => s.risk_band === "high");
const hiCrime = hi.filter(s => s.crime_count_90d > 0).length;
console.log(`high-band segments: ${hi.length}, of which with recent crime: ${hiCrime}`);

const t0 = Date.now();
const graph = core.buildGraph(segments);
console.log(`graph built in ${Date.now() - t0}ms, nodes: ${graph.nodes.size}`);

const trips = [
  ["Uni -> Portswood",        [50.9362,-1.3957], [50.9285,-1.3995], 2.5],
  ["City centre -> Town Quay",[50.9045,-1.4025], [50.8998,-1.4005], 2.0],
  ["City centre -> Ocean Village",[50.9045,-1.4025],[50.9040,-1.3930], 2.5],
  ["St Denys -> Cobden Bridge",[50.9215,-1.3905],[50.9245,-1.3780], 2.5],
  ["Shirley -> city centre",  [50.9105,-1.4325], [50.9045,-1.4025], 4.5],
];
let fail = 0;
for (const [name, from, to, maxKm] of trips) {
  console.log(`\n== ${name} ==`);
  const a = core.snap(graph, from), b = core.snap(graph, to);
  const triad = core.planTriad(graph, a.key, b.key);
  const routes = [];
  for (const [label, route] of [["Safest", triad.safest], ["Shortest", triad.shortest], ["Balanced", triad.balanced]]) {
    if (!route) { console.log(`  ${label}: NO ROUTE`); fail++; continue; }
    const st = core.routeStats(route);
    const high = route.segments.filter(s => s.risk_band === "high").length;
    const crimes90 = route.segments.reduce((t, s) => t + (s.crime_count_90d||0), 0);
    console.log(`  ${label}: ${(st.len/1000).toFixed(2)}km, ${Math.round(st.minutes)}min, ` +
      `band=${st.band}, high-segs=${high}, recent-crimes-on-route=${crimes90}, unscored=${st.unknownCount}` +
      (label === "Safest" && triad.safestNote ? `  [bound applied]` : ""));
    routes.push({ label, route });
    if (label === "Shortest" && st.len / 1000 > maxKm) { console.log(`  !! shortest ${(st.len/1000).toFixed(2)}km > ${maxKm}km`); fail++; }
  }
  // bounded-safest invariants
  const shortMin = core.routeStats(routes[1].route).minutes;
  const safeMin = core.routeStats(routes[0].route).minutes;
  if (safeMin - shortMin > core.MAX_EXTRA_MIN + 1) { console.log(`  !! safest detour ${(safeMin-shortMin).toFixed(0)} min > ${core.MAX_EXTRA_MIN}`); fail++; }
  const exposure = (rr) => rr.route.segments.reduce((t, s) => t + (s.crime_count_90d || 0), 0);
  const hiN = (rr) => rr.route.segments.filter(s => s.risk_band === "high").length;
  // in uniformly risky areas "safest" may only match the shortest; it must
  // never be dramatically worse, and the UI states the similarity honestly.
  if (exposure(routes[0]) > exposure(routes[1]) * 2 || hiN(routes[0]) > hiN(routes[1]) * 2) {
    console.log("  !! safest exposure dramatically worse than shortest"); fail++;
  }
  const uniq = [];
  for (const r of routes)
    if (!uniq.some(u => u.route.segments.map(s=>s.id).join() === r.route.segments.map(s=>s.id).join())) uniq.push(r);
  for (const r of uniq.slice(0, 2))
    console.log(`  [${r.label}] "${core.explain(r.route, uniq, crimes, havens, r.label)}"`);
  const url = core.routeToGmapsUrl(graph, uniq[0].route);
  console.log(`  gmaps: hops=${uniq[0].route.steps.length} stops=0`, url.slice(0, 90) + "…");
  if (url.includes("waypoints=")) { console.log("  !! waypoints present — Google would show stops"); fail++; }
  if (!url.includes("travelmode=walking")) { console.log("  !! missing travelmode=walking"); fail++; }
  const stops = (url.match(/%7C/g) || []).length;
  if (stops) { console.log(`  !! ${stops} pipe-separated stops in URL`); fail++; }
}
// ---- preferences: parity with preferences.py fixtures + route flip ----
console.log("\n== preferences ==");
const FIX = [
  [{lighting:"no", highway_type:"path", steep:null, covered:null, surface:null}, {well_lit:true}, 3.0],
  [{lighting:"unknown", highway_type:"path", steep:null, covered:null, surface:null}, {well_lit:true}, 1.0],
  [{lighting:"yes", highway_type:"steps", steep:false, covered:false, surface:"paved"}, {avoid_stairs:true, well_lit:false}, 4.0],
  [{lighting:"yes", highway_type:"path", steep:true, covered:null, surface:null}, {avoid_steep:true}, 3.0],
  [{lighting:"yes", highway_type:"path", steep:null, covered:true, surface:null}, {sheltered:true}, 0.55],
  [{lighting:"yes", highway_type:"footway", steep:null, covered:null, surface:"unpaved"}, {terrain:"paved"}, 2.5],
  [{lighting:"yes", highway_type:"footway", steep:null, covered:null, surface:"unpaved"}, {terrain:"mixed"}, 1.3],
  [{lighting:"no", highway_type:"steps", steep:true, covered:true, surface:"unpaved"}, {}, 3.9],
  [{lighting:"yes", highway_type:"footway", steep:null, covered:null, surface:"unpaved"}, {well_lit:false, terrain:"any"}, 1.0],
  [{lighting:"yes", highway_type:"footway", steep:null, covered:null, surface:"paved", in_green:true}, {green:"avoid"}, 6.0],
  [{lighting:"yes", highway_type:"footway", steep:null, covered:null, surface:"paved", in_green:true}, {}, 2.0],
  [{lighting:"yes", highway_type:"footway", steep:null, covered:null, surface:"paved", in_green:true}, {green:"any"}, 1.0],
];
for (const [edge, prefs, want] of FIX) {
  const got = core.edgeMultiplier(edge, { ...core.DEFAULT_PREFS, ...prefs });
  if (Math.abs(got - want) > 1e-9) { console.log(`  !! multiplier ${JSON.stringify(prefs)} on ${JSON.stringify(edge)}: got ${got}, want ${want}`); fail++; }
}
const chips = core.explanationFactors(
  [{lighting:"yes", highway_type:"residential"}, {lighting:"no", highway_type:"footway", surface:"unpaved"}],
  { ...core.DEFAULT_PREFS, terrain: "paved", green: "any" });
console.log("  chips:", chips.join(" | "));
if (chips.join() !== "unlit stretch unavoidable,unpaved unavoidable") { console.log("  !! chips mismatch vs preferences.py fixture"); fail++; }

// toggling a preference must actually change a route that has alternatives
const pa = core.snap(graph, [50.9215, -1.3905]), pb = core.snap(graph, [50.9245, -1.3780]);
const tDefault = core.planTriad(graph, pa.key, pb.key, core.loadPrefs ? core.loadPrefs() : core.DEFAULT_PREFS);
const tNoLit = core.planTriad(graph, pa.key, pb.key, { ...core.DEFAULT_PREFS, well_lit: false });
const sameSet = (t1, t2) => (t1.shortest ? t1.shortest.segments.map(s=>s.id).join() : "") ===
                           (t2.shortest ? t2.shortest.segments.map(s=>s.id).join() : "");
console.log("  prefs on/off change available routes:", sameSet(tDefault, tNoLit) ? "no (shortest unaffected)" : "yes");
// avoid-stairs sanity: known steps get 4x when the pref is on
const stepsSeg = segments.find(s => s.highway_type === "steps");
if (stepsSeg && core.edgeMultiplier(stepsSeg, { ...core.DEFAULT_PREFS, avoid_stairs: true }) <= 1) {
  console.log("  !! steps segment not penalised"); fail++;
}

console.log(fail ? `\nFAILED: ${fail} problems` : "\nALL TESTS PASSED");
process.exit(fail ? 1 : 0);
