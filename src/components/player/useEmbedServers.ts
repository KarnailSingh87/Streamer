// src/components/react/useEmbedServers.ts — automatic server selection.
//
// WHAT CHANGED AND WHY
// This hook used to seed a server the instant it mounted, straight from the
// curated preference order, and let the probe reshuffle things afterwards. That
// made the first frame fast but it meant the choice was made before any evidence
// existed: the "default" server was simply whichever provider we had listed
// first, and a viewer whose network blocks that provider watched a dead frame
// before failover noticed.
//
// Now NOTHING is preselected. `server` stays null until a selection pass has
// actually decided, and the pass is bounded so that decision cannot cost the
// viewer perceptible time:
//
//   1. Health for the title is resolved through player/serverHealth.ts — one
//      parallel edge probe (all providers at once, behind its own deadline) plus
//      one parallel reachability probe per provider from the viewer's own
//      network, both raced against a single ~900ms budget.
//   2. Every server is scored by player/serverRanking.ts, which weights playback
//      success, quality, response time, buffering speed, reliability and uptime.
//   3. The highest-scoring server that is not disqualified wins and playback
//      starts. Whatever evidence had not arrived by the deadline simply did not
//      get a vote.
//
// The pass runs on mount — before the viewer presses Play — so in the common case
// it has finished long before there is anything to show, and the result is cached
// for 45s so switching episodes costs no network at all.
//
// TWO RULES THAT SURVIVED
//  1. The list is never empty. Even a total probe failure yields every provider,
//     unproven, so playback always has somewhere to go.
//  2. A server that failed for THIS title is never auto-selected again until the
//     title changes or the viewer explicitly retries.
//
// The viewer is never asked to choose. Manual picking was removed from the UI and
// with it the override channel (`writeServerOverride`): a remembered pick is
// precisely how a dead server kept being handed back to a viewer, since the
// override was read *before* any evidence was gathered. Selection now starts from
// what the ranking and the long-lived ledger know, every time.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bestServerId,
  expectsProof as rankingExpectsProof,
  qualityFor,
  qualityLabel,
  readHealth,
  recordServerOutcome,
  type HealthLedger,
} from '../../lib/player/serverRanking';
import {
  KNOWN_SERVERS,
  prefetchWhenIdle,
  readCachedHealth,
  resolveServerHealth,
  SELECTION_BUDGET_MS,
  type HealthTarget,
  type ServerHealthSnapshot,
} from '../../lib/player/serverHealth';

export interface AvailableServer {
  id: string;
  name: string;
  label: string;
  /** Backend confirmed a real source URL for this exact title. */
  verified: boolean;
  /** Provider answered the backend probe for this title. */
  online: boolean;
  confidence: 'title' | 'live';
  /** Set client-side once the frame proves it is streaming (postMessage). */
  live?: boolean;
  /** Measured probe round-trip, or null when the probe failed / never ran. */
  latencyMs?: number | null;
  /** Declared quality. Null until the data model carries it — see SERVER_QUALITY. */
  maxHeight?: number | null;
  bitrateKbps?: number | null;
  qualityLabel?: string | null;
  /** Probe had not answered inside the deadline (≠ answered "no"). */
  pending?: boolean;
  /** Reachable from this browser's network. false = blocked here. */
  reachable?: boolean | null;
  /** Round-trip to the provider's origin measured in this browser. */
  clientLatencyMs?: number | null;
  /** Measured time-to-first-frame from real playback, in ms. */
  startupMs?: number | null;
}

/**
 * `selecting` — a health pass is deciding which server to play.
 * `ready`     — a server is selected and playable.
 * `exhausted` — every server has been tried and failed for this title; the UI
 *               must now ask the viewer, which is the ONLY time it should.
 */
export type ServerStatus = 'idle' | 'selecting' | 'ready' | 'exhausted' | 'error';

/**
 * Client-safe mirror of the provider registry (ids + display names only, no
 * URLs, no keys), used so the picker is fully populated even if every check
 * fails. Quality comes from the shared registry so it ranks like a probed list.
 */
const FALLBACK_SERVERS: AvailableServer[] = KNOWN_SERVERS.map((s) => ({
  ...s,
  verified: false,
  online: false,
  latencyMs: null,
  maxHeight: qualityFor(s.id).maxHeight,
  bitrateKbps: qualityFor(s.id).bitrateKbps,
  qualityLabel: qualityLabel(s.id),
  pending: true,
  reachable: null,
  clientLatencyMs: null,
}));

/** Merge a health snapshot into the hook's server shape. */
function toServers(snapshots: readonly ServerHealthSnapshot[]): AvailableServer[] {
  if (snapshots.length === 0) return FALLBACK_SERVERS;
  return snapshots.map((s) => ({
    id: s.id,
    name: s.name,
    label: s.label,
    confidence: s.confidence,
    verified: s.verified,
    online: s.online,
    latencyMs: s.latencyMs,
    // Fall back to the declared registry so a partial edge response still ranks
    // on quality where we know it.
    maxHeight: s.maxHeight ?? qualityFor(s.id).maxHeight,
    bitrateKbps: s.bitrateKbps ?? qualityFor(s.id).bitrateKbps,
    qualityLabel: s.qualityLabel ?? qualityLabel(s.id),
    pending: s.pending,
    reachable: s.reachable,
    clientLatencyMs: s.clientLatencyMs,
  }));
}

interface Args {
  type: 'movie' | 'tv';
  id: number | string;
  season?: number | null;
  episode?: number | null;
  /** Skip the request until the caller is ready (e.g. no episode chosen yet). */
  enabled?: boolean;
  /** Server id remembered from Continue Watching, preferred when still valid. */
  preferred?: string | null;
}

export function useEmbedServers({ type, id, season, episode, enabled = true, preferred }: Args) {
  /**
   * Playback must start on the very first commit — a viewer who pressed Play
   * should never watch a "Finding the best server" pause while a health pass
   * runs. So a server IS picked before any evidence arrives, and the only
   * question is which one.
   *
   * It used to be `FALLBACK_SERVERS[0]`, i.e. whichever provider happened to be
   * listed first, which is the choice this file's own header says must not
   * happen: a hardcoded first entry is not a decision, it is a coin toss, and a
   * viewer whose network blocks that provider watched a dead frame while the real
   * selection pass was still running.
   *
   * Instead the seed is the best server *by everything this browser already
   * knows* — the reliability ledger, read synchronously from localStorage, plus
   * the curated preference and quality order. Same instant start, no network
   * round-trip, but a server chosen from experience instead of from list order.
   * A first-time viewer with no history gets the curated best, which is exactly
   * what the old code did by accident.
   */
  const seeded =
    bestServerId(FALLBACK_SERVERS, { health: readHealth() }) ??
    FALLBACK_SERVERS[0]?.id ??
    'vidlink';
  const initialPick = preferred ?? seeded;

  const [servers, setServers] = useState<AvailableServer[]>(FALLBACK_SERVERS);
  const [status, setStatus] = useState<ServerStatus>('ready');
  const [server, setServer] = useState<string | null>(initialPick);
  /** How long the last selection pass took, in ms. Surfaced for diagnostics. */
  const [selectionMs, setSelectionMs] = useState<number | null>(null);

  const preferredRef = useRef(preferred ?? null);
  preferredRef.current = preferred ?? null;

  /**
   * Servers already tried and failed for the title currently loaded. Ranked last
   * so failover never walks back onto a corpse. Owned here (rather than in the
   * island) so ranking and failover cannot disagree about what was tried.
   */
  const tried = useRef<Set<string>>(new Set());
  const healthRef = useRef<HealthLedger>({});

  // The ledger is read once on mount: it is written rarely (only on a real
  // playback outcome) and reading it on every rank would hit localStorage in a
  // render path. Held in a ref rather than state because nothing renders from it
  // directly — every rank reads `healthRef.current`, and a rank always happens
  // inside an `adopt`/`reportOutcome` call that already re-renders.
  useEffect(() => {
    healthRef.current = readHealth();
  }, []);

  const key = type === 'tv' ? `${type}:${id}:${season}:${episode}` : `${type}:${id}`;

  const target = useMemo<HealthTarget>(
    () => ({ type, id, season: season ?? null, episode: episode ?? null }),
    [type, id, season, episode]
  );

  /**
   * Decide what plays from a scored list.
   *
   * Precedence: the server remembered by Continue Watching, but only while it is
   * still viable (never failed for this title, reachable) → the highest-scoring
   * server. `null` from `bestServerId` means every server is disqualified, which
   * is the one case the viewer is told about rather than handed a list to sort.
   */
  const adopt = useCallback((list: AvailableServer[]) => {
    const safe = list.length > 0 ? list : FALLBACK_SERVERS;
    setServers(safe);

    const remembered = preferredRef.current;
    // A remembered server that has since failed for this title, or that this
    // network cannot reach, is not a preference worth honouring.
    const cw =
      safe.find(
        (s) => s.id === remembered && !tried.current.has(s.id) && s.reachable !== false
      )?.id ?? null;

    const best = bestServerId(safe, { health: healthRef.current, tried: tried.current });
    const pick = cw ?? best;

    setServer(pick);
    setStatus(pick ? 'ready' : 'exhausted');
    return pick;
  }, []);

  /**
   * Run one selection pass.
   *
   * Bounded by SELECTION_BUDGET_MS inside serverHealth, so this resolves in well
   * under a second whether the providers cooperate or not. Nothing here can throw:
   * `resolveServerHealth` always answers with a full list, degraded at worst.
   */
  const select = useCallback(
    async (signal?: AbortSignal) => {
      setStatus('selecting');
      const startedAt = Date.now();
      const result = await resolveServerHealth(target, { signal });
      if (signal?.aborted) return;
      setSelectionMs(result.fromCache ? 0 : Date.now() - startedAt);
      adopt(toServers(result.servers));
    },
    [target, adopt]
  );

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }
    // A new title/episode is a clean slate for failover: a provider that could
    // not serve the previous episode may serve this one.
    tried.current = new Set();

    const cached = readCachedHealth(target);
    if (cached?.fresh) {
      // Fresh evidence already in hand (prefetch, or another episode of this
      // title within the last 45s). Decide synchronously — no request, no
      // "optimising" state, playback starts on the very first commit.
      adopt(toServers(cached.result.servers));
      setSelectionMs(0);
      return;
    }

    // Do NOT blank out the server when switching episodes.
    // Retain the current working server, or fall back to the same seeded pick the
    // first commit used — never to a hardcoded provider name, which is how a title
    // could end up pinned to one arbitrary server no matter what the ranking or the
    // ledger had learned.
    setServer((prev) => prev ?? initialPick);

    const ac = new AbortController();
    void select(ac.signal);
    return () => ac.abort();
    // `key` collapses the id/season/episode tuple into one dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  /**
   * Record a real outcome for a server and, on failure, return the next-best
   * server to try (or null when every server has been tried for this title).
   *
   * `startupMs` is how long the server took to prove it was playing — the
   * buffering-speed signal that shapes later picks.
   *
   * `silent` says the frame loaded but never sent a message. That is the one
   * failure the server is not responsible for, and it is recorded as such so the
   * next visit stops waiting for proof from a provider that cannot give any (see
   * `expectsProof` in serverRanking.ts).
   *
   * Failure is recorded in two places on purpose: `tried` is per-title and
   * resets when the title changes, while the ledger is long-lived and shapes
   * scoring on later visits.
   */
  const reportOutcome = useCallback(
    (
      serverId: string,
      ok: boolean,
      startupMs?: number | null,
      silent?: boolean
    ): string | null => {
      const ledger = recordServerOutcome(serverId, ok, startupMs, silent);
      healthRef.current = ledger;
      if (ok) return null;
      tried.current.add(serverId);
      const next = bestServerId(servers, { health: ledger, tried: tried.current });
      setStatus(next ? 'ready' : 'exhausted');
      return next;
    },
    [servers]
  );

  /**
   * Whether this server's frame has to post a message before we believe it is
   * playing. False only for a provider already learned to be mute AND currently
   * known to be working — see the policy in serverRanking.ts.
   */
  const expectsProof = useCallback(
    (serverId: string | null): boolean =>
      serverId ? rankingExpectsProof(serverId, healthRef.current) : true,
    []
  );

  /** Manual retry of the current server: give it a genuine fresh attempt. */
  const resetTried = useCallback(() => {
    tried.current = new Set();
    setStatus((prev) => (prev === 'exhausted' ? 'ready' : prev));
  }, []);

  /** Move to the next server in the list (used when a frame fails to load). */
  const nextServer = useCallback((): string | null => {
    if (servers.length < 2 || !server) return null;
    const idx = servers.findIndex((s) => s.id === server);
    const next = servers[(idx + 1) % servers.length];
    if (!next || next.id === server) return null;
    setServer(next.id);
    return next.id;
  }, [servers, server]);

  /**
   * Mark a server as proven from the client: the frame emitted a player event,
   * which is stronger evidence than any server-side probe can get for the
   * providers whose availability is not introspectable.
   */
  const confirmLive = useCallback((serverId: string) => {
    setServers((prev) =>
      prev.map((s) =>
        s.id === serverId && !s.live
          ? { ...s, live: true, online: true, pending: false, reachable: true }
          : s
      )
    );
  }, []);

  /** Warm the health cache for another target (e.g. the next episode). */
  const prefetch = useCallback((next: HealthTarget) => prefetchWhenIdle(next), []);

  /** Force a fresh pass, ignoring the cached result. */
  const retry = useCallback(() => {
    tried.current = new Set();
    void select();
  }, [select]);

  return {
    servers,
    /** null until a selection pass has decided — nothing is preselected. */
    server,
    setServer,
    reportOutcome,
    expectsProof,
    resetTried,
    status,
    /** True while a health pass is choosing; drives the "optimising" message. */
    selecting: status === 'selecting',
    /** True when every server failed for this title and the viewer must choose. */
    exhausted: status === 'exhausted',
    /** Wall-clock cost of the last selection pass, in ms (0 = served from cache). */
    selectionMs,
    /** The budget the pass is held to, exported so the UI can be honest about it. */
    selectionBudgetMs: SELECTION_BUDGET_MS,
    retry,
    nextServer,
    confirmLive,
    prefetch,
  };
}
