import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
const dir = "data";
if (!fs.existsSync(dir))
    fs.mkdirSync(dir);
const db = new Database(path.join(dir, "history.sqlite"));
db.exec(`
CREATE TABLE IF NOT EXISTS rainfall (
  id INTEGER PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  ts INTEGER NOT NULL,
  mm1h REAL DEFAULT 0,
  mm3h REAL DEFAULT 0,
  mm24h REAL DEFAULT 0,
  mm72h REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rain_latlon ON rainfall(lat, lon);
CREATE INDEX IF NOT EXISTS idx_rain_ts ON rainfall(ts);
`);
const ins = db.prepare(`INSERT INTO rainfall (lat,lon,ts,mm1h,mm3h,mm24h,mm72h) VALUES (?,?,?,?,?,?,?)`);
export function storeRain(lat, lon, tsMs, pack) {
    ins.run(lat, lon, tsMs, pack.mm1h || 0, pack.mm3h || 0, pack.mm24h || 0, pack.mm72h || 0);
}
export function computeEMI(lat, lon, nowMs = Date.now(), halfLifeDays = 3) {
    const lambda = Math.log(2) / (halfLifeDays * 24 * 3600 * 1000);
    const rows = db
        .prepare(`SELECT ts, mm1h, mm24h FROM rainfall WHERE lat=? AND lon=? ORDER BY ts DESC LIMIT 1000`)
        .all(lat, lon);
    let emi = 0;
    for (const r of rows) {
        const dt = nowMs - r.ts;
        const pulse = r.mm1h && r.mm1h > 0 ? r.mm1h : (r.mm24h || 0) / 24;
        emi += pulse * Math.exp(-lambda * dt);
    }
    return emi;
}
