/** Turns raw terminal input into key, mouse and report events. */

const CSI_FINAL = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'backtab' };
const CSI_TILDE = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };

function csi(params, final) {
  if (params.startsWith('<') && (final === 'M' || final === 'm')) {
    const [b, x, y] = params.slice(1).split(';').map(Number);
    const ev = { name: 'mouse', x: x - 1, y: y - 1 };
    if (b & 64) ev.action = b & 1 ? 'wheeldown' : 'wheelup';
    else if ((b & 3) === 0 && !(b & 32)) ev.action = final === 'm' ? 'release' : 'press';
    else ev.action = 'other';
    return ev;
  }
  if (final === 't') {
    const [kind, h, w] = params.split(';').map(Number);
    if (kind === 6 && h > 0 && w > 0) return { name: 'cellsize', h, w };
  }
  if (CSI_FINAL[final]) return { name: CSI_FINAL[final] };
  if (final === '~') return { name: CSI_TILDE[Number(params.split(';')[0])] ?? 'unknown' };
  return { name: 'unknown' };
}

export function parseInput(str) {
  const events = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const next = str[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < str.length && !(str.charCodeAt(j) >= 0x40 && str.charCodeAt(j) <= 0x7e)) j++;
        if (j >= str.length) {
          i = str.length;
          continue;
        }
        events.push(csi(str.slice(i + 2, j), str[j]));
        i = j + 1;
        continue;
      }
      if (next === 'O' && i + 2 < str.length) {
        events.push({ name: CSI_FINAL[str[i + 2]] ?? 'unknown' });
        i += 3;
        continue;
      }
      events.push({ name: 'escape' });
      i++;
      continue;
    }
    const cp = str.codePointAt(i);
    const c = String.fromCodePoint(cp);
    i += c.length;
    if (c === '\r' || c === '\n') events.push({ name: 'enter' });
    else if (c === '\t') events.push({ name: 'tab' });
    else if (c === '\x7f' || c === '\b') events.push({ name: 'backspace' });
    else if (cp >= 1 && cp <= 26) events.push({ name: String.fromCharCode(cp + 96), ctrl: true });
    else if (cp >= 32) events.push({ name: c, char: c });
  }
  return events;
}
