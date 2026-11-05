'use strict';
// Current contracts, isolated from Electron, native services and real networking.
// Updated for this release; the final build task does not execute these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { StringDecoder } = require('node:string_decoder');
const { reconstructLines } = require('../app/m1/ocr-lines');
const root = path.resolve(__dirname, '..');

function harness(options = {}) {
  const writes = [], logs = [], sent = [], handlers = {}, files = new Map(), handles = new Map();
  let fd = 0;
  const frame = {};
  const window = { isDestroyed: () => false, isVisible: () => false, hide() {}, show() {}, focus() {},
    showInactive() {}, setBounds() {}, setShape() {}, getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    webContents: { mainFrame: frame, isDestroyed: () => false, isLoading: () => false, send: (...args) => sent.push(args) } };
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0); png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(100, 16); png.writeUInt32BE(100, 20);
  const image = { isEmpty: () => false, getSize: () => ({ width: 100, height: 100 }),
    toPNG: () => png, toDataURL: () => 'data:image/png;base64,' + png.toString('base64') };
  const request = options.fetch || (async () => { throw new Error('Unexpected network access'); });
  function BrowserWindow() {}
  BrowserWindow.fromWebContents = () => window;
  const electron = { app: { isPackaged: false, requestSingleInstanceLock: () => true, quit() {}, on() {},
      getPath: () => 'X:/test-profile', getVersion: () => '0.4.0-preview.1', getName: () => 'ppt-ai', whenReady: () => ({ then() {} }) },
    BrowserWindow, ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; } },
    screen: { getPrimaryDisplay: () => ({ id: 1, scaleFactor: 1,
      bounds: { x: 0, y: 0, width: 100, height: 100 }, workArea: { x: 0, y: 0, width: 100, height: 100 } }) },
    globalShortcut: {}, session: {}, shell: {}, Menu: {}, Tray: function () {}, clipboard: {},
    desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: image }] },
    nativeImage: { createFromBuffer: () => image }, net: { fetch: request },
    safeStorage: { isEncryptionAvailable: () => options.encryption !== false,
      decryptString: () => { if (options.decryptFails) throw new Error('decryption failed'); return 'test-encrypted-key'; },
      encryptString: () => Buffer.from('encrypted-value') } };
  const fileApi = { mkdirSync() {}, existsSync: () => true, statSync: () => ({ size: 487601967 }),
    readFileSync: name => files.get(name) || JSON.stringify(options.settings || {}),
    appendFileSync: (_name, body) => logs.push(String(body)),
    openSync: name => { handles.set(++fd, name); return fd; }, fsyncSync() {}, closeSync() {},
    writeFileSync: (target, body) => { const name = typeof target === 'number' ? handles.get(target) : target;
      files.set(name, String(body)); writes.push({ name, body: String(body) }); },
    copyFileSync: (from, to) => files.set(to, files.get(from) || JSON.stringify(options.settings || {})),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); }, unlinkSync: name => files.delete(name) };
  const modules = { electron, fs: fileApi, path, os: { cpus: () => Array(4) }, string_decoder: { StringDecoder },
    child_process: { spawn: () => { throw new Error('Unexpected subprocess'); } },
    'opencc-js': { Converter: () => value => value }, koffi: { load: () => ({ func: () => () => true }) },
    './screen-layout': { findBlankRect: () => null, isBlankRect: () => ({ blank: true }), planTranslations: async () => ({ cards: [], missing: [] }) },
    './screen-surface': { bindScreenSurface() {}, coverScreen: () => ({ coverageOk: true }) },
    './local-ocr': { createLocalOCR: () => ({ dispose() {} }) },
    './native-text': { extractNativeText: async () => ({ regions: [] }) },
    './text-measurer': { createTextMeasurer: () => ({ dispose() {} }) },
    './managed-asr': { createManagedAsr: () => ({ start: async () => {}, dispose() {}, recognize: async () => ({ text: options.asrText || '这是课堂提问' }) }) } };
  const context = vm.createContext({ require(name) {
    if (!(name in modules)) throw new Error('Unexpected require: ' + name); return modules[name];
  }, __dirname: path.join(root, 'app/m1'), process: { pid: 1, platform: 'win32', env: {}, resourcesPath: 'X:/resources' },
    Buffer, FormData, Blob, AbortController, AbortSignal, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, testWindow: window });
  const source = fs.readFileSync(path.join(root, 'app/m1/main.js'), 'utf8');
  vm.runInContext(source + '\npet=testWindow; panel=testWindow; this.api={getApiKey,handleAsr,handleAsk,captureScreen,installIpc};', context);
  return { ...context.api, writes, logs, sent, handlers, files, event: { sender: window.webContents, senderFrame: frame } };
}

test('encrypted configuration is required and decrypt failures do not leak values', () => {
  assert.equal(harness({ settings: { apiKeyEnc: 'YQ==' } }).getApiKey(), 'test-encrypted-key');
  for (const options of [{}, { settings: { apiKey: 'plaintext-not-supported' } },
    { settings: { apiKeyEnc: 'YQ==' }, encryption: false }, { settings: { apiKeyEnc: 'YQ==' }, decryptFails: true }]) {
    const h = harness(options); assert.equal(h.getApiKey(), ''); assert.ok(!h.logs.join('').includes('plaintext-not-supported'));
  }
});

test('captureScreen returns a memory image and geometry without screenshot files', async () => {
  const h = harness(), capture = await h.captureScreen();
  assert.equal(capture.pixelSize.width, 100); assert.equal(capture.bounds.height, 100);
  assert.equal(capture.image.getSize().height, 100); assert.equal(h.writes.length, 0);
});

test('ASR returns text without persisting audio or transcription', async () => {
  const text = '这是私密课堂测试文本', h = harness({ asrText: text });
  assert.equal((await h.handleAsr(Buffer.from('test-wave').toString('base64'))).text, text);
  assert.equal(h.writes.length, 0); assert.ok(!h.logs.join('').includes(text));
  assert.equal((await h.handleAsr('bad base64!')).ok, false);
});

test('current request-object limits reject invalid input before networking', async () => {
  const h = harness();
  for (const payload of [{ requestId: 'a', text: '字'.repeat(301) }, { requestId: 'b', text: 'q', imageDataUrls: [null] },
    { requestId: 'c', text: 'q', imageDataUrls: Array(6).fill('data:image/png;base64,YQ==') }]) {
    assert.equal((await h.handleAsk(payload)).ok, false);
  }
});

test('provider error bodies are not exposed to UI or logs', async () => {
  const secret = 'upstream-private-body';
  const h = harness({ settings: { apiKeyEnc: 'YQ==' }, fetch: async () => ({ ok: false, status: 401, text: async () => secret }) });
  assert.equal((await h.handleAsk({ requestId: 'error-case', text: 'q', imageDataUrls: [] })).ok, false);
  assert.ok(!JSON.stringify(h.sent).includes(secret)); assert.ok(!h.logs.join('').includes(secret));
});

test('current request streams an answer without persisting its content', async () => {
  let request;
  const h = harness({ settings: { apiKeyEnc: 'YQ==' }, fetch: async (url, init) => {
    request = { url, init }; let done = false;
    return { ok: true, body: { getReader: () => ({ read: async () => {
      if (done) return { done: true }; done = true;
      return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"私密答案"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') };
    } }) } };
  } });
  assert.equal((await h.handleAsk({ requestId: 'stream-case', text: '私密问题', imageDataUrls: [] })).ok, true);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.ok(h.sent.some(([channel, payload]) => channel === 'm1:delta' && payload.text === '私密答案'));
  assert.equal(h.writes.length, 0); assert.ok(!h.logs.join('').includes('私密'));
});

test('atomic Key saving writes encrypted content rather than plaintext', async () => {
  const h = harness(); h.installIpc();
  assert.equal((await h.handlers['m1:saveKey'](h.event, 'sk-example-private-key')).ok, true);
  assert.ok(h.writes.length > 0); assert.ok(!JSON.stringify(h.writes).includes('sk-example-private-key'));
  assert.ok([...h.files.values()].some(value => JSON.parse(value).apiKeyEnc));
});

const fragment = (text, x, y, width, height = 40) => ({ text, rect: { x, y, width, height }, confidence: 0.95 });
test('English x-height differences preserve one left-to-right sentence', () => {
  const value = reconstructLines([fragment('east.', 430, 8, 80), fragment('sun', 95, 21, 65, 27),
    fragment('The', 0, 8, 75), fragment('rises', 180, 21, 95, 27), fragment('in the', 295, 8, 110)]);
  assert.equal(value.lines.length, 1); assert.equal(value.lines[0].text, 'The sun rises in the east.');
});
test('Chinese words and a low period join without invented spaces', () => {
  const value = reconstructLines([fragment('。', 265, 31, 8, 8), fragment('同伴讨论', 135, 0, 120), fragment('请先与', 0, 0, 120)]);
  assert.equal(value.lines.length, 1); assert.equal(value.lines[0].text, '请先与同伴讨论。'); assert.equal(value.glyphHeight, 40);
});
test('separate rows retain their vertical reading order', () => {
  const value = reconstructLines([fragment('Second', 0, 100, 110), fragment('First', 0, 0, 90)]);
  assert.deepEqual(value.lines.map(line => line.text), ['First', 'Second']);
});
