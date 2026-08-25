// src/components/react/player/PlayerShell.tsx — the stage and its chrome.
//
// RESPONSIBILITIES
// Renders the engine host, every overlay (splash, spinner, error, cues, HUD,
// skip pulse, gesture zones, up-next, end card) and the control bar. It holds no
// playback state of its own: everything comes from `usePlayer`.
//
// RESPONSIVE REFLOW (not shrink)
// The bar measures its own width with a ResizeObserver and switches between three
// layouts at breakpoints read from CSS custom properties (`--fp-bp-compact`,
// `--fp-bp-wide` — see styles/player.css, no magic numbers here):
//   compact  (<40rem) primary transport only; everything secondary moves into the
//                     overflow sheet, targets grow to 44px, the title truncates.
//   regular  (<64rem) transport + volume + tracks + fullscreen inline.
//   wide     (≥64rem) adds speed, PiP, episode nav labels and the time readout.
// Measuring the *stage* rather than the viewport is deliberate: the same shell is
// used inline in a page column and in fullscreen, and only its own width matters.
//
// POINTER SURFACES
// • Engines we control (html5 / youtube): the surface is divided into three
//   vertical thirds computed from the RENDERED stage width (percentages, not
//   pixels, so they hold at 375px and at 1920px). Double-tap the left or right
//   third to skip ∓10s with a ripple drawn where the finger landed; the centre
//   third is play/pause. A single tap still does the ordinary thing — reveal the
//   controls on touch, play/pause on a mouse — because the single-tap action is
//   deferred by one double-tap window and cancelled when a second tap arrives.
// • The third-party embed engine: no overlay at all, so the provider's own
//   play/pause and seek bar stay clickable. This is why the zones are not simply
//   "left half / right half" for every engine.
//
// ISOLATION (see `containPointer`)
// The stage is an event boundary: pointer and click events raised by the player's
// own chrome stop here instead of travelling on to page-level delegates (the
// poster-card document click handler, rail drag handlers, modal backdrops).
// Anything that genuinely has to talk to the page is marked
// `data-fp-passthrough` and bubbles normally.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PlayerApi } from './usePlayer';
import { SKIP_SECONDS } from './usePlayer';
import { BRIGHTNESS_MAX, BRIGHTNESS_MIN } from '../../../lib/player/prefs';
import type { TimeMarker } from '../../../lib/player/types';
import { formatTime } from '../../../lib/player/format';
import type { PlayerT } from '../../../lib/player/strings';
import SeekBar from './SeekBar';
import VolumeControl from './VolumeControl';
import Popover from './Popover';
import TracksMenu from './TracksMenu';
import SpeedMenu from './SpeedMenu';
import OverflowMenu from './OverflowMenu';
import SubtitleLayer from './SubtitleLayer';
import {
  AudioTrackIcon,
  BackIcon,
  BrightnessIcon,
  CaptionsIcon,
  CloseIcon,
  DialogueIcon,
  EpisodesIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  MoreIcon,
  NextIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  PrevIcon,
  ReplayIcon,
  SkipIcon,
  SpeedIcon,
  VerticalDotsIcon,
  VolumeIcon,
  WarningIcon,
  ZoomInIcon,
} from './Icons';

type Layout = 'compact' | 'regular' | 'wide';

/** The three pointer regions of the stage. */
type Zone = 'left' | 'centre' | 'right';

/**
 * Window in which a second tap on the same zone counts as a double-tap, and
 * therefore also how long a single tap's action is deferred. 300ms is what
 * YouTube uses: long enough for a deliberate double-tap, short enough that a
 * single click still feels immediate.
 */
const DOUBLE_TAP_MS = 300;
/** Lifetime of the ±10s ripple. Must match the CSS animation duration. */
const RIPPLE_MS = 520;
/**
 * How long the embed fullscreen/minimize button stays on screen after any
 * reveal. Matches usePlayer's IDLE_MS so the provider frame's one piece of
 * Streamer chrome behaves like the chrome on our own engines.
 */
const SCREEN_CTL_MS = 1000;

export interface PlayerShellProps {
  api: PlayerApi;
  t: PlayerT;
  title: string;
  /** Secondary line, e.g. "S2 · E4 · Episode name". */
  subtitle?: string | null;
  /** Backdrop for the pre-play splash. */
  splashImage?: string | null;
  /** False until the viewer has pressed Play (or resumed). */
  started: boolean;
  onStart: () => void;
  onBack?: () => void;
  onReload: () => void;
  markers: TimeMarker[];
  /** Server / source switcher, rendered under the stage. */
  belowStage?: ReactNode;
  /** Episode navigation (series only). */
  episodeNav?: {
    hasPrev: boolean;
    hasNext: boolean;
    onPrev: () => void;
    onNext: () => void;
    onOpenEpisodes: () => void;
  } | null;
  /** Panel rendered when the Episodes menu is open. */
  episodesPanel?: ReactNode;
  /** Up-next prompt (series, near/after the end). */
  upNext?: ReactNode;
  /** End card (video finished). */
  endCard?: ReactNode;
  /** Extra note under the stage (e.g. the volume-relay explanation). */
  notice?: ReactNode;
  /**
   * Transient one-line status shown over the video (server fallback, quality
   * change). Netflix-style silent recovery: it appears, it explains, it leaves.
   */
  toast?: string | null;
  /**
   * Automatic server selection is still running for this title.
   *
   * Rendered as a quiet line over the stage rather than as a blocking spinner:
   * the pass is held to a sub-second budget (see useEmbedServers), so this is
   * usually gone before it is read, and it must never look like an error.
   */
  optimizing?: boolean;
  /** Autoplay-next preference plumbing for the overflow sheet. */
  showAutoplayNext: boolean;
  /** Maturity / content rating pill, e.g. "Rated U/A 13+" */
  ratingBadge?: string;
  /** Content warning / advisory text, e.g. "frightening scenes, sexual content, violence, tobacco depictions, alcohol use" */
  contentAdvisory?: string;
}

/** Read a rem-valued CSS custom property from an element, in pixels. */
function readRemToken(element: Element, name: string, fallbackPx: number): number {
  const raw = getComputedStyle(element).getPropertyValue(name).trim();
  if (!raw) return fallbackPx;
  const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  if (raw.endsWith('rem')) return parseFloat(raw) * rootSize;
  if (raw.endsWith('px')) return parseFloat(raw);
  const numeric = parseFloat(raw);
  return Number.isFinite(numeric) ? numeric : fallbackPx;
}

export default function PlayerShell({
  api,
  t,
  title,
  subtitle,
  splashImage,
  started,
  onStart,
  onBack,
  onReload,
  markers,
  belowStage,
  episodeNav,
  episodesPanel,
  upNext,
  endCard,
  notice,
  toast,
  optimizing = false,
  showAutoplayNext,
  ratingBadge,
  contentAdvisory,
}: PlayerShellProps) {
  const {
    hostRef,
    stageRef,
    snapshot,
    caps,
    engine,
    prefs,
    controlsVisible,
    menu,
    setMenu,
    isFullscreen,
    pseudoFullscreen,
    announcement,
    activeMarker,
    scrubTime,
    setScrubTime,
    togglePlay,
    seekTo,
    seekBy,
    setVolume,
    toggleMute,
    unmuteFromAutoplay,
    setRate,
    selectAudio,
    selectText,
    toggleSubtitles,
    setBrightness,
    setZoom,
    toggleGestures,
    updatePrefs,
    toggleFullscreen,
    requestPip,
    wake,
    holdChrome,
    thumbnailAt,
    skipPulse,
    slowNetwork,
    offline,
  } = api;

  const tracksBtn = useRef<HTMLButtonElement>(null);
  const speedBtn = useRef<HTMLButtonElement>(null);
  const overflowBtn = useRef<HTMLButtonElement>(null);
  const episodesBtn = useRef<HTMLButtonElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  /**
   * Keep the chrome open while the cursor is resting on it.
   *
   * Decided by GEOMETRY, not by :hover / pointerenter: the control bar is
   * `pointer-events: none` while hidden, so a cursor parked where the bar is
   * about to appear never raises an enter event — with a 1s idle timeout that
   * meant the bar faded out from under a stationary cursor and only came back on
   * the next mouse move. Testing the pointer against the interactive rows (seek
   * bar + button row, not the transparent scrim) fixes it for any pointer that
   * can hover, and touch is ignored because a finger does not rest anywhere.
   */
  const trackPointerHold = useCallback(
    (event: { clientX: number; clientY: number; pointerType?: string }) => {
      if (event.pointerType === 'touch') return;
      const host = controlsRef.current;
      if (!host) return;
      const rows = host.querySelectorAll<HTMLElement>('.fp-seek, .fp-bar, .fp-menu');
      let inside = false;
      rows.forEach((row) => {
        const r = row.getBoundingClientRect();
        if (
          event.clientX >= r.left &&
          event.clientX <= r.right &&
          event.clientY >= r.top &&
          event.clientY <= r.bottom
        ) {
          inside = true;
        }
      });
      holdChrome(inside);
    },
    [holdChrome]
  );

  // ── Layout measurement ────────────────────────────────────────────────────
  const [layout, setLayout] = useState<Layout>('regular');
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const compactAt = readRemToken(stage, '--fp-bp-compact', 640);
    const wideAt = readRemToken(stage, '--fp-bp-wide', 1024);
    const measure = (width: number) => {
      setLayout(width < compactAt ? 'compact' : width < wideAt ? 'regular' : 'wide');
    };
    measure(stage.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) measure(width);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stageRef]);

  const compact = layout === 'compact';
  const wide = layout === 'wide';

  // ── HUD (brightness / volume / zoom flash) ────────────────────────────────
  const [hud, setHud] = useState<{ kind: 'brightness' | 'volume' | 'zoom'; value: number } | null>(
    null
  );
  const hudTimer = useRef<number | undefined>(undefined);
  const flashHud = useCallback((kind: 'brightness' | 'volume' | 'zoom', value: number) => {
    setHud({ kind, value });
    window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(null), 900);
  }, []);
  useEffect(() => () => window.clearTimeout(hudTimer.current), []);

  // ── Gesture zones ─────────────────────────────────────────────────────────
  // Vertical drag: brightness on the left, volume on the right (the phone-player
  // convention). A tap that never moved is treated as a tap, not a nudge.
  const drag = useRef<{
    kind: 'brightness' | 'volume';
    startY: number;
    startValue: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);

  // ── Double-tap / double-click seek (YouTube-style ±10s) ────────────────────
  // One code path for touch and mouse: both raise pointerup, so `resolveTap`
  // sees the same two events either way and desktop needs no separate dblclick
  // handler (the native one is neutralised below so it cannot double-fire).
  const lastTap = useRef<{ time: number; zone: Zone } | null>(null);
  const tapTimer = useRef<number | undefined>(undefined);
  const rippleTimer = useRef<number | undefined>(undefined);
  const rippleSeq = useRef(0);
  const [ripple, setRipple] = useState<{
    id: number;
    side: 'left' | 'right';
    /** Percentages of the rendered stage box, so the burst lands under the
     *  finger at every viewport size. */
    x: number;
    y: number;
  } | null>(null);

  const showRipple = useCallback(
    (side: 'left' | 'right', clientX: number, clientY: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      // Measured against the stage, never against the viewport or a constant:
      // the same code puts the ripple in the right place on a 375px phone, in a
      // page column, and in fullscreen.
      const x = rect && rect.width ? ((clientX - rect.left) / rect.width) * 100 : side === 'left' ? 17 : 83;
      const y = rect && rect.height ? ((clientY - rect.top) / rect.height) * 100 : 50;
      rippleSeq.current += 1;
      setRipple({
        id: rippleSeq.current,
        side,
        x: Math.min(Math.max(x, 8), 92),
        y: Math.min(Math.max(y, 12), 88),
      });
      window.clearTimeout(rippleTimer.current);
      rippleTimer.current = window.setTimeout(() => setRipple(null), RIPPLE_MS);
    },
    [stageRef]
  );

  /**
   * Decide what one tap on a zone means.
   *
   * DEBOUNCE: the single-tap action is not run immediately — it is scheduled one
   * double-tap window out and cancelled if a second tap lands on the same zone.
   * That is what stops a rapid double-tap from both toggling playback and
   * seeking. The delay only applies to the side zones (where a double-tap has a
   * meaning); the centre zone acts at once, so play/pause stays instant.
   */
  const resolveTap = useCallback(
    (zone: Zone, event: React.PointerEvent<HTMLDivElement>) => {
      const now = Date.now();
      const previous = lastTap.current;
      const canDouble = zone !== 'centre' && caps.seek;

      if (canDouble && previous && previous.zone === zone && now - previous.time < DOUBLE_TAP_MS) {
        lastTap.current = null;
        window.clearTimeout(tapTimer.current);
        seekBy(zone === 'left' ? -SKIP_SECONDS : SKIP_SECONDS, 'none');
        showRipple(zone, event.clientX, event.clientY);
        return;
      }

      if (!canDouble) {
        // Nothing to wait for: act now.
        if (zone === 'centre' && caps.playback) togglePlay();
        else wake();
        return;
      }

      lastTap.current = { time: now, zone };
      const withMouse = event.pointerType === 'mouse';
      window.clearTimeout(tapTimer.current);
      tapTimer.current = window.setTimeout(() => {
        lastTap.current = null;
        // Mouse: a plain click on the picture is play/pause, as on every desktop
        // player. Touch: a plain tap reveals the controls, because a finger on a
        // phone is how you look at the seek bar, not how you pause.
        if (withMouse && caps.playback) togglePlay();
        else wake();
      }, DOUBLE_TAP_MS);
    },
    [caps.seek, caps.playback, seekBy, showRipple, togglePlay, wake]
  );

  useEffect(
    () => () => {
      window.clearTimeout(tapTimer.current);
      window.clearTimeout(rippleTimer.current);
    },
    []
  );

  const onZoneDown = useCallback(
    (kind: 'brightness' | 'volume') => (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = {
        kind,
        startY: event.clientY,
        startValue: kind === 'brightness' ? prefs.brightness : prefs.volume,
        moved: false,
        pointerId: event.pointerId,
      };
      wake();
    },
    [prefs.brightness, prefs.volume, wake]
  );

  const onZoneMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const session = drag.current;
      const stage = stageRef.current;
      if (!session || !stage || session.pointerId !== event.pointerId) return;
      const height = stage.clientHeight || 1;
      const delta = session.startY - event.clientY;
      if (Math.abs(delta) > 6) session.moved = true;
      // 65% of the stage height spans the full range — enough travel for fine
      // control without needing to swipe past the edge.
      const ratio = delta / (height * 0.65);
      if (session.kind === 'brightness') {
        const next = session.startValue + ratio * (BRIGHTNESS_MAX - BRIGHTNESS_MIN);
        setBrightness(next);
        flashHud('brightness', Math.round((Math.min(Math.max(next, BRIGHTNESS_MIN), BRIGHTNESS_MAX) / BRIGHTNESS_MAX) * 100));
      } else {
        const next = Math.min(1, Math.max(0, session.startValue + ratio));
        setVolume(next);
        flashHud('volume', Math.round(next * 100));
      }
      event.preventDefault();
    },
    [flashHud, setBrightness, setVolume, stageRef]
  );

  const onZoneUp = useCallback(
    (zone: Zone) => (event: React.PointerEvent<HTMLDivElement>) => {
      const session = drag.current;
      drag.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      // A drag changed brightness/volume; it was never a tap.
      if (session?.moved) return;
      resolveTap(zone, event);
    },
    [resolveTap]
  );

  // ── Derived UI state ──────────────────────────────────────────────────────
  const isPlaying = snapshot.status === 'playing';
  const isBuffering = engine !== 'embed' && (snapshot.status === 'buffering' || (started && snapshot.status === 'loading'));
  const hasError = snapshot.status === 'error' && !!snapshot.error;
  const ended = snapshot.status === 'ended';
  const showSeekBar = caps.time && snapshot.duration > 0;
  const activeTextTrack = snapshot.textTracks.find((s) => s.active) ?? null;

  const errorMessage = useMemo(() => {
    const kind = snapshot.error?.kind;
    // A dropped connection is the real cause; saying "network error" when the
    // device is plainly offline sends the viewer looking for the wrong fix.
    if (offline && (kind === 'network' || kind === 'unknown' || !kind)) return t('offline');
    switch (kind) {
      case 'network':
        return t('errNetwork');
      case 'unsupported':
        return t('errUnsupported');
      case 'decode':
        return t('errDecode');
      case 'drm':
        return t('errDrm');
      case 'geo':
        return t('errGeo');
      case 'notfound':
        return t('errNotFound');
      default:
        return t('errUnknown');
    }
  }, [snapshot.error?.kind, offline, t]);

  const surfaceStyle = useMemo(() => {
    const base = { filter: `brightness(${prefs.brightness})` };
    // Native <video> (html5): a GPU-accelerated transform crop-zooms cleanly.
    //
    // Every other engine renders a cross-origin <iframe> — the YouTube player
    // (reachable via the settings menu, e.g. on trailers) and the third-party
    // embed providers. WebKit/iOS (and some Chromium builds) frequently fail to
    // repaint or scale a *transformed* cross-origin frame, so `transform:
    // scale()` on the surface left the picture unchanged and the zoom buttons
    // "did nothing" — most visibly on mobile. For those engines we crop-zoom
    // instead by enlarging the frame past the stage and re-centring it; the
    // stage's `overflow: hidden` does the actual cropping. (left/top override
    // the CSS `inset:0`; with width/height also set, the now-redundant
    // right/bottom from that inset are ignored per the box model.)
    if (engine !== 'html5') {
      const overflowPct = (prefs.zoom - 1) * 50; // half the overflow, per side
      return {
        ...base,
        width: `${prefs.zoom * 100}%`,
        height: `${prefs.zoom * 100}%`,
        left: `-${overflowPct}%`,
        top: `-${overflowPct}%`,
      };
    }
    return { ...base, transform: `scale(${prefs.zoom})` };
  }, [prefs.brightness, prefs.zoom, engine]);

  const stageClass = [
    'fp-stage',
    isFullscreen ? 'is-fullscreen' : '',
    // The CSS fallback needs its own class: `is-fullscreen` only resizes, while
    // this one has to position the stage fixed over the whole page (iOS Safari,
    // which refuses to fullscreen anything but a <video>).
    pseudoFullscreen ? 'is-pseudo-fullscreen' : '',
    controlsVisible ? 'is-controls-visible' : 'is-controls-hidden',
    started ? 'is-started' : 'is-idle',
    compact ? 'is-compact' : '',
    wide ? 'is-wide' : '',
    engine ? `is-engine-${engine}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // The primary transport button reflects the real state, including "replay"
  // once the video has ended — a play icon there would be a lie.
  const primaryLabel = ended ? t('replay') : isPlaying ? t('pause') : t('play');

  /**
   * ISOLATION BOUNDARY (both directions).
   *
   * Outward: pointer and click events raised inside the stage stop here instead
   * of continuing to page-level delegates — the poster-card `document` click
   * handler, rail drag handlers, modal backdrops, anything a future page adds. A
   * volume drag or a double-tap seek must never also trigger a navbar item or a
   * related-title card that happens to sit near the player.
   *
   * Inward: nothing outside can reach the player's state either. Keyboard
   * shortcuts are bound to the stage element, not the window (see usePlayer), the
   * embed adapter filters postMessage by frame identity, and fullscreen changes
   * are matched against this stage specifically.
   *
   * The one deliberate exception is `data-fp-passthrough`: the end card's
   * related-title links have to reach Astro's ClientRouter on `document` for a
   * view transition, so their clicks bubble normally.
   */
  const containPointer = useCallback((event: React.SyntheticEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('[data-fp-passthrough]')) return;
    event.stopPropagation();
  }, []);

  /**
   * THE EMBED FULLSCREEN/MINIMIZE BUTTON'S OWN 1-SECOND LIFE.
   *
   * It cannot ride on `controlsVisible` like the rest of the chrome, because the
   * signals that keep that alive do not survive a cross-origin iframe:
   *
   *   • `mousemove` raised inside the provider's frame never reaches this
   *     document, so `wake()` stops being called the moment the cursor is over
   *     the video — yet CSS `:hover` DOES cross the boundary (the parent sees the
   *     <iframe> element as hovered). Keying the button off `:hover` therefore
   *     pinned it on screen for as long as the cursor sat anywhere on the stage.
   *   • On a touch screen there is no hover at all, so the old rule just forced
   *     it permanently visible at `opacity: .72`.
   *
   * So visibility is owned here: any reveal starts a 1s countdown and the button
   * goes away when it expires, whatever the pointer is doing. A cursor resting on
   * the button itself (or keyboard focus) holds it open — a control that vanishes
   * from under the hand reaching for it is the bug, not the feature.
   */
  const [screenCtlVisible, setScreenCtlVisible] = useState(false);
  const screenCtlTimer = useRef<number | undefined>(undefined);
  const screenCtlHeld = useRef(false);

  const revealScreenCtl = useCallback(() => {
    setScreenCtlVisible(true);
    window.clearTimeout(screenCtlTimer.current);
    if (screenCtlHeld.current) return;
    screenCtlTimer.current = window.setTimeout(
      () => setScreenCtlVisible(false),
      SCREEN_CTL_MS
    );
  }, []);

  /** Pointer resting on / focus inside the button: suspend the countdown. */
  const holdScreenCtl = useCallback(
    (held: boolean) => {
      screenCtlHeld.current = held;
      if (held) {
        window.clearTimeout(screenCtlTimer.current);
        setScreenCtlVisible(true);
      } else {
        revealScreenCtl();
      }
    },
    [revealScreenCtl]
  );

  return (
    <div className="fp-root">
      <div
        ref={stageRef}
        className={stageClass}
        tabIndex={0}
        role="group"
        aria-label={`${title} — ${t('play')}`}
        onMouseMove={(event) => {
          trackPointerHold(event);
          wake();
          revealScreenCtl();
        }}
        // `mousemove` dies at the provider frame's edge, but crossing INTO the
        // stage is still reported here (the parent owns the <iframe> element even
        // though it cannot see inside it) — so this is the mouse's wake signal.
        onMouseEnter={revealScreenCtl}
        // A cursor that leaves the stage (to another window, to the page below)
        // must release the hold even though no further move arrives inside it.
        onMouseLeave={() => {
          holdChrome(false);
          wake();
        }}
        onPointerDown={(event) => {
          wake();
          containPointer(event);
        }}
        onPointerUp={containPointer}
        onClick={containPointer}
        onDoubleClick={containPointer}
      >
        {/* Engine surface. The adapter appends <video> / <iframe> here. */}
        <div ref={hostRef} className="fp-surface" style={surfaceStyle} />

        {/* Pre-play splash. The play control is a real button, so Enter/Space
            start playback; the icon carries the whole meaning, so there is no
            label text next to it (the accessible name lives on aria-label). */}
        {!started && !hasError && (
          <div
            className="fp-splash"
            style={splashImage ? { backgroundImage: `url(${splashImage})` } : undefined}
          >
            <span className="fp-splash-scrim" aria-hidden="true" />
            <button
              type="button"
              className="fp-splash-play"
              onClick={onStart}
              aria-label={`${t('play')} ${title}`}
            >
              <PlayIcon size={30} />
            </button>
          </div>
        )}

        {/* Automatic server selection in progress. Deliberately a quiet status
            line and a ring — not the error card, not a modal — because nothing
            has gone wrong: the player is choosing between working servers and
            has under a second to do it. `aria-live="polite"` so a screen reader
            hears it without being interrupted mid-sentence. */}
        {started && optimizing && !hasError && (
          <div className="fp-optimizing" role="status" aria-live="polite">
            <span className="fp-optimizing-ring" aria-hidden="true" />
            <span className="fp-optimizing-text">{t('findingServer')}</span>
          </div>
        )}

        {/* Gesture / tap zones, only where WE own playback (html5 / youtube). On
            the third-party embed engine we cannot drive the video anyway, so any
            overlay would just sit on top of the provider's OWN controls and
            block them — the exact "cannot control the server" problem. Render
            nothing there, so every provider control (play/pause, seek, quality,
            audio track, fullscreen) inside the frame is fully reachable.

            The three zones are equal thirds of the stage width (CSS
            percentages), so the double-tap targets stay proportional from a
            375px phone to a 1920px desktop. `onDoubleClick` is neutralised
            because the pointerup path already handles the second click — without
            this the browser's own dblclick would fire a duplicate action and
            select the page text behind the video. */}
        {started && prefs.gestures && !hasError && !ended && engine !== 'embed' && (
          <>
            <div
              className="fp-zone fp-zone-left"
              onPointerDown={onZoneDown('brightness')}
              onPointerMove={onZoneMove}
              onPointerUp={onZoneUp('left')}
              onPointerCancel={onZoneUp('left')}
              onDoubleClick={(event) => event.preventDefault()}
              aria-hidden="true"
            />
            {/* Centre tap: only where we can actually toggle playback. */}
            <div
              className="fp-zone fp-zone-centre"
              onPointerUp={onZoneUp('centre')}
              onDoubleClick={(event) => event.preventDefault()}
              aria-hidden="true"
            />
            <div
              className="fp-zone fp-zone-right"
              onPointerDown={onZoneDown('volume')}
              onPointerMove={onZoneMove}
              onPointerUp={onZoneUp('right')}
              onPointerCancel={onZoneUp('right')}
              onDoubleClick={(event) => event.preventDefault()}
              aria-hidden="true"
            />
          </>
        )}

        {/* Double-tap seek ripple, drawn at the point that was tapped. Separate
            from `fp-skip-pulse` (which confirms the ±10s BUTTONS and the arrow
            keys, and stays centred on its side) so neither ever doubles up. */}
        {ripple && (
          <span
            key={ripple.id}
            className={`fp-tap-ripple is-${ripple.side}`}
            style={{ left: `${ripple.x}%`, top: `${ripple.y}%` }}
            aria-hidden="true"
          >
            <span className="fp-tap-ripple-burst" />
            <span className="fp-tap-ripple-label">
              <SkipIcon size={22} direction={ripple.side === 'left' ? 'back' : 'forward'} />
              <span>{ripple.side === 'left' ? '−' : '+'}{SKIP_SECONDS}s</span>
            </span>
          </span>
        )}

        {/* Skip feedback pulse (double-tap / ± keys). */}
        {skipPulse && (
          <div className={`fp-skip-pulse is-${skipPulse}`} aria-hidden="true">
            <SkipIcon size={30} direction={skipPulse} />
            <span>{SKIP_SECONDS}s</span>
          </div>
        )}

        {/* Buffering. A quiet ring, not a jarring spinner, and only after the
            engine has been stalled long enough to be worth mentioning. */}
        {isBuffering && !hasError && (
          <div className="fp-spinner" role="status" aria-label={t('buffering')}>
            <span className="fp-spinner-ring" aria-hidden="true" />
          </div>
        )}

        {/* Adaptive-bitrate degradation notice. */}
        {slowNetwork && isPlaying && !offline && (
          <p className="fp-slow" role="status">
            {t('slowNetwork')}
          </p>
        )}

        {/* Offline banner. Shown whenever the connection is down and the error
            card is not already saying it — playback can survive on the buffer
            for a while, so this is a warning, not a failure. */}
        {offline && !hasError && (
          <p className="fp-slow is-offline" role="status">
            {t('offline')}
          </p>
        )}

        {/* Autoplay policy: the browser refused sound, so the engine started
            muted and said so. Netflix/JioHotstar answer to this is one tap that
            restores audio — never an error card, never silent playback with no
            explanation. The button is a real button (Enter/Space work) and is
            sized ≥44px for a thumb. */}
        {started && snapshot.autoplayBlocked && !hasError && (
          <button
            type="button"
            className="fp-unmute"
            onClick={(event) => {
              event.stopPropagation();
              unmuteFromAutoplay();
            }}
          >
            <span className="fp-unmute-icon" aria-hidden="true">
              <VolumeIcon size={18} level={0} />
            </span>
            <span className="fp-unmute-text">{t('tapToUnmute')}</span>
          </button>
        )}

        {/* Transient status (server fallback, etc.). Polite, self-dismissing,
            and never on top of the control bar — see .fp-toast in player.css. */}
        {toast && (
          <p className="fp-toast" role="status" aria-live="polite">
            {toast}
          </p>
        )}

        {/* Error card with the recovery that fits the failure. */}
        {hasError && (
          <div className="fp-error" role="alert">
            <span className="fp-error-icon" aria-hidden="true">
              <WarningIcon size={26} />
            </span>
            <p className="fp-error-text">{errorMessage}</p>
            <div className="fp-error-actions">
              {snapshot.error?.retryable !== false && (
                <button type="button" className="fp-pill fp-pill-primary" onClick={onReload}>
                  {t('retry')}
                </button>
              )}
              {onBack && (
                <button type="button" className="fp-pill" onClick={onBack}>
                  {t('back')}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Subtitles we render ourselves (html5 only). */}
        <SubtitleLayer
          cues={snapshot.cues}
          size={prefs.subtitleSize}
          backdrop={prefs.subtitleBackdrop}
          lifted={controlsVisible}
        />

        {/* Gesture HUD. */}
        {hud && (
          <div className="fp-hud" aria-hidden="true">
            <span className="fp-hud-icon">
              {hud.kind === 'brightness' ? (
                <BrightnessIcon size={18} />
              ) : hud.kind === 'volume' ? (
                <VolumeIcon size={18} level={hud.value / 100} />
              ) : (
                <ZoomInIcon size={18} />
              )}
            </span>
            <span className="fp-hud-bar">
              <span className="fp-hud-fill" style={{ width: `${hud.value}%` }} />
            </span>
            <span className="fp-hud-value">{hud.value}%</span>
          </div>
        )}

        {/* Embed providers keep their own playback chrome fully interactive.
            This pointer-transparent wrapper contributes only one centered
            fullscreen/minimize button; server selection remains below stage. */}
        {/* Top bar: Back/Close + Rating Badge + Advisory on Left; Subtitles/Audio + Volume + Fullscreen + Settings on Right */}
        {started && (
          <div
            className="fp-topbar"
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') holdChrome(true);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== 'touch') holdChrome(false);
              wake();
            }}
          >
            <div className="fp-topbar-left">
              {onBack && (
                <button
                  type="button"
                  className="fp-btn fp-btn-ghost fp-top-close"
                  onClick={onBack}
                  aria-label={t('back')}
                  title={t('back')}
                >
                  <CloseIcon size={24} />
                </button>
              )}
              <div className="fp-rating-wrap">
                <span className="fp-rating-pill">
                  {ratingBadge || 'Rated U/A 13+'}
                </span>
                <span className="fp-rating-advisory">
                  {contentAdvisory || 'frightening scenes, sexual content, violence, tobacco depictions, alcohol use'}
                </span>
              </div>
            </div>

            <div className="fp-topbar-right">
              {/* Dialogue / Subtitles / Audio */}
              <button
                ref={tracksBtn}
                type="button"
                className={`fp-btn fp-top-btn${menu === 'tracks' ? ' is-open' : ''}`}
                onClick={() => setMenu(menu === 'tracks' ? null : 'tracks')}
                aria-label={t('audioAndSubtitles')}
                title={t('audioAndSubtitles')}
              >
                <DialogueIcon size={22} />
              </button>

              {/* Volume */}
              {caps.volume !== 'none' && (
                <VolumeControl
                  volume={prefs.volume}
                  muted={prefs.muted}
                  mode={caps.volume}
                  onVolume={(value) => {
                    setVolume(value);
                    flashHud('volume', Math.round(value * 100));
                  }}
                  onToggleMute={toggleMute}
                  t={t}
                />
              )}

              {/* Fullscreen */}
              <button
                type="button"
                className="fp-btn fp-top-btn"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
                title={`${isFullscreen ? t('exitFullscreen') : t('fullscreen')} (F)`}
              >
                {isFullscreen || pseudoFullscreen ? (
                  <ExitFullscreenIcon size={22} />
                ) : (
                  <FullscreenIcon size={22} />
                )}
              </button>

              {/* Settings with text label below */}
              <button
                ref={overflowBtn}
                type="button"
                className={`fp-settings-btn${menu === 'overflow' ? ' is-open' : ''}`}
                onClick={() => setMenu(menu === 'overflow' ? null : 'overflow')}
                aria-label="Settings"
                title="Settings"
              >
                <VerticalDotsIcon size={20} />
                <span className="fp-settings-label">Settings</span>
              </button>
            </div>
          </div>
        )}

        {/* Skip Intro / Recap / Credits — appears only while the playhead is
            inside a marker, and disappears on its own. */}
        {activeMarker && started && !ended && (
          <button
            type="button"
            className="fp-skip-marker"
            onClick={() => seekTo(activeMarker.end)}
          >
            {activeMarker.kind === 'intro'
              ? t('skipIntro')
              : activeMarker.kind === 'recap'
                ? t('skipRecap')
                : t('skipCredits')}
          </button>
        )}

        {upNext}
        {ended && endCard}

        {/* ── Control bar ── */}
        {started && !hasError && (
          <div
            ref={controlsRef}
            className="fp-controls"
            // Pointer events here must not reach the tap-to-toggle zones.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={wake}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') holdChrome(true);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== 'touch') holdChrome(false);
              wake();
            }}
          >
            {/* Full-width seek bar with left timestamp, chapter dots, right timestamp */}
            {showSeekBar && (
              <SeekBar
                currentTime={snapshot.currentTime}
                duration={snapshot.duration}
                buffered={snapshot.buffered}
                seekable={caps.seek}
                markers={markers}
                scrubTime={scrubTime}
                onScrub={setScrubTime}
                onCommit={seekTo}
                onNudge={seekBy}
                thumbnailAt={thumbnailAt}
                t={t}
              />
            )}

            {/* Bottom-Center Transport Controls: [ ↺ 10 ] [ ▶ / || ] [ ↻ 10 ] */}
            <div className="fp-center-transport">
              {/* Rewind 10s */}
              <button
                type="button"
                className="fp-transport-skip"
                onClick={() => seekBy(-SKIP_SECONDS)}
                aria-label={t('back10')}
                title={`${t('back10')} (←)`}
              >
                <SkipIcon direction="back" size={26} />
              </button>

              {/* Main Play / Pause */}
              {caps.playback && (
                <button
                  type="button"
                  className="fp-transport-main"
                  onClick={togglePlay}
                  aria-label={primaryLabel}
                  title={`${primaryLabel} (Space)`}
                >
                  {ended ? <ReplayIcon size={30} /> : isPlaying ? <PauseIcon size={30} /> : <PlayIcon size={30} />}
                </button>
              )}

              {/* Forward 10s */}
              <button
                type="button"
                className="fp-transport-skip"
                onClick={() => seekBy(SKIP_SECONDS)}
                aria-label={t('forward10')}
                title={`${t('forward10')} (→)`}
              >
                <SkipIcon direction="forward" size={26} />
              </button>
            </div>

            {/* Menus popovers */}
            <Popover
              open={menu === 'tracks'}
              onClose={() => setMenu(null)}
              label={t('audioAndSubtitles')}
              triggerRef={tracksBtn}
              className="fp-menu-top"
            >
              <TracksMenu
                audioTracks={snapshot.audioTracks}
                textTracks={snapshot.textTracks}
                canSelectAudio={caps.audioTracks}
                canSelectText={caps.textTracks}
                canStyleSubtitles={caps.subtitleStyling}
                managedExternally={false}
                subtitleSize={prefs.subtitleSize}
                subtitleBackdrop={prefs.subtitleBackdrop}
                onSelectAudio={selectAudio}
                onSelectText={selectText}
                onSubtitleSize={(size) => updatePrefs({ subtitleSize: size })}
                onSubtitleBackdrop={(backdrop) => updatePrefs({ subtitleBackdrop: backdrop })}
                t={t}
              />
            </Popover>

            <Popover
              open={menu === 'speed'}
              onClose={() => setMenu(null)}
              label={t('speed')}
              triggerRef={speedBtn}
              className="fp-menu-top"
            >
              <SpeedMenu rate={prefs.rate} onSelect={setRate} t={t} />
            </Popover>

            <Popover
              open={menu === 'overflow'}
              onClose={() => setMenu(null)}
              label="Settings"
              triggerRef={overflowBtn}
              className="fp-menu-top"
            >
              <OverflowMenu
                brightness={prefs.brightness}
                zoom={prefs.zoom}
                gestures={prefs.gestures}
                autoplayNext={prefs.autoplayNext}
                showAutoplayNext={showAutoplayNext}
                canPip={caps.pip}
                speed={caps.rate ? { rate: prefs.rate, onRate: setRate } : null}
                episodeNav={
                  episodeNav
                    ? {
                        hasPrev: episodeNav.hasPrev,
                        hasNext: episodeNav.hasNext,
                        onPrev: episodeNav.onPrev,
                        onNext: episodeNav.onNext,
                      }
                    : null
                }
                onOpenEpisodes={() => {
                  setMenu(null);
                  episodeNav?.onOpenEpisodes();
                }}
                onBrightness={(b) => {
                  setBrightness(b);
                  flashHud('brightness', Math.round(b * 100));
                }}
                onZoom={(z) => {
                  setZoom(z);
                  flashHud('zoom', Math.round(z * 100));
                }}
                onToggleGestures={toggleGestures}
                onToggleAutoplayNext={() =>
                  updatePrefs({ autoplayNext: !prefs.autoplayNext })
                }
                onRequestPip={requestPip}
                t={t}
              />
            </Popover>

            {episodesPanel && (
              <Popover
                open={menu === 'episodes'}
                onClose={() => setMenu(null)}
                label={t('episodes')}
                triggerRef={episodesBtn}
                className="fp-menu-wide"
              >
                {episodesPanel}
              </Popover>
            )}
          </div>
        )}

        {/* Single live region for state changes: "Paused", "Muted", "10 seconds
            forward". One region, so announcements never overlap. */}
        <p className="fp-sr-live" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>

      {belowStage}
      {notice}
    </div>
  );
}
