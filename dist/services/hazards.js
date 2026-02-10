import axios from "axios";
const NHC_JSON = "https://www.nhc.noaa.gov/CurrentStorms.json";
const CYCLONE_KEYS = [
    "HURRICANE",
    "TYPHOON",
    "CYCLONE",
    "TROPICAL STORM",
    "TROPICAL DEPRESSION",
    "SEVERE CYCLONIC STORM",
    "VERY SEVERE CYCLONIC STORM",
    "SUPER CYCLONE",
    "GALE WARNING",
    "STORM WARNING",
    "CYCLONIC STORM",
    "TORNADO WATCH",
    "TORNADO WARNING",
];
const FLOOD_KEYS = [
    "FLOOD",
    "FLASH FLOOD",
    "INUNDATION",
    "RIVER FLOOD",
    "URBAN AND SMALL STREAM FLOOD",
];
export function extractHazardsFromAlerts(alerts = []) {
    const norm = (s) => String(s || "").toUpperCase();
    const tags = alerts.map((a) => norm(a.event || a.type || a.category || a.headline || a.title));
    const cycloneHits = tags.filter((t) => CYCLONE_KEYS.some((k) => t.includes(k)));
    const floodHits = tags.filter((t) => FLOOD_KEYS.some((k) => t.includes(k)));
    const cyclone = {
        active: cycloneHits.length > 0,
        count: cycloneHits.length,
        examples: cycloneHits.slice(0, 3),
    };
    const flood = {
        active: floodHits.length > 0,
        count: floodHits.length,
        examples: floodHits.slice(0, 3),
    };
    return { cyclone, flood };
}
export async function nhcCurrentStorms() {
    try {
        const { data } = await axios.get(NHC_JSON, { timeout: 8000 });
        const storms = (data?.activeStorms || data || []).map((s) => ({
            id: s.id || s.stormNumber || s.stormName,
            name: s.name || s.stormName,
            basin: s.basin || s.basinCode,
            status: s.status,
            advisory: s.advisory || s.publicAdvisory,
            lat: s.lat || s.center?.lat,
            lon: s.lon || s.center?.lon,
            maxWindKt: s.maxWind || s.maxWindKT,
            movingDir: s.movingDir,
            movingKts: s.movingSpeed || s.movingKts,
        }));
        return storms;
    }
    catch {
        return [];
    }
}
