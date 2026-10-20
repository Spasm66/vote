'use strict';
/*
 * Génère un PDF A4 de codes de vote à découper, sans dépendance.
 * Codes en Courier gras 12 pt, grille de pointillés pour la découpe.
 */

// Caractères hors Latin-1 présents dans l'encodage WinAnsi
const WINANSI_EXTRA = {
  0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2013: 0x96, 0x2014: 0x97, 0x0152: 0x8c, 0x0153: 0x9c, 0x0178: 0x9f,
};

function pdfString(text) {
  let out = '(';
  for (const ch of String(text)) {
    let c = ch.codePointAt(0);
    if (WINANSI_EXTRA[c] !== undefined) c = WINANSI_EXTRA[c];
    else if (c > 255 || (c >= 0x80 && c < 0xa0)) c = 63; // « ? »
    if (c === 40 || c === 41 || c === 92) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

const W = 595.28, H = 841.89;          // A4 en points
const MARGIN_X = 24, MARGIN_TOP = 34, MARGIN_BOTTOM = 24;
const FONT_SIZE = 12, CHAR_W = 0.6 * FONT_SIZE, CAP_H = 0.562 * FONT_SIZE;
const COLS = 8;
const CELL_W = (W - 2 * MARGIN_X) / COLS;
const CELL_H = 20;
const ROWS = Math.floor((H - MARGIN_TOP - MARGIN_BOTTOM) / CELL_H);
const PER_PAGE = COLS * ROWS;

function codesPdf({ titre, codes }) {
  const pageCount = Math.max(1, Math.ceil(codes.length / PER_PAGE));
  const contents = [];

  for (let pg = 0; pg < pageCount; pg++) {
    const slice = codes.slice(pg * PER_PAGE, (pg + 1) * PER_PAGE);
    const rows = Math.max(1, Math.ceil(slice.length / COLS));
    const top = H - MARGIN_TOP;
    const bottom = top - rows * CELL_H;
    const left = MARGIN_X, right = W - MARGIN_X;
    let s = '';

    const header = `${titre} — page ${pg + 1}/${pageCount} — ${codes.length} codes — un code = une voix, à usage unique`;
    s += `BT /F2 8 Tf 0.35 g 1 0 0 1 ${left} ${(H - 22).toFixed(2)} Tm ${pdfString(header)} Tj ET\n`;

    // Grille de découpe en pointillés
    s += '0.65 G 0.5 w [2 2] 0 d\n';
    for (let r = 0; r <= rows; r++) {
      const y = (top - r * CELL_H).toFixed(2);
      s += `${left} ${y} m ${right.toFixed(2)} ${y} l S\n`;
    }
    for (let c = 0; c <= COLS; c++) {
      const x = (left + c * CELL_W).toFixed(2);
      s += `${x} ${top.toFixed(2)} m ${x} ${bottom.toFixed(2)} l S\n`;
    }

    // Codes
    s += `BT /F1 ${FONT_SIZE} Tf 0 g\n`;
    slice.forEach((code, i) => {
      const r = Math.floor(i / COLS), c = i % COLS;
      const x = left + c * CELL_W + (CELL_W - code.length * CHAR_W) / 2;
      const y = top - (r + 1) * CELL_H + (CELL_H - CAP_H) / 2;
      s += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(code)} Tj\n`;
    });
    s += 'ET\n';
    contents.push(s);
  }

  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const kids = [];
  contents.forEach((c, i) => {
    const pageId = 5 + i * 2, contentId = 6 + i * 2;
    kids.push(`${pageId} 0 R`);
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}\nendstream`;
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  const infoId = objs.length;
  // Métadonnées en UTF-16BE (seul encodage fiable pour les accents hors du contenu des pages)
  const utf16 = Buffer.from('﻿' + titre, 'utf16le').swap16().toString('hex');
  objs[infoId] = `<< /Title <${utf16}> /Producer (Vote AG) >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { codesPdf, CODES_PAR_PAGE: PER_PAGE };
