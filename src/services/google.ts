import axios from "axios";

const BASE = "https://maps.googleapis.com/maps/api";

function mapsKey(): string {
  const k = process.env.GOOGLE_MAPS_WEB_KEY || "";
  if (!k) throw new Error("GOOGLE_MAPS_WEB_KEY is missing (set it in .env)");
  return k;
}

export async function fetchElevationGrid(lat: number, lon: number, grid = 5, spacingMeters = 30) {
  const KEY = mapsKey();
  const cell = spacingMeters;
  const dLat = cell / 111320;
  const dLon = cell / (111320 * Math.cos((lat * Math.PI) / 180));
  const locs: string[] = [];
  const half = Math.floor(grid / 2);
  for (let i = -half; i <= half; i++) {
    for (let j = -half; j <= half; j++) {
      locs.push(`${(lat + i * dLat).toFixed(6)},${(lon + j * dLon).toFixed(6)}`);
    }
  }
  const url = `${BASE}/elevation/json?locations=${encodeURIComponent(locs.join("|"))}&key=${KEY}`;
  const { data } = await axios.get(url);
  if (data.status !== "OK") throw new Error(`Elevation API: ${data.status}`);
  const values: number[] = data.results.map((r: any) => r.elevation);
  const grid2D: number[][] = [];
  for (let i = 0; i < grid; i++) grid2D.push(values.slice(i * grid, (i + 1) * grid));
  return { elevGrid: grid2D, cellSizeMeters: spacingMeters };
}

export async function fetchTimezone(lat: number, lon: number, timestampSec: number) {
  const KEY = mapsKey();
  const url = `${BASE}/timezone/json?location=${lat},${lon}&timestamp=${timestampSec}&key=${KEY}`;
  const { data } = await axios.get(url);
  if (data.status !== "OK") throw new Error(`Time Zone API: ${data.status}`);
  const totalOffset = data.rawOffset + data.dstOffset;
  return { timeZoneId: data.timeZoneId as string, totalOffsetSec: totalOffset as number };
}

export async function fetchRoutes(
  origin: string,
  destination: string,
  opts: { mode?: string; avoid?: string[] } = {}
) {
  const KEY = mapsKey();
  const params = new URLSearchParams({
    origin,
    destination,
    alternatives: "true",
    mode: opts.mode || "driving",
    departure_time: "now",
    traffic_model: "best_guess",
    avoid: (opts.avoid || []).join("|"),
  });
  const url = `${BASE}/directions/json?${params.toString()}&key=${KEY}`;
  const { data } = await axios.get(url);
  if (data.status !== "OK") throw new Error(`Directions API: ${data.status}`);
  return data.routes.map((r: any) => ({
    summary: r.summary,
    legs: r.legs,
    warnings: r.warnings || [],
    polyline: r.overview_polyline.points,
  }));
}

export async function nearbyPlaces(lat: number, lon: number, type = "hospital", radius = 5000) {
  const KEY = mapsKey();
  const url = `${BASE}/place/nearbysearch/json?location=${lat},${lon}&radius=${radius}&type=${type}&key=${KEY}`;
  const { data } = await axios.get(url);
  if (data.status !== "OK") throw new Error(`Places API: ${data.status}`);
  return data.results.map((p: any) => ({
    name: p.name as string,
    loc: p.geometry?.location,
    address: p.vicinity as string,
    place_id: p.place_id as string,
    rating: p.rating as number,
  }));
}
