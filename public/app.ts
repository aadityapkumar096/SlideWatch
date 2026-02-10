// public/app.ts

// ---------- Types ----------
type LatLng = { lat: number; lon: number };
type StormOverlay = {
  id: string;
  name: string;
  basin: string;
  track: LatLng[];
  cones: LatLng[][];
};

// ---------- DOM helpers ----------
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const latEl = $("#lat") as HTMLInputElement;
const lonEl = $("#lon") as HTMLInputElement;
const searchEl = $("#search") as HTMLInputElement;

// ---------- Google map state ----------
let map: google.maps.Map;
let marker: google.maps.Marker;
let riskOverlay: google.maps.Circle | google.maps.Polyline | null = null;
let trafficLayer: google.maps.TrafficLayer | null = null;
let rainTiles: google.maps.ImageMapType | null = null;
let autocomplete: google.maps.places.Autocomplete | null = null;
let sse: EventSource | null = null;

// ---------- Wire UI events ----------
($("#btnGo") as HTMLButtonElement).addEventListener("click", analyze);
($("#btnWatch") as HTMLButtonElement).addEventListener("click", toggleLive);
($("#btnPOI") as HTMLButtonElement).addEventListener("click", findPOI);
($("#btnExport") as HTMLButtonElement).addEventListener("click", exportReport);
($("#toggleTraffic") as HTMLInputElement).addEventListener("change", toggleTraffic);
($("#toggleRain") as HTMLInputElement).addEventListener("change", toggleRain);
($("#toggleStorms") as HTMLInputElement).addEventListener("change", toggleStorms);

// ---------- Boot ----------
init().catch((err) => console.error(err));

async function init(): Promise<void> {
  const cfg = await (await fetch("/api/config")).json();
  await loadMapsScript(String(cfg.googleMapsJsKey));

  const start = await getStart();
  readyMap(start.lat, start.lon, cfg);

  // Places Autocomplete
  autocomplete = new google.maps.places.Autocomplete(searchEl, { fields: ["geometry", "name"] });
  autocomplete.addListener("place_changed", () => {
    const p = autocomplete!.getPlace();
    if (!p.geometry || !p.geometry.location) return;
    const lat = p.geometry.location.lat();
    const lon = p.geometry.location.lng();
    latEl.value = lat.toFixed(6);
    lonEl.value = lon.toFixed(6);
    void analyze();
  });
}

async function loadMapsScript(key: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Maps JS failed to load"));
    document.head.appendChild(s);
  });
}

async function getStart(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve) => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve({ lat: 12.9716, lon: 77.5946 })
      );
    } else {
      resolve({ lat: 12.9716, lon: 77.5946 });
    }
  });
}

function readyMap(lat: number, lon: number, cfg: Record<string, unknown>): void {
  map = new google.maps.Map($("#map") as HTMLElement, {
    center: { lat, lng: lon },
    zoom: 11,
    mapTypeId: "terrain",
    clickableIcons: false,
    disableDefaultUI: false
  });

  marker = new google.maps.Marker({ position: { lat, lng: lon }, map });

  map.addListener("click", (e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return;
    latEl.value = e.latLng.lat().toFixed(6);
    lonEl.value = e.latLng.lng().toFixed(6);
    void analyze();
  });

  // Rain overlay (OpenWeather tiles) — optional
  const owmKey = (cfg.openWeatherTilesKey as string) || "";
  if (owmKey) {
    rainTiles = new google.maps.ImageMapType({
      getTileUrl: (coord: google.maps.Point, zoom: number): string =>
        `https://tile.openweathermap.org/map/precipitation_new/${zoom}/${coord.x}/${coord.y}.png?appid=${encodeURIComponent(
          owmKey
        )}`,
      tileSize: new google.maps.Size(256, 256),
      name: "OWM Rain"
    });
  }

  void analyze();
}

// ---------- Core actions ----------
async function analyze(): Promise<void> {
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return;

  marker.setPosition({ lat, lng: lon });
  map.panTo({ lat, lng: lon });

  const [tz, risk] = await Promise.all([
    fetchJSON(`/api/timezone?lat=${lat}&lon=${lon}`),
    fetchJSON(`/api/risk?lat=${lat}&lon=${lon}`)
  ]);

  ($("#localTime") as HTMLElement).textContent = tz.timeZoneId
    ? `Local: ${new Date(tz.localTimeIso).toLocaleString()} (${tz.timeZoneId})`
    : "—";

  renderAll(risk);
  drawRisk(lat, lon, risk.risk.risk);
}

function renderAll(data: any): void {
  // Terrain
  const s = data.slope;
  $("#terrain").innerHTML = `
    <div><b>Elevation:</b> ${s.meanElev.toFixed(0)} m</div>
    <div><b>Inclination (slope):</b> ${s.slopeDeg.toFixed(1)}°</div>
    <div><b>Tilt (aspect):</b> ${s.aspectDeg.toFixed(0)}° from North</div>
  `;

  // Weather + alerts
  const h = data.hydro;
  $("#weather").innerHTML = `
    <div>Rain last 1h: ${fmtMM(h.mm1h)}</div>
    <div>Rain last 24h: ${fmtMM(h.mm24h)}</div>
    <div>Rain last 72h: ${fmtMM(h.mm72h)}</div>
    <div>Forecast next 6h: ${fmtMM(h.forecast6h)}</div>
    <div>Humidity: ${h.humidity}%</div>
  `;
  const alertsBox = $("#alerts");
  alertsBox.innerHTML = "";
  (h.alerts || []).slice(0, 6).forEach((a: any) => {
    const div = document.createElement("div");
    div.className = "alert";
    div.textContent =
      (a.event || a.type || "Alert") + ": " + (a.description || a.text || a.headline || "");
    alertsBox.appendChild(div);
  });

  // Cyclone/Flood flags
  const hz = data.hazards || { cyclone: { active: false }, flood: { active: false } };
  $("#cyclone").innerHTML = hz.cyclone.active
    ? `<span class="chip danger">⚠️ Cyclone-related alerts</span> <small>${hz.cyclone.examples.join(
        " · "
      )}</small>`
    : `<span class="chip ok">No cyclone alerts</span>`;
  $("#flood").innerHTML = hz.flood.active
    ? `<span class="chip warn">⚠️ Flood alerts</span> <small>${hz.flood.examples.join(" · ")}</small>`
    : `<span class="chip ok">No flood alerts</span>`;

  // Quakes
  const q = data.quakeHazard;
  const strongest = q.strongest;
  $("#quakes").innerHTML = strongest
    ? `<div><b>Nearest strong quake:</b> M ${strongest.magnitude.toFixed(
        1
      )}, ${strongest.distanceKm.toFixed(0)} km</div>
       <div>Earthquake hazard index: ${q.hazard}/100</div>`
    : "No recent earthquakes within 300 km.";

  // Tsunami
  $("#tsunami").textContent = data.tsunami.active
    ? `⚠️ ${data.tsunami.headline || "Tsunami bulletin active"}`
    : "No active tsunami bulletins.";

  // Risk
  const r = data.risk;
  const riskEl = $("#riskScore");
  riskEl.textContent = `${r.risk}/100 — ${r.level}`;
  riskEl.className = `risk ${r.level.toLowerCase()}`;
  $("#riskBreakdown").innerHTML = `
    <li>Slope factor: ${(r.components.slopeScore * 100).toFixed(0)}/100</li>
    <li>Wetness factor: ${(r.components.wetScore * 100).toFixed(0)}/100 (ARI: ${fmtMM(
      r.components.ari
    )})</li>
    <li>Soil moisture (EMI): ${fmtMM(r.components.emi)}</li>
    <li>Seismic trigger: ${(r.components.seismicScore * 100).toFixed(0)}/100</li>
    <li>Tsunami boost: ${r.components.tsunami ? "Yes" : "No"}</li>
  `;
  $("#emiNote").textContent = `EMI: exponential blend of recent rainfall history (half-life 3 days).`;
}

function drawRisk(lat: number, lon: number, score: number): void {
  if (riskOverlay) riskOverlay.setMap(null);
  const color = score < 25 ? "#5df2a2" : score < 50 ? "#ffd166" : score < 75 ? "#ff6b6b" : "#ffb3b3";
  riskOverlay = new google.maps.Circle({
    map,
    center: { lat, lng: lon },
    radius: Math.max(300, Math.min(2000, score * 20)),
    strokeColor: color,
    strokeOpacity: 0.9,
    strokeWeight: 2,
    fillColor: color,
    fillOpacity: 0.18
  });
}

// ---------- POIs & routing ----------
async function findPOI(): Promise<void> {
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  const type = (document.querySelector("#poiType") as HTMLSelectElement).value;
  const data = await fetchJSON(`/api/places?lat=${lat}&lon=${lon}&type=${encodeURIComponent(type)}`);
  const list = $("#poiList");
  list.innerHTML = "";
  (data.places as any[]).slice(0, 8).forEach((p: any) => {
    const li = document.createElement("li");
    li.textContent = `${p.name} (${p.rating ?? "?"}★) - ${p.address || ""}`;
    li.addEventListener("click", () => void routeTo({ lat: p.loc.lat, lon: p.loc.lng }));
    list.appendChild(li);
  });
}

async function routeTo(dest: LatLng): Promise<void> {
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  const o = `${lat},${lon}`;
  const d = `${dest.lat},${dest.lon}`;
  const data = await fetchJSON(
    `/api/routes?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&mode=driving`
  );
  const best = (data.routes as any[])[0];

  const path = decodePolyline(String(best.polyline)).map(([a, b]) => ({ lat: a, lng: b }));
  if (riskOverlay) riskOverlay.setMap(null);
  const line = new google.maps.Polyline({
    map,
    path,
    strokeColor: "#7bd4ff",
    strokeOpacity: 0.9,
    strokeWeight: 4
  });
  riskOverlay = line;
  map.fitBounds(boundsOf(path));
}

// ---------- Storm tracks & cones ----------
let stormLayers: Array<google.maps.Polygon | google.maps.Polyline> = [];

async function toggleStorms(e: Event): Promise<void> {
  const on = (e.target as HTMLInputElement).checked;
  clearStorms();
  if (!on) return;
  const data = await fetchJSON("/api/stormOverlays");
  const storms: StormOverlay[] = (data.storms as StormOverlay[]) || [];
  storms.forEach((s) => {
    if (s.track?.length) {
      const path = s.track.map((p) => ({ lat: p.lat, lng: p.lon }));
      const line = new google.maps.Polyline({
        map,
        path,
        strokeColor: "#67e8f9",
        strokeOpacity: 1,
        strokeWeight: 3,
        icons: [
          {
            icon: {
              path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
              scale: 2,
              strokeColor: "#a78bfa"
            },
            offset: "100%"
          }
        ]
      });
      stormLayers.push(line);
    }
    (s.cones || []).forEach((poly) => {
      const path = poly.map((p) => ({ lat: p.lat, lng: p.lon }));
      const pg = new google.maps.Polygon({
        map,
        paths: path,
        strokeColor: "#a78bfa",
        strokeOpacity: 0.9,
        strokeWeight: 1.5,
        fillColor: "#a78bfa",
        fillOpacity: 0.18
      });
      stormLayers.push(pg);
    });
  });
}

function clearStorms(): void {
  stormLayers.forEach((l) => l.setMap(null));
  stormLayers = [];
}

// ---------- Toggles ----------
function toggleTraffic(e: Event): void {
  if (!trafficLayer) trafficLayer = new google.maps.TrafficLayer();
  (e.target as HTMLInputElement).checked ? trafficLayer.setMap(map) : trafficLayer.setMap(null);
}

function toggleRain(e: Event): void {
  if (!rainTiles) {
    (e.target as HTMLInputElement).checked = false;
    alert("Rain overlay requires OpenWeather key.");
    return;
  }
  const on = (e.target as HTMLInputElement).checked;
  if (on) map.overlayMapTypes.insertAt(0, rainTiles);
  else {
    for (let i = 0; i < map.overlayMapTypes.getLength(); i++) {
      if (map.overlayMapTypes.getAt(i) === rainTiles) {
        map.overlayMapTypes.removeAt(i);
        break;
      }
    }
  }
}

// ---------- Live stream ----------
async function toggleLive(): Promise<void> {
  const btn = $("#btnWatch") as HTMLButtonElement;
  if (sse) {
    sse.close();
    sse = null;
    btn.textContent = "Start Live";
    return;
  }
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  sse = new EventSource(`/api/stream?lat=${lat}&lon=${lon}`);
  sse.addEventListener("update", (msg: Event) => {
    const data = JSON.parse((msg as MessageEvent).data as string);
    renderAll(data);
  });
  sse.addEventListener("error", () => {
    // ignore; server may reconnect next tick
  });
  btn.textContent = "Stop Live";
}

// ---------- Export ----------
async function exportReport(): Promise<void> {
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  const risk = await fetchJSON(`/api/risk?lat=${lat}&lon=${lon}`);
  const payload = { generatedAt: new Date().toISOString(), lat, lon, ...risk };
  const name = `hazard-${lat.toFixed(4)}_${lon.toFixed(4)}-${Date.now()}.json`;
  const res = await fetch("/api/saveReport", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, payload })
  });
  const out = await res.json();
  ($("#exportStatus") as HTMLElement).textContent = out.fileId
    ? `Saved: ${out.name}`
    : `Failed: ${out.error}`;
}

// ---------- Utils ----------
async function fetchJSON<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as T;
}

function fmtMM(v: number): string {
  return `${Number(v || 0).toFixed(1)} mm`;
}

function decodePolyline(str: string): [number, number][] {
  let index = 0,
    lat = 0,
    lng = 0;
  const coordinates: [number, number][] = [];
  while (index < str.length) {
    let b: number,
      shift = 0,
      result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : result >> 1;

    lat += dlat;
    lng += dlng;
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

function boundsOf(path: Array<{ lat: number; lng: number }>): google.maps.LatLngBounds {
  const b = new google.maps.LatLngBounds();
  path.forEach((p) => b.extend(p));
  return b;
}