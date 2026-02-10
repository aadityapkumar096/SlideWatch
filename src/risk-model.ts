const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = deg2rad(b.lat - a.lat);
  const dLon = deg2rad(b.lon - a.lon);
  const lat1 = deg2rad(a.lat),
    lat2 = deg2rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function slopeFromGrid(elevGrid: number[][], cellSizeMeters: number) {
  if (elevGrid.length < 3 || elevGrid[0].length < 3) throw new Error("Grid too small");
  const n = elevGrid.length,
    m = elevGrid[0].length;
  const i = Math.floor(n / 2),
    j = Math.floor(m / 2);
  const dzdx =
    (elevGrid[i - 1][j + 1] + 2 * elevGrid[i][j + 1] + elevGrid[i + 1][j + 1] -
      (elevGrid[i - 1][j - 1] + 2 * elevGrid[i][j - 1] + elevGrid[i + 1][j - 1])) /
    (8 * cellSizeMeters);
  const dzdy =
    (elevGrid[i + 1][j - 1] + 2 * elevGrid[i + 1][j] + elevGrid[i + 1][j + 1] -
      (elevGrid[i - 1][j - 1] + 2 * elevGrid[i - 1][j] + elevGrid[i - 1][j + 1])) /
    (8 * cellSizeMeters);
  const slopeRad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
  let aspectRad = Math.atan2(dzdx, -dzdy);
  if (aspectRad < 0) aspectRad += 2 * Math.PI;
  const meanElev = elevGrid.flat().reduce((a, b) => a + b, 0) / (n * m);
  return { slopeDeg: rad2deg(slopeRad), aspectDeg: rad2deg(aspectRad), meanElev };
}

export function calcARI(hydro: any) {
  const w1 = 0.5,
    w3 = 0.25,
    w24 = 0.15,
    w72 = 0.1,
    wf = 0.4;
  const obs =
    w1 * (hydro.mm1h || 0) + w3 * (hydro.mm3h || 0) + w24 * (hydro.mm24h || 0) + w72 * (hydro.mm72h || 0);
  return obs + wf * (hydro.forecast6h || 0);
}

export function computeRisk(signals: any) {
  const { slope, hydro, quakes, tsunami } = signals;
  const ari = calcARI(hydro);
  const emi = Math.max(0, signals.emi || 0);
  const emiNorm = Math.min(1, emi / 120);
  const slopeScore = Math.min(1, slope.slopeDeg / 45);
  const wetScore = Math.min(1, ari / 80) * 0.6 + Math.min(1, (hydro.humidity || 0) / 100) * 0.2 + emiNorm * 0.2;

  const recent = (quakes || [])
    .filter((q: any) => Date.now() - q.time < 24 * 3600e3)
    .sort((a: any, b: any) => a.distanceKm - b.distanceKm)[0];
  let seismicScore = 0;
  if (recent) {
    const eff = recent.magnitude - Math.log10(Math.max(1, recent.distanceKm));
    seismicScore = Math.max(0, Math.min(1, (eff - 3.5) / 3.0));
  }
  const tsunamiBoost = tsunami && tsunami.active ? 0.15 : 0;

  const risk01 = 0.48 * slopeScore + 0.37 * wetScore + 0.15 * seismicScore + tsunamiBoost;
  const risk = Math.round(Math.max(0, Math.min(1, risk01)) * 100);
  const level = risk < 25 ? "LOW" : risk < 50 ? "MODERATE" : risk < 75 ? "HIGH" : "EXTREME";
  return {
    risk,
    level,
    components: { slopeScore, wetScore, seismicScore, ari, emi, tsunami: !!(tsunami && tsunami.active) }
  };
}

export function quakeHazard(quakes: any[]) {
  if (!quakes?.length) return { hazard: 0, strongest: null };
  const strongest = quakes.reduce((a, b) => (a.magnitude > b.magnitude ? a : b));
  const per = quakes.map((q) => Math.max(0, (q.magnitude - 3) / 5) * Math.max(0, 1 - q.distanceKm / 300));
  const hazard = Math.round(Math.max(...per) * 100);
  return { hazard, strongest };
}