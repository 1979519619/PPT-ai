'use strict';

const { BrowserWindow, screen } = require('electron');

const bindings = new WeakMap();
const measurements = new WeakMap();
const visualZoomLocked = new WeakSet();
let nativeApi;
const TOLERANCE_PX = 2;

function windowsApi() {
  if (nativeApi !== undefined) return nativeApi;
  nativeApi = null;
  if (process.platform !== 'win32') return nativeApi;
  try {
    const library = require('koffi').load('user32.dll');
    const api = {
      library,
      setWindowPos: library.func('int __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int width, int height, uint32_t flags)'),
      getWindowRect: library.func('int __stdcall GetWindowRect(intptr_t hwnd, void *rect)'),
      getClientRect: library.func('int __stdcall GetClientRect(intptr_t hwnd, void *rect)'),
      clientToScreen: library.func('int __stdcall ClientToScreen(intptr_t hwnd, void *point)'),
      getWindowProcess: library.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *processId)'),
      getDpiForWindow: null,
    };
    try { api.getDpiForWindow = library.func('uint32_t __stdcall GetDpiForWindow(intptr_t hwnd)'); } catch (_) {}
    nativeApi = api;
  } catch (_) {}
  return nativeApi;
}

function liveAppWindow(win) {
  return win instanceof BrowserWindow && !win.isDestroyed() &&
    win.webContents && !win.webContents.isDestroyed();
}

function copyRect(rect) {
  if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) ||
      rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function closeRect(actual, expected) {
  return !!actual && !!expected && ['x', 'y', 'width', 'height'].every(key =>
    Math.abs(actual[key] - expected[key]) <= TOLERANCE_PX);
}

function lockZoom(win) {
  const contents = win.webContents;
  try {
    if (typeof contents.setZoomMode === 'function' &&
        (typeof contents.getZoomMode !== 'function' || contents.getZoomMode() !== 'isolated')) {
      contents.setZoomMode('isolated');
    }
    if (typeof contents.getZoomFactor !== 'function' || Math.abs(contents.getZoomFactor() - 1) > 0.0001) {
      contents.setZoomFactor(1);
    }
  } catch (_) {}
  if (!visualZoomLocked.has(contents) && typeof contents.setVisualZoomLevelLimits === 'function') {
    visualZoomLocked.add(contents);
    try { Promise.resolve(contents.setVisualZoomLevelLimits(1, 1)).catch(() => {}); } catch (_) {}
  }
}

function nativeHandle(win) {
  const value = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(value)) return null;
  if (value.length === 8) return value.readBigUInt64LE(0);
  if (value.length === 4) return value.readUInt32LE(0);
  return null;
}

function measure(api, hwnd) {
  const outer = Buffer.alloc(16), client = Buffer.alloc(16), origin = Buffer.alloc(8);
  const actual = { actualWindowPixels: null, actualClientPixels: null, dpi: null };
  if (api.getWindowRect(hwnd, outer)) {
    actual.actualWindowPixels = {
      x: outer.readInt32LE(0), y: outer.readInt32LE(4),
      width: outer.readInt32LE(8) - outer.readInt32LE(0),
      height: outer.readInt32LE(12) - outer.readInt32LE(4),
    };
  }
  if (api.getClientRect(hwnd, client)) {
    origin.writeInt32LE(client.readInt32LE(0), 0);
    origin.writeInt32LE(client.readInt32LE(4), 4);
    if (api.clientToScreen(hwnd, origin)) {
      actual.actualClientPixels = {
        x: origin.readInt32LE(0), y: origin.readInt32LE(4),
        width: client.readInt32LE(8) - client.readInt32LE(0),
        height: client.readInt32LE(12) - client.readInt32LE(4),
      };
    }
  }
  try {
    const dpi = api.getDpiForWindow ? api.getDpiForWindow(hwnd) : 0;
    if (dpi > 0) actual.dpi = dpi;
  } catch (_) {}
  return actual;
}

function report(win, result, logger) {
  if (typeof logger !== 'function') return;
  const metadata = {
    coverageOk: result.coverageOk,
    reason: result.reason, nativeAvailable: result.nativeAvailable, attempted: result.attempted,
    expectedBounds: result.expectedBounds, expectedPixels: result.expectedPixels,
    actualWindowPixels: result.actualWindowPixels, actualClientPixels: result.actualClientPixels,
    dpi: result.dpi, zoomFactor: result.zoomFactor,
  };
  const state = measurements.get(win) || {};
  const encoded = JSON.stringify(metadata);
  if (encoded === state.lastLog) return;
  state.lastLog = encoded; measurements.set(win, state);
  try { logger('SCREEN_SURFACE ' + encoded); } catch (_) {}
}

/**
 * coverScreen(win, display?, log?) -> physical client coverage metadata.
 * Only moves an already-visible window owned by this Electron main process.
 * It does not activate/show windows or change process/thread DPI awareness.
 */
function coverScreen(win, display = screen.getPrimaryDisplay(), logger) {
  const result = {
    coverageOk: false, expectedBounds: copyRect(display?.bounds), expectedPixels: null,
    actualWindowPixels: null, actualClientPixels: null, dpi: null, zoomFactor: null,
    attempted: false, nativeAvailable: false, reason: 'not-ready',
  };
  if (!liveAppWindow(win) || !result.expectedBounds) return result;
  const state = measurements.get(win) || {};
  if (state.busy) return { ...result, reason: 'reentrant' };
  state.busy = true; measurements.set(win, state);
  try {
    lockZoom(win);
    try { result.zoomFactor = win.webContents.getZoomFactor(); } catch (_) {}
    // Electron converts the target monitor's DIP rectangle once; Win32 receives
    // physical coordinates. Do not multiply this rectangle by DPI again.
    result.expectedPixels = copyRect(screen.dipToScreenRect(null, result.expectedBounds));
    if (!result.expectedPixels) { result.reason = 'invalid-display'; return result; }
    const api = windowsApi();
    if (!api) { result.reason = 'native-unavailable'; return result; }
    result.nativeAvailable = true;
    const hwnd = nativeHandle(win);
    if (hwnd === null || hwnd === 0 || hwnd === 0n) { result.reason = 'invalid-handle'; return result; }
    const owner = Buffer.alloc(4);
    if (!api.getWindowProcess(hwnd, owner) || owner.readUInt32LE(0) !== process.pid) {
      result.reason = 'not-owned'; return result;
    }
    Object.assign(result, measure(api, hwnd));
    result.coverageOk = closeRect(result.actualClientPixels, result.expectedPixels);
    if (!win.isVisible()) { result.reason = 'hidden'; return result; }
    if (!result.coverageOk) {
      result.attempted = true;
      const pixels = result.expectedPixels;
      // NOACTIVATE | NOSENDCHANGING. Deliberately omit SHOWWINDOW and do not
      // bind a resize listener: native repositioning must not recurse forever.
      const changed = api.setWindowPos(hwnd, -1, Math.round(pixels.x), Math.round(pixels.y),
        Math.round(pixels.width), Math.round(pixels.height), 0x0410);
      Object.assign(result, measure(api, hwnd));
      result.coverageOk = closeRect(result.actualClientPixels, pixels);
      result.reason = result.coverageOk ? 'covered' : changed ? 'client-mismatch' : 'position-failed';
    } else result.reason = 'covered';
    return result;
  } catch (_) {
    result.coverageOk = false; result.reason = 'native-error'; return result;
  } finally {
    state.busy = false;
    report(win, result, logger);
  }
}

/**
 * bindScreenSurface(win, {display?, getDisplay?, log?, initialize?})
 * Returns {cover(), dispose()}; it adds listeners without replacing main's.
 */
function bindScreenSurface(win, options = {}) {
  if (!liveAppWindow(win)) return { cover: () => ({ coverageOk: false }), dispose() {} };
  const existing = bindings.get(win);
  if (existing) return existing;
  // Capture the emitter while the native window is alive. Accessing the
  // BrowserWindow.webContents getter from its 'closed' event can throw.
  const contents = win.webContents;
  let disposed = false;
  const getDisplay = typeof options.getDisplay === 'function' ? options.getDisplay :
    () => options.display || screen.getPrimaryDisplay();
  const cover = () => {
    if (disposed || !liveAppWindow(win)) return { coverageOk: false, reason: 'destroyed' };
    return coverScreen(win, getDisplay(), options.log);
  };
  const loaded = () => { if (!disposed && liveAppWindow(win)) { lockZoom(win); if (win.isVisible()) cover(); } };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // EventEmitter cleanup needs no live native object or destruction queries.
    win.removeListener('ready-to-show', cover);
    win.removeListener('show', cover);
    win.removeListener('enter-full-screen', cover);
    win.removeListener('closed', dispose);
    contents.removeListener('did-finish-load', loaded);
    contents.removeListener('destroyed', dispose);
    visualZoomLocked.delete(contents);
    bindings.delete(win); measurements.delete(win);
  };
  const binding = { cover, dispose };
  bindings.set(win, binding);
  win.on('ready-to-show', cover);
  win.on('show', cover);
  win.on('enter-full-screen', cover);
  win.on('closed', dispose);
  contents.on('did-finish-load', loaded);
  contents.once('destroyed', dispose);
  lockZoom(win);
  if (options.initialize !== false && win.isVisible()) cover();
  return binding;
}

module.exports = { bindScreenSurface, coverScreen };
