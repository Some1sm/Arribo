# 🚌 BadAMBBusTracker — Live Tracker & GPS Telemetry Solver (Line C-10)

> Real-time monitoring, live GPS telemetry reconstruction, and multi-checkpoint corridor solver for interurban bus line **C-10 (Barcelona ⇄ Mataró per la N-II)** operated by Empresa Casas / Moventis.

[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.19+-blue.svg)](https://expressjs.com/)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9+-brightgreen.svg)](https://leafletjs.com/)
[![Status](https://img.shields.io/badge/Tests-Passing_100%25-success.svg)]()

---

## 🧭 The Problem with AMB Mobilitat & Our Solution

- **The Problem**: The *AMB Mobilitat* app only covers stops located inside the 36 metropolitan municipalities (up to Montgat). When the C-10 enters the Maresme coastal region (*El Masnou, Premià de Mar, Vilassar de Mar, Cabrera de Mar, Mataró*), the vehicle "disappears" or falls back to static tables.
- **The Solution**: We integrated directly with the official Generalitat de Catalunya **Mou-te REST API** (`https://mou-te.gencat.cat/MouteAPI/rest/`) authenticated with dynamic HMAC MD5 security tokens, combined with an open GTFS feed and an advanced **Multi-Stop Dynamic Gradient GPS Solver** to track the entire 42-stop corridor in real time.

---

## ✨ Features

- 🛰️ **Dynamic Gradient GPS Solver**:
  - Computes exact vehicle latitude/longitude ($6$-decimal precision) along the road polyline.
  - Spherical trigonometry for Great-Circle bearing angle ($0^\circ - 360^\circ$) and compass orientation (e.g. `NE ↗️`).
  - Physical velocity calculation ($\text{km/h}$) and remaining distance/time to the next checkpoint.
- 📡 **Live GPS Telemetry Stream Inspector**:
  - Live cockpit radar panel displaying real-time coordinates, heading angle, estimated speed, active road segment, and overall route completion percentage.
- 🗺️ **Interactive Leaflet Canvas Map**:
  - Per-second client-side multi-segment gliding animation (`requestAnimationFrame`).
  - Vehicle marker rotated in real time to match the bus's forward bearing (`transform: rotate(θ deg)`).
  - Stop markers color-coded by region, with interactive departure inspection popups.
- ⭐ **Fully Customizable Target Stop**:
  - Select **any stop** along the route as your primary favorite via the top dropdown, list star icons (`⭐`), or map popups.
  - Saved persistently in `localStorage` across reloads with dedicated Google Maps direct navigation links.
- ⚡ **Unified Active-Trip Corridor Timeline**:
  - 9 linear checkpoints showing coherent progression for the single active trip on the road.
  - Completed stops marked with checkmarks (**`✓ Passat`**), current location with glowing **`🚌`**, and upcoming stops with live ETAs and delay tags.
- 🅿️ **Terminal Layover & Turnaround Synchronization**:
  - Detects when a bus arrives at the terminus (*Hospital de Mataró* or *Barcelona La Pau*) and enters dwell turnaround (**`🅿️ En Regulació`**).
  - Synchronized seamlessly with return schedule departures in the opposite direction.
- 🏙️ **Geographic Regional Zoning**:
  - True spatial boundary classification at the Montgat/Maresme border ($2.289^\circ\text{ E}$ Longitude) cleanly separating **Zona AMB** from **Zona Maresme**.
- 🔊 **Audio & Notification Alerts**:
  - Web Audio API chime and HTML5 desktop push notifications when your bus is within 5 minutes.

---

## 📡 REST API Documentation

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/c10/target-eta?direction={0\|1}&stopId={id}` | Returns live countdown, schedule comparison, and upcoming departures for the chosen stop. |
| `GET` | `/api/c10/live-corridor?direction={0\|1}` | Returns 9 unified corridor checkpoints and active vehicle GPS telemetry. |
| `GET` | `/api/c10/stops?direction={0\|1}` | Returns all 41–42 stops with GPS coordinates, GTFS codes, and zone tags. |
| `GET` | `/api/c10/stop/:id/departures?direction={0\|1}` | Returns real-time arrival departures for any specific stop pole. |
| `GET` | `/api/health` | Service health check. |

---

## 🌐 Free 1-Click Cloud Deployment

Deploy this tracker for free and share the live URL with friends:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSome1sm%2FBadAMBBusTracker)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Some1sm/BadAMBBusTracker)

### Option 1: Vercel (Recommended — 100% Free & Fast)
1. Go to [Vercel.com](https://vercel.com) and log in with your GitHub account.
2. Click **"Add New Project"** and import `Some1sm/BadAMBBusTracker`.
3. Click **Deploy**. Vercel will instantly build and host your app with an `https://badambbustracker.vercel.app` URL!

### Option 2: Render
1. Go to [Render.com](https://render.com) and connect your GitHub repository.
2. Choose **Web Service** (Free Plan) with Node.js runtime.
3. Render will deploy your app on `https://badambbustracker.onrender.com`.

---

## 🚀 Getting Started Locally

```bash
# 1. Clone the repository
git clone https://github.com/Some1sm/BadAMBBusTracker.git
cd BadAMBBusTracker

# 2. Install dependencies
npm install

# 3. Run automated test suite
npm test

# 4. Start the local server
npm start
```

Open your browser at **`http://localhost:3000`**.

---

## 📁 Project Architecture

```
├── data/                       # GTFS stops & route schedule datasets
│   ├── c10_full_schedule.json  # Complete timetable with service calendars
│   ├── c10_matched_stops_dir0.json
│   └── c10_matched_stops_dir1.json
├── public/                     # Static Web Frontend
│   ├── index.html              # Modern responsive HTML5 UI
│   ├── css/style.css           # Custom CSS3 theme & animations
│   └── js/
│       ├── app.js              # Application state, timer loops & audio
│       └── map.js              # Leaflet map, marker rotation & gliding
├── src/                        # Backend Engine
│   ├── mouteClient.js          # Mou-te REST API client with HMAC MD5 auth
│   ├── geoUtils.js             # Haversine, Great-Circle bearing & compass math
│   └── corridorTracker.js      # GPS interpolation & corridor engine
├── test/
│   └── e2e_test.js             # Automated E2E verification test suite
├── server.js                   # Express server & API routes
└── package.json
```

---

## 📜 License & Acknowledgments

- Data provided by **Generalitat de Catalunya (Mou-te / ATM)** and **AMB Mobilitat**.
- Built with ❤️ for commuters along the Maresme coastal corridor.
