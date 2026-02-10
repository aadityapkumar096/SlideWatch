import axios from "axios";
import { haversineKm } from "../risk-model.js";

const FEEDS = {
  day: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson"
};

export async function getNearbyQuakes(lat: number, lon: number, withinKm = 300) {
  const { data } = await axios.get(FEEDS.day, { timeout: 10000 });
  const feats = data.features || [];
  const list = feats
    .map((f: any) => {
      const [qLon, qLat, depthKm] = f.geometry.coordinates;
      const distanceKm = haversineKm({ lat, lon }, { lat: qLat, lon: qLon });
      return {
        id: f.id as string,
        magnitude: f.properties.mag as number,
        place: f.properties.place as string,
        time: f.properties.time as number,
        distanceKm,
        depthKm
      };
    })
    .filter((q: any) => q.distanceKm <= withinKm);
  return list.sort((a: any, b: any) => b.magnitude - a.magnitude);
}