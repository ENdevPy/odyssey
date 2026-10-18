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
  const LABELS = { Safest: "Safest", Balanced: "Balanced", Shortest: "Shortest" };
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

  const graph = buildGraph(segments);
  const walkable = segments.filter((s) => s.highway_type !== "service" && s.length_m >= 10);
  const counts = { low: 0, medium: 0, high: 0, unknown: 0 };
  walkable.forEach((s) => counts[s.risk_band]++);
  const unknownPct = Math.round((counts.unknown / walkable.length) * 100);
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
      openSegment(s);
    }).addTo(map);
  }
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
      `<p>of Southampton’s ${total.toLocaleString()} walking paths have no lighting record. ` +
      `Odyssey shows them as “risk unknown” instead of guessing.</p>` +
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
    if (focus) setTimeout(() => $("dest").focus(), 280);
  }
  function closeSearch() {
    $("dest").blur();
    showView(lastResults ? "results" : "plan");
    setSheet(lastResults ? "half" : "peek");
  }
  $("open-search").addEventListener("click", () => openSearch());
  $("search-close").addEventListener("click", closeSearch);

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
      (q && !suggestions.length ? `<p class="small" style="padding:14px 4px">No matches yet. Keep typing a street, place or postcode.</p>` : "");
    $("suggestions").querySelectorAll(".row[data-i]").forEach((b) =>
      b.addEventListener("click", () => chooseDestination(suggestions[+b.dataset.i])));
    const pickBtn = $("suggestions").querySelector('[data-act="pick-to"]');
    if (pickBtn) pickBtn.addEventListener("click", () => startPick("to"));
  }
  $("dest").addEventListener("input", () => {
    const q = $("dest").value.trim();
    renderSuggestions(q);
    clearTimeout(searchTimer);
    if (searchCtrl) searchCtrl.abort();
    if (q.length < 3) { $("search-status").textContent = ""; return; }
    searchTimer = setTimeout(async () => {
      searchCtrl = new AbortController();
      $("search-status").className = "status";
      $("search-status").textContent = "Searching…";
      try {
        const url = `${NOMINATIM}?format=jsonv2&limit=6&accept-language=en&countrycodes=gb&viewbox=${VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { signal: searchCtrl.signal }).then((x) => x.json());
        const remote = (Array.isArray(r) ? r : []).map((x) => {
          const parts = (x.display_name || "").split(",").map((t) => t.trim());
          return { name: parts[0], sub: parts.slice(1, 3).join(", "), ll: [+x.lat, +x.lon], remote: true };
        });
        $("search-status").textContent = "";
        if ($("dest").value.trim() === q) renderSuggestions(q, remote);
      } catch (e) {
        if (e.name === "AbortError") return;
        $("search-status").className = "status warn";
        $("search-status").textContent = "Place search needs a connection. Popular places and the map still work.";
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
      const p = suggestions[Math.max(0, activeIdx)];
      if (p) chooseDestination(p);
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
    plan();
  }

  /* ---------------------------------------------------------------- planning */
  let routeLayers = [], lastResults = null, selected = 0, pins = [];

  async function plan() {
    if (!to) return;
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
      showView("search"); setSheet("full");
      $("search-status").className = "status warn";
      $("search-status").textContent = a.dist > 400
        ? "Your start is outside the area Odyssey has evidence for. Choose a start point in Southampton."
        : "That destination is outside the area Odyssey has evidence for. Odyssey covers Southampton.";
      return;
    }
    const prefs = loadPrefs();
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
      showView("search"); setSheet("full");
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
    }
    const shortestR = uniq.find((x) => x.label === "Shortest") || (triad.shortest ? { route: triad.shortest } : null);
    for (const r of uniq) r.gmaps = gmapsLink(r, shortestR);
    for (const r of uniq) r.bullets = bulletsFor(r, uniq);
    lastResults = { uniq, fromLL, toLL: to.ll, fromName: from.name, toName: to.name };
    renderResults();
    vibrate(12);
  }

  /* Google Maps handoff with as few stops as possible.
   * Every waypoint in a Google Maps link shows up as a "stop", so we add one
   * only where this route goes a different way from the shortest route (that's
   * where Google would otherwise take its own, shorter path). At most
   * MAX_STOPS, each well away from the start, the end and each other.
   * The shortest route itself needs no stops. Set MAX_STOPS to 0 for none. */
  const MAX_STOPS = 2;
  function gmapsLink(r, shortest) {
    const steps = r.route.steps;
    const ll = (c) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
    const start = graph.nodes.get(steps[0].from).c;
    const end = graph.nodes.get(steps[steps.length - 1].to).c;
    const q = new URLSearchParams({ api: 1, origin: ll(start), destination: ll(end), travelmode: "walking" });
    if (MAX_STOPS > 0 && shortest && shortest.route !== r.route) {
      const onShortest = new Set(shortest.route.segments.map((x) => x.id));
      const runs = [];
      let cur = null;
      for (const st of steps) {
        if (!onShortest.has(st.seg)) {
          if (!cur) { cur = { steps: [], m: 0 }; runs.push(cur); }
          cur.steps.push(st); cur.m += st.len;
        } else cur = null;
      }
      const picks = [];
      for (const run of runs.filter((x) => x.m >= 80).sort((a, b) => b.m - a.m)) {
        if (picks.length >= MAX_STOPS) break;
        // the point halfway along this different stretch
        let acc = 0, mid = run.steps[0];
        for (const st of run.steps) { acc += st.len; if (acc >= run.m / 2) { mid = st; break; } }
        const c = graph.nodes.get(mid.to).c;
        const farEnough = distM(c, start) > 150 && distM(c, end) > 150 && picks.every((p) => distM(p.c, c) > 250);
        if (farEnough) picks.push({ c, at: steps.indexOf(mid) });
      }
      if (picks.length) q.set("waypoints", picks.sort((a, b) => a.at - b.at).map((p) => ll(p.c)).join("|"));
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
      if (avoided) out.push(["i-check", avoided.lighting === "no" ? "Avoids an unlit path" : avoided.risk_band === "unknown" ? "Avoids a path with no lighting data" : "Avoids a higher-risk path", "good"]);
    }
    if (r.note) out.push(["i-check", "Best option within a 12 min detour", "good"]);
    const crimes = r.route.segments.reduce((t, x) => t + (x.crime_count_90d || 0), 0);
    out.push(crimes ? ["i-alert", `${crimes} street crime${crimes > 1 ? "s" : ""} nearby (3 months)`, crimes >= 20 ? "bad" : ""]
      : ["i-check", "No recent street crime recorded", "good"]);
    if (r.stats.unknownCount) out.push(["i-bulb", `${r.stats.unknownCount} stretch${r.stats.unknownCount > 1 ? "es" : ""} with no lighting data`, "unk"]);
    const haven = havens.find((h) => /24\/7/.test(h.hours) && r.coords.some((c) => distM(c, [h.lat, h.lng]) < 150));
    if (haven) out.push(["i-shield", "Passes a 24/7 staffed place", "good"]);
    if (r.route.segments.some((x) => x.tide_exposed)) out.push(["i-wave", "Includes a waterside path", ""]);
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
      return m >= 20 ? `${Math.round(m)} metres ${b === "unknown" ? "with no lighting data" : b + " risk"}` : "";
    }).filter(Boolean).join(", ");
    return `<div class="ribbon" role="img" aria-label="Route from start to destination: ${summary || "all low risk"}">` +
      merged.map((x) => `<span class="r-${x.band}" style="flex:${x.m}"></span>`).join("") +
      `</div><div class="ribbon-ends"><span>Start</span><span>Destination</span></div>`;
  }

  function renderResults() {
    const { uniq, fromName, toName } = lastResults;
    $("results-to").textContent = toName;
    $("results-from").textContent = `From ${fromName}`;
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
        `</div></article>`;
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
    cards.querySelectorAll("[data-go]").forEach((a) => a.addEventListener("click", () => vibrate(10)));
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
      if (i === selected) return;
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
    uniq.forEach((x, i) => {
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
    const unknownM = r.legs.filter((l) => l.band === "unknown").reduce((t, l) => t + l.m, 0);
    const highM = r.legs.filter((l) => l.band === "high").reduce((t, l) => t + l.m, 0);
    const passed = havens.filter((h) => r.coords.some((c) => distM(c, [h.lat, h.lng]) < 150));
    const named = [...new Set(segs.map((s) => s.name).filter((n) => n && n !== "unnamed path"))].slice(0, 4);
    const rows = [
      ["Along this route", named.length ? `Via ${named.join(", ")}` : "Mostly unnamed paths", "OpenStreetMap"],
      ["Reported street crime nearby", crimes ? `${crimes} in the last 3 months on the paths this route uses` : "None recorded on these paths in the last 3 months",
        `Police UK, locations approximate${crimePeriod ? ", " + crimePeriod : ""}`],
      ["Higher-risk stretches", highM >= 10 ? `${Math.round(highM)} m` : "None", "Athena model"],
      ["Lighting data", unknownM >= 10 ? `Unknown for ${Math.round(unknownM)} m of the walk` : "Known for the whole walk", "OpenStreetMap lit tags"],
      ["Staffed places passed", passed.length ? passed.map((h) => `${h.name} (${h.hours})`).join("; ") : "None within 150 m", "Hand-checked list, hours may change"],
    ];
    $("route-detail").innerHTML =
      (unknownM >= 30 ? `<div class="notice">Lighting data unavailable for ${Math.round(unknownM)} m of this walk, so risk is unknown there.</div>` : "") +
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
      (s.risk_band === "unknown" ? `<div class="notice">Lighting data unavailable, so Odyssey doesn’t score this path. Routes prefer an alternative where one exists.</div>` : "") +
      factsHTML([
        s.risk_score != null ? ["Model estimate", `${Math.round(s.risk_score * 100)}% chance of at least one reported street crime nearby in a month`, "Athena model trained on Police UK records"] : null,
        ["Lighting", esc(lighting), "OpenStreetMap"],
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
  async function refreshLive() {
    try {
      const r = await fetch(`https://environment.data.gov.uk/flood-monitoring/id/stations/${EA_TIDE_GAUGE}/readings?latest`).then((x) => x.json());
      const it = r.items[0];
      const fw = await fetch("https://environment.data.gov.uk/flood-monitoring/id/floods").then((x) => x.json());
      const hants = (fw.items || []).filter((i) => ["Hampshire", "Southampton"].includes(i.countyName || ""));
      live = { ok: true, level: it.value, time: new Date(it.dateTime), warnings: hants };
    } catch (e) {
      const snap = liveSnapshot && liveSnapshot.tide_gauge;
      live = { ok: false, snapshot: snap && snap.value != null ? snap : null };
    }
    const dot = $("live-dot");
    dot.className = "live-dot" + (live.ok ? (live.warnings.length ? " alert" : " on") : "");
    $("tonight-label").textContent = live.ok
      ? (live.warnings.length ? `${live.warnings.length} flood warning${live.warnings.length > 1 ? "s" : ""}` : `Live · Tide ${live.level.toFixed(1)} m`)
      : "Tonight";
  }
  refreshLive();
  setInterval(refreshLive, 10 * 60 * 1000);

  function openTonight() {
    const t = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const liveRows = live && live.ok
      ? [["Tide at Woolston", `${live.level.toFixed(2)} m above datum, at ${t(live.time)}`, "Environment Agency, live"],
        ["Flood warnings", live.warnings.length ? live.warnings.map((w) => esc(w.description || w.severity)).join("<br>") : "None active in Hampshire", "Environment Agency, live"]]
      : [["Live data", live && live.snapshot ? `Offline. Last tide reading ${live.snapshot.value} m at ${live.snapshot.reading_time.slice(11, 16)} UTC when the data was built.` : "Offline. Live tide and flood data unavailable.", "Environment Agency"]];
    const ev = model && model.evaluation;
    const sources = manifest ? manifest.sources.map((s) => [esc(s.name), `Updated ${(s.fetched_at || "").slice(0, 10)}`, s.licence]) : [];
    openModal("Tonight in Southampton",
      factsHTML(liveRows) +
      `<h3 class="section">How ratings are made</h3>` +
      factsHTML([
        ev ? ["Crime model", `Ranks paths by predicted reported street crime. On a month it never saw, it scored ${ev.auc_model} AUC, against ${ev.auc_baseline_recent_crime} for simply using last month’s crime.`,
          `Logistic regression on ${crimeCount ? crimeCount.toLocaleString() + " " : ""}Police UK records${crimePeriod ? ", " + crimePeriod : ""}`] : null,
        ["What we don’t know", `${unknownPct}% of walking paths have no lighting record, so they’re shown as risk unknown and never scored.`, "OpenStreetMap"],
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
    openModal("Help",
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
        body.querySelector("#h-share").addEventListener("click", async () => {
          const msg = body.querySelector("#h-msg");
          msg.textContent = "Finding your location…";
          try {
            const ll = await getPosition();
            const url = `https://www.google.com/maps?q=${ll[0].toFixed(5)},${ll[1].toFixed(5)}`;
            if (navigator.share) { await navigator.share({ title: "My location", text: "This is where I am:", url }); msg.textContent = ""; }
            else { await navigator.clipboard.writeText(url); msg.textContent = "Location link copied. Paste it into a message."; }
          } catch (e) { msg.textContent = e.message || "Couldn’t share your location."; }
        });
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
        `<label><input type="radio" name="terrain" value="${v}" ${p.terrain === v ? "checked" : ""}><span>${l}</span></label>`).join("")}</div></div>`;
  }
  function readPrefs(root) {
    return {
      well_lit: root.querySelector("#pref-lit").checked,
      avoid_stairs: root.querySelector("#pref-stairs").checked,
      avoid_steep: root.querySelector("#pref-steep").checked,
      sheltered: root.querySelector("#pref-sheltered").checked,
      terrain: (root.querySelector("input[name=terrain]:checked") || {}).value || "mixed",
    };
  }
  function openPrefs() {
    openModal("Route preferences",
      `<p class="lead">These change which route Athena picks. They never change the crime risk shown.</p>` + prefsFormHTML(loadPrefs()) +
      `<button class="btn primary block" id="prefs-save" style="margin-top:16px">Save preferences</button>`,
      (body) => body.querySelector("#prefs-save").addEventListener("click", () => {
        store.set("odyssey_prefs", readPrefs(body));
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
        { id: "a-prefs", icon: "i-sliders", title: "Route preferences", sub: "Lighting, stairs, slopes, surface" },
        { id: "a-welcome", icon: "i-replay", title: "Show the introduction", sub: "How to read the map" },
      ]) +
      `<h3 class="section">How it works</h3>` +
      groupHTML([
        { id: "a-tonight", icon: "i-info", title: "Data and ratings", sub: ev ? `Crime model AUC ${ev.auc_model} vs ${ev.auc_baseline_recent_crime} baseline` : "Sources and freshness" },
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
      `<div class="w-point"><i class="sw unknown"></i><div><b>Unknown</b><span>No lighting record. We show it rather than guess: that’s ${unknownPct}% of paths.</span></div></div></div>`,
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
  if (/[?&]debug\b/.test(location.search)) window.__odyssey = { openSegment, openTonight, openHelp, openAbout, openPrefs, map, walkable };
  renderPlanView();
  showView("plan");
  setSheet("peek", false);
  $("splash").classList.add("done");
  setTimeout(() => $("splash").classList.add("hidden"), 400);
  if (!store.get("odyssey_welcomed", false)) startWelcome();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline support is optional */ });
  }
})();
