# 🚆 Bad AMB Bus Tracker — Metropolitan Barcelona & Catalonia Transit Platform

> Live tracking, real-time GPS telemetry, dead-zone location estimation, universal stop search, and accurate schedules for **288+ bus and train lines** and **7,500+ stops and stations** across all major operators in Catalonia (**Rodalies de Catalunya Trains, Moventis, TUSGSAL, Avanza, Monbus, Sagalés, Soler i Sauret, Baixbus, and Mataró Bus**).

🌐 **Live Web App**: [https://bad-amb-bus-tracker.vercel.app/](https://bad-amb-bus-tracker.vercel.app/)

[![Live Deployment](https://img.shields.io/badge/Live-bad--amb--bus--tracker.vercel.app-blueviolet?style=for-the-badge&logo=vercel)](https://bad-amb-bus-tracker.vercel.app/)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.19+-blue.svg)](https://expressjs.com/)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9+-brightgreen.svg)](https://leafletjs.com/)
[![Architecture Guide](https://img.shields.io/badge/Docs-ARCHITECTURE.md-blue.svg)](ARCHITECTURE.md)
[![Tests](https://img.shields.io/badge/Tests-Passing_100%25-success.svg)]()

---

## 📖 System Architecture & Technical Documentation

For developers, contributors, and AI coding assistants:
👉 **[Read the complete ARCHITECTURE.md](ARCHITECTURE.md)** for detailed data flow diagrams, API reverse-engineering schemas, domain algorithms, timezone handling, and provider mappings.

---

## 🧭 The Problem & Our Solution

1. **The AMB Mobilitat Dead Zone**: The official *AMB Mobilitat* app only covers stops inside the 36 metropolitan municipalities (stopping abruptly at Montgat). When interurban lines like **C-10**, **N80**, or **e11.1** travel into the Maresme coastal region (*El Masnou, Premià de Mar, Vilassar de Mar, Cabrera de Mar, Mataró*), vehicles disappear.
2. **Cellular Shadow Drops**: Buses in urban and rural corridors regularly cross cellular dead zones where mobile apps stop rendering them or drop live GPS telemetry.
3. **Multi-Operator Fragmentation**: Catalonia's transit network is scattered across separate portals.
4. **The Solution**: 
   - Unified polymorphic backend integrating **AMB Mobilitat API v2**, **Renfe / Rodalies GTFS-RT**, **Generalitat Mou-te REST API**, **Sagalés Real-time Feeds**, and **Avanza SIRI SOAP service**.
   - Built-in **Dead-Zone Location Estimator (Dead-Reckoning)** with 90-second client-side retention and road-snapped polyline projection.
   - Smart **Night Service (23:00 to 05:00) Timetable Engine** supporting seamless overnight and morning departures.

---

## 🚆 Supported Networks & Operators (288+ Lines)

| Network / Operator | Coverage | Key Lines |
| :--- | :--- | :--- |
| **🚆 Rodalies de Catalunya** | Rodalia de Barcelona & Regionals | `R1`, `R2`, `R2N`, `R2S`, `R3`, `R4`, `R7`, `R8`, `RG1`, `R11`..`R17`, `RL3`, `RL4`, `RT1`, `RT2` |
| **🟡 DIREXIS TUSGSAL** | Barcelonès Nord (Badalona, Santa Coloma, Sant Adrià) & NitBus | `B1`..`B84`, `M1`, `M6`, `M19`, `M26`, `M27`, `M28`, `M30`, NitBus `N0`..`N11`, `N23`..`N28` |
| **🔵 Avanza (Baix Llobregat)** | Baix Llobregat, Castelldefels, Gavà, Viladecans, Exprés & NitBus | `L80`, `L82`, `L85`, `L86`, `L88`, `L94`..`L99`, `X80`..`X97`, `CF1`/`CF2`, `GA1`/`GA2`, `VB1`..`VB4`, `N12`..`N21` |
| **🟠 Monbus & Aerobús** | Aerobús Barcelona & Baix Llobregat | `A1`, `A2`, `L46`, `L52`, `L70`..`L78`, `M5`, `M75`, `X43`..`X79`, `SB1`..`SB3`, `87` |
| **🌊 Moventis / Casas** | Maresme, L'Hospitalet, El Prat & Cerdanyola | `C-10`, `N80`, `N81`, `e11.1`, `e11.2`, `C-20`, `C-30`, `C-3`, `C-12`..`C-15`, `L16`..`L22`, `LH1`/`LH2`, `PR1`..`PR5`, `M12`/`M14`, `X30` |
| **🦉 Sagalés** | NitBus Maresme & Vallès Interurbans | `N82`, `N83`, `603` (Aeroport-Blanes), `N70`, `N71`, `N73` |
| **🟢 Soler i Sauret** | Baix Llobregat & Sant Feliu | `EP1`, `EP2`, `JM`, `JT`, `SF1`..`SF3`, `MB1`..`MB3`, `SV1`..`SV4`, `ESC`, `PF1`, `PF2` |
| **📍 Mataró Bus** | Urbà de Mataró (Avanza) | `L1`, `L2`, `L3`, `L4`, `L5`, `L6`, `L7`, `L8` |
| **🟣 Baixbus / TGO** | Baix Llobregat | `CS1`, `CS2`, `CS3`, `CS4` |

---

## ✨ Key Platform Features

- 🔍 **Universal Stop & Station Searcher**: Search across 7,500+ bus stops and train stations with instant camera jump and target stop selection.
- 🔗 **Direct URL Hash Navigation**: Direct links to any line (e.g. `/#r1`, `/#n80`, `/#b25`, `/#l80`, `/#a1`, `/#c10`).
- 🛰️ **Dead-Zone GPS Location Estimator**:
  - Extrapolates vehicle coordinates along high-definition road polylines during cellular shadow zones.
  - Visual status pill indicators: `🟢 Temps Real Actiu` vs `⚡ Estimació`.
- 🧭 **Cockpit GPS Telemetry Inspector**:
  - High-precision latitude/longitude coordinates.
  - Great-circle compass bearing angle ($0^\circ - 360^\circ$) and compass label (e.g. `NW ↖️`).
  - Vehicle speed ($\text{km/h}$), delay duration, active checkpoint segment, and route progression.
- 🗺️ **Interactive Leaflet Canvas Map**:
  - Continuous 60fps hardware-accelerated gliding animation without teleportation or rubber-banding.
  - Directional road arrows and route polylines rendered in official operator colors.
  - Bus pin rotation matching the vehicle's actual forward direction.
- ⭐ **Persistent Target Stop & Departure Countdowns**:
  - Real-time countdowns (`Imminent`, `3 min`, etc.) with punctual / early / delayed status badges.
- 🔊 **Audio Chimes & Push Notifications**:
  - Synthesized Web Audio API arrival chimes when your bus or train is approaching.

---

## 📡 REST API Documentation

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/lines` | Returns all 288+ transit lines grouped by network. |
| `GET` | `/api/search/stops?q={query}` | Universal search across all stops & train stations in Catalonia. |
| `GET` | `/api/line/:lineId?direction={0\|1}` | Returns stops, polyline geometry, active vehicles, and checkpoints for any line. |
| `GET` | `/api/line/:lineId/target-eta?direction={0\|1}&stopId={id}` | Returns real-time arrival countdown, hero clock, and upcoming departures for a stop. |
| `GET` | `/api/line/:lineId/stop/:stopId/departures?direction={0\|1}` | Returns live departures list for any specific stop. |
| `GET` | `/api/health` | Health check endpoint. |

---

## 🚀 Running Locally & Testing

```bash
# 1. Clone repository
git clone https://github.com/Some1sm/BadAMBBusTracker.git
cd BadAMBBusTracker

# 2. Install dependencies
npm install

# 3. Run automated multi-line E2E tests
npm test

# 4. Start local development server
npm start
# Server will run on http://localhost:3000
```

---

## 🌐 Free Cloud Deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSome1sm%2FBadAMBBusTracker)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Some1sm/BadAMBBusTracker)
