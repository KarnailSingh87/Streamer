// tests/prefs.test.mjs — persisted viewer preferences.
//
// Run with: npm test
//
// Same shape as the other suites: plain .mjs importing the TypeScript module
// directly (Node strips the types), no framework, no build step.
//
// prefs.ts reaches for `localStorage` and `window`, so a minimal stand-in is
// installed before the module is imported — `readPrefs` is only ever called
// through that. Both spellings are defined because a real browser exposes one
// store two ways, and the player uses both.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const store = new Map();
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};
globalThis.localStorage = localStorage;
globalThis.window = { localStorage };

const { DEFAULT_PREFS, readPrefs, writePrefs, RATES } = await import(
  '../src/lib/player/prefs.ts'
);

const KEY = 'streamer.player.prefs.v2';
const write = (patch) =>
  store.set(KEY, JSON.stringify({ ...DEFAULT_PREFS, ...patch }));

describe('defaults', () => {
  beforeEach(() => store.clear());

  it('falls back to defaults when nothing is stored', () => {
    assert.deepEqual(readPrefs(), DEFAULT_PREFS);
  });

  it('never hands out the shared DEFAULT_PREFS object', () => {
    // A caller that mutated the returned record would silently reconfigure every
    // later reader of the defaults, including the next mount of the player.
    const first = readPrefs();
    first.volume = 0.25;
    assert.equal(DEFAULT_PREFS.volume, 1);
    assert.equal(readPrefs().volume, 1);
  });
});

describe('mute is remembered', () => {
  beforeEach(() => store.clear());

  it('restores a muted player instead of unmuting it', () => {
    write({ muted: true, volume: 0.6 });
    const prefs = readPrefs();
    assert.equal(prefs.muted, true);
    assert.equal(prefs.volume, 0.6);
  });

  it('restores an unmuted player as unmuted', () => {
    write({ muted: false, volume: 0.6 });
    assert.equal(readPrefs().muted, false);
  });

  it('treats a stored level of zero as the mute it came from', () => {
    // Dragging the slider to the bottom writes volume 0 AND muted true; a record
    // where only the level survived must still come back silent, not at full
    // volume.
    write({ muted: false, volume: 0 });
    const prefs = readPrefs();
    assert.equal(prefs.volume, 0);
    assert.equal(prefs.muted, true);
  });

  it('round-trips a write through a read', () => {
    writePrefs({ ...DEFAULT_PREFS, muted: true, volume: 0.35, rate: 1.5 });
    const prefs = readPrefs();
    assert.equal(prefs.muted, true);
    assert.equal(prefs.volume, 0.35);
    assert.equal(prefs.rate, 1.5);
  });
});

describe('repairs hostile values', () => {
  beforeEach(() => store.clear());

  it('rejects a rate that is not on the ladder', () => {
    write({ rate: 7.3 });
    assert.equal(readPrefs().rate, 1);
    assert.ok(RATES.includes(readPrefs().rate));
  });

  it('clamps volume, brightness and zoom into range', () => {
    write({ volume: 12, brightness: 99, zoom: -4 });
    const prefs = readPrefs();
    assert.equal(prefs.volume, 1);
    assert.equal(prefs.brightness, 1.8);
    assert.equal(prefs.zoom, 1);
  });

  it('falls back to defaults for unparseable storage', () => {
    store.set(KEY, '{not json');
    assert.deepEqual(readPrefs(), DEFAULT_PREFS);
  });

  it('rejects unknown subtitle style values', () => {
    write({ subtitleSize: 'gigantic', subtitleBackdrop: 'rainbow' });
    const prefs = readPrefs();
    assert.equal(prefs.subtitleSize, 'medium');
    assert.equal(prefs.subtitleBackdrop, 'shadow');
  });
});
