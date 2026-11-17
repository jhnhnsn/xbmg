/** Small helpers for drawing styled, fixed-width text in the terminal. */

export const R = '\x1b[0m';

/** Builds an SGR escape from 256-colour numbers and flags. */
export function style({ fg, bg, bold, dim, italic, underline } = {}) {
  const p = [];
  if (bold) p.push(1);
  if (dim) p.push(2);
  if (italic) p.push(3);
  if (underline) p.push(4);
  if (fg != null) p.push(`38;5;${fg}`);
  if (bg != null) p.push(`48;5;${bg}`);
  return p.length ? `\x1b[${p.join(';')}m` : '';
}

/** Removes control characters so text from the API cannot move the cursor or change the terminal. */
export function clean(text) {
  return String(text ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

/** Approximate terminal cell width of one code point (0, 1 or 2). */
export function charWidth(cp) {
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function strWidth(text) {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Cleans text, then cuts it with "…" or pads it with spaces to exactly `width` cells. */
export function fit(text, width, { align = 'left' } = {}) {
  if (width <= 0) return '';
  let s = clean(text);
  let w = strWidth(s);
  if (w > width) {
    let cut = '';
    let used = 0;
    for (const ch of s) {
      const cw = charWidth(ch.codePointAt(0));
      if (used + cw > width - 1) break;
      cut += ch;
      used += cw;
    }
    s = `${cut}…`;
    w = used + 1;
  }
  const pad = ' '.repeat(width - w);
  return align === 'right' ? pad + s : s + pad;
}

/**
 * Builds one screen row of exactly `width` cells from styled segments.
 * `base` (usually a background colour) is kept under every segment.
 */
export class Line {
  constructor(width, base = '') {
    this.width = width;
    this.base = base;
    this.used = 0;
    this.out = base;
  }

  get room() {
    return Math.max(0, this.width - this.used);
  }

  add(text, st = '', w, align) {
    const room = this.room;
    if (room <= 0) return this;
    let t;
    if (w != null) {
      t = fit(text, Math.min(w, room), { align });
    } else {
      t = clean(text);
      if (strWidth(t) > room) t = fit(t, room);
    }
    this.out += st ? `${st}${t}${R}${this.base}` : t;
    this.used += strWidth(t);
    return this;
  }

  done() {
    return `${this.out}${' '.repeat(this.room)}${R}`;
  }
}

/** Removes escape sequences. Tests use this to read a frame as plain text. */
export function plain(text) {
  return text.replace(/\x1b\[[0-9;?<]*[A-Za-z~]/g, '').replace(/\x1b_G[^\x1b]*\x1b\\/g, '').replace(/\x1b\]1337;[^\x07]*\x07/g, '');
}
