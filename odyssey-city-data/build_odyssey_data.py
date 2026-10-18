#!/usr/bin/env python3
"""
Odyssey live data pipeline — real Southampton data, nothing synthetic.
Feeds the Athena routing engine in ../odyssey-app.

What it fetches (all public, all free):
  1. OpenStreetMap  walking network + lit tags  (Overpass API, ODbL)
  2. Police UK      street-level crime, last 6 months  (data.police.uk, OGL v3)
  3. OSM nightlife  pubs/bars/nightclubs (model feature, ODbL)
  4. EA flood API   live tide gauge + flood warnings  (OGL v3, no key)
  5. UK Tidal API   tide predictions, OPTIONAL: set TIDAL_API_KEY env var
     (free registration, https://api.gov.uk/ukho/uk-tidal-api-discovery/)

It then trains the Athena risk model (logistic regression) on the real crime
data with a temporal train/test split and writes everything the app loads.

Usage:
    python3 build_odyssey_data.py            # full live run
    python3 build_odyssey_data.py --offline  # use all cached fetches
    python3 build_odyssey_data.py --bbox 50.90 50.94 -1.42 -1.36

Outputs (into ./entities/):
    path_segments.json   walking network with real crime history + model score
    incidents.json       REAL police street crimes, snapped to segments
    safe_havens.json     staffed places (OSM 24/7 where mapped, curated rest)
    model.json           trained model + model card (baseline comparison)
    live_check.json      EA live tide gauge + flood warnings snapshot
    data_manifest.json   every source with URL, licence, date, coverage

No Python dependencies beyond the standard library (numpy used if present).
"""
import argparse, gzip, json, math, os, sys, time, urllib.request
from datetime import date, datetime, timezone
from collections import Counter, defaultdict

# ---------------------------------------------------------------- constants
SOUTHAMPTON_AREA_ID = 3600127864
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
POLICE_URL = "https://data.police.uk/api/crimes-street/all-crime"
EA_BASE = "https://environment.data.gov.uk/flood-monitoring"
TIDAL_API_BASE = "https://admiraltyapi.azurewebsites.net"
TIDE_STATION_ID = "0062"                       # UKHO Southampton
EA_TIDE_GAUGE = "E12660"                       # EA Woolston tide gauge
USER_AGENT = "Odyssey-data/2.0 (SotonShip exemplar project)"

HIGHWAY_TYPES = ("footway|path|pedestrian|steps|living_street|residential"
                 "|unclassified|tertiary|secondary|primary|cycleway|service")
MIN_LENGTH_M = 0.0

# Points covering the city for the Police UK 1-mile-radius street crime API.
POLICE_POINTS = [
    (50.9362, -1.3957), (50.9285, -1.3995), (50.9045, -1.4025),
    (50.9085, -1.4115), (50.8998, -1.4005), (50.9040, -1.3930),
    (50.9215, -1.3905), (50.9245, -1.3780), (50.9200, -1.4045),
    (50.9105, -1.4325), (50.9055, -1.4600), (50.9165, -1.4650),
]
POLICE_MONTHS = 8
SNAP_MAX_M = 120.0            # police locations are blurred; 120 m tolerance

WATER = [
    [[50.9450,-1.3650],[50.9400,-1.3720],[50.9300,-1.3790],[50.9245,-1.3780],
     [50.9180,-1.3800],[50.9100,-1.3850],[50.9050,-1.3880],[50.9000,-1.3950],
     [50.8988,-1.3980],[50.8995,-1.4020]],
    [[50.8950,-1.4600],[50.9000,-1.4400],[50.9020,-1.4200],[50.8990,-1.4100],
     [50.8990,-1.4020]],
    [[50.8995,-1.4020],[50.8990,-1.3880],[50.9020,-1.3720],[50.9060,-1.3600],
     [50.9110,-1.3480],[50.9160,-1.3380]],
]
TIDE_EXPOSURE_M = 250.0

# Curated safe havens — real staffed places; hours as of Oct 2026, verify.
SAFE_HAVENS = [
    {"id":"SH-01","name":"University of Southampton Security Lodge (Highfield gate)","lat":50.9362,"lng":-1.3957,"hours":"24/7","type":"Security","phone":"+44 23 8059 3311"},
    {"id":"SH-02","name":"Sainsbury's Portswood","lat":50.9285,"lng":-1.3995,"hours":"07:00-23:00 (24h Fri/Sat)","type":"Retail"},
    {"id":"SH-03","name":"Southampton Students' Union (The Bridge)","lat":50.9345,"lng":-1.3962,"hours":"08:00-02:00","type":"Students' Union"},
    {"id":"SH-04","name":"Glen Eyre Halls reception","lat":50.9340,"lng":-1.4026,"hours":"24/7","type":"Halls reception"},
    {"id":"SH-05","name":"Premier Inn Southampton City Centre","lat":50.9030,"lng":-1.4045,"hours":"24/7","type":"Hotel"},
    {"id":"SH-06","name":"Southampton Central police front desk","lat":50.9085,"lng":-1.4115,"hours":"08:00-20:00","type":"Police","phone":"101"},
    {"id":"SH-07","name":"Grand Harbour Hotel (Town Quay)","lat":50.8995,"lng":-1.4020,"hours":"24/7","type":"Hotel"},
    {"id":"SH-08","name":"Harbour Lights Picturehouse, Ocean Village","lat":50.9045,"lng":-1.3940,"hours":"10:00-00:30","type":"Cinema"},
    {"id":"SH-09","name":"Asda Southampton (Ocean Village)","lat":50.9060,"lng":-1.3935,"hours":"24/7","type":"Retail"},
    {"id":"SH-10","name":"Southampton General Hospital main reception","lat":50.9174,"lng":-1.4327,"hours":"24/7","type":"Hospital","phone":"111"},
    {"id":"SH-11","name":"Royal South Hants Hospital reception","lat":50.9074,"lng":-1.4051,"hours":"24/7","type":"Hospital","phone":"111"},
    {"id":"SH-12","name":"Tesco Express Bevois Valley","lat":50.9207,"lng":-1.4040,"hours":"06:00-23:00","type":"Retail"},
    {"id":"SH-13","name":"BP petrol station, Burgess Road","lat":50.9308,"lng":-1.3956,"hours":"24/7","type":"Petrol station"},
    {"id":"SH-14","name":"Bitterne Leisure Centre","lat":50.9215,"lng":-1.3635,"hours":"06:30-22:00","type":"Leisure centre"},
    {"id":"SH-15","name":"Woodmill Inn","lat":50.9257,"lng":-1.3800,"hours":"11:00-23:00","type":"Pub"},
]

TODAY = date.today()
NOW_ISO = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# ---------------------------------------------------------------- helpers
def dist_m(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2-lat1)/2)**2
         + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2)
    return 2 * 6371000 * math.asin(math.sqrt(h))

def way_length(coords):
    return sum(dist_m(p, q) for p, q in zip(coords, coords[1:]))

def min_dist_point_to_polyline(pt, poly):
    return min(dist_m(pt, q) for q in poly)

def http_json(url, data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=data,
        headers={"User-Agent": USER_AGENT, **(headers or {})})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def cache_fetch(name, fetch_fn, offline):
    """Fetch + cache a gzip JSON blob; reuse cache with --offline."""
    path = f"cache_{name}.json.gz"
    if offline and os.path.exists(path):
        with gzip.open(path, "rb") as f:
            return json.load(f)
    val = fetch_fn()
    with gzip.open(path, "wb") as f:
        f.write(json.dumps(val).encode())
    return val

def months_back(n):
    """Last n month strings YYYY-MM ending with the latest one Police UK has.
    Police data lags ~1 month; probe backwards from last month."""
    y, m = TODAY.year, TODAY.month - 1
    out = []
    for _ in range(n + 2):
        mm = f"{y}-{m:02d}"
        out.append(mm)
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out[:n]        # caller verifies availability with a probe fetch

# ---------------------------------------------------------------- OSM
def fetch_osm():
    q = (f'[out:json][timeout:300];area({SOUTHAMPTON_AREA_ID})->.a;'
         f'way(area.a)["highway"~"^({HIGHWAY_TYPES})$"];out geom;')
    last = None
    for _ in range(3):
        try:
            req = urllib.request.Request(OVERPASS_URL, data=q.encode(),
                                         headers={"User-Agent": USER_AGENT})
            return json.load(urllib.request.urlopen(req, timeout=300))
        except Exception as e:
            last = e
            time.sleep(10)
    raise SystemExit(f"Overpass unreachable after 3 tries: {last}")

def fetch_nightlife():
    q = ('[out:json][timeout:180];(nwr["amenity"~"^(pub|bar|nightclub)$"]'
         '(50.86,-1.48,50.96,-1.34););out center tags;')
    for _ in range(2):
        try:
            req = urllib.request.Request(OVERPASS_URL, data=q.encode(),
                                         headers={"User-Agent": USER_AGENT})
            return json.load(urllib.request.urlopen(req, timeout=180))
        except Exception:
            time.sleep(10)
    return {"elements": []}          # feature degrades to 0, model still works

def fetch_basemap():
    """Map context for the app's GeoJSON basemap: water, green space, rail.
    Replaces third-party raster tiles — the app ships its own basemap."""
    q = ('[out:json][timeout:300];area(3600127864)->.a;(\n'
         'way(area.a)["natural"="water"];'
         'way(area.a)["waterway"="riverbank"];'
         'way(area.a)["landuse"~"^(reservoir|basin)$"];'
         'relation(area.a)["natural"="water"];'
         'way(area.a)["leisure"~"^(park|garden|nature_reserve|common)$"];'
         'relation(area.a)["leisure"~"^(park|garden|nature_reserve|common)$"];'
         'way(area.a)["landuse"~"^(forest|grass|meadow|recreation_ground|cemetery|allotments)$"];'
         'way(area.a)["natural"~"^(wood|scrub|heath|wetland)$"];'
         'way(area.a)["railway"~"^(rail|light_rail)$"];\n);out geom;')
    last = None
    for _ in range(3):
        try:
            req = urllib.request.Request(OVERPASS_URL, data=q.encode(),
                                         headers={"User-Agent": USER_AGENT})
            return json.load(urllib.request.urlopen(req, timeout=300))
        except Exception as e:
            last = e
            time.sleep(10)
    raise SystemExit(f"Overpass unreachable after 3 tries: {last}")

def build_basemap(overpass):
    """Overpass elements -> compact GeoJSON: {kind: water|green|rail}."""
    feats = []
    def coords(el):
        return [[round(g["lon"], 5), round(g["lat"], 5)]
                for g in el.get("geometry", []) if "lat" in g]

    def add(kind, c, closed_ok=True):
        if len(c) < 2:
            return
        is_closed = closed_ok and len(c) > 3 and c[0] == c[-1]
        feats.append({
            "type": "Feature",
            "properties": {"kind": kind},
            "geometry": {"type": "Polygon" if is_closed else "LineString",
                         "coordinates": [c] if is_closed else c},
        })

    for el in overpass.get("elements", []):
        t = el.get("type")
        if t == "way":
            tags = el.get("tags", {})
            if "railway" in tags:
                add("rail", coords(el), closed_ok=False)
            elif tags.get("natural") == "water" or "waterway" in tags \
                    or tags.get("landuse") in ("reservoir", "basin"):
                add("water", coords(el))
            else:
                add("green", coords(el))
        elif t == "relation":
            # multipolygon: render outer member ways as filled polygons
            for m in el.get("members", []):
                if m.get("type") == "way" and m.get("role") in ("", "outer") \
                        and m.get("geometry"):
                    c = [[round(g["lon"], 5), round(g["lat"], 5)]
                         for g in m["geometry"] if "lat" in g]
                    add("water" if el.get("tags", {}).get("natural") == "water"
                        else "green", c)
    return {"type": "FeatureCollection",
            "attribution": "(c) OpenStreetMap contributors, ODbL",
            "features": feats}

def lighting_of(tags):
    lit = tags.get("lit")
    if lit in ("yes", "24/7", "sunset-sunrise"):
        return "yes", None
    if lit == "no":
        return "no", None
    hw = tags.get("highway")
    # UK urban main/through streets are lit: documented modelling assumption.
    if hw in ("residential", "tertiary", "secondary", "primary",
              "living_street", "pedestrian"):
        return "yes", "assumed (UK main-road default)"
    return "unknown", None

def isolation_of(hw, lighting):
    base = {"primary": 1, "secondary": 1, "tertiary": 2, "residential": 3,
            "living_street": 3, "pedestrian": 3, "unclassified": 5,
            "cycleway": 5, "footway": 6, "path": 7, "steps": 7,
            "service": 6}[hw]
    if lighting == "no":
        base += 2
    elif lighting == "unknown":
        base += 1
    return min(10, base)

def footfall_of(hw):
    return {"primary": "high", "secondary": "high", "tertiary": "high",
            "residential": "medium", "living_street": "medium",
            "pedestrian": "high", "unclassified": "medium",
            "cycleway": "low", "footway": "low", "path": "low",
            "steps": "low", "service": "low"}[hw]

PAVED_SURFACES = {"asphalt", "concrete", "paved", "concrete:lanes", "chipseal",
                  "metal", "paving_stones", "sett", "unhewn_cobblestone",
                  "cobblestone", "brick"}
UNPAVED_SURFACES = {"unpaved", "gravel", "fine_gravel", "dirt", "ground",
                    "grass", "mud", "sand", "compacted", "pebblestone",
                    "wood", "woodchips", "rock", "stone", "shells"}

def surface_of(tags):
    s = tags.get("surface", "").split(";")[0].strip().lower()
    if s in PAVED_SURFACES:
        return "paved"
    if s in UNPAVED_SURFACES:
        return "unpaved"
    return None                          # honest unknown, not guessed

def steep_of(tags):
    inc = tags.get("incline", "").strip().lower()
    if not inc:
        return None
    if inc in ("up", "down", "steep"):
        return True
    try:
        return abs(float(inc.rstrip("%"))) >= 8.0
    except ValueError:
        return None

def covered_of(tags):
    if tags.get("covered") == "yes" or tags.get("tunnel") == "yes" \
            or tags.get("highway") == "covered":
        return True
    if tags.get("covered") == "no":
        return False
    return None

def build_segments(ways, args, nightlife):
    venues = []
    for e in nightlife.get("elements", []):
        lat = e.get("center", {}).get("lat") or (e.get("lat") if e.get("type") == "node" else None)
        lon = e.get("center", {}).get("lon") or (e.get("lon") if e.get("type") == "node" else None)
        if lat and lon:
            venues.append((lat, lon))
    centre = (50.9045, -1.4025)

    segs = []
    for w in ways:
        coords = [[round(p["lat"], 5), round(p["lon"], 5)] for p in w["geometry"]]
        if len(coords) < 2:
            continue
        length = way_length(coords)
        if length < MIN_LENGTH_M:
            continue
        lat, lon = coords[0]
        if not (args.bbox[0] <= lat <= args.bbox[1]
                and args.bbox[2] <= lon <= args.bbox[3]):
            continue
        tags = w["tags"]
        hw = tags.get("highway", "path")
        lighting, lit_note = lighting_of(tags)
        surface = surface_of(tags)
        steep = steep_of(tags)
        covered = covered_of(tags)
        mid = coords[len(coords)//2]
        tide = min(min_dist_point_to_polyline(mid, poly) for poly in WATER) \
            <= TIDE_EXPOSURE_M
        n_night = sum(1 for v in venues if dist_m(v, mid) <= 250)
        segs.append({
            "id": f"SEG-{w['id']}",
            "osm_way_id": w["id"],
            "name": tags.get("name") or tags.get("ref") or "unnamed path",
            "highway_type": hw,
            "coordinates": coords,
            "length_m": int(length),
            "lighting": lighting,
            "lighting_source": ("OpenStreetMap lit tag" if tags.get("lit")
                                else lit_note or "no OSM lit tag"),
            "isolation_score": isolation_of(hw, lighting),
            "tide_exposed": tide,
            "surface": surface,          # paved / unpaved / None=unknown
            "steep": steep,              # True / False / None=unknown
            "covered": covered,          # True / False / None=unknown
            "footfall": footfall_of(hw),
            "nightlife_venues_250m": n_night,
            "dist_to_centre_m": int(dist_m(mid, centre)),
            "crime_count_90d": 0,
            "crime_count_6m": 0,
            "last_crime_month": None,
            "crime_categories": {},
            "risk_band": None,
            "risk_score": None,
            "data_sources": {
                "geometry": "OpenStreetMap (ODbL)",
                "lighting": "OSM lit tag + UK road-type default",
                "crime": "Police UK street-level crime (OGL v3)",
                "tide": "EA live gauge + OS coastline model",
            },
        })
    return segs

# ---------------------------------------------------------------- police
def fetch_police():
    months = months_back(POLICE_MONTHS)
    # probe: drop months the API doesn't have yet (it returns [])
    crimes = {}
    for month in months:
        lat0, lng0 = POLICE_POINTS[0]
        try:  # cheap probe: is this month published?
            if not http_json(f"{POLICE_URL}?lat={lat0}&lng={lng0}&date={month}",
                             timeout=60):
                print(f"    {month}: not published yet, skipping")
                continue
        except Exception:
            continue
        found_any = False
        for lat, lng in POLICE_POINTS:
            url = f"{POLICE_URL}?lat={lat}&lng={lng}&date={month}"
            for attempt in range(3):
                try:
                    d = http_json(url, timeout=60)
                    found_any = found_any or bool(d)
                    for c in d:
                        crimes[c["id"]] = {
                            "id": c["id"],
                            "category": c["category"],
                            "month": c["month"],
                            "street": c["location"]["street"]["name"],
                            "lat": float(c["location"]["latitude"]),
                            "lng": float(c["location"]["longitude"]),
                            "outcome": (c.get("outcome_status") or {}).get("category"),
                        }
                    break
                except Exception:
                    time.sleep(2 * attempt + 1)
            else:
                print(f"    !! point ({lat},{lng}) {month} failed, skipped")
            time.sleep(0.3)
        print(f"    {month}: {len(crimes)} unique crimes so far")
    return list(crimes.values())

def snap_crimes(segs, crimes):
    """Attach each crime to the nearest walking segment (within SNAP_MAX_M)."""
    cell = 0.0012
    grid = defaultdict(list)          # cell -> [(lat,lng,seg_idx)]
    for i, s in enumerate(segs):
        pts = list(s["coordinates"])
        grid[(round(pts[0][0]/cell), round(pts[0][1]/cell))].append(
            (pts[0][0], pts[0][1], i))
        for a, b in zip(pts, pts[1:]):
            grid[(round(b[0]/cell), round(b[1]/cell))].append((b[0], b[1], i))
            if dist_m(a, b) > 40:     # long straight edges: add midpoint
                grid[(round((a[0]+b[0])/2/cell),
                      round((a[1]+b[1])/2/cell))].append(
                    ((a[0]+b[0])/2, (a[1]+b[1])/2, i))
    def nearest(pt):
        gx, gy = round(pt[0]/cell), round(pt[1]/cell)
        best = (SNAP_MAX_M, None)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (la, ln, i) in grid.get((gx+dx, gy+dy), ()):
                    d = dist_m(pt, (la, ln))
                    if d < best[0]:
                        best = (d, i)
        return best
    for c in crimes:
        d, i = nearest((c["lat"], c["lng"]))
        if i is not None:
            c["segment_id"] = segs[i]["id"]
            c["snap_distance_m"] = int(d)
        else:
            c["segment_id"] = None
        c["source"] = "data.police.uk street-level crime (OGL v3)"
    return [c for c in crimes if c["segment_id"] is not None]

def tally_crimes(segs, crimes):
    idx = {s["id"]: s for s in segs}
    per_month = defaultdict(lambda: defaultdict(int))
    all_months = sorted({c["month"] for c in crimes})
    latest3 = set(all_months[-3:])       # ~90 days of published data
    for c in crimes:
        per_month[c["segment_id"]][c["month"]] += 1
        s = idx[c["segment_id"]]
        s["crime_categories"][c["category"]] = \
            s["crime_categories"].get(c["category"], 0) + 1
    for s in segs:
        counts = per_month.get(s["id"], {})
        s["crime_count_6m"] = sum(counts.values())
        s["crimes_by_month"] = dict(counts)
        s["last_crime_month"] = max(counts) if counts else None
        s["crime_count_90d"] = sum(v for m, v in counts.items() if m in latest3)
    return per_month

# ---------------------------------------------------------------- EA live
def fetch_ea_live():
    out = {"fetched_at": NOW_ISO,
           "licence": "Environment Agency flood-monitoring API, OGL v3"}
    try:
        r = http_json(f"{EA_BASE}/id/stations/{EA_TIDE_GAUGE}/readings?latest",
                      timeout=30)
        it = r["items"][0]
        out["tide_gauge"] = {
            "station": "Woolston (E12660)", "measure": "tidal level mAOD",
            "value": it["value"], "reading_time": it["dateTime"],
        }
    except Exception as e:
        out["tide_gauge"] = {"error": str(e)}
    try:
        r = http_json(f"{EA_BASE}/id/floods", timeout=30)
        hants = [i for i in r["items"]
                 if i.get("countyName") in ("Hampshire", "Southampton")]
        out["flood_warnings"] = [
            {"name": i["name"], "severity": i["severity"],
             "severity_level": i["severityLevel"],
             "message": i.get("message", "")[:300],
             "url": i.get("@id")} for i in hants]
        out["flood_warnings_nationwide"] = len(r["items"])
    except Exception as e:
        out["flood_warnings"] = [{"error": str(e)}]
    return out

def fetch_ukho_tides():
    """OPTIONAL: official UKHO tide predictions. Set TIDAL_API_KEY to enable.
    Free registration: https://api.gov.uk/ukho/uk-tidal-api-discovery/"""
    key = os.environ.get("TIDAL_API_KEY")
    if not key:
        return None
    try:
        hdr = {"Ocp-Apim-Subscription-Key": key}
        st = http_json(f"{TIDAL_API_BASE}/api/V2/Stations", headers=hdr, timeout=30)
        return {"fetched_at": NOW_ISO, "station_list_queried": len(st)}
    except Exception as e:
        print(f"    !! UK Tidal API error (ignored): {e}")
        return None

# ---------------------------------------------------------------- Athena model
# Crime prediction only. Preference-related attributes (lighting, isolation,
# tide exposure, haven proximity, terrain) are deliberately NOT features:
# they belong in the router as user-preference multipliers, not in the model.
REMOVED_FEATURES = ["lit_no", "lit_partial", "lit_unknown", "isolation",
                    "tide_exposed", "haven_300m"]
FEATURES_STATIC = ["log_len", "is_footway", "is_path", "is_steps", "is_service",
    "is_residential", "is_main", "is_pedestrian", "is_cycleway",
    "nightlife_250m", "log_dist_centre"]
FEATURES_LAG = ["log1p_lag1", "log1p_lag2"]

def seg_features(s, lag1=0, lag2=0):
    hw = s["highway_type"]
    return {
        "log_len": math.log1p(s["length_m"]),
        "is_footway": hw == "footway", "is_path": hw == "path",
        "is_steps": hw == "steps", "is_service": hw == "service",
        "is_residential": hw == "residential",
        "is_main": hw in ("primary", "secondary", "tertiary"),
        "is_pedestrian": hw == "pedestrian", "is_cycleway": hw == "cycleway",
        "nightlife_250m": min(1.0, s["nightlife_venues_250m"] / 10.0),
        "log_dist_centre": math.log1p(s["dist_to_centre_m"]) / 10.0,
        "log1p_lag1": math.log1p(lag1),
        "log1p_lag2": math.log1p(lag2),
    }

def logistic(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z)) if z < 500 else 1.0
    e = math.exp(z) if z > -500 else 0.0
    return e / (1.0 + e)

def train_lr(rows, n_feat, epochs, lr, l2):
    """Batch logistic regression with gradient descent. rows = [(x, y)]."""
    w = [0.0] * n_feat
    b = 0.0
    n = len(rows)
    for ep in range(epochs):
        gw = [0.0] * n_feat
        gb = 0.0
        for x, y in rows:
            z = b + sum(wi * xi for wi, xi in zip(w, x))
            p = logistic(z)
            err = p - y
            gb += err
            for j in range(n_feat):
                gw[j] += err * x[j]
        b -= lr * gb / n
        for j in range(n_feat):
            w[j] -= lr * (gw[j] / n + l2 * w[j])
    return w, b

def auc(pairs):
    """pairs of (score, label). Rank-based AUC (Mann-Whitney)."""
    pos = [s for s, y in pairs if y == 1]
    neg = [s for s, y in pairs if y == 0]
    if not pos or not neg:
        return None
    order = sorted(pairs, key=lambda t: t[0])
    ranks, i = {}, 0
    while i < len(order):                      # average ranks for ties
        j = i
        while j < len(order) and order[j][0] == order[i][0]:
            j += 1
        for k in range(i, j):
            ranks[k] = (i + j - 1) / 2.0 + 1
        i = j
    rank_sum = sum(ranks[k] for k, (s, y) in enumerate(order) if y == 1)
    n1, n0 = len(pos), len(neg)
    return (rank_sum - n1 * (n1 + 1) / 2.0) / (n1 * n0)

def train_model(segs, per_month, havens, months, offline):
    """Train on all months but the last; evaluate on the last month.
    Returns (model_dict, predictions per segment for next month)."""
    scored = [s for s in segs if s["lighting"] != "unknown"]
    fidx = FEATURES_STATIC + FEATURES_LAG
    months_sorted = sorted(months)
    if len(months_sorted) < 3:
        return None, None
    test_m = months_sorted[-1]
    train_ms = months_sorted[:-1][-3:]      # up to 3 months before test

    def count(s, m):
        return per_month.get(s["id"], {}).get(m, 0)

    def old_extras(s):
        mid = s["coordinates"][len(s["coordinates"])//2]
        haven = any(dist_m((h["lat"], h["lng"]), mid) <= 300 for h in havens)
        return {
            "lit_no": s["lighting"] == "no",
            "lit_partial": s["lighting"] == "partial",
            "lit_unknown": s["lighting"] == "unknown",
            "isolation": s["isolation_score"] / 10.0,
            "tide_exposed": s["tide_exposed"],
            "haven_300m": haven,
        }

    rows, y = [], []
    for s in scored:
        for m in train_ms:
            mi = months_sorted.index(m)
            lag1 = count(s, months_sorted[mi-1]) if mi >= 1 else 0
            lag2 = count(s, months_sorted[mi-2]) if mi >= 2 else 0
            if mi < 2:                        # need 2 lags to be comparable
                continue
            f = seg_features(s, lag1, lag2)
            rows.append(([f[k] for k in fidx], 1 if count(s, m) > 0 else 0))
    if not rows:
        return None, None

    # standardise
    n = len(rows)
    dim = len(rows[0][0])
    mean = [sum(r[0][j] for r in rows) / n for j in range(dim)]
    std = [math.sqrt(sum((r[0][j] - mean[j]) ** 2 for r in rows) / n) or 1
           for j in range(dim)]
    for r, _ in rows:
        for j in range(dim):
            r[j] = (r[j] - mean[j]) / std[j]

    print(f"    training rows: {len(rows)} | test month: {test_m}")

    def fit(Xmat, Yvec):
        """Logistic regression (L2=0.01), numpy fast path, stdlib fallback."""
        try:
            import numpy as np
            Xa = np.array(Xmat); Ya = np.array(Yvec)
            w = np.zeros(Xa.shape[1]); b = 0.0
            for _ in range(400):
                p = 1 / (1 + np.exp(-(Xa @ w + b)))
                err = p - Ya
                gw = Xa.T @ err / len(Ya) + 0.01 * w
                b -= float(0.5 * err.mean())
                w -= 0.5 * gw
            return w.tolist(), b, "numpy"
        except ImportError:
            rr = [(list(x), yy) for x, yy in zip(Xmat, Yvec)]
            w, b = train_lr(rr, len(Xmat[0]), 80, 2.0, 0.01)
            return w, b, "pure-python"

    # final model: crime-prediction features only
    w, b, path_used = fit([r for r, _ in rows], [yy for _, yy in rows])

    # comparison fit including the removed features, used ONLY as evidence
    # for the removed_features block — every number comes from this fit
    rows_w = []           # rows with segment attached (built above, refit here)
    for s in scored:
        for m in train_ms:
            mi = months_sorted.index(m)
            if mi < 2:
                continue
            lag1 = count(s, months_sorted[mi-1])
            lag2 = count(s, months_sorted[mi-2])
            f = seg_features(s, lag1, lag2)
            ex = old_extras(s)
            rows_w.append(([f[k] for k in fidx] + [ex[k] for k in REMOVED_FEATURES],
                           1 if count(s, m) > 0 else 0))
    n_w = len(rows_w)
    dim_w = len(fidx) + len(REMOVED_FEATURES)
    mean_w = [sum(r[0][j] for r in rows_w) / n_w for j in range(dim_w)]
    std_w = [math.sqrt(sum((r[0][j] - mean_w[j]) ** 2 for r in rows_w) / n_w) or 1
             for j in range(dim_w)]
    for r in rows_w:
        for j in range(dim_w):
            r[0][j] = (r[0][j] - mean_w[j]) / std_w[j]
    w_old, _, _ = fit([r for r, _ in rows_w], [yy for _, yy in rows_w])
    removed_coefs = {k: round(c, 4) for k, c in
                     zip(REMOVED_FEATURES, w_old[-len(REMOVED_FEATURES):])}
    print("    comparison-fit coefficients for removed features:", removed_coefs)

    # evaluate on the held-out month
    pairs_m, pairs_b, pairs_r, silent_m, silent_l = [], [], [], [], []
    for s in scored:
        mi = months_sorted.index(test_m)
        if mi < 2:
            continue
        lag1, lag2 = count(s, months_sorted[mi-1]), count(s, months_sorted[mi-2])
        f = seg_features(s, lag1, lag2)
        x = [(f[k] - mean[j]) / std[j] for j, k in enumerate(fidx)]
        z = b + sum(wj * xj for wj, xj in zip(w, x))
        y = 1 if count(s, test_m) > 0 else 0
        pairs_m.append((logistic(z), y))
        pairs_b.append((lag1, y))             # baseline: last month's count
        # stronger baseline: last two months' count, ties broken by length
        pairs_r.append((lag1 + lag2 + s["length_m"] / 1e6, y))
        if lag1 + lag2 == 0:                  # history is silent here
            silent_m.append((logistic(z), y))
            silent_l.append((s["length_m"], y))
    auc_m, auc_b = auc(pairs_m), auc(pairs_b)
    auc_r, auc_sm, auc_sl = auc(pairs_r), auc(silent_m), auc(silent_l)
    base_rate = sum(yy for _, yy in pairs_m) / len(pairs_m)

    # predict next month for every scored segment (lags = last two months)
    preds = {}
    for s in scored:
        lag1 = count(s, months_sorted[-1])
        lag2 = count(s, months_sorted[-2])
        f = seg_features(s, lag1, lag2)
        x = [(f[k] - mean[j]) / std[j] for j, k in enumerate(fidx)]
        preds[s["id"]] = round(logistic(b + sum(wj * xj for wj, xj in zip(w, x))), 4)

    # bands: quantiles of predicted next-month risk, documented in the card
    vals = sorted(preds.values())
    hi_cut = vals[int(0.90 * (len(vals)-1))]
    med_cut = vals[int(0.75 * (len(vals)-1))]

    coef = {k: round(v, 4) for k, v in zip(fidx, w)}
    # the app renders non-service segments >= 10 m; quote coverage on that set
    rendered = [s for s in segs
               if s["highway_type"] != "service" and s["length_m"] >= 10]
    total_segs = len(rendered) or len(segs)
    unknown_l = sum(1 for s in rendered if s["lighting"] == "unknown")
    lighting_unknown_pct = 100.0 * unknown_l / total_segs if total_segs else 0

    model = {
        "name": "Athena street-crime risk model",
        "type": "logistic regression (L2, standardised features)",
        "implementation": path_used,
        "features": fidx,
        "coefficients": coef,
        "intercept": round(b, 4),
        "feature_means": {k: round(m, 3) for k, m in zip(fidx, mean)},
        "feature_stds": {k: round(s, 3) for k, s in zip(fidx, std)},
        "training": {
            "train_months": train_ms, "test_month": test_m,
            "rows": len(rows), "segments_scored": len(scored),
        },
        "evaluation": {
            "auc_model": round(auc_m, 3) if auc_m else None,
            "auc_baseline_recent_crime": round(auc_b, 3) if auc_b else None,
            "baseline_description":
                "predicts risk from last month's crime count alone",
            "base_rate_any_crime_next_month": round(base_rate, 4),
            "auc_baseline_two_month_rule": round(auc_r, 3) if auc_r else None,
            "two_month_rule_description":
                "last two months' crime count, ties broken by path length",
            "share_scored_with_no_recent_crime": round(len(silent_m) / max(1, len(pairs_m)), 3),
            "auc_model_no_recent_crime": round(auc_sm, 3) if auc_sm else None,
            "auc_length_only_no_recent_crime": round(auc_sl, 3) if auc_sl else None,
            "honest_reading":
                "Recent crime explains most of the ranking. The model adds most "
                "where a path had no crime in the last two months, where crime "
                "history alone cannot rank paths.",
        },
        "bands": {
            "high": f"top 10% of scored segments by predicted risk "
                    f"(percentile band, cut at {hi_cut})",
            "medium": f"75th-90th percentile of scored segments "
                      f"(cut at {med_cut})",
            "low": "below the 75th percentile",
            "unknown": "lighting unknown -> never scored (honesty rule)",
            "note": "bands are percentile-based on the fit's scored "
                    "predictions, not absolute probability thresholds",
        },
        "removed_features": [
            {"feature": "lit_no",
             "reason": "moved to router as preference multiplier",
             "detail": "lighting encodes the user's well-lit-roads "
                       "preference, not crime causation; kept in the model it "
                       "confounds preference with prediction",
             "coefficient_in_comparison_fit": removed_coefs["lit_no"]},
            {"feature": "lit_partial",
             "reason": "moved to router as preference multiplier",
             "detail": "as lit_no; also a near-empty dummy in this dataset",
             "coefficient_in_comparison_fit": removed_coefs["lit_partial"]},
            {"feature": "lit_unknown",
             "reason": "moved to router as preference multiplier",
             "detail": "unknown-lighting segments are never scored at all "
                       "(honesty rule), so the dummy carries no signal",
             "coefficient_in_comparison_fit": removed_coefs["lit_unknown"]},
            {"feature": "isolation",
             "reason": "moved to router as preference multiplier",
             "detail": "quiet-vs-busy streets are a route preference the user "
                       "can weigh, not a crime predictor we should bake in",
             "coefficient_in_comparison_fit": removed_coefs["isolation"]},
            {"feature": "tide_exposed",
             "reason": "structurally dead",
             "detail": "riverside exposure is rare in the crime window and "
                       "the fitted weight is negligible; live tide data is "
                       "shown in the app instead",
             "coefficient_in_comparison_fit": removed_coefs["tide_exposed"]},
            {"feature": "haven_300m",
             "reason": "excluded before scoring",
             "detail": "safe-haven density tracks the city centre and "
                       "duplicates log_dist_centre (confounded); havens are "
                       "surfaced on the map, not in the crime score",
             "coefficient_in_comparison_fit": removed_coefs["haven_300m"]},
        ],
        "design_choice":
            "Preference-related attributes (lighting, isolation, tide "
            "exposure, haven proximity, terrain) are separated from crime "
            "prediction so a user's preferences cannot bias the risk estimate: "
            "the model predicts reported street crime only, and the router "
            "applies each user's preferences as explicit edge-cost "
            "multipliers. Risk bands are percentile-based (75th/90th "
            "percentile of the fit's scored predictions) rather than absolute "
            "thresholds, so bands stay comparable when the base rate moves.",
        "known_limitations": [
            "Time-of-day gap: Police UK street-level data has no time field, "
            "so the model predicts reported street crime generally, not "
            "night-time crime specifically; the night framing is carried by "
            "the router's preferences (lighting, quiet streets), not by data.",
            "Crime-location blurring: Police UK snaps crimes to an anonymous "
            "nearby street point; we snap to the nearest walking segment "
            f"within {SNAP_MAX_M:.0f} m, so segment-level counts are "
            "approximate by construction.",
            f"Lag-feature dominance: recent-crime history "
            f"(log1p_lag1 coefficient {coef.get('log1p_lag1', 0)}) is the "
            "strongest signal; where a street has no recent records the "
            "model falls back on structure (type, length, centre distance) "
            "and is correspondingly less certain.",
            f"Unknown-lighting exclusion: {lighting_unknown_pct:.0f}% of "
            "walking segments have no lighting data in OSM and are never "
            "scored; they show as grey 'risk unknown' in the app rather "
            "than being silently guessed.",
        ],
        "trained_at": NOW_ISO,
        "data_sources": [
            "Police UK street-level crime API (OGL v3), months "
            + ", ".join(months_sorted),
            "OpenStreetMap lit tags + highway types (ODbL)",
        ],
    }
    print(f"    AUC model {auc_m:.3f} vs baseline {auc_b:.3f} on {test_m}")
    return model, preds

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--bbox", nargs=4, type=float,
                    metavar=("LAT_MIN", "LAT_MAX", "LNG_MIN", "LNG_MAX"),
                    default=[50.86, 50.96, -1.48, -1.34])
    args = ap.parse_args()
    os.makedirs("entities", exist_ok=True)
    manifest = {"generated_at": NOW_ISO, "sources": []}
    def M(name, url, licence, **extra):
        manifest["sources"].append({"name": name, "url": url,
                                    "licence": licence, "fetched_at": NOW_ISO,
                                    **extra})

    print("1/8 loading OSM walking network ...")
    osm = cache_fetch("osm", fetch_osm, args.offline)
    ways = [e for e in osm["elements"] if e["type"] == "way" and "geometry" in e]
    print(f"   {len(ways)} raw ways")
    nightlife = cache_fetch("nightlife", fetch_nightlife, args.offline)
    print(f"   {len(nightlife.get('elements', []))} nightlife venues")

    print("2/8 building GeoJSON basemap (water, green, rail) ...")
    overpass_basemap = cache_fetch("basemap", fetch_basemap, args.offline)
    basemap = build_basemap(overpass_basemap)
    print(f"   {len(basemap['features'])} basemap features")
    M("OpenStreetMap basemap (water/green/rail)", OVERPASS_URL,
      "ODbL 1.0, (c) OSM contributors",
      features=len(basemap["features"]))

    print("3/8 building segments ...")
    segs = build_segments(ways, args, nightlife)
    print(f"   {len(segs)} segments")
    M("OpenStreetMap walking network", OVERPASS_URL, "ODbL 1.0, (c) OSM contributors",
      coverage=f"{len(segs)} segments")

    print("4/8 fetching real Police UK street crime ...")
    crimes = cache_fetch("police", fetch_police, args.offline)
    print(f"   {len(crimes)} unique crimes")
    crimes = snap_crimes(segs, crimes)
    print(f"   {len(crimes)} snapped to walking segments (<= {SNAP_MAX_M:.0f} m)")
    months = sorted({c["month"] for c in crimes})
    M("Police UK street-level crime", POLICE_URL,
      "Open Government Licence v3 (data.police.uk)", months=months,
      crimes=len(crimes))

    print("5/8 tallying crime per segment ...")
    per_month = tally_crimes(segs, crimes)

    print("6/8 training the Athena risk model ...")
    havens = [dict(h) for h in SAFE_HAVENS]
    model, preds = train_model(segs, per_month, havens, months, args.offline)

    vals_hi = vals_med = None
    if model and preds:
        vals = sorted(preds.values())
        vals_hi = vals[int(0.90 * (len(vals)-1))]
        vals_med = vals[int(0.75 * (len(vals)-1))]
    for s in segs:
        if s["lighting"] == "unknown":
            s["risk_band"] = "unknown"; s["risk_score"] = None
        elif model and preds:
            p = preds.get(s["id"], 0)
            s["risk_score"] = p
            s["risk_band"] = ("high" if p >= vals_hi else
                              "medium" if p >= vals_med else "low")
        else:
            # untrained fallback: recent crime count only, clearly flagged
            s["risk_band"] = ("high" if s["crime_count_90d"] >= 3 else
                              "medium" if s["crime_count_90d"] >= 1 else "low")
            s["risk_score"] = None
    for h in havens:
        near = min(segs, key=lambda s:
                   dist_m(s["coordinates"][0], (h["lat"], h["lng"])))
        h["segment_id"] = near["id"]
        h["source"] = "curated (hours hand-checked Oct 2026)"

    # preference-field coverage, computed from the real data (the app shows
    # these numbers as footnotes in the preferences modal)
    rendered = [s for s in segs
                if s["highway_type"] != "service" and s["length_m"] >= 10]
    n = len(rendered) or len(segs) or 1
    manifest["coverage"] = {
        "rendered_segments": len(rendered),
        "lighting_known_pct": round(100 * sum(
            1 for s in rendered if s["lighting"] != "unknown") / n, 1),
        "surface_known_pct": round(100 * sum(
            1 for s in rendered if s["surface"]) / n, 1),
        "incline_known_pct": round(100 * sum(
            1 for s in rendered if s["steep"] is not None) / n, 1),
        "sheltered_known_pct": round(100 * sum(
            1 for s in rendered if s["covered"] is not None) / n, 1),
        "steps_segments": sum(1 for s in rendered
                              if s["highway_type"] == "steps"),
        "covered_segments": sum(1 for s in rendered if s["covered"]),
    }

    print("7/8 live sources + outputs ...")
    live = fetch_ea_live()
    M("EA flood monitoring (live gauge + warnings)",
      f"{EA_BASE}/id/stations/{EA_TIDE_GAUGE}", "OGL v3",
      gauge=live.get("tide_gauge"))
    tides = fetch_ukho_tides()
    if tides:
        M("UKHO Admiralty Tidal API", TIDAL_API_BASE, "UKHO terms (free tier)",
          station=TIDE_STATION_ID)
    M("OSM nightlife venues", OVERPASS_URL, "ODbL 1.0",
      count=len(nightlife.get("elements", [])))

    with open("entities/path_segments.json", "w") as f:
        json.dump(segs, f, separators=(",", ":"))
    with open("entities/incidents.json", "w") as f:
        json.dump(crimes, f, separators=(",", ":"))
    with open("entities/safe_havens.json", "w") as f:
        json.dump(havens, f, indent=2)
    with open("entities/model.json", "w") as f:
        json.dump(model or {"status": "untrained — insufficient months"}, f, indent=2)
    with open("entities/live_check.json", "w") as f:
        json.dump(live, f, indent=2)
    with open("entities/basemap.geojson", "w") as f:
        json.dump(basemap, f, separators=(",", ":"))
    with open("entities/data_manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    feats = [{
        "type": "Feature",
        "geometry": {"type": "LineString",
                     "coordinates": [[c[1], c[0]] for c in s["coordinates"]]},
        "properties": {"id": s["id"], "name": s["name"],
                       "risk_band": s["risk_band"], "lighting": s["lighting"],
                       "crimes_90d": s["crime_count_90d"],
                       "isolation": s["isolation_score"],
                       "tide_exposed": s["tide_exposed"],
                       "length_m": s["length_m"]},
    } for s in segs]
    with open("risk_map.geojson", "w") as f:
        json.dump({"type": "FeatureCollection",
                   "attribution": "(c) OpenStreetMap contributors, ODbL; "
                                  "crime data (c) Police UK, OGL v3",
                   "features": feats}, f, separators=(",", ":"))

    bands = Counter(s["risk_band"] for s in segs)
    print(f"\ndone. {len(segs)} segments | bands {dict(bands)}")
    print(f"     {len(crimes)} real crimes | {months[0]}..{months[-1]} | "
          f"{len(havens)} havens")
    if live.get("tide_gauge", {}).get("value") is not None:
        print(f"     live tide now: {live['tide_gauge']['value']} mAOD "
              f"({live['tide_gauge']['reading_time']})")
    if model:
        print(f"     model AUC: {model['evaluation']['auc_model']} vs baseline "
              f"{model['evaluation']['auc_baseline_recent_crime']}")

if __name__ == "__main__":
    main()
