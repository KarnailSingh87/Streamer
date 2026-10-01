"use client";

import React from "react";

const PRIMARY_LINKS = [
  { name: "Home", href: "/" },
  { name: "TV Shows", href: "/series" },
  { name: "Movies", href: "/movies" },
  { name: "Trending", href: "/movies?sort=trending" },
  { name: "Terms of Service", href: "/terms" },
  { name: "Privacy Policy", href: "/privacy" },
  { name: "Contact Support", href: "/contact" },
];

export function CinematicFooter() {
  return (
    <footer className="simple-netflix-footer" role="contentinfo">
      <div className="simple-footer-inner">
        {/* Brand & Tagline */}
        <div className="simple-footer-top">
          <div className="simple-footer-brand">
            <span className="simple-footer-logo">STREAMER</span>
          </div>
          <div className="simple-footer-status">
            <span className="simple-status-dot" aria-hidden="true" />
            <span>All Fast Servers Active</span>
          </div>
        </div>

        {/* Navigation Links */}
        <nav className="simple-footer-nav" aria-label="Footer Navigation">
          {PRIMARY_LINKS.map((link) => (
            <a key={link.name} href={link.href} className="simple-footer-link">
              {link.name}
            </a>
          ))}
        </nav>

        {/* Disclaimer & Copyright */}
        <div className="simple-footer-bottom">
          <p className="simple-footer-disclaimer">
            This site does not store any files on its server. All contents are provided by non-affiliated third parties.
          </p>
          <div className="simple-footer-copy-row">
            <span>&copy; {new Date().getFullYear()} Streamer. All rights reserved.</span>
            <span className="simple-footer-pill">4K &bull; Ultra HD &bull; Multi-Source</span>
          </div>
        </div>
      </div>

      <style>{`
        .simple-netflix-footer {
          width: 100%;
          background: #0f0f0f;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          color: #8c8c8c;
          padding: 2.75rem 4% 2.25rem;
          margin-top: 4rem;
          position: relative;
          z-index: 5;
        }

        .simple-footer-inner {
          max-width: 1080px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 1.75rem;
        }

        /* Top Row: Brand & Live Status */
        .simple-footer-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 1rem;
          padding-bottom: 1.25rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .simple-footer-brand {
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
        }

        .simple-footer-logo {
          font-family: 'Helvetica Neue', Arial, sans-serif;
          font-size: 1.4rem;
          font-weight: 900;
          color: #e50914;
          letter-spacing: -0.02em;
          line-height: 1;
        }

        .simple-footer-sub {
          font-size: 0.85rem;
          font-weight: 600;
          color: #ffffff;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          opacity: 0.7;
        }

        .simple-footer-status {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.8rem;
          font-weight: 600;
          color: #a3a3a3;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 0.35rem 0.75rem;
          border-radius: 999px;
        }

        .simple-status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #46d369;
          box-shadow: 0 0 8px #46d369;
        }

        /* Navigation row */
        .simple-footer-nav {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 1.5rem 2rem;
        }

        .simple-footer-link {
          color: #a3a3a3;
          font-size: 0.875rem;
          font-weight: 500;
          text-decoration: none;
          transition: color 150ms ease;
        }

        .simple-footer-link:hover {
          color: #ffffff;
        }

        /* Bottom Row */
        .simple-footer-bottom {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          font-size: 0.775rem;
          color: #666666;
          line-height: 1.5;
        }

        .simple-footer-disclaimer {
          margin: 0;
          max-width: 680px;
        }

        .simple-footer-copy-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 0.75rem;
          padding-top: 0.5rem;
        }

        .simple-footer-pill {
          font-size: 0.725rem;
          color: #737373;
          letter-spacing: 0.04em;
        }

        @media (max-width: 768px) {
          .simple-netflix-footer {
            padding: 2rem 1.25rem calc(68px + env(safe-area-inset-bottom, 0px));
            margin-top: 2.5rem;
          }
          .simple-footer-nav {
            gap: 1rem 1.5rem;
          }
          .simple-footer-copy-row {
            flex-direction: column;
            align-items: flex-start;
          }
        }
      `}</style>
    </footer>
  );
}

export default CinematicFooter;
