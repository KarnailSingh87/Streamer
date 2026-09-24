// src/lib/player/serverHealth.ts — the client half of automatic server selection.
//
// WHAT THIS MODULE IS FOR
// Choosing a streaming server needs two kinds of evidence and they live in
// different places:
//
//   1. Does the provider have this exact title, and how fast does it answer?
//      Only the server can ask that (the provider URL and the CodeSpecter key
//      never reach the browser), so it arrives via /api/embed/servers, which
//      probes all providers in parallel under a hard deadline.
//   2. Can THIS browser, on THIS network, reach the provider at all?
//      Only the client can ask that, and it is the failure mode a datacenter
//      probe is blindest to: DNS-level ad blockers, extension blocklists,
//      corporate/school filters and captive portals kill specific providers for
//      a specific viewer while the same provider answers our edge perfectly.
//
// This module runs both, in parallel, against one shared sub-second budget, and
// merges them into the `RankableServer` shape that serverRanking.ts scores.
//
// HONESTY ABOUT THE CLIENT-SIDE CHECK — READ BEFORE EXTENDING IT
// The reachability probe is a `no-cors` HEAD request to the provider's ORIGIN.
// Being opaque, its response tells us exactly one bit: the request completed, or
// it did not. It cannot read a status code, cannot tell 200 from 403, and cannot
// say anything about the video. So:
//   • a completed request means "the network path to this provider is open" —
//     recorded as `reachable: true`;
//   • a rejected request means "this browser cannot talk to this host" —
//     recorded as `reachable: false`, which serverRanking treats as a hard
//     disqualification, because a host the browser cannot open will not stream;
//   • anything unfinished when the budget expires stays `null` (unknown) and is
//     scored neither up nor down.
// The origins below are not secrets: they appear in the browser's network panel
// the moment any player frame loads. No paths, no query strings, no API keys.
//
// WHAT WE DELIBERATELY DO NOT DO
// We do not mount hidden player iframes to "validate playback" during selection.
// That would start up to five concurrent video sessions (and five ad wrappers)
// on a phone to answer a question the real frame answers a moment later for
// free — the actual playback confirmation arrives from the mounted player as
// proof-of-life and is recorded in the reliability ledger, which is what makes
// the next pick better. Selection stays cheap; validation stays real.

import type { RankableServer } from './serverRanking';

/** One server as the health engine sees it, before scoring. */
export interface ServerHealthSnapshot extends RankableServer {
  id: string;
  name: string;
  label: string;
  verified: boolean;
  online: boolean;
  confidence: 'title' | 'live';
  latencyMs: number | null;
  maxHeight: number | null;
  bitrateKbps: number | null;
  qualityLabel: string | null;
  pending: boolean;
  reachable: boolean | null;
  clientLatencyMs: number | null;
}

/** Result of one selection pass. */
export interface HealthCheckResult {
  servers: ServerHealthSnapshot[];
  /** Epoch ms the result was produced. */
  checkedAt: number;
  /** How long the whole parallel pass actually took, in ms. */
  elapsedMs: number;
  /** True when this came from cache without any network work. */
  fromCache: boolean;
  /** True when the edge probe could not be reached at all. */
  degraded: boolean;
}

export interface HealthTarget {
  type: 'movie' | 'tv';
  id: number | string;
  season?: number | null;
  episode?: number | null;
}

// ─── Budgets ──────────────────────────────────────────────────────────────────
// The product requirement is that selection finishes in under a second. These
// numbers are chosen so the WORST case still does: the edge probe and the
// reachability probes run concurrently, so the pass costs max(EDGE, CLIENT), not
// their sum, and both sit comfortably under 1000ms including React's own commit.

/** Total wall-clock budget for one selection pass. */
export const SELECTION_BUDGET_MS = 900;
/** Deadline handed to /api/embed/servers for its own parallel probe pass. */
const EDGE_BUDGET_MS = 750;
/** Per-provider budget for the client-side reachability probe. */
const REACHABILITY_BUDGET_MS = 600;
/**
 * How long a health result stays usable. The requirement is 30–60s; 45s sits in
 * the middle, which is long enough that flicking between episodes of a series
 * costs no network at all and short enough that a provider that fell over is
 * re-checked while the viewer is still in the same session.
 */
export const HEALTH_TTL_MS = 45 * 1000;
/**
 * A cache entry older than the TTL but younger than this is still served
 * immediately, with a revalidation kicked off in the background. Stale-while-
 * revalidate is what keeps the second and third episode instant without ever
 * showing the viewer a stale-forever answer.
 */
const HEALTH_STALE_MS = 5 * 60 * 1000;
/** One retry for a transient edge failure, then we fall back to unprobed data. */
const EDGE_RETRIES = 1;

// ─── Client-safe provider origins ─────────────────────────────────────────────
// Origin only, by design: enough to test the network path, not enough to build a
// player URL (that stays server-side in src/lib/embed.ts, along with the key).
const PROVIDER_ORIGIN: Readonly<Record<string, string>> = {
  vidsrcin: 'https://vidsrc.in',
  vidlink: 'https://vidlink.pro',
  videasy: 'https://player.videasy.net',
  vidfast: 'https://vidfast.pro',
  nexstream: 'https://www.vidking.net',
};

/**
 * Client-safe mirror of EMBED_SERVER_META — ids, display names and probe
 * confidence, no URLs and no keys. Used to seed a full list before (or instead
 * of) the edge answering, so the player never has zero servers to offer.
 */
export const KNOWN_SERVERS: ReadonlyArray<{
  id: string;
  name: string;
  label: string;
  confidence: 'title' | 'live';
}> = [
  { id: 'vidlink', name: 'VidLink (Fast HD)', label: 'Server 1', confidence: 'title' },
  { id: 'vidfast', name: 'VidFast', label: 'Server 2', confidence: 'live' },
  { id: 'videasy', name: 'Videasy (Multi-Source)', label: 'Server 3', confidence: 'live' },
  { id: 'vidsrcin', name: 'VidSrc IN (Hindi)', label: 'Server 4', confidence: 'title' },
  { id: 'nexstream', name: 'NexStream', label: 'Server 5', confidence: 'title' },
];

/** A list with no evidence attached. Never empty, so the UI always has options. */
export function unprobedServers(): ServerHealthSnapshot[] {
  return KNOWN_SERVERS.map((meta) => ({
    ...meta,
    verified: false,
    online: false,
    latencyMs: null,
    maxHeight: null,
    bitrateKbps: null,
    qualityLabel: null,
    pending: true,
    reachable: null,
    clientLatencyMs: null,
  }));
}

/** Cache key for a title. Episode-specific, because availability is. */
export function healthKey(target: HealthTarget): string {
  return target.type === 'tv'
    ? `tv:${target.id}:${target.season ?? 1}:${target.episode ?? 1}`
    : `movie:${target.id}`;
}

// ─── Cache ────────────────────────────────────────────────────────────────────
// Two layers with different jobs:
//   • an in-memory Map — survives client-side navigation within the SPA shell
//     (Astro's ClientRouter keeps the module graph alive), costs nothing to read,
//     and is the layer that makes episode switching instant;
//   • sessionStorage — survives a full document navigation and a back/forward
//     trip, which is exactly how viewers move between a listing page and a
//     detail page. Not localStorage: health is a "right now" fact and has no
//     business outliving the tab.

interface CacheEntry {
  result: HealthCheckResult;
  expires: number;
}

const memory = new Map<string, CacheEntry>();
const MEMORY_MAX = 60;
const STORE_KEY = 'streamer.player.health.v1';

function canUseSession(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !!window.sessionStorage;
  } catch {
    return false; // strict privacy mode
  }
}

function readSession(): Record<string, CacheEntry> {
  if (!canUseSession()) return {};
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSession(key: string, entry: CacheEntry): void {
  if (!canUseSession()) return;
  try {
    const all = readSession();
    const now = Date.now();
    // Prune on write; there is no other moment we are guaranteed to run.
    for (const [k, v] of Object.entries(all)) {
      if (!v || (v.expires ?? 0) + HEALTH_STALE_MS < now) delete all[k];
    }
    all[key] = entry;
    sessionStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* quota or private mode — the memory layer still works */
  }
}

/**
 * Cached health for a target.
 *
 * Returns the entry plus whether it is fresh. A stale-but-recent entry is still
 * returned so the caller can play immediately and revalidate behind the frame;
 * anything older than HEALTH_STALE_MS is treated as absent.
 */
export function readCachedHealth(
  target: HealthTarget
): { result: HealthCheckResult; fresh: boolean } | null {
  const key = healthKey(target);
  const now = Date.now();
  const entry = memory.get(key) ?? readSession()[key];
  if (!entry || !entry.result) return null;
  if (entry.expires + HEALTH_STALE_MS < now) {
    memory.delete(key);
    return null;
  }
  // Re-seat a sessionStorage hit in memory so the next read is free.
  memory.set(key, entry);
  return { result: { ...entry.result, fromCache: true }, fresh: entry.expires > now };
}

function cacheHealth(target: HealthTarget, result: HealthCheckResult): void {
  const key = healthKey(target);
  const entry: CacheEntry = { result, expires: Date.now() + HEALTH_TTL_MS };
  if (memory.size >= MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, entry);
  writeSession(key, entry);
}

/** Drop everything we know. Exposed for tests and for a hard manual retry. */
export function clearHealthCache(): void {
  memory.clear();
  if (!canUseSession()) return;
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* ignore */
  }
}

// ─── The two parallel probes ──────────────────────────────────────────────────

interface EdgeServer {
  id: string;
  name: string;
  label: string;
  verified?: boolean;
  online?: boolean;
  confidence?: 'title' | 'live';
  latencyMs?: number | null;
  maxHeight?: number | null;
  bitrateKbps?: number | null;
  qualityLabel?: string | null;
  pending?: boolean;
}

/** Abort helper: one timer, cleared on settle, so nothing leaks on a fast path. */
function withTimeout(budgetMs: number, external?: AbortSignal): {
  signal: AbortSignal;
  done: () => void;
  /** True when OUR timer fired, as opposed to the caller aborting. */
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, budgetMs);
  const onExternalAbort = () => controller.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
    timedOut: () => expired,
  };
}

/**
 * Ask the edge how every provider looks for this title. One request, because the
 * endpoint already probes all five providers in parallel behind its own deadline
 * — five requests from the browser would only add five TLS handshakes.
 *
 * Retries once on a transient failure (a dropped connection to a same-origin
 * route), but NEVER on our own timeout. Retrying a timeout would double the
 * worst case, and the replacement request could only answer after the selection
 * budget had already expired — it would cost a round-trip to produce an answer
 * nobody is still waiting for.
 */
async function probeEdge(
  target: HealthTarget,
  signal: AbortSignal | undefined,
  attempt = 0
): Promise<EdgeServer[] | null> {
  const params = new URLSearchParams({ type: target.type, id: String(target.id) });
  if (target.type === 'tv') {
    params.set('season', String(target.season ?? 1));
    params.set('episode', String(target.episode ?? 1));
  }
  params.set('budget', String(EDGE_BUDGET_MS));

  const gate = withTimeout(EDGE_BUDGET_MS + 150, signal);
  try {
    const response = await fetch(`/api/embed/servers?${params.toString()}`, {
      signal: gate.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(String(response.status));
    const data = (await response.json()) as { servers?: EdgeServer[] };
    return data.servers ?? null;
  } catch {
    const retryable = !gate.timedOut() && signal?.aborted !== true && attempt < EDGE_RETRIES;
    if (retryable) return probeEdge(target, signal, attempt + 1);
    return null;
  } finally {
    gate.done();
  }
}

/**
 * Can this browser reach the provider's origin? See the module header for
 * exactly how much (and how little) an opaque response tells us.
 *
 * All providers are probed in the same tick — `Promise.all` over one request
 * each — so the whole pass costs one round-trip, not five.
 *
 * A failed HEAD is retried once as a GET before we conclude anything, because
 * some hosts reject HEAD at the connection level. Without that retry a perfectly
 * good provider could be disqualified for a protocol quirk, and `reachable:
 * false` is a hard gate — it has to be earned.
 */
async function probeReachability(
  ids: readonly string[],
  signal?: AbortSignal
): Promise<Map<string, { reachable: boolean | null; latencyMs: number | null }>> {
  const out = new Map<string, { reachable: boolean | null; latencyMs: number | null }>();
  if (typeof fetch !== 'function') return out;

  const attempt = async (origin: string, method: 'HEAD' | 'GET', budgetMs: number) => {
    const gate = withTimeout(budgetMs, signal);
    const startedAt = now();
    try {
      await fetch(origin, {
        method,
        mode: 'no-cors',
        // Never let a cached opaque response answer a liveness question.
        cache: 'no-store',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: gate.signal,
      });
      return { ok: true, timedOut: false, latencyMs: Math.round(now() - startedAt) };
    } catch {
      return { ok: false, timedOut: gate.timedOut() || signal?.aborted === true, latencyMs: null };
    } finally {
      gate.done();
    }
  };

  await Promise.all(
    ids.map(async (id) => {
      const origin = PROVIDER_ORIGIN[id];
      if (!origin) {
        out.set(id, { reachable: null, latencyMs: null });
        return;
      }

      // Two attempts share the budget, so a retry can never push the pass over
      // its deadline.
      const head = await attempt(origin, 'HEAD', Math.round(REACHABILITY_BUDGET_MS * 0.6));
      if (head.ok) {
        out.set(id, { reachable: true, latencyMs: head.latencyMs });
        return;
      }
      if (head.timedOut) {
        // Ran out of time rather than being refused: unknown, not negative.
        out.set(id, { reachable: null, latencyMs: null });
        return;
      }

      const get = await attempt(origin, 'GET', Math.round(REACHABILITY_BUDGET_MS * 0.4));
      if (get.ok) {
        out.set(id, { reachable: true, latencyMs: get.latencyMs });
        return;
      }
      // Refused both ways. That is a network-level block, and the only thing
      // in this module allowed to disqualify a provider outright.
      out.set(id, { reachable: get.timedOut ? null : false, latencyMs: null });
    })
  );

  return out;
}

/** Monotonic clock where available, so a system clock change cannot skew timings. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

// ─── The selection pass ───────────────────────────────────────────────────────

function mergeSnapshots(
  edge: EdgeServer[] | null,
  reach: Map<string, { reachable: boolean | null; latencyMs: number | null }>
): ServerHealthSnapshot[] {
  const byId = new Map((edge ?? []).map((s) => [s.id, s]));
  // Iterate the client-side registry, not the edge response: a provider missing
  // from a truncated or partial response must still be offered.
  return KNOWN_SERVERS.map((meta) => {
    const e = byId.get(meta.id);
    const r = reach.get(meta.id);
    return {
      id: meta.id,
      name: e?.name ?? meta.name,
      label: e?.label ?? meta.label,
      confidence: e?.confidence ?? meta.confidence,
      verified: e?.verified ?? false,
      online: e?.online ?? false,
      latencyMs: e?.latencyMs ?? null,
      maxHeight: e?.maxHeight ?? null,
      bitrateKbps: e?.bitrateKbps ?? null,
      qualityLabel: e?.qualityLabel ?? null,
      // No edge answer at all means "not checked", which is what pending means.
      pending: e ? (e.pending ?? false) : true,
      reachable: r?.reachable ?? null,
      clientLatencyMs: r?.latencyMs ?? null,
    };
  });
}

/**
 * Run one health pass for a target: edge probe and client reachability probes
 * together, merged, cached and returned.
 *
 * NEVER REJECTS and never runs long. Both probes are raced against
 * SELECTION_BUDGET_MS, and whatever evidence has landed by then is what the
 * caller scores — a slow provider costs the pick some confidence, never the
 * viewer a second of waiting. When nothing lands at all the caller still gets a
 * full server list (flagged `degraded`), because a player with no buttons is a
 * worse outcome than a player with unproven ones.
 */
export async function checkServerHealth(
  target: HealthTarget,
  options: { signal?: AbortSignal; budgetMs?: number } = {}
): Promise<HealthCheckResult> {
  const budget = Math.max(200, options.budgetMs ?? SELECTION_BUDGET_MS);
  const startedAt = now();
  const ids = KNOWN_SERVERS.map((s) => s.id);

  const edgePromise = probeEdge(target, options.signal);
  const reachPromise = probeReachability(ids, options.signal);

  // The budget applies to the PASS, not to each probe: whichever evidence has
  // arrived when the clock runs out is what we use.
  let expire: () => void = () => {};
  const deadline = new Promise<'deadline'>((resolve) => {
    const timer = setTimeout(() => resolve('deadline'), budget);
    expire = () => clearTimeout(timer);
  });

  let edge: EdgeServer[] | null = null;
  let reach = new Map<string, { reachable: boolean | null; latencyMs: number | null }>();

  try {
    const both = Promise.all([edgePromise, reachPromise]).then((pair) => {
      [edge, reach] = pair;
      return 'settled' as const;
    });
    const outcome = await Promise.race([both, deadline]);
    if (outcome === 'deadline') {
      // Losing the race is not losing the work: both probes keep going and their
      // results land in the cache through the revalidation path below, so the
      // NEXT pass (episode change, or the 45s revalidation) is fully informed.
      void both.catch(() => undefined);
    }
  } catch {
    /* probeEdge / probeReachability already swallow their own failures */
  } finally {
    expire();
  }

  const result: HealthCheckResult = {
    servers: mergeSnapshots(edge, reach),
    checkedAt: Date.now(),
    elapsedMs: Math.round(now() - startedAt),
    fromCache: false,
    degraded: edge === null,
  };

  // Only cache a pass that learned something. Caching a fully degraded result
  // would pin the player to "we know nothing" for the whole TTL.
  if (!result.degraded) cacheHealth(target, result);
  return result;
}

// ─── Prefetch ─────────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<HealthCheckResult>>();

/**
 * Warm the cache for a target without blocking anything.
 *
 * Called for the title a viewer is looking at (before they press Play) and for
 * the next episode (while the current one plays), so by the time selection
 * actually runs the answer is usually already sitting in memory and the pick
 * costs zero network. De-duplicated by key: ten hover events cost one request.
 */
export function prefetchServerHealth(target: HealthTarget): Promise<HealthCheckResult> | null {
  if (typeof window === 'undefined') return null;
  const key = healthKey(target);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const cached = readCachedHealth(target);
  if (cached?.fresh) return Promise.resolve(cached.result);

  const run = checkServerHealth(target).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * Prefetch when the browser is idle, so warming the next episode never competes
 * with the frame that is currently painting. Falls back to a short timeout in
 * Safari, which still ships no requestIdleCallback.
 */
export function prefetchWhenIdle(target: HealthTarget): void {
  if (typeof window === 'undefined') return;
  const run = () => void prefetchServerHealth(target);
  const idle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 2000 });
  else window.setTimeout(run, 250);
}

/**
 * Health for a target, cheapest path first.
 *
 * 1. A fresh cache entry is returned synchronously-fast, with no network at all.
 * 2. A stale-but-recent entry is returned immediately AND revalidated in the
 *    background, so playback starts now and the next pick is current.
 * 3. Otherwise a full pass runs under the selection budget — and it is SHARED.
 *    Two callers asking at the same moment (React's development double-mount, a
 *    prefetch racing the real selection, two player islands on one page) must
 *    cost one pass, not two: five probes per provider per caller is exactly the
 *    kind of waste an automatic system should never generate.
 *
 * The shared pass deliberately does not take the caller's AbortSignal: it is
 * already bounded by the selection budget, and letting whichever caller unmounts
 * first abort the work would hand the other caller a degraded result. Callers
 * check their own signal after awaiting and discard what they no longer need.
 */
export async function resolveServerHealth(
  target: HealthTarget,
  options: { signal?: AbortSignal; budgetMs?: number } = {}
): Promise<HealthCheckResult> {
  const cached = readCachedHealth(target);
  if (cached?.fresh) return cached.result;
  if (cached) {
    // Stale-while-revalidate. The returned value is the stale one on purpose:
    // waiting for the refresh would spend the viewer's second re-learning what
    // we already know.
    prefetchServerHealth(target);
    return cached.result;
  }

  const key = healthKey(target);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = checkServerHealth(target, { budgetMs: options.budgetMs }).finally(() =>
    inFlight.delete(key)
  );
  inFlight.set(key, run);
  return run;
}
