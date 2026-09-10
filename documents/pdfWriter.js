'use strict';

// A small, focused PDF writer: pages, text with real word-wrapping, rules and filled
// rectangles. Enough to typeset a structured document and draw a clean diagram, and
// deliberately nothing more.
//
// NO DEPENDENCY, ON PURPOSE. This project hand-rolls its external clients for exactly this
// reason - agent/core/claudeClient.js says it plainly ("No SDK dependency is added for
// this"), and the whole runtime has two dependencies. A PDF library would have added a
// couple of dozen transitive packages to produce one document, so the document is produced
// here instead, from the PDF specification's own primitives.
//
// STANDARD FONTS ONLY. Helvetica and Helvetica-Bold are two of the 14 fonts every PDF
// reader is required to provide, so nothing has to be embedded and the file stays small.
// Their real character widths are below, so wrapping is measured rather than guessed.
//
// TEXT IS SANITISED TO WinAnsi. Typographic characters (curly quotes, en/em dashes) are
// mapped to their ASCII equivalents before encoding, so a stray character can never corrupt
// a content stream.

// A4 in PostScript points.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

// Character widths (per 1000 units) for the two standard fonts used here, ASCII 32-126.
// From the Adobe Core14 AFM metrics.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Typographic characters this project's copy actually uses, mapped to WinAnsi-safe ASCII.
const CHARACTER_REPLACEMENTS = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−]/g, '-'],
  [/[…]/g, '...'],
  [/[   ]/g, ' '],
  [/[→]/g, '->'],
  [/[↺↻⟲⟳]/g, '(loops back)'],
  [/[✓✔]/g, 'v'],
  [/[•]/g, '-'],
];

function sanitize(text) {
  let out = String(text === null || text === undefined ? '' : text);
  for (const [pattern, replacement] of CHARACTER_REPLACEMENTS) out = out.replace(pattern, replacement);
  // Anything still outside printable ASCII is dropped rather than written as a byte the
  // reader would misinterpret.
  return out.replace(/[^\x20-\x7E]/g, '');
}

function widthsFor(font) {
  return font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
}

// Width of one already-sanitised string, in points.
function measureText(text, size, font) {
  const widths = widthsFor(font);
  let total = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    const width = code >= 32 && code <= 126 ? widths[code - 32] : widths[0];
    total += width;
  }
  return (total / 1000) * size;
}

// Greedy wrap on real measured widths. A single word longer than the line is hard-split
// rather than allowed to run off the page.
function wrapText(text, size, font, maxWidth) {
  const clean = sanitize(text);
  if (clean === '') return [''];
  const lines = [];
  for (const paragraph of clean.split('\n')) {
    if (paragraph.trim() === '') { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measureText(candidate, size, font) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      if (measureText(word, size, font) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const char of word) {
        if (measureText(chunk + char, size, font) > maxWidth && chunk !== '') {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      line = chunk;
    }
    if (line !== '') lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}

function escapePdfString(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function formatNumber(value) {
  return (Math.round(value * 100) / 100).toString();
}

function createPdfDocument({ width = PAGE_WIDTH, height = PAGE_HEIGHT } = {}) {
  const pages = [];
  let current = null;

  function addPage() {
    current = { ops: [] };
    pages.push(current);
    return current;
  }

  function requirePage() {
    if (!current) addPage();
    return current;
  }

  // Coordinates are given TOP-LEFT throughout this API, which is how the document is
  // actually laid out; the flip to PDF's bottom-left origin happens here, once.
  function toPdfY(y) {
    return height - y;
  }

  function setFill(color) {
    const [r, g, b] = color || [0, 0, 0];
    return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)} rg`;
  }

  function setStroke(color) {
    const [r, g, b] = color || [0, 0, 0];
    return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)} RG`;
  }

  // Draws one already-wrapped line. Returns nothing; callers track their own cursor.
  function drawTextLine(text, { x, y, size = 11, font = 'regular', color = [0, 0, 0] } = {}) {
    const page = requirePage();
    const resource = font === 'bold' ? '/F2' : '/F1';
    page.ops.push(setFill(color));
    page.ops.push('BT');
    page.ops.push(`${resource} ${formatNumber(size)} Tf`);
    page.ops.push(`1 0 0 1 ${formatNumber(x)} ${formatNumber(toPdfY(y) - size)} Tm`);
    page.ops.push(`(${escapePdfString(sanitize(text))}) Tj`);
    page.ops.push('ET');
  }

  function rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 1 } = {}) {
    const page = requirePage();
    if (fill) page.ops.push(setFill(fill));
    if (stroke) {
      page.ops.push(setStroke(stroke));
      page.ops.push(`${formatNumber(lineWidth)} w`);
    }
    page.ops.push(`${formatNumber(x)} ${formatNumber(toPdfY(y) - h)} ${formatNumber(w)} ${formatNumber(h)} re`);
    page.ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
  }

  function line(x1, y1, x2, y2, { color = [0, 0, 0], lineWidth = 1 } = {}) {
    const page = requirePage();
    page.ops.push(setStroke(color));
    page.ops.push(`${formatNumber(lineWidth)} w`);
    page.ops.push(`${formatNumber(x1)} ${formatNumber(toPdfY(y1))} m`);
    page.ops.push(`${formatNumber(x2)} ${formatNumber(toPdfY(y2))} l`);
    page.ops.push('S');
  }

  function toBuffer() {
    if (pages.length === 0) addPage();

    const objects = [];
    const pageObjectStart = 5; // 1 catalog, 2 pages, 3 F1, 4 F2, then page/content pairs.
    const pageIds = pages.map((_, index) => pageObjectStart + index * 2);

    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    pages.forEach((page, index) => {
      const pageId = pageIds[index];
      const contentId = pageId + 1;
      objects[pageId] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(width)} ${formatNumber(height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
      const stream = page.ops.join('\n');
      objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
    });

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (let id = 1; id < objects.length; id += 1) {
      if (objects[id] === undefined) continue;
      offsets[id] = Buffer.byteLength(pdf, 'latin1');
      pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    const maxId = objects.length;
    pdf += `xref\n0 ${maxId}\n0000000000 65535 f \n`;
    for (let id = 1; id < maxId; id += 1) {
      const offset = offsets[id] === undefined ? 0 : offsets[id];
      pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${maxId} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(pdf, 'latin1');
  }

  return {
    addPage,
    drawTextLine,
    rect,
    line,
    toBuffer,
    get pageCount() {
      return pages.length;
    },
    width,
    height,
  };
}

module.exports = {
  createPdfDocument,
  measureText,
  wrapText,
  sanitize,
  PAGE_WIDTH,
  PAGE_HEIGHT,
};
