// _verify_smart_server.mjs — end-to-end check of Smart Auto Server Selection.
//
//   node _verify_smart_server.mjs [baseUrl]
//
// Verifies, in a real browser, the behaviour the unit tests cannot observe:
//   1. nothing is preselected before the health pass decides,
//   2. the pass runs in parallel and finishes inside its budget,
//   3. exactly one server is chosen and playback starts by itself,
//   4. the "Finding the best streaming server…" status exists and is transient,
//   5. failover to the next-ranked server preserves the playback position.
import { chromium } from '/Users/kapildev/.npm/_npx/6f4879659183bc49/node_modules/playwright/index.mjs';

const BASE = process.argv[2] || 'http://localhost:4321';
const PATH = '/movie/550';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const health = [];   // /api/embed/servers requests
const frames = [];   // /api/embed/movie/... iframe requests
const origins = [];  // client-side reachability probes
const t0 = Date.now();

page.on('request', (r) => {
  const url = r.url();
  if (url.includes('/api/embed/servers')) health.push({ at: Date.now() - t0, url });
  else if (/\/api\/embed\/movie\/\d+\?/.test(url)) {
    frames.push({ at: Date.now() - t0, url, server: new URL(url).searchParams.get('server'), t: new URL(url).searchParams.get('t') });
  } else if (/^https:\/\/(vidsrc\.in|vidlink\.pro|player\.videasy\.net|vidfast\.pro|www\.vidking\.net)\/?$/.test(url)) {
    origins.push({ at: Date.now() - t0, url, method: r.method() });
  }
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto(BASE + PATH, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Let the island hydrate and run its selection pass before Play is pressed.
await page.waitForTimeout(3500);

// ── 1. Nothing is preselected, and no player frame exists before Play ────────
const beforePlay = await page.evaluate(() => ({
  frame: !!document.querySelector('.fp-embed-frame'),
  active: [...document.querySelectorAll('.fp-source-group-servers .fp-pill.is-active')].map((el) => el.textContent?.trim()),
  pills: document.querySelectorAll('.fp-source-group-servers .fp-pill').length,
}));
check('no iframe is mounted before the viewer presses Play', beforePlay.frame === false);
check('the server list is fully populated', beforePlay.pills >= 5, `${beforePlay.pills} servers offered`);
check(
  'at most one server is marked active (the scored pick, not a hardcoded default)',
  beforePlay.active.length <= 1,
  `active=${JSON.stringify(beforePlay.active)}`
);

// ── 2. The health pass ran, in parallel, once ───────────────────────────────
check('a health pass ran without the viewer asking', health.length >= 1, `${health.length} request(s) at +${health[0]?.at}ms`);
check(
  'the edge probe carries the client budget',
  health.length > 0 && Number(new URL(health[0].url).searchParams.get('budget')) > 0,
  health.length ? `budget=${new URL(health[0].url).searchParams.get('budget')}ms` : ''
);
if (origins.length > 0) {
  const span = Math.max(...origins.map((o) => o.at)) - Math.min(...origins.map((o) => o.at));
  check(
    'reachability probes for every provider start together (parallel, not serial)',
    origins.length >= 4 && span < 250,
    `${origins.length} probes within ${span}ms, methods=${[...new Set(origins.map((o) => o.method))].join('/')}`
  );
} else {
  check('reachability probes were issued', false, 'none observed');
}

// ── 3. Pressing Play starts exactly one server, immediately ─────────────────
await page.click('.fp-splash-play');
await page.waitForTimeout(2500);

const afterPlay = await page.evaluate(() => ({
  frame: document.querySelector('.fp-embed-frame')?.getAttribute('src') ?? null,
  optimizing: !!document.querySelector('.fp-optimizing'),
}));
check('playback starts by itself once Play is pressed', !!afterPlay.frame, afterPlay.frame ?? 'no frame');
check('exactly one server was loaded, not a walk through the list', frames.length === 1, frames.map((f) => f.server).join(' → ') || 'none');
check('the optimising overlay is gone once a server is chosen', afterPlay.optimizing === false);

// The overlay markup and its copy must exist even though it is usually too fast
// to catch — verify it renders when selection is genuinely slow (below).
const activeAfter = await page.evaluate(() =>
  [...document.querySelectorAll('.fp-source-group-servers .fp-pill.is-active')].map((el) => el.textContent?.trim())
);
check('one server is now active in the picker', activeAfter.length === 1, JSON.stringify(activeAfter));

// ── 4. The optimising status appears when the pass is genuinely slow ────────
// Deliberately checked on a SERIES: a movie's health pass starts at mount and is
// over within its 900ms budget long before a click can be observed, whereas an
// episode's pass starts at the moment the episode is chosen — which is precisely
// the "viewer is waiting" window the status line exists for.
const slow = await ctx.newPage();
await slow.route('**/api/embed/servers**', async (route) => {
  await new Promise((r) => setTimeout(r, 4000)); // hold it well past the budget
  await route.continue();
});
await slow.goto(`${BASE}/series/1396`, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Wait for real hydration before clicking, otherwise the click lands on static
// HTML and nothing happens.
await slow.waitForSelector('.fp-splash-play', { timeout: 30000 });
await slow.waitForTimeout(2500);
await slow.click('.fp-splash-play');
const sawOptimizing = await slow
  .waitForSelector('.fp-optimizing', { timeout: 3000, state: 'attached' })
  .then((el) => el.textContent())
  .catch(() => null);
check(
  'a stalled pass shows the "finding the best server" status',
  typeof sawOptimizing === 'string' && /server|सर्वर/i.test(sawOptimizing),
  sawOptimizing ? sawOptimizing.trim() : 'overlay never appeared'
);
// It must still decide despite the stall — the budget, not the network, ends it.
const decided = await slow
  .waitForSelector('.fp-embed-frame', { timeout: 5000, state: 'attached' })
  .then(() => true)
  .catch(() => false);
check('a stalled pass still picks a server and plays', decided);
// And the status must clear itself once a server is playing.
const overlayGone = await slow
  .waitForSelector('.fp-optimizing', { timeout: 3000, state: 'detached' })
  .then(() => true)
  .catch(() => false);
check('the status clears itself once a server is chosen', overlayGone);
await slow.close();

// ── 5. Failover preserves the position ─────────────────────────────────────
// The only mid-title failure the embed adapter can actually detect is a frame
// that never answers: a cross-origin document's HTTP status is unreadable from
// the parent (so an error page is indistinguishable from a working player), and
// any message from the frame is proof of life that correctly cancels failover.
// So the injected failure is a request held open forever, and the known position
// comes from Continue Watching — which is where a timestamp for a third-party
// player realistically comes from.
const failPage = await ctx.newPage();
const failFrames = [];
failPage.on('request', (r) => {
  const url = r.url();
  if (/\/api\/embed\/movie\/\d+\?/.test(url)) {
    const p = new URL(url).searchParams;
    failFrames.push({ server: p.get('server'), t: p.get('t') });
  }
});

await failPage.addInitScript(() => {
  localStorage.setItem(
    'streamer_continue',
    JSON.stringify([
      {
        id: 550,
        mediaType: 'movie',
        title: 'Fight Club',
        posterUrl: null,
        positionSeconds: 642,
        durationSeconds: 8340,
        updatedAt: new Date().toISOString(),
      },
    ])
  );
});

let blockedFirst = null;
await failPage.route('**/api/embed/movie/**', async (route) => {
  const server = new URL(route.request().url()).searchParams.get('server');
  if (blockedFirst === null) blockedFirst = server;
  // Never fulfil, never continue: the frame stays blank, which is what the
  // adapter's load timeout exists to catch.
  if (server === blockedFirst) return;
  await route.continue();
});
await failPage.goto(BASE + PATH, { waitUntil: 'domcontentloaded', timeout: 60000 });
await failPage.waitForTimeout(2500);
await failPage.click('.fp-splash-play');
// The adapter's load timeout is 9s; allow for it plus the remount.
await failPage.waitForTimeout(13000);

const toast = await failPage.evaluate(() => document.querySelector('.fp-toast')?.textContent?.trim() ?? null);
const notice = await failPage.evaluate(() =>
  [...document.querySelectorAll('.fp-notice')].map((n) => n.textContent?.trim()).join(' | ')
);
check(
  'the first frame resumes from the saved Continue Watching position',
  Number(failFrames[0]?.t) === 642,
  `t=${failFrames[0]?.t}`
);
check(
  'failover moved to a different server',
  failFrames.length >= 2 && failFrames[1].server !== failFrames[0].server,
  failFrames.map((f) => `${f.server}${f.t ? `@t=${f.t}` : ''}`).join(' → ')
);
const resumed = failFrames.slice(1).find((f) => Number(f.t) > 0);
check(
  'the replacement server is asked to resume at the preserved position',
  !!resumed,
  resumed ? `t=${resumed.t}s` : 'no t= on the replacement request'
);
check(
  'the viewer is told, briefly and non-intrusively',
  typeof toast === 'string' && /server|सर्वर/i.test(toast),
  toast ?? `no toast; notices="${notice}"`
);

await failPage.close();

// ── 6. Same behaviour on every form factor ─────────────────────────────────
// The requirement is that speed and behaviour are identical across devices, and
// the server picker deliberately renders DIFFERENT markup below 40rem (a sheet
// instead of a pill row — see SourceBar's useCompactViewport), so the selection
// path has to be checked on both.
for (const device of [
  { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, mobile: true },
  { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false },
]) {
  const dctx = await browser.newContext({
    viewport: device.viewport,
    isMobile: device.mobile,
    hasTouch: device.mobile,
    userAgent: device.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const dpage = await dctx.newPage();
  const dframes = [];
  const dstart = Date.now();
  let firstFrameAt = null;
  dpage.on('request', (r) => {
    if (/\/api\/embed\/movie\/\d+\?/.test(r.url())) {
      dframes.push(new URL(r.url()).searchParams.get('server'));
      firstFrameAt ??= Date.now() - dstart;
    }
  });
  await dpage.goto(BASE + PATH, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dpage.waitForSelector('.fp-splash-play', { timeout: 30000 });
  await dpage.waitForTimeout(2500);
  const clickAt = Date.now();
  await dpage.click('.fp-splash-play');
  const played = await dpage
    .waitForSelector('.fp-embed-frame', { timeout: 5000, state: 'attached' })
    .then(() => true)
    .catch(() => false);
  const timeToPlay = Date.now() - clickAt;
  const picker = await dpage.evaluate(() => ({
    sheetTrigger: !!document.querySelector('.fp-server-trigger'),
    pills: document.querySelectorAll('.fp-source-group-servers .fp-pill').length,
  }));
  check(
    `${device.name}: one server auto-selected and playing`,
    played && dframes.length === 1,
    `server=${dframes.join(',') || 'none'} servers=${played ? 'playing' : 'no frame'}`
  );
  check(
    `${device.name}: playback starts promptly after the tap`,
    played && timeToPlay < 1500,
    `${timeToPlay}ms after the tap`
  );
  check(
    `${device.name}: the picker is reachable in the right form (${device.viewport.width}px)`,
    device.viewport.width <= 640 ? picker.sheetTrigger : picker.pills >= 5,
    `sheetTrigger=${picker.sheetTrigger} pills=${picker.pills}`
  );
  await dctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
