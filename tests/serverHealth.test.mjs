// tests/serverHealth.test.mjs — the health pass: parallel, bounded, cached.
//
// Run with: npm test
//
// The module is client-side code, but it is written to be environment-agnostic
// (it feature-detects `window` and `sessionStorage`), so it runs here against a
// stubbed `fetch` with no DOM at all. What is under test is the behaviour the
// product requirements are actually about: every check runs in parallel, the pass
// cannot outlive its budget, slow requests are aborted, results are cached for
// 30–60s, transient failures are retried, and nothing ever throws.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  HEALTH_TTL_MS,
  KNOWN_SERVERS,
  SELECTION_BUDGET_MS,
  checkServerHealth,
  clearHealthCache,
  healthKey,
  readCachedHealth,
  resolveServerHealth,
  unprobedServers,
} from '../src/lib/player/serverHealth.ts';

const MOVIE = { type: 'movie', id: 550 };

/** Replace global fetch, recording every call. Returns a restore handle. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  let inFlight = 0;
  let peakInFlight = 0;
  globalThis.fetch = (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    return Promise.resolve()
      .then(() => handler(url, init))
      .finally(() => {
        inFlight -= 1;
      });
  };
  return {
    calls,
    get peakInFlight() {
      return peakInFlight;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** A promise that resolves after `ms`, or rejects the moment it is aborted. */
function after(ms, value, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value()), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function edgeResponse(overrides = {}) {
  const servers = KNOWN_SERVERS.map((s) => ({
    ...s,
    verified: s.confidence === 'title',
    online: true,
    latencyMs: 120,
    maxHeight: null,
    bitrateKbps: null,
    qualityLabel: null,
    pending: false,
    ...overrides,
  }));
  return new Response(JSON.stringify({ servers, count: servers.length }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const isEdge = (url) => url.includes('/api/embed/servers');

beforeEach(() => {
  clearHealthCache();
});

describe('healthKey', () => {
  it('separates movies, episodes and seasons', () => {
    assert.equal(healthKey({ type: 'movie', id: 550 }), 'movie:550');
    assert.equal(healthKey({ type: 'tv', id: 1, season: 2, episode: 3 }), 'tv:1:2:3');
    assert.notEqual(
      healthKey({ type: 'tv', id: 1, season: 2, episode: 3 }),
      healthKey({ type: 'tv', id: 1, season: 2, episode: 4 })
    );
  });

  it('defaults a missing season/episode rather than producing a broken key', () => {
    assert.equal(healthKey({ type: 'tv', id: 9 }), 'tv:9:1:1');
  });
});

describe('unprobedServers', () => {
  it('offers every known server, marked as unchecked rather than failed', () => {
    const list = unprobedServers();
    assert.equal(list.length, KNOWN_SERVERS.length);
    assert.ok(list.length > 0, 'the picker is never empty');
    for (const server of list) {
      assert.equal(server.pending, true);
      assert.equal(server.online, false);
      assert.equal(server.reachable, null);
    }
  });
});

describe('checkServerHealth — parallelism', () => {
  it('starts the edge probe and every reachability probe in the same tick', async () => {
    const stub = stubFetch((url, init) => after(40, () => (isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })), init.signal));
    try {
      await checkServerHealth(MOVIE);
      // 1 edge request + one per provider, all overlapping. Sequential code
      // could never reach a peak above 1.
      assert.equal(stub.calls.length, KNOWN_SERVERS.length + 1);
      assert.equal(stub.peakInFlight, KNOWN_SERVERS.length + 1);
    } finally {
      stub.restore();
    }
  });

  it('probes each provider origin exactly once, with no path or query attached', async () => {
    const stub = stubFetch((url) => Promise.resolve(isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })));
    try {
      await checkServerHealth(MOVIE);
      const origins = stub.calls.filter((url) => !isEdge(url));
      assert.equal(origins.length, KNOWN_SERVERS.length);
      for (const url of origins) {
        const parsed = new URL(url);
        assert.equal(parsed.search, '', 'no query string is ever sent to a provider');
        assert.equal(parsed.pathname, '/', 'origin only — never a player URL');
      }
    } finally {
      stub.restore();
    }
  });

  it('sends the reachability probe as an opaque HEAD that cannot leak a referrer', async () => {
    const seen = [];
    const stub = stubFetch((url, init) => {
      if (!isEdge(url)) seen.push(init);
      return Promise.resolve(isEdge(url) ? edgeResponse() : new Response(null, { status: 200 }));
    });
    try {
      await checkServerHealth(MOVIE);
      assert.equal(seen.length, KNOWN_SERVERS.length);
      for (const init of seen) {
        assert.equal(init.method, 'HEAD');
        assert.equal(init.mode, 'no-cors');
        assert.equal(init.cache, 'no-store');
        assert.equal(init.referrerPolicy, 'no-referrer');
        assert.ok(init.signal, 'every probe is abortable');
      }
    } finally {
      stub.restore();
    }
  });
});

describe('checkServerHealth — the budget', () => {
  it('is declared under one second', () => {
    assert.ok(SELECTION_BUDGET_MS < 1000, `${SELECTION_BUDGET_MS}ms must be < 1000ms`);
  });

  it('answers within its budget even when nothing ever responds', async () => {
    const stub = stubFetch((_url, init) => after(60_000, () => new Response(null), init.signal));
    try {
      const startedAt = Date.now();
      const result = await checkServerHealth(MOVIE, { budgetMs: 300 });
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 900, `pass took ${elapsed}ms, budget was 300ms`);
      assert.equal(result.servers.length, KNOWN_SERVERS.length, 'still offers every server');
      assert.equal(result.degraded, true);
      for (const server of result.servers) {
        assert.equal(server.pending, true, 'unanswered is reported as pending, not failed');
      }
    } finally {
      stub.restore();
    }
  });

  it('aborts a slow provider probe instead of waiting on it', async () => {
    let aborted = 0;
    const stub = stubFetch((url, init) => {
      if (isEdge(url)) return Promise.resolve(edgeResponse());
      init.signal?.addEventListener('abort', () => {
        aborted += 1;
      });
      return after(60_000, () => new Response(null), init.signal);
    });
    try {
      await checkServerHealth(MOVIE, { budgetMs: 250 });
      // The pass returned on its deadline; the hung probes are torn down by
      // their own timeouts rather than being left to leak.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(aborted, KNOWN_SERVERS.length);
    } finally {
      stub.restore();
    }
  });

  it('never rejects, whatever the network does', async () => {
    const stub = stubFetch(() => Promise.reject(new Error('offline')));
    try {
      const result = await checkServerHealth(MOVIE, { budgetMs: 300 });
      assert.equal(result.servers.length, KNOWN_SERVERS.length);
      assert.equal(result.degraded, true);
    } finally {
      stub.restore();
    }
  });
});

describe('checkServerHealth — evidence', () => {
  it('merges the edge verdict with the client-side reachability result', async () => {
    const stub = stubFetch((url) => {
      if (isEdge(url)) return Promise.resolve(edgeResponse());
      // One provider is blocked for this viewer (ad blocker / DNS filter).
      if (url.includes('vidfast')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    try {
      const result = await checkServerHealth(MOVIE);
      const byId = new Map(result.servers.map((s) => [s.id, s]));
      assert.equal(byId.get('vidfast').reachable, false, 'blocked here');
      assert.equal(byId.get('vidfast').online, true, 'but the edge still reached it');
      assert.equal(byId.get('vidlink').reachable, true);
      assert.equal(typeof byId.get('vidlink').clientLatencyMs, 'number');
      assert.equal(result.degraded, false);
    } finally {
      stub.restore();
    }
  });

  it('retries a refused HEAD as a GET before disqualifying a provider', async () => {
    // Some hosts drop HEAD at the connection level. Concluding "unreachable"
    // from that alone would disqualify a provider that streams perfectly.
    const methods = [];
    const stub = stubFetch((url, init) => {
      if (isEdge(url)) return Promise.resolve(edgeResponse());
      if (url.includes('vidlink')) {
        methods.push(init.method);
        if (init.method === 'HEAD') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    try {
      const result = await checkServerHealth(MOVIE);
      const vidlink = result.servers.find((s) => s.id === 'vidlink');
      assert.deepEqual(methods, ['HEAD', 'GET']);
      assert.equal(vidlink.reachable, true, 'the GET proved the host is reachable');
    } finally {
      stub.restore();
    }
  });

  it('offers a provider the edge response omitted', async () => {
    const stub = stubFetch((url) => {
      if (!isEdge(url)) return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(
        new Response(JSON.stringify({ servers: [{ id: 'vidlink', name: 'VidLink', label: 'Server 2', online: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    });
    try {
      const result = await checkServerHealth(MOVIE);
      assert.equal(result.servers.length, KNOWN_SERVERS.length);
      const missing = result.servers.find((s) => s.id === 'nexstream');
      assert.equal(missing.pending, true, 'unmentioned means unchecked');
    } finally {
      stub.restore();
    }
  });

  it('retries the edge probe once on a transient failure', async () => {
    let edgeCalls = 0;
    const stub = stubFetch((url) => {
      if (!isEdge(url)) return Promise.resolve(new Response(null, { status: 200 }));
      edgeCalls += 1;
      if (edgeCalls === 1) return Promise.reject(new Error('connection reset'));
      return Promise.resolve(edgeResponse());
    });
    try {
      const result = await checkServerHealth(MOVIE);
      assert.equal(edgeCalls, 2, 'exactly one retry, not an infinite walk');
      assert.equal(result.degraded, false, 'the retry recovered the pass');
    } finally {
      stub.restore();
    }
  });

  it('does not retry its own timeout', async () => {
    // A retry could only answer after the selection budget had expired, so it
    // would cost a round-trip for an answer nobody is waiting for.
    let edgeCalls = 0;
    const stub = stubFetch((url, init) => {
      if (!isEdge(url)) return Promise.resolve(new Response(null, { status: 200 }));
      edgeCalls += 1;
      return after(60_000, () => edgeResponse(), init.signal);
    });
    try {
      await checkServerHealth(MOVIE, { budgetMs: 300 });
      await new Promise((resolve) => setTimeout(resolve, 1200)); // past the gate
      assert.equal(edgeCalls, 1, 'the timed-out probe is not repeated');
    } finally {
      stub.restore();
    }
  });

  it('asks the edge to answer on the same clock the client is using', async () => {
    const stub = stubFetch((url) => Promise.resolve(isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })));
    try {
      await checkServerHealth(MOVIE);
      const edge = new URL(stub.calls.find(isEdge), 'https://example.test');
      const budget = Number(edge.searchParams.get('budget'));
      assert.ok(budget > 0 && budget < SELECTION_BUDGET_MS, `edge budget ${budget} must fit inside the pass`);
      assert.equal(edge.searchParams.get('type'), 'movie');
      assert.equal(edge.searchParams.get('id'), '550');
    } finally {
      stub.restore();
    }
  });

  it('sends season and episode for a tv target', async () => {
    const stub = stubFetch((url) => Promise.resolve(isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })));
    try {
      await checkServerHealth({ type: 'tv', id: 1396, season: 5, episode: 14 });
      const edge = new URL(stub.calls.find(isEdge), 'https://example.test');
      assert.equal(edge.searchParams.get('season'), '5');
      assert.equal(edge.searchParams.get('episode'), '14');
    } finally {
      stub.restore();
    }
  });
});

describe('caching', () => {
  it('keeps a result for 30–60 seconds', () => {
    assert.ok(HEALTH_TTL_MS >= 30_000 && HEALTH_TTL_MS <= 60_000, `${HEALTH_TTL_MS}ms out of range`);
  });

  it('serves a repeat request from cache with no network at all', async () => {
    const stub = stubFetch((url) => Promise.resolve(isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })));
    try {
      await checkServerHealth(MOVIE);
      const afterFirst = stub.calls.length;
      const second = await resolveServerHealth(MOVIE);
      assert.equal(stub.calls.length, afterFirst, 'no new requests');
      assert.equal(second.fromCache, true);
      assert.equal(second.servers.length, KNOWN_SERVERS.length);
    } finally {
      stub.restore();
    }
  });

  it('shares one pass between callers that ask at the same moment', async () => {
    // React mounts effects twice in development, and a prefetch can race the
    // real selection. Both must cost one pass, not two.
    const stub = stubFetch((url, init) =>
      after(50, () => (isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })), init.signal)
    );
    try {
      const [a, b] = await Promise.all([resolveServerHealth(MOVIE), resolveServerHealth(MOVIE)]);
      assert.equal(stub.calls.filter(isEdge).length, 1, 'one edge probe for two callers');
      assert.equal(stub.calls.length, KNOWN_SERVERS.length + 1);
      assert.deepEqual(a.servers.map((s) => s.id), b.servers.map((s) => s.id));
    } finally {
      stub.restore();
    }
  });

  it('caches per title, so another title still runs its own pass', async () => {
    const stub = stubFetch((url) => Promise.resolve(isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })));
    try {
      await checkServerHealth(MOVIE);
      const afterFirst = stub.calls.length;
      await resolveServerHealth({ type: 'movie', id: 999 });
      assert.ok(stub.calls.length > afterFirst, 'a different title is checked');
    } finally {
      stub.restore();
    }
  });

  it('does not cache a pass that learned nothing', async () => {
    const stub = stubFetch(() => Promise.reject(new Error('offline')));
    try {
      const result = await checkServerHealth(MOVIE, { budgetMs: 250 });
      assert.equal(result.degraded, true);
      assert.equal(readCachedHealth(MOVIE), null, 'a degraded pass must not pin the player');
    } finally {
      stub.restore();
    }
  });

  it('reports a cached entry as fresh, and forgets it when cleared', async () => {
    const stub = stubFetch((url) => Promise.resolve(isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })));
    try {
      await checkServerHealth(MOVIE);
      const hit = readCachedHealth(MOVIE);
      assert.ok(hit);
      assert.equal(hit.fresh, true);
      clearHealthCache();
      assert.equal(readCachedHealth(MOVIE), null);
    } finally {
      stub.restore();
    }
  });

  it('measures how long the pass took', async () => {
    const stub = stubFetch((url, init) => after(30, () => (isEdge(url) ? edgeResponse() : new Response(null, { status: 200 })), init.signal));
    try {
      const result = await checkServerHealth(MOVIE);
      assert.ok(result.elapsedMs >= 0);
      assert.ok(result.elapsedMs < SELECTION_BUDGET_MS);
      assert.equal(result.fromCache, false);
      assert.ok(result.checkedAt > 0);
    } finally {
      stub.restore();
    }
  });
});
