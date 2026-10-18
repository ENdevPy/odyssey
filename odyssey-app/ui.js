/* Odyssey interface. Routing and scoring come from app.js (Athena core),
 * which this file never changes: it only presents results and collects input.
 * No build step, no backend, no keys. */
"use strict";

(async function () {
  const $ = (id) => document.getElementById(id);
  const isDesktop = () => window.matchMedia("(min-width: 900px)").matches;
  // Yield once to the browser (so a status message can show) before heavy work.
  // A message-channel hop is never throttled, unlike timers or animation frames.
  const nextPaint = () => new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
  const vibrate = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* unsupported */ } };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // Route labels shown to people. Change the right-hand side to rename a profile
  // everywhere in the interface; the routing core keeps its own names.
  // "Safest" stays as the internal key; users see "Lower risk" because no route is guaranteed safe
  const LABELS = { Safest: "Lower risk", Balanced: "Balanced", Shortest: "Shortest" };
  const BAND_TEXT = { low: "Low risk", medium: "Medium risk", high: "High risk", unknown: "Risk unknown" };
  const COLORS = { low: "#34D399", medium: "#FBBF24", high: "#F87171", unknown: "#8592A6" };
  const CRIME_NAMES = {
    "anti-social-behaviour": "Anti-social behaviour", "violent-crime": "Violence and sexual offences",
    "public-order": "Public order", "criminal-damage-arson": "Criminal damage", "shoplifting": "Shoplifting",
    "other-theft": "Other theft", "theft-from-the-person": "Theft from the person", "robbery": "Robbery",
    "bicycle-theft": "Bicycle theft", "burglary": "Burglary", "vehicle-crime": "Vehicle crime",
    "drugs": "Drugs", "possession-of-weapons": "Weapons possession", "other-crime": "Other crime",
  };

  /* ---------------------------------------------------------------- loading */
  const splashMsg = $("splash-msg"), splashBar = $("splash-bar");
  async function loadJSON(path, onProgress) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const total = +res.headers.get("content-length") || 0;
    if (!res.body || !total || !onProgress) return res.json();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got / total);
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return JSON.parse(new TextDecoder().decode(buf));
  }

  let segments, havens, model, liveSnapshot, manifest, basemap;
  try {
    [segments, havens, model, liveSnapshot, manifest, basemap] = await Promise.all([
      loadJSON("data/path_segments.json", (f) => { splashBar.style.width = `${Math.round(8 + f * 82)}%`; }),
      loadJSON("data/safe_havens.json"),
      loadJSON("data/model.json").catch(() => null),
      loadJSON("data/live_check.json").catch(() => null),
      loadJSON("data/data_manifest.json").catch(() => null),
      loadJSON("data/basemap.geojson").catch(() => null),
    ]);
  } catch (e) {
    splashMsg.textContent = "Couldn’t load the map data. Check your connection and reload.";
    return;
  }
  splashMsg.textContent = "Building the walking network";
  splashBar.style.width = "94%";
  await nextPaint();

  /* Police UK crime was only fetched for these 12 one-mile circles
   * (POLICE_POINTS in build_odyssey_data.py). Outside them a path has no
   * crime history, so its model score would look falsely "low". We mark those
   * paths as risk unknown instead, for the map, the cards and the router. */
  const CRIME_AREAS = [
    [50.9362, -1.3957], [50.9285, -1.3995], [50.9045, -1.4025], [50.9085, -1.4115],
    [50.8998, -1.4005], [50.9040, -1.3930], [50.9215, -1.3905], [50.9245, -1.3780],
    [50.9200, -1.4045], [50.9105, -1.4325], [50.9055, -1.4600], [50.9165, -1.4650],
  ];
  const CRIME_RADIUS_M = 1609;
  for (const s of segments) {
    const mid = s.coordinates[Math.floor(s.coordinates.length / 2)];
    s.crime_covered = CRIME_AREAS.some((p) => distM(mid, p) <= CRIME_RADIUS_M);
    if (!s.crime_covered && s.risk_band !== "unknown") { s.risk_band = "unknown"; s.risk_score = null; }
  }
  /* Parks and woods: mark footpaths whose middle sits inside a park, wood,
   * common or similar green area of at least half a hectare (OSM basemap).
   * Roads through parks (e.g. The Avenue across the Common) aren't marked. */
  const PATHY = new Set(["footway", "path", "cycleway", "steps", "bridleway", "track", "pedestrian"]);
  const greens = [];
  if (basemap && basemap.features) {
    for (const f of basemap.features) {
      if (f.properties.kind !== "green" || f.geometry.type !== "Polygon") continue;
      const ring = f.geometry.coordinates[0];
      if (ring.length < 4) continue;
      const kx = 111320 * Math.cos((ring[0][1] * Math.PI) / 180), ky = 110540;
      let a = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = ring[i], [xn, yn] = ring[(i + 1) % ring.length];
        a += x * kx * yn * ky - xn * kx * y * ky;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (Math.abs(a) / 2 >= 5000) greens.push({ ring, x0, x1, y0, y1 });
    }
  }
  const inRing = (lng, lat, ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (const s of segments) {
    if (!PATHY.has(s.highway_type)) continue;
    const [lat, lng] = s.coordinates[Math.floor(s.coordinates.length / 2)];
    s.in_green = greens.some((g) => lng >= g.x0 && lng <= g.x1 && lat >= g.y0 && lat <= g.y1 && inRing(lng, lat, g.ring));
  }
  const graph = buildGraph(segments);
  const walkable = segments.filter((s) => s.highway_type !== "service" && s.length_m >= 10);
  const counts = { low: 0, medium: 0, high: 0, unknown: 0 };
  walkable.forEach((s) => counts[s.risk_band]++);
  const unknownPct = Math.round((counts.unknown / walkable.length) * 100);
  const lenOf = (arr) => arr.reduce((t, x) => t + (x.length_m || 0), 0);
  const walkLen = lenOf(walkable);
  const noLightPct = Math.round((lenOf(walkable.filter((x) => x.lighting === "unknown")) / walkLen) * 100);
  const noCrimePct = Math.round((lenOf(walkable.filter((x) => !x.crime_covered)) / walkLen) * 100);
  const police = manifest && manifest.sources.find((s) => /police/i.test(s.name));
  const crimeCount = police && police.crimes ? police.crimes : null;
  const monthName = (m) => m ? new Date(m + "-01T12:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "";
  const crimePeriod = police && police.months ? `${monthName(police.months[0])} to ${monthName(police.months[police.months.length - 1])}` : "";

  /* ---------------------------------------------------------------- map */
  const map = L.map("map", { zoomControl: false, attributionControl: false, preferCanvas: true, tap: true })
    .setView([50.9180, -1.4000], 14);
  L.control.attribution({ prefix: false, position: "bottomright" })
    .addAttribution("© OpenStreetMap contributors · Police UK (OGL)").addTo(map);
  map.createPane("base").style.zIndex = 200;
  map.createPane("segments").style.zIndex = 350;
  map.createPane("routes").style.zIndex = 450;
  map.createPane("pins").style.zIndex = 620;
  const segRenderer = L.canvas({ pane: "segments", tolerance: 9 });
  const routeRenderer = L.canvas({ pane: "routes", tolerance: 12 });
  const baseRenderer = L.canvas({ pane: "base" });

  const BASE_STYLE = {
    water: { color: "#18355a", weight: 1, fill: true, fillColor: "#0d1d33", fillOpacity: 1 },
    green: { color: "#14261c", weight: 0, fill: true, fillColor: "#112018", fillOpacity: 1 },
    rail: { color: "#2a3445", weight: 1.6, dashArray: "8 6", fill: false },
  };
  if (basemap && basemap.features) {
    for (const f of basemap.features) {
      const st = { ...(BASE_STYLE[f.properties.kind] || {}), renderer: baseRenderer, interactive: false };
      const toLL = (c) => [c[1], c[0]];
      if (f.geometry.type === "Polygon") {
        const ring = f.geometry.coordinates[0].map(toLL);
        if (ring.length > 3) L.polygon(ring, st).addTo(map);
      } else if (f.geometry.type === "LineString") {
        L.polyline(f.geometry.coordinates.map(toLL), st).addTo(map);
      }
    }
  }

  for (const s of walkable) {
    const unk = s.risk_band === "unknown";
    L.polyline(s.coordinates, {
      renderer: segRenderer, color: COLORS[s.risk_band],
      weight: s.risk_band === "high" ? 3.2 : unk ? 1.6 : 2.2,
      opacity: unk ? 0.6 : 0.92, dashArray: unk ? "4 5" : null,
    }).on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      if (pick) return;
      openRoadPeek(s, e.latlng);
    }).addTo(map);
  }
  // midpoints for quick "what's around here" lookups
  const segMids = segments.map((x) => [x, x.coordinates[Math.floor(x.coordinates.length / 2)]]);
  for (const h of havens) {
    L.circleMarker([h.lat, h.lng], {
      pane: "pins", radius: 6, color: "#0E1726", weight: 2, fillColor: "#7DD3FC", fillOpacity: 1,
    }).on("click", (e) => { L.DomEvent.stopPropagation(e); openHaven(h); }).addTo(map);
  }

  /* ---------------------------------------------------------------- sheet */
  const sheet = $("sheet");
  let safeProbe = null;
  function safeAreaBottom() {
    if (!safeProbe) {
      safeProbe = document.createElement("div");
      safeProbe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)";
      document.body.appendChild(safeProbe);
    }
    return parseFloat(getComputedStyle(safeProbe).paddingBottom) || 0;
  }
  let sheetState = "peek";
  function sheetHeights() {
    const full = sheet.getBoundingClientRect().height || window.innerHeight * 0.9;
    const safeB = safeAreaBottom();
    return { peek: Math.min(full, 158 + safeB), half: Math.min(full, Math.round(window.innerHeight * 0.56)), full };
  }
  function setSheet(state, animate = true) {
    sheetState = state;
    const h = sheetHeights();
    const visible = isDesktop() ? 0 : h[state];
    if (!isDesktop()) {
      if (!animate) sheet.classList.add("dragging");
      sheet.style.setProperty("--sheet-y", `${h.full - visible}px`);
      if (!animate) requestAnimationFrame(() => sheet.classList.remove("dragging"));
    }
    document.documentElement.style.setProperty("--sheet-visible", `${Math.min(visible, h.half)}px`);
  }
  // drag to resize (grabber and the top of each view)
  (function enableDrag() {
    let startY = 0, startT = 0, dragging = false, lastY = 0, lastT = 0;
    const handles = [$("grabber"), $("view-plan").querySelector(".search-field"), document.querySelector(".results-head")];
    const onDown = (e) => {
      if (isDesktop()) return;
      dragging = true; startY = lastY = e.clientY; lastT = performance.now();
      const m = /translateY\(([-\d.]+)px\)/.exec(getComputedStyle(sheet).transform) ||
        [0, new DOMMatrix(getComputedStyle(sheet).transform).m42];
      startT = parseFloat(m[1]) || 0;
      sheet.classList.add("dragging");
    };
    const onMove = (e) => {
      if (!dragging) return;
      const h = sheetHeights();
      const y = Math.max(0, Math.min(h.full - h.peek + 40, startT + (e.clientY - startY)));
      sheet.style.setProperty("--sheet-y", `${y}px`);
      lastT = performance.now(); lastY = e.clientY;
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove("dragging");
      const moved = e.clientY - startY;
      if (Math.abs(moved) < 6) return; // a tap, not a drag
      e.preventDefault();
      const h = sheetHeights();
      const visible = h.full - (startT + moved);
      const options = ["peek", "half", "full"].map((k) => [k, Math.abs(h[k] - visible)]);
      let target = options.sort((a, b) => a[1] - b[1])[0][0];
      const velocity = (e.clientY - lastY) / Math.max(1, performance.now() - lastT);
      if (velocity > 0.6) target = visible > h.half ? "half" : "peek";
      if (velocity < -0.6) target = visible < h.half ? "half" : "full";
      setSheet(target);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 50);
    };
    let suppressClick = false;
    for (const el of handles) {
      if (!el) continue;
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("click", (e) => { if (suppressClick) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    $("grabber").addEventListener("click", () => setSheet(sheetState === "peek" ? "half" : sheetState === "half" ? "full" : "peek"));
  })();
  window.addEventListener("resize", () => setSheet(sheetState, false));

  function showView(name) {
    for (const v of ["plan", "search", "results"]) $(`view-${v}`).classList.toggle("hidden", v !== name);
  }

  /* ---------------------------------------------------------------- toast */
  let toastTimer = null;
  function toast(text, action, onAction) {
    $("toast-text").textContent = text;
    const btn = $("toast-action");
    btn.classList.toggle("hidden", !action);
    btn.textContent = action || "";
    btn.onclick = () => { $("toast").classList.add("hidden"); onAction && onAction(); };
    $("toast").classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.add("hidden"), action ? 6000 : 3500);
  }

  /* ---------------------------------------------------------------- modal */
  const modal = $("modal"), scrim = $("scrim");
  let modalOpen = false, lastFocus = null;
  function openModal(title, html, onMount) {
    lastFocus = document.activeElement;
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = html;
    $("modal-body").scrollTop = 0;
    modal.classList.remove("hidden"); scrim.classList.remove("hidden");
    requestAnimationFrame(() => { modal.classList.add("show"); scrim.classList.add("show"); });
    if (!modalOpen) history.pushState({ modal: true }, "");
    modalOpen = true;
    onMount && onMount($("modal-body"));
    setTimeout(() => $("modal-title").focus({ preventScroll: true }), 50);
  }
  function closeModal(fromHistory) {
    if (!modalOpen) return;
    modalOpen = false;
    modal.classList.remove("show"); scrim.classList.remove("show");
    setTimeout(() => { if (!modalOpen) { modal.classList.add("hidden"); scrim.classList.add("hidden"); } }, 280);
    if (!fromHistory && history.state && history.state.modal) history.back();
    lastFocus && lastFocus.focus && lastFocus.focus({ preventScroll: true });
  }
  $("modal-close").addEventListener("click", () => closeModal());
  scrim.addEventListener("click", () => closeModal());
  window.addEventListener("popstate", () => closeModal(true));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (modalOpen) closeModal();
      else if (pick) endPick();
      else if (!$("view-search").classList.contains("hidden")) closeSearch();
    }
  });

  /* ---------------------------------------------------------------- location */
  let meMarker = null;
  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("This browser can’t share your location."));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve([p.coords.latitude, p.coords.longitude]),
        (err) => reject(new Error(err.code === 1
          ? "Location is turned off for this site. Allow it in your browser settings, or choose a start point."
          : "Couldn’t find your location. Choose a start point instead.")),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
  }
  function showMe(ll) {
    const icon = L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    if (meMarker) meMarker.setLatLng(ll); else meMarker = L.marker(ll, { icon, pane: "pins", interactive: false }).addTo(map);
  }
  $("btn-locate").addEventListener("click", async () => {
    const btn = $("btn-locate");
    btn.style.opacity = ".6";
    try {
      const ll = await getPosition();
      showMe(ll);
      map.flyTo(ll, 16, { duration: 0.6 });
    } catch (e) { toast(e.message); }
    btn.style.opacity = "";
  });
  $("btn-legend").addEventListener("click", () => {
    const hidden = $("legend").classList.toggle("hidden");
    $("btn-legend").setAttribute("aria-expanded", String(!hidden));
  });

  /* ---------------------------------------------------------------- trip state */
  let from = { kind: "gps", name: "My location" };   // or { kind: "place", name, ll }
  let to = null;                                      // { name, ll }
  let pick = null;                                    // "from" | "to" while choosing on the map
  const recentKey = "odyssey_recent";

  function addRecent(place) {
    const list = store.get(recentKey, []).filter((p) => p.name !== place.name);
    list.unshift({ name: place.name, ll: place.ll, sub: place.sub || "" });
    store.set(recentKey, list.slice(0, 6));
  }

  /* ---------------------------------------------------------------- plan view */
  const presetPlaces = PRESETS.map(([name, lat, lng]) => ({ name, ll: [lat, lng], sub: "Popular place" }));
  function renderPlanView() {
    $("quick-chips").innerHTML = presetPlaces.slice(0, 8).map((p, i) =>
      `<button class="chip" data-i="${i}"><svg><use href="#i-pin"/></svg>${esc(p.name.replace(/ \(.*\)/, ""))}</button>`).join("");
    $("quick-chips").querySelectorAll(".chip").forEach((b) =>
      b.addEventListener("click", () => chooseDestination(presetPlaces[+b.dataset.i])));
    const recent = store.get(recentKey, []);
    $("recent-wrap").classList.toggle("hidden", !recent.length);
    $("recent-list").innerHTML = recent.map((p, i) => placeRow(p, i, "i-clock")).join("");
    $("recent-list").querySelectorAll(".row").forEach((b) =>
      b.addEventListener("click", () => chooseDestination(recent[+b.dataset.i])));
    const total = walkable.length;
    $("honesty-card").innerHTML =
      `<div class="big">${unknownPct}%</div>` +
      `<p>of Southampton’s ${total.toLocaleString()} walking paths are shown as “risk unknown” instead of guessed. ` +
      `${noLightPct}% of the network has no lighting record, and ${noCrimePct}% is outside the area police crime data was fetched for.</p>` +
      `<div class="meter" aria-hidden="true">${["low", "medium", "high", "unknown"].map((b) =>
        `<span style="width:${(counts[b] / total) * 100}%;background:${b === "unknown"
          ? "repeating-linear-gradient(90deg,#8592A6 0 5px,#1F2E4A 5px 9px)" : COLORS[b]}"></span>`).join("")}</div>` +
      `<p class="tiny" style="margin-top:8px">Crime model trained on ${crimeCount ? crimeCount.toLocaleString() + " " : ""}` +
      `real Police UK records${crimePeriod ? ", " + crimePeriod : ""}.</p>`;
  }
  function placeRow(p, i, icon) {
    return `<button class="row" role="option" data-i="${i}"><span class="row-icon"><svg><use href="#${icon}"/></svg></span>` +
      `<span class="row-text"><span class="row-title">${esc(p.name)}</span>` +
      (p.sub ? `<span class="row-sub">${esc(p.sub)}</span>` : "") + `</span></button>`;
  }

  /* ---------------------------------------------------------------- search view */
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const VIEWBOX = "-1.48,50.86,-1.33,50.96";
  let searchCtrl = null, searchTimer = null, suggestions = [], activeIdx = -1;

  function openSearch(focus = true) {
    showView("search");
    setSheet("full");
    $("from-value").textContent = from.name;
    $("from-picker").classList.add("hidden");
    $("search-status").textContent = "";
    $("search-status").className = "status";
    renderSuggestions($("dest").value);
    syncClear();
    if (focus) setTimeout(() => $("dest").focus(), 280);
  }
  function closeSearch() {
    $("dest").blur();
    showView(lastResults ? "results" : "plan");
    setSheet(lastResults ? "half" : "peek");
  }
  $("open-search").addEventListener("click", () => openSearch());
  // the X clears what's typed in "To" (like a normal search box); it doesn't close the panel
  function syncClear() { $("search-close").classList.toggle("is-empty", !$("dest").value); }
  $("search-close").addEventListener("click", () => {
    $("dest").value = "";
    searchDone = "";
    clearTimeout(searchTimer);
    if (searchCtrl) searchCtrl.abort();
    $("search-status").textContent = "";
    $("search-status").className = "status";
    renderSuggestions("");
    syncClear();
    $("dest").focus();
  });

  let searchDone = "";   // the last query the online search fully answered
  function renderSuggestions(q, remote = []) {
    q = (q || "").trim().toLowerCase();
    const recent = store.get(recentKey, []);
    const local = q
      ? [...recent, ...presetPlaces].filter((p, i, arr) => p.name.toLowerCase().includes(q) && arr.findIndex((x) => x.name === p.name) === i)
      : [...recent.map((p) => ({ ...p, recent: true })), ...presetPlaces.filter((p) => !recent.some((r) => r.name === p.name))];
    suggestions = [...local, ...remote.filter((r) => !local.some((l) => l.name === r.name))].slice(0, 12);
    activeIdx = -1;
    const actions = q ? "" :
      `<button class="row" data-act="pick-to"><span class="row-icon"><svg><use href="#i-pin"/></svg></span>` +
      `<span class="row-text"><span class="row-title">Choose on the map</span><span class="row-sub">Tap where you’re going</span></span></button>`;
    $("suggestions").innerHTML = actions + suggestions.map((p, i) => placeRow(p, i, p.recent ? "i-clock" : p.remote ? "i-search" : "i-pin")).join("") +
      (q && !suggestions.length ? `<p class="small" style="padding:14px 4px">${searchDone === q
        ? `No place called “${esc(q)}” found in Southampton. Try a street name or postcode.`
        : "No matches yet. Keep typing a street, place or postcode."}</p>` : "");
    $("suggestions").querySelectorAll(".row[data-i]").forEach((b) =>
      b.addEventListener("click", () => chooseDestination(suggestions[+b.dataset.i])));
    const pickBtn = $("suggestions").querySelector('[data-act="pick-to"]');
    if (pickBtn) pickBtn.addEventListener("click", () => startPick("to"));
  }
  $("dest").addEventListener("input", () => {
    syncClear();
    const q = $("dest").value.trim();
    renderSuggestions(q);
    clearTimeout(searchTimer);
    if (searchCtrl) searchCtrl.abort();
    searchDone = "";
    if (q.length < 3) { $("search-status").textContent = ""; return; }
    searchTimer = setTimeout(async () => {
      searchCtrl = new AbortController();
      $("search-status").className = "status";
      $("search-status").textContent = "Searching…";
      try {
        const url = `${NOMINATIM}?format=jsonv2&limit=6&accept-language=en&countrycodes=gb&viewbox=${VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { signal: searchCtrl.signal });
        if (!res.ok) throw Object.assign(new Error("search " + res.status), { server: true });
        const r = await res.json();
        const remote = (Array.isArray(r) ? r : []).map((x) => {
          const parts = (x.display_name || "").split(",").map((t) => t.trim());
          return { name: parts[0], sub: parts.slice(1, 3).join(", "), ll: [+x.lat, +x.lon], remote: true };
        });
        $("search-status").textContent = "";
        if ($("dest").value.trim() === q) { searchDone = q.toLowerCase(); renderSuggestions(q, remote); }
      } catch (e) {
        if (e.name === "AbortError") return;
        $("search-status").className = "status warn";
        // say what actually went wrong: no connection is not the same as "not found"
        $("search-status").textContent = !navigator.onLine || !e.server
          ? "You’re offline, so place search isn’t available. Popular places, recent places and choosing on the map still work."
          : "Place search isn’t responding right now. Try again in a moment, or choose on the map.";
      }
    }, 380);
  });
  $("dest").addEventListener("keydown", (e) => {
    const rows = [...$("suggestions").querySelectorAll(".row[data-i]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(0, Math.min(rows.length - 1, activeIdx + (e.key === "ArrowDown" ? 1 : -1)));
      rows.forEach((r, i) => r.setAttribute("aria-selected", String(i === activeIdx)));
      rows[activeIdx] && rows[activeIdx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = $("dest").value.trim().toLowerCase();
      if (activeIdx >= 0 && suggestions[activeIdx]) return chooseDestination(suggestions[activeIdx]);
      // never pick silently: only go straight to a result when it's the only match,
      // or the only one whose name matches exactly
      const exact = suggestions.filter((p) => p.name.toLowerCase() === q);
      if (suggestions.length === 1 && searchDone === q) return chooseDestination(suggestions[0]);
      if (exact.length === 1 && suggestions.filter((p) => p.name.toLowerCase() === q).length === 1 && !exact[0].remote) return chooseDestination(exact[0]);
      $("search-status").className = "status";
      $("search-status").textContent = !suggestions.length ? (searchDone === q ? "" : "Still searching…")
        : (suggestions.length > 1 ? `${suggestions.length} places match. Tap the right one below.` : "Is this the place you mean? Tap it below to confirm.");
      if (rows[0]) { activeIdx = 0; rows[0].setAttribute("aria-selected", "true"); }
    }
  });

  // start point picker
  $("from-row").addEventListener("click", () => {
    const fp = $("from-picker");
    if (!fp.classList.contains("hidden")) { fp.classList.add("hidden"); return; }
    const opts = [{ name: "My location", sub: "Use this phone’s location", gps: true },
      { name: "Choose on the map", sub: "Tap your start point", map: true }, ...presetPlaces];
    $("from-list").innerHTML = opts.map((p, i) => placeRow(p, i, p.gps ? "i-dot" : "i-pin")).join("");
    $("from-list").querySelectorAll(".row").forEach((b) => b.addEventListener("click", () => {
      const p = opts[+b.dataset.i];
      fp.classList.add("hidden");
      if (p.gps) from = { kind: "gps", name: "My location" };
      else if (p.map) return startPick("from");
      else from = { kind: "place", name: p.name, ll: p.ll };
      $("from-value").textContent = from.name;
      if (to) plan();
      else $("dest").focus();
    }));
    fp.classList.remove("hidden");
  });

  function startPick(which) {
    pick = which;
    $("dest").blur();
    $("pick-text").textContent = which === "from" ? "Tap the map to set your start" : "Tap the map where you’re going";
    $("pick-banner").classList.remove("hidden");
    setSheet("peek");
  }
  function endPick() {
    pick = null;
    $("pick-banner").classList.add("hidden");
  }
  $("pick-cancel").addEventListener("click", () => { endPick(); openSearch(false); });
  map.on("click", (e) => {
    if (!pick) return;
    const ll = [e.latlng.lat, e.latlng.lng];
    const which = pick;
    endPick();
    vibrate();
    if (which === "from") {
      from = { kind: "place", name: "Dropped pin (start)", ll };
      if (to) plan(); else openSearch();
    } else {
      chooseDestination({ name: "Dropped pin", ll, sub: `${ll[0].toFixed(4)}, ${ll[1].toFixed(4)}` });
    }
  });

  function chooseDestination(place) {
    to = { name: place.name, ll: place.ll, sub: place.sub };
    if (!/Dropped pin/.test(place.name)) addRecent(to);
    $("dest").value = place.name;
    syncClear();
    plan();
  }

  /* ---------------------------------------------------------------- planning */
  let routeLayers = [], lastResults = null, selected = 0, pins = [], lastWaterAvoid = false;

  // throw away the previous route as soon as a new plan starts, so a failed
  // search never leaves an old route on the map or in the sheet
  // metres actually walked on paths matching test (counts only the part of each path the route uses)
  function walkedM(r, test) {
    let m = 0;
    for (const st of r.route.steps) { const seg = graph.byId.get(st.seg); if (seg && test(seg)) m += st.len; }
    return m;
  }
  function clearResults() {
    lastResults = null;
    drawRoutes();
    $("cards").innerHTML = "";
    $("card-dots").innerHTML = "";
    $("route-detail").innerHTML = "";
  }
  function outsideMsg(which, dist) {
    const km = dist >= 2000 ? ` It’s about ${Math.round(dist / 1000)} km from the nearest path Odyssey knows.` : "";
    return which === "start"
      ? `Your start is outside Southampton. Odyssey only covers Southampton.${km} Choose a start point in the city.`
      : `That destination is outside Southampton. Odyssey only covers Southampton.${km}`;
  }

  async function plan() {
    if (!to) return;
    clearResults();
    $("dest").blur();
    showView("search");
    $("search-status").className = "status";
    let fromLL = from.ll;
    if (from.kind === "gps") {
      $("search-status").textContent = "Finding your location…";
      try {
        fromLL = await getPosition();
        showMe(fromLL);
      } catch (e) {
        $("search-status").className = "status warn";
        $("search-status").textContent = e.message;
        $("from-row").click();
        return;
      }
    }
    $("search-status").textContent = "";
    showSkeleton();
    await nextPaint();
    const a = snap(graph, fromLL), b = snap(graph, to.ll);
    if (a.dist > 400 || b.dist > 400) {
      clearResults(); showView("search"); setSheet("full");
      $("search-status").className = "status warn";
      $("search-status").textContent = a.dist > 400 ? outsideMsg("start", a.dist) : outsideMsg("end", b.dist);
      return;
    }
    lastWaterAvoid = waterAvoid();
    const prefs = { ...loadPrefs(), avoid_waterside: lastWaterAvoid };
    const triad = planTriad(graph, a.key, b.key, prefs);
    const results = [];
    if (triad.safest) results.push({ label: "Safest", route: triad.safest, note: triad.safestNote });
    if (triad.shortest) results.push({ label: "Shortest", route: triad.shortest });
    if (triad.balanced) results.push({ label: "Balanced", route: triad.balanced });
    const uniq = [];
    for (const r of results) {
      if (!uniq.some((u) => u.route.segments.map((s) => s.id).join() === r.route.segments.map((s) => s.id).join())) uniq.push(r);
    }
    if (!uniq.length) {
      clearResults(); showView("search"); setSheet("full");
      $("search-status").className = "status warn";
      $("search-status").textContent = "No walking route found between those points. Try a point nearer a street or path.";
      return;
    }
    $("search-status").textContent = "";
    for (const r of uniq) {
      r.stats = routeStats(r.route);
      r.text = [r.note, explain(r.route, uniq, [], havens, r.label)].filter(Boolean).join(" ");
      r.factors = explanationFactors(r.route.segments, prefs);
      r.coords = [graph.nodes.get(r.route.steps[0].from).c].concat(r.route.steps.map((st) => graph.nodes.get(st.to).c));
      r.legs = legsOf(r.route);
      r.crimeCover = walkedM(r, (x) => x.crime_covered) / (walkedM(r, () => true) || 1);
    }
    const shortestR = uniq.find((x) => x.label === "Shortest") || (triad.shortest ? { route: triad.shortest } : null);
    for (const r of uniq) r.gmaps = gmapsLink(r, shortestR);
    for (const r of uniq) r.bullets = bulletsFor(r, uniq);
    lastResults = { uniq, fromLL, toLL: to.ll, fromName: from.name, toName: to.name, toSub: to.sub && to.sub !== "Popular place" ? to.sub : "" };
    renderResults();
    vibrate(12);
  }

  /* Google Maps handoff with as few stops as possible.
   * Routes that differ from the shortest get up to MAX_STOPS points spread
   * evenly along the walk, so Google follows this route instead of its own.
   * The shortest route needs none. Set MAX_STOPS to 0 for none. */
  const MAX_STOPS = 8;   // Google Maps allows up to 9 points in a link
  // Google Maps links can't steer a route without stops, and it pins every stop.
  // We keep the stops (so it follows this route) and tell people on the card.
  function gmapsLink(r, shortest) {
    const steps = r.route.steps;
    const ll = (c) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
    const start = graph.nodes.get(steps[0].from).c;
    const end = graph.nodes.get(steps[steps.length - 1].to).c;
    const q = new URLSearchParams({ api: 1, origin: ll(start), destination: ll(end), travelmode: "walking" });
    if (MAX_STOPS > 0 && shortest && shortest.route !== r.route) {
      // evenly spaced points along the walk, like the earlier version: Google Maps
      // shows them as small dots and follows this route instead of its own
      const pts = r.coords;
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + distM(pts[k - 1], pts[k]));
      const total = cum[cum.length - 1];
      const wps = [];
      for (let k = 1; k <= MAX_STOPS; k++) {
        const target = (total * k) / (MAX_STOPS + 1);
        let i = 1;
        while (i < cum.length - 1 && cum[i] < target) i++;
        const c = pts[i];
        if (distM(c, start) > 100 && distM(c, end) > 100 && wps.every((w) => distM(w, c) > 120)) wps.push(c);
      }
      if (wps.length) q.set("waypoints", wps.map(ll).join("|"));
      r.gmapsStops = wps.length;
    }
    return "https://www.google.com/maps/dir/?" + q.toString();
  }

  /* Short, scannable facts for each route card (max 4), built from the same
   * data the core's explain() uses. The full sentence stays available to
   * screen readers through the card's label. */
  function bulletsFor(r, uniq) {
    const out = [];
    const shortest = uniq.find((x) => x.label === "Shortest");
    const segIds = new Set(r.route.segments.map((x) => x.id));
    if (r.label === "Shortest" || !shortest) out.push(["i-walk", "Most direct route", ""]);
    else {
      const d = Math.round(r.stats.minutes - shortest.stats.minutes);
      out.push(["i-clock", d >= 1 ? `+${d} min vs shortest` : "Same time as shortest", ""]);
      const avoided = shortest.route.segments.find((x) => !segIds.has(x.id) && (x.risk_band === "high" || x.risk_band === "unknown"));
      if (avoided) out.push(["i-check", avoided.lighting === "no" ? "Avoids an unlit path" : avoided.risk_band === "unknown" ? "Avoids a path with unknown risk" : "Avoids a higher-risk path", "good"]);
    }
    if (r.note) out.push(["i-check", "Best option within a 12 min detour", "good"]);
    const crimes = r.route.segments.reduce((t, x) => t + (x.crime_count_90d || 0), 0);
    const cov = r.crimeCover;
    if (cov >= 0.95) out.push(crimes ? ["i-alert", `${crimes} street crime${crimes > 1 ? "s" : ""} nearby (3 months)`, crimes >= 20 ? "bad" : ""]
      : ["i-check", "No recent street crime recorded", "good"]);
    else if (cov < 0.05) out.push(["i-alert", "No police crime data for this walk", "unk"]);
    else out.push(["i-alert", `${crimes || "No"} crime${crimes === 1 ? "" : "s"} recorded, but data covers only ${Math.round(cov * 100)}% of the walk`, "unk"]);
    const greenM = walkedM(r, (x) => x.in_green === true);
    if (greenM >= 50) out.push(["i-tree", `${Math.round(greenM / 10) * 10} m through a park or wood`, (loadPrefs().green || "reduce") === "any" ? "" : "unk"]);
    else if ((loadPrefs().green || "reduce") !== "any" && uniq.some((u) => u !== r && walkedM(u, (x) => x.in_green === true) >= 50))
      out.push(["i-tree", "Keeps out of parks and woods", "good"]);
    const noLight = r.route.segments.filter((x) => x.lighting === "unknown").length;
    if (noLight) out.push(["i-bulb", `${noLight} stretch${noLight > 1 ? "es" : ""} with no lighting data`, "unk"]);
    const haven = havens.find((h) => /24\/7/.test(h.hours) && r.coords.some((c) => distM(c, [h.lat, h.lng]) < 150));
    if (haven) out.push(["i-shield", "Passes a 24/7 staffed place", "good"]);
    if (r.route.segments.some((x) => x.tide_exposed)) out.push(lastWaterAvoid ? ["i-wave", "Uses a waterside path while the tide is high", "bad"] : ["i-wave", "Includes a waterside path", ""]);
    return out.slice(0, 4);
  }

  function showSkeleton() {
    $("results-to").textContent = to.name;
    $("results-from").textContent = "Comparing routes…";
    $("cards").innerHTML = [0, 1].map(() => `<article class="card skeleton" aria-hidden="true"><i class="sk w40"></i><i class="sk w60 tall"></i>` +
      `<i class="sk w100 thin"></i><i class="sk w80"></i><i class="sk w70"></i><i class="sk w90"></i><i class="sk w100 btnh"></i></article>`).join("");
    $("card-dots").innerHTML = "";
    $("route-detail").innerHTML = "";
    showView("results");
    setSheet("half");
  }

  function legsOf(route) {
    const legs = [];
    for (const st of route.steps) {
      const band = graph.byId.get(st.seg).risk_band;
      const a = graph.nodes.get(st.from).c, b = graph.nodes.get(st.to).c;
      const last = legs[legs.length - 1];
      if (last && last.band === band) { last.coords.push(b); last.m += st.len; }
      else legs.push({ band, coords: [a, b], m: st.len });
    }
    return legs;
  }

  function ribbonHTML(legs) {
    const total = legs.reduce((t, l) => t + l.m, 0) || 1;
    const merged = [];
    for (const l of legs) {
      const last = merged[merged.length - 1];
      if (last && (last.band === l.band || l.m / total < 0.012)) last.m += l.m;
      else merged.push({ band: l.band, m: l.m });
    }
    const summary = ["high", "unknown", "medium"].map((b) => {
      const m = merged.filter((x) => x.band === b).reduce((t, x) => t + x.m, 0);
      return m >= 20 ? `${Math.round(m)} metres ${b === "unknown" ? "with unknown risk" : b + " risk"}` : "";
    }).filter(Boolean).join(", ");
    return `<div class="ribbon" role="img" aria-label="Route from start to destination: ${summary || "all low risk"}">` +
      merged.map((x) => `<span class="r-${x.band}" style="flex:${x.m}"></span>`).join("") +
      `</div><div class="ribbon-ends"><span>Start</span><span>Destination</span></div>`;
  }

  /* ---------- Google Maps stops: say clearly they aren't the destination */
  function explainStops(r) {
    openModal("Before you open Google Maps",
      `<div class="explain">` +
      `<div class="ex-row"><span class="ex-ico dot"></span><div><b>${r.gmapsStops} small stops along the way</b><span>They keep Google Maps on the ${LABELS[r.label].toLowerCase()} route. They aren’t your destination.</span></div></div>` +
      `<div class="ex-row"><span class="ex-ico"><svg><use href="#i-pin"/></svg></span><div><b>The red pin moves as you walk</b><span>After you press Start, it sits on the next stop, then jumps ahead each time you pass one.</span></div></div>` +
      `<div class="ex-row"><span class="ex-ico end"><svg><use href="#i-flag"/></svg></span><div><b>${esc(lastResults.toName)} is the last stop</b><span>That’s where the route ends.</span></div></div>` +
      `</div>` +
      `<label class="check-row" style="margin-top:16px"><input type="checkbox" id="ex-hide"><span>Don’t show this again</span></label>` +
      `<div class="stack" style="margin-top:16px">` +
      `<a class="btn primary block" id="ex-go" href="${r.gmaps}" target="_blank" rel="noopener">Open Google Maps</a>` +
      `<button class="btn secondary block" id="ex-walk"><svg><use href="#i-locate"/></svg>Walk with Odyssey instead</button></div>`,
      (body) => {
        const remember = () => { if (body.querySelector("#ex-hide").checked) store.set("odyssey_stops_ok", true); };
        body.querySelector("#ex-go").addEventListener("click", () => { remember(); setTimeout(closeModal, 300); });
        body.querySelector("#ex-walk").addEventListener("click", () => { remember(); closeModal(); startWalk(r); });
      });
  }

  /* ---------- ride suggestion (settings: odyssey_ride) */
  const RIDE_DEFAULT = { mode: "long", minutes: 20 };
  const rideSettings = () => ({ ...RIDE_DEFAULT, ...store.get("odyssey_ride", {}) });
  function rideReason() {
    const set = rideSettings();
    if (set.mode === "off" || !lastResults) return null;
    const best = lastResults.uniq[0];           // the lower-risk route
    const min = Math.round(best.stats.minutes);
    const long = min > set.minutes;
    const risky = best.stats.band === "high";
    if ((set.mode === "long" || set.mode === "long_or_risky") && long)
      return { title: "Long walk", text: `${min} min on foot${risky ? ", with a higher-risk stretch even on the lower-risk route" : ""}. Prefer a ride?` };
    if ((set.mode === "risky" || set.mode === "long_or_risky") && risky)
      return { title: "Higher-risk stretch on every route", text: "Even the lower-risk route passes a higher-risk path. Prefer a ride?" };
    return null;
  }
  function renderRide() {
    const why = rideReason();
    const box = $("ride-card");
    if (!why) { box.innerHTML = ""; return; }
    const d = lastResults.toLL, name = lastResults.toName;
    const uber = "https://m.uber.com/ul/?" + new URLSearchParams({
      action: "setPickup", pickup: "my_location",
      "dropoff[latitude]": d[0].toFixed(6), "dropoff[longitude]": d[1].toFixed(6), "dropoff[nickname]": name,
    }).toString();
    box.innerHTML =
      `<div class="ride"><div class="ride-head"><span class="ride-ico"><svg><use href="#i-moon"/></svg></span>` +
      `<div><p class="ride-title">${esc(why.title)}</p><p class="ride-text">${esc(why.text)}</p></div></div>` +
      `<div class="ride-actions">` +
      `<a class="btn ride-uber" href="${uber}" target="_blank" rel="noopener">Uber</a>` +
      `<button class="btn ride-bolt" id="ride-bolt">Bolt</button>` +
      `<button class="btn secondary" id="ride-share"><svg><use href="#i-share"/></svg>Send location</button></div>` +
      `<button class="ride-settings" id="ride-settings">Ride suggestions: ${rideSettings().mode === "off" ? "off" : "change"}</button></div>`;
    $("ride-bolt").addEventListener("click", async () => {
      // Bolt has no public link that fills in the destination, so copy it first
      try { await navigator.clipboard.writeText(`${name}${lastResults.toSub ? ", " + lastResults.toSub : ""}, Southampton`); } catch (e) { /* ignore */ }
      toast("Destination copied. Paste it into Bolt.");
      setTimeout(() => window.open("https://bolt.eu/en-gb/rides/", "_blank", "noopener"), 700);
    });
    $("ride-share").addEventListener("click", () => shareMyLocation());
    $("ride-settings").addEventListener("click", openPrefs);
  }

  /* ---------- share where I am right now */
  async function shareMyLocation(msgEl) {
    const say = (t) => { if (msgEl) msgEl.textContent = t; else if (t) toast(t); };
    say("Finding your location…");
    try {
      const ll = walkState && walkState.last ? walkState.last : await getPosition();
      const url = `https://www.google.com/maps?q=${ll[0].toFixed(5)},${ll[1].toFixed(5)}`;
      const dest = lastResults ? ` I’m heading to ${lastResults.toName}.` : "";
      if (navigator.share) { await navigator.share({ title: "My location", text: `This is where I am right now.${dest}`, url }); say(""); }
      else { await navigator.clipboard.writeText(`This is where I am right now.${dest} ${url}`); say("Location link copied. Paste it into a message."); }
    } catch (e) { if (e && e.name !== "AbortError") say(e.message || "Couldn’t share your location."); else say(""); }
  }

  /* ---------- tap a road: short summary of the area around it */
  let peekPopup = null;
  function openRoadPeek(s, latlng) {
    const at = [latlng.lat, latlng.lng];
    const near = segMids.filter(([, m]) => distM(m, at) <= 150).map(([x]) => x);
    const covered = near.some((x) => x.crime_covered);
    const crimes = near.reduce((t, x) => t + (x.crime_count_90d || 0), 0);
    const lenNear = lenOf(near) || 1;
    const litPct = Math.round((lenOf(near.filter((x) => x.lighting === "yes")) / lenNear) * 100);
    const noLight = near.every((x) => x.lighting === "unknown");
    let haven = null, hd = Infinity;
    for (const h of havens) { const d = distM(at, [h.lat, h.lng]); if (d < hd) { hd = d; haven = h; } }
    const name = s.name === "unnamed path" ? `Unnamed ${s.highway_type}` : s.name;
    const light = s.lighting === "yes" ? "This path is lit" : s.lighting === "no" ? "This path is unlit" : "No lighting record for this path";
    const rows = [
      s.in_green ? ["i-tree", "Footpath through a park or wood"] : null,
      ["i-bulb", light + (noLight ? "" : ` · ${litPct}% of paths nearby are lit`)],
      covered ? ["i-alert", crimes ? `${crimes} street crime${crimes > 1 ? "s" : ""} reported within 150 m (3 months)` : "No street crime reported within 150 m (3 months)"]
        : ["i-alert", "No police crime data for this area"],
      haven && hd <= 1000 ? ["i-shield", `${esc(haven.name)}, ${Math.round(hd / 10) * 10} m away`] : ["i-shield", "No staffed place within 1 km"],
    ];
    const html = `<div class="peek"><div class="peek-top"><b>${esc(name)}</b><span class="band ${s.risk_band}">${BAND_TEXT[s.risk_band]}</span></div>` +
      `<ul>${rows.filter(Boolean).map(([ic, t]) => `<li><svg><use href="#${ic}"/></svg><span>${t}</span></li>`).join("")}</ul>` +
      `<button class="peek-more">More details</button></div>`;
    if (peekPopup) map.closePopup(peekPopup);
    peekPopup = L.popup({ className: "peek-pop", closeButton: true, autoPanPaddingTopLeft: [12, 80], autoPanPaddingBottomRight: [12, 40], maxWidth: 290 })
      .setLatLng(latlng).setContent(html).openOn(map);
    const el = peekPopup.getElement();
    el && el.querySelector(".peek-more").addEventListener("click", () => { map.closePopup(peekPopup); openSegment(s); });
  }

  /* ---------- Walk with Odyssey: live position on our own map */
  let walkState = null;
  async function startWalk(r) {
    if (!navigator.geolocation) return toast("This browser can’t share your location.");
    const pts = r.coords;
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + distM(pts[k - 1], pts[k]));
    walkState = { r, pts, cum, total: cum[cum.length - 1], follow: true, last: null, idx: 0, done: false, lock: null };
    selected = lastResults.uniq.indexOf(r);
    document.body.classList.add("walking");
    $("walkbar").classList.remove("hidden");
    $("wb-sub").textContent = `${LABELS[r.label]} route to ${lastResults.toName}`;
    $("wb-next").textContent = "Finding your location…";
    $("wb-warn").classList.add("hidden");
    drawRoutes();
    map.setView(pts[0], 17, { animate: true });
    updateWalk(null);
    try { if (navigator.wakeLock) walkState.lock = await navigator.wakeLock.request("screen"); } catch (e) { /* not supported */ }
    walkState.watch = navigator.geolocation.watchPosition(
      (p) => onWalkPos([p.coords.latitude, p.coords.longitude]),
      (err) => { toast(err.code === 1 ? "Location is off for this site, so Odyssey can’t follow your walk." : "Can’t get your location right now."); if (err.code === 1) endWalk(); },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
    vibrate(12);
  }
  // nearest point on the route line to where you are
  function project(ll) {
    const { pts, cum } = walkState;
    const kx = Math.cos((ll[0] * Math.PI) / 180);
    let best = { d: Infinity, along: 0, i: 0 };
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][1] * kx, ay = pts[i][0], bx = pts[i + 1][1] * kx, by = pts[i + 1][0];
      const px = ll[1] * kx, py = ll[0];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const q = [ay + t * dy, (ax + t * dx) / kx];
      const d = distM(ll, q);
      if (d < best.d) best = { d, along: cum[i] + t * (cum[i + 1] - cum[i]), i };
    }
    return best;
  }
  function streetAt(i) {
    const st = walkState.r.route.steps[i];
    const seg = st && graph.byId.get(st.seg);
    return seg && seg.name && seg.name !== "unnamed path" ? seg.name : null;
  }
  function onWalkPos(ll) {
    if (!walkState) return;
    walkState.last = ll;
    showMe(ll);
    if (walkState.follow) map.panTo(ll, { animate: true });
    updateWalk(project(ll));
  }
  function updateWalk(pr) {
    const w = walkState;
    const left = pr ? Math.max(0, w.total - pr.along) : w.total;
    const min = Math.max(0, Math.round(left / 80));
    $("wb-min").textContent = min;
    $("wb-dist").textContent = left >= 1000 ? `${(left / 1000).toFixed(1)} km` : `${Math.round(left / 10) * 10} m`;
    $("wb-sub").textContent = `Arrive ${etaTime(left / 80)} · ${LABELS[w.r.label]} route to ${lastResults.toName}`;
    if (!pr) return;
    if (left < 30 && !w.done) {
      w.done = true;
      $("wb-next").innerHTML = `<b>You’ve arrived at ${esc(lastResults.toName)}</b>`;
      $("wb-end").textContent = "Done";
      vibrate([20, 60, 20]);
      return;
    }
    const off = pr.d > 40;
    $("wb-warn").classList.toggle("hidden", !off);
    if (off) $("wb-warn-text").textContent = `You’re about ${Math.round(pr.d / 10) * 10} m off the route.`;
    const here = streetAt(pr.i);
    let next = null, nextAt = 0;
    for (let k = pr.i + 1; k < w.r.route.steps.length; k++) {
      const n = streetAt(k);
      if (n && n !== here) { next = n; nextAt = w.cum[k] - pr.along; break; }
    }
    $("wb-next").innerHTML = (here ? `On <b>${esc(here)}</b>` : "Follow the line") +
      (next ? ` · then <b>${esc(next)}</b> in ${nextAt >= 1000 ? (nextAt / 1000).toFixed(1) + " km" : Math.max(10, Math.round(nextAt / 10) * 10) + " m"}` : "");
  }
  function endWalk() {
    if (!walkState) return;
    if (walkState.watch != null) navigator.geolocation.clearWatch(walkState.watch);
    try { walkState.lock && walkState.lock.release(); } catch (e) { /* ignore */ }
    walkState = null;
    document.body.classList.remove("walking");
    $("walkbar").classList.add("hidden");
    $("wb-end").textContent = "End";
    drawRoutes();
    setSheet("half");
  }
  $("wb-end").addEventListener("click", endWalk);
  $("wb-recenter").addEventListener("click", () => { if (!walkState) return; walkState.follow = true; if (walkState.last) map.setView(walkState.last, 17); });
  $("wb-share").addEventListener("click", () => shareMyLocation());
  $("wb-replan").addEventListener("click", () => { endWalk(); from = { kind: "gps", name: "My location" }; plan(); });
  map.on("dragstart", () => { if (walkState) walkState.follow = false; });

  function renderResults() {
    const { uniq, fromName, toName } = lastResults;
    $("results-to").textContent = toName;
    $("results-from").textContent = `${lastResults.toSub ? lastResults.toSub + " · " : ""}from ${fromName}`;
    const cards = $("cards");
    cards.innerHTML = uniq.map((r, i) => {
      const st = r.stats;
      return `<article class="card" role="listitem" data-i="${i}" tabindex="0" aria-label="${LABELS[r.label]} route, ${Math.round(st.minutes)} minutes, ${BAND_TEXT[st.band]}. ${esc(r.text)}">` +
        `<div class="card-top"><span class="card-label">${LABELS[r.label]}</span><span class="band ${st.band}">${BAND_TEXT[st.band]}</span></div>` +
        `<div class="eta"><b>${Math.round(st.minutes)}</b><span class="eta-unit">min</span>` +
        `<span class="eta-meta"><span>Arrive ${etaTime(st.minutes)}</span><span>${(st.len / 1000).toFixed(1)} km</span></span></div>` +
        ribbonHTML(r.legs) +
        `<ul class="card-why">${r.bullets.map(([ic, t, tone]) => `<li class="${tone}"><svg><use href="#${ic}"/></svg><span>${esc(t)}</span></li>`).join("")}</ul>` +
        `<div class="actions">` +
        `<a class="btn primary" href="${r.gmaps}" target="_blank" rel="noopener" data-go="${i}"><svg><use href="#i-walk"/></svg>Go</a>` +
        `<button class="btn secondary square" data-share="${i}" aria-label="Share this walk"><svg><use href="#i-share"/></svg></button>` +
        `<button class="btn secondary square" data-report="${i}" aria-label="Report a problem on this route"><svg><use href="#i-flag"/></svg></button>` +
        `</div>` +
        `<button class="btn secondary block walk-btn" data-walk="${i}"><svg><use href="#i-locate"/></svg>Walk with Odyssey</button>` +
        (r.gmapsStops ? `<p class="go-note"><svg><use href="#i-dot"/></svg><span>Google Maps shows ${r.gmapsStops} small stops that keep it on this route. <b>They aren’t your destination.</b> ${esc(toName)} is the last stop.</span></p>` : "") +
        `</article>`;
    }).join("");
    $("card-dots").innerHTML = uniq.length > 1 ? uniq.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("") : "";
    cards.scrollLeft = 0;
    requestAnimationFrame(() => { cards.scrollLeft = 0; });
    cards.querySelectorAll(".card").forEach((c) => c.addEventListener("click", (e) => {
      if (e.target.closest("a,button")) return;
      selectRoute(+c.dataset.i, true);
    }));
    cards.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", () => shareWalk(uniq[+b.dataset.share])));
    cards.querySelectorAll("[data-report]").forEach((b) => b.addEventListener("click", () => openReport({ route: uniq[+b.dataset.report] })));
    cards.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", (e) => {
      vibrate(10);
      const rr = uniq[+a.dataset.go];
      if (rr.gmapsStops && !store.get("odyssey_stops_ok", false)) { e.preventDefault(); explainStops(rr); }
    }));
    cards.querySelectorAll("[data-walk]").forEach((b) => b.addEventListener("click", () => startWalk(uniq[+b.dataset.walk])));
    renderRide();
    showView("results");
    setSheet("half");
    selectRoute(0, false);
    fitRoutes();
  }

  let scrollTimer = null, ignoreScrollUntil = 0;
  $("cards").addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    if (performance.now() < ignoreScrollUntil) return;
    scrollTimer = setTimeout(() => {
      const cards = [...$("cards").children];
      const left = $("cards").scrollLeft + 16;
      let best = 0, bestD = Infinity;
      cards.forEach((c, i) => { const d = Math.abs(c.offsetLeft - left); if (d < bestD) { bestD = d; best = i; } });
      if (best !== selected) selectRoute(best, false);
    }, 90);
  }, { passive: true });

  function selectRoute(i, scroll) {
    if (!lastResults) return;
    selected = i;
    const { uniq } = lastResults;
    $("cards").querySelectorAll(".card").forEach((c, k) => c.classList.toggle("selected", k === i));
    $("card-dots").querySelectorAll("i").forEach((d, k) => d.classList.toggle("on", k === i));
    if (scroll) {
      const c = $("cards").children[i];
      const target = c.offsetLeft - 16;
      $("cards").scrollTo({ left: target, behavior: "smooth" });
      ignoreScrollUntil = performance.now() + 700;
      // some browsers skip smooth scrolling; make sure the card lands
      setTimeout(() => { if (Math.abs($("cards").scrollLeft - target) > 4) $("cards").scrollLeft = target; }, 650);
    }
    drawRoutes();
    renderDetail(uniq[i]);
    vibrate(6);
  }

  // put each time tag where its route is furthest from the others, so tags don't stack
  function tagSpot(x, i, uniq) {
    const others = uniq.filter((_, j) => j !== i).flatMap((o) => o.coords.filter((_, k) => k % 3 === 0));
    let best = x.coords[Math.floor(x.coords.length / 2)], bestD = -1;
    const n = x.coords.length;
    for (let k = Math.floor(n * 0.15); k < Math.ceil(n * 0.85); k += Math.max(1, Math.floor(n / 80))) {
      const c = x.coords[k];
      let d = Infinity;
      for (const o of others) { const dd = distM(c, o); if (dd < d) d = dd; if (d < bestD) break; }
      if (d > bestD) { bestD = d; best = c; }
    }
    return best;
  }

  function drawRoutes() {
    routeLayers.forEach((l) => map.removeLayer(l));
    routeLayers = [];
    pins.forEach((p) => map.removeLayer(p));
    pins = [];
    if (!lastResults) { document.body.classList.remove("pane-dim"); return; }
    document.body.classList.add("pane-dim");
    const { uniq } = lastResults;
    uniq.forEach((r, i) => {
      if (i === selected || walkState) return;
      const alt = L.polyline(r.coords, { renderer: routeRenderer, color: "#AEB9CF", weight: 5, opacity: 0.75, dashArray: "2 9", lineCap: "round" })
        .on("click", (e) => { L.DomEvent.stopPropagation(e); selectRoute(i, true); });
      routeLayers.push(alt.addTo(map));
    });
    const r = uniq[selected];
    routeLayers.push(L.polyline(r.coords, { renderer: routeRenderer, color: "#06101F", weight: 11, opacity: 0.85, interactive: false }).addTo(map));
    for (const l of r.legs) {
      routeLayers.push(L.polyline(l.coords, {
        renderer: routeRenderer, color: COLORS[l.band], weight: 6.5, opacity: 1, interactive: false,
        dashArray: l.band === "unknown" ? "3 7" : null, lineCap: "round", lineJoin: "round",
      }).addTo(map));
    }
    const pin = (ll, cls, label) => L.marker(ll, {
      pane: "pins", keyboard: false, title: label,
      icon: L.divIcon({ className: "", html: `<div class="pin ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, cls === "end" ? 20 : 11] }),
    }).addTo(map);
    pins = [pin(r.coords[0], "start", "Start"), pin(r.coords[r.coords.length - 1], "end", lastResults.toName)];
    // time tags on each route, like the big map apps; tap one to pick that route
    if (!walkState) uniq.forEach((x, i) => {
      const at = tagSpot(x, i, uniq);
      const tag = L.marker(at, {
        pane: "pins", keyboard: false, title: `${LABELS[x.label]} route`,
        icon: L.divIcon({ className: "", html: `<div class="route-tag ${i === selected ? "on" : ""}"><b>${Math.round(x.stats.minutes)} min</b>${i === selected ? `<span>${LABELS[x.label]}</span>` : ""}</div>`, iconSize: null }),
      }).on("click", (e) => { L.DomEvent.stopPropagation(e); if (i !== selected) selectRoute(i, true); }).addTo(map);
      pins.push(tag);
    });
  }

  function fitRoutes() {
    if (!lastResults) return;
    const all = lastResults.uniq.flatMap((r) => r.coords);
    const bottom = isDesktop() ? 40 : sheetHeights().half + 20;
    map.fitBounds(L.latLngBounds(all), {
      paddingTopLeft: [isDesktop() ? 440 : 30, isDesktop() ? 40 : 90], paddingBottomRight: [isDesktop() ? 40 : 30, bottom], maxZoom: 17,
    });
  }

  function renderDetail(r) {
    const segs = r.route.segments;
    const crimes = segs.reduce((t, s) => t + (s.crime_count_90d || 0), 0);
    const unknownM = walkedM(r, (x) => x.risk_band === "unknown");
    const noLightM = walkedM(r, (x) => x.lighting === "unknown");
    const noCrimeM = walkedM(r, (x) => !x.crime_covered);
    const covPct = Math.round(r.crimeCover * 100);
    const highM = r.legs.filter((l) => l.band === "high").reduce((t, l) => t + l.m, 0);
    const passed = havens.filter((h) => r.coords.some((c) => distM(c, [h.lat, h.lng]) < 150));
    const named = [...new Set(segs.map((s) => s.name).filter((n) => n && n !== "unnamed path"))].slice(0, 4);
    const rows = [
      ["Along this route", named.length ? `Via ${named.join(", ")}` : "Mostly unnamed paths", "OpenStreetMap"],
      ["How routes are ranked", "Lower risk and Balanced keep off paths Athena’s crime model rates higher risk, within a 12 minute detour. Shortest ignores the model.", "Athena model"],
      ["Reported street crime nearby", (crimes ? `${crimes} in the last 3 months on the paths this route uses` : "None recorded on these paths in the last 3 months") +
        (covPct < 95 ? `. Police crime data covers only ${covPct}% of this walk, so the real number may be higher.` : ""),
        `Police UK, locations approximate${crimePeriod ? ", " + crimePeriod : ""}`],
      ["Higher-risk stretches", highM >= 10 ? `${Math.round(highM)} m` : "None", "Athena model"],
      ["Risk unknown", unknownM >= 10 ? `${Math.round(unknownM)} m of the walk` + [noLightM >= 10 ? `${Math.round(noLightM)} m with no lighting record` : "", noCrimeM >= 10 ? `${Math.round(noCrimeM)} m outside the police data area` : ""].filter(Boolean).map((x, i) => (i ? ", " : ": ") + x).join("") : "None", "OpenStreetMap lit tags, Police UK coverage"],
      ["Parks and woods", walkedM(r, (x) => x.in_green === true) >= 20 ? `${Math.round(walkedM(r, (x) => x.in_green === true))} m of this walk is on footpaths through parks or woods` : "None on this route", "OpenStreetMap park and woodland areas"],
      ["Staffed places passed", passed.length ? passed.map((h) => `${h.name} (${h.hours})`).join("; ") : "None within 150 m", "Hand-checked list, hours may change"],
    ];
    $("route-detail").innerHTML =
      (lastWaterAvoid ? `<div class="notice">${live && live.warnings && live.warnings.length ? "A flood warning is active near Southampton" : "The tide is high"}, so routes keep off waterside paths where they can.</div>` : "") +
      (unknownM >= 30 ? `<div class="notice">Risk is unknown for ${Math.round(unknownM)} m of this walk: no lighting record or no police crime data there.</div>` : "") +
      (r.factors.length ? `<div class="factor-chips" aria-label="Your preferences">${r.factors.map((f) => `<span class="tag">${esc(f)}</span>`).join("")}</div>` : "") +
      `<div class="facts">${rows.map(([l, v, s]) => `<div class="fact"><p class="fact-label">${l}</p><p class="fact-value">${esc(v)}</p><p class="fact-src">${esc(s)}</p></div>`).join("")}</div>` +
      `<p class="tiny" style="margin-top:12px">Risk bands compare routes using recorded data. They aren’t a guarantee. Your maps app may choose a slightly different path.</p>`;
  }

  $("results-back").addEventListener("click", () => {
    lastResults = null;
    drawRoutes();
    openSearch(false);
  });
  $("btn-prefs").addEventListener("click", openPrefs);

  async function shareWalk(r) {
    const text = `I’m walking to ${lastResults.toName} (${LABELS[r.label]} route, about ${Math.round(r.stats.minutes)} min, arriving around ${etaTime(r.stats.minutes)}).`;
    try {
      if (navigator.share) { await navigator.share({ title: "My walk home", text, url: r.gmaps }); return; }
      await navigator.clipboard.writeText(`${text} ${r.gmaps}`);
      toast("Walk details copied. Paste them into a message.");
    } catch (e) { /* share cancelled */ }
  }

  /* ---------------------------------------------------------------- detail sheets */
  function factsHTML(rows) {
    return `<div class="facts">${rows.filter(Boolean).map(([l, v, s]) =>
      `<div class="fact"><p class="fact-label">${l}</p><div class="fact-value">${v}</div>${s ? `<p class="fact-src">${esc(s)}</p>` : ""}</div>`).join("")}</div>`;
  }

  function openSegment(s) {
    const name = s.name === "unnamed path" ? `Unnamed ${s.highway_type}` : s.name;
    const cats = Object.entries(s.crime_categories || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxCat = cats.length ? cats[0][1] : 1;
    const months = Object.entries(s.crimes_by_month || {}).sort((a, b) => a[0].localeCompare(b[0]));
    const allMonths = police && police.months ? police.months : months.map((m) => m[0]);
    const monthVals = allMonths.map((m) => [m, (s.crimes_by_month || {})[m] || 0]);
    const maxMonth = Math.max(1, ...monthVals.map((m) => m[1]));
    const lighting = s.lighting === "unknown" ? "No lighting record in OpenStreetMap"
      : s.lighting === "yes" ? (s.lighting_source.startsWith("assumed") ? "Lit (assumed: main roads in the UK are lit)" : "Lit (recorded in OpenStreetMap)")
      : s.lighting === "no" ? "Unlit (recorded in OpenStreetMap)" : s.lighting;
    const html =
      `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="band ${s.risk_band}">${BAND_TEXT[s.risk_band]}</span>` +
      `<span class="small">${s.length_m} m ${esc(s.highway_type)}</span></div>` +
      (s.risk_band === "unknown" ? `<div class="notice">${!s.crime_covered ? "Police crime data wasn’t fetched for this area" : "No lighting record for this path"}, so Odyssey doesn’t score it. Routes prefer an alternative where one exists.</div>` : "") +
      factsHTML([
        s.risk_score != null ? ["Model estimate", `${Math.round(s.risk_score * 100)}% chance of at least one reported street crime nearby in a month`, "Athena model trained on Police UK records"] : null,
        ["Lighting", esc(lighting), "OpenStreetMap"],
        !s.crime_covered ? ["Reported street crime nearby", "No data. Police crime records were only fetched for central Southampton, and this path is outside that area.", "Police UK"] :
        ["Reported street crime nearby", `${s.crime_count_90d || 0} in the last 3 months, ${s.crime_count_6m || 0} in 7 months` +
          (cats.length ? `<div class="bars">${cats.map(([k, v]) => `<div class="bar-row"><span>${esc(CRIME_NAMES[k] || k)}</span><span class="bar-track"><span style="width:${(v / maxCat) * 100}%"></span></span><span>${v}</span></div>`).join("")}</div>` : "") +
          (monthVals.some((m) => m[1]) ? `<div class="spark" aria-label="Crimes by month">${monthVals.map(([m, v]) =>
            `<div><i style="height:${Math.max(3, (v / maxMonth) * 30)}px"></i><small>${new Date(m + "-01T12:00:00Z").toLocaleDateString("en-GB", { month: "narrow" })}</small></div>`).join("")}</div>` : ""),
          `Police UK, locations approximate${s.last_crime_month ? `, latest ${monthName(s.last_crime_month)}` : ""}`],
        ["Isolation", `${s.isolation_score} out of 10 (0 is a busy road, 10 an isolated path)`, "Estimated from street type and lighting"],
        s.nightlife_venues_250m ? ["Nightlife within 250 m", `${s.nightlife_venues_250m} venue${s.nightlife_venues_250m > 1 ? "s" : ""}`, "OpenStreetMap"] : null,
        s.tide_exposed ? ["Waterside", "Near the tidal waterfront", "Environment Agency gauge and coastline model"] : null,
      ]) +
      `<div class="stack" style="margin-top:16px"><button class="btn secondary block" id="seg-report"><svg><use href="#i-flag"/></svg>Report a problem here</button></div>`;
    openModal(name, html, (body) => body.querySelector("#seg-report").addEventListener("click", () => openReport({ segment: s })));
  }

  function openHaven(h) {
    openModal(h.name, factsHTML([
      ["Type", esc(h.type)], ["Opening hours", esc(h.hours), h.source || "Hand-checked list, hours may change"],
    ]) + `<div class="stack" style="margin-top:14px"><a class="btn secondary block" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}&travelmode=walking">Directions here</a>` +
      `<a class="btn quiet block" target="_blank" rel="noopener" href="https://www.safeplaces.org.uk/apps/">Find official Safe Places</a></div>`);
  }

  /* ---------------------------------------------------------------- report */
  const REPORT_CATS = [
    ["streetlight_out", "Streetlight out", "A light that should be on"],
    ["poorly_lit", "Poorly lit", "Dark stretch"],
    ["blocked", "Path blocked", "Closed or obstructed"],
    ["flooded", "Flooded", "Water on the path"],
    ["felt_unsafe", "Felt unsafe here", "About the place, not people"],
  ];
  function openReport({ route, segment }) {
    const target = segment ? (segment.name === "unnamed path" ? "this path" : segment.name) : `the ${LABELS[route.label].toLowerCase()} route`;
    openModal("Report a problem",
      `<p class="lead">About ${esc(target)}. Choose what you noticed.</p>` +
      `<div class="cat-grid">${REPORT_CATS.map(([id, label, sub]) => `<button class="cat" data-cat="${id}">${label}<small>${sub}</small></button>`).join("")}</div>` +
      `<p class="tiny" style="margin-top:14px">In this pilot, reports are saved on your phone only. For crime, call 101, or 999 in an emergency.</p>`,
      (body) => body.querySelectorAll(".cat").forEach((b) => b.addEventListener("click", () => {
        const cat = b.dataset.cat;
        const list = store.get("odyssey_reports", []);
        list.push({ ts: new Date().toISOString(), category: cat, segment_ids: segment ? [segment.id] : route.route.segments.map((x) => x.id) });
        store.set("odyssey_reports", list);
        closeModal();
        vibrate(14);
        if (cat === "streetlight_out") toast("Saved. Tell the council so they can fix it.", "Report fault",
          () => window.open("https://lightsoninsouthampton.co.uk/Public/Default.aspx", "_blank", "noopener"));
        else if (cat === "felt_unsafe") toast("Saved. You can also tell the police anonymously.", "StreetSafe",
          () => window.open("https://www.police.uk/streetsafe", "_blank", "noopener"));
        else toast("Saved on this phone. Thanks for reporting.");
      })));
  }

  /* ---------------------------------------------------------------- tonight */
  let live = null;
  // Near spring high water at Woolston (roughly +1.8 m above datum) waterside
  // paths can be splashed or closed, so above this level routes avoid them.
  const TIDE_HIGH_M = 1.5;
  function waterAvoid() {
    return !!(live && live.ok && (live.warnings.length || live.level >= TIDE_HIGH_M));
  }
  async function refreshLive() {
    try {
      const r = await fetch(`https://environment.data.gov.uk/flood-monitoring/id/stations/${EA_TIDE_GAUGE}/readings?latest`).then((x) => x.json());
      const it = r.items[0];
      // only warnings whose area is within 15 km of the city
      const fw = await fetch(`${EA_BASE}/id/floods?lat=50.91&long=-1.40&dist=15`).then((x) => x.json());
      live = { ok: true, level: it.value, time: new Date(it.dateTime), warnings: fw.items || [] };
    } catch (e) {
      const snap = liveSnapshot && liveSnapshot.tide_gauge;
      live = { ok: false, snapshot: snap && snap.value != null ? snap : null };
    }
    const dot = $("live-dot");
    dot.className = "live-dot" + (live.ok ? (waterAvoid() ? " alert" : " on") : "");
    $("tonight-label").textContent = live.ok
      ? (live.warnings.length ? `${live.warnings.length} flood warning${live.warnings.length > 1 ? "s" : ""}`
        : waterAvoid() ? `High tide · ${live.level.toFixed(1)} m` : `Live · Tide ${live.level.toFixed(1)} m`)
      : "Tonight";
  }
  refreshLive();
  setInterval(refreshLive, 10 * 60 * 1000);

  function openTonight() {
    const t = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const liveRows = live && live.ok
      ? [["Tide at Woolston", `${live.level.toFixed(2)} m above datum, at ${t(live.time)}`, "Environment Agency, live"],
        ["Flood warnings", live.warnings.length ? live.warnings.map((w) => esc(w.description || w.severity)).join("<br>") : "None active within 15 km of Southampton", "Environment Agency, live"],
        ["Effect on your routes", waterAvoid() ? "Routes are keeping off waterside paths right now." : `Routes keep off waterside paths when the tide is above ${TIDE_HIGH_M} m or a flood warning is active nearby. Neither applies right now.`, "Odyssey"]]
      : [["Live data", (live && live.snapshot ? `Offline. Last tide reading ${live.snapshot.value} m at ${live.snapshot.reading_time.slice(11, 16)} UTC when the data was built.` : "Offline. Live tide and flood data unavailable.") +
          " Routes can’t adjust for the tide, so take care on waterside paths.", "Environment Agency"]];
    const ev = model && model.evaluation;
    const sources = manifest ? manifest.sources.map((s) => [esc(s.name), `Updated ${(s.fetched_at || "").slice(0, 10)}`, s.licence]) : [];
    openModal("Tonight in Southampton",
      factsHTML(liveRows) +
      `<h3 class="section">How ratings are made</h3>` +
      factsHTML([
        ev ? ["Crime model", `Ranks paths by predicted reported street crime. On a month it never saw, it scored ${ev.auc_model} AUC. ` +
          (ev.auc_baseline_two_month_rule ? `A simple rule (crimes in the last two months, then path length) scores ${ev.auc_baseline_two_month_rule}, so recent crime does most of the work. ` +
          `The model matters most on the ${Math.round(ev.share_scored_with_no_recent_crime * 100)}% of paths with no crime in the last two months, where history alone can’t rank them: it scores ${ev.auc_model_no_recent_crime} there.` : ""),
          `Logistic regression on ${crimeCount ? crimeCount.toLocaleString() + " " : ""}Police UK records${crimePeriod ? ", " + crimePeriod : ""}`] : null,
        ["What we don’t know", `${noLightPct}% of the walking network has no lighting record, and ${noCrimePct}% is outside the 12 areas police crime data was fetched for. Those paths are shown as risk unknown and never scored.`, "OpenStreetMap, Police UK"],
        ["Time of night", "Police data has no time of day, so night-time effects come from lighting and isolation, not from crime timing.", "Model card"],
      ]) +
      (model && model.known_limitations ? `<details style="margin-top:6px"><summary class="small" style="cursor:pointer;padding:8px 0">All known limitations</summary>` +
        `<ul class="small" style="padding-left:18px">${model.known_limitations.map((l) => `<li style="margin-bottom:6px">${esc(l)}</li>`).join("")}</ul></details>` : "") +
      `<h3 class="section">Data sources</h3>` + factsHTML(sources));
  }
  $("btn-tonight").addEventListener("click", openTonight);

  /* iOS/Android settings-style grouped list */
  function groupHTML(rows) {
    return `<div class="group">${rows.map((r) => {
      const tag = r.href ? "a" : "button";
      const attrs = r.href ? `href="${r.href}" ${r.href.startsWith("tel:") ? "" : 'target="_blank" rel="noopener"'}` : `id="${r.id}"`;
      return `<${tag} class="g-row" ${attrs}><span class="g-icon ${r.tone || ""}"><svg><use href="#${r.icon}"/></svg></span>` +
        `<span class="g-text"><span class="g-title">${r.title}</span>${r.sub ? `<span class="g-sub">${r.sub}</span>` : ""}</span>` +
        `<svg class="g-chev"><use href="#i-chevron"/></svg></${tag}>`;
    }).join("")}</div>`;
  }

  /* ---------------------------------------------------------------- help */
  function openHelp() {
    openModal("SOS",
      `<button class="sos" id="h-999"><span class="sos-ring"><svg><use href="#i-phone"/></svg></span><span><b>Call 999</b><small>Emergency services</small></span></button>` +
      `<h3 class="section">Get help</h3>` +
      groupHTML([
        { href: "tel:101", icon: "i-phone", title: "Call 101", sub: "Police non-emergency" },
        { id: "h-share", icon: "i-share", title: "Share my location", sub: "Send a map link to someone" },
        { href: "https://www.safeplaces.org.uk/apps/", icon: "i-pin", title: "Find a Safe Place", sub: "Official Safe Places app", tone: "blue" },
      ]) +
      `<p class="small" id="h-msg" style="margin:8px 4px 0"></p>` +
      `<h3 class="section">Report and learn</h3>` +
      groupHTML([
        { href: "https://www.police.uk/streetsafe", icon: "i-flag", title: "StreetSafe", sub: "Tell police where you feel unsafe, anonymously" },
        { href: "https://www.gov.uk/contact-999", icon: "i-info", title: "When to call 999", sub: "GOV.UK" },
        { href: "https://www.suzylamplugh.org/pages/categories?category=safety-advice", icon: "i-book", title: "Personal safety advice", sub: "Suzy Lamplugh Trust" },
        { href: "https://www.southampton.gov.uk/council-democracy/community-safety/community-safety-team/", icon: "i-shield", title: "Southampton community safety", sub: "Southampton City Council" },
      ]) +
      `<p class="tiny" style="margin:14px 4px 0">Odyssey compares routes using public data. It doesn’t track you, contact anyone for you, or send help.</p>`,
      (body) => {
        body.querySelector("#h-999").addEventListener("click", () => {
          if (confirm("Call 999 now?")) window.location.href = "tel:999";
        });
        body.querySelector("#h-share").addEventListener("click", () => shareMyLocation(body.querySelector("#h-msg")));
      });
  }
  $("btn-help").addEventListener("click", openHelp);

  /* ---------------------------------------------------------------- preferences */
  function prefsFormHTML(p) {
    const cov = (manifest && manifest.coverage) || {};
    const covTxt = (v) => typeof v === "number" ? `Data for about ${Math.round(v)}% of paths` : "";
    const row = (id, label, sub, on) =>
      `<label class="switch-row"><span class="row-text"><span class="row-title" style="white-space:normal">${label}</span>` +
      `<span class="row-sub" style="white-space:normal">${sub}</span></span>` +
      `<span class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><span></span></span></label>`;
    return row("pref-lit", "Prefer well-lit streets", covTxt(cov.lighting_known_pct), p.well_lit) +
      row("pref-stairs", "Avoid stairs", `${cov.steps_segments ?? 0} mapped stairways`, p.avoid_stairs) +
      row("pref-steep", "Avoid steep slopes", `${covTxt(cov.incline_known_pct)}. Unmapped slopes aren’t penalised.`, p.avoid_steep) +
      row("pref-sheltered", "Prefer sheltered paths", `${covTxt(cov.sheltered_known_pct)}. Unmapped cover isn’t penalised.`, p.sheltered) +
      `<div style="padding:14px 0 4px"><p class="row-title">Path surface</p><p class="row-sub">${covTxt(cov.surface_known_pct)}</p>` +
      `<div class="segmented" role="radiogroup" aria-label="Path surface">${[["paved", "Paved only"], ["mixed", "Mostly paved"], ["any", "Any"]].map(([v, l]) =>
        `<label><input type="radio" name="terrain" value="${v}" ${p.terrain === v ? "checked" : ""}><span>${l}</span></label>`).join("")}</div></div>` +
      `<div style="padding:14px 0 4px"><p class="row-title">Parks and woods</p><p class="row-sub" style="white-space:normal">Footpaths through parks, woods and commons. Roads across them aren’t affected.</p>` +
      `<div class="segmented" role="radiogroup" aria-label="Parks and woods">${[["avoid", "Avoid"], ["reduce", "If much shorter"], ["any", "Don’t mind"]].map(([v, l]) =>
        `<label><input type="radio" name="green" value="${v}" ${(p.green || "reduce") === v ? "checked" : ""}><span>${l}</span></label>`).join("")}</div></div>` +
      rideFormHTML();
  }
  function rideFormHTML() {
    const rs = rideSettings();
    const opt = (name, list, cur) => `<div class="segmented${list.length > 3 ? " two-rows" : ""}" role="radiogroup">${list.map(([v, l]) =>
      `<label><input type="radio" name="${name}" value="${v}" ${String(cur) === String(v) ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>`;
    return `<div style="padding:18px 0 4px"><p class="row-title">Suggest a ride</p><p class="row-sub">Shows Uber and Bolt under your routes.</p>` +
      opt("ride-mode", [["long", "Long walks"], ["long_or_risky", "Long or risky"], ["risky", "Risky only"], ["off", "Never"]], rs.mode) +
      `<p class="row-sub" style="margin-top:12px">A long walk is over</p>` +
      opt("ride-min", [[15, "15 min"], [20, "20 min"], [30, "30 min"], [45, "45 min"]], rs.minutes) + `</div>`;
  }
  function saveRide(root) {
    const m = root.querySelector("input[name=ride-mode]:checked"), n = root.querySelector("input[name=ride-min]:checked");
    store.set("odyssey_ride", { mode: m ? m.value : RIDE_DEFAULT.mode, minutes: n ? +n.value : RIDE_DEFAULT.minutes });
  }
  function readPrefs(root) {
    return {
      well_lit: root.querySelector("#pref-lit").checked,
      avoid_stairs: root.querySelector("#pref-stairs").checked,
      avoid_steep: root.querySelector("#pref-steep").checked,
      sheltered: root.querySelector("#pref-sheltered").checked,
      terrain: (root.querySelector("input[name=terrain]:checked") || {}).value || "mixed",
      green: (root.querySelector("input[name=green]:checked") || {}).value || "reduce",
    };
  }
  function openPrefs() {
    openModal("Preferences",
      `<p class="lead">These change which route Athena picks. They never change the crime risk shown.</p>` + prefsFormHTML(loadPrefs()) +
      `<button class="btn primary block" id="prefs-save" style="margin-top:16px">Save preferences</button>`,
      (body) => body.querySelector("#prefs-save").addEventListener("click", () => {
        store.set("odyssey_prefs", readPrefs(body));
        saveRide(body);
        closeModal();
        toast("Preferences saved.");
        if (lastResults) plan();
      }));
  }

  /* ---------------------------------------------------------------- about */
  let installEvent = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; });
  function openAbout() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const ev = model && model.evaluation;
    openModal("Odyssey",
      `<div class="about-hero"><svg class="about-logo"><use href="#logo"/></svg><div><p class="about-name">Odyssey</p>` +
      `<p class="small">Night walking routes for Southampton</p></div></div>` +
      (!standalone && (installEvent || ios) ? groupHTML([{ id: "a-install", icon: "i-download", title: "Add to Home Screen", sub: ios ? "In Safari: Share, then Add to Home Screen" : "Opens full-screen and works offline", tone: "accent" }]) : "") +
      `<h3 class="section">Settings</h3>` +
      groupHTML([
        { id: "a-prefs", icon: "i-sliders", title: "Preferences", sub: "Lighting, parks, stairs, ride suggestions" },
        { id: "a-welcome", icon: "i-replay", title: "Show the introduction", sub: "How to read the map" },
      ]) +
      `<h3 class="section">How it works</h3>` +
      groupHTML([
        { id: "a-tonight", icon: "i-info", title: "Data and ratings", sub: "How the crime model works, and its limits" },
        { id: "a-privacy", icon: "i-lock", title: "Privacy", sub: "No accounts, no tracking" },
      ]) +
      `<p class="tiny" style="margin:16px 4px 0;line-height:1.6">Map data © OpenStreetMap contributors (ODbL). Crime data: Police UK (OGL v3). ` +
      `Tide and flood data: Environment Agency (OGL v3). Map library: Leaflet.</p>`,
      (body) => {
        const ins = body.querySelector("#a-install");
        if (ins) ins.addEventListener("click", async () => {
          if (installEvent) { installEvent.prompt(); await installEvent.userChoice; installEvent = null; closeModal(); }
          else toast("In Safari, tap Share, then Add to Home Screen.");
        });
        body.querySelector("#a-prefs").addEventListener("click", openPrefs);
        body.querySelector("#a-tonight").addEventListener("click", openTonight);
        body.querySelector("#a-welcome").addEventListener("click", () => { closeModal(); startWelcome(); });
        body.querySelector("#a-privacy").addEventListener("click", () => openModal("Privacy",
          `<p class="lead">Odyssey is built to know as little about you as possible.</p>` +
          groupHTML([
            { id: "p1", icon: "i-lock", title: "No accounts", sub: "Nothing to sign up for" },
            { id: "p2", icon: "i-locate", title: "Location stays on your phone", sub: "Used only to plan the route you asked for" },
            { id: "p3", icon: "i-search", title: "Place search", sub: "Sent to OpenStreetMap’s search service" },
            { id: "p4", icon: "i-flag", title: "Reports and preferences", sub: "Saved on this phone only" },
          ]).replace(/<svg class="g-chev">.*?<\/svg>/g, "")));
      });
  }
  $("btn-menu").addEventListener("click", openAbout);

  /* ---------------------------------------------------------------- welcome */
  const WELCOME = [
    () => `<h2 id="welcome-title">Choose your way home after dark</h2>` +
      `<p class="w-body">Odyssey compares walking routes across Southampton using real police records, street lighting data and live tide information, and shows you why each route is rated the way it is.</p>` +
      `<svg class="w-art" viewBox="0 0 360 190" role="img" aria-label="Two routes across a dark map: a shorter one through a red, higher-risk stretch and a lower-risk one in green">      <rect width="360" height="190" rx="22" fill="#17233A"/>      <path d="M0 140 C60 120 90 160 160 150 S280 110 360 130" stroke="#0d1d33" stroke-width="26" fill="none"/>      <g stroke="#2C3D5E" stroke-width="2" fill="none" opacity=".9"><path d="M30 20 L90 180M140 0 L120 190M230 10 L250 190M300 0 L330 190M0 60 H360M0 100 H360"/></g>      <path d="M48 160 C90 120 120 110 150 92 S220 60 300 36" stroke="#F87171" stroke-width="6" fill="none" stroke-dasharray="2 10" stroke-linecap="round" opacity=".9"/>      <path d="M48 160 C70 150 100 150 120 130 S170 80 210 78 S270 60 300 36" stroke="#06101F" stroke-width="12" fill="none" stroke-linecap="round"/>      <path d="M48 160 C70 150 100 150 120 130" stroke="#34D399" stroke-width="7" fill="none" stroke-linecap="round"/>      <path d="M120 130 C150 100 170 80 210 78" stroke="#FBBF24" stroke-width="7" fill="none" stroke-linecap="round"/>      <path d="M210 78 C240 76 270 60 300 36" stroke="#34D399" stroke-width="7" fill="none" stroke-linecap="round"/>      <circle cx="48" cy="160" r="9" fill="#A5B4FC" stroke="#0E1726" stroke-width="3"/>      <circle cx="300" cy="36" r="9" fill="#EEF2F8" stroke="#0E1726" stroke-width="3"/>      <circle cx="180" cy="128" r="6" fill="#7DD3FC" stroke="#0E1726" stroke-width="2"/>    </svg>`,
    () => `<h2 id="welcome-title">How to read the map</h2><div class="w-points">` +
      `<div class="w-point"><i class="sw low"></i><div><b>Lower risk</b><span>Fewer recorded problems nearby</span></div></div>` +
      `<div class="w-point"><i class="sw medium"></i><div><b>Medium risk</b></div></div>` +
      `<div class="w-point"><i class="sw high"></i><div><b>Higher risk</b><span>The top 10% of paths for predicted reported crime</span></div></div>` +
      `<div class="w-point"><i class="sw unknown"></i><div><b>Unknown</b><span>No lighting record, or outside the area police crime data covers. We show it rather than guess: that’s ${unknownPct}% of paths.</span></div></div></div>`,
    () => `<h2 id="welcome-title">What it can and can’t do</h2>` +
      `<p class="w-body">It compares routes using public data. It can’t promise any route is safe, it doesn’t track you, and it can’t call for help. In an emergency, call 999.</p>`,
    () => `<h2 id="welcome-title">Your route preferences</h2><p class="w-body" style="margin-bottom:6px">You can change these any time.</p>` + prefsFormHTML(loadPrefs()),
  ];
  let wStep = 0;
  function renderWelcome() {
    $("welcome-step").innerHTML = WELCOME[wStep]();
    $("welcome-dots").innerHTML = WELCOME.map((_, i) => `<i class="${i === wStep ? "on" : ""}"></i>`).join("");
    $("welcome-back").classList.toggle("hidden", wStep === 0);
    $("welcome-skip").classList.toggle("hidden", wStep >= 2);
    const next = $("welcome-next");
    next.textContent = wStep === WELCOME.length - 1 ? "Start using Odyssey" : "Continue";
  }
  function startWelcome() { wStep = 0; $("welcome").classList.remove("hidden"); renderWelcome(); }
  $("welcome-next").addEventListener("click", () => {
    if (wStep === WELCOME.length - 1) {
      store.set("odyssey_prefs", readPrefs($("welcome-step")));
      saveRide($("welcome-step"));
      store.set("odyssey_welcomed", true);
      $("welcome").classList.add("hidden");
      return;
    }
    wStep++;
    renderWelcome();
  });
  $("welcome-back").addEventListener("click", () => { wStep = Math.max(0, wStep - 1); renderWelcome(); });
  // Skip still shows the "what it can and can't do" screen, so everyone sees it once
  $("welcome-skip").addEventListener("click", () => { wStep = Math.max(wStep, 2); renderWelcome(); });

  /* ---------------------------------------------------------------- start */
  if (/[?&]debug\b/.test(location.search)) window.__odyssey = { openRoadPeek, rideReason, renderRide, get last() { return lastResults; }, openSegment, openTonight, openHelp, openAbout, openPrefs, map, walkable };
  renderPlanView();
  showView("plan");
  setSheet("peek", false);
  $("splash").classList.add("done");
  setTimeout(() => $("splash").classList.add("hidden"), 400);
  if (!store.get("odyssey_welcomed", false)) startWelcome();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    // check for a new version every time the app opens; when one takes over, reload once
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded && !walkState) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update()).catch(() => { /* offline support is optional */ });
  }
})();
