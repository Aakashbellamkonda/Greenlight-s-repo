// Client-side city model + routing used by the ambulance priority simulation.
export const COLS = 10;
export const ROWS = 7;
export const EDGE_M = 400;

const ROW_NAMES = ["Harbor", "Market", "Cedar", "Elm", "Pine", "Oak", "Bay"];
const COL_NAMES = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];

export const nodeXY = (id: number) => ({
  x: 60 + (id % COLS) * 98,
  y: 50 + Math.floor(id / COLS) * 86,
});
export const signalName = (id: number) =>
  `${ROW_NAMES[Math.floor(id / COLS)]}/${COL_NAMES[id % COLS]}`;
export const signalCode = (id: number) => `SG-${String(id).padStart(3, "0")}`;

export type Edge = { a: number; b: number; density: number };
export const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

export function buildCity(seed = 42, load = 1) {
  const r = rng(seed);
  const edges = new Map<string, Edge>();
  const adj: number[][] = Array.from({ length: COLS * ROWS }, () => []);
  const add = (a: number, b: number, d: number) => {
    edges.set(edgeKey(a, b), { a, b, density: Math.min(0.98, Math.max(0.05, d * load)) });
    adj[a].push(b);
    adj[b].push(a);
  };
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) {
      const id = y * COLS + x;
      // arterial congestion on Elm (row 3) and 5th (col 4)
      if (x < COLS - 1) add(id, id + 1, r() * 0.55 + (y === 3 ? 0.4 : 0) + (y === 1 && x > 4 ? 0.3 : 0));
      if (y < ROWS - 1) add(id, id + COLS, r() * 0.55 + (x === 4 ? 0.4 : 0) + (x === 7 && y < 3 ? 0.25 : 0));
    }
  const offsets = Array.from({ length: COLS * ROWS }, () => Math.floor(r() * 60));
  return { edges, adj, offsets };
}
export type City = ReturnType<typeof buildCity>;

export function dijkstra(city: City, start: number, end: number, cost: (e: Edge) => number) {
  const n = COLS * ROWS;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  dist[start] = 0;
  for (let i = 0; i < n; i++) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!done[v] && (u === -1 || dist[v] < dist[u])) u = v;
    if (u === -1 || dist[u] === Infinity) break;
    done[u] = true;
    if (u === end) break;
    for (const v of city.adj[u]) {
      const c = dist[u] + cost(city.edges.get(edgeKey(u, v))!);
      if (c < dist[v]) { dist[v] = c; prev[v] = u; }
    }
  }
  const path: number[] = [];
  for (let v = end; v !== -1; v = prev[v]) path.unshift(v);
  return path;
}

export const speedFor = (density: number) => 72 * (1 - 0.55 * density); // km/h
export const SIGNAL_WAIT_S = 24; // expected red wait without priority

export type RouteOption = {
  id: string;
  label: string;
  path: number[];
  km: number;
  density: number;
  etaPriority: number; // seconds
  etaNormal: number;
  traffic: { low: number; moderate: number; high: number };
  score: number;
  reasons: string[];
  recommended: boolean;
};

export type TrafficLevel = "low" | "moderate" | "high";
export const trafficLevel = (d: number): TrafficLevel => (d >= 0.6 ? "high" : d >= 0.35 ? "moderate" : "low");
export const TRAFFIC_LOADS = [
  { id: "off", label: "Off-peak", load: 0.7 },
  { id: "normal", label: "Normal", load: 1 },
  { id: "rush", label: "Rush hour", load: 1.35 },
];

export function routeOptions(city: City, start: number, end: number): RouteOption[] {
  const defs = [
    { id: "ai", label: "AI · density-weighted", cost: (e: Edge) => 1 + 3 * e.density * e.density },
    { id: "bal", label: "Balanced", cost: (e: Edge) => 1 + 0.6 * e.density + (e.b - e.a === 1 ? 0 : 0.05) },
    { id: "short", label: "Shortest distance", cost: (e: Edge) => 1 + (e.b - e.a === 1 ? 0.001 : 0) },
  ];
  const opts: RouteOption[] = defs.map((d) => {
    const path = dijkstra(city, start, end, d.cost);
    let t = 0, dens = 0;
    const traffic = { low: 0, moderate: 0, high: 0 };
    for (let i = 0; i < path.length - 1; i++) {
      const e = city.edges.get(edgeKey(path[i], path[i + 1]))!;
      dens += e.density;
      traffic[trafficLevel(e.density)]++;
      t += EDGE_M / (speedFor(e.density) / 3.6);
    }
    const signals = Math.max(0, path.length - 2);
    return {
      id: d.id,
      label: d.label,
      path,
      km: ((path.length - 1) * EDGE_M) / 1000,
      density: dens / Math.max(1, path.length - 1),
      etaPriority: t,
      etaNormal: t + signals * SIGNAL_WAIT_S * 0.6,
      traffic,
      score: t + traffic.high * 45 + traffic.moderate * 10 + signals * 4,
      reasons: [] as string[],
      recommended: false,
    };
  });
  const seen = new Set<string>();
  const uniq = opts.filter((o) => { const k = o.path.join(","); if (seen.has(k)) return false; seen.add(k); return true; });
  opts.length = 0; opts.push(...uniq);
  const best = opts.reduce((b, o) => (o.score < b.score ? o : b), opts[0]);
  best.recommended = true;
  const minEta = Math.min(...opts.map((o) => o.etaPriority));
  const minHigh = Math.min(...opts.map((o) => o.traffic.high));
  const minSig = Math.min(...opts.map((o) => o.path.length));
  for (const o of opts) {
    if (o.etaPriority === minEta) o.reasons.push("fastest arrival");
    if (o.traffic.high === minHigh) o.reasons.push(o.traffic.high === 0 ? "no heavy traffic" : "least heavy traffic");
    if (o.path.length === minSig) o.reasons.push("fewest signals");
    if (o.traffic.high > minHigh) o.reasons.push(`${o.traffic.high} heavy-traffic block${o.traffic.high > 1 ? "s" : ""}`);
  }
  return opts;
}

export const DEPOTS = [
  { name: "Central Depot", node: 60 },
  { name: "West Station", node: 20 },
  { name: "South Station", node: 64 },
];

export const HOSPITALS = [
  { name: "St. Aurelia General", node: 9, beds: 4, total: 24, icu: 2, erWait: 8, trauma: true, lx: -176, ly: 18 },
  { name: "Northgate Medical", node: 3, beds: 0, total: 30, icu: 0, erWait: 35, trauma: true, lx: 18, ly: 18 },
  { name: "Riverside Children's", node: 39, beds: 2, total: 18, icu: 1, erWait: 12, trauma: false, lx: -176, ly: 18 },
];

export type Availability = "available" | "limited" | "full";
export const availability = (h: (typeof HOSPITALS)[number]): Availability =>
  h.beds === 0 ? "full" : h.beds <= 2 ? "limited" : "available";

export type Severity = 1 | 2 | 3;

export function scoreHospital(city: City, start: number, h: (typeof HOSPITALS)[number], sev: Severity) {
  const best = routeOptions(city, start, h.node)[0];
  let score = best.etaPriority;
  if (h.beds === 0) score += 900;
  if (sev === 1 && !h.trauma) score += 400;
  if (sev === 1 && h.icu === 0) score += 300;
  score += h.erWait * 4;
  return { eta: best.etaPriority, score };
}

export const fmt = (s: number) => {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};
