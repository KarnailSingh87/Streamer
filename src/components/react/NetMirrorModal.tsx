// src/components/react/NetMirrorModal.tsx — 1:1 NetMirror / Netflix Preview Dialog
import React, { useState, useEffect, useRef } from 'react';

export interface Episode {
  episode_number: number;
  name: string;
  overview: string;
  still_path: string | null;
  runtime: string;
}

export interface Recommendation {
  id: number;
  title: string;
  mediaType: 'movie' | 'tv';
  backdropUrl: string | null;
  year?: string;
  rating?: number | null;
  match?: string;
  ageRating?: string;
  duration?: string;
  overview?: string;
}

export interface PreviewData {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  overview: string;
  backdropUrl: string | null;
  posterUrl: string | null;
  year: string;
  runtime?: string;
  seasonsCount?: string;
  rating: number | null;
  match: string;
  ageRating: string;
  quality: string;
  descriptors: string;
  genres: string[];
  cast: string[];
  languages: string[];
  thisShowIs: string[];
  seasons: Array<{
    season_number: number;
    name: string;
    episode_count: number;
  }>;
  currentSeason: number;
  episodes: Episode[];
  recommendations: Recommendation[];
}

export default function NetMirrorModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PreviewData | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [seasonLoading, setSeasonLoading] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [activeLang, setActiveLang] = useState<string>('Hindi');
  const modalRef = useRef<HTMLDivElement>(null);

  // Open modal handler
  const openModal = async (id: number, mediaType: 'movie' | 'tv' = 'movie') => {
    setLoading(true);
    setIsOpen(true);
    setSelectedSeason(1);
    document.body.style.overflow = 'hidden';

    try {
      const res = await fetch(`/api/preview?id=${id}&type=${mediaType}`);
      if (!res.ok) throw new Error('Failed to load preview');
      const json: PreviewData = await res.json();
      setData(json);
      if (json.languages && json.languages.length > 0) {
        setActiveLang(json.languages.includes('Hindi') ? 'Hindi' : json.languages[0]);
      }

      // Check watchlist state
      try {
        const wl = JSON.parse(localStorage.getItem('streamer_watchlist') || '[]');
        setIsSaved(wl.some((item: any) => item.id === id && item.mediaType === mediaType));
      } catch {}

      // Update URL hash for clean sharing / back-button support without page reload
      window.history.replaceState(null, '', `#preview-${mediaType}-${id}`);
    } catch (err) {
      console.error('[NetMirrorModal] Error fetching preview:', err);
    } finally {
      setLoading(false);
    }
  };

  const closeModal = () => {
    setIsOpen(false);
    setData(null);
    document.body.style.overflow = '';
    // Clear preview hash cleanly
    if (window.location.hash.startsWith('#preview-')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };

  // Toggle watchlist
  const toggleWatchlist = () => {
    if (!data) return;
    try {
      const wl = JSON.parse(localStorage.getItem('streamer_watchlist') || '[]');
      const exists = wl.some((i: any) => i.id === data.id && i.mediaType === data.mediaType);
      const next = exists
        ? wl.filter((i: any) => !(i.id === data.id && i.mediaType === data.mediaType))
        : [...wl, { id: data.id, mediaType: data.mediaType, title: data.title, posterUrl: data.posterUrl, addedAt: new Date().toISOString() }];
      localStorage.setItem('streamer_watchlist', JSON.stringify(next));
      setIsSaved(!exists);
    } catch {}
  };

  // Load season episodes
  const handleSeasonChange = async (seasonNum: number) => {
    if (!data) return;
    setSelectedSeason(seasonNum);
    setSeasonLoading(true);
    try {
      const res = await fetch(`/api/tv/${data.id}/season/${seasonNum}`);
      if (!res.ok) throw new Error('Failed to load season');
      const json = await res.json() as { episodes?: Episode[] };
      if (json.episodes) {
        setData((prev) => (prev ? { ...prev, episodes: json.episodes! } : null));
      }
    } catch (e) {
      console.error('[NetMirrorModal] Season fetch error:', e);
    } finally {
      setSeasonLoading(false);
    }
  };

  // Listen to custom open events and intercept card clicks globally
  useEffect(() => {
    const handleCustomOpen = (e: CustomEvent<{ id: number; mediaType?: 'movie' | 'tv' }>) => {
      if (e.detail?.id) {
        openModal(e.detail.id, e.detail.mediaType || 'movie');
      }
    };

    window.addEventListener('open-netmirror-modal' as any, handleCustomOpen);

    // Global click listener to intercept clicks on poster cards, top10 cards, etc.
    const handleDocumentClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('[data-netmirror-id], .poster-card-cover, .pc-btn--info, .t10-card');
      if (!target) return;

      // If the click is directly on the play button on a card with explicit play intent, allow or open
      const isPlayBtn = (e.target as HTMLElement).closest('.pc-btn--play, [data-play-direct]');
      if (isPlayBtn) return; // let native play href run

      const card = target.closest('[data-netmirror-id]') as HTMLElement || target as HTMLElement;
      const rawId = card.getAttribute('data-netmirror-id') ||
                    card.getAttribute('data-id') ||
                    card.getAttribute('href')?.match(/\/(movie|series)\/(\d+)/)?.[2];
      const rawType = card.getAttribute('data-netmirror-type') ||
                      card.getAttribute('data-type') ||
                      (card.getAttribute('href')?.includes('/series/') ? 'tv' : 'movie');

      if (rawId && !isNaN(Number(rawId))) {
        e.preventDefault();
        e.stopPropagation();
        openModal(Number(rawId), rawType === 'tv' ? 'tv' : 'movie');
      }
    };

    document.addEventListener('click', handleDocumentClick, true);

    // Check if URL hash has a preview on page load
    const hashMatch = window.location.hash.match(/^#preview-(movie|tv)-(\d+)$/);
    if (hashMatch) {
      openModal(Number(hashMatch[2]), hashMatch[1] as 'movie' | 'tv');
    }

    // Keyboard Escape to close
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('open-netmirror-modal' as any, handleCustomOpen);
      document.removeEventListener('click', handleDocumentClick, true);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="netmirror-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={data?.title || 'Title preview'}
    >
      <div className="netmirror-modal-card" ref={modalRef}>
        {/* Close Button */}
        <button
          type="button"
          className="netmirror-close-btn"
          onClick={closeModal}
          aria-label="Close dialog"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {loading || !data ? (
          <div className="netmirror-loading-state">
            <div className="netmirror-spinner" />
          </div>
        ) : (
          <>
            {/* Hero Banner Header */}
            <div className="netmirror-hero-wrap">
              {data.backdropUrl ? (
                <img
                  src={data.backdropUrl}
                  alt={data.title}
                  className="netmirror-hero-img"
                />
              ) : (
                <div className="netmirror-hero-placeholder" />
              )}
              <div className="netmirror-hero-gradient" />

              <div className="netmirror-hero-actions-container">
                <h1 className="netmirror-hero-title">{data.title}</h1>

                <div className="netmirror-hero-btns-row">
                  {/* Big White Play Button */}
                  <a
                    href={
                      data.mediaType === 'movie'
                        ? `/movie/${data.id}?play=1#watch`
                        : `/series/${data.id}?season=${selectedSeason}&episode=1&play=1#watch`
                    }
                    className="netmirror-play-btn"
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    <span>Play</span>
                  </a>

                  {/* Add to List (+) */}
                  <button
                    type="button"
                    className={`netmirror-round-btn${isSaved ? ' is-active' : ''}`}
                    onClick={toggleWatchlist}
                    title={isSaved ? 'Remove from My List' : 'Add to My List'}
                    aria-label="Add to My List"
                  >
                    {isSaved ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    )}
                  </button>

                  {/* Thumbs Up Like */}
                  <button
                    type="button"
                    className={`netmirror-round-btn${isLiked ? ' is-active' : ''}`}
                    onClick={() => setIsLiked(!isLiked)}
                    title="I like this"
                    aria-label="Like"
                  >
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                    </svg>
                  </button>

                  {/* Recently Added Pill Badge */}
                  <div className="netmirror-recent-badge">Recently added</div>
                </div>
              </div>
            </div>

            {/* Content Body: 2 Columns */}
            <div className="netmirror-body-content">
              <div className="netmirror-grid-cols">
                {/* Left Column: Metadata & Overview */}
                <div className="netmirror-col-left">
                  <div className="netmirror-meta-line">
                    <span className="netmirror-match-badge">{data.match}</span>
                    <span className="netmirror-meta-year">{data.year}</span>
                    <span className="netmirror-meta-duration">
                      {data.mediaType === 'tv' ? data.seasonsCount : data.runtime}
                    </span>
                    <span className="netmirror-quality-pill">{data.quality}</span>
                  </div>

                  <div className="netmirror-rating-advisory-row">
                    <span className="netmirror-age-badge">{data.ageRating}</span>
                    <span className="netmirror-advisory-text">{data.descriptors}</span>
                  </div>

                  <p className="netmirror-synopsis">{data.overview}</p>

                  {/* Spoken Languages Row with Red Underline */}
                  {data.languages && data.languages.length > 0 && (
                    <div className="netmirror-lang-row">
                      {['Unknown', ...data.languages.slice(0, 5)].map((lang, idx) => (
                        <button
                          key={idx}
                          type="button"
                          className={`netmirror-lang-btn${activeLang === lang ? ' is-selected' : ''}`}
                          onClick={() => setActiveLang(lang)}
                        >
                          {lang}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Right Column: Cast & Genres */}
                <div className="netmirror-col-right">
                  {data.cast && data.cast.length > 0 && (
                    <div className="netmirror-side-item">
                      <span className="netmirror-side-label">Cast: </span>
                      <span className="netmirror-side-val">{data.cast.join(', ')}</span>
                    </div>
                  )}

                  {data.genres && data.genres.length > 0 && (
                    <div className="netmirror-side-item">
                      <span className="netmirror-side-label">Genres: </span>
                      <span className="netmirror-side-val">{data.genres.join(', ')}</span>
                    </div>
                  )}

                  {data.thisShowIs && data.thisShowIs.length > 0 && (
                    <div className="netmirror-side-item">
                      <span className="netmirror-side-label">This show is: </span>
                      <span className="netmirror-side-val">{data.thisShowIs.join(', ')}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* TV Episodes Section */}
              {data.mediaType === 'tv' && (
                <div className="netmirror-episodes-section">
                  <div className="netmirror-episodes-header">
                    <h2 className="netmirror-section-title">Episodes</h2>

                    {data.seasons && data.seasons.length > 1 && (
                      <div className="netmirror-season-dropdown-wrap">
                        <select
                          className="netmirror-season-select"
                          value={selectedSeason}
                          onChange={(e) => handleSeasonChange(Number(e.target.value))}
                          aria-label="Select season"
                        >
                          {data.seasons.map((s) => (
                            <option key={s.season_number} value={s.season_number}>
                              Season {s.season_number} ({s.episode_count} EP)
                            </option>
                          ))}
                        </select>
                        <div className="netmirror-dropdown-arrow">▼</div>
                      </div>
                    )}
                  </div>

                  {seasonLoading ? (
                    <div className="netmirror-season-spinner-wrap">
                      <div className="netmirror-spinner" />
                    </div>
                  ) : (
                    <div className="netmirror-episodes-list">
                      {data.episodes && data.episodes.length > 0 ? (
                        data.episodes.map((ep) => (
                          <a
                            key={ep.episode_number}
                            href={`/series/${data.id}?season=${selectedSeason}&episode=${ep.episode_number}&play=1#watch`}
                            className="netmirror-episode-item"
                          >
                            <span className="netmirror-ep-num">{ep.episode_number}</span>

                            <div className="netmirror-ep-thumb-wrap">
                              {ep.still_path ? (
                                <img
                                  src={ep.still_path}
                                  alt={ep.name}
                                  className="netmirror-ep-thumb"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="netmirror-ep-thumb-empty" />
                              )}
                              <div className="netmirror-ep-play-overlay">
                                <div className="netmirror-ep-play-icon">
                                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                                    <polygon points="6 4 20 12 6 20 6 4" />
                                  </svg>
                                </div>
                              </div>
                            </div>

                            <div className="netmirror-ep-info">
                              <div className="netmirror-ep-top-row">
                                <span className="netmirror-ep-title">{ep.name}</span>
                                <span className="netmirror-ep-runtime">{ep.runtime}</span>
                              </div>
                              <p className="netmirror-ep-overview">{ep.overview || data.overview}</p>
                            </div>
                          </a>
                        ))
                      ) : (
                        <div className="netmirror-no-episodes">No episodes available for this season.</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* More Like This Section */}
              {data.recommendations && data.recommendations.length > 0 && (
                <div className="netmirror-recs-section">
                  <h2 className="netmirror-section-title">More Like This</h2>

                  <div className="netmirror-recs-grid">
                    {data.recommendations.map((rec) => (
                      <div
                        key={rec.id}
                        className="netmirror-rec-card"
                        onClick={() => openModal(rec.id, rec.mediaType)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="netmirror-rec-img-wrap">
                          {rec.backdropUrl ? (
                            <img
                              src={rec.backdropUrl}
                              alt={rec.title}
                              className="netmirror-rec-img"
                              loading="lazy"
                            />
                          ) : (
                            <div className="netmirror-rec-placeholder" />
                          )}
                          <span className="netmirror-rec-duration-badge">{rec.duration}</span>
                          <div className="netmirror-rec-red-badge">Recently added</div>
                          <div className="netmirror-rec-hover-play">
                            <div className="netmirror-rec-play-circle">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="6 4 20 12 6 20 6 4" />
                              </svg>
                            </div>
                          </div>
                        </div>

                        <div className="netmirror-rec-details">
                          <div className="netmirror-rec-meta-row">
                            <div className="netmirror-rec-tags">
                              <span className="netmirror-match-badge">{rec.match}</span>
                              <span className="netmirror-age-badge-sm">{rec.ageRating}</span>
                              <span className="netmirror-rec-year">{rec.year}</span>
                            </div>
                            <button
                              type="button"
                              className="netmirror-rec-plus-btn"
                              aria-label="Add to List"
                              onClick={(e) => {
                                e.stopPropagation();
                              }}
                            >
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </svg>
                            </button>
                          </div>
                          <p className="netmirror-rec-overview">{rec.overview}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <style>{`
        .netmirror-modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 10000;
          background: rgba(0, 0, 0, 0.78);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          display: flex;
          justify-content: center;
          align-items: flex-start;
          overflow-y: auto;
          padding: 2.5rem 1rem;
          animation: nm-fade 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes nm-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }

        .netmirror-modal-card {
          position: relative;
          width: 100%;
          max-width: 860px;
          background: #181818;
          border-radius: 10px;
          box-shadow: 0 25px 80px rgba(0, 0, 0, 0.95);
          overflow: hidden;
          margin-bottom: 2rem;
          animation: nm-scale 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes nm-scale {
          from { transform: scale(0.94); opacity: 0; }
          to   { transform: scale(1); opacity: 1; }
        }

        .netmirror-close-btn {
          position: absolute;
          top: 16px;
          right: 16px;
          z-index: 20;
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: #181818;
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 150ms ease;
        }
        .netmirror-close-btn:hover {
          background: #2a2a2a;
          transform: scale(1.08);
          border-color: #ffffff;
        }

        .netmirror-loading-state {
          min-height: 480px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .netmirror-spinner {
          width: 44px;
          height: 44px;
          border: 3px solid rgba(255, 255, 255, 0.2);
          border-top-color: #e50914;
          border-radius: 50%;
          animation: nm-spin 0.75s linear infinite;
        }
        @keyframes nm-spin {
          to { transform: rotate(360deg); }
        }

        /* Hero Image & Overlay */
        .netmirror-hero-wrap {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 9;
          max-height: 480px;
          overflow: hidden;
          background: #000;
        }
        .netmirror-hero-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .netmirror-hero-placeholder {
          width: 100%;
          height: 100%;
          background: #222;
        }
        .netmirror-hero-gradient {
          position: absolute;
          inset: 0;
          background: linear-gradient(0deg, #181818 0%, rgba(24, 24, 24, 0.7) 35%, rgba(24, 24, 24, 0) 70%);
          pointer-events: none;
        }

        .netmirror-hero-actions-container {
          position: absolute;
          bottom: 2rem;
          left: 2.5rem;
          right: 2.5rem;
          z-index: 10;
        }
        .netmirror-hero-title {
          font-size: 2.4rem;
          font-weight: 800;
          color: #ffffff;
          line-height: 1.15;
          margin-bottom: 1.25rem;
          text-shadow: 0 4px 18px rgba(0, 0, 0, 0.85);
          letter-spacing: -0.02em;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          max-width: calc(100% - 48px);
        }
        .netmirror-hero-btns-row {
          display: flex;
          align-items: center;
          gap: 0.85rem;
        }

        /* Play Button (White pill) */
        .netmirror-play-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.6rem;
          padding: 0.65rem 1.75rem;
          background: #ffffff;
          color: #000000;
          font-size: 1.1rem;
          font-weight: 700;
          border-radius: 4px;
          text-decoration: none;
          transition: all 150ms ease;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
        }
        .netmirror-play-btn:hover {
          background: rgba(255, 255, 255, 0.85);
          transform: scale(1.03);
        }

        /* Round action buttons (+, like) */
        .netmirror-round-btn {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: 2px solid rgba(255, 255, 255, 0.65);
          background: rgba(42, 42, 42, 0.65);
          color: #ffffff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 150ms ease;
          backdrop-filter: blur(6px);
        }
        .netmirror-round-btn:hover {
          border-color: #ffffff;
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.08);
        }
        .netmirror-round-btn.is-active {
          border-color: #e50914;
          background: rgba(229, 9, 20, 0.3);
          color: #e50914;
        }

        /* Recently Added red badge */
        .netmirror-recent-badge {
          background: #e50914;
          color: #ffffff;
          font-size: 0.875rem;
          font-weight: 700;
          padding: 0.4rem 0.85rem;
          border-radius: 4px;
          letter-spacing: 0.02em;
          box-shadow: 0 4px 12px rgba(229, 9, 20, 0.4);
          margin-left: 0.25rem;
        }

        /* Modal Body */
        .netmirror-body-content {
          padding: 1.5rem 2.5rem 2.5rem;
          color: #ffffff;
        }

        .netmirror-grid-cols {
          display: grid;
          grid-template-columns: 1.6fr 1fr;
          gap: 2.5rem;
          margin-bottom: 2rem;
        }

        .netmirror-meta-line {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.75rem;
          font-size: 0.95rem;
          margin-bottom: 0.85rem;
        }
        .netmirror-match-badge {
          color: #46d369;
          font-weight: 700;
        }
        .netmirror-meta-year,
        .netmirror-meta-duration {
          color: #a3a3a3;
        }
        .netmirror-quality-pill {
          font-size: 0.7rem;
          font-weight: 700;
          padding: 1px 5px;
          border: 1px solid rgba(255, 255, 255, 0.4);
          border-radius: 3px;
          color: #ffffff;
          line-height: 1.2;
        }

        .netmirror-rating-advisory-row {
          display: flex;
          align-items: center;
          gap: 0.65rem;
          font-size: 0.875rem;
          color: #a3a3a3;
          margin-bottom: 1rem;
        }
        .netmirror-age-badge {
          border: 1px solid rgba(255, 255, 255, 0.4);
          padding: 1px 6px;
          font-size: 0.8rem;
          color: #ffffff;
          font-weight: 600;
          border-radius: 2px;
        }
        .netmirror-synopsis {
          font-size: 0.975rem;
          line-height: 1.55;
          color: #e5e5e5;
          margin-bottom: 1.25rem;
        }

        /* Language row with red underline */
        .netmirror-lang-row {
          display: flex;
          align-items: center;
          gap: 1.25rem;
          margin-top: 1.25rem;
          padding-top: 0.75rem;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          overflow-x: auto;
        }
        .netmirror-lang-btn {
          background: none;
          border: none;
          color: #a3a3a3;
          font-size: 0.92rem;
          font-weight: 600;
          cursor: pointer;
          padding: 0.35rem 0.1rem;
          position: relative;
          transition: color 150ms ease;
        }
        .netmirror-lang-btn:hover {
          color: #ffffff;
        }
        .netmirror-lang-btn.is-selected {
          color: #ffffff;
        }
        .netmirror-lang-btn.is-selected::after {
          content: '';
          position: absolute;
          bottom: -2px;
          left: 0;
          right: 0;
          height: 3px;
          background: #e50914;
          border-radius: 2px;
        }

        /* Right column */
        .netmirror-col-right {
          font-size: 0.875rem;
          line-height: 1.55;
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
        }
        .netmirror-side-item {
          word-break: break-word;
        }
        .netmirror-side-label {
          color: #777777;
        }
        .netmirror-side-val {
          color: #dddddd;
        }

        /* Episodes Section */
        .netmirror-episodes-section {
          border-top: 1px solid #404040;
          padding-top: 1.75rem;
          margin-bottom: 2.5rem;
        }
        .netmirror-episodes-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1.25rem;
        }
        .netmirror-section-title {
          font-size: 1.5rem;
          font-weight: 700;
          color: #ffffff;
        }

        .netmirror-season-dropdown-wrap {
          position: relative;
          display: inline-flex;
          align-items: center;
        }
        .netmirror-season-select {
          appearance: none;
          background: #242424;
          color: #ffffff;
          border: 1px solid #4d4d4d;
          border-radius: 4px;
          padding: 0.55rem 2.2rem 0.55rem 1rem;
          font-size: 0.95rem;
          font-weight: 600;
          cursor: pointer;
        }
        .netmirror-dropdown-arrow {
          position: absolute;
          right: 12px;
          pointer-events: none;
          font-size: 0.75rem;
          color: #a3a3a3;
        }

        .netmirror-season-spinner-wrap {
          min-height: 160px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .netmirror-episodes-list {
          display: flex;
          flex-direction: column;
        }
        .netmirror-episode-item {
          display: flex;
          align-items: center;
          gap: 1.25rem;
          padding: 1.15rem 1rem;
          border-bottom: 1px solid #333333;
          border-radius: 6px;
          text-decoration: none;
          color: inherit;
          transition: background 150ms ease;
        }
        .netmirror-episode-item:hover {
          background: #2f2f2f;
        }
        .netmirror-ep-num {
          font-size: 1.4rem;
          font-weight: 600;
          color: #8c8c8c;
          min-width: 28px;
          text-align: center;
        }
        .netmirror-ep-thumb-wrap {
          position: relative;
          width: 140px;
          height: 80px;
          border-radius: 6px;
          overflow: hidden;
          background: #262626;
          flex-shrink: 0;
        }
        .netmirror-ep-thumb {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .netmirror-ep-thumb-empty {
          width: 100%;
          height: 100%;
          background: #333;
        }
        .netmirror-ep-play-overlay {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 150ms ease;
        }
        .netmirror-episode-item:hover .netmirror-ep-play-overlay {
          opacity: 1;
        }
        .netmirror-ep-play-icon {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 2px solid #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #ffffff;
          background: rgba(0, 0, 0, 0.5);
        }

        .netmirror-ep-info {
          flex: 1;
          min-width: 0;
        }
        .netmirror-ep-top-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          margin-bottom: 0.35rem;
          min-width: 0;
        }
        .netmirror-ep-title {
          font-size: 1rem;
          font-weight: 700;
          color: #ffffff;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .netmirror-ep-runtime {
          font-size: 0.9rem;
          color: #a3a3a3;
          flex-shrink: 0;
        }
        .netmirror-ep-overview {
          font-size: 0.85rem;
          color: #a3a3a3;
          line-height: 1.45;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        /* More Like This Grid */
        .netmirror-recs-section {
          border-top: 1px solid #404040;
          padding-top: 2rem;
        }
        .netmirror-recs-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.15rem;
          margin-top: 1.25rem;
        }
        .netmirror-rec-card {
          background: #2f2f2f;
          border-radius: 6px;
          overflow: hidden;
          cursor: pointer;
          transition: transform 180ms ease, background 180ms ease;
          display: flex;
          flex-direction: column;
        }
        .netmirror-rec-card:hover {
          transform: translateY(-4px);
          background: #383838;
        }
        .netmirror-rec-img-wrap {
          position: relative;
          aspect-ratio: 16 / 9;
          background: #111;
          overflow: hidden;
        }
        .netmirror-rec-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .netmirror-rec-placeholder {
          width: 100%;
          height: 100%;
          background: #222;
        }
        .netmirror-rec-duration-badge {
          position: absolute;
          top: 8px;
          right: 8px;
          background: rgba(0, 0, 0, 0.7);
          color: #fff;
          font-size: 0.75rem;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 3px;
        }
        .netmirror-rec-red-badge {
          position: absolute;
          bottom: 8px;
          left: 8px;
          background: #e50914;
          color: #fff;
          font-size: 0.7rem;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 3px;
        }
        .netmirror-rec-hover-play {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 150ms ease;
        }
        .netmirror-rec-card:hover .netmirror-rec-hover-play {
          opacity: 1;
        }
        .netmirror-rec-play-circle {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: 2px solid #ffffff;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          color: #ffffff;
        }

        .netmirror-rec-details {
          padding: 1rem;
          flex: 1;
          display: flex;
          flex-direction: column;
        }
        .netmirror-rec-meta-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.65rem;
        }
        .netmirror-rec-tags {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.85rem;
        }
        .netmirror-age-badge-sm {
          border: 1px solid rgba(255, 255, 255, 0.4);
          padding: 0 4px;
          font-size: 0.75rem;
          color: #fff;
          border-radius: 2px;
        }
        .netmirror-rec-year {
          color: #a3a3a3;
        }
        .netmirror-rec-plus-btn {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 1.5px solid rgba(255, 255, 255, 0.5);
          background: transparent;
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 150ms ease;
        }
        .netmirror-rec-plus-btn:hover {
          border-color: #ffffff;
          background: rgba(255, 255, 255, 0.2);
        }
        .netmirror-rec-overview {
          font-size: 0.825rem;
          color: #b3b3b3;
          line-height: 1.45;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        @media (max-width: 768px) {
          .netmirror-modal-backdrop {
            padding: 0;
          }
          .netmirror-modal-card {
            border-radius: 0;
            min-height: 100vh;
            margin-bottom: 0;
          }
          .netmirror-hero-title {
            font-size: 1.75rem;
          }
          .netmirror-hero-actions-container {
            bottom: 1rem;
            left: 1rem;
            right: 1rem;
          }
          .netmirror-body-content {
            padding: 1.25rem 1rem;
          }
          .netmirror-grid-cols {
            grid-template-columns: 1fr;
            gap: 1.25rem;
          }
          .netmirror-recs-grid {
            grid-template-columns: 1fr;
          }
          .netmirror-ep-thumb-wrap {
            width: 105px;
            height: 60px;
          }
        }
      `}</style>
    </div>
  );
}
