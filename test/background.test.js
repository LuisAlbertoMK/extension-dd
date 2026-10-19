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
  const tabs = { nextId: 1, live: new Map(), removed: [] };
  const listeners = { message: [], startup: [], installed: [], updated: [] };
  const failSetOn = { key: options.failSetOn || null, message: options.failMessage || 'QUOTA_BYTES quota exceeded' };
  const payload = options.payload || { dd: { page: { pageInfo: { pageName: 'test' } } }, aa: null };

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
        const id = tabs.nextId++;
        tabs.live.set(id, { id, url, status: 'complete' });
        return { id, url, status: 'complete' };
      },
      get: async (id) => {
        const tab = tabs.live.get(id);
        if (!tab) throw new Error('No tab with id ' + id);
        return { ...tab, status: 'complete' };
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

  return { chrome, store, tabs, send, waitForJobEnd, snapshot, resultKeys };
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
