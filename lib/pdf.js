/* Minimal dependency-free PDF writer + ATS-friendly resume renderer.
   Uses the standard Helvetica fonts (real, selectable text — parses cleanly in ATS). */
(function (root) {
  // Helvetica advance widths for ASCII 32..126 (1000 units/em)
  const REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

  const MAP = {
    '–': '\x96', '—': '\x97', '•': '\x95', '‘': '\x91', '’': '\x92',
    '“': '\x93', '”': '\x94', '…': '\x85', ' ': ' ', '−': '-',
    '→': '->', '●': '\x95', '·': '\xb7', '\t': ' '
  };

  // Unicode -> WinAnsi-ish single-byte string
  function enc(s) {
    let o = '';
    for (const ch of String(s == null ? '' : s)) {
      const c = ch.codePointAt(0);
      if (MAP[ch] !== undefined) o += MAP[ch];
      else if (c >= 32 && c < 127) o += ch;
      else if (c >= 0xa0 && c <= 0xff) o += ch;
      else if (c < 32) o += ' ';
      else {
        const n = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
        o += n.length === 1 && n.charCodeAt(0) < 127 ? n : '?';
      }
    }
    return o;
  }

  function cw(ch, bold) {
    const n = ch.charCodeAt(0);
    if (n >= 32 && n < 127) return (bold ? BOLD : REG)[n - 32];
    switch (n) {
      case 0x95: return 350;
      case 0x96: return 556;
      case 0x97: case 0x85: return 1000;
      case 0x91: case 0x92: return bold ? 278 : 222;
      case 0x93: case 0x94: return bold ? 500 : 333;
      default: return 556;
    }
  }
  function width(s, bold, size) {
    let w = 0;
    for (let i = 0; i < s.length; i++) w += cw(s[i], bold);
    return (w * size) / 1000;
  }
  const esc = (s) => s.replace(/([\\()])/g, '\\$1');

  class Doc {
    constructor() { this.pages = []; this.newPage(); }
    newPage() { this.cur = []; this.pages.push(this.cur); }
    text(s, x, y, font, size) {
      this.cur.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(s)}) Tj ET`);
    }
    line(x1, x2, y, w) {
      this.cur.push(`${w} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
    }
    build(title) {
      const objs = [];
      const fonts = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique'];
      const nPages = this.pages.length;
      const firstPage = 7; // 1 catalog,2 pages,3-5 fonts,6 info
      const kids = [];
      for (let i = 0; i < nPages; i++) kids.push(`${firstPage + i * 2} 0 R`);
      objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
      objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${nPages} >>`;
      fonts.forEach((f, i) => {
        objs[3 + i] = `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`;
      });
      objs[6] = `<< /Title (${esc(enc(title || 'Resume'))}) /Producer (Job Copilot) >>`;
      this.pages.forEach((cmds, i) => {
        const pid = firstPage + i * 2, cid = pid + 1;
        const stream = cmds.join('\n');
        objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${cid} 0 R >>`;
        objs[cid] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
      });
      let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
      const offsets = [];
      for (let i = 1; i < objs.length; i++) {
        offsets[i] = out.length;
        out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
      }
      const xref = out.length;
      out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
      for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
      out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF`;
      const bytes = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
      return bytes;
    }
  }

  function layoutResume(r, FS) {
    const PW = 612, PH = 792, M = 54, CW = PW - 2 * M, BOT = 48, TOP = PH - 50;
    const doc = new Doc();
    let y = TOP;
    const LH = FS * 1.3;
    const need = (h) => { if (y - h < BOT) { doc.newPage(); y = TOP; } };

    function wrap(text, bold, size, maxW, firstW) {
      const words = enc(text).split(/\s+/).filter(Boolean);
      const lines = [];
      let cur = '', limit = firstW == null ? maxW : firstW;
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w;
        if (!cur || width(t, bold, size) <= limit) cur = t;
        else { lines.push(cur); cur = w; limit = maxW; }
      }
      if (cur) lines.push(cur);
      return lines;
    }
    function centered(text, bold, size) {
      for (const l of wrap(text, bold, size, CW)) {
        need(size * 1.3);
        doc.text(l, (PW - width(l, bold, size)) / 2, y - size, bold ? 'F2' : 'F1', size);
        y -= size * 1.3;
      }
    }
    function para(text, font, size, indent) {
      const bold = font === 'F2';
      for (const l of wrap(text, bold, size, CW - (indent || 0))) {
        need(size * 1.3);
        doc.text(l, M + (indent || 0), y - size, font, size);
        y -= size * 1.3;
      }
    }
    function bullet(text) {
      const lines = wrap(text, false, FS, CW - 18);
      lines.forEach((l, i) => {
        need(LH);
        if (i === 0) doc.text('\x95', M + 6, y - FS, 'F1', FS);
        doc.text(l, M + 18, y - FS, 'F1', FS);
        y -= LH;
      });
    }
    function section(title) {
      need(44);
      y -= 7;
      doc.text(enc(title.toUpperCase()), M, y - 10.5, 'F2', 10.5);
      y -= 14;
      doc.line(M, M + CW, y, 0.7);
      y -= 6;
    }
    function entry(left, right) {
      need(LH * 2.2);
      const l = enc(left), rt = enc(right || '');
      doc.text(l, M, y - FS, 'F2', FS);
      if (rt) doc.text(rt, M + CW - width(rt, false, FS), y - FS, 'F1', FS);
      y -= LH;
    }
    function sub(text) { if (text) para(text, 'F3', FS, 0); }
    function labeled(label, text) {
      const lab = enc(label + ': ');
      const lw = width(lab, true, FS);
      const lines = wrap(text, false, FS, CW, CW - lw);
      lines.forEach((l, i) => {
        need(LH);
        if (i === 0) { doc.text(lab, M, y - FS, 'F2', FS); doc.text(l, M + lw, y - FS, 'F1', FS); }
        else doc.text(l, M, y - FS, 'F1', FS);
        y -= LH;
      });
    }
    const dates = (a, b) => [a, b].filter(Boolean).join(' – ');

    // header
    if (r.name) { centered(r.name, true, 20); y -= 2; }
    if (r.contact && r.contact.length) centered(r.contact.join('  |  '), false, FS - 0.5);
    if (r.summary) { section('Summary'); para(r.summary, 'F1', FS, 0); }

    const skills = r.skills || [];
    if (skills.length) {
      section('Skills');
      for (const s of skills) {
        if (typeof s === 'string') labeled('Skills', s);
        else if (s && (s.items || []).length) {
          if (s.category) labeled(s.category, s.items.join(', '));
          else para(s.items.join(', '), 'F1', FS, 0);
        }
      }
    }
    if ((r.experience || []).length) {
      section('Experience');
      r.experience.forEach((e, i) => {
        if (i) y -= 4;
        entry(e.title || e.company, dates(e.start, e.end));
        sub([e.company, e.location].filter((v) => v && v !== e.title).join(' — '));
        (e.bullets || []).forEach(bullet);
      });
    }
    if ((r.projects || []).length) {
      section('Projects');
      r.projects.forEach((p, i) => {
        if (i) y -= 4;
        entry(p.name, '');
        if (p.link) sub(p.link);
        if (p.description) para(p.description, 'F1', FS, 0);
        (p.bullets || []).forEach(bullet);
      });
    }
    if ((r.education || []).length) {
      section('Education');
      r.education.forEach((e, i) => {
        if (i) y -= 3;
        entry(e.school, dates(e.start, e.end));
        sub([[e.degree, e.field].filter(Boolean).join(', '), e.gpa ? 'GPA ' + e.gpa : ''].filter(Boolean).join(' — '));
        if (e.details) para(e.details, 'F1', FS, 0);
      });
    }
    if ((r.certifications || []).length) {
      section('Certifications');
      r.certifications.forEach(bullet);
    }
    return doc;
  }

  function renderResume(r) {
    // Prefer a single page (largest readable font that fits); otherwise flow onto two at 10pt.
    let doc = null;
    for (const fs of [10.5, 10, 9.5]) {
      const d = layoutResume(r, fs);
      if (d.pages.length === 1) { doc = d; break; }
    }
    if (!doc) doc = layoutResume(r, 10);
    return doc.build((r.name || 'Resume') + ' - Resume');
  }

  function toBase64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  const api = { renderResume, toBase64 };
  root.JobPDF = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
