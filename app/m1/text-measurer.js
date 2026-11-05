'use strict';

const path = require('path');

function measurementError(code, aborted = false) {
  const error = new Error(aborted ? '本次排版已取消' : '文字排版测量暂不可用，请在回答框查看全文');
  error.code = code;
  if (aborted) error.name = 'AbortError';
  return error;
}

/**
 * A lazy, hidden local renderer. It is created only during a real translation
 * request, not while this module is imported. All sizes are CSS/DIP pixels.
 * measure([{id,text,width,fontSizes}], {signal}) -> [{id,measurements:[...]}].
 */
function createTextMeasurer({ BrowserWindow, log = () => {} }) {
  let win = null, contents = null, ready = null, disposed = false;
  let queue = Promise.resolve();

  function resetWindow() {
    const previous = win;
    win = null; contents = null; ready = null;
    if (previous && !previous.isDestroyed()) previous.destroy();
  }

  function getWindow() {
    if (disposed) return Promise.reject(measurementError('measurer-disposed'));
    if (win && !win.isDestroyed() && ready) return ready;
    win = new BrowserWindow({
      show: false, width: 100, height: 100, skipTaskbar: true, focusable: false,
      frame: false, resizable: false, paintWhenInitiallyHidden: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        zoomFactor: 1, backgroundThrottling: false, partition: 'ppt-ai-text-measure' }
    });
    const created = win;
    contents = created.webContents;
    const createdContents = contents;
    created.setMenu(null);
    createdContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    createdContents.on('will-navigate', event => event.preventDefault());
    createdContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    createdContents.session.setPermissionCheckHandler(() => false);
    createdContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }));
    created.on('closed', () => {
      if (win === created) { win = null; contents = null; ready = null; }
    });
    ready = created.loadFile(path.join(__dirname, 'text-measure.html')).then(() => {
      if (disposed || created.isDestroyed() || createdContents.isDestroyed()) throw measurementError('measure-window-closed');
      createdContents.setZoomFactor(1);
      return createdContents;
    });
    return ready;
  }

  function bounded(promise, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { resetWindow(); reject(error); } else resolve(result);
      };
      const abort = () => finish(measurementError('measure-aborted', true));
      const timer = setTimeout(() => finish(measurementError('measure-timeout')), 12000);
      signal?.addEventListener('abort', abort, { once: true });
      // Attach rejection handling even if cancellation was already requested;
      // the loading/execute promise may still settle after its window is gone.
      Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
      if (signal?.aborted) abort();
    });
  }

  async function execute(requests, signal) {
    if (signal?.aborted) throw measurementError('measure-aborted', true);
    if (disposed) throw measurementError('measurer-disposed');
    if (!Array.isArray(requests) || requests.length > 16 || requests.some(request => String(request?.text || '').length > 32000)) {
      throw measurementError('measure-request-too-large');
    }
    const sanitized = requests.map(request => ({
      id: String(request.id), text: String(request.text || ''),
      width: Number(request.width),
      fontSizes: [...new Set((Array.isArray(request.fontSizes) ? request.fontSizes : [])
        .filter(size => Number.isFinite(size) && size >= 8 && size <= 128))].slice(0, 24)
    }));
    if (sanitized.some(request => !Number.isFinite(request.width) || request.width < 8 || request.width > 16384)) {
      throw measurementError('invalid-measure-width');
    }
    // JSON is an argument expression, never page markup or a shell command.
    const serialized = JSON.stringify(sanitized).replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    try {
      return await bounded((async () => {
        const target = await getWindow();
        if (signal?.aborted) throw measurementError('measure-aborted', true);
        if (target.isDestroyed()) throw measurementError('measure-window-closed');
        const result = await target.executeJavaScript('window.PPTText.measureBatch(' + serialized + ')', false);
        if (!Array.isArray(result)) throw measurementError('invalid-measure-result');
        return result;
      })(), signal);
    } catch (error) {
      if (error?.name !== 'AbortError') log('TEXT_MEASURE_FAILED code=' + (error?.code || 'renderer-error'));
      throw error;
    }
  }

  return {
    measure(requests, { signal } = {}) {
      const result = queue.then(() => execute(requests, signal));
      queue = result.catch(() => {});
      return result;
    },
    dispose() { disposed = true; resetWindow(); }
  };
}

module.exports = { createTextMeasurer };
