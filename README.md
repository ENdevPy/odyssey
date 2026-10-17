# Odyssey — night-safety routing for Southampton

> We help someone walking home late in Southampton choose streets the data
> says are safer, using an AI model trained on real Police UK street crime
> and OpenStreetMap lighting, with live Environment Agency tide and flood
> data — showing every number's source, date, and what we don't know.

Odyssey is the exemplar project for the **SotonShip** Coastal City track: a
night-safety route planner whose navigation engine, **Athena**, scores every
walking segment in Southampton with a trained risk model and plans Safest /
Shortest / Balanced routes with plain-English, honest explanations.

## Repo map

| Path | What it is |
|---|---|
| `odyssey-app/` | The web app. Static, no backend, no keys. Run it with any static server. |
| `odyssey-city-data/` | The live data pipeline: `build_odyssey_data.py` fetches every source, trains the Athena model, and emits `entities/*.json` |
| `odyssey-city-data/entities/` | Generated data (real crimes, scored segments, model card, source manifest) |
| `GUIDE.md` | The complete plain-English walkthrough: what it is, how it works, how to run it, how to publish it |
| `LICENSE` | MIT (code). Data licences stated per source in the table below. |

## Quickstart

```bash
cd odyssey-app
python3 -m http.server 8000      # Windows: py -m http.server 8000
```

Open http://localhost:8000. Don't open `index.html` by double-clicking: the browser blocks the data and the map stays empty.

### On a phone

Phones only share GPS with https sites, so publish it with GitHub Pages (free): repo **Settings > Pages > Deploy from a branch > main > / (root) > Save**. A few minutes later the app is at `https://<username>.github.io/odyssey/odyssey-app/`. Open it once on Wi-Fi (about 23 MB of map data), then:

- **iPhone (Safari):** Share > Add to Home Screen.
- **Android (Chrome):** menu > Install app, or About in the app > Add Odyssey to your home screen.

It then opens full-screen like an installed app and works offline (live tide, flood warnings and place search need a connection and say so when offline).

Refresh every data source and retrain the model (~4 minutes):

```bash
cd odyssey-city-data
python3 build_odyssey_data.py
cp entities/*.json ../odyssey-app/data/
```

Run the routing tests on the real data: `cd odyssey-app && node test_core.js`.

### App files

| File | What it does |
|---|---|
| `app.js` | Athena core: graph, routing, model-driven costs, explanations. No interface code, so the tests can load it. |
| `ui.js` | The interface: map, bottom sheet, search, route cards, path details, Tonight, Help, reports, preferences, welcome screens. |
| `index.html`, `style.css` | Layout and design (mobile-first, side panel on wide screens). |
| `manifest.webmanifest`, `sw.js`, `icons/` | Install to home screen and offline support. |

## What's real (everything)

| Source | Use | Licence |
|---|---|---|
| Police UK street-level crime API | 15,258 recorded street crimes, Feb–Aug 2026, snapped to segments | OGL v3 |
| OpenStreetMap / Overpass | 23,144 walking ways, geometry + `lit` tags | ODbL 1.0 |
| Environment Agency flood-monitoring API | live Woolston tide gauge + flood warnings, fetched live in the browser | OGL v3 |
| OSM nightlife venues | model features | ODbL 1.0 |
| Curated safe havens | 15 real staffed places, hours checked Oct 2026 | this repo |

The app renders this provenance itself: the **Data sources & freshness**
panel is generated from `entities/data_manifest.json`, and each segment
popup cites Police UK with the month of the data.

## AI at the core

Athena's risk model is a logistic regression (19 standardised features)
trained by the pipeline on the real crime data, with a temporal split:
trained on months to Jul 2026, evaluated on the held-out month Aug 2026.
**AUC 0.971**, against **0.866** for a baseline that predicts risk from last
month's crime alone. The router consumes the model's continuous probability
per segment with a 12-minute detour bound, and when an area offers no real
safety gain it says so instead of pretending. Full model card, coefficients
and honesty notes: `odyssey-city-data/entities/model.json`.

## Honesty by design

- 45% of the walking network has no lighting data: rendered grey-dashed,
  labelled "risk unknown", never scored by the model.
- Police UK blurs crime locations to a street point; snapping distances are
  recorded and the blurring is stated in the UI.
- No time-of-day in the crime data: the model predicts reported street crime
  generally; lighting and isolation carry the night weighting.
- Offline or out of coverage, the app says what is stale or unavailable
  instead of faking liveness.

## Business case (short version)

Universities' student-safety budgets, the council's community-safety team,
or the city-centre BID pay for a per-term licence. Running cost is a static
site plus one ~4-minute monthly retrain on public data — effectively zero
infrastructure. Second city: swap the OSM area id, bbox and Police UK sample
points; the whole pipeline is city-parameterised. Full version in
`odyssey-city-data/README.md`.

## Demo script

In `odyssey-city-data/README.md` — opens on the honesty stat (45% unknown),
peaks on the Shirley→centre trip (shortest route passes 265 reported street
crimes; Athena's safest passes 13 for +7 min), and closes on the live
Environment Agency gauge reading.

## Disclosure

Built as an organiser's exemplar ahead of the event with AI assistance
(Base44 Superagent). No proprietary data or restricted systems were used.
Entering teams should build their own during the event; this repo exists to
show the bar: real data, load-bearing AI, an honest model card, a working
product, and a live demo.
