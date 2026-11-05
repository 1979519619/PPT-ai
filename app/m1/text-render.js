'use strict';

// Shared by the transparent overlay and its isolated measuring document.
// Text is never inserted as HTML except for locally rendered, untrusted KaTeX.
(function installTextRenderer() {
  const FONT_FAMILY = '"Microsoft YaHei", sans-serif';
  const escapeHtml = text => String(text).replace(/[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function renderMath(value) {
    const source = String(value || '');
    const pattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g;
    let output = '', last = 0, match;
    while ((match = pattern.exec(source))) {
      output += escapeHtml(source.slice(last, match.index));
      try {
        if (!window.katex) throw new Error('math-renderer-unavailable');
        output += window.katex.renderToString(match[1] || match[2] || match[3] || match[4] || '', {
          displayMode: !!(match[1] || match[2]), throwOnError: false, strict: false,
          trust: false, maxSize: 10, maxExpand: 200
        });
      } catch (_) { output += escapeHtml(match[0]); }
      last = match.index + match[0].length;
    }
    return output + escapeHtml(source.slice(last));
  }

  function applyTextStyle(element) {
    Object.assign(element.style, {
      boxSizing: 'border-box', margin: '0', padding: '4px',
      fontFamily: FONT_FAMILY, fontWeight: '400', fontStyle: 'normal',
      lineHeight: '1.3', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      wordBreak: 'normal', letterSpacing: 'normal', textIndent: '0',
      textTransform: 'none', background: 'transparent'
    });
    return element;
  }

  function glyphHeight(text, fontSize) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.font = '400 ' + fontSize + 'px ' + FONT_FAMILY;
    // Use visible characters from this translation, rather than assuming Latin
    // and CJK occupy the same fraction of the CSS em box.
    const sample = String(text || '').replace(/\s+/g, '').slice(0, 160) || '国Ag';
    const metrics = context.measureText(sample);
    const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    return Number.isFinite(height) && height > 0 ? height : null;
  }

  async function measureBatch(requests) {
    const root = document.getElementById('measure-root');
    if (!root || !Array.isArray(requests)) throw new Error('invalid-measure-document');
    root.replaceChildren();
    const prepared = [];
    try {
      for (const request of requests) {
        const width = Number(request.width);
        if (!Number.isFinite(width) || width < 8 || width > 16384) continue;
        const text = String(request.text || '');
        const samples = [];
        for (const fontSize of request.fontSizes || []) {
          if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 128) continue;
          const element = applyTextStyle(document.createElement('div'));
          element.className = 'ppt-measure-text';
          Object.assign(element.style, {
            position: 'absolute', left: '0', top: '0', width: width + 'px',
            fontSize: fontSize + 'px', height: 'auto', minHeight: '0',
            maxHeight: 'none', overflow: 'visible'
          });
          element.innerHTML = renderMath(text);
          root.appendChild(element);
          // Resolve styles before waiting for the local font faces they need.
          element.getBoundingClientRect();
          samples.push({ fontSize, element });
        }
        prepared.push({ id: String(request.id), text, width, samples });
      }
      if (document.fonts?.ready) await document.fonts.ready;
      return prepared.map(request => ({
        id: request.id,
        measurements: request.samples.map(({ fontSize, element }) => {
          const rect = element.getBoundingClientRect();
          const height = Math.ceil(Math.max(rect.height, element.scrollHeight)) + 1;
          const overflow = element.scrollWidth > element.clientWidth + 1 ||
            !Number.isFinite(height) || height <= 0 || height > 20000;
          return { fontSize, width: request.width, height, overflow,
            glyphHeight: glyphHeight(request.text, fontSize) };
        })
      }));
    } finally {
      // The helper keeps font resources warm, never a previous page's text DOM.
      root.replaceChildren();
    }
  }

  window.PPTText = Object.freeze({ FONT_FAMILY, renderMath, applyTextStyle, glyphHeight, measureBatch });
})();
