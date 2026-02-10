"use strict";
// public/app.ts
// ---------- DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const latEl = $("#lat");
const lonEl = $("#lon");
const searchEl = $("#search");
// ---------- Google map state ----------
let map;
let marker;
let riskOverlay = null;
let trafficLayer = null;
let rainTiles = null;
let autocomplete = null;
let sse = null;
// ---------- Wire UI events ----------
$("#btnGo").addEventListener("click", analyze);
$("#btnWatch").addEventListener("click", toggleLive);
$("#btnPOI").addEventListener("click", findPOI);
$("#btnExport").addEventListener("click", exportReport);
$("#toggleTraffic").addEventListener("change", toggleTraffic);
$("#toggleRain").addEventListener("change", toggleRain);
$("#toggleStorms").addEventListener("change", toggleStorms);
// ---------- Boot ----------
init().catch((err) => console.error(err));
async function init() {
    const cfg = await (await fetch("/api/config")).json();
    await loadMapsScript(String(cfg.googleMapsJsKey));
    const start = await getStart();
    readyMap(start.lat, start.lon, cfg);
    // Places Autocomplete
    autocomplete = new google.maps.places.Autocomplete(searchEl, { fields: ["geometry", "name"] });
    autocomplete.addListener("place_changed", () => {
        const p = autocomplete.getPlace();
        if (!p.geometry || !p.geometry.location)
            return;
        const lat = p.geometry.location.lat();
        const lon = p.geometry.location.lng();
        latEl.value = lat.toFixed(6);
        lonEl.value = lon.toFixed(6);
        void analyze();
    });
}
async function loadMapsScript(key) {
    await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places`;
        s.async = true;
        s.defer = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("Maps JS failed to load"));
        document.head.appendChild(s);
    });
}
async function getStart() {
    return new Promise((resolve) => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }), () => resolve({ lat: 12.9716, lon: 77.5946 }));
        }
        else {
            resolve({ lat: 12.9716, lon: 77.5946 });
        }
    });
}
function readyMap(lat, lon, cfg) {
    map = new google.maps.Map($("#map"), {
        center: { lat, lng: lon },
        zoom: 11,
        mapTypeId: "terrain",
        clickableIcons: false,
        disableDefaultUI: false
    });
    marker = new google.maps.Marker({ position: { lat, lng: lon }, map });
    map.addListener("click", (e) => {
        if (!e.latLng)
            return;
        latEl.value = e.latLng.lat().toFixed(6);
        lonEl.value = e.latLng.lng().toFixed(6);
        void analyze();
    });
    // Rain overlay (OpenWeather tiles) — optional
    const owmKey = cfg.openWeatherTilesKey || "";
    if (owmKey) {
        rainTiles = new google.maps.ImageMapType({
            getTileUrl: (coord, zoom) => `https://tile.openweathermap.org/map/precipitation_new/${zoom}/${coord.x}/${coord.y}.png?appid=${encodeURIComponent(owmKey)}`,
            tileSize: new google.maps.Size(256, 256),
            name: "OWM Rain"
        });
    }
    void analyze();
}
// ---------- Core actions ----------
async function analyze() {
    const lat = parseFloat(latEl.value);
    const lon = parseFloat(lonEl.value);
    if (Number.isNaN(lat) || Number.isNaN(lon))
        return;
    marker.setPosition({ lat, lng: lon });
    map.panTo({ lat, lng: lon });
    const [tz, risk] = await Promise.all([
        fetchJSON(`/api/timezone?lat=${lat}&lon=${lon}`),
        fetchJSON(`/api/risk?lat=${lat}&lon=${lon}`)
    ]);
    $("#localTime").textContent = tz.timeZoneId
        ? `Local: ${new Date(tz.localTimeIso).toLocaleString()} (${tz.timeZoneId})`
        : "—";
    renderAll(risk);
    drawRisk(lat, lon, risk.risk.risk);
}
function renderAll(data) {
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
    (h.alerts || []).slice(0, 6).forEach((a) => {
        const div = document.createElement("div");
        div.className = "alert";
        div.textContent =
            (a.event || a.type || "Alert") + ": " + (a.description || a.text || a.headline || "");
        alertsBox.appendChild(div);
    });
    // Cyclone/Flood flags
    const hz = data.hazards || { cyclone: { active: false }, flood: { active: false } };
    $("#cyclone").innerHTML = hz.cyclone.active
        ? `<span class="chip danger">⚠️ Cyclone-related alerts</span> <small>${hz.cyclone.examples.join(" · ")}</small>`
        : `<span class="chip ok">No cyclone alerts</span>`;
    $("#flood").innerHTML = hz.flood.active
        ? `<span class="chip warn">⚠️ Flood alerts</span> <small>${hz.flood.examples.join(" · ")}</small>`
        : `<span class="chip ok">No flood alerts</span>`;
    // Quakes
    const q = data.quakeHazard;
    const strongest = q.strongest;
    $("#quakes").innerHTML = strongest
        ? `<div><b>Nearest strong quake:</b> M ${strongest.magnitude.toFixed(1)}, ${strongest.distanceKm.toFixed(0)} km</div>
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
    <li>Wetness factor: ${(r.components.wetScore * 100).toFixed(0)}/100 (ARI: ${fmtMM(r.components.ari)})</li>
    <li>Soil moisture (EMI): ${fmtMM(r.components.emi)}</li>
    <li>Seismic trigger: ${(r.components.seismicScore * 100).toFixed(0)}/100</li>
    <li>Tsunami boost: ${r.components.tsunami ? "Yes" : "No"}</li>
  `;
    $("#emiNote").textContent = `EMI: exponential blend of recent rainfall history (half-life 3 days).`;
}
function drawRisk(lat, lon, score) {
    if (riskOverlay)
        riskOverlay.setMap(null);
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
async function findPOI() {
    const lat = parseFloat(latEl.value);
    const lon = parseFloat(lonEl.value);
    const type = document.querySelector("#poiType").value;
    const data = await fetchJSON(`/api/places?lat=${lat}&lon=${lon}&type=${encodeURIComponent(type)}`);
    const list = $("#poiList");
    list.innerHTML = "";
    data.places.slice(0, 8).forEach((p) => {
        const li = document.createElement("li");
        li.textContent = `${p.name} (${p.rating ?? "?"}★) - ${p.address || ""}`;
        li.addEventListener("click", () => void routeTo({ lat: p.loc.lat, lon: p.loc.lng }));
        list.appendChild(li);
    });
}
async function routeTo(dest) {
    const lat = parseFloat(latEl.value);
    const lon = parseFloat(lonEl.value);
    const o = `${lat},${lon}`;
    const d = `${dest.lat},${dest.lon}`;
    const data = await fetchJSON(`/api/routes?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&mode=driving`);
    const best = data.routes[0];
    const path = decodePolyline(String(best.polyline)).map(([a, b]) => ({ lat: a, lng: b }));
    if (riskOverlay)
        riskOverlay.setMap(null);
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
let stormLayers = [];
async function toggleStorms(e) {
    const on = e.target.checked;
    clearStorms();
    if (!on)
        return;
    const data = await fetchJSON("/api/stormOverlays");
    const storms = data.storms || [];
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
function clearStorms() {
    stormLayers.forEach((l) => l.setMap(null));
    stormLayers = [];
}
// ---------- Toggles ----------
function toggleTraffic(e) {
    if (!trafficLayer)
        trafficLayer = new google.maps.TrafficLayer();
    e.target.checked ? trafficLayer.setMap(map) : trafficLayer.setMap(null);
}
function toggleRain(e) {
    if (!rainTiles) {
        e.target.checked = false;
        alert("Rain overlay requires OpenWeather key.");
        return;
    }
    const on = e.target.checked;
    if (on)
        map.overlayMapTypes.insertAt(0, rainTiles);
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
async function toggleLive() {
    const btn = $("#btnWatch");
    if (sse) {
        sse.close();
        sse = null;
        btn.textContent = "Start Live";
        return;
    }
    const lat = parseFloat(latEl.value);
    const lon = parseFloat(lonEl.value);
    sse = new EventSource(`/api/stream?lat=${lat}&lon=${lon}`);
    sse.addEventListener("update", (msg) => {
        const data = JSON.parse(msg.data);
        renderAll(data);
    });
    sse.addEventListener("error", () => {
        // ignore; server may reconnect next tick
    });
    btn.textContent = "Stop Live";
}
// ---------- Export ----------
async function exportReport() {
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
    $("#exportStatus").textContent = out.fileId
        ? `Saved: ${out.name}`
        : `Failed: ${out.error}`;
}
// ---------- Utils ----------
async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok)
        throw new Error(await r.text());
    return (await r.json());
}
function fmtMM(v) {
    return `${Number(v || 0).toFixed(1)} mm`;
}
function decodePolyline(str) {
    let index = 0, lat = 0, lng = 0;
    const coordinates = [];
    while (index < str.length) {
        let b, shift = 0, result = 0;
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
function boundsOf(path) {
    const b = new google.maps.LatLngBounds();
    path.forEach((p) => b.extend(p));
    return b;
}
