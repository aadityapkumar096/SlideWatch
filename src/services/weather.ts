import axios from "axios";

function owKey(): string {
  const k = process.env.OPENWEATHER_API_KEY || "";
  if (!k) throw new Error("OPENWEATHER_API_KEY is missing (set it in .env)");
  return k;
}
function awKey(): string | null {
  return process.env.ACCUWEATHER_API_KEY || null;
}

// ---- utils ----
function safeNum(v: any, d = 0): number {
  return Number.isFinite(v) ? Number(v) : d;
}
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
}

type OWForecast3h = {
  dt: number;
  main: { humidity?: number };
  wind?: { speed?: number };
  rain?: { "3h"?: number };
};

function synthAlertsFromForecast(list: OWForecast3h[]): any[] {
  const heavyRainNext6h = sum(list.slice(0, 2).map((x) => x.rain?.["3h"] || 0)); // first 6h
  const strongWindNext12h = Math.max(...list.slice(0, 4).map((x) => x.wind?.speed || 0)); // m/s
  const alerts: any[] = [];
  if (heavyRainNext6h >= 15)
    alerts.push({
      event: "HEAVY RAIN (6h)",
      severity: "moderate",
      description: `~${heavyRainNext6h.toFixed(1)} mm expected in next 6h`,
    });
  if (heavyRainNext6h >= 30)
    alerts.push({
      event: "VERY HEAVY RAIN (6h)",
      severity: "severe",
      description: `~${heavyRainNext6h.toFixed(1)} mm in next 6h`,
    });
  if (strongWindNext12h >= 14)
    alerts.push({
      event: "STRONG WINDS",
      severity: "moderate",
      description: `gusts ≈ ${(strongWindNext12h * 3.6).toFixed(0)} km/h (next 12h)`,
    });
  return alerts;
}

// ---- OpenWeather (free) pack ----
// Returns shape compatible with the app: mm1h, mm24h, mm72h, forecast6h, humidity, alerts[]
export async function openWeatherPack(lat: number, lon: number) {
  const key = owKey();
  // 1) current weather (free)
  const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${key}&units=metric`;
  // 2) 5-day / 3-hour forecast (free)
  const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${key}&units=metric`;

  // fetch both in parallel
  const [curRes, fcRes] = await Promise.all([
    axios.get(currentUrl).catch((e) => {
      throw explain("OpenWeather current", e);
    }),
    axios.get(forecastUrl).catch((e) => {
      throw explain("OpenWeather forecast", e);
    }),
  ]);

  const cur = curRes.data || {};
  const list: OWForecast3h[] = fcRes.data?.list || [];

  const mm1h = safeNum(cur.rain?.["1h"], 0); // may be undefined if no rain now
  const humidity = safeNum(cur.main?.humidity, 0);

  // Estimate next 6h from the first two 3h slots:
  const forecast6h = sum(list.slice(0, 2).map((x) => x.rain?.["3h"] || 0));

  // For a free-plan prototype, we don’t have historical 24/72h.
  // Use near-term “windowed” rainfall so the UI has values (it’s fine for demo):
  const mm24h = sum(list.slice(0, 8).map((x) => x.rain?.["3h"] || 0)) + mm1h; // ≈ next 24h + current
  const mm72h = sum(list.slice(0, 24).map((x) => x.rain?.["3h"] || 0)) + mm1h; // ≈ next 72h + current

  // Try AccuWeather alerts if available, else synthesize
  let alerts: any[] = [];
  try {
    const aw = await accuWeatherAlerts(lat, lon);
    if (aw.length > 0) alerts = aw;
  } catch {
    // ignore
  }
  if (alerts.length === 0) alerts = synthAlertsFromForecast(list);

  return { mm1h, mm24h, mm72h, forecast6h, humidity, alerts };
}

// ---- AccuWeather alerts (optional) ----
export async function accuWeatherAlerts(lat: number, lon: number) {
  const key = awKey();
  if (!key) return [];
  try {
    // free plan allows geoposition search; alarms endpoint may be restricted in some tiers
    const lkUrl = `https://dataservice.accuweather.com/locations/v1/cities/geoposition/search?apikey=${key}&q=${lat}%2C${lon}`;
    const lk = (await axios.get(lkUrl)).data;
    const locKey = lk?.Key;
    if (!locKey) return [];
    // try alarms (some tiers may 403 -> we swallow and return [])
    const alertsUrl = `https://dataservice.accuweather.com/alarms/v1/5day/${locKey}?apikey=${key}`;
    const { data } = await axios.get(alertsUrl);
    return (data || []).map((a: any) => ({
      event: a?.Category || "Alert",
      severity: String(a?.Severity ?? ""),
      description: a?.Source || "AccuWeather",
    }));
  } catch {
    return []; // if blocked or 403 – just return none and rely on synthetic alerts
  }
}

// Pretty error message for axios
function explain(tag: string, e: any) {
  if (e?.response) {
    const code = e.response.status;
    const msg =
      typeof e.response.data === "object"
        ? JSON.stringify(e.response.data)
        : String(e.response.data);
    return new Error(`${tag} HTTP ${code}: ${msg}`);
  }
  return e;
}
