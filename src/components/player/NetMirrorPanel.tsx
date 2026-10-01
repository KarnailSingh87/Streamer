// src/components/player/NetMirrorPanel.tsx — exact NetMirror (net77.cc) side panel.
//
// Replicates the 4-tab right-docked settings drawer from net77.cc:
// 1. Quality (signal bars icon)
// 2. Subtitles (CC box icon) with "Subtitle Settings"
// 3. Playback Speed (timer icon)
// 4. Audio tracks (audio/headphone icon)
//
// Each active item features:
// - Red left vertical indicator strip (#e50914)
// - Gray active background (#383838)
// - Green play triangle icon (▶)
// - Bright green label (#22c55e)

import { useState, useRef, useEffect } from 'react';
import type { AudioTrackInfo, TextTrackInfo } from '../../lib/player/types';
import type { SubtitleBackdrop, SubtitleSize } from '../../lib/player/prefs';

export interface ServerOptionItem {
  id: string;
  name: string;
  label: string;
  qualityLabel?: string | null;
  online?: boolean;
  verified?: boolean;
  live?: boolean;
  failed?: boolean;
}

export type NetMirrorTab = 'server' | 'quality' | 'subtitles' | 'speed' | 'audio';

interface NetMirrorPanelProps {
  open: boolean;
  activeTab: NetMirrorTab;
  onTabChange: (tab: NetMirrorTab) => void;
  onClose: () => void;
  servers?: ServerOptionItem[];
  activeServer?: string | null;
  onSelectServer?: (id: string) => void;
  quality: string;
  onSelectQuality: (q: string) => void;
  audioTracks: AudioTrackInfo[];
  onSelectAudio: (id: string) => void;
  textTracks: TextTrackInfo[];
  onSelectText: (id: string | null) => void;
  rate: number;
  onSelectRate: (rate: number) => void;
  subtitleSize: SubtitleSize;
  subtitleBackdrop: SubtitleBackdrop;
  onSubtitleSize: (size: SubtitleSize) => void;
  onSubtitleBackdrop: (backdrop: SubtitleBackdrop) => void;
}

export default function NetMirrorPanel({
  open,
  activeTab,
  onTabChange,
  onClose,
  servers = [],
  activeServer,
  onSelectServer,
  quality,
  onSelectQuality,
  audioTracks,
  onSelectAudio,
  textTracks,
  onSelectText,
  rate,
  onSelectRate,
  subtitleSize,
  subtitleBackdrop,
  onSubtitleSize,
  onSubtitleBackdrop,
}: NetMirrorPanelProps) {
  const [showSubSettings, setShowSubSettings] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape or click outside
  useEffect(() => {
    if (!open) return;
    const openedAt = Date.now();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent | PointerEvent) => {
      // Ignore interactions during the initial opening gesture
      if (Date.now() - openedAt < 180) return;
      const target = e.target as HTMLElement | null;
      if (panelRef.current && !panelRef.current.contains(target as Node)) {
        if (target?.closest?.('.fp-top-btn, .fp-btn, .fp-settings-btn')) {
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const speeds = [
    { label: '0.5x', value: 0.5 },
    { label: '0.75x', value: 0.75 },
    { label: 'Normal', value: 1 },
    { label: '1.25x', value: 1.25 },
    { label: '1.5x', value: 1.5 },
    { label: '2x', value: 2 },
  ];

  const qualities = ['Auto', '1080p', '720p', '480p'];

  return (
    <div
      ref={panelRef}
      className="nm-panel"
      role="dialog"
      aria-label="Player Settings"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ── Top Tab Bar ── */}
      <div className="nm-tabs-bar">
        <div className="nm-tabs-list">
          {/* Tab 0: Server (when servers are available) */}
          {servers && servers.length > 0 && (
            <button
              type="button"
              className={`nm-tab-btn${activeTab === 'server' ? ' is-active' : ''}`}
              onClick={() => onTabChange('server')}
              title="Servers"
              aria-label="Servers"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                <line x1="6" y1="6" x2="6.01" y2="6" />
                <line x1="6" y1="18" x2="6.01" y2="18" />
              </svg>
            </button>
          )}

          {/* Tab 1: Quality */}
          <button
            type="button"
            className={`nm-tab-btn${activeTab === 'quality' ? ' is-active' : ''}`}
            onClick={() => onTabChange('quality')}
            title="Quality"
            aria-label="Quality"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="3" y="16" width="3" height="5" rx="0.5" />
              <rect x="8.5" y="12" width="3" height="9" rx="0.5" />
              <rect x="14" y="8" width="3" height="13" rx="0.5" />
              <rect x="19.5" y="4" width="3" height="17" rx="0.5" />
            </svg>
          </button>

          {/* Tab 2: Subtitles */}
          <button
            type="button"
            className={`nm-tab-btn${activeTab === 'subtitles' ? ' is-active' : ''}`}
            onClick={() => onTabChange('subtitles')}
            title="Subtitles"
            aria-label="Subtitles"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M10 9.5a2.5 2.5 0 0 0-2.5 2.5v0a2.5 2.5 0 0 0 2.5 2.5" />
              <path d="M16.5 9.5a2.5 2.5 0 0 0-2.5 2.5v0a2.5 2.5 0 0 0 2.5 2.5" />
            </svg>
          </button>

          {/* Tab 3: Speed */}
          <button
            type="button"
            className={`nm-tab-btn${activeTab === 'speed' ? ' is-active' : ''}`}
            onClick={() => onTabChange('speed')}
            title="Playback Speed"
            aria-label="Playback Speed"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 8h2" />
              <path d="M4 12h3" />
              <path d="M5 16h2" />
              <circle cx="14" cy="12" r="7" />
              <polyline points="14 9 14 12 16 14" />
            </svg>
          </button>

          {/* Tab 4: Audio */}
          <button
            type="button"
            className={`nm-tab-btn${activeTab === 'audio' ? ' is-active' : ''}`}
            onClick={() => onTabChange('audio')}
            title="Audio"
            aria-label="Audio"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16" />
              <path d="M4 10h16" />
              <path d="M7 15a5 5 0 0 1 10 0v2" />
              <rect x="5" y="16" width="3" height="4" rx="1" />
              <rect x="16" y="16" width="3" height="4" rx="1" />
            </svg>
          </button>
        </div>

        {/* Close Button */}
        <button
          type="button"
          className="nm-close-btn"
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* ── Content Body ── */}
      <div className="nm-panel-body">
        {/* TAB 0: Servers */}
        {activeTab === 'server' && (
          <div className="nm-list">
            {servers.map((s, idx) => {
              const active = activeServer === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`nm-row${active ? ' is-active' : ''}`}
                  onClick={() => onSelectServer?.(s.id)}
                >
                  {active ? (
                    <span className="nm-play-icon" aria-hidden="true">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="#22c55e">
                        <polygon points="6 3 20 12 6 21 6 3" />
                      </svg>
                    </span>
                  ) : (
                    <span className="nm-play-placeholder" aria-hidden="true" />
                  )}
                  <div className="nm-server-info">
                    <span className="nm-row-text">Server {idx + 1} ({s.name})</span>
                    {s.qualityLabel && <span className="nm-server-badge">{s.qualityLabel}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* TAB 1: Quality */}
        {activeTab === 'quality' && (
          <div className="nm-list">
            {qualities.map((q) => {
              const active = quality === q;
              return (
                <button
                  key={q}
                  type="button"
                  className={`nm-row${active ? ' is-active' : ''}`}
                  onClick={() => onSelectQuality(q)}
                >
                  {active ? (
                    <span className="nm-play-icon" aria-hidden="true">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="#22c55e">
                        <polygon points="6 3 20 12 6 21 6 3" />
                      </svg>
                    </span>
                  ) : (
                    <span className="nm-play-placeholder" aria-hidden="true" />
                  )}
                  <span className="nm-row-text">{q}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* TAB 2: Subtitles */}
        {activeTab === 'subtitles' && (
          <div className="nm-subtitles-wrap">
            <div className="nm-sub-header">
              <button
                type="button"
                className="nm-sub-settings-btn"
                onClick={() => setShowSubSettings(!showSubSettings)}
              >
                Subtitle Settings
              </button>
            </div>

            {showSubSettings && (
              <div className="nm-sub-styling-box">
                <div className="nm-sub-style-group">
                  <span className="nm-sub-style-label">Size:</span>
                  {(['small', 'medium', 'large'] as SubtitleSize[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`nm-sub-style-pill${subtitleSize === s ? ' is-active' : ''}`}
                      onClick={() => onSubtitleSize(s)}
                    >
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
                <div className="nm-sub-style-group">
                  <span className="nm-sub-style-label">Background:</span>
                  {(['none', 'shadow', 'box'] as SubtitleBackdrop[]).map((b) => (
                    <button
                      key={b}
                      type="button"
                      className={`nm-sub-style-pill${subtitleBackdrop === b ? ' is-active' : ''}`}
                      onClick={() => onSubtitleBackdrop(b)}
                    >
                      {b === 'none' ? 'Off' : b === 'shadow' ? 'Shadow' : 'Box'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="nm-list">
              {/* Off Option */}
              <button
                type="button"
                className={`nm-row${!textTracks.some((t) => t.active) ? ' is-active' : ''}`}
                onClick={() => onSelectText(null)}
              >
                {!textTracks.some((t) => t.active) ? (
                  <span className="nm-play-icon" aria-hidden="true">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="#22c55e">
                      <polygon points="6 3 20 12 6 21 6 3" />
                    </svg>
                  </span>
                ) : (
                  <span className="nm-play-placeholder" aria-hidden="true" />
                )}
                <span className="nm-row-text">Off</span>
              </button>

              {/* Subtitle Tracks */}
              {textTracks.map((t) => {
                const active = t.active;
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`nm-row${active ? ' is-active' : ''}`}
                    onClick={() => onSelectText(t.id)}
                  >
                    {active ? (
                      <span className="nm-play-icon" aria-hidden="true">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="#22c55e">
                          <polygon points="6 3 20 12 6 21 6 3" />
                        </svg>
                      </span>
                    ) : (
                      <span className="nm-play-placeholder" aria-hidden="true" />
                    )}
                    <span className="nm-row-text">{t.label || t.lang}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 3: Speed */}
        {activeTab === 'speed' && (
          <div className="nm-list">
            {speeds.map((s) => {
              const active = rate === s.value;
              return (
                <button
                  key={s.value}
                  type="button"
                  className={`nm-row${active ? ' is-active' : ''}`}
                  onClick={() => onSelectRate(s.value)}
                >
                  {active ? (
                    <span className="nm-play-icon" aria-hidden="true">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="#22c55e">
                        <polygon points="6 3 20 12 6 21 6 3" />
                      </svg>
                    </span>
                  ) : (
                    <span className="nm-play-placeholder" aria-hidden="true" />
                  )}
                  <span className="nm-row-text">{s.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* TAB 4: Audio */}
        {activeTab === 'audio' && (
          <div className="nm-list">
            {audioTracks.map((t) => {
              const active = t.active;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`nm-row${active ? ' is-active' : ''}`}
                  onClick={() => onSelectAudio(t.id)}
                >
                  {active ? (
                    <span className="nm-play-icon" aria-hidden="true">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="#22c55e">
                        <polygon points="6 3 20 12 6 21 6 3" />
                      </svg>
                    </span>
                  ) : (
                    <span className="nm-play-placeholder" aria-hidden="true" />
                  )}
                  <span className="nm-row-text">{t.label || t.lang}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
