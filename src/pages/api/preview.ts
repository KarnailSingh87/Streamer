// src/pages/api/preview.ts — Serves complete metadata for the NetMirror / Netflix modal
import type { APIRoute } from 'astro';
import { getMovieFull, getSeriesFull, getSeasonDetails, tmdbImage } from '../../lib/tmdb';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const idStr = url.searchParams.get('id');
  const type = url.searchParams.get('type') || 'movie';

  if (!idStr || !/^\d+$/.test(idStr)) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const id = Number(idStr);

  try {
    if (type === 'tv') {
      const data = await getSeriesFull(id);
      const series = data.series;
      const credits = data.credits;
      const recommendations = data.recommendations?.results || [];

      // Fetch first season episodes
      const validSeasons = (series.seasons || []).filter((s) => s.season_number > 0);
      const firstSeasonNum = validSeasons[0]?.season_number || 1;
      let episodes: Array<{
        episode_number: number;
        name: string;
        overview: string;
        still_path: string | null;
        runtime: string;
      }> = [];

      try {
        const seasonData = await getSeasonDetails(id, firstSeasonNum);
        episodes = (seasonData.episodes || []).map((ep) => ({
          episode_number: ep.episode_number,
          name: ep.name || `Episode ${ep.episode_number}`,
          overview: ep.overview || '',
          still_path: ep.still_path ? tmdbImage(ep.still_path, 'w342') : null,
          runtime: ep.runtime ? `${ep.runtime}m` : '35m',
        }));
      } catch {
        // Fallback episodes placeholder if season fetch fails
        episodes = Array.from({ length: Math.min(validSeasons[0]?.episode_count || 8, 8) }).map((_, i) => ({
          episode_number: i + 1,
          name: `Episode ${i + 1}`,
          overview: series.overview || '',
          still_path: null,
          runtime: '42m',
        }));
      }

      const vote = series.vote_average || 7.2;
      const matchScore = Math.min(99, Math.max(68, Math.round(vote * 10 + 14)));

      const responsePayload = {
        id: series.id,
        mediaType: 'tv',
        title: series.name,
        overview: series.overview,
        backdropUrl: tmdbImage(series.backdrop_path, 'w780') || tmdbImage(series.poster_path, 'w500'),
        posterUrl: tmdbImage(series.poster_path, 'w500'),
        year: series.first_air_date ? series.first_air_date.slice(0, 4) : '2024',
        seasonsCount: `${series.number_of_seasons || 1} Season${(series.number_of_seasons || 1) > 1 ? 's' : ''}`,
        rating: vote ? Math.round(vote * 10) / 10 : null,
        match: `${matchScore}% match`,
        ageRating: vote >= 7.8 ? 'U/A 16+' : 'U/A 13+',
        quality: 'HD',
        descriptors: 'sexual content, substances, language',
        genres: (series.genres || []).map((g) => g.name),
        cast: (credits.cast || []).slice(0, 7).map((c) => c.name),
        languages: (series.spoken_languages || []).map((l) => l.english_name || l.name).filter(Boolean),
        thisShowIs: [
          series.genres?.[0]?.name,
          'Sentimental',
          'Understated',
          'Drama',
          'Intimate',
          'TV',
        ].filter(Boolean),
        seasons: validSeasons.map((s) => ({
          season_number: s.season_number,
          name: s.name,
          episode_count: s.episode_count,
        })),
        currentSeason: firstSeasonNum,
        episodes,
        recommendations: recommendations.slice(0, 9).map((r) => ({
          id: r.id,
          title: r.name || '',
          mediaType: 'tv',
          backdropUrl: tmdbImage(r.backdrop_path, 'w780') || tmdbImage(r.poster_path, 'w500'),
          year: r.first_air_date ? r.first_air_date.slice(0, 4) : '',
          rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
          match: `${Math.min(98, Math.max(52, Math.round((r.vote_average || 6.5) * 10 + 11)))}% match`,
          ageRating: 'U/A 16+',
          duration: '1 Season',
          overview: r.overview || '',
        })),
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800, s-maxage=3600',
        },
      });
    } else {
      // Movie
      const data = await getMovieFull(id);
      const movie = data.movie;
      const credits = data.credits;
      const recommendations = data.recommendations?.results || [];

      const vote = movie.vote_average || 7.0;
      const matchScore = Math.min(99, Math.max(68, Math.round(vote * 10 + 14)));
      const runtimeFormatted = movie.runtime
        ? `${Math.floor(movie.runtime / 60)}h ${movie.runtime % 60}m`
        : '2h 10m';

      const responsePayload = {
        id: movie.id,
        mediaType: 'movie',
        title: movie.title,
        overview: movie.overview,
        backdropUrl: tmdbImage(movie.backdrop_path, 'w780') || tmdbImage(movie.poster_path, 'w500'),
        posterUrl: tmdbImage(movie.poster_path, 'w500'),
        year: movie.release_date ? movie.release_date.slice(0, 4) : '2024',
        runtime: runtimeFormatted,
        rating: vote ? Math.round(vote * 10) / 10 : null,
        match: `${matchScore}% match`,
        ageRating: movie.adult ? 'A 18+' : (vote >= 7.6 ? 'U/A 16+' : 'U/A 13+'),
        quality: vote >= 7.5 ? '4K Ultra HD' : 'HD',
        descriptors: 'violence, language, substance use',
        genres: (movie.genres || []).map((g) => g.name),
        cast: (credits.cast || []).slice(0, 7).map((c) => c.name),
        languages: (movie.spoken_languages || []).map((l) => l.english_name || l.name).filter(Boolean),
        thisShowIs: [
          movie.genres?.[0]?.name,
          'Exciting',
          'Gritty',
          'Suspenseful',
          'Action',
        ].filter(Boolean),
        seasons: [],
        currentSeason: 1,
        episodes: [],
        recommendations: recommendations.slice(0, 9).map((r) => ({
          id: r.id,
          title: r.title || '',
          mediaType: 'movie',
          backdropUrl: tmdbImage(r.backdrop_path, 'w780') || tmdbImage(r.poster_path, 'w500'),
          year: r.release_date ? r.release_date.slice(0, 4) : '',
          rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
          match: `${Math.min(98, Math.max(52, Math.round((r.vote_average || 6.5) * 10 + 11)))}% match`,
          ageRating: 'U/A 16+',
          duration: '1h 55m',
          overview: r.overview || '',
        })),
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800, s-maxage=3600',
        },
      });
    }
  } catch (err) {
    console.error('[preview-api] Error fetching title preview', { id, type, err });
    return new Response(JSON.stringify({ error: 'Failed to fetch title preview' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
