import { LRUCache } from "lru-cache";
import Redis from "ioredis";
const TTL = Number(process.env.CACHE_TTL_SECONDS || 120);
// Optional Redis client (non-blocking). Falls back to LRU if not ready.
let redis = null;
if (process.env.REDIS_URL) {
    try {
        redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
        if (redis && typeof redis.on === "function") {
            redis.on("error", () => { }); // swallow errors -> fallback to LRU
            if (typeof redis.connect === "function") {
                redis.connect().catch(() => { });
            }
        }
    }
    catch {
        redis = null;
    }
}
// ✅ Explicit generic + annotation so TS is happy with any value type
const lru = new LRUCache({
    max: 1000,
    ttl: TTL * 1000
});
// Safe base64url (don’t rely on Node's "base64url" codec for portability)
function toBase64Url(str) {
    return Buffer.from(str)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}
export async function cacheGet(key) {
    if (redis && redis.status === "ready") {
        try {
            const v = await redis.get(key);
            return v ? JSON.parse(v) : null;
        }
        catch {
            // fall through to LRU
        }
    }
    return lru.get(key) ?? null;
}
export async function cacheSet(key, val, ttlSec = TTL) {
    if (redis && redis.status === "ready") {
        try {
            await redis.set(key, JSON.stringify(val), "EX", ttlSec);
            return;
        }
        catch {
            // fall through to LRU
        }
    }
    lru.set(key, val, { ttl: ttlSec * 1000 });
}
export function cacheKey(prefix, obj) {
    return `${prefix}:${toBase64Url(JSON.stringify(obj))}`;
}
