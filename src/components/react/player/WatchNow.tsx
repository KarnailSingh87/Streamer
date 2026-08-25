// src/components/react/player/WatchNow.tsx — the Watch Now island.
//
// Composes everything: engine selection, streaming-server list, season/episode
// state, Continue Watching, Up Next and the end card. All playback behaviour
// lives in usePlayer; all chrome lives in PlayerShell. This file is the product
// logic that decides *what* to play.
//
// ENGINE PRIORITY
//   1. 'html5'   when the caller passes a first-party source (licensed HLS/MP4).
//                Full capabilities: real seek bar, audio renditions, captions.
//   2. 'embed'   the streaming providers, when at least one server exists.
//                Degraded on purpose — see adapters/embed.ts.
//   3. 'youtube' the TMDB trailer. Also offered alongside the others whenever a
//                trailer key exists, because it is the one source Streamer can
//                always play with full controls.
//
// SERIES STATE
// Episodes are fetched from /api/tv/:id/season/:season (keeps the TMDB key on the
// server) and cached per season, so flicking between season tabs is instant.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayer } from './usePlayer';
import PlayerShell from './PlayerShell';
import SourceBar, { type ServerOption } from './SourceBar';
import EpisodeOverlay, { type EpisodeItem, type SeasonOption } from './EpisodeOverlay';
import UpNext from './UpNext';
import EndCard, { type RelatedTitle } from './EndCard';
import { useEmbedServers } from '../useEmbedServers';
import { createPlayerT } from '../../../lib/player/strings';
import { languageDirection } from '../../../lib/player/languages';
import { SUPPORTED_LOCALES, type Locale } from '../../../lib/i18n';
import type {
  EngineId,
  MediaSource,
  PlayerSource,
  TimeMarker,
} from '../../../lib/player/types';
import { getContinueEntry, saveContinueWatching } from '../../../lib/continueWatching';

/** Seconds of credits left when the Up Next prompt appears. */
const UPNEXT_LEAD_SECONDS = 30;
/** Countdown before auto-advancing once a title actually ends. */
const AUTOPLAY_COUNTDOWN = 8;
/** Ignore a resume offer this close to the start or the end. */
const RESUME_MIN = 15;
const RESUME_TAIL = 60;

export interface WatchNowProps {
  mediaType: 'movie' | 'tv';
  /** TMDB id. */
  id: number | string;
  title: string;
  /** Splash / poster art. */
  backdropUrl?: string | null;
  posterUrl?: string | null;
  /** Seasons for the episode picker (tv only, specials excluded). */
  seasons?: SeasonOption[];
  /** YouTube key of the official trailer, when TMDB has one. */
  trailerKey?: string | null;
  /**
   * First-party media. Pass this once Streamer has a licensed stream and the
   * player upgrades itself to full capabilities with no other change.
   */
  media?: MediaSource | null;
  /** Chapter markers driving Skip Intro / Skip Recap / credits. */
  markers?: TimeMarker[];
  /** "More like this" tiles for the end card. */
  related?: RelatedTitle[];
  /** UI language for the player chrome. */
  locale?: Locale;
}

export default function WatchNow({
  mediaType,
  id,
  title,
  backdropUrl,
  posterUrl,
  seasons = [],
  trailerKey,
  media,
  markers = [],
  related = [],
  locale = 'en',
}: WatchNowProps) {
  /**
   * Locale is resolved in the browser, not on the server. Detail pages are
   * edge-cached (see src/middleware.ts) without a `Vary: Accept-Language`, so
   * baking a language into the HTML would serve one viewer's language to
   * everyone. The prop is the default; the browser refines it after hydration.
   */
  const [uiLocale, setUiLocale] = useState<Locale>(locale);
  useEffect(() => {
    const candidates = [
      document.documentElement.lang,
      ...(navigator.languages ?? [navigator.language]),
    ];
    for (const candidate of candidates) {
      const short = (candidate ?? '').slice(0, 2).toLowerCase() as Locale;
      if (SUPPORTED_LOCALES.includes(short)) {
        setUiLocale(short);
        return;
      }
    }
  }, []);

  const t = useMemo(() => createPlayerT(uiLocale), [uiLocale]);
  const chromeDir = languageDirection(uiLocale);
  const numericId = typeof id === 'string' ? parseInt(id, 10) : id;
  const isSeries = mediaType === 'tv';

  // ── Which engines can we offer? ───────────────────────────────────────────
  const availableEngines = useMemo<EngineId[]>(() => {
    const list: EngineId[] = [];
    if (media) list.push('html5');
    // The embed engine is always an option for a real title; the server list is
    // never empty (useEmbedServers falls back to the static registry).
    list.push('embed');
    if (trailerKey) list.push('youtube');
    return list;
  }, [media, trailerKey]);

  const [engine, setEngine] = useState<EngineId>(() => (media ? 'html5' : 'embed'));
  const [started, setStarted] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [upNextDismissed, setUpNextDismissed] = useState(false);

  // ── Transient status line ─────────────────────────────────────────────────
  // Used for silent recovery (a server fell over and we moved on). Deliberately
  // a toast and not an error card: the viewer's video is playing, so the message
  // explains and then gets out of the way.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // ── Series state ──────────────────────────────────────────────────────────
  /**
   * The island never trusts the season list to be usable. A caller may pass an
   * empty array (TMDB has no season data for this title — common for anime and
   * for some Amazon / Netflix originals), and providers still play `S1E1` for
   * those ids, so we synthesise one season rather than degrading into a
   * movie-shaped player with no episode controls.
   *
   * `episode_count: 0` means "unknown"; the fetched episode list wins wherever
   * a count is needed (see `countBySeason`).
   */
  const effectiveSeasons = useMemo<SeasonOption[]>(() => {
    if (!isSeries) return [];
    if (seasons.length > 0) return seasons;
    return [{ season_number: 1, name: 'Season 1', episode_count: 0 }];
  }, [isSeries, seasons]);

  const firstSeason = effectiveSeasons[0]?.season_number ?? 1;
  const [activeSeason, setActiveSeason] = useState(firstSeason);
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState(false);
  const [seasonNonce, setSeasonNonce] = useState(0);
  const episodeCache = useRef(new Map<number, EpisodeItem[]>());
  const [current, setCurrent] = useState<{ season: number; episode: number } | null>(null);

  // ── Continue Watching ─────────────────────────────────────────────────────
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [preferredServer, setPreferredServer] = useState<string | null>(null);

  useEffect(() => {
    const entry = getContinueEntry(Number(numericId), mediaType);
    if (!entry) return;
    if (entry.server) setPreferredServer(entry.server);
    if (isSeries && entry.season && entry.episode) {
      // Only adopt the remembered season if the title still lists it. Season
      // lists do change (TMDB re-numbers, specials get folded in), and selecting
      // a season with no tab leaves the picker looking broken.
      const known = effectiveSeasons.some((s) => s.season_number === entry.season);
      if (known) {
        setActiveSeason(entry.season);
        // The episode is offered, not forced: the splash shows "Resume S2 E4".
        setCurrent({ season: entry.season, episode: entry.episode });
      }
    }
    const position = entry.positionSeconds ?? 0;
    const duration = entry.durationSeconds ?? 0;
    // Do not resume from the first seconds, and do not resume something the
    // viewer effectively finished.
    if (position > RESUME_MIN && (duration === 0 || position < duration - RESUME_TAIL)) {
      setResumeAt(position);
    }
  }, [numericId, mediaType, isSeries, effectiveSeasons]);

  // ── Streaming servers (embed engine only) ─────────────────────────────────
  // Nothing is preselected. The hook scores every server from a parallel health
  // pass (see lib/player/serverHealth.ts) and hands back a decision within its
  // sub-second budget; this island only says which title it wants and reacts to
  // outcomes. See serverRanking.ts for the weights behind "best".
  const {
    ranked,
    recommended,
    isAuto,
    server,
    setServer,
    chooseServer,
    useAutoServer,
    reportOutcome,
    resetTried,
    selecting,
    exhausted,
    confirmLive,
    prefetch,
  } = useEmbedServers({
    type: isSeries ? 'tv' : 'movie',
    id,
    season: current?.season ?? null,
    episode: current?.episode ?? null,
    enabled: engine === 'embed' && (!isSeries || current !== null),
    preferred: preferredServer,
  });

  // ── Season fetching ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isSeries) return;
    const cached = episodeCache.current.get(activeSeason);
    if (cached) {
      setEpisodes(cached);
      setEpisodesLoading(false);
      setEpisodesError(false);
      return;
    }
    const controller = new AbortController();
    setEpisodesLoading(true);
    setEpisodesError(false);
    setEpisodes([]);
    fetch(`/api/tv/${id}/season/${activeSeason}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<{ episodes?: EpisodeItem[] }>;
      })
      .then((data) => {
        const list = data.episodes ?? [];
        episodeCache.current.set(activeSeason, list);
        setEpisodes(list);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setEpisodesError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setEpisodesLoading(false);
      });
    return () => controller.abort();
  }, [id, isSeries, activeSeason, seasonNonce]);

  // ── Episode neighbours (crossing season boundaries) ───────────────────────
  const seasonOrder = useMemo(
    () => effectiveSeasons.map((s) => s.season_number).sort((a, b) => a - b),
    [effectiveSeasons]
  );
  const countBySeason = useMemo(() => {
    const map = new Map<number, number>();
    effectiveSeasons.forEach((s) => map.set(s.season_number, s.episode_count ?? 0));
    // The fetched list is ground truth for the season we are looking at: TMDB
    // reports `episode_count: 0` for plenty of currently-airing seasons, and
    // trusting that would make "next episode" jump a whole season.
    if (episodes.length > 0) {
      const known = map.get(activeSeason) ?? 0;
      map.set(activeSeason, Math.max(known, episodes.length));
    }
    return map;
  }, [effectiveSeasons, episodes.length, activeSeason]);

  /**
   * Lowest episode number in the active season. Almost always 1, but TMDB does
   * carry seasons numbered from 0 (specials, recaps, some anime imports), and
   * "Play" must start at a real episode, not a guess.
   */
  const firstEpisodeNumber = useMemo(() => {
    if (episodes.length === 0) return 1;
    return episodes.reduce((low, e) => Math.min(low, e.episode_number), Infinity) || 1;
  }, [episodes]);

  const neighbours = useMemo(() => {
    if (!current) return { prev: null, next: null } as {
      prev: { season: number; episode: number } | null;
      next: { season: number; episode: number } | null;
    };
    const { season, episode } = current;
    const count = countBySeason.get(season) ?? 0;
    const index = seasonOrder.indexOf(season);
    const lowest = season === activeSeason ? firstEpisodeNumber : 1;

    let prev: { season: number; episode: number } | null = null;
    if (episode > lowest) prev = { season, episode: episode - 1 };
    else if (index > 0) {
      const previousSeason = seasonOrder[index - 1]!;
      // Unknown count for that season: offer its first episode rather than
      // nothing, since the provider can play it either way.
      prev = { season: previousSeason, episode: countBySeason.get(previousSeason) || 1 };
    }

    let next: { season: number; episode: number } | null = null;
    if (count === 0) {
      // Count unknown (season list has no counts and the episode list has not
      // arrived). Assume the season continues — the alternative is hiding Next
      // Episode on titles where it works perfectly well.
      next = { season, episode: episode + 1 };
    } else if (episode < count) {
      next = { season, episode: episode + 1 };
    } else if (index >= 0 && index < seasonOrder.length - 1) {
      next = { season: seasonOrder[index + 1]!, episode: 1 };
    }
    return { prev, next };
  }, [current, countBySeason, seasonOrder, activeSeason, firstEpisodeNumber]);

  const nextEpisodeName = useMemo(() => {
    if (!neighbours.next || neighbours.next.season !== activeSeason) return null;
    return episodes.find((e) => e.episode_number === neighbours.next!.episode)?.name ?? null;
  }, [neighbours.next, activeSeason, episodes]);

  const currentEpisodeName = useMemo(() => {
    if (!current || current.season !== activeSeason) return null;
    return episodes.find((e) => e.episode_number === current.episode)?.name ?? null;
  }, [current, activeSeason, episodes]);

  // ── Persistence ───────────────────────────────────────────────────────────
  const remember = useCallback(
    (patch?: { position?: number; duration?: number; server?: string | null }) => {
      saveContinueWatching({
        id: Number(numericId),
        mediaType,
        title,
        posterUrl: posterUrl ?? backdropUrl ?? null,
        season: current?.season,
        episode: current?.episode,
        server: patch?.server ?? server ?? undefined,
        positionSeconds: patch?.position,
        durationSeconds: patch?.duration,
      });
    },
    [numericId, mediaType, title, posterUrl, backdropUrl, current, server]
  );

  // ── Failover continuity ───────────────────────────────────────────────────
  /**
   * Latest known playback position, in seconds. Fed by the engine's progress
   * callback (for the embed engine that means the providers which volunteer
   * timing — see adapters/embed.ts) and used as the resume point when a server
   * dies mid-title, so an automatic switch costs a buffer rather than a rewind.
   */
  const positionRef = useRef(0);
  /** Position handed to the CURRENT embed frame. Only changes on a failover. */
  const [embedResumeAt, setEmbedResumeAt] = useState(0);
  /** When the current frame was mounted, for the time-to-first-frame measurement. */
  const mountedAtRef = useRef(0);

  // ── The source handed to the engine ───────────────────────────────────────
  const source = useMemo<PlayerSource | null>(() => {
    if (!started) return null;
    if (engine === 'html5' && media) {
      return { engine: 'html5', media, startAt: resumeAt ?? 0 };
    }
    if (engine === 'youtube' && trailerKey) {
      return { engine: 'youtube', videoId: trailerKey, startAt: 0 };
    }
    if (engine === 'embed' && server) {
      // `t` is the resume position. The redirect route forwards it to the
      // provider's own resume parameter where one exists (RESUME_PARAM in
      // lib/embed.ts) and drops it where it does not, so the worst case is the
      // old behaviour rather than a broken URL.
      const resume = Math.max(0, Math.floor(embedResumeAt));
      const suffix = `${resume > 0 ? `&t=${resume}` : ''}&_=${reloadKey}`;
      const url = isSeries
        ? `/api/embed/tv/${id}/${current?.season ?? 1}/${current?.episode ?? 1}?server=${server}${suffix}`
        : `/api/embed/movie/${id}?server=${server}${suffix}`;
      return { engine: 'embed', url, frameKey: `${server}-${reloadKey}` };
    }
    return null;
  }, [started, engine, media, resumeAt, trailerKey, server, isSeries, id, current, reloadKey, embedResumeAt]);

  const sourceKey = [
    engine,
    server ?? '-',
    current ? `${current.season}x${current.episode}` : '-',
    reloadKey,
    started ? 'on' : 'off',
  ].join(':');

  // ── Player ────────────────────────────────────────────────────────────────
  const onStarted = useCallback(() => {
    remember();
  }, [remember]);

  const onProgress = useCallback(
    (seconds: number, duration: number) => {
      // Kept in a ref as well as in storage: failover needs the newest position
      // synchronously, without waiting for a state commit.
      if (Number.isFinite(seconds) && seconds > 0) positionRef.current = seconds;
      remember({ position: seconds, duration });
    },
    [remember]
  );

  const [endedFlag, setEndedFlag] = useState(false);
  const onEnded = useCallback(() => setEndedFlag(true), []);

  const api = usePlayer({
    source,
    sourceKey,
    markers,
    onStarted,
    onEnded,
    onProgress,
    t,
  });

  const { snapshot, caps, setMenu, prefs } = api;

  // Any message from a provider frame is proof it is alive for this title —
  // stronger evidence than the backend probe can get. It is also a real success
  // for the reliability ledger, which is what makes tomorrow's automatic pick
  // better than today's.
  //
  // AUDIO ON THE EMBED SERVERS. Volume is relayed into the frame (every dialect
  // those players are plausibly built on — see adapters/embed.ts), but none of
  // the four providers publishes an INBOUND command API, so a server that starts
  // its own player muted can only be unmuted from inside the frame. We used to
  // surface a one-per-session toast explaining this; it was removed as noise —
  // the frame's own speaker control is discoverable enough on its own.
  useEffect(() => {
    if (engine === 'embed' && snapshot.live && server) {
      confirmLive(server);
      // How long this provider took to prove it was playing, measured from the
      // moment its frame was mounted. This is the buffering-speed signal that
      // shapes later automatic picks (see SCORE_WEIGHTS.buffering) — the only
      // part of "how fast does it buffer" a cross-origin player exposes.
      const startupMs = mountedAtRef.current > 0 ? Date.now() - mountedAtRef.current : null;
      reportOutcome(server, true, startupMs);
    }
    // `reportOutcome` is intentionally excluded: it changes identity whenever the
    // server list changes, and re-running this on that would re-record a success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, snapshot.live, server, confirmLive]);

  // The frame for this source is (re)mounting now: start the stopwatch that the
  // effect above stops when the provider proves it is alive.
  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, [sourceKey]);

  // Auto-failover: an embed frame that errors (or never loads — see the embed
  // adapter's load timeout) advances to the NEXT-BEST server by itself rather
  // than leaving a dead rectangle. `reportOutcome` records the failure (both for
  // this title and in the long-lived reliability ledger) and returns the best
  // server not yet tried for this title; when every server has been tried the
  // error card stays put (Reload / manual switch) instead of cycling dead frames
  // forever.
  //
  // The `failoverFor` guard is load-bearing: this effect also re-runs on the
  // commit right after `setServer`, when `snapshot.status` is still the stale
  // 'error' from the previous render. Without the guard one failure would walk
  // the entire server list in a single frame and land on the worst option.
  const failoverFor = useRef<string>('');
  const [failedOver, setFailedOver] = useState(false);
  useEffect(() => {
    if (engine !== 'embed' || snapshot.status !== 'error' || !server) return;
    if (failoverFor.current === sourceKey) return;
    failoverFor.current = sourceKey;
    const next = reportOutcome(server, false);
    if (!next) return;
    setFailedOver(true);
    // Non-intrusive and short: the viewer's video is about to continue, so the
    // message explains in one line and leaves. The provider name goes in the
    // persistent notice below the stage, not in the toast.
    showToast(t('switchedToBetter'));
    // CONTINUITY. Hand the replacement server the position we were at, so the
    // switch costs a buffer rather than a rewind. `snapshot.currentTime` is
    // preferred (it is the freshest reading) and `positionRef` covers the case
    // where the provider stopped volunteering timing before it died.
    const resumeFrom = Math.max(snapshot.currentTime || 0, positionRef.current);
    if (resumeFrom > 1) setEmbedResumeAt(resumeFrom);
    setServer(next);
    setPreferredServer(next);
    setReloadKey((key) => key + 1);
    remember({ server: next, position: resumeFrom > 1 ? resumeFrom : undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, snapshot.status, server, sourceKey]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const start = useCallback(() => {
    // For a series with nothing selected, start at the first episode that
    // actually exists in this season (not always 1 — see firstEpisodeNumber).
    if (isSeries && !current) setCurrent({ season: activeSeason, episode: firstEpisodeNumber });
    // Providers that accept a resume parameter now get the Continue Watching
    // position too, so "Resume" means the same thing on every engine.
    if (resumeAt && resumeAt > 1) setEmbedResumeAt(resumeAt);
    setStarted(true);
    setEndedFlag(false);
  }, [isSeries, current, activeSeason, firstEpisodeNumber, resumeAt]);

  const reload = useCallback(() => {
    setEndedFlag(false);
    // Manual retry: give the current server a genuine fresh attempt and re-enable
    // the full failover walk. The position is deliberately kept, so a reload
    // resumes rather than restarts.
    resetTried();
    failoverFor.current = '';
    setReloadKey((key) => key + 1);
  }, [resetTried]);

  const switchEngine = useCallback(
    (next: EngineId) => {
      setEngine(next);
      setEndedFlag(false);
      setResumeAt(null);
      setReloadKey((key) => key + 1);
    },
    []
  );

  const switchServer = useCallback(
    (next: string) => {
      // A deliberate pick, remembered for this title for the whole session so no
      // re-render, refetch or unrelated island can drop it back to auto-best.
      chooseServer(next);
      setPreferredServer(next);
      setFailedOver(false);
      failoverFor.current = '';
      setEndedFlag(false);
      // Same continuity as automatic failover: a viewer switching servers mid-film
      // wants the new one to pick up where they were.
      const resumeFrom = Math.max(snapshot.currentTime || 0, positionRef.current);
      if (resumeFrom > 1) setEmbedResumeAt(resumeFrom);
      setReloadKey((key) => key + 1);
      remember({ server: next });
    },
    [chooseServer, remember, snapshot.currentTime]
  );

  /** Hand selection back to the ranking (the "Auto" pill). */
  const switchToAuto = useCallback(() => {
    const best = useAutoServer();
    if (!best) return;
    setPreferredServer(best);
    setFailedOver(false);
    failoverFor.current = '';
    setReloadKey((key) => key + 1);
    remember({ server: best });
  }, [useAutoServer, remember]);

  const playEpisode = useCallback(
    (season: number, episode: number) => {
      setCurrent({ season, episode });
      setActiveSeason(season);
      setResumeAt(null);
      // A different episode starts at its own beginning, never at the previous
      // episode's position.
      setEmbedResumeAt(0);
      positionRef.current = 0;
      setEndedFlag(false);
      setUpNextDismissed(false);
      // New episode = new title context; a server that failed for the previous
      // one may serve this one, so let failover reconsider all of them.
      resetTried();
      failoverFor.current = '';
      setStarted(true);
      setMenu(null);
      setReloadKey((key) => key + 1);
    },
    [setMenu, resetTried]
  );

  const replay = useCallback(() => {
    setEndedFlag(false);
    if (caps.seek) {
      api.seekTo(0);
      api.play();
    } else {
      setReloadKey((key) => key + 1);
    }
  }, [api, caps.seek]);

  /**
   * Back: browser history first, so Astro's ClientRouter restores the previous
   * page *and its scroll position*. Only when there is no history to go back to
   * (deep link, new tab) do we fall back to the listing page.
   */
  const goBack = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.href = isSeries ? '/series' : '/movies';
  }, [isSeries]);

  // ── Up Next / end card ────────────────────────────────────────────────────
  const nextTarget = neighbours.next;
  const nearEnd =
    caps.time &&
    snapshot.duration > 0 &&
    snapshot.duration - snapshot.currentTime <= UPNEXT_LEAD_SECONDS &&
    snapshot.status === 'playing';

  const showUpNext = !!nextTarget && !upNextDismissed && (nearEnd || (endedFlag && !caps.endedSignal));
  const upNextEyebrow = nextTarget ? `S${nextTarget.season} E${nextTarget.episode}` : '';

  const upNextNode =
    showUpNext && nextTarget ? (
      <UpNext
        eyebrow={upNextEyebrow}
        title={nextEpisodeName ?? `${t('episode')} ${nextTarget.episode}`}
        stillUrl={
          nextTarget.season === activeSeason
            ? episodes.find((e) => e.episode_number === nextTarget.episode)?.still_path
              ? `https://image.tmdb.org/t/p/w300${
                  episodes.find((e) => e.episode_number === nextTarget.episode)!.still_path
                }`
              : null
            : null
        }
        // Only count down once the title has truly ended and the viewer opted in;
        // during credits it is a manual prompt.
        seconds={endedFlag && prefs.autoplayNext ? AUTOPLAY_COUNTDOWN : 0}
        onPlay={() => playEpisode(nextTarget.season, nextTarget.episode)}
        onCancel={() => setUpNextDismissed(true)}
        t={t}
      />
    ) : null;

  const endCardNode = (
    <EndCard
      title={title}
      next={
        nextTarget
          ? {
              eyebrow: upNextEyebrow,
              title: nextEpisodeName ?? `${t('episode')} ${nextTarget.episode}`,
              onPlay: () => playEpisode(nextTarget.season, nextTarget.episode),
            }
          : null
      }
      onReplay={replay}
      related={related}
      t={t}
    />
  );

  // ── Background prefetch ───────────────────────────────────────────────────
  // Warm the server-health cache for the NEXT episode while the current one
  // plays, on an idle callback so it never competes with the frame being
  // painted. When the viewer hits Next Episode the selection pass finds a fresh
  // cache entry and picks a server with no network round-trip at all.
  useEffect(() => {
    if (engine !== 'embed' || !isSeries || !started || !neighbours.next) return;
    prefetch({
      type: 'tv',
      id,
      season: neighbours.next.season,
      episode: neighbours.next.episode,
    });
  }, [engine, isSeries, started, neighbours.next, id, prefetch]);

  // ── Chrome data ───────────────────────────────────────────────────────────
  // Ranked order, so the bar reads best-first and the badge on the leader is the
  // truth about what "Auto" would play.
  const serverOptions: ServerOption[] = ranked.map(({ server: s, reason }) => ({
    id: s.id,
    name: s.name,
    verified: s.verified,
    online: s.online,
    live: s.live,
    qualityLabel: s.qualityLabel ?? null,
    latencyMs: s.latencyMs ?? null,
    pending: s.pending ?? false,
    reachable: s.reachable ?? null,
    failed: reason === 'failing',
  }));

  const subtitle = isSeries && current
    ? [`S${current.season}`, `E${current.episode}`, currentEpisodeName].filter(Boolean).join(' · ')
    : engine === 'youtube'
      ? t('trailer')
      : null;

  const episodesPanel = isSeries ? (
    <EpisodeOverlay
      variant="overlay"
      seasons={effectiveSeasons}
      activeSeason={activeSeason}
      onSeason={setActiveSeason}
      episodes={episodes}
      loading={episodesLoading}
      error={episodesError}
      onRetry={() => setSeasonNonce((n) => n + 1)}
      current={current}
      onPlay={playEpisode}
      onClose={() => setMenu(null)}
      t={t}
    />
  ) : null;

  const splashTitle = resumeAt
    ? `${title} — ${Math.floor(resumeAt / 60)}m`
    : title;

  return (
    <div className="fp-watchnow" dir={chromeDir}>
      <PlayerShell
        api={api}
        t={t}
        title={splashTitle}
        subtitle={subtitle}
        splashImage={backdropUrl ?? posterUrl ?? null}
        started={started}
        onStart={start}
        onBack={goBack}
        onReload={reload}
        markers={markers}
        showAutoplayNext={isSeries}
        episodeNav={
          isSeries
            ? {
                hasPrev: !!neighbours.prev,
                hasNext: !!neighbours.next,
                onPrev: () =>
                  neighbours.prev && playEpisode(neighbours.prev.season, neighbours.prev.episode),
                onNext: () =>
                  neighbours.next && playEpisode(neighbours.next.season, neighbours.next.episode),
                onOpenEpisodes: () => undefined,
              }
            : null
        }
        episodesPanel={episodesPanel}
        upNext={upNextNode}
        endCard={endCardNode}
        belowStage={
          <SourceBar
            available={availableEngines}
            engine={engine}
            onEngine={switchEngine}
            servers={serverOptions}
            activeServer={server}
            onServer={switchServer}
            recommended={recommended}
            isAuto={isAuto}
            onAuto={switchToAuto}
            checking={selecting}
            t={t}
          />
        }
        toast={toast}
        optimizing={selecting || (engine === 'embed' && started && !server && !exhausted)}
        notice={
          <>
            {/* Honest statement of the engine's ceiling. Only shown for the
                third-party iframe, and only once playback has started. */}
            {started && engine === 'embed' && (
              <p className="fp-notice">{t('tracksOnServerHint')}</p>
            )}
            {/* Every server has now failed for this title. This is the only
                situation in which the viewer is asked to choose one by hand. */}
            {started && engine === 'embed' && exhausted && (
              <p className="fp-notice is-warning">{t('allServersFailed')}</p>
            )}
            {/* The toast that announced the fallback is gone within seconds; this
                line stays, so a viewer who looked away still understands why they
                are on a different server and how to change it. */}
            {started && engine === 'embed' && failedOver && !exhausted && (
              <p className="fp-notice">{t('serverFellBack')}</p>
            )}
          </>
        }
      />

      {/* Browsable episode list under the player (series only). Kept out of the
          overlay so a viewer can pick an episode without covering the video.
          Driven by `effectiveSeasons`, so a title with no TMDB season data shows
          the episodes the season endpoint returns instead of nothing. */}
      {isSeries && (
        <EpisodeOverlay
          variant="inline"
          seasons={effectiveSeasons}
          activeSeason={activeSeason}
          onSeason={setActiveSeason}
          episodes={episodes}
          loading={episodesLoading}
          error={episodesError}
          onRetry={() => setSeasonNonce((n) => n + 1)}
          current={current}
          onPlay={playEpisode}
          t={t}
        />
      )}
    </div>
  );
}
