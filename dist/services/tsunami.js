import axios from "axios";
import { parseStringPromise } from "xml2js";
const ATOM = "https://www.tsunami.gov/events/xml/atom10/tsunami_en.xml";
export async function tsunamiState() {
    try {
        const { data } = await axios.get(ATOM, { timeout: 8000 });
        const xml = await parseStringPromise(data);
        const entries = xml?.feed?.entry || [];
        const active = entries.some((e) => {
            const title = String(e.title?.[0] || "").toUpperCase();
            return /(WARNING|WATCH|ADVISORY)/.test(title);
        });
        const headline = entries[0]?.title?.[0] || "";
        return { active, headline, sources: ["NOAA PTWC"] };
    }
    catch {
        return { active: false, sources: ["NOAA PTWC"], headline: undefined };
    }
}
