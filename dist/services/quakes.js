import axios from "axios";
import { haversineKm } from "../risk-model.js";
const FEEDS = {
    day: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson"
};
export async function getNearbyQuakes(lat, lon, withinKm = 300) {
    const { data } = await axios.get(FEEDS.day, { timeout: 10000 });
    const feats = data.features || [];
    const list = feats
        .map((f) => {
        const [qLon, qLat, depthKm] = f.geometry.coordinates;
        const distanceKm = haversineKm({ lat, lon }, { lat: qLat, lon: qLon });
        return {
            id: f.id,
            magnitude: f.properties.mag,
            place: f.properties.place,
            time: f.properties.time,
            distanceKm,
            depthKm
        };
    })
        .filter((q) => q.distanceKm <= withinKm);
    return list.sort((a, b) => b.magnitude - a.magnitude);
}
