// anno-waker: starts ONE RunPod pod (env.POD_ID) when it is stopped. Nothing else.
const ALLOWED_ORIGINS = new Set([
  "https://jimtsa80.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const MIN_GAP_S = 120;        // at most one start per 2 minutes
const MAX_STARTS_PER_DAY = 8; // hard daily cap on starts
const RUNPOD = "https://rest.runpod.io/v1/pods/";

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
function podState(p) {
  const d = String((p && p.desiredStatus) || "").toUpperCase();
  if (d === "RUNNING") return "running";
  if (d === "EXITED") return "stopped";
  if (d === "TERMINATED") return "gone";
  return d ? d.toLowerCase() : "unknown";
}
async function getPod(env) {
  const r = await fetch(RUNPOD + encodeURIComponent(env.POD_ID), {
    method: "GET",
    headers: { Authorization: "Bearer " + env.RUNPOD_API_KEY },
  });
  if (!r.ok) throw new Error("runpod status " + r.status);
  return r.json();
}
async function startPod(env) {
  // the ONLY mutating call this worker can make
  const r = await fetch(RUNPOD + encodeURIComponent(env.POD_ID) + "/start", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RUNPOD_API_KEY },
  });
  const t = await r.text();
  if (!r.ok) throw new Error("runpod start " + r.status + " " + t.slice(0, 160));
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin not allowed" }, 403, null);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} });
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return json({ ok: true, service: "anno-waker" }, 200, origin);
    if (!(await keyOk(req.headers.get("X-Wake-Key"), env.WAKE_KEY))) return json({ error: "bad wake key" }, 401, origin);

    try {
      if (path === "/status" && req.method === "GET") {
        const p = await getPod(env);
        return json({ state: podState(p), desiredStatus: p.desiredStatus || null }, 200, origin);
      }
      if (path === "/wake" && req.method === "POST") {
        const p = await getPod(env);
        const state = podState(p);
        if (state === "running") return json({ action: "noop", state }, 200, origin);
        if (state !== "stopped") return json({ action: "none", state }, 200, origin);
        const day = new Date().toISOString().slice(0, 10);
        const dayKey = "starts:" + day;
        const used = parseInt((await env.STATE.get(dayKey)) || "0", 10);
        if (used >= MAX_STARTS_PER_DAY) return json({ error: "daily start cap reached", state }, 429, origin);
        if (await env.STATE.get("last_start")) return json({ error: "too soon", retry_after_s: MIN_GAP_S, state }, 429, origin);
        await env.STATE.put("last_start", String(Date.now()), { expirationTtl: MIN_GAP_S });
        try {
          await startPod(env);
        } catch (e) {
          await env.STATE.delete("last_start");
          return json({ error: String(e.message || e), state }, 502, origin);
        }
        await env.STATE.put(dayKey, String(used + 1), { expirationTtl: 90000 });
        return json({ action: "started", state: "starting" }, 200, origin);
      }
      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, origin);
    }
  },
};
