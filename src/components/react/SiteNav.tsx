"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Bell, Menu, X, ChevronDown, Bookmark, User, LogOut } from "lucide-react";

interface NavLink {
  href: string;
  label: string;
}

interface Props {
  user?: { name: string; avatar_url: string | null } | null;
  pathname?: string;
}

const NAV_LINKS: NavLink[] = [
  { href: "/", label: "Home" },
  { href: "/series", label: "TV Shows" },
  { href: "/movies", label: "Movies" },
  { href: "/netflix", label: "Netflix" },
  { href: "/prime", label: "Prime Video" },
  { href: "/appletv", label: "Apple TV+" },
];

function isLinkActive(href: string, pathname: string) {
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href);
}

export default function SiteNav({ user, pathname = "/" }: Props) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPath, setCurrentPath] = useState(pathname);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Sync pathname on client for Astro transitions
  useEffect(() => {
    setCurrentPath(window.location.pathname);
    const onStart = (e: Event) => {
      const to = (e as CustomEvent & { to?: URL }).to;
      if (to?.pathname) setCurrentPath(to.pathname);
    };
    const onDone = () => setCurrentPath(window.location.pathname);
    document.addEventListener("astro:before-preparation", onStart);
    document.addEventListener("astro:page-load", onDone);
    return () => {
      document.removeEventListener("astro:before-preparation", onStart);
      document.removeEventListener("astro:page-load", onDone);
    };
  }, []);

  // Background opacity transition on scroll
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Close menus on page navigation
  useEffect(() => {
    const handler = () => {
      setMobileMenuOpen(false);
      setProfileMenuOpen(false);
    };
    document.addEventListener("astro:before-preparation", handler);
    return () => document.removeEventListener("astro:before-preparation", handler);
  }, []);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      window.location.href = `/search?q=${encodeURIComponent(searchQuery.trim())}`;
    }
  };

  return (
    <>
      <header
        className={`netflix-header${scrolled ? " is-scrolled" : ""}`}
        role="banner"
      >
        <div className="netflix-header-inner">
          {/* ── Left: Logo & Navigation ── */}
          <div className="netflix-header-left">
            <a href="/" className="netflix-logo" aria-label="Streamer Home">
              <span className="netflix-logo-text">STREAMER</span>
            </a>

            <nav className="netflix-nav-links" aria-label="Main Navigation">
              {NAV_LINKS.map((link) => {
                const active = isLinkActive(link.href, currentPath);
                return (
                  <a
                    key={link.href}
                    href={link.href}
                    className={`netflix-nav-item${active ? " is-active" : ""}`}
                  >
                    {link.label}
                  </a>
                );
              })}
            </nav>
          </div>

          {/* ── Right: Search, Bell, Profile ── */}
          <div className="netflix-header-right">
            {/* Search Bar / Icon */}
            <div className={`netflix-search-box${searchOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="netflix-icon-btn"
                onClick={() => setSearchOpen(!searchOpen)}
                aria-label="Search"
                title="Search"
              >
                <Search size={18} strokeWidth={2.5} />
              </button>
              {searchOpen && (
                <form onSubmit={handleSearchSubmit} className="netflix-search-form">
                  <input
                    ref={searchInputRef}
                    type="search"
                    placeholder="Titles, people, genres"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="netflix-search-input"
                  />
                  <button
                    type="button"
                    className="netflix-search-close"
                    onClick={() => {
                      setSearchOpen(false);
                      setSearchQuery("");
                    }}
                    aria-label="Close search"
                  >
                    <X size={16} />
                  </button>
                </form>
              )}
            </div>

            {/* Notifications Bell */}
            <a
              href="/movies?sort=release_date.desc"
              className="netflix-icon-btn"
              title="Notifications"
              aria-label="Notifications"
            >
              <Bell size={19} />
              <span className="netflix-bell-dot" aria-hidden="true" />
            </a>

            {/* Profile Avatar & Menu */}
            <div className="netflix-profile-wrap">
              <button
                type="button"
                className="netflix-profile-btn"
                onClick={() => setProfileMenuOpen(!profileMenuOpen)}
                aria-expanded={profileMenuOpen}
                aria-label="User menu"
              >
                <div className="netflix-avatar-box">
                  <img
                    src={user?.avatar_url || "https://upload.wikimedia.org/wikipedia/commons/0/0b/Netflix-avatar.png"}
                    alt={user?.name || "Profile"}
                    className="netflix-avatar-img"
                  />
                </div>
                <ChevronDown size={14} className={`netflix-chevron${profileMenuOpen ? " is-open" : ""}`} />
              </button>

              {profileMenuOpen && (
                <div className="netflix-profile-dropdown" role="menu">
                  <div className="netflix-dropdown-arrow" />
                  <a href="/profile" className="netflix-dropdown-item" role="menuitem">
                    <User size={16} />
                    <span>{user?.name || "Account"}</span>
                  </a>
                  <a href="/watchlist" className="netflix-dropdown-item" role="menuitem">
                    <Bookmark size={16} />
                    <span>My List</span>
                  </a>
                  <div className="netflix-dropdown-sep" />
                  <a href="/login" className="netflix-dropdown-item is-signout" role="menuitem">
                    <LogOut size={16} />
                    <span>Sign out of Netflix</span>
                  </a>
                </div>
              )}
            </div>

            {/* Mobile Hamburger Toggle */}
            <button
              type="button"
              className="netflix-hamburger-btn"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            >
              {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>
      </header>

      {/* ── Mobile Slide-out Menu ── */}
      {mobileMenuOpen && (
        <div className="netflix-mobile-drawer" role="dialog" aria-label="Mobile Navigation">
          <div className="netflix-mobile-backdrop" onClick={() => setMobileMenuOpen(false)} />
          <div className="netflix-mobile-content">
            <div className="netflix-mobile-header">
              <span className="netflix-logo-text">STREAMER</span>
              <button
                type="button"
                className="netflix-icon-btn"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close menu"
              >
                <X size={24} />
              </button>
            </div>

            <div className="netflix-mobile-search">
              <form onSubmit={handleSearchSubmit}>
                <input
                  type="search"
                  placeholder="Search movies, TV shows..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="netflix-mobile-input"
                />
              </form>
            </div>

            <nav className="netflix-mobile-nav">
              {NAV_LINKS.map((link) => {
                const active = isLinkActive(link.href, currentPath);
                return (
                  <a
                    key={link.href}
                    href={link.href}
                    className={`netflix-mobile-link${active ? " is-active" : ""}`}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {link.label}
                  </a>
                );
              })}
            </nav>

            <div className="netflix-mobile-footer">
              <a href="/watchlist" className="netflix-mobile-link">
                <Bookmark size={18} />
                <span>My List</span>
              </a>
              <a href="/profile" className="netflix-mobile-link">
                <User size={18} />
                <span>Account & Settings</span>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ── Navbar Styles ── */}
      <style>{`
        .netflix-header {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 68px;
          z-index: 100;
          background: linear-gradient(180deg, rgba(0, 0, 0, 0.75) 10%, rgba(0, 0, 0, 0) 100%);
          transition: background-color 300ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        .netflix-header.is-scrolled {
          background-color: #141414;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        }

        .netflix-header-inner {
          max-width: 1920px;
          margin: 0 auto;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 4%;
        }

        .netflix-header-left {
          display: flex;
          align-items: center;
          gap: 2.25rem;
        }

        .netflix-logo {
          text-decoration: none;
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }

        .netflix-logo-text {
          font-family: "Bebas Neue", "Impact", "Arial Black", sans-serif;
          font-size: 1.85rem;
          font-weight: 900;
          letter-spacing: 0.08em;
          color: #e50914;
          text-transform: uppercase;
          line-height: 1;
          filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6));
        }

        .netflix-nav-links {
          display: flex;
          align-items: center;
          gap: 1.25rem;
        }

        .netflix-nav-item {
          font-size: 0.875rem;
          color: #e5e5e5;
          text-decoration: none;
          transition: color 200ms ease;
          white-space: nowrap;
          font-weight: 500;
        }

        .netflix-nav-item:hover {
          color: #b3b3b3;
        }

        .netflix-nav-item.is-active {
          color: #ffffff;
          font-weight: 700;
        }

        .netflix-header-right {
          display: flex;
          align-items: center;
          gap: 1.25rem;
        }

        .netflix-icon-btn {
          background: transparent;
          border: none;
          color: #ffffff;
          cursor: pointer;
          padding: 0.35rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          position: relative;
          text-decoration: none;
          transition: opacity 150ms ease;
        }

        .netflix-icon-btn:hover {
          opacity: 0.75;
        }

        .netflix-bell-dot {
          position: absolute;
          top: 4px;
          right: 4px;
          width: 6px;
          height: 6px;
          background: #e50914;
          border-radius: 50%;
        }

        /* Expandable search */
        .netflix-search-box {
          display: flex;
          align-items: center;
          position: relative;
        }

        .netflix-search-form {
          position: absolute;
          right: 0;
          display: flex;
          align-items: center;
          background: #141414;
          border: 1px solid rgba(255, 255, 255, 0.85);
          border-radius: 4px;
          padding: 0.2rem 0.5rem;
          width: 250px;
          max-width: calc(100vw - 120px);
          z-index: 50;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
          animation: netflix-search-expand 200ms ease-out;
        }

        @keyframes netflix-search-expand {
          from { width: 40px; opacity: 0; }
          to { width: 250px; opacity: 1; }
        }

        .netflix-search-input {
          background: transparent;
          border: none;
          outline: none;
          color: #ffffff;
          font-size: 0.85rem;
          width: 100%;
          padding: 0.25rem 0.4rem;
        }

        .netflix-search-input::placeholder {
          color: #888888;
        }

        .netflix-search-close {
          background: transparent;
          border: none;
          color: #ffffff;
          cursor: pointer;
          padding: 0.2rem;
          display: flex;
          align-items: center;
        }

        /* Profile avatar */
        .netflix-profile-wrap {
          position: relative;
        }

        .netflix-profile-btn {
          background: transparent;
          border: none;
          display: flex;
          align-items: center;
          gap: 0.4rem;
          cursor: pointer;
          padding: 0;
        }

        .netflix-avatar-box {
          width: 32px;
          height: 32px;
          border-radius: 4px;
          overflow: hidden;
          background: #e50914;
        }

        .netflix-avatar-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .netflix-chevron {
          color: #ffffff;
          transition: transform 200ms ease;
        }

        .netflix-chevron.is-open {
          transform: rotate(180deg);
        }

        .netflix-profile-dropdown {
          position: absolute;
          top: calc(100% + 12px);
          right: 0;
          width: 190px;
          background: rgba(0, 0, 0, 0.94);
          border: 1px solid rgba(255, 255, 255, 0.15);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
          padding: 0.5rem 0;
          display: flex;
          flex-direction: column;
          animation: netflix-drop 150ms ease;
          border-radius: 4px;
        }

        @keyframes netflix-drop {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .netflix-dropdown-arrow {
          position: absolute;
          top: -6px;
          right: 18px;
          width: 0;
          height: 0;
          border-left: 6px solid transparent;
          border-right: 6px solid transparent;
          border-bottom: 6px solid rgba(255, 255, 255, 0.15);
        }

        .netflix-dropdown-item {
          display: flex;
          align-items: center;
          gap: 0.65rem;
          padding: 0.6rem 1rem;
          color: #e5e5e5;
          text-decoration: none;
          font-size: 0.85rem;
          font-weight: 500;
          transition: background-color 150ms ease, color 150ms ease;
        }

        .netflix-dropdown-item:hover {
          background-color: rgba(255, 255, 255, 0.1);
          color: #ffffff;
        }

        .netflix-dropdown-sep {
          height: 1px;
          background: rgba(255, 255, 255, 0.12);
          margin: 0.4rem 0;
        }

        .netflix-dropdown-item.is-signout {
          color: #e50914;
        }

        .netflix-hamburger-btn {
          display: none;
          background: transparent;
          border: none;
          color: #ffffff;
          cursor: pointer;
          padding: 0.25rem;
        }

        /* Mobile drawer */
        .netflix-mobile-drawer {
          position: fixed;
          inset: 0;
          z-index: 150;
          display: flex;
        }

        .netflix-mobile-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(4px);
        }

        .netflix-mobile-content {
          position: relative;
          width: min(300px, 80vw);
          background: #141414;
          height: 100%;
          display: flex;
          flex-direction: column;
          padding: 1.5rem;
          box-shadow: 10px 0 30px rgba(0, 0, 0, 0.8);
          animation: netflix-slide-right 220ms ease;
        }

        @keyframes netflix-slide-right {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }

        .netflix-mobile-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1.5rem;
        }

        .netflix-mobile-search {
          margin-bottom: 1.5rem;
        }

        .netflix-mobile-input {
          width: 100%;
          background: #222222;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 4px;
          padding: 0.55rem 0.85rem;
          color: #ffffff;
          font-size: 0.875rem;
          outline: none;
        }

        .netflix-mobile-nav {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          flex: 1;
          overflow-y: auto;
        }

        .netflix-mobile-link {
          color: #b3b3b3;
          text-decoration: none;
          font-size: 1rem;
          font-weight: 500;
          padding: 0.5rem 0;
          display: flex;
          align-items: center;
          gap: 0.75rem;
          transition: color 150ms ease;
        }

        .netflix-mobile-link:hover,
        .netflix-mobile-link.is-active {
          color: #ffffff;
          font-weight: 700;
        }

        .netflix-mobile-footer {
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          padding-top: 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        @media (max-width: 960px) {
          .netflix-nav-links {
            display: none;
          }
          .netflix-hamburger-btn {
            display: inline-flex;
          }
        }
      `}</style>
    </>
  );
}
