// Integration harness for background.js: runs the real service worker inside a
// sandbox with a fake chrome API and checks the storage protocol end to end
// (per-URL keys, progress, resume, quota abort). Run with: npm test
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const BACKGROUND = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createWorker(options = {}) {
  const store = new Map();
  const tabs = { nextId: 1, live: new Map(), removed: [], created: [], attempts: 0 };
  const alarms = { created: [], cleared: [] };
  const listeners = { message: [], startup: [], installed: [], updated: [], alarm: [] };
  const failSetOn = { key: options.failSetOn || null, message: options.failMessage || 'QUOTA_BYTES quota exceeded' };
  const payload = options.payload || { dd: { page: { pageInfo: { pageName: 'test' } } }, aa: null };
  let failTabCreate = !!options.failFirstTabCreate;

  Object.keys(options.seed || {}).forEach((key) => store.set(key, clone(options.seed[key])));

  function set(items, callback) {
    const keys = Object.keys(items);
    if (failSetOn.key && keys.indexOf(failSetOn.key) !== -1) {
      failSetOn.key = null;
      chrome.runtime.lastError = { message: failSetOn.message };
      if (callback) callback();
      chrome.runtime.lastError = null;
      return;
    }
    keys.forEach((key) => store.set(key, clone(items[key])));
    if (callback) callback();
  }

  function get(keys, callback) {
    const out = {};
    if (keys === null || keys === undefined) {
      store.forEach((value, key) => { out[key] = clone(value); });
    } else {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
        if (store.has(key)) out[key] = clone(store.get(key));
      });
    }
    callback(out);
  }

  function remove(keys, callback) {
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => store.delete(key));
    if (callback) callback();
  }

  const chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://test/' + p,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) }
    },
    storage: { local: { get, set, remove, onChanged: { addListener: () => {} } } },
    tabs: {
      create: async ({ url }) => {
        // The extension's own results tab is not a page load: it must not be
        // counted as an attempt when a test is checking retry behaviour.
        if (url.indexOf('chrome-extension://') === 0) {
          const id = tabs.nextId++;
          tabs.live.set(id, { id, url, status: 'complete' });
          return { id, url, status: 'complete' };
        }
        tabs.attempts++;
        if (failTabCreate) {
          failTabCreate = false;
          throw new Error('Tabs cannot be edited right now (user may be dragging a tab)');
        }
        const id = tabs.nextId++;
        tabs.created.push(id);
        tabs.live.set(id, { id, url, status: 'complete' });
        return { id, url, status: 'complete' };
      },
      get: async (id) => {
        if (options.dropTabs) throw new Error('No tab with id ' + id);
        const tab = tabs.live.get(id);
        if (!tab) throw new Error('No tab with id ' + id);
        return { ...tab, status: 'complete', url: options.finalUrl || tab.url };
      },
      remove: async (id) => {
        tabs.removed.push(id);
        tabs.live.delete(id);
      },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn), removeListener: () => {} }
    },
    scripting: {
      executeScript: async () => [{ result: clone(payload) }]
    },
    cookies: { set: async () => {} },
    alarms: {
      create: async (name, info) => { alarms.created.push({ name, info }); },
      clear: async (name) => { alarms.cleared.push(name); },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) }
    },
    declarativeNetRequest: { updateDynamicRules: async () => {} }
  };

  const context = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Object,
    Array,
    Number,
    String,
    Set,
    Map,
    Date,
    Math,
    Error,
    URL
  };
  context.globalThis = context;
  if (options.page) context.window = options.page;
  const vmContext = vm.createContext(context);
  context.importScripts = (...files) => {
    files.forEach((file) => {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
      vm.runInContext(code, vmContext, { filename: file });
    });
  };
  vm.runInContext(BACKGROUND, vmContext, { filename: 'background.js' });

  function send(message) {
    return new Promise((resolve, reject) => {
      const handler = listeners.message[0];
      if (!handler) return reject(new Error('no message listener registered'));
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('no response from START_JOB')); }
      }, 10000);
      handler(message, {}, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  async function waitForJobEnd(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (store.has('ddJobRunning') && store.get('ddJobRunning') === false) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('job did not finish in time');
  }

  function snapshot() {
    const out = {};
    store.forEach((value, key) => { out[key] = clone(value); });
    return out;
  }

  function resultKeys() {
    return [...store.keys()].filter((key) => key.indexOf('ddR:') === 0);
  }

  // Reaches top-level `let` bindings of the worker (activeJob, resumeInFlight)
  // which are not properties of the sandbox object.
  function evaluate(code) {
    return vm.runInContext(code, vmContext);
  }

  // Simulates the browser firing the watchdog alarm.
  function fireAlarm(name = 'ddWatchdog') {
    listeners.alarm.slice().forEach((fn) => fn({ name }));
    return new Promise((resolve) => setTimeout(resolve, 60));
  }

  return {
    chrome,
    store,
    tabs,
    alarms,
    sandbox: context,
    send,
    waitForJobEnd,
    snapshot,
    resultKeys,
    evaluate,
    fireAlarm
  };
}

const URLS = [
  'https://shop.example/a',
  'https://shop.example/b',
  'https://shop.example/c',
  'https://shop.example/d',
  'https://shop.example/e'
];

describe('background job persistence', () => {
  it('stores one result per URL, tracks progress and closes every tab', async () => {
    const worker = createWorker();
    const response = await worker.send({ type: 'START_JOB', urls: URLS });
    assert.equal(response && response.ok, true);

    await worker.waitForJobEnd();
    const stored = worker.snapshot();

    assert.equal(stored.ddTotal, URLS.length);
    assert.deepEqual(worker.resultKeys().sort(), ['ddR:0', 'ddR:1', 'ddR:2', 'ddR:3', 'ddR:4']);
    assert.equal(stored.ddProgress.done, URLS.length);
    assert.equal(stored.ddProgress.total, URLS.length);
    assert.equal(stored.ddJobRunning, false);
    assert.equal(stored.ddJob.status, 'idle');
    assert.ok(!('ddResults' in stored), 'legacy single-key snapshot must not be written');

    const first = stored['ddR:0'];
    assert.equal(first.url, URLS[0]);
    assert.equal(first.status, 'ok');
    assert.equal(first.digitalData.page.pageInfo.pageName, 'test');
    assert.equal(typeof first.finalUrl, 'string');

    assert.equal(worker.tabs.removed.length, URLS.length);
    // Only the results page opened by finalizeJob stays open.
    assert.deepEqual([...worker.tabs.live.values()].map((tab) => tab.url),
      ['chrome-extension://test/results.html']);
  });

  it('resumes a persisted running job without reprocessing finished URLs', async () => {
    const worker = createWorker({
      seed: {
        ddJob: {
          status: 'running',
          urls: URLS,
          nextIndex: 0,
          startedAt: Date.now(),
          tabIds: []
        },
        ddJobRunning: true,
        ddTotal: URLS.length,
        'ddR:0': { url: URLS[0], finalUrl: null, status: 'ok', digitalData: { kept: true }, error: null },
        'ddR:1': { url: URLS[1], finalUrl: null, status: 'ok', digitalData: { kept: true }, error: null }
      }
    });

    await worker.waitForJobEnd();
    const stored = worker.snapshot();

    assert.equal(stored.ddProgress.done, URLS.length);
    assert.deepEqual(stored['ddR:0'].digitalData, { kept: true });
    assert.deepEqual(stored['ddR:1'].digitalData, { kept: true });
    assert.equal(stored['ddR:4'].status, 'ok');
    // Only the three missing URLs were opened in tabs.
    assert.equal(worker.tabs.removed.length, 3);
  });

  it('aborts on a storage quota failure and keeps the partial results', async () => {
    const worker = createWorker({ failSetOn: 'ddR:1' });
    await worker.send({ type: 'START_JOB', urls: URLS.slice(0, 3) });
    await worker.waitForJobEnd();

    const stored = worker.snapshot();
    assert.equal(stored.ddJobError, 'storage-quota');
    assert.equal(stored.ddJobRunning, false);
    assert.equal(stored.ddJob.status, 'aborted');
    assert.ok(worker.resultKeys().length >= 1, 'partial results must survive');
    assert.ok(worker.resultKeys().length < 3, 'the failing write must not be counted');
    assert.equal(stored.ddProgress.done, worker.resultKeys().length);
  });
});

describe('background load classification', () => {
  it('reports a network error page as an error instead of no-data', async () => {
    const worker = createWorker({ finalUrl: 'chrome-error://chromewebdata/' });
    await worker.send({ type: 'START_JOB', urls: [URLS[0]] });
    await worker.waitForJobEnd();

    const entry = worker.snapshot()['ddR:0'];
    assert.equal(entry.status, 'error');
    assert.match(entry.error, /Page failed to load/);
    assert.equal(entry.digitalData, null);
  });

  it('reports a tab closed before it could be read as an error', async () => {
    const worker = createWorker({ dropTabs: true });
    await worker.send({ type: 'START_JOB', urls: [URLS[0]] });
    await worker.waitForJobEnd();

    const entry = worker.snapshot()['ddR:0'];
    assert.equal(entry.status, 'error');
    assert.match(entry.error, /Tab closed/);
  });
});

describe('cancellation', () => {
  it('stops a running job, keeps the partial results readable and leaves a marker', async () => {
    const worker = createWorker();
    const started = await worker.send({ type: 'START_JOB', urls: URLS });
    assert.equal(started.ok, true);

    const cancelled = await worker.send({ type: 'CANCEL_JOB' });
    assert.equal(cancelled.ok, true);
    await worker.waitForJobEnd();

    const stored = worker.snapshot();
    assert.equal(stored.ddJobRunning, false);
    assert.equal(stored.ddJobError, 'cancelled');
    assert.equal(stored.ddJob.status, 'cancelled');
    assert.ok(worker.resultKeys().length < URLS.length, 'a cancelled run must not complete');
    // A cancelled job must not write progress either: the counters have to match
    // the results actually on disk.
    assert.equal(stored.ddProgress.done, worker.resultKeys().length);
  });

  it('clears a zombie running state the worker could not resume', async () => {
    // A record marked running with no usable URL list: maybeResume() refuses it,
    // so only an explicit cancel can clear the state the popup is showing.
    const worker = createWorker({
      seed: {
        ddJob: { status: 'running', urls: [], nextIndex: 0, startedAt: Date.now(), tabIds: [] },
        ddJobRunning: true,
        ddTotal: 0
      }
    });

    const cancelled = await worker.send({ type: 'CANCEL_JOB' });
    assert.equal(cancelled.ok, true);

    const stored = worker.snapshot();
    assert.equal(stored.ddJobRunning, false);
    assert.equal(stored.ddJobError, 'cancelled');
    assert.equal(stored.ddJob.status, 'cancelled');
  });

  it('reports no job to cancel when nothing is running', async () => {
    const worker = createWorker();
    const cancelled = await worker.send({ type: 'CANCEL_JOB' });
    assert.deepEqual(clone(cancelled), { ok: false, reason: 'no-job' });
  });

  it('lets a new run start over a cancelled job that is still draining', async () => {
    const worker = createWorker();
    await worker.send({ type: 'START_JOB', urls: URLS });
    await worker.send({ type: 'CANCEL_JOB' });

    const restarted = await worker.send({ type: 'START_JOB', urls: [URLS[0]] });
    assert.equal(restarted.ok, true);
    await worker.waitForJobEnd();

    const stored = worker.snapshot();
    assert.equal(stored.ddTotal, 1);
    assert.equal(stored.ddJobError, undefined, 'the new run clears the cancelled marker');
    assert.equal(stored.ddJob.status, 'idle');
  });
});

describe('watchdog', () => {
  it('arms the alarm while a job runs and clears it when the job ends', async () => {
    const worker = createWorker();
    await worker.send({ type: 'START_JOB', urls: [URLS[0]] });
    await worker.waitForJobEnd();

    assert.deepEqual(worker.alarms.created.map((a) => a.name), ['ddWatchdog']);
    assert.ok(worker.alarms.cleared.includes('ddWatchdog'));
  });

  it('resumes a job whose worker died and never woke up', async () => {
    const worker = createWorker({
      seed: {
        ddJob: { status: 'running', urls: URLS, nextIndex: 0, startedAt: Date.now(), tabIds: [] },
        ddJobRunning: true,
        ddTotal: URLS.length
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Simulate the kill: the in-memory queue is gone, storage still says running.
    worker.evaluate('activeJob.handle.cancelled = true; activeJob.handle.superseded = true; activeJob = null;');
    assert.equal(worker.snapshot().ddJobRunning, true, 'the run stays stuck until something wakes it');

    await worker.fireAlarm();
    await worker.waitForJobEnd();

    const stored = worker.snapshot();
    assert.equal(stored.ddProgress.done, URLS.length);
    assert.equal(stored.ddJob.status, 'idle');
    assert.deepEqual(worker.resultKeys().sort(), ['ddR:0', 'ddR:1', 'ddR:2', 'ddR:3', 'ddR:4']);
  });

  it('restarts a queue that stopped producing results', async () => {
    const worker = createWorker();
    await worker.send({ type: 'START_JOB', urls: URLS });
    // Pretend the queue went mute two minutes ago while its tabs hang.
    worker.evaluate('activeJob.lastProgressAt = Date.now() - 300000');

    await worker.fireAlarm();
    await worker.waitForJobEnd();

    const stored = worker.snapshot();
    assert.equal(stored.ddProgress.done, URLS.length);
    assert.equal(stored.ddJob.status, 'idle');
    assert.equal(worker.resultKeys().length, URLS.length);
    assert.equal(stored.ddJobError, undefined, 'a watchdog restart is not a failure');
  });

  it('closes the tabs the killed worker left behind', async () => {
    const worker = createWorker();
    await worker.send({ type: 'START_JOB', urls: URLS });
    // Give the workers a beat to open their tabs and persist the live ids.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const progress = worker.snapshot().ddProgress;
    assert.equal(progress.tabIds.length, URLS.length, 'live tab ids must be persisted');

    worker.evaluate('activeJob.handle.cancelled = true; activeJob.handle.superseded = true; activeJob = null;');
    await worker.fireAlarm();
    await worker.waitForJobEnd();

    // Every tab opened by the first queue is closed: 5 orphans + 5 from the
    // restarted queue.
    URLS.forEach((_, i) => assert.ok(worker.tabs.removed.includes(i + 1), `tab ${i + 1} must be closed`));
  });

  it('clears the alarm when the alarm finds no running job', async () => {
    const worker = createWorker();
    await worker.fireAlarm();
    assert.ok(worker.alarms.cleared.includes('ddWatchdog'));
  });
});

describe('retry', () => {
  it('retries a transient tab failure and keeps the data', async () => {
    const worker = createWorker({ failFirstTabCreate: true });
    await worker.send({ type: 'START_JOB', urls: [URLS[0]] });
    await worker.waitForJobEnd();

    const entry = worker.snapshot()['ddR:0'];
    assert.equal(entry.status, 'ok');
    assert.equal(entry.digitalData.page.pageInfo.pageName, 'test');
    assert.equal(worker.tabs.created.length, 1, 'the retry must not leave a second page open');
    assert.equal(worker.tabs.attempts, 2, 'the failed attempt must be retried');
  });

  it('does not retry a network error page', async () => {
    const worker = createWorker({ finalUrl: 'chrome-error://chromewebdata/' });
    await worker.send({ type: 'START_JOB', urls: [URLS[0]] });
    await worker.waitForJobEnd();

    const entry = worker.snapshot()['ddR:0'];
    assert.equal(entry.status, 'error');
    assert.match(entry.error, /Page failed to load/);
    assert.equal(worker.tabs.attempts, 1, "the site's answer must not be retried");
  });
});

describe('extractPageAnalytics', () => {
  it('ignores an empty digitalData and waits until it is populated', async () => {
    const page = { digitalData: {} };
    const worker = createWorker({ page });
    setTimeout(() => { page.digitalData = { page: { pageInfo: { pageName: 'late' } } }; }, 30);

    const result = await worker.sandbox.extractPageAnalytics(300, 10, 2);
    assert.equal(result.dd.page.pageInfo.pageName, 'late');
  });

  it('reports no digitalData when the object stays empty until the timeout', async () => {
    const worker = createWorker({ page: { digitalData: {} } });
    const result = await worker.sandbox.extractPageAnalytics(60, 10, 2);
    assert.equal(result.dd, null);
  });

  it('accepts a payload that stays identical for the required polls', async () => {
    const page = { digitalData: { page: { pageInfo: { pageName: 'stable' } } } };
    const worker = createWorker({ page });
    const result = await worker.sandbox.extractPageAnalytics(300, 10, 2);
    assert.equal(result.dd.page.pageInfo.pageName, 'stable');
  });

  it('falls back to the last seen payload when it never stabilizes', async () => {
    const page = { digitalData: { n: 0 } };
    const worker = createWorker({ page });
    let n = 0;
    const timer = setInterval(() => { n++; page.digitalData = { n }; }, 10);

    const result = await worker.sandbox.extractPageAnalytics(80, 10, 2);
    clearInterval(timer);
    assert.ok(result.dd && result.dd.n > 0, 'expected the last observed payload');
  });
});
