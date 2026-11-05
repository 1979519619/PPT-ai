'use strict';

// Coordinates accepted and returned here are global logical screen pixels.
// Blank detection is a conservative local pixel heuristic, not a content guarantee.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function rectOf(value) {
  const rect = value && (value.rect || value.bbox || value);
  if (!rect || !finite(rect.x) || !finite(rect.y)) return null;
  const width = finite(rect.width) ? rect.width : rect.w;
  const height = finite(rect.height) ? rect.height : rect.h;
  return finite(width) && finite(height) && width > 0 && height > 0
    ? { x: rect.x, y: rect.y, width, height } : null;
}

function intersects(a, b, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width > b.x - gap &&
    a.y < b.y + b.height + gap && a.y + a.height > b.y - gap;
}

function inside(rect, bounds, margin = 0) {
  // Only absorb floating point arithmetic noise, never whole screenshot pixels.
  const epsilon = 1e-6;
  return rect.x >= bounds.x + margin - epsilon && rect.y >= bounds.y + margin - epsilon &&
    rect.x + rect.width <= bounds.x + bounds.width - margin + epsilon &&
    rect.y + rect.height <= bounds.y + bounds.height - margin + epsilon;
}

function integral(values, width, height) {
  const stride = width + 1;
  const out = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += values[y * width + x];
      out[(y + 1) * stride + x + 1] = out[y * stride + x + 1] + row;
    }
  }
  return (x, y, w, h) => {
    const right = x + w, bottom = y + h;
    return out[bottom * stride + right] - out[y * stride + right] -
      out[bottom * stride + x] + out[y * stride + x];
  };
}

function imageMatchesBounds(size, bounds) {
  if (!size || !bounds || !finite(size.width) || !finite(size.height) ||
      !finite(bounds.width) || !finite(bounds.height) ||
      size.width <= 0 || size.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return false;
  // Compare the unresized capture with its logical bounds. The cross product
  // allows at most two source pixels of projection error on the shorter axis.
  // A resized short, wide crop can change aspect slightly through integer
  // rounding; that is not evidence of a mismatched capture.
  return Math.abs(size.width * bounds.height - size.height * bounds.width) <=
    2 * Math.max(bounds.width, bounds.height);
}

const analysisUnavailable = (reason = 'analysis-unavailable') => ({ unavailable: true, reason });

function analyseImage(nativeImage, bounds, maxExtent = 640) {
  if (!bounds || !nativeImage) return analysisUnavailable();
  let image, size, bitmap;
  try {
    if (nativeImage.isEmpty?.()) return analysisUnavailable();
    const original = nativeImage.getSize(1);
    if (!original.width || !original.height) return analysisUnavailable();
    if (!imageMatchesBounds(original, bounds)) return analysisUnavailable('capture-mismatch');
    // Bound local work even on a very tall display; preserve the screenshot aspect.
    const scale = Math.min(1, maxExtent / original.width, maxExtent / original.height);
    image = scale < 1 ? nativeImage.resize({
      width: Math.max(1, Math.round(original.width * scale)),
      height: Math.max(1, Math.round(original.height * scale)), quality: 'good'
    }) : nativeImage;
    size = image.getSize(1);
    bitmap = image.toBitmap({ scaleFactor: 1 });
  } catch (_) { return analysisUnavailable(); }
  const sw = size.width, sh = size.height;
  if (!Number.isInteger(sw) || !Number.isInteger(sh) || sw <= 0 || sh <= 0 ||
      !bitmap || bitmap.length !== sw * sh * 4) return analysisUnavailable('capture-mismatch');
  const lum = new Float64Array(sw * sh), squared = new Float64Array(sw * sh);
  const edges = new Uint8Array(sw * sh);
  for (let i = 0; i < lum.length; i++) {
    const offset = i * 4;
    const value = 0.0722 * bitmap[offset] + 0.7152 * bitmap[offset + 1] + 0.2126 * bitmap[offset + 2];
    lum[i] = value; squared[i] = value * value;
  }
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x, offset = i * 4;
      const neighbors = [i - 1, i + 1, i - sw, i + sw];
      // RGB differences also catch colored text with similar luminance.
      edges[i] = neighbors.some(n => {
        const p = n * 4;
        return Math.max(Math.abs(bitmap[offset] - bitmap[p]),
          Math.abs(bitmap[offset + 1] - bitmap[p + 1]),
          Math.abs(bitmap[offset + 2] - bitmap[p + 2])) > 14;
      }) ? 1 : 0;
    }
  }
  const sum = integral(lum, sw, sh), squareSum = integral(squared, sw, sh);
  const edgeSum = integral(edges, sw, sh);
  return { sw, sh, sum, squareSum, edgeSum };
}

function assessBlank(analysis, rect, bounds) {
  if (!analysis || analysis.unavailable) return { blank: false, reason: analysis?.reason || 'analysis-unavailable' };
  if (!rect || !bounds || !inside(rect, bounds)) return { blank: false, reason: 'analysis-outside-region' };
  const { sw, sh, sum, squareSum, edgeSum } = analysis;
  const sx = clamp(Math.floor((rect.x - bounds.x) * sw / bounds.width), 0, sw - 1);
  const sy = clamp(Math.floor((rect.y - bounds.y) * sh / bounds.height), 0, sh - 1);
  const ex = clamp(Math.ceil((rect.x + rect.width - bounds.x) * sw / bounds.width), sx + 1, sw);
  const ey = clamp(Math.ceil((rect.y + rect.height - bounds.y) * sh / bounds.height), sy + 1, sh);
  const rw = ex - sx, rh = ey - sy, area = rw * rh;
  if (rw < 8 || rh < 8) return { blank: false, reason: 'analysis-unavailable' };
  const mean = sum(sx, sy, rw, rh) / area;
  const variance = Math.max(0, squareSum(sx, sy, rw, rh) / area - mean * mean);
  const edgeCount = edgeSum(sx, sy, rw, rh);
  // A small text island must not disappear inside a large blank average.
  if (variance > 20 || edgeCount > Math.min(10, area * 0.001)) return { blank: false, reason: 'not-blank' };
  for (let ty = sy; ty < ey; ty += 8) {
    for (let tx = sx; tx < ex; tx += 8) {
      if (edgeSum(tx, ty, Math.min(8, ex - tx), Math.min(8, ey - ty)) > 2) return { blank: false, reason: 'not-blank' };
    }
  }
  return { blank: true, tone: mean < 130 ? 'dark' : 'light', variance, edgeCount };
}

/**
 * isBlankRect(nativeImage, globalRect, screenBounds) -> {blank,tone?,reason?}.
 * Check the final candidate against the same full-display screenshot. Cropping
 * before sampling keeps small text more visible than a full-screen thumbnail.
 * A positive result remains a pixel heuristic, not a semantic safety guarantee.
 */
function isBlankRect(nativeImage, globalRect, screenBounds) {
  const bounds = rectOf(screenBounds), rect = rectOf(globalRect);
  const diagnostic = { rect, bounds };
  const failed = reason => ({ blank: false, reason, diagnostic });
  if (!bounds) return failed('invalid-screen-bounds');
  if (!rect) return failed('invalid-candidate');
  if (!inside(rect, bounds)) return failed('candidate-outside-screen');
  if (!nativeImage) return failed('capture-unavailable');
  let image = nativeImage, analysisBounds = bounds, analysisRect = rect;
  try {
    if (nativeImage.isEmpty?.()) return failed('capture-empty');
    const size = nativeImage.getSize(1);
    diagnostic.imageSize = { width: size.width, height: size.height };
    if (!size.width || !size.height) return failed('capture-empty');
    if (!imageMatchesBounds(size, bounds)) return failed('capture-mismatch');
    if (typeof nativeImage.crop === 'function') {
      const x = Math.max(0, Math.floor((rect.x - bounds.x) * size.width / bounds.width));
      const y = Math.max(0, Math.floor((rect.y - bounds.y) * size.height / bounds.height));
      const right = Math.min(size.width, Math.ceil((rect.x + rect.width - bounds.x) * size.width / bounds.width));
      const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height - bounds.y) * size.height / bounds.height));
      const crop = { x, y, width: right - x, height: bottom - y };
      diagnostic.crop = crop;
      if (right <= x || bottom <= y) return failed('empty-pixel-crop');
      image = nativeImage.crop(crop);
      const croppedSize = image.getSize(1);
      if (croppedSize.width !== crop.width || croppedSize.height !== crop.height) return failed('crop-size-mismatch');
      // Analyse the exact integer crop in its own pixel coordinates. Rebuilding
      // a DIP rectangle here used to reject valid regions through round-off.
      analysisBounds = { x: 0, y: 0, width: crop.width, height: crop.height };
      analysisRect = { ...analysisBounds };
    }
  } catch (_) { return failed('pixel-crop-failed'); }
  const result = assessBlank(analyseImage(image, analysisBounds, 960), analysisRect, analysisBounds);
  return result.blank ? { blank: true, tone: result.tone } : failed(result.reason || 'analysis-unavailable');
}

/**
 * Search only below the initial translation candidate, in the same column.
 * x, width, height and font size are kept; only y and the sampled tone change.
 * originals/placed/excluded accept rects or objects with rect/bbox properties.
 * A null result means no verified blank candidate was found inside this screen.
 */
function findTranslationBelow(nativeImage, card, originals = [], placed = [], screenBounds, excluded = []) {
  const bounds = rectOf(screenBounds), initial = rectOf(card);
  if (!nativeImage || !bounds || !initial || !inside(initial, bounds)) return null;
  const blocked = [originals, placed, excluded].flatMap(items =>
    (Array.isArray(items) ? items : []).map(rectOf).filter(Boolean));
  const bottom = bounds.y + bounds.height - initial.height;
  let y = initial.y;
  while (y <= bottom) {
    const rect = { x: initial.x, y, width: initial.width, height: initial.height };
    const obstructions = blocked.filter(other => intersects(rect, other, 5));
    if (obstructions.length) {
      y = Math.max(y + 8, ...obstructions.map(other => other.y + other.height + 8));
      continue;
    }
    const check = isBlankRect(nativeImage, rect, bounds);
    if (check.blank) return { ...card, rect, tone: check.tone || card.tone || 'light' };
    // Invalid image data cannot become valid by shifting the candidate down.
    if (check.reason && check.reason !== 'not-blank') return null;
    y += 8;
  }
  return null;
}

/**
 * findBlankRect(nativeImage, {width,height}, excluded, screenBounds)
 * Returns {x,y,width,height,tone:'light'|'dark'} or null. The image must capture
 * exactly screenBounds, including its full display, rather than its work area.
 * excluded accepts global rects, or objects containing rect/bbox.
 */
function findBlankRect(nativeImage, desired, excluded = [], screenBounds) {
  const bounds = rectOf(screenBounds);
  if (!bounds || !nativeImage || !desired ||
      !finite(desired.width) || !finite(desired.height)) return null;
  const width = Math.ceil(desired.width), height = Math.ceil(desired.height);
  if (width < 40 || height < 24 || width > bounds.width - 24 || height > bounds.height - 24) return null;
  const analysis = analyseImage(nativeImage, bounds);
  if (!analysis || analysis.unavailable) return null;
  const blocked = (Array.isArray(excluded) ? excluded : []).map(rectOf).filter(Boolean);
  const margin = 12, step = Math.max(8, Math.round(Math.min(bounds.width, bounds.height) / 70));
  const xs = [], ys = [];
  const right = Math.floor(bounds.x + bounds.width - margin - width);
  const bottom = Math.floor(bounds.y + bounds.height - margin - height);
  for (let x = Math.ceil(bounds.x + margin); x <= right; x += step) xs.push(x);
  for (let y = Math.ceil(bounds.y + margin); y <= bottom; y += step) ys.push(y);
  if (xs[xs.length - 1] !== right) xs.push(right);
  if (ys[ys.length - 1] !== bottom) ys.push(bottom);
  const candidates = [];
  for (const y of ys) {
    for (const x of xs) {
      const rect = { x, y, width, height };
      if (blocked.some(other => intersects(rect, other, 14))) continue;
      const result = assessBlank(analysis, rect, bounds);
      if (!result.blank) continue;
      // Prefer lower texture, then the right and lower side, with a stable result.
      const score = result.variance + result.edgeCount * 2 +
        ((bounds.x + bounds.width - x - width) / bounds.width) * 0.2 +
        ((bounds.y + bounds.height - y - height) / bounds.height) * 0.1;
      candidates.push({ ...rect, tone: result.tone, score });
      candidates.sort((a, b) => a.score - b.score);
      if (candidates.length > 16) candidates.pop();
    }
  }
  // Verify promising areas against a cropped, higher-resolution image before use.
  // Refuse all candidates when thin/small content appears in this second pass.
  for (const candidate of candidates) {
    const check = isBlankRect(nativeImage, candidate, bounds);
    if (check.blank) {
      const { x, y, width: candidateWidth, height: candidateHeight } = candidate;
      return { x, y, width: candidateWidth, height: candidateHeight, tone: check.tone };
    }
  }
  return null;
}

function estimatedLines(text, width, fontSize) {
  // Transparent text boxes have 4px padding, with editing controls outside the text.
  const capacity = Math.max(1, (width - 8) / fontSize);
  let count = 0;
  for (const line of String(text || '').split('\n')) {
    let units = 0;
    for (const char of line) units += /[\u0020-\u007e]/.test(char) ? 0.58 : 1;
    count += Math.max(1, Math.ceil(units / capacity));
  }
  return count;
}

/**
 * regions: [{id,rect:{x,y,width,height},tone?}] (direct rect or bbox also accepted).
 * texts: strings, {id,text} entries, or an object keyed by region id.
 * Returns {cards:[{id,text,rect,fontSize,tone}], missing:[{id,text,region,reason}]}.
 * Legacy estimate retained for callers outside the new translation pipeline.
 * Production translation placement must use planTranslations + real DOM metrics.
 */
function fitTranslationRects(regions, texts, screenBounds) {
  const bounds = rectOf(screenBounds), cards = [], missing = [];
  const source = (Array.isArray(regions) ? regions : []).map((region, index) => ({
    id: region && region.id != null ? region.id : index,
    rect: rectOf(region), tone: region?.tone === 'dark' ? 'dark' : 'light', index
  }));
  const originals = source.map(item => item.rect).filter(Boolean);
  for (const item of source) {
    let value;
    if (Array.isArray(texts)) {
      value = texts.find(entry => entry && typeof entry === 'object' && String(entry.id) === String(item.id));
      if (value == null) value = texts[item.index];
    } else value = texts && texts[item.id];
    const text = String(value && typeof value === 'object' ? value.text || '' : value || '');
    const region = item.rect;
    const fail = reason => missing.push({ id: item.id, text, region, reason });
    if (!bounds || !region || !inside(region, bounds) || !text.trim()) {
      fail(!text.trim() ? '没有可显示的译文' : '选区超出当前屏幕'); continue;
    }
    // Maintain the selected width and x position; never slide a translation to another line.
    if (region.width < 40) { fail('选区过窄，请手动选择译文位置'); continue; }
    let placed = false;
    for (const fontSize of [24, 22, 20, 18, 16, 14, 12, 10, 8]) {
      const height = Math.max(24, Math.ceil(8 +
        estimatedLines(text, region.width, fontSize) * fontSize * 1.3));
      let y = region.y + region.height + 8;
      // Move below obstructions only, retaining the same horizontal anchor and width.
      for (let attempt = 0; attempt <= originals.length + cards.length; attempt++) {
        const candidate = { x: region.x, y, width: region.width, height };
        const obstructions = originals.concat(cards.map(card => card.rect))
          .filter(other => intersects(candidate, other, 5));
        if (!obstructions.length) break;
        y = Math.max(...obstructions.map(other => other.y + other.height + 8));
      }
      const rect = { x: region.x, y, width: region.width, height };
      if (!inside(rect, bounds, 4) || originals.some(other => intersects(rect, other, 5)) ||
          cards.some(card => intersects(rect, card.rect, 5))) continue;
      cards.push({ id: item.id, sourceIndex: item.index, text, rect, fontSize, tone: item.tone });
      placed = true; break;
    }
    if (!placed) fail('原文下方空间不足，请手动放置或查看完整面板');
  }
  return { cards, missing };
}

function median(values) {
  const sorted = values.filter(value => finite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('本次排版已取消'); error.name = 'AbortError'; throw error;
}

/**
 * Place each translation independently against one frozen source screenshot.
 * `measure` is the isolated renderer's measure(requests,{signal}) function.
 * Source rects/line boxes and glyphHeight are global DIP metrics from OCR;
 * optional fontSize is already converted from native slide points to screen DIP.
 * The legacy character-count helper is deliberately not involved in this path.
 */
async function planTranslations({ regions = [], translations = [], screenBounds,
  image, excluded = [], measure, signal } = {}) {
  const bounds = rectOf(screenBounds), cards = [], missing = [], prepared = [];
  const source = (Array.isArray(regions) ? regions : []).slice(0, 5);
  const translated = Array.isArray(translations) ? translations : [];
  const fail = (item, code, reason, detail = {}) => missing.push({
    id: item.id, sourceIndex: item.sourceIndex, text: item.text,
    region: item.rect, code, reason, detail
  });
  const originals = source.map(rectOf).filter(Boolean);
  const blockers = (Array.isArray(excluded) ? excluded : []).map(rectOf).filter(Boolean);

  for (let index = 0; index < source.length; index++) {
    const region = source[index] || {}, id = region.id == null ? index : region.id;
    const translation = translated.find(value => String(value?.id ?? value?.index) === String(id)) ||
      translated.find(value => value?.index === index);
    const item = { id, sourceIndex: Number.isInteger(translation?.index) ? translation.index : index,
      text: String(translation?.text || ''), rect: rectOf(region), source: region };
    if (!bounds || !item.rect || !inside(item.rect, bounds)) {
      fail(item, 'source-outside-screen', '原文位置与当前屏幕不一致，请重新圈选'); continue;
    }
    if (translation?.error || !item.text.trim()) {
      fail(item, 'translation-unavailable', translation?.error || '这段没有可显示的译文'); continue;
    }
    if (region.error || (finite(region.confidence) && region.confidence < 0.65 && !region.corrected)) {
      fail(item, 'source-unreliable', '原文识别不够可靠，请核对原文后手动放置'); continue;
    }
    item.glyphHeight = finite(region.glyphHeight) && region.glyphHeight > 0 ? region.glyphHeight :
      median((Array.isArray(region.lines) ? region.lines : []).map(line => rectOf(line)?.height));
    item.nativeSize = finite(region.fontSize) && region.fontSize > 0 ? region.fontSize : null;
    if (!item.glyphHeight && !item.nativeSize) {
      fail(item, 'source-metrics-unavailable', '未取得原文字高，请在回答框查看或手动放置'); continue;
    }
    // The 4px text padding is outside the source's visible line bounds, keeping
    // the actual translated glyphs aligned with the original's left edge.
    const left = Math.max(bounds.x + 1, item.rect.x - 4);
    const right = Math.min(bounds.x + bounds.width - 1, item.rect.x + item.rect.width + 4);
    item.column = { x: left, width: right - left };
    if (item.column.width < 40) {
      fail(item, 'source-column-too-narrow', '原文过窄，译文请在回答框查看或手动放置'); continue;
    }
    prepared.push(item);
  }
  if (!prepared.length) return { cards, missing };
  aborted(signal);
  if (typeof measure !== 'function') {
    prepared.forEach(item => fail(item, 'measurement-unavailable', '排版测量不可用，请在回答框查看全文'));
    return { cards, missing };
  }

  let probeResults;
  try {
    probeResults = await measure(prepared.map(item => ({ id: String(item.id), text: item.text,
      width: item.column.width, fontSizes: [32] })), { signal });
  } catch (error) {
    aborted(signal);
    prepared.forEach(item => fail(item, 'measurement-unavailable', '排版测量不可用，请在回答框查看全文',
      { stage: 'font-probe', code: error?.code || 'renderer-error' }));
    return { cards, missing };
  }
  aborted(signal);
  const measurable = [];
  for (const item of prepared) {
    const probe = probeResults?.find(result => String(result.id) === String(item.id))?.measurements?.[0];
    if (!probe || !finite(probe.glyphHeight) || probe.glyphHeight <= 0) {
      fail(item, 'glyph-measurement-unavailable', '无法可靠匹配原文字高，请手动放置'); continue;
    }
    // Prefer native em size when it also matches the visible ink height. A
    // different source typeface can have much shorter ink than Microsoft YaHei;
    // in that case visual glyph matching takes priority over copying its em.
    const calibratedSize = item.glyphHeight ? 32 * item.glyphHeight / probe.glyphHeight : null;
    const nativeInk = item.nativeSize ? probe.glyphHeight * item.nativeSize / 32 : null;
    const nativeCompatible = item.nativeSize && (!item.glyphHeight ||
      (nativeInk >= item.glyphHeight * 0.85 && nativeInk <= item.glyphHeight * 1.1));
    item.targetSize = nativeCompatible ? item.nativeSize : calibratedSize;
    item.targetGlyphHeight = item.glyphHeight || probe.glyphHeight * item.targetSize / 32;
    if (!finite(item.targetSize) || item.targetSize < 8 || item.targetSize > 128) {
      fail(item, 'source-font-out-of-range', '原文字号超出自动匹配范围，请在回答框查看或手动放置',
        { targetFontSize: item.targetSize }); continue;
    }
    // Rounding only affects the editable CSS size. The actual glyph-height
    // interval is checked again after DOM and font measurement.
    item.fontSizes = [...new Set([1, 0.975, 0.95, 0.925, 0.9, 0.875, 0.85]
      .map(factor => Math.round(item.targetSize * factor * 2) / 2)
      .filter(size => size >= 8 && size <= 128))];
    measurable.push(item);
  }
  if (!measurable.length) return { cards, missing };
  let measured;
  try {
    measured = await measure(measurable.map(item => ({ id: String(item.id), text: item.text,
      width: item.column.width, fontSizes: item.fontSizes })), { signal });
  } catch (error) {
    aborted(signal);
    measurable.forEach(item => fail(item, 'measurement-unavailable', '排版测量不可用，请在回答框查看全文',
      { stage: 'paragraph-layout', code: error?.code || 'renderer-error' }));
    return { cards, missing };
  }
  aborted(signal);

  // The coarse integral map only rejects obviously textured candidates. Every
  // accepted candidate is rechecked in its exact, higher-resolution local crop.
  const coarse = analyseImage(image, bounds, 960);
  let examined = 0;
  for (const item of measurable) {
    const measurements = measured?.find(result => String(result.id) === String(item.id))?.measurements;
    if (!Array.isArray(measurements)) {
      fail(item, 'measurement-missing', '这段未取得排版尺寸，请在回答框查看全文'); continue;
    }
    let placed = null, lastFailure = { code: 'no-space-below' };
    for (const measurement of measurements) {
      const { fontSize, glyphHeight } = measurement;
      const height = finite(measurement.height) ? Math.max(24, measurement.height) : null;
      if (!finite(fontSize) || !finite(height) || height <= 0 || measurement.overflow ||
          !finite(glyphHeight) || glyphHeight < item.targetGlyphHeight * 0.85 - 0.25 ||
          glyphHeight > item.targetGlyphHeight * 1.1 + 0.25) {
        lastFailure = { code: 'measured-overflow-or-font-mismatch', fontSize, height, glyphHeight };
        continue;
      }
      const gap = Math.max(8, Math.min(16, item.targetGlyphHeight * 0.2));
      const startY = item.rect.y + item.rect.height + gap;
      const drift = Math.min(160, Math.max(32, item.targetGlyphHeight * 3, item.rect.height));
      const endY = Math.min(startY + drift, bounds.y + bounds.height - height - 1);
      const obstacles = originals.concat(blockers, cards.map(card => card.rect));
      let y = startY;
      lastFailure = { code: 'no-space-below', rect: { x: item.column.x, y, width: item.column.width, height },
        fontSize, maxY: endY };
      while (y <= endY + 1e-6) {
        aborted(signal);
        if (++examined % 64 === 0) { await new Promise(resolve => setImmediate(resolve)); aborted(signal); }
        const rect = { x: item.column.x, y, width: item.column.width, height };
        const obstructions = obstacles.filter(other => intersects(rect, other, 3));
        if (obstructions.length) {
          lastFailure = { code: 'occupied-by-region', rect, fontSize };
          y = Math.max(y + 4, ...obstructions.map(other => other.y + other.height + 4));
          continue;
        }
        if (!inside(rect, bounds, 1)) {
          lastFailure = { code: 'candidate-outside-screen', rect, fontSize }; break;
        }
        const quick = assessBlank(coarse, rect, bounds);
        if (!quick.blank && quick.reason === 'not-blank') {
          lastFailure = { code: 'not-blank', rect, fontSize }; y += 4; continue;
        }
        const check = isBlankRect(image, rect, bounds);
        if (check.blank) {
          placed = { id: item.id, sourceIndex: item.sourceIndex, text: item.text, rect,
            fontSize, tone: check.tone || 'light', sourceGlyphHeight: item.targetGlyphHeight,
            placement: 'auto-below', provider: item.source.provider || 'ocr' };
          break;
        }
        lastFailure = { code: check.reason || 'analysis-unavailable', rect, fontSize,
          diagnostic: check.diagnostic };
        // Moving down cannot repair missing or mismatched image data.
        if (check.reason !== 'not-blank') break;
        y += 4;
      }
      if (placed) break;
      if (lastFailure.code !== 'not-blank' && lastFailure.code !== 'no-space-below' &&
          lastFailure.code !== 'occupied-by-region' && lastFailure.code !== 'measured-overflow-or-font-mismatch' &&
          lastFailure.code !== 'candidate-outside-screen') break;
    }
    if (placed) cards.push(placed);
    else fail(item, lastFailure.code, '原文下方无法完整放入相近字号的译文，已保留在回答框，可手动放置', lastFailure);
  }
  return { cards, missing };
}

module.exports = { findBlankRect, isBlankRect, fitTranslationRects, findTranslationBelow, planTranslations };
