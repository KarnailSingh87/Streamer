// src/pages/api/embed/servers.ts — how does each server look for this title?
//
// The player islands render EVERY server returned here, in the order given, and
// any of them can be selected. Probe results come back as flags (`online`,
// `verified`) instead of as a filter: a probe runs from a datacenter IP that
// these providers throttle, so a failed probe is not proof the stream is dead in
// the viewer's browser. Confirmed servers simply sort first.
//
//   GET /api/embed/servers?type=movie&id=550
//   GET /api/embed/servers?type=tv&id=2734&season=1&episode=1
//
// -> { servers: [{ id, name, label, verified, online, confidence }], count }
import type { APIRoute } from 'astro';
import {
  DEFAULT_PROBE_DEADLINE_MS,
  EMBED_SERVER_META,
  getAvailableServers,
  type EmbedTarget,
} from '../../../lib/embed';
import { qualityFor, qualityLabel } from '../../../lib/player/serverRanking';

export const prerender = false;

const isDigits = (v: string | null): v is string => !!v && /^\d+$/.test(v);

/** Unprobed server list, used when the probe pass itself blows up. Carries the
 *  same shape as a probed entry (including the quality fields) so the client
 *  ranking never has to special-case it. */
const UNPROBED = EMBED_SERVER_META.map((m) => ({
  id: m.id,
  name: m.name,
  label: m.label,
  confidence: m.confidence,
  online: false,
  verified: false,
  latencyMs: null,
  maxHeight: qualityFor(m.id).maxHeight,
  bitrateKbps: qualityFor(m.id).bitrateKbps,
  qualityLabel: qualityLabel(m.id),
  // "Not checked", not "checked and failed" — the client scores the two
  // differently, and a wholesale probe failure is the former.
  pending: true,
}));

export const GET: APIRoute = async ({ url }) => {
  const type = url.searchParams.get('type');
  const id = url.searchParams.get('id');

  if (!isDigits(id) || (type !== 'movie' && type !== 'tv')) {
    return Response.json(
      { error: 'Invalid type/id', servers: UNPROBED, count: UNPROBED.length },
      { status: 400 }
    );
  }

  let target: EmbedTarget;
  if (type === 'movie') {
    target = { kind: 'movie', id };
  } else {
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');
    if (!isDigits(season) || !isDigits(episode)) {
      return Response.json(
        {
          error: 'season and episode are required for type=tv',
          servers: UNPROBED,
          count: UNPROBED.length,
        },
        { status: 400 }
      );
    }
    target = { kind: 'tv', id, season, episode };
  }

  try {
    // The client hands us its own budget so the endpoint answers on the same
    // clock the player is selecting against. Clamped in getAvailableServers.
    const requestedBudget = Number(url.searchParams.get('budget'));
    const servers = await getAvailableServers(target, {
      deadlineMs: Number.isFinite(requestedBudget) && requestedBudget > 0
        ? requestedBudget
        : DEFAULT_PROBE_DEADLINE_MS,
    });
    return Response.json(
      { servers, count: servers.length, checkedAt: Date.now() },
      {
        headers: {
          // 45s matches the client-side health TTL (see player/serverHealth.ts):
          // both layers expire together, so a viewer never scores a cached list
          // the client already considers stale. `stale-while-revalidate` lets the
          // edge serve instantly and refresh behind the request, which is the
          // same trick the client cache uses.
          'Cache-Control': 'public, max-age=45, s-maxage=45, stale-while-revalidate=120',
        },
      }
    );
  } catch {
    // Probing failed wholesale (network, config). Still hand back the server
    // list so the viewer keeps every button — just without confirmation marks.
    return Response.json(
      { servers: UNPROBED, count: UNPROBED.length, probed: false },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
};
