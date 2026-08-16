# 🚌 Bad AMB Bus Tracker — Multi-Line Real-Time Transit Platform

> Live tracking, real-time GPS telemetry, universal stop search, and dead-zone location estimator for interurban line **C-10 (Barcelona ⇄ Mataró per N-II)** and all 8 urban lines of **Mataró Bus (L1, L2, L3, L4, L5, L6, L7, L8)**.

🌐 **Live Web App**: [https://bad-amb-bus-tracker.vercel.app/](https://bad-amb-bus-tracker.vercel.app/)

[![Live Deployment](https://img.shields.io/badge/Live-bad--amb--bus--tracker.vercel.app-blueviolet?style=for-the-badge&logo=vercel)](https://bad-amb-bus-tracker.vercel.app/)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.19+-blue.svg)](https://expressjs.com/)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9+-brightgreen.svg)](https://leafletjs.com/)
[![Status](https://img.shields.io/badge/Tests-Passing_100%25-success.svg)]()

---

## 🧭 The Problem & Our Solution

1. **The AMB Mobilitat Dead Zone**: The official *AMB Mobilitat* app only covers stops inside the 36 metropolitan municipalities (stopping abruptly at Montgat). When line C-10 travels into the Maresme coastal region (*El Masnou, Premià de Mar, Vilassar de Mar, Cabrera de Mar, Mataró*), vehicles disappear.
2. **Mataró Bus Coverage Shadow Drops**: In urban Mataró, buses frequently cross cellular dead zones where mobile apps stop rendering them or drop live GPS telemetry.
3. **The Solution**: 
   - Direct integration with Generalitat de Catalunya's **Mou-te REST API** with HMAC MD5 tokens for the C-10 interurban corridor.
   - Reverse-engineered integration with Avanza's official **SIRI SOAP service** (`sirimataro.avanzagrupo.com`) for real-time Mataró Bus fleet monitoring.
   - Built-in **Dead-Zone Location Estimator (Dead-Reckoning)** that projects bus movement smoothly along exact road polyline geometries during coverage dropouts.

---

## 🚌 Supported Lines

| Line | Name | Operator | Official Color |
| :--- | :--- | :--- | :--- |
| **C-10** | Barcelona ⇄ Mataró (per N-II) | Empresa Casas (Moventis) | `#009485` Teal |
| **L1** | Circular 1 (Hospital ⇄ Rodalies) | Mataró Bus (Avanza) | `#ff00ff` Magenta |
| **L2** | Circular 2 (Hospital ⇄ Rodalies) | Mataró Bus (Avanza) | `#804000` Brown |
| **L3** | Camí de la Serra ⇄ Vista Alegre ⇄ Rocafonda | Mataró Bus (Avanza) | `#808080` Gray |
| **L4** | Cirera ⇄ Molins | Mataró Bus (Avanza) | `#ff0000` Red |
| **L5** | Rodalies ⇄ Hospital de Mataró | Mataró Bus (Avanza) | `#00ea00` Lime |
| **L6** | Institut Català Salut ⇄ Ctra. de Mata | Mataró Bus (Avanza) | `#febf01` Amber |
| **L7** | Pl. Tereses ⇄ Cerdanyola | Mataró Bus (Avanza) | `#80ffff` Cyan |
| **L8** | Rodalies ⇄ Galícia | Mataró Bus (Avanza) | `#008040` Forest |

---

## ✨ Key Features

- 🔍 **Universal Stop Searcher**: Search by stop name, code, or neighborhood across all lines in Mataró and the coastal corridor with instant jump and target selection.
- 🛰️ **Dead-Zone GPS Location Estimator**:
  - When vehicles cross cellular shadow zones or signal is delayed, the system extrapolates vehicle coordinates along the road polyline using speed and stop progression.
  - Visual status pill indicators: `🟢 Senyal GPS Actiu` vs `⚡ Estimació Zona Cobertura`.
- 🧭 **Cockpit GPS Telemetry Inspector**:
  - High-precision latitude/longitude coordinates.
  - Great-circle compass bearing angle ($0^\circ - 360^\circ$) and compass label (e.g. `NW ↖️`).
  - Vehicle physical speed ($\text{km/h}$), delay duration, active segment, and route progression percentage.
- 🗺️ **Interactive Leaflet Canvas Map**:
  - Continuous 60fps hardware-accelerated gliding animation without teleportation or rubber-banding.
  - Dynamic route polyline rendered in the line's official color.
  - Bus pin rotation matching the vehicle's actual forward direction.
- ⭐ **Persistent Target Stop & Departure Countdowns**:
  - Choose any favorite stop on any line via the select dropdown, list stars, or map popups.
  - Real-time countdowns (`Imminent`, `3 min`, etc.) with punctual / early / delayed status badges.
- 🔊 **Audio Chimes & Push Notifications**:
  - Synthesized Web Audio API arrival chimes when your bus is approaching.

---

## 📡 REST API Documentation

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/lines` | Returns all supported transit lines (C-10 + Mataró L1..L8). |
| `GET` | `/api/search/stops?q={query}` | Universal search across all stops by name or code. |
| `GET` | `/api/mataro/lines` | Returns metadata for all 8 Mataró urban lines. |
| `GET` | `/api/mataro/line/:lineId?direction={0\|1}` | Returns stops, polyline geometry, and active/estimated buses for a Mataró line. |
| `GET` | `/api/mataro/target-eta?lineId={id}&stopId={id}&direction={dir}` | Returns real-time arrival countdown for target stop on Mataró Bus. |
| `GET` | `/api/mataro/stop/:stopId/departures?lineId={id}` | Returns live stop departures. |
| `GET` | `/api/c10/target-eta?direction={0\|1}&stopId={id}` | C-10 target stop countdown and upcoming departures. |
| `GET` | `/api/c10/live-corridor?direction={0\|1}` | C-10 corridor checkpoints and GPS telemetry. |
| `GET` | `/api/c10/stops?direction={0\|1}` | C-10 stop catalog. |
| `GET` | `/api/health` | Health check endpoint. |

---

## 🌐 1-Click Free Cloud Deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSome1sm%2FBadAMBBusTracker)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Some1sm/BadAMBBusTracker)

### Option 1: Vercel (100% Free)
1. Log in to [Vercel.com](https://vercel.com) with GitHub.
2. Click **Add New Project** and select `Some1sm/BadAMBBusTracker`.
3. Click **Deploy**. Vercel will launch your live site instantly!

### Option 2: Render
1. Connect your repository on [Render.com](https://render.com).
2. Choose **Web Service** (Node runtime).

---

## 🚀 Running Locally

```bash
# 1. Clone repo
git clone https://github.com/Some1sm/BadAMBBusTracker.git
cd BadAMBBusTracker

# 2. Install dependencies
npm install

# 3. Run automated test suite
node test/e2e_multiline_test.js

# 4. Start local server
npm start
```

Visit **`http://localhost:3000`** in your browser.

---

## 📜 License & Credits

- Data sources: **Generalitat de Catalunya (Mou-te / ATM)**, **AMB Mobilitat**, and **Mataró Bus (Avanza / CTSA SIRI)**.
