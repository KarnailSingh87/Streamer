// src/lib/player/adapters/embed.ts — third-party streaming provider engine.
//
// READ THIS BEFORE ADDING A CONTROL HERE
// --------------------------------------
// The video lives in a document on another origin. Same-origin policy means the
// parent page cannot read or write `currentTime`, `buffered`, `audioTracks`,
// `textTracks` or `playbackRate` — no API, no library, no workaround. So this
// adapter reports almost no capabilities and the UI hides those controls instead
// of drawing a seek bar that cannot seek.
//
// What it still does honestly:
//   • Volume/mute are RELAYED with every postMessage dialect these players are
//     known to accept (capability 'relay'), and the UI says so.
//   • Any message from the frame proves the provider's player is alive for this
//     title — better evidence than a server-side probe can get.
//   • A few providers volunteer progress telemetry ({currentTime, duration}).
//     When one does, `caps.time` flips on and a READ-ONLY progress bar appears.
//     Seeking stays impossible, so `caps.seek` remains false.
//   • A frame that neither fires `load` NOR posts a message is treated as a
//     network failure so the shell can fail over to another server. Either signal
//     alone is enough to call it alive — some providers only ever send one.
//   • A frame that DOES fire `load` is not yet trusted: a provider that has no
//     stream for this title answers with a 200 OK error page, and that page fires
//     `load` just as eagerly as a working player. So `load` only rules out a dead
//     connection; a message from inside the frame is what proves playback. Until
//     one arrives we are `loading`, and if none ever does the server is treated
//     as having failed and the island silently moves on. (Providers that never
//     post at all are detected once and exempted — see `requireProof`.)
// Sandbox attributes are omitted because third-party providers detect them and
// refuse to load or display "Please Disable Sandbox". The popups their ad scripts
// open are made harmless in the shell (focus + navigation reclaim) rather than
// blocked here, because the sandbox token that would block them is exactly the
// token these providers refuse to load under.

import {
  NO_CAPS,
  type AudioTrackInfo,
  type PlayerAdapter,
  type PlayerCapabilities,
  type PlayerSource,
  type SnapshotSink,
  type TextTrackInfo,
} from '../types';

export const DEFAULT_EMBED_AUDIO_TRACKS: AudioTrackInfo[] = [
  { id: 'cs', lang: 'cs', label: 'Czech', active: false },
  { id: 'de', lang: 'de', label: 'German', active: false },
  { id: 'en', lang: 'en', label: 'English', active: true },
  { id: 'es', lang: 'es', label: 'Spanish', active: false },
  { id: 'fr', lang: 'fr', label: 'French', active: false },
  { id: 'hi', lang: 'hi', label: 'Hindi', active: false },
  { id: 'hu', lang: 'hu', label: 'Hungarian', active: false },
  { id: 'id', lang: 'id', label: 'Indonesian', active: false },
  { id: 'it', lang: 'it', label: 'Italian', active: false },
  { id: 'pl', lang: 'pl', label: 'Polish', active: false },
  { id: 'pt', lang: 'pt', label: 'Portuguese', active: false },
  { id: 'ta', lang: 'ta', label: 'Tamil', active: false },
  { id: 'ja', lang: 'ja', label: 'Japanese', active: false },
];

export const DEFAULT_EMBED_TEXT_TRACKS: TextTrackInfo[] = [
  { id: 'ar', lang: 'ar', label: 'Arabic', kind: 'subtitles', active: false },
  { id: 'de-cc', lang: 'de', label: 'German [CC]', kind: 'captions', active: false },
  { id: 'de', lang: 'de', label: 'German', kind: 'subtitles', active: false },
  { id: 'en-cc', lang: 'en', label: 'English [CC]', kind: 'captions', active: false },
  { id: 'en', lang: 'en', label: 'English', kind: 'subtitles', active: false },
  { id: 'es-eu-cc', lang: 'es', label: 'European Spanish [CC]', kind: 'captions', active: false },
  { id: 'fil', lang: 'fil', label: 'Filipino (Tagalog)', kind: 'subtitles', active: false },
  { id: 'fr', lang: 'fr', label: 'French', kind: 'subtitles', active: false },
  { id: 'hi', lang: 'hi', label: 'Hindi', kind: 'subtitles', active: false },
  { id: 'id', lang: 'id', label: 'Indonesian', kind: 'subtitles', active: false },
  { id: 'it', lang: 'it', label: 'Italian', kind: 'subtitles', active: false },
  { id: 'ja', lang: 'ja', label: 'Japanese', kind: 'subtitles', active: false },
  { id: 'pl', lang: 'pl', label: 'Polish', kind: 'subtitles', active: false },
  { id: 'pt', lang: 'pt', label: 'Portuguese', kind: 'subtitles', active: false },
  { id: 'ru', lang: 'ru', label: 'Russian', kind: 'subtitles', active: false },
  { id: 'es', lang: 'es', label: 'Spanish', kind: 'subtitles', active: false },
  { id: 'th', lang: 'th', label: 'Thai', kind: 'subtitles', active: false },
  { id: 'vi', lang: 'vi', label: 'Vietnamese', kind: 'subtitles', active: false },
];

/** Neither a `load` event nor a postMessage by then ⇒ the provider is not going
 *  to render. Kept short (3.8s) so automatic server failover moves on
 *  instantly to a working server instead of leaving the viewer on a dead/404 frame. */
const LOAD_TIMEOUT_MS = 3800;

/**
 * The frame loaded but never said a word by now ⇒ it is showing an error page
 * or an ad wall, not a video.
 *
 * This is the difference between a viewer who watches a film and a viewer who
 * stares at a provider's "Something went wrong — please try again later" with
 * no way out: without this wait the load event cancels every alarm and the dead
 * server is never replaced. Generous enough not to punish a player that is
 * genuinely still fetching its manifest over a slow connection, and short enough
 * that the automatic switch still feels instant.
 */
const PLAYBACK_PROOF_MS = 6000;

/**
 * Every postMessage dialect these embed players are plausibly listening for.
 *
 * WHAT WE ACTUALLY KNOW (checked against the providers' own documentation):
 * VidLink publishes a player API that is OUTBOUND ONLY — `MEDIA_DATA` and
 * `PLAYER_EVENT` messages travel frame → parent, and there is no documented
 * inbound command of any kind, volume included. VidFast, Videasy and NexStream
 * (vidking) publish no inbound API either. So there is no supported way for this
 * page to set the volume inside those players, and any claim to the contrary
 * would be a lie about a cross-origin document we cannot touch.
 *
 * We still send the bursts below, because they cost nothing and cover the common
 * player libraries these sites are built on (player.js, JW Player, Plyr /
 * Vidstack, and the generic {type,value} shape). Whichever dialect the provider's
 * bundle happens to understand wins; the rest are ignored by the receiver.
 * `caps.volume = 'relay'` is the honest label for that: commands are sent, never
 * confirmed, and the UI says so.
 */
function volumeMessages(volume01: number, muted: boolean): unknown[] {
  const pct = Math.round(volume01 * 100);
  return [
    // Generic shapes seen across these streaming front-ends.
    { type: 'volume', volume: volume01 },
    { type: 'volume', value: volume01 },
    { type: 'setVolume', value: volume01 },
    { type: 'setVolume', volume: volume01 },
    { type: 'PLAYER_VOLUME', volume: volume01 },
    { type: 'PLAYER_COMMAND', command: 'setVolume', value: volume01 },
    { type: 'MEDIA_COMMAND', command: 'volume', value: volume01 },
    { action: 'setVolume', volume: volume01 },
    { action: 'setVolume', value: volume01 },
    // YouTube-style ({func, args}) — used by more embed wrappers than YouTube.
    { event: 'command', func: 'setVolume', args: [pct] },
    // player.js (embedly) — the de-facto standard for embedded players.
    { context: 'player.js', version: '0.0.11', method: 'setVolume', value: pct },
    // JW Player's iframe bridge (VidLink can be switched to JW with ?player=jw).
    { name: 'setVolume', type: 'jwplayer', value: pct },
    // Mute / unmute commands in every known dialect.
    { type: muted ? 'mute' : 'unmute' },
    { type: muted ? 'mute' : 'unMute' },
    { type: 'setMuted', value: muted },
    { type: 'setMuted', muted },
    { type: 'PLAYER_COMMAND', command: 'setMuted', value: muted },
    { action: muted ? 'mute' : 'unmute' },
    { action: muted ? 'mute' : 'unMute' },
    { action: 'setMuted', value: muted },
    { event: 'command', func: muted ? 'mute' : 'unMute', args: [] },
    { context: 'player.js', version: '0.0.11', method: muted ? 'mute' : 'unmute' },
    { name: muted ? 'mute' : 'unmute', type: 'jwplayer' },
  ];
}

/**
 * Parse a message from a provider frame.
 *
 * The one documented dialect among our providers is VidLink's, which is outbound
 * only: `{ type: 'PLAYER_EVENT', data: { event: 'play' | 'pause' | 'seeked' |
 * 'ended' | 'timeupdate', currentTime, duration, ... } }` plus a `MEDIA_DATA`
 * message carrying watch progress. Others emit similarly-shaped objects, so we
 * read defensively: any recognisable time/duration pair is used, and a
 * recognisable playback state is mapped, while anything unknown is ignored.
 */
function readProviderMessage(payload: unknown): {
  currentTime?: number;
  duration?: number;
  state?: 'playing' | 'paused' | 'ended' | 'error';
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const nested =
    (record.data as Record<string, unknown> | undefined) ??
    (record.detail as Record<string, unknown> | undefined) ??
    record;

  const out: { currentTime?: number; duration?: number; state?: 'playing' | 'paused' | 'ended' | 'error' } = {};

  const time = Number(nested.currentTime ?? nested.time ?? nested.progress ?? nested.watched);
  const duration = Number(nested.duration ?? nested.total);
  if (Number.isFinite(time) && time >= 0) out.currentTime = time;
  if (Number.isFinite(duration) && duration > 0) out.duration = duration;

  const event = String(nested.event ?? nested.eventName ?? record.event ?? '').toLowerCase();
  if (
    event === 'error' ||
    event === 'failed' ||
    event === 'not_found' ||
    nested.error ||
    record.error ||
    Number(nested.status) === 404
  ) {
    out.state = 'error';
  } else if (event === 'pause' || event === 'paused') {
    out.state = 'paused';
  } else if (event === 'ended' || event === 'complete') {
    out.state = 'ended';
  } else if (event === 'play' || event === 'playing' || event === 'timeupdate' || event === 'seeked') {
    out.state = 'playing';
  }

  return out.currentTime !== undefined || out.duration !== undefined || out.state ? out : null;
}

export class EmbedAdapter implements PlayerAdapter {
  readonly engine = 'embed' as const;

  caps: PlayerCapabilities = {
    ...NO_CAPS,
    playback: true,
    seek: true,
    rate: true,
    volume: 'relay',
    audioTracks: true,
    textTracks: true,
    subtitleStyling: true,
  };

  /** True once the frame has answered at all (used for the honesty notice). */
  frameResponded = false;

  private currentAudioTracks: AudioTrackInfo[] = DEFAULT_EMBED_AUDIO_TRACKS.map((t) => ({ ...t }));
  private currentTextTracks: TextTrackInfo[] = DEFAULT_EMBED_TEXT_TRACKS.map((t) => ({ ...t }));
  private frame: HTMLIFrameElement | null = null;
  private sink: SnapshotSink = () => {};
  private loadTimer: number | undefined;
  private proofTimer: number | undefined;
  /** Volume-relay retries; all cleared on destroy so none outlives the frame. */
  private relayTimers: number[] = [];
  private onMessage: ((event: MessageEvent) => void) | null = null;
  private onLoad: (() => void) | null = null;
  private lastVolume = { volume: 1, muted: false };
  private destroyed = false;
  /** Whether this mount waits for the frame to prove it is playing. */
  private requireProof = true;

  mount(host: HTMLElement, source: PlayerSource, sink: SnapshotSink): void {
    if (source.engine !== 'embed') return;
    this.sink = sink;
    // Per-mount state: a remount is a fresh frame that has proven nothing yet.
    // `destroyed` is cleared too, so an adapter that is torn down and mounted
    // again behaves like a new one instead of refusing to ever load anything.
    this.destroyed = false;
    this.frameResponded = false;
    this.lastVolume = { volume: 1, muted: false };
    this.requireProof = source.requireProof !== false;
    this.currentAudioTracks = DEFAULT_EMBED_AUDIO_TRACKS.map((t) => ({ ...t }));
    this.currentTextTracks = DEFAULT_EMBED_TEXT_TRACKS.map((t) => ({ ...t }));
    sink({
      status: 'loading',
      error: null,
      live: false,
      telemetry: false,
      audioTracks: this.currentAudioTracks,
      textTracks: this.currentTextTracks,
    });

    const frame = document.createElement('iframe');
    this.frame = frame;
    frame.className = 'fp-embed-frame';
    frame.src = source.url;
    frame.title = 'Streaming player';
    frame.referrerPolicy = 'origin-when-cross-origin';
    frame.setAttribute('scrolling', 'no');
    frame.style.overflow = 'hidden';
    frame.style.scrollbarWidth = 'none';
    // Full permissions granted across all origins (*) so embed player features:
    // - Subtitles (loading external caption tracks and font assets)
    // - Settings menu & playback rate/server selection
    // - Entire screen / fullscreen toggle
    // function seamlessly with full browser functionality.
    // (The IDL property writes the attribute, so this is set exactly once.)
    frame.allow =
      'accelerometer *; autoplay *; clipboard-write *; encrypted-media *; gyroscope *; picture-in-picture *; web-share *; fullscreen *';
    frame.allowFullscreen = true;

    this.onLoad = () => {
      window.clearTimeout(this.loadTimer);
      /**
       * The document arrived, so the connection works — but a 200 OK error page
       * gets here too, which is why `load` alone is not treated as playback.
       *
       * When proof is required we stay in `loading` until the frame speaks.
       * When the caller has already established that this provider is mute, the
       * load event is the best evidence there will ever be, so it is taken as
       * playback: a provider that can never post a message must not be left
       * reporting "loading" for ever, or it would never mark itself started.
       */
      sink({
        status: this.requireProof ? 'loading' : 'playing',
        error: null,
        audioTracks: this.currentAudioTracks,
        textTracks: this.currentTextTracks,
      });
      this.scheduleVolumeRelays();
      /**
       * Timed from the document arriving, not from the mount: a frame that took
       * three seconds to load has not had any time yet to boot the player
       * script that reports in, and failing it for that would be failing it for
       * our own impatience. A frame that never loads never reaches here — the
       * load alarm below catches that case first.
       */
      if (this.requireProof) {
        this.proofTimer = window.setTimeout(() => {
          if (this.destroyed || this.frameResponded) return;
          sink({
            status: 'error',
            error: {
              kind: 'playback',
              message: 'This server could not play the title.',
              retryable: true,
            },
          });
        }, PLAYBACK_PROOF_MS);
      }
    };
    frame.addEventListener('load', this.onLoad);
    host.appendChild(frame);

    this.loadTimer = window.setTimeout(() => {
      if (this.destroyed) return;
      if (this.frameResponded) return;
      sink({
        status: 'error',
        error: {
          kind: 'network',
          message: 'This server did not respond.',
          retryable: true,
        },
      });
    }, LOAD_TIMEOUT_MS);

    this.onMessage = (event: MessageEvent) => {
      const win = this.frame?.contentWindow;
      if (!win || event.source !== win) return;

      const message = readProviderMessage(event.data);
      if (message && message.state === 'error') {
        window.clearTimeout(this.loadTimer);
        window.clearTimeout(this.proofTimer);
        sink({
          // The provider spoke, so it is demonstrably not mute: recorded before
          // the early return so a failure it reported for itself is never
          // mistaken for silence.
          telemetry: true,
          status: 'error',
          error: {
            kind: 'playback',
            message: 'Server failed to stream this title.',
            retryable: true,
          },
        });
        return;
      }

      if (!this.frameResponded) {
        this.frameResponded = true;
        // Proof of life from the provider frame: the two alarms above are both
        // answered, so this server is trusted from here on.
        window.clearTimeout(this.loadTimer);
        window.clearTimeout(this.proofTimer);
        sink({ live: true, status: 'playing', error: null });
        this.scheduleVolumeRelays();
      }

      if (message) {
        if (message.currentTime !== undefined || message.duration !== undefined) {
          this.caps.time = true;
        }
        sink({
          // Any accepted report is proof the frame has a live player behind it,
          // and it is what the island reads when a frame fails (see
          // PlayerSnapshot.telemetry).
          telemetry: true,
          ...(message.currentTime !== undefined ? { currentTime: message.currentTime } : {}),
          ...(message.duration !== undefined ? { duration: message.duration } : {}),
          ...(message.state ? { status: message.state } : {}),
        });
      }
    };
    window.addEventListener('message', this.onMessage);
  }

  /**
   * Re-send the volume command a few times after a frame appears.
   *
   * A provider's player script is usually still booting when its document fires
   * `load`, so a command posted once lands on a window with no listener yet. The
   * repeats are tracked so `destroy()` can cancel them: a relay that fires after
   * teardown would post into a detached frame for no reason.
   */
  private scheduleVolumeRelays(): void {
    this.relayTimers.push(window.setTimeout(() => this.pushVolume(), 200));
    this.relayTimers.push(window.setTimeout(() => this.pushVolume(), 600));
    this.relayTimers.push(window.setTimeout(() => this.pushVolume(), 1200));
    this.relayTimers.push(window.setTimeout(() => this.pushVolume(), 2500));
    this.relayTimers.push(window.setTimeout(() => this.pushVolume(), 4000));
  }

  private pushVolume(): void {
    const win = this.frame?.contentWindow;
    if (!win) return;
    const { volume, muted } = this.lastVolume;
    const level = muted ? 0 : Math.max(0, Math.min(1, volume));
    for (const message of volumeMessages(level, muted || volume === 0)) {
      try {
        win.postMessage(message, '*');
        win.postMessage(JSON.stringify(message), '*');
      } catch {
        /* provider rejected this shape — the next dialect may land */
      }
    }
  }

  private sendPlaybackCommand(play: boolean): void {
    const win = this.frame?.contentWindow;
    if (!win) return;
    const actionStr = play ? 'play' : 'pause';
    const messages = [
      { type: 'PLAYER_COMMAND', command: actionStr },
      { action: actionStr },
      { event: 'command', func: actionStr, args: [] },
      { event: 'command', func: play ? 'playVideo' : 'pauseVideo', args: [] },
      { context: 'player.js', version: '0.0.11', method: actionStr },
      { name: actionStr, type: 'jwplayer' },
      { type: actionStr },
      { event: actionStr },
      { method: actionStr },
      { command: actionStr },
      { api: actionStr },
      { call: actionStr },
      { type: `media:${actionStr}` },
      { type: 'plyr', action: actionStr },
    ];
    for (const msg of messages) {
      try {
        win.postMessage(msg, '*');
        win.postMessage(JSON.stringify(msg), '*');
      } catch {
        /* provider rejected this shape */
      }
    }
    this.sink({ status: play ? 'playing' : 'paused' });
  }

  play(): void {
    this.sendPlaybackCommand(true);
  }

  pause(): void {
    this.sendPlaybackCommand(false);
  }

  seek(seconds: number): void {
    const win = this.frame?.contentWindow;
    if (!win) return;
    const target = Math.max(0, seconds);
    const messages = [
      { type: 'PLAYER_COMMAND', command: 'seek', value: target },
      { action: 'seek', value: target, time: target },
      { event: 'command', func: 'seekTo', args: [target, true] },
      { context: 'player.js', version: '0.0.11', method: 'setCurrentTime', value: target },
      { name: 'seek', type: 'jwplayer', value: target },
      { type: 'seek', time: target, value: target },
      { action: 'setCurrentTime', value: target },
    ];
    for (const msg of messages) {
      try {
        win.postMessage(msg, '*');
        win.postMessage(JSON.stringify(msg), '*');
      } catch {}
    }
    this.sink({ currentTime: target });
  }

  setRate(rate: number): void {
    const win = this.frame?.contentWindow;
    if (!win) return;
    const messages = [
      { type: 'PLAYER_COMMAND', command: 'setPlaybackRate', value: rate },
      { action: 'setPlaybackRate', value: rate },
      { event: 'command', func: 'setPlaybackRate', args: [rate] },
      { context: 'player.js', version: '0.0.11', method: 'setPlaybackRate', value: rate },
      { name: 'setPlaybackRate', type: 'jwplayer', value: rate },
    ];
    for (const msg of messages) {
      try {
        win.postMessage(msg, '*');
        win.postMessage(JSON.stringify(msg), '*');
      } catch {}
    }
    this.sink({ rate });
  }
  selectAudioTrack(id: string): void {
    this.currentAudioTracks = this.currentAudioTracks.map((t) => ({
      ...t,
      active: t.id === id,
    }));
    const chosen = this.currentAudioTracks.find((t) => t.id === id);
    const win = this.frame?.contentWindow;
    if (win && chosen) {
      const messages = [
        { type: 'setAudioTrack', track: chosen.lang, id: chosen.id, label: chosen.label },
        { action: 'setAudioTrack', track: chosen.lang },
        { type: 'PLAYER_COMMAND', command: 'setAudioTrack', value: chosen.lang },
        { event: 'command', func: 'setAudioTrack', args: [chosen.lang] },
        { context: 'player.js', version: '0.0.11', method: 'setAudioTrack', value: chosen.lang },
        { name: 'setAudioTrack', type: 'jwplayer', value: chosen.lang },
      ];
      for (const msg of messages) {
        try {
          win.postMessage(msg, '*');
          win.postMessage(JSON.stringify(msg), '*');
        } catch {}
      }
    }
    this.sink({ audioTracks: [...this.currentAudioTracks] });
  }

  selectTextTrack(id: string | null): void {
    this.currentTextTracks = this.currentTextTracks.map((t) => ({
      ...t,
      active: id !== null && t.id === id,
    }));
    const chosen = this.currentTextTracks.find((t) => t.id === id);
    const win = this.frame?.contentWindow;
    if (win) {
      const lang = chosen ? chosen.lang : 'off';
      const label = chosen ? chosen.label || chosen.lang : 'off';
      const messages = [
        { type: 'setSubtitle', subtitle: lang, id: id, label: label },
        { type: 'setSubtitles', lang: lang },
        { action: 'setSubtitle', subtitle: lang },
        { action: 'setTrack', track: lang },
        { type: 'PLAYER_COMMAND', command: 'setSubtitle', value: lang },
        { event: 'command', func: 'setSubtitle', args: [lang] },
        { context: 'player.js', version: '0.0.11', method: 'setSubtitle', value: lang },
        { name: 'setCurrentCaptions', type: 'jwplayer', value: id !== null ? 1 : 0 },
        { type: 'setClosedCaptions', enabled: id !== null, lang: lang },
      ];
      for (const msg of messages) {
        try {
          win.postMessage(msg, '*');
          win.postMessage(JSON.stringify(msg), '*');
        } catch {}
      }
    }
    this.sink({ textTracks: [...this.currentTextTracks] });
  }

  setVolume(volume: number, muted: boolean): void {
    const level = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0));
    this.lastVolume = { volume: level, muted };
    this.pushVolume();
    // Echo the clamped value so our own slider can never display a level the
    // relay did not actually send.
    this.sink({ volume: level, muted });
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.loadTimer);
    window.clearTimeout(this.proofTimer);
    for (const timer of this.relayTimers) window.clearTimeout(timer);
    this.relayTimers = [];
    if (this.onMessage) window.removeEventListener('message', this.onMessage);
    this.onMessage = null;
    // The frame's own listener is not on the window, so it has to come off here.
    if (this.onLoad && this.frame) this.frame.removeEventListener('load', this.onLoad);
    this.onLoad = null;
    this.frame?.remove();
    this.frame = null;
  }
}
