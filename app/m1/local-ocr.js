'use strict';

// A bounded, cancellable local subprocess. Screen content travels over stdin only;
// stdout is a single JSON object and neither is written to a log or a temp file.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { reconstructLines } = require('./ocr-lines');

const MAX_INPUT_BYTES = 48 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 60000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const abortError = () => Object.assign(new Error('本次文字识别已取消'), { name: 'AbortError' });

function createLocalOCR({ app, resourcesPath = process.resourcesPath, log = () => {} } = {}) {
  const runtime = app?.isPackaged ? path.join(resourcesPath, 'ocr-runtime') : path.resolve(__dirname, '..', 'ocr-runtime');
  const executable = path.join(runtime, 'python', 'python.exe');
  // Python is an external process and cannot open a file inside app.asar.
  const worker = app?.isPackaged ? path.join(resourcesPath, 'ocr-worker.py') : path.join(__dirname, 'ocr-worker.py');
  const active = new Set();
  let disposed = false;
  const required = ['ch_PP-OCRv4_det_mobile.onnx', 'ch_PP-OCRv4_rec_mobile.onnx', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'ppocr_keys_v1.txt'];
  const available = () => !disposed && fs.existsSync(executable) && fs.existsSync(worker) &&
    fs.existsSync(path.join(runtime, 'site-packages', 'rapidocr', '__init__.py')) &&
    required.every(name => fs.existsSync(path.join(runtime, 'models', name)));

  function run(input, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted || disposed) { reject(abortError()); return; }
      let child, output = '', outputBytes = 0, settled = false, timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (child) active.delete(child);
        if (error) { try { child?.kill(); } catch (_) {} reject(error); } else resolve(value);
      };
      const cancel = () => finish(abortError());
      try {
        child = spawn(executable, ['-I', '-B', worker, runtime], {
          windowsHide: true, shell: false, cwd: runtime, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
            OMP_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4', MKL_NUM_THREADS: '4' }
        });
        active.add(child);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > MAX_OUTPUT_BYTES) finish(new Error('本地识别结果过大，请缩小选区'));
          else output += chunk;
        });
        // Upstream diagnostic output may contain model paths; never forward source
        // text, arbitrary stderr, or a Python traceback to the classroom panel.
        child.stderr.on('data', () => {});
        child.on('error', () => finish(new Error('本地文字识别组件无法启动')));
        child.stdin.on('error', () => { if (!settled) finish(new Error('本地文字识别输入未完成')); });
        child.on('close', code => {
          if (settled) return;
          try {
            const result = JSON.parse(output.trim());
            if (code !== 0 || !result || result.ok !== true || !Array.isArray(result.regions)) {
              if (typeof result?.code === 'string' && /^ocr-[a-z-]{1,50}$/.test(result.code)) log('OCR_FAILURE code=' + result.code);
              finish(new Error(typeof result?.error === 'string' ? result.error : '本地文字识别未完成')); return;
            }
            finish(null, result);
          } catch (_) { finish(new Error('本地文字识别返回格式异常')); }
        });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted || disposed) { cancel(); return; }
        timer = setTimeout(() => finish(new Error('本地文字识别等待超时，请缩小选区后重试')), TIMEOUT_MS);
        child.stdin.end(input, 'utf8');
      } catch (_) { finish(new Error('本地文字识别组件无法启动')); }
    });
  }

  async function recognize({ image, bounds, regions, signal, snapshotId } = {}) {
    if (signal?.aborted || disposed) throw abortError();
    const source = (Array.isArray(regions) ? regions : []).slice(0, 5);
    const failAll = diagnostic => ({ provider: 'rapidocr', snapshotId, diagnostic,
      regions: source.map(region => ({ id: region.id, rect: region.rect, text: '', lines: [],
        confidence: 0, glyphHeight: null, provider: 'rapidocr', error: diagnostic })) });
    if (!available()) return failAll('本地识别组件尚未准备好，请检查安装资源');
    if (!image || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(finite) ||
        bounds.width <= 0 || bounds.height <= 0) return failAll('识别画面坐标无效');
    const size = image.getSize(1), entries = [], crops = [];
    if (!size.width || !size.height || size.width * size.height > 40 * 1024 * 1024) return failAll('识别画面尺寸不受支持');
    for (const region of source) {
      const rect = region?.rect;
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(finite) || rect.width <= 0 || rect.height <= 0 ||
          rect.x < bounds.x - 0.01 || rect.y < bounds.y - 0.01 ||
          rect.x + rect.width > bounds.x + bounds.width + 0.01 || rect.y + rect.height > bounds.y + bounds.height + 0.01) {
        entries.push({ region, error: '文字选区超出识别画面' }); continue;
      }
      const x = Math.max(0, Math.floor((rect.x - bounds.x) * size.width / bounds.width));
      const y = Math.max(0, Math.floor((rect.y - bounds.y) * size.height / bounds.height));
      const right = Math.min(size.width, Math.ceil((rect.x + rect.width - bounds.x) * size.width / bounds.width));
      const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height - bounds.y) * size.height / bounds.height));
      if (right - x < 2 || bottom - y < 2) { entries.push({ region, error: '文字选区过小' }); continue; }
      const cropRect = { x, y, width: right - x, height: bottom - y };
      const png = image.crop(cropRect).toPNG();
      entries.push({ region, cropRect });
      crops.push({ id: String(region.id), png: png.toString('base64') });
    }
    const input = JSON.stringify({ version: 1, regions: crops });
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) return failAll('识别画面过大，请缩小选区');
    let output;
    try { output = crops.length ? await run(input, signal) : { regions: [] }; }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      log('OCR_UNAVAILABLE'); return failAll(error.message);
    }
    if (signal?.aborted || disposed) throw abortError();
    const indexed = new Map(output.regions.map(region => [String(region.id), region]));
    const mapped = entries.map(({ region, cropRect, error }) => {
      const result = indexed.get(String(region.id));
      const base = { id: region.id, rect: { ...region.rect }, text: '', lines: [], confidence: 0,
        glyphHeight: null, provider: 'rapidocr', snapshotId };
      if (error || !result || result.error) return { ...base, error: error || result?.error || '未取得该选区文字' };
      if (!Array.isArray(result.lines) || result.lines.length > 600) return { ...base, error: '本区文字行过多或识别不完整，请缩小选区' };
      const fragments = result.lines.flatMap(line => {
        if (!line || !Array.isArray(line.box) || line.box.length !== 4 || !line.box.every(point =>
          Array.isArray(point) && point.length === 2 && point.every(finite))) return [];
        const xs = line.box.map(point => Math.max(0, Math.min(cropRect.width, point[0])));
        const ys = line.box.map(point => Math.max(0, Math.min(cropRect.height, point[1])));
        const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
        const text = String(line.text || '').trim();
        if (!text || right <= left || bottom <= top) return [];
        const confidence = finite(line.confidence) ? Math.max(0, Math.min(1, line.confidence)) : 0;
        return [{ text, confidence, rect: {
          x: bounds.x + (cropRect.x + left) * bounds.width / size.width,
          y: bounds.y + (cropRect.y + top) * bounds.height / size.height,
          width: (right - left) * bounds.width / size.width,
          height: (bottom - top) * bounds.height / size.height
        } }];
      });
      const { lines, glyphHeight } = reconstructLines(fragments);
      if (!lines.length) return { ...base, error: '没有识别到清晰文字，请重新圈选或校正原文' };
      const left = Math.min(...lines.map(line => line.rect.x));
      const top = Math.min(...lines.map(line => line.rect.y));
      const right = Math.max(...lines.map(line => line.rect.x + line.rect.width));
      const bottom = Math.max(...lines.map(line => line.rect.y + line.rect.height));
      const confidence = lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length;
      return { ...base, text: lines.map(line => line.text).join('\n'), lines,
        rect: { x: left, y: top, width: right - left, height: bottom - top },
        selectionRect: { ...region.rect }, glyphHeight,
        confidence, lowConfidence: confidence < 0.8 || lines.some(line => line.minConfidence < 0.6) };
    });
    // Only counts and provider states are logged; source/translated text is omitted.
    log('OCR_DONE regions=' + mapped.length + ' recognized=' + mapped.filter(region => !region.error).length);
    return { provider: 'rapidocr', snapshotId, regions: mapped };
  }

  return { recognize, available, dispose() {
    disposed = true;
    for (const child of active) { try { child.kill(); } catch (_) {} }
    active.clear();
  } };
}

module.exports = { createLocalOCR };
