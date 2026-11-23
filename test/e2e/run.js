/* eslint-env node */
'use strict';

// End-to-end runner. Loads the built extension (dist/) into Chromium, points
// the booking host at the local stand-in in ./site and checks what the
// extension did there.
//
//   npm run test:e2e                  every scenario
//   npm run test:e2e -- "autoPay"     only scenarios whose name contains this
//   E2E_LOG=1 npm run test:e2e        also print what the stand-in recorded

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { chromium } = require('playwright-core');
const { startServer, SITE_HOST } = require('./server');
const scenarios = require('./scenarios');

const DIST = path.resolve(__dirname, '../../dist');
const STORAGE_KEY = 'tatkalTicketBookingFormData';
const NOT_RESOLVED = 'net::ERR_NAME_NOT_RESOLVED';

// Every browser started here gets these arguments. The first two are the
// isolation: the booking host resolves to the stand-in, every other name fails
// to resolve, and no proxy is used that could resolve names instead.
function chromeArgs(port) {
  return [
    `--host-resolver-rules=MAP ${SITE_HOST}:443 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    '--no-proxy-server',
    '--ignore-certificate-errors', // the stand-in's certificate is self-signed
    '--headless=new', // Chromium's own headless mode; the older one cannot load extensions
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
  ];
}

class IsolationError extends Error {}

// Temp directories still in use. Removed on any exit, an interrupt included.
const inUse = new Set();
process.on('exit', () => {
  for (const dir of inUse) fs.rmSync(dir, { recursive: true, force: true });
});

// Reads the network log a browser wrote and throws unless the stand-in is the
// only thing it exchanged data with. This is a measurement, not an argument:
// some of Chromium's own lookups do not go through the resolver rules.
// `mustHaveReached` is false for a browser that failed before it loaded
// anything: that is a failed scenario, not a failure of isolation.
function assertOnlyStandInReached(netLog, port, mustHaveReached = true) {
  let constants;
  let events;
  try {
    ({ constants, events } = JSON.parse(fs.readFileSync(netLog, 'utf8')));
  } catch (error) {
    throw new IsolationError(`The network log could not be read (${error.message}), so isolation is not verified.`);
  }
  const typeOf = Object.fromEntries(Object.entries(constants.logEventTypes).map(([name, id]) => [id, name]));
  const standIn = `127.0.0.1:${port}`;
  const udpPeer = new Map();
  const outside = new Set();
  let reachedStandIn = false;

  for (const { type, source, params } of events) {
    const address = params && params.address;
    if (typeOf[type] === 'TCP_CONNECT_ATTEMPT' && address) {
      if (address === standIn) reachedStandIn = true;
      else outside.add(`TCP connection to ${address}`);
    }
    // Connecting a UDP socket sends nothing (Chromium does it to look for an
    // IPv6 route); a datagram on one is a DNS query or QUIC.
    if (typeOf[type] === 'UDP_CONNECT' && address) udpPeer.set(source.id, address);
    if (typeOf[type] === 'UDP_BYTES_SENT') outside.add(`UDP datagram to ${udpPeer.get(source.id) || 'an unknown address'}`);
  }

  if (outside.size) throw new IsolationError(`The browser reached outside the stand-in: ${[...outside].join(', ')}`);
  if (mustHaveReached && !reachedStandIn) throw new IsolationError('The network log shows no connection to the stand-in, so it proves nothing.');
}

// A browser with a fresh profile, closed and deleted afterwards. Its network
// log is checked on the way out.
async function withBrowser(port, use) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-profile-'));
  const netLog = path.join(profile, 'net-log.json');
  inUse.add(profile);
  try {
    // Chromium answers a navigation that fails to resolve with a DNS lookup of
    // its own, outside the resolver rules. This preference switches that off.
    fs.mkdirSync(path.join(profile, 'Default'));
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ alternate_error_pages: { enabled: false } }));
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_PATH || chromium.executablePath(),
      headless: false, // --headless=new above is what makes it headless
      viewport: { width: 1280, height: 900 },
      args: [...chromeArgs(port), `--log-net-log=${netLog}`],
      // Keeps the crash database in the profile, not in the home directory.
      env: { ...process.env, BREAKPAD_DUMP_LOCATION: path.join(profile, 'crash') },
    });
    let failure;
    try {
      await use(context);
    } catch (error) {
      failure = error;
    } finally {
      await context.close();
    }
    assertOnlyStandInReached(netLog, port, !failure);
    if (failure) throw failure;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
    inUse.delete(profile);
  }
}

function makeChecks() {
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
    if (!ok) failures.push(name);
    return ok;
  };
  const same = (name, actual, expected) => check(name, isDeepStrictEqual(actual, expected),
    `expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`);
  return { check, same, failures };
}

async function poll(what, get, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`gave up after ${timeoutMs / 1000} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Runs before any scenario, in a browser set up exactly like theirs but with
// the extension left switched off. Returns false unless that browser can reach
// the stand-in and nothing else.
async function verifyIsolation(server) {
  const { check, failures } = makeChecks();
  await withBrowser(server.port, async (context) => {
    const page = await context.newPage();
    const failed = new Map();
    page.on('requestfailed', (request) => failed.set(request.url(), request.failure().errorText));
    // Requests are made from the page, not by navigating to them: a navigation
    // that fails to resolve makes Chromium test the machine's DNS with a real
    // lookup of its own, which the resolver rules do not cover.
    const reason = async (url) => {
      const loaded = await page.evaluate((target) => fetch(target, { mode: 'no-cors' }).then(() => true, () => false), url);
      return loaded ? 'it loaded' : poll(`the failure of ${url}`, () => failed.get(url), 5000);
    };

    // First a name that cannot leave this machine: without the catch-all rule
    // it is the stand-in's own port, so the probe is harmless even when it
    // fails. It is made from a page of its own, before the booking host is
    // asked for at all. Not from about:blank: the options page the extension
    // opens on install can take over a blank tab.
    await page.goto('data:text/html,<title>isolation check</title>');
    const local = await reason(`https://localhost:${server.port}/__standin/ping`);
    if (!check('localhost does not resolve, so the catch-all rule is in force', local === NOT_RESOLVED, local)) return;

    const response = await page.goto(`https://${SITE_HOST}/__standin/ping`);
    const served = response.headers()['x-standin'] === server.marker && (await response.text()) === server.marker;
    if (!check(`https://${SITE_HOST} is answered by the stand-in (this run's marker came back)`, served)) return;

    // Only now, with both proven, names that exist outside this machine.
    for (const url of ['https://example.com/', 'https://api.ocr.space/']) {
      const result = await reason(url);
      check(`${url} does not resolve`, result === NOT_RESOLVED, result);
    }
  });
  // Reaching this line means withBrowser found nothing else in the network log.
  check('network log of that browser: data went to the stand-in and nowhere else', true);
  return failures.length === 0;
}

// Stores the scenario's settings the way the options page would have.
async function seedSettings(context, settings) {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 20000 }));
  const optionsUrl = `chrome-extension://${new URL(worker.url()).host}/options.html`;

  // On a fresh install the extension opens its options page, and that page
  // stores its own defaults when it finds no settings. Wait until it has, so
  // that it cannot overwrite what is stored next.
  const options = await poll('the options page to open after install',
    () => context.pages().find((page) => page.url().startsWith(optionsUrl)), 20000);
  await poll('the options page to store its defaults',
    () => options.evaluate((key) => chrome.storage.local.get(key).then((stored) => Boolean(stored[key])), STORAGE_KEY), 20000);
  // debugMode makes the content script log its steps, shown when a scenario fails.
  await options.evaluate((data) => chrome.storage.local.set(data), { [STORAGE_KEY]: settings, debugMode: true });
  await options.close();
}

const describe = (entry) => {
  const { n, ms, clock, type, key, ...rest } = entry;
  return `    ${String(n).padStart(3)}  +${String(ms).padStart(5)}ms  ${clock}  ${type.padEnd(6)} ${key}  ${JSON.stringify(rest)}`;
};

async function runScenario(scenario, server) {
  const t = { ...makeChecks(), dialogs: [], outside: [] };
  const extensionLog = [];
  let log = [];

  try {
    await withBrowser(server.port, async (context) => {
      await seedSettings(context, scenario.settings);
      const page = await context.newPage();

      // The test stands in for the person: it answers each prompt the
      // extension raises with the next answer the scenario lists.
      const answers = [...(scenario.answers || [])];
      page.on('dialog', async (dialog) => {
        const answer = dialog.type() === 'prompt' && answers.length ? answers.shift() : null;
        t.dialogs.push({ type: dialog.type(), message: dialog.message(), answer });
        await (answer === null ? dialog.dismiss() : dialog.accept(answer));
      });
      page.on('console', (message) => {
        if (message.text().startsWith('[IRCTC-Bot]')) extensionLog.push(message.text());
      });
      // A request to another host dies at name resolution, so the network log
      // never shows it. It is recorded here as an attempt.
      page.on('request', (request) => {
        if (new URL(request.url()).host !== SITE_HOST) t.outside.push(`${request.method()} ${request.url()}`);
      });

      const query = encodeURIComponent(JSON.stringify(scenario.site));
      const response = await page.goto(`https://${SITE_HOST}/nget/train-search?standin=${query}`);
      if (response.headers()['x-standin'] !== server.marker) throw new Error('the page did not come from the stand-in');

      const readLog = async () => {
        log = await page.evaluate(() => window.__standin.log);
        return log;
      };
      try {
        await scenario.drive({
          ...t,
          page,
          readLog,
          pause: (ms) => page.waitForTimeout(ms),
          setClock: (time) => page.evaluate((value) => window.__standin.setClock(value), time),
          until: (what, reached, timeoutMs = 30000) => poll(what, async () => reached(await readLog()), timeoutMs),
        });
      } finally {
        await readLog().catch(() => {});
      }
    });
    t.check('network log: data went to the stand-in and nowhere else', true);
  } catch (error) {
    if (error instanceof IsolationError) throw error; // nothing else should run after that
    t.check('the scenario ran to its end', false, error.message.split('\n')[0]);
  }

  // Checked even after a failed drive: it shows how far the extension got.
  scenario.verify(t, log);
  t.same('no request was attempted outside the stand-in, apart from those the scenario names', t.outside, scenario.outsideRequests || []);

  if (t.failures.length || process.env.E2E_LOG) {
    console.log('  what the stand-in recorded:');
    console.log(log.map(describe).join('\n') || '    (nothing)');
    console.log(`  dialogs: ${JSON.stringify(t.dialogs)}`);
    console.log('  last lines the extension logged:');
    console.log(extensionLog.slice(-15).map((line) => `    ${line}`).join('\n') || '    (nothing)');
  }
  return t.failures.length === 0;
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    console.error('dist/ is missing. Build the extension first: npm run build');
    return 2;
  }
  // A run on a build older than its sources would describe the old code.
  const built = fs.statSync(path.join(DIST, 'content.js')).mtimeMs;
  const newer = ['manifest.json', 'src/sw.js', 'src/scripts/user-script.js', 'src/scripts/logger.js', 'src/scripts/ocr-reader.js']
    .filter((file) => fs.statSync(path.resolve(__dirname, '../../chrome-extension', file)).mtimeMs > built);
  if (newer.length) {
    console.error(`dist/ is older than ${newer.join(', ')}. Build again: npm run build`);
    return 2;
  }
  const wanted = process.argv[2];
  const selected = scenarios.filter((scenario) => !wanted || scenario.name.includes(wanted));
  if (!selected.length) {
    console.error(`No scenario has "${wanted}" in its name.`);
    return 2;
  }

  const startedAt = Date.now();
  const server = await startServer(inUse);
  try {
    console.log(`stand-in for https://${SITE_HOST} listening on 127.0.0.1:${server.port}\n\nisolation`);
    if (!(await verifyIsolation(server))) {
      console.error('\nThe browser is not isolated from the network. No scenario was run.');
      return 2;
    }

    const seconds = (since) => ((Date.now() - since) / 1000).toFixed(1);
    let failed = 0;
    for (const scenario of selected) {
      console.log(`\n${scenario.name}`);
      const scenarioStartedAt = Date.now();
      if (!(await runScenario(scenario, server))) failed += 1;
      console.log(`  (${seconds(scenarioStartedAt)} s)`);
    }
    console.log(`\n${selected.length - failed} of ${selected.length} scenarios passed in ${seconds(startedAt)} s`);
    return failed ? 1 : 0;
  } finally {
    await server.close();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(error instanceof IsolationError ? `\n${error.message}\nStopped: nothing further was run.` : error);
    process.exitCode = 2;
  },
);
