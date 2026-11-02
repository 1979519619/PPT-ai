const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function harness(options = {}) {
  const writes = [], reads = [], logs = [], handlers = {}, sent = [];
  const settings = options.settings || {};
  const panel = { isVisible: () => false, hide() {}, showInactive() {}, webContents: { send: (...x) => sent.push(x) } };
  const streams = {};
  const child = { stdout: { on: (e, f) => { streams.stdout = f; } }, stderr: { on: (e, f) => { streams.stderr = f; } }, on() {} };
  const electron = {
    app: { isPackaged: false, requestSingleInstanceLock: () => true, quit() {}, getPath: () => 'C:/test-data', whenReady: () => ({ then() {} }), on() {} },
    BrowserWindow: function () {}, ipcMain: { handle: (k, f) => { handlers[k] = f; } },
    screen: { getPrimaryDisplay: () => ({ id: 1, bounds: { width: 100, height: 100 }, scaleFactor: 1 }) },
    globalShortcut: {}, session: {}, shell: {},
    desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,YQ==' } }] },
    safeStorage: {
      isEncryptionAvailable: () => options.encryption !== false,
      decryptString: () => { if (options.decryptFails) throw new Error('fake key must not leak'); return 'test-encrypted-only'; },
      encryptString: () => Buffer.from('ciphertext')
    }
  };
  const fileApi = {
    mkdirSync() {}, existsSync: () => true, statSync: () => ({ size: 487601967 }),
    readFileSync: p => { reads.push(p); return JSON.stringify(settings); },
    writeFileSync: (p, b) => writes.push({ p, b: String(b) }), appendFileSync: (p, b) => logs.push(String(b))
  };
  const modules = { electron, fs: fileApi, path, os: { cpus: () => Array(16) },
    net: { connect: () => ({ once(e, f) { if (e === 'connect') queueMicrotask(f); return this; }, destroy() {} }) },
    'child_process': { spawn: () => child },
    'opencc-js': { Converter: () => s => s }, koffi: { load: () => ({ func: () => () => true }) }
  };
  const context = vm.createContext({
    require: n => { if (!(n in modules)) throw new Error('Unexpected require: ' + n); return modules[n]; },
    __dirname: path.join(root, 'app/m1'), process: { pid: 1, resourcesPath: 'C:/resources' },
    Buffer, FormData, Blob, AbortController, TextDecoder, TextEncoder,
    setTimeout: f => { queueMicrotask(f); return 1; }, clearTimeout() {},
    fetch: options.fetch || (async () => { throw new Error('Unexpected network request'); })
  });
  const source = fs.readFileSync(path.join(root, 'app/m1/main.js'), 'utf8');
  vm.runInContext(source + '\nthis.api = { getApiKey, handleAsr, handleAsk, capture, startAsr }; pet = this.testPanel; panel = this.testPanel;', Object.assign(context, { testPanel: panel }));
  return { ...context.api, writes, reads, logs, handlers, sent, streams };
}

test('encrypted key works; missing/unavailable/decryption failure never reads plaintext fallback', () => {
  assert.equal(harness({ settings: { apiKeyEnc: 'YQ==' } }).getApiKey(), 'test-encrypted-only');
  for (const options of [{}, { settings: { apiKeyEnc: 'YQ==' }, encryption: false }, { settings: { apiKeyEnc: 'YQ==' }, decryptFails: true }]) {
    const h = harness(options);
    assert.equal(h.getApiKey(), '');
    assert.ok(h.reads.every(p => path.basename(p) === 'settings.json'));
    assert.ok(!h.logs.join('').includes('fake key'));
  }
});

test('screen capture stays in memory', async () => {
  const h = harness();
  assert.match(await h.capture(), /^data:image\/png/);
  assert.equal(h.writes.length, 0);
});

test('ASR audio and transcript are not persisted in files or logs', async () => {
  const secret = '这是私密课堂测试文本';
  const h = harness({ fetch: async () => ({ ok: true, text: async () => JSON.stringify({ text: secret }) }) });
  const result = await h.handleAsr(Buffer.from('test-wave').toString('base64'));
  assert.equal(result.text, secret);
  assert.equal(h.writes.length, 0);
  assert.ok(!h.logs.join('').includes(secret));
  h.startAsr(); h.streams.stdout(Buffer.from(secret)); h.streams.stderr(Buffer.from(secret));
  assert.ok(!h.logs.join('').includes(secret));
});

test('oversized or malformed requests are rejected before any network access', async () => {
  const h = harness();
  assert.equal((await h.handleAsk('a'.repeat(2001), [])).ok, false);
  assert.equal((await h.handleAsk('q', Array(6).fill('data:image/png;base64,YQ=='))).ok, false);
  assert.equal((await h.handleAsk('q', [null])).ok, false);
  assert.equal((await h.handleAsr('a'.repeat(12 * 1024 * 1024 + 1))).ok, false);
  assert.equal((await h.handleAsr('not base64!')).ok, false);
});

test('missing key gives settings guidance; upstream error bodies are not exposed', async () => {
  const h = harness();
  assert.equal((await h.handleAsk('q', [])).ok, false);
  assert.ok(h.sent.some(x => String(x[1]).includes('Ctrl+Alt+S')));
  const upstreamSecret = 'provider-reflected-secret';
  const withKey = harness({ settings: { apiKeyEnc: 'YQ==' }, fetch: async () => ({ ok: false, status: 401, text: async () => upstreamSecret }) });
  assert.equal((await withKey.handleAsk('q', [])).ok, false);
  assert.ok(!JSON.stringify(withKey.sent).includes(upstreamSecret));
  assert.ok(!withKey.logs.join('').includes(upstreamSecret));
});

test('streaming answers reach panel without persisting question/answer text', async () => {
  let request;
  const h = harness({ settings: { apiKeyEnc: 'YQ==' }, fetch: async (url, init) => {
    request = { url, init }; let done = false;
    return { ok: true, body: { getReader: () => ({ read: async () => {
      if (done) return { done: true }; done = true;
      return { value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"私密答案"}}]}\n\ndata: [DONE]\n\n'), done: false };
    } }) } };
  } });
  assert.equal((await h.handleAsk('私密问题', ['data:image/png;base64,YQ=='])).ok, true);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(request.init.body).messages[1].content.length, 2);
  assert.ok(h.sent.some(x => x[0] === 'm1:delta' && x[1].text === '私密答案'));
  assert.equal(h.writes.length, 0);
  assert.ok(!h.logs.join('').includes('私密'));
});

test('DPAPI save never writes raw API key', async () => {
  const h = harness();
  assert.equal((await h.handlers['m1:saveKey']({}, 'fake-private-key')).ok, true);
  assert.equal(h.writes.length, 1);
  assert.ok(!h.writes[0].b.includes('fake-private-key'));
  assert.ok(JSON.parse(h.writes[0].b).apiKeyEnc);
});

test('renderer inline scripts parse and removed debug hooks are absent', () => {
  for (const name of ['panel.html', 'pet.html', 'settings.html', 'lasso.html']) {
    const html = fs.readFileSync(path.join(root, 'app/m1', name), 'utf8');
    for (const [, code] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(code, { filename: name });
    assert.ok(!/onDevAsk|onStartMicTest/.test(html));
    assert.ok(html.includes('Content-Security-Policy'));
  }
});

test('microphone stops on short audio, ASR rejection and conversion failure', async () => {
  const html = fs.readFileSync(path.join(root, 'app/m1/settings.html'), 'utf8');
  const start = html.indexOf('async function runMicTest(){');
  const end = html.indexOf('\nfunction busy(', start);
  for (const outcome of ['short', 'rejected', 'conversion-error']) {
    let stopped = 0, busyState = false;
    const context = vm.createContext({
      setMsg() {}, setAsr() {}, stopLevel() { stopped++; }, openMic: async () => {}, startLevel() {},
      stream: {}, chunks: [], mr: null, lastBlob: null, Blob, performance,
      busy: b => { busyState = b; }, setTimeout() {},
      toWav: async () => { if (outcome === 'conversion-error') throw new Error('conversion'); return 'YQ=='; },
      window: { m1: { asr: async () => ({ ok: false, error: 'no speech' }) } },
      MediaRecorder: class { start() {} }
    });
    vm.runInContext(html.slice(start, end) + '\nthis.run = runMicTest;', context);
    await context.run();
    context.chunks = [new Blob([outcome === 'short' ? 'a' : 'a'.repeat(2000)])];
    await context.mr.onstop();
    assert.equal(stopped, 2, outcome + ': stop old stream and newly recorded stream');
    assert.equal(busyState, false, outcome + ': button restored');
  }
});
