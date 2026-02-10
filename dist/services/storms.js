import axios from "axios";
import { parseStringPromise } from "xml2js";
/**
 * We read the NHC GIS Atom feeds for Atlantic & E. Pacific.
 * Each feed lists KML resources (track + cone). We pick the latest per storm.
 */
const FEEDS = [
    "https://www.nhc.noaa.gov/gis-at.xml", // Atlantic
    "https://www.nhc.noaa.gov/gis-ep.xml" // East Pacific
];
export async function fetchStormOverlays() {
    const entries = (await Promise.all(FEEDS.map(fetchAtom))).flat();
    // Group by storm id/name; fetch KMLs (track & cone)
    const byStorm = new Map();
    for (const e of entries) {
        // Titles are like "AL05 Forecast Track, Cone, and Watch/Warning Graphics"
        const title = e.title.toUpperCase();
        const idMatch = title.match(/\b(AL|EP|CP)\d{2}\b/);
        const stormId = idMatch?.[0] || e.title;
        const basin = idMatch ? idMatch[1] : "UNK";
        const prev = byStorm.get(stormId) || { name: stormId, basin };
        if (/TRACK/i.test(title) || /FORECAST TRACK/i.test(title)) {
            prev.trackUrl = e.link;
        }
        if (/CONE/i.test(title)) {
            prev.coneUrl = e.link;
        }
        byStorm.set(stormId, prev);
    }
    const storms = [];
    for (const [id, info] of byStorm.entries()) {
        const track = info.trackUrl ? await parseTrackKml(info.trackUrl).catch(() => []) : [];
        const cones = info.coneUrl ? await parseConeKml(info.coneUrl).catch(() => []) : [];
        if (track.length || cones.length) {
            storms.push({ id, name: info.name, basin: info.basin, track, cones });
        }
    }
    return { storms };
}
async function fetchAtom(feedUrl) {
    try {
        const { data } = await axios.get(feedUrl, { timeout: 10000 });
        const xml = await parseStringPromise(data);
        const entries = xml?.feed?.entry || [];
        return entries
            .map((e) => ({
            title: String(e.title?.[0] || ""),
            link: String(e.link?.[0]?.$.href || e.id?.[0] || "")
        }))
            .filter((x) => x.link.endsWith(".kml"));
    }
    catch {
        return [];
    }
}
// KML helpers
function coordsToLatLon(coordStr) {
    return coordStr
        .trim()
        .split(/\s+/)
        .map((p) => p.split(",").map(Number))
        .filter((a) => a.length >= 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]))
        .map(([lon, lat]) => ({ lat, lon }));
}
async function parseTrackKml(url) {
    const { data } = await axios.get(url, { timeout: 10000 });
    const xml = await parseStringPromise(data);
    // Try to find LineString coordinates
    const lines = findAll(xml, ["kml", "Document", "Placemark", "LineString", "coordinates"]);
    if (lines.length) {
        const merged = lines.map((arr) => String(arr[0] || "")).join(" ");
        return coordsToLatLon(merged);
    }
    return [];
}
async function parseConeKml(url) {
    const { data } = await axios.get(url, { timeout: 10000 });
    const xml = await parseStringPromise(data);
    // Find Polygon/LinearRing/coordinates blocks
    const rings = findAll(xml, ["kml", "Document", "Placemark", "Polygon", "outerBoundaryIs", "LinearRing", "coordinates"]);
    return rings.map((arr) => coordsToLatLon(String(arr[0] || "")));
}
// Tiny XML path finder (depth-insensitive)
function findAll(obj, path) {
    const out = [];
    function dfs(node, depth) {
        if (!node)
            return;
        if (depth === path.length) {
            out.push(node);
            return;
        }
        const key = path[depth];
        const children = node[key];
        if (Array.isArray(children)) {
            for (const c of children)
                dfs(c, depth + 1);
        }
        else if (children) {
            dfs(children, depth + 1);
        }
        // Also scan other keys to be resilient to folder structures
        for (const k of Object.keys(node || {})) {
            const v = node[k];
            if (typeof v === "object")
                dfs(v, depth);
        }
    }
    dfs(obj, 0);
    return out;
}
