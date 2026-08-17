# 🚀 Railway 1-Click Deployment Guide

This guide walks you through deploying **Bad AMB Bus Tracker** with the **Centralized Flight Recorder & Persistent SQLite Database** on **[Railway.app](https://railway.app)**.

---

### Step 1: Push Changes to GitHub
Make sure all your latest changes are pushed to your GitHub repository (`Some1sm/BadAMBBusTracker`):
```bash
git push origin main
```

---

### Step 2: Create a New Project on Railway
1. Go to **[railway.app](https://railway.app)** and log in (with your GitHub account).
2. Click **"+ New Project"**.
3. Select **"Deploy from GitHub repo"**.
4. Choose **`Some1sm/BadAMBBusTracker`**.

Railway will automatically detect the [`Dockerfile`](Dockerfile) and [`railway.json`](railway.json) and begin the build.

---

### Step 3: Attach Persistent Storage (For SQLite DB)
To ensure your historical delay logs and telemetry survive redeploys:
1. In your Railway project dashboard, click on your service card.
2. Go to the **"Volumes"** tab (or click **"+ New"** $\rightarrow$ **"Volume"**).
3. Set the **Mount Path** to:
   ```
   /app/data
   ```
4. Click **"Add Volume"**.

---

### Step 4: Generate a Public Domain
1. In your service settings on Railway, go to the **"Settings"** tab.
2. Scroll down to the **"Networking"** / **"Public Networking"** section.
3. Click **"Generate Domain"** (or add your own custom domain).
4. Open the generated URL (e.g. `https://badambbustracker-production.up.railway.app`) in your browser!

---

### ✅ What Will Happen on Railway:
- **24/7 Autonomous Ingestion**: The background daemon will run continuously, sampling all Catalonia bus routes.
- **Persistent Data Journalism DB**: All delay records and vehicle snapshots will be saved directly into `/app/data/transit_history.db`.
- **Zero Upstream Spam**: Hundreds of users visiting your Railway domain will query your Railway container's memory/SQLite database in **<3ms** without overloading official transport servers.
