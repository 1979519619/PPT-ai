'use strict';

// Optional read-only Office metadata. Same-frame OCR remains authoritative:
// callers must corroborate text before using native font/geometry information.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const validRect = rect => rect && ['x', 'y', 'width', 'height'].every(key => finite(rect[key])) &&
  rect.width > 0 && rect.height > 0;
const contained = (rect, bounds, tolerance = 0.5) => validRect(rect) && validRect(bounds) &&
  rect.x >= bounds.x - tolerance && rect.y >= bounds.y - tolerance &&
  rect.x + rect.width <= bounds.x + bounds.width + tolerance &&
  rect.y + rect.height <= bounds.y + bounds.height + tolerance;
const unavailable = diagnostic => ({ regions: [], provider: 'native', diagnostic });

function extractNativeText(options = {}) {
  const { screenBounds, pixelSize, context, signal } = options;
  if (process.platform !== 'win32') return Promise.resolve(unavailable('native-platform-unavailable'));
  if (signal?.aborted) return Promise.resolve(unavailable('native-aborted'));
  if (!context?.showing || context.tracking !== 'slide' || !Number.isSafeInteger(context.showHwnd) ||
      context.showHwnd <= 0 || typeof context.pageKey !== 'string' || context.pageKey.length > 512 ||
      !validRect(screenBounds) || !pixelSize || !finite(pixelSize.width) || !finite(pixelSize.height) ||
      pixelSize.width < 1 || pixelSize.height < 1 || pixelSize.width > 32768 || pixelSize.height > 32768) {
    return Promise.resolve(unavailable('native-context-unavailable'));
  }
  const regions = (Array.isArray(options.regions) ? options.regions : []).slice(0, 5)
    .filter(region => region && contained(region.rect, screenBounds))
    .map(region => ({ id: String(region.id), rect: { ...region.rect } }));
  if (!regions.length) return Promise.resolve(unavailable('native-no-regions'));
  const script = options.app?.isPackaged
    ? path.join(options.resourcesPath || process.resourcesPath || '', 'slide-text.ps1')
    : path.join(__dirname, 'slide-text.ps1');
  if (!fs.existsSync(script)) return Promise.resolve(unavailable('native-helper-missing'));
  const request = {
    regions, screenBounds, pixelSize,
    showHwnd: context.showHwnd, pageKey: context.pageKey,
    ownerPid: Number.isSafeInteger(options.ownerPid) ? options.ownerPid : process.pid,
    snapshotId: String(options.snapshotId || '').slice(0, 160)
  };

  return new Promise(resolve => {
    let child, timer, finished = false, output = '', byteCount = 0;
    const finish = (result, kill = false) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (kill && child && !child.killed) { try { child.kill(); } catch (_) {} }
      resolve(result);
    };
    const abort = () => finish(unavailable('native-aborted'), true);
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta',
        '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (_) { finish(unavailable('native-helper-unavailable')); return; }
    timer = setTimeout(() => finish(unavailable('native-timeout'), true), 6500);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (finished) return;
      byteCount += Buffer.byteLength(data, 'utf8');
      if (byteCount > 768 * 1024) { finish(unavailable('native-output-limit'), true); return; }
      output += data;
    });
    // Office error messages can contain document information. Do not retain them.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => finish(unavailable('native-input-unavailable'), true));
    child.on('error', () => finish(unavailable('native-helper-unavailable')));
    child.on('close', code => {
      if (finished) return;
      if (code !== 0) { finish(unavailable('native-helper-unavailable')); return; }
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if (!result || result.pageKey !== context.pageKey ||
            result.snapshotId !== request.snapshotId || !Array.isArray(result.regions)) {
          finish(unavailable('native-response-mismatch')); return;
        }
        const provider = result.provider === 'powerpoint' || result.provider === 'wps' ? result.provider : 'native';
        const accepted = [];
        for (const source of result.regions.slice(0, 5)) {
          const selected = regions.find(region => region.id === String(source.id));
          if (!selected || typeof source.text !== 'string' || !source.text.trim() || source.text.length > 20000 ||
              !contained(source.rect, selected.rect, 1) || !Array.isArray(source.lines) || source.lines.length > 400) continue;
          const lines = source.lines.filter(line => line && typeof line.text === 'string' &&
            line.text.length <= 10000 && contained(line.rect, selected.rect, 1)).map(line => ({
            text: line.text, rect: { ...line.rect }, confidence: 1,
            ...(finite(line.fontSize) && line.fontSize > 0 && line.fontSize <= 2048 ? { fontSize: line.fontSize } : {}),
            ...(finite(line.fontPoints) && line.fontPoints > 0 && line.fontPoints <= 4000 ? { fontPoints: line.fontPoints } : {}),
            mixedFont: line.mixedFont === true
          }));
          if (!lines.length || lines.length !== source.lines.length) continue;
          accepted.push({ id: selected.id, text: source.text, rect: { ...source.rect }, lines,
            glyphHeight: finite(source.glyphHeight) && source.glyphHeight > 0 ? source.glyphHeight : undefined,
            ...(finite(source.fontSize) && source.fontSize > 0 && source.fontSize <= 2048 ? { fontSize: source.fontSize } : {}),
            mixedFont: source.mixedFont === true, confidence: 1, provider });
        }
        finish({ regions: accepted, provider, diagnostic: accepted.length ? 'native-available' :
          (typeof result.diagnostic === 'string' && /^[a-z0-9-]{1,80}$/.test(result.diagnostic)
            ? result.diagnostic : 'native-no-supported-text') });
      } catch (_) { finish(unavailable('native-response-invalid')); }
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

module.exports = { extractNativeText };
