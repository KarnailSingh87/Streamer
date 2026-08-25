# Streamer 🎬

A modern, high-performance streaming discovery and tracking platform built with **Astro 5**, **React 19**, **Tailwind CSS v4**, and **Cloudflare Workers**.

---

## ✨ Features

- ⚡ **Ultra-fast SSR & Edge Delivery** powered by Astro and Cloudflare Workers
- 🎥 **Comprehensive Movie & Series Catalog** integrated with TMDB API
- 🔍 **Instant Search & Filters** by genre, platform (Netflix, Prime Video, Apple TV+, Hotstar), ratings, and year
- 🤖 **AI-Powered Mood Recommendation** for mood-based discovery
- 📱 **Responsive Cinematic UI** with smooth micro-interactions, dark mode, and mobile tab navigation
- 🍿 **Continue Watching & Watchlist** client/server synchronized tracking
- 🛡️ **Built-in Resilience**: multi-provider fallback, concurrency gating, and smart caching

---

## 🚀 Getting Started

### Prerequisites
- Node.js `>= 22.12.0`
- npm

### Installation

```bash
# Clone the repository
git clone https://github.com/KarnailSingh87/streamer.git
cd streamer

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
```

### Development

```bash
npm run dev
```

The app will be available at `http://localhost:4321`.

### Build & Production

```bash
# Build production bundle
npm run build

# Deploy to Cloudflare Workers
npm run deploy
```

---

## 🛠️ Tech Stack

- **Framework**: [Astro 5](https://astro.build/)
- **UI & Islands**: [React 19](https://react.dev/), [Framer Motion / Motion](https://motion.dev/), [Lucide Icons](https://lucide.dev/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Deployment**: [Cloudflare Workers](https://workers.cloudflare.com/) / [Vercel](https://vercel.com/)
- **Database**: Cloudflare D1 / Turso (libSQL)
- **API**: TMDB (The Movie Database)

---

## 📄 License

MIT License.
