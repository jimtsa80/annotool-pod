// anno-waker v2: keeps ONE RunPod pod awake for the annotool server.
//  - starts the current pod when it is stopped (POST /wake)
//  - if RunPod cannot start it (its GPU is taken: HTTP 400 on start) it CREATES a new pod from the same config
//    (same image/env/ports/disk, same network volume, volume's datacenter, GPU fallback list, price cap)
//  - remembers the current pod id in KV; /status returns it plus its proxy URL
//  - never terminates anything. Optional idle reaper (cron) can STOP the current pod (REAP_IDLE_MIN).
// Uses the Runpod REST API v2 (https://api.runpod.io/v2). v1 (rest.runpod.io/v1) was retired on 2026-11-15.
const ALLOWED_ORIGINS = new Set([
  "https://jimtsa80.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const API = "https://api.runpod.io/v2";
const MIN_GAP_S = 120;          // at most one start/create per 2 minutes
const MAX_STARTS_PER_DAY = 8;   // hard daily cap on start calls
const MAX_CREATES_PER_DAY = 2;  // hard daily cap on NEW pods
const DEFAULT_MAX_PRICE = 1.2;  // $/hr cap for a new pod (override with env MAX_PRICE_HR)
const MIN_VRAM_GB = 24;
const PORT = 8000;
// Preference order after the RTX 4090. CUDA-12.1 image (pytorch 2.4.1): Blackwell GPUs (RTX 5090 / PRO 6000 / B200) are NOT usable.
// "price" is only the fallback when the catalog cannot be read (list price, secure cloud, approximate).
const GPU_PREF = [
  { id: "NVIDIA GeForce RTX 4090", vram: 24, price: 0.69 },
  { id: "NVIDIA GeForce RTX 3090", vram: 24, price: 0.46 },
  { id: "NVIDIA RTX A5000", vram: 24, price: 0.27 },
  { id: "NVIDIA L4", vram: 24, price: 0.39 },
  { id: "NVIDIA A40", vram: 48, price: 0.40 },
  { id: "NVIDIA L40S", vram: 48, price: 0.86 },
  { id: "NVIDIA RTX A6000", vram: 48, price: 0.49 },
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "X-Wake-Key, Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(origin ? corsHeaders(origin) : {}) },
  });
}
async function keyOk(provided, expected) {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; // compares fixed-length hashes
  return d === 0;
}

// ---------- RunPod v2 ----------
class RpError extends Error {
  constructor(status, detail, path) { super("runpod " + path + " " + status + " " + String(detail).slice(0, 200)); this.status = status; this.detail = String(detail); }
}
async function rp(env, method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: "Bearer " + env.RUNPOD_API_KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-json */ }
    if (!r.ok) throw new RpError(r.status, (data && (data.detail || data.title)) || text || "", method + " " + path.split("?")[0].replace(/[a-z0-9]{10,}/g, ":id"));
    return data;
  } catch (e) {
    if (e instanceof RpError) throw e;
    throw new RpError(0, e && e.name === "AbortError" ? "timeout" : String(e && e.message || e), method + " " + path.split("?")[0]);
  } finally { clearTimeout(t); }
}
function podState(p) {
  const s = String((p && (p.status || p.desiredStatus)) || "").toUpperCase(); // v2: status; v1: desiredStatus
  if (s === "RUNNING") return "running";
  if (s === "EXITED" || s === "ERROR") return "stopped";
  if (s === "PROVISIONING" || s === "STARTING") return "starting";
  if (s === "TERMINATED") return "gone";
  return s ? s.toLowerCase() : "unknown";
}
const proxyUrl = (id) => "https://" + id + "-" + PORT + ".proxy.runpod.net";
const getPod = (env, id) => rp(env, "GET", "/pods/" + encodeURIComponent(id));
const maxPrice = (env) => { const n = parseFloat(env.MAX_PRICE_HR); return n > 0 ? n : DEFAULT_MAX_PRICE; };

// ---------- current pod bookkeeping (KV) ----------
async function currentId(env) { return (await env.STATE.get("pod_id")) || env.POD_ID; }
async function history(env) {
  try { const h = JSON.parse((await env.STATE.get("pod_history")) || "[]"); return Array.isArray(h) ? h : []; } catch (_) { return []; }
}
async function getCurrent(env) {
  const id = await currentId(env);
  try { const p = await getPod(env, id); return { id, pod: p, state: podState(p) }; }
  catch (e) { if (e instanceof RpError && e.status === 404) return { id, pod: null, state: "gone" }; throw e; }
}

// ---------- config clone ----------
function cloneConfig(src) {
  const net = (src.mounts && src.mounts.network) || [];
  if (!src.image) throw new Error("template pod has no image");
  if (!net.length) throw new Error("template pod has no network volume - refusing to create a pod without the data volume");
  const env = {};
  for (const [k, v] of Object.entries(src.env || {})) if (!/^RUNPOD_(?!API_KEY$)/.test(k)) env[k] = v; // RunPod injects RUNPOD_* itself
  if (!Object.keys(env).length) throw new Error("template pod returned no env vars - refusing (admin/CORS settings would be lost)");
  const cfg = {
    image: src.image,
    disk: src.disk || 20,
    ports: (src.ports && src.ports.length) ? src.ports : [PORT + "/http"],
    env,
    network: net.map((m) => ({ volumeId: m.volumeId, path: m.path })),
    cloud: src.cloud || "SECURE",
    dataCenterId: src.dataCenterId || null,
  };
  if (src.args) cfg.args = src.args;
  if (src.registry) cfg.registry = src.registry;
  return cfg;
}
async function templatePod(env) {
  // newest first: current pod, previous pods, bootstrap pod. Old pods are never terminated, so one of them stays readable.
  const ids = [...new Set([await currentId(env), ...(await history(env)).slice().reverse(), env.POD_ID])].filter(Boolean);
  let lastErr = null;
  for (const id of ids) {
    try { const p = await getPod(env, id); if (podState(p) !== "gone") return { id, pod: p }; }
    catch (e) { lastErr = e; if (!(e instanceof RpError && e.status === 404)) throw e; }
  }
  throw new Error("no readable template pod (" + (lastErr ? lastErr.message : "none") + ")");
}
async function volumeDc(env, cfg) {
  try { const v = await rp(env, "GET", "/network-volumes/" + encodeURIComponent(cfg.network[0].volumeId)); if (v && v.dataCenter) return v.dataCenter; }
  catch (e) { if (!(e instanceof RpError && (e.status === 403 || e.status === 404))) throw e; }
  return cfg.dataCenterId; // fallback: where the template pod ran
}
// ordered candidates [{id, price, level}] for the volume's datacenter, 4090 first, then cheapest first, price <= cap
async function candidates(env, dc) {
  const cap = maxPrice(env);
  let cat = null;
  try {
    const r = await rp(env, "GET", "/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE");
    cat = new Map((r && r.gpus || []).map((g) => [g.id, g]));
  } catch (_) { cat = null; } // key without catalog scope, etc.: fall back to the static list
  const out = [];
  for (const g of GPU_PREF) {
    const c = cat && cat.get(g.id);
    let price = g.price, level = "unknown";
    if (cat) {
      if (!c) continue;                                   // not offered at all
      if (c.memory && c.memory < MIN_VRAM_GB) continue;
      price = (c.price && c.price.secure) || g.price;
      const d = (c.dataCenters || []).find((x) => x.id === dc);
      level = d ? d.availability : "NONE";
      if (level === "NONE") continue;                     // nothing free in the volume's datacenter right now
    }
    if (price > cap) continue;
    out.push({ id: g.id, price, level });
  }
  const first = out.filter((x) => x.id === GPU_PREF[0].id), rest = out.filter((x) => x.id !== GPU_PREF[0].id).sort((a, b) => a.price - b.price);
  return [...first, ...rest];
}
const redactedEnvKeys = (env) => Object.keys(env).sort();
async function plan(env) {
  const t = await templatePod(env);
  const cfg = cloneConfig(t.pod);
  const dc = await volumeDc(env, cfg);
  if (!dc) throw new Error("cannot determine the network volume datacenter");
  const cands = await candidates(env, dc);
  return {
    template_pod: t.id, image: cfg.image, disk_gb: cfg.disk, ports: cfg.ports, cloud: cfg.cloud,
    volume: cfg.network, datacenter: dc, max_price_hr: maxPrice(env),
    env_keys: redactedEnvKeys(cfg.env), candidates: cands,
  };
}

async function createPod(env, now) {
  const t = await templatePod(env);
  const cfg = cloneConfig(t.pod);
  const dc = await volumeDc(env, cfg);
  if (!dc) throw new Error("cannot determine the network volume datacenter");
  const cands = await candidates(env, dc);
  if (!cands.length) throw new RpError(400, "no suitable GPU is currently available in " + dc + " within $" + maxPrice(env) + "/hr", "create");
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  let lastErr = null, tries = 0;
  for (const c of cands) {
    for (let attempt = 0; attempt < 2; attempt++) {
      tries++;
      const body = {
        name: "anno-pod-" + stamp, image: cfg.image, disk: cfg.disk, ports: cfg.ports, env: cfg.env, cloud: cfg.cloud,
        gpu: { id: c.id, count: 1 }, dataCenterIds: [dc], mounts: { network: cfg.network },
      };
      if (cfg.args) body.args = cfg.args;
      if (cfg.registry) body.registry = cfg.registry;
      try {
        const p = await rp(env, "POST", "/pods", body);
        return { pod: p, gpu: c.id, price: c.price, datacenter: dc, template: t.id, tries };
      } catch (e) {
        lastErr = e;
        if (!(e instanceof RpError)) throw e;
        if (e.status === 400 || e.status === 403) break;                // this GPU / datacenter cannot be placed: next candidate
        if (e.status === 0 || e.status >= 500) { if (attempt === 0) continue; break; } // transient: retry once, then next
        throw e;                                                         // 402 balance, 409 account limit, 422 bad body, 429 rate limit: stop
      }
    }
  }
  throw lastErr || new Error("create failed");
}

async function wake(env, origin) {
  const cur = await getCurrent(env);
  if (cur.state === "running") return json({ action: "noop", state: "running", pod_id: cur.id, url: proxyUrl(cur.id) }, 200, origin);
  if (cur.state === "starting") return json({ action: "none", state: "starting", pod_id: cur.id, url: proxyUrl(cur.id) }, 200, origin);
  if (cur.state !== "stopped" && cur.state !== "gone") return json({ action: "none", state: cur.state, pod_id: cur.id, url: proxyUrl(cur.id) }, 200, origin);

  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const sKey = "starts:" + day, cKey = "creates:" + day;
  const starts = parseInt((await env.STATE.get(sKey)) || "0", 10);
  const creates = parseInt((await env.STATE.get(cKey)) || "0", 10);
  if (await env.STATE.get("last_start")) return json({ error: "too soon", retry_after_s: MIN_GAP_S, state: cur.state, pod_id: cur.id, url: proxyUrl(cur.id) }, 429, origin);
  await env.STATE.put("last_start", String(now), { expirationTtl: MIN_GAP_S });
  const release = () => env.STATE.delete("last_start");

  let needNew = cur.state === "gone";
  if (!needNew) {
    if (starts >= MAX_STARTS_PER_DAY) { await release(); return json({ error: "daily start cap reached", state: cur.state, pod_id: cur.id, url: proxyUrl(cur.id) }, 429, origin); }
    try {
      await rp(env, "POST", "/pods/" + encodeURIComponent(cur.id) + "/action", { action: "start" });
      await env.STATE.put(sKey, String(starts + 1), { expirationTtl: 90000 });
      return json({ action: "started", state: "starting", pod_id: cur.id, url: proxyUrl(cur.id) }, 200, origin);
    } catch (e) {
      // 400 = "this pod cannot be placed" (its GPU is taken). 409 (account limit), 402, 429, 5xx, timeouts: do NOT create anything.
      if (e instanceof RpError && e.status === 400) needNew = true;
      else { await release(); return json({ error: String(e.message || e), state: cur.state, pod_id: cur.id, url: proxyUrl(cur.id) }, 502, origin); }
    }
  }
  // fall back: new pod from the same config
  if (creates >= MAX_CREATES_PER_DAY) { await release(); return json({ error: "daily new-pod cap reached", state: cur.state, pod_id: cur.id, url: proxyUrl(cur.id) }, 429, origin); }
  if (await env.STATE.get("creating")) { await release(); return json({ action: "none", state: "starting", note: "a new pod is already being created", pod_id: cur.id, url: proxyUrl(cur.id) }, 200, origin); }
  await env.STATE.put("creating", "1", { expirationTtl: 90 });
  try {
    const r = await createPod(env, now);
    const id = r.pod && r.pod.id;
    if (!id) throw new Error("create returned no pod id");
    const h = await history(env); if (!h.includes(cur.id)) h.push(cur.id);
    await env.STATE.put("pod_history", JSON.stringify(h.slice(-10)));
    await env.STATE.put("pod_id", id);
    await env.STATE.put("pod_info", JSON.stringify({ id, replaced: cur.id, gpu: r.gpu, price_hr: (r.pod && r.pod.cost) || r.price, datacenter: r.datacenter, created_at: new Date(now).toISOString() }));
    await env.STATE.put(cKey, String(creates + 1), { expirationTtl: 90000 });
    return json({ action: "created", state: "starting", pod_id: id, url: proxyUrl(id), replaced: cur.id, gpu: r.gpu, price_hr: (r.pod && r.pod.cost) || r.price }, 200, origin);
  } catch (e) {
    await release(); // nothing was created: allow a retry after the 'creating' lock expires
    return json({ error: String(e.message || e), state: cur.state, pod_id: cur.id, url: proxyUrl(cur.id) }, 502, origin);
  } finally { await env.STATE.delete("creating"); }
}

async function reapIdle(env) {
  const min = parseFloat(env.REAP_IDLE_MIN);
  if (!(min > 0)) return { skipped: "REAP_IDLE_MIN not set" };
  const cur = await getCurrent(env);
  if (cur.state !== "running") return { skipped: cur.state };
  let h;
  try { const r = await fetch(proxyUrl(cur.id) + "/health", { signal: AbortSignal.timeout(8000) }); h = r.ok ? await r.json() : null; } catch (_) { h = null; }
  const idle = h && h.idle && typeof h.idle.idle_seconds === "number" ? h.idle.idle_seconds : null;
  if (idle === null || h.busy) return { skipped: "no idle info / busy" };
  if (idle < min * 60) return { skipped: "active", idle_seconds: idle };
  await rp(env, "POST", "/pods/" + encodeURIComponent(cur.id) + "/action", { action: "stop" });
  return { stopped: cur.id, idle_seconds: idle };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin not allowed" }, 403, null);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} });
    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return json({ ok: true, service: "anno-waker", version: 2 }, 200, origin);
    if (!(await keyOk(req.headers.get("X-Wake-Key"), env.WAKE_KEY))) return json({ error: "bad wake key" }, 401, origin);
    try {
      if (path === "/status" && req.method === "GET") {
        const c = await getCurrent(env);
        const info = c.state === "gone" ? null : { desiredStatus: (c.pod && (c.pod.status || c.pod.desiredStatus)) || null };
        return json({ state: c.state, pod_id: c.id, url: proxyUrl(c.id), ...info }, 200, origin);
      }
      if (path === "/plan" && req.method === "GET") return json(await plan(env), 200, origin); // dry run: no mutation, no secrets
      if (path === "/wake" && req.method === "POST") {
        if (u.searchParams.get("dry") === "1") return json({ dry_run: true, plan: await plan(env) }, 200, origin);
        return await wake(env, origin);
      }
      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, origin);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(reapIdle(env).catch(() => {})); },
};
