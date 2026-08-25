// tests/serverRanking.test.mjs — the automatic pick, verified.
//
// Run with: npm test
//
// Written in .mjs and importing the TypeScript module directly (Node strips the
// types) so the suite needs no build step, no test framework dependency and no
// tsconfig changes. serverRanking.ts is deliberately dependency-free, which is
// what makes this possible.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SCORE_WEIGHTS,
  bestServerId,
  explainScore,
  failureRate,
  preferenceRank,
  rankServers,
  scoreServer,
  viableServers,
} from '../src/lib/player/serverRanking.ts';

/** A server with no evidence either way. */
function base(id, over = {}) {
  return {
    id,
    verified: false,
    online: false,
    live: false,
    latencyMs: null,
    maxHeight: null,
    bitrateKbps: null,
    pending: false,
    reachable: null,
    clientLatencyMs: null,
    startupMs: null,
    ...over,
  };
}

describe('SCORE_WEIGHTS', () => {
  it('sums to 100 so a score reads as a percentage', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
  });

  it('gives playback success the highest weight of any signal', () => {
    const others = Object.entries(SCORE_WEIGHTS)
      .filter(([key]) => key !== 'playback')
      .map(([, value]) => value);
    assert.ok(SCORE_WEIGHTS.playback > Math.max(...others));
  });

  it('orders the remaining weights by the product priority', () => {
    assert.ok(SCORE_WEIGHTS.quality > SCORE_WEIGHTS.latency);
    assert.ok(SCORE_WEIGHTS.latency > SCORE_WEIGHTS.buffering);
    assert.ok(SCORE_WEIGHTS.buffering >= SCORE_WEIGHTS.reliability);
    assert.ok(SCORE_WEIGHTS.reliability > SCORE_WEIGHTS.uptime);
  });
});

describe('scoreServer — playback success', () => {
  it('ranks confirmed-live above title-verified above online above unchecked', () => {
    const live = scoreServer(base('vidlink', { live: true, online: true, verified: true }));
    const verified = scoreServer(base('vidlink', { verified: true, online: true }));
    const online = scoreServer(base('vidlink', { online: true }));
    const pending = scoreServer(base('vidlink', { pending: true }));
    const refused = scoreServer(base('vidlink'));

    assert.ok(live.total > verified.total, 'live > verified');
    assert.ok(verified.total > online.total, 'verified > online');
    assert.ok(online.total > pending.total, 'online > pending');
    assert.ok(pending.total > refused.total, 'pending > refused');
  });

  it('treats a probe that never answered as weaker than one that answered "no"', () => {
    // This is the whole reason `pending` exists: an unanswered probe under a
    // sub-second deadline must not be recorded as a provider failure.
    const pending = scoreServer(base('vidlink', { pending: true }));
    const refused = scoreServer(base('vidlink', { pending: false }));
    assert.ok(pending.breakdown.playback > refused.breakdown.playback);
  });
});

describe('scoreServer — quality', () => {
  it('prefers 4K over 1080p over 720p over 480p', () => {
    const at = (h) => scoreServer(base('vidlink', { maxHeight: h })).breakdown.quality;
    assert.ok(at(2160) > at(1440));
    assert.ok(at(1440) > at(1080));
    assert.ok(at(1080) > at(720));
    assert.ok(at(720) > at(480));
  });

  it('scores an unknown resolution neutrally rather than as zero', () => {
    const unknown = scoreServer(base('vidlink')).breakdown.quality;
    const sd = scoreServer(base('vidlink', { maxHeight: 480 })).breakdown.quality;
    const hd = scoreServer(base('vidlink', { maxHeight: 1080 })).breakdown.quality;
    assert.ok(unknown > sd, 'unknown must not be punished like SD');
    assert.ok(unknown < hd, 'unknown must not be rewarded like HD');
  });

  it('lets a 4K server beat a faster 480p server', () => {
    const list = [
      base('vidlink', { online: true, maxHeight: 480, latencyMs: 30 }),
      base('videasy', { online: true, maxHeight: 2160, latencyMs: 900 }),
    ];
    assert.equal(bestServerId(list), 'videasy');
  });
});

describe('scoreServer — response time and buffering', () => {
  it('prefers the lower latency when nothing else separates two servers', () => {
    const list = [
      base('vidlink', { online: true, latencyMs: 1500 }),
      base('vidfast', { online: true, latencyMs: 40 }),
    ];
    assert.equal(bestServerId(list), 'vidfast');
  });

  it('trusts the client-measured round-trip over the edge probe', () => {
    // Same edge latency, very different from the viewer's own network.
    const list = [
      base('vidlink', { online: true, latencyMs: 100, clientLatencyMs: 1900 }),
      base('vidfast', { online: true, latencyMs: 100, clientLatencyMs: 60 }),
    ];
    assert.equal(bestServerId(list), 'vidfast');
  });

  it('prefers the server that started playing faster last time', () => {
    const health = {
      vidlink: { successes: 3, failures: 0, lastFailureAt: null, startupMs: 5200, updatedAt: Date.now() },
      vidfast: { successes: 3, failures: 0, lastFailureAt: null, startupMs: 500, updatedAt: Date.now() },
    };
    const list = [base('vidlink', { online: true }), base('vidfast', { online: true })];
    assert.equal(bestServerId(list, { health }), 'vidfast');
  });
});

describe('scoreServer — reliability and uptime', () => {
  it('demotes a curated-favourite that keeps failing in this browser', () => {
    const now = Date.now();
    const health = {
      // vidsrcin is preference rank 0, so it wins on a cold start…
      vidsrcin: { successes: 0, failures: 8, lastFailureAt: now - 60_000, startupMs: null, updatedAt: now },
      nexstream: { successes: 6, failures: 0, lastFailureAt: null, startupMs: null, updatedAt: now },
    };
    const list = [base('vidsrcin', { online: true }), base('nexstream', { online: true })];
    assert.equal(bestServerId(list), 'vidsrcin', 'cold start favours the curated order');
    assert.equal(bestServerId(list, { health }), 'nexstream', '…real outcomes override it');
  });

  it('counts a very recent failure against a server even on another title', () => {
    const now = Date.now();
    const fresh = { successes: 1, failures: 1, lastFailureAt: now, startupMs: null, updatedAt: now };
    const old = { successes: 1, failures: 1, lastFailureAt: now - 10 * 60_000, startupMs: null, updatedAt: now };
    const a = scoreServer(base('vidlink', { online: true }), { health: { vidlink: fresh }, now });
    const b = scoreServer(base('vidlink', { online: true }), { health: { vidlink: old }, now });
    assert.ok(b.total > a.total);
    assert.equal(a.breakdown.uptime, 0);
    assert.equal(b.breakdown.uptime, 1);
  });

  it('reports failure rate honestly for an unknown server', () => {
    assert.equal(failureRate(undefined), 0);
    assert.equal(failureRate({ successes: 1, failures: 1 }), 0.5);
  });
});

describe('disqualification', () => {
  it('never auto-selects a server that already failed for this title', () => {
    const list = [base('vidsrcin', { online: true }), base('vidlink', { online: true })];
    const tried = new Set(['vidsrcin']);
    assert.equal(bestServerId(list, { tried }), 'vidlink');
  });

  it('never auto-selects a provider this network cannot reach', () => {
    const list = [
      // Would win on every other signal.
      base('vidsrcin', { online: true, verified: true, live: true, reachable: false }),
      base('vidlink', { online: true, reachable: true }),
    ];
    assert.equal(bestServerId(list), 'vidlink');
  });

  it('returns null once every server is exhausted, so the UI can ask the viewer', () => {
    const list = [base('vidsrcin', { online: true }), base('vidlink', { online: true })];
    const tried = new Set(['vidsrcin', 'vidlink']);
    assert.equal(bestServerId(list, { tried }), null);
    assert.deepEqual(viableServers(list, { tried }), []);
  });

  it('still lists a disqualified server so it can be forced by hand', () => {
    const list = [base('vidsrcin', { online: true }), base('vidlink', { online: true })];
    const ranked = rankServers(list, { tried: new Set(['vidsrcin']) });
    assert.equal(ranked.length, 2, 'nothing is filtered out of the picker');
    assert.equal(ranked.at(-1).server.id, 'vidsrcin', 'it just goes last');
    assert.equal(ranked.at(-1).reason, 'failing');
  });

  it('labels an unreachable provider as blocked, not as failing', () => {
    const ranked = rankServers([base('vidlink', { online: true, reachable: false })]);
    assert.equal(ranked[0].reason, 'blocked');
  });
});

describe('failover order', () => {
  it('walks the list best-first and terminates', () => {
    const list = [
      base('vidsrcin', { online: true }),
      base('vidlink', { online: true }),
      base('vidfast', { online: true }),
    ];
    const tried = new Set();
    const walked = [];
    for (let i = 0; i < 10; i += 1) {
      const next = bestServerId(list, { tried });
      if (!next) break;
      walked.push(next);
      tried.add(next);
    }
    assert.equal(walked.length, 3, 'every server is offered exactly once');
    assert.equal(new Set(walked).size, 3, 'no server is offered twice');
    // Curated order decides when nothing else separates them.
    assert.deepEqual(
      walked,
      [...walked].sort((a, b) => preferenceRank(a) - preferenceRank(b))
    );
  });
});

describe('stability', () => {
  it('is deterministic and does not reshuffle equal servers between calls', () => {
    const list = [
      base('nexstream', { online: true }),
      base('videasy', { online: true }),
      base('vidfast', { online: true }),
    ];
    const first = rankServers(list).map((r) => r.server.id);
    const second = rankServers(list).map((r) => r.server.id);
    assert.deepEqual(first, second);
  });

  it('assigns ranks and scores in descending order', () => {
    const ranked = rankServers([
      base('nexstream', { online: true }),
      base('vidlink', { live: true, online: true, verified: true }),
    ]);
    assert.deepEqual(ranked.map((r) => r.rank), [0, 1]);
    assert.ok(ranked[0].score > ranked[1].score);
    assert.equal(ranked[0].server.id, 'vidlink');
  });

  it('explains a score in terms of its weighted parts', () => {
    const text = explainScore(scoreServer(base('vidlink', { live: true, online: true })));
    assert.match(text, /^vidlink = /);
    for (const key of Object.keys(SCORE_WEIGHTS)) assert.match(text, new RegExp(key));
  });
});
