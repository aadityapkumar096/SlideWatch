// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import { fetchElevationGrid, fetchTimezone, fetchRoutes, nearbyPlaces } from "./services/google.js";
import { openWeatherPack, accuWeatherAlerts } from "./services/weather.js";
import { getNearbyQuakes } from "./services/quakes.js";
import { tsunamiState } from "./services/tsunami.js";
import { uploadJsonReport } from "./services/drive.js";
import { slopeFromGrid, computeRisk, quakeHazard } from "./risk-model.js";
import { cacheGet, cacheSet, cacheKey } from "./services/cache.js";
import { storeRain, computeEMI } from "./storage/history.js";
import { extractHazardsFromAlerts, nhcCurrentStorms } from "./services/hazards.js";
import { fetchStormOverlays } from "./services/storms.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 8080);
const HALF_LIFE = Number(process.env.EMI_HALFLIFE_DAYS || 3);

// ---- Env diagnostics (masked) ----
const mask = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "null");
function envReport() {
  return {
    GOOGLE_MAPS_JS_KEY: !!process.env.GOOGLE_MAPS_JS_KEY,
    GOOGLE_MAPS_WEB_KEY: !!process.env.GOOGLE_MAPS_WEB_KEY,
    OPENWEATHER_API_KEY: !!process.env.OPENWEATHER_API_KEY,
    ACCUWEATHER_API_KEY: !!process.env.ACCUWEATHER_API_KEY,
    GOOGLE_DRIVE_FOLDER_ID: !!process.env.GOOGLE_DRIVE_FOLDER_ID
  };
}
const r = envReport();
console.log(
  "ENV → JS:", mask(process.env.GOOGLE_MAPS_JS_KEY),
  "WEB:", mask(process.env.GOOGLE_MAPS_WEB_KEY),
  "OW:", r.OPENWEATHER_API_KEY,
  "AW:", r.ACCUWEATHER_API_KEY
);
if (process.env.STRICT_ENV === "true") {
  const missing = Object.entries(r).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error("❌ Missing required env:", missing.join(", "));
    process.exit(1);
  }
}

// Health
app.get("/api/health", (_req: Request, res: Response) =>
  res.json({ ok: true, time: new Date().toISOString(), env: envReport() })
);

// Frontend config (what the client needs)
app.get("/api/config", (_req: Request, res: Response) => {
  res.json({
    googleMapsJsKey: process.env.GOOGLE_MAPS_JS_KEY || null,
    openWeatherTilesKey: process.env.OPENWEATHER_API_KEY || null
  });
});

// Timezone
app.get("/api/timezone", async (req: Request, res: Response) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const key = cacheKey("tz", { lat, lon });
    const cached = await cacheGet(key);
    if (cached) return res.json(cached);

    const ts = Math.floor(Date.now() / 1000);
    const tz = await fetchTimezone(lat, lon, ts);
    const local = new Date(Date.now() + tz.totalOffsetSec * 1000 - new Date().getTimezoneOffset() * 60000);
    const out = { ...tz, localTimeIso: local.toISOString() };
    await cacheSet(key, out);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Terrain / slope
app.get("/api/terrain", async (req: Request, res: Response) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const key = cacheKey("terrain", { lat, lon });
    const cached = await cacheGet(key);
    if (cached) return res.json(cached);

    const grid = await fetchElevationGrid(lat, lon, 5, 30);
    const slope = slopeFromGrid(grid.elevGrid, grid.cellSizeMeters);
    const out = { grid, slope };
    await cacheSet(key, out, 600);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Weather + alerts
app.get("/api/weather", async (req: Request, res: Response) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const key = cacheKey("weather", { lat, lon });
    const cached = await cacheGet(key);
    if (cached) return res.json(cached);

    const ow = await openWeatherPack(lat, lon);
    const awAlerts = await accuWeatherAlerts(lat, lon).catch(() => []);
    const alerts = [...(ow.alerts || []), ...awAlerts];

    storeRain(lat, lon, Date.now(), ow);

    const out = { hydro: { ...ow, alerts } };
    await cacheSet(key, out);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Earthquakes
app.get("/api/earthquakes", async (req: Request, res: Response) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const withinKm = Number(req.query.withinKm || 300);
    const key = cacheKey("quakes", { lat, lon, withinKm });
    const cached = await cacheGet(key);
    if (cached) return res.json(cached);

    const quakes = await getNearbyQuakes(lat, lon, withinKm);
    const out = { quakes };
    await cacheSet(key, out, 60);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Tsunami
app.get("/api/tsunami", async (_req: Request, res: Response) => {
  try {
    const key = "tsunami";
    const cached = await cacheGet(key);
    if (cached) return res.json(cached);
    const out = { tsunami: await tsunamiState() };
    await cacheSet(key, out, 120);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Cyclones
app.get("/api/cyclones", async (_req: Request, res: Response) => {
  try {
    const key = "nhc";
    const cached = await cacheGet(key);
    if (cached) return res.json(cached);
    const storms = await nhcCurrentStorms();
    const out = { storms };
    await cacheSet(key, out, 300);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Storm tracks + cones
app.get("/api/stormOverlays", async (_req: Request, res: Response) => {
  try {
    const key = "stormOverlays";
    const cached = await cacheGet(key);
    if (cached) return res.json(cached);
    const overlays = await fetchStormOverlays();
    await cacheSet(key, overlays, 300);
    res.json(overlays);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Routing
app.get("/api/routes", async (req: Request, res: Response) => {
  try {
    const origin = String(req.query.origin);
    const destination = String(req.query.destination);
    const mode = String(req.query.mode || "driving");
    const avoid = String(req.query.avoid || "ferries").split("|");
    const routes = await fetchRoutes(origin, destination, { mode, avoid });
    res.json({ routes });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Emergency POIs
app.get("/api/places", async (req: Request, res: Response) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const type = String(req.query.type || "hospital");
    const key = cacheKey("places", { lat, lon, type });
    const cached = await cacheGet(key);
    if (cached) return res.json(cached);
    const places = await nearbyPlaces(lat, lon, type, 10000);
    const out = { places };
    await cacheSet(key, out, 300);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Combined risk
app.get("/api/risk", async (req: Request, res: Response) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const [grid, weather, quakes, tsu] = await Promise.all([
      fetchElevationGrid(lat, lon, 5, 30),
      openWeatherPack(lat, lon),
      getNearbyQuakes(lat, lon, 300),
      tsunamiState()
    ]);

    storeRain(lat, lon, Date.now(), weather);
    const emi = computeEMI(lat, lon, Date.now(), HALF_LIFE);

    const slope = slopeFromGrid(grid.elevGrid, grid.cellSizeMeters);
    const signals = { slope, hydro: weather, quakes, tsunami: tsu, emi };
    const risk = computeRisk(signals);
    const qu = quakeHazard(quakes);

    const awAlerts = await accuWeatherAlerts(lat, lon).catch(() => []);
    const hazards = extractHazardsFromAlerts([...(weather.alerts || []), ...awAlerts]);

    res.json({ slope, hydro: weather, quakes, tsunami: tsu, emi, risk, quakeHazard: qu, hazards });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Drive export
app.post("/api/saveReport", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { name?: string; payload?: unknown };
    const name = body.name || `hazard-report-${Date.now()}.json`;
    const payload = body.payload || {};
    const out = await uploadJsonReport(name, payload);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// SSE stream
app.get("/api/stream", (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

  const tick = async () => {
    try {
      const [grid, weather, quakes, tsu] = await Promise.all([
        fetchElevationGrid(lat, lon, 5, 30),
        openWeatherPack(lat, lon),
        getNearbyQuakes(lat, lon, 300),
        tsunamiState()
      ]);
      storeRain(lat, lon, Date.now(), weather);
      const emi = computeEMI(lat, lon, Date.now(), HALF_LIFE);

      const slope = slopeFromGrid(grid.elevGrid, grid.cellSizeMeters);
      const signals = { slope, hydro: weather, quakes, tsunami: tsu, emi };
      const risk = computeRisk(signals);
      const qu = quakeHazard(quakes);
      const awAlerts = await accuWeatherAlerts(lat, lon).catch(() => []);
      const hazards = extractHazardsFromAlerts([...(weather.alerts || []), ...awAlerts]);

      res.write(`event: update\n`);
      res.write(`data: ${JSON.stringify({ slope, hydro: weather, quakes, tsunami: tsu, emi, risk, quakeHazard: qu, hazards })}\n\n`);
    } catch (e: any) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: e.message || String(e) })}\n\n`);
    }
  };

  const iv = setInterval(tick, 60_000);
  tick();
  req.on("close", () => clearInterval(iv));
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));