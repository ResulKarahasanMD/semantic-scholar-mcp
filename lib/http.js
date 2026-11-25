// Semantic Scholar HTTP katmani: throttle + 429/5xx geri cekilme + kucuk TTL cache.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Anahtarsiz kullanimda API paylasimli havuzda calisir ve 429 NORMALDIR; retry sart.

export const BASE = process.env.S2_BASE_URL || "https://api.semanticscholar.org";
// GUI'den acilan Claude ~/.zshenv okumaz; degisken yoksa "${S2_API_KEY}" metni oldugu gibi gelir
// ve S2 buna 403 doner (olculdu 2026-09-17). Bu durumda anahtar dogrudan env dosyasindan okunur.
function resolveKey() {
  const v = (process.env.S2_API_KEY || "").trim();
  if (v && !v.includes("${")) return { key: v, source: "ortam değişkeni" };
  const file = process.env.S2_ENV_FILE || join(homedir(), ".config/claude/env");
  try {
    const m = readFileSync(file, "utf8").match(/^\s*(?:export\s+)?S2_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
    if (m) return { key: m[1], source: `${file} (ortam değişkeni ${v ? "genişletilmemiş" : "yok"})` };
  } catch {}
  return { key: "", source: v ? `genişletilmemiş değer "${v}", ${file} okunamadı` : "yok" };
}
const RESOLVED = resolveKey();
export const API_KEY = RESOLVED.key;
export const API_KEY_SOURCE = RESOLVED.source;

// Anahtarsiz havuz cok dar; anahtarli hesapta tipik limit 1 rps.
const DEFAULT_INTERVAL = API_KEY ? 1100 : 3000;
export const MIN_INTERVAL = Number(process.env.S2_MIN_INTERVAL_MS || DEFAULT_INTERVAL);
export const MAX_RETRIES = Number(process.env.S2_MAX_RETRIES || 5);
export const TIMEOUT_MS = Number(process.env.S2_TIMEOUT_MS || 30000);
// MCP istemcisi 60 sn sonra cagriyi dusurur; ondan once ANLASILIR bir hata donmeliyiz.
export const DEADLINE_MS = Number(process.env.S2_DEADLINE_MS || 45000);
const CACHE_TTL_MS = Number(process.env.S2_CACHE_TTL_MS || 10 * 60 * 1000);

export class S2Error extends Error {}
export class RateLimitError extends S2Error {}

const cache = new Map(); // key -> { at, data }
let hits = 0, misses = 0, calls = 0, retries = 0;
export const stats = () => ({ calls, retries, cacheHits: hits, cacheMisses: misses, cacheSize: cache.size });

let lastCall = 0;
let chain = Promise.resolve(); // tum istekleri tek siraya dizer, paralel patlamayi onler
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const wait = lastCall + MIN_INTERVAL - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

function headers() {
  const h = { Accept: "application/json", "User-Agent": "semantic-scholar-mcp/0.1 (local)" };
  if (API_KEY) h["x-api-key"] = API_KEY;
  return h;
}

/** Tek istek + 429/5xx icin ustel geri cekilme. Sira disi calistirilmaz. */
async function once(url, init) {
  let backoff = Number(process.env.S2_BACKOFF_MS || 2000);
  const t0 = Date.now();
  const left = () => DEADLINE_MS - (Date.now() - t0);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    calls++;
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...headers(), ...(init?.headers || {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      // undici gercek nedeni cause zincirinde tasir; "fetch failed" tek basina teshis edilemez.
      const why = [e.message, e.cause?.message, e.cause?.code, e.cause?.cause?.message]
        .filter((x, i, arr) => x && arr.indexOf(x) === i).join(" ← ");
      const detail = `${why} (${attempt + 1}. deneme, ${Math.round((Date.now() - t0) / 1000)} sn)`;
      if (attempt === MAX_RETRIES || left() < backoff) throw new S2Error(`ağ hatası: ${detail}`);
      retries++; await sleep(backoff); backoff *= 2; continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra0 = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(ra0) && ra0 > 0 ? ra0 * 1000 : backoff + Math.floor(Math.random() * 500);
      if (attempt === MAX_RETRIES || left() < waitMs + MIN_INTERVAL) {
        const msg = res.status === 429
          ? `429 rate limit (${attempt + 1} deneme, ${Math.round((Date.now() - t0) / 1000)} sn). ` +
            (API_KEY ? "Anahtarlı hesap limiti aşıldı; S2_MIN_INTERVAL_MS değerini yükseltin." : "Anahtarsız paylaşımlı havuz dolu; S2_API_KEY tanımlayın veya birkaç dakika bekleyin.")
          : `${res.status} sunucu hatası (${attempt + 1} deneme)`;
        throw new RateLimitError(msg);
      }
      retries++;
      await sleep(waitMs);
      backoff *= 2;
      continue;
    }
    const body = await res.text();
    if (res.status === 403) throw new S2Error(`403 Forbidden: x-api-key reddedildi (geçersiz/iptal anahtar). Anahtar kaynağı: ${API_KEY_SOURCE}`);
    if (!res.ok) throw new S2Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    try { return JSON.parse(body); } catch { throw new S2Error(`JSON çözülemedi: ${body.slice(0, 200)}`); }
  }
}

function run(fn) { // istekleri seri hale getir
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}

export async function get(path, params = {}) {
  const u = new URL(path.startsWith("http") ? path : BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const key = "GET " + u.toString();
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_TTL_MS) { hits++; return c.data; }
  misses++;
  const data = await run(() => once(u.toString(), { method: "GET" }));
  cache.set(key, { at: Date.now(), data });
  return data;
}

export async function post(path, params = {}, body = {}) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const key = "POST " + u.toString() + " " + JSON.stringify(body);
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_TTL_MS) { hits++; return c.data; }
  misses++;
  const data = await run(() => once(u.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  cache.set(key, { at: Date.now(), data });
  return data;
}
