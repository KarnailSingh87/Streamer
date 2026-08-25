// Same-origin image proxy for TMDB stills.
//
// WHY: the FeaturedGallery is a WebGL canvas (three.js). WebGL textures must be
// loaded with `crossOrigin="anonymous"`, and TMDB's image CDN (image.tmdb.org)
// sends NO `Access-Control-Allow-Origin` header — so every texture load was
// blocked by CORS, threw ("Could not load …"), and tore down the whole gallery
// island (the section vanished). Plain <img> tags don't need CORS, which is why
// the CinematicGallery below it kept working.
//
// Serving the same stills from our own origin removes the cross-origin question
// entirely (and we still send ACAO:* for good measure). Locked to TMDB image
// paths so this can't be used as an open proxy / SSRF vector.
import type { APIRoute } from 'astro';

export const prerender = false;

const TMDB_IMG = 'https://image.tmdb.org';
// e.g. /t/p/w780/abc123.jpg  ·  /t/p/original/abc.png
const PATH_RE = /^\/t\/p\/(w\d{2,4}|original)\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i;

export const GET: APIRoute = async ({ request }) => {
  const path = new URL(request.url).searchParams.get('path') || '';
  if (!PATH_RE.test(path)) {
    return new Response('Invalid image path', { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(TMDB_IMG + path, { headers: { Accept: 'image/*' } });
  } catch {
    return new Response('Upstream fetch failed', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response('Upstream error', { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'image/jpeg');
  // TMDB stills are content-addressed and immutable; cache hard at edge + browser.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(upstream.body, { status: 200, headers });
};
