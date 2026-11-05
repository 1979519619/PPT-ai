'use strict';

// OCR detection boxes are fragments, not an authoritative reading order. Rebuild
// visible rows in screen coordinates so differences in capital/x-height do not
// turn one large English sentence into several out-of-order paragraphs.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const median = values => {
  const sorted = values.filter(value => finite(value) && value > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const punctuationOnly = text => /^[.,，。;；:：!！?？、…'"“”‘’()（）\[\]【】]+$/u.test(text);
const right = rect => rect.x + rect.width;
const bottom = rect => rect.y + rect.height;
const center = rect => rect.y + rect.height / 2;
const latinOrNumber = character => /[A-Za-z0-9\u00c0-\u024f]/u.test(character || '');
const han = character => /[\u3400-\u9fff]/u.test(character || '');

function union(rects) {
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(right)) - x, height: Math.max(...rects.map(bottom)) - y };
}

function needsSpace(previous, next) {
  const a = Array.from(previous).at(-1), b = Array.from(next)[0];
  if (!a || !b || /\s/u.test(a) || /\s/u.test(b)) return false;
  if (/[.,，。;；:：!！?？、…'"”’\)）\]】]/u.test(b) || /[\(（\[【“‘]/u.test(a)) return false;
  if (han(a) || han(b)) return false;
  return latinOrNumber(a) && latinOrNumber(b) || /[.,;:!?]/u.test(a) && latinOrNumber(b);
}

function reconstructLines(value) {
  const fragments = (Array.isArray(value) ? value : []).filter(item => item && item.rect &&
    [item.rect.x, item.rect.y, item.rect.width, item.rect.height].every(finite) && item.rect.width > 0 &&
    item.rect.height > 0 && String(item.text || '').trim()).map((item, index) => ({
      text: String(item.text).trim(), rect: { ...item.rect }, index,
      confidence: finite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0
    }));
  const bodies = fragments.filter(item => !punctuationOnly(item.text));
  const punctuation = fragments.filter(item => punctuationOnly(item.text));
  const rows = [];
  const add = (row, fragment) => {
    row.fragments.push(fragment);
    row.bodyRect = union(row.fragments.filter(item => !punctuationOnly(item.text)).map(item => item.rect));
    row.bodyCenter = median(row.fragments.filter(item => !punctuationOnly(item.text)).map(item => center(item.rect)));
  };

  bodies.sort((a, b) => center(a.rect) - center(b.rect) || a.rect.x - b.rect.x || a.index - b.index);
  for (const fragment of bodies) {
    let best = null, bestScore = Infinity;
    for (const row of rows) {
      const a = fragment.rect, b = row.bodyRect;
      const overlap = Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
      const scale = Math.max(a.height, b.height);
      const distance = Math.abs(center(a) - row.bodyCenter);
      if (overlap < Math.min(a.height, b.height) * 0.45 || distance > scale * 0.55) continue;
      const score = distance / scale - overlap / Math.min(a.height, b.height) * 0.25;
      if (score < bestScore) { best = row; bestScore = score; }
    }
    if (best) add(best, fragment);
    else rows.push({ fragments: [fragment], bodyRect: { ...fragment.rect }, bodyCenter: center(fragment.rect) });
  }

  // Small periods/commas often sit below a word's center. Attach by a height-
  // relative baseline neighborhood and horizontal proximity, never by a fixed
  // 10px top-edge threshold. Unmatched punctuation is retained, not invented or
  // silently removed.
  for (const fragment of punctuation) {
    let best = null, bestScore = Infinity;
    for (const row of rows) {
      const a = fragment.rect, b = row.bodyRect, scale = b.height;
      const verticalGap = Math.max(0, b.y - bottom(a), a.y - bottom(b));
      if (verticalGap > scale * 0.3 || center(a) < b.y - scale * 0.25 || center(a) > bottom(b) + scale * 0.3) continue;
      const gap = Math.min(...row.fragments.map(item => Math.max(0,
        item.rect.x - right(a), a.x - right(item.rect))));
      if (gap > scale * 1.5) continue;
      const score = verticalGap / scale * 3 + gap / scale + Math.abs(bottom(a) - bottom(b)) / scale * 0.15;
      if (score < bestScore) { best = row; bestScore = score; }
    }
    if (best) best.fragments.push(fragment);
    else rows.push({ fragments: [fragment], bodyRect: { ...fragment.rect }, bodyCenter: center(fragment.rect), punctuation: true });
  }

  rows.sort((a, b) => a.bodyCenter - b.bodyCenter || a.bodyRect.x - b.bodyRect.x);
  const lines = rows.map(row => {
    const items = row.fragments.sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y || a.index - b.index);
    let text = '';
    for (const fragment of items) text += (needsSpace(text, fragment.text) ? ' ' : '') + fragment.text;
    const weight = items.reduce((sum, item) => sum + Array.from(item.text).length, 0);
    return { text, rect: union(items.map(item => item.rect)), fragmentCount: items.length,
      glyphHeight: row.punctuation ? null : row.bodyRect.height,
      confidence: items.reduce((sum, item) => sum + item.confidence * Array.from(item.text).length, 0) / Math.max(1, weight),
      minConfidence: Math.min(...items.map(item => item.confidence)) };
  });
  return { lines, glyphHeight: median(lines.map(line => line.glyphHeight)) };
}

module.exports = { reconstructLines };
