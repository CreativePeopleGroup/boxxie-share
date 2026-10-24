/* Minimal QR code generator (byte mode, error correction level M, versions 1–10).
 * Enough for a Boxxie Share pairing link. Based on the QR Code specification (ISO/IEC 18004);
 * structure follows Project Nayuki's public-domain reference implementation.
 * Usage: BoxxieQR.svg("https://…", { size: 240 }) → SVG element
 */
(function () {
  "use strict";

  // [total codewords, number of blocks, EC codewords per block] for level M, versions 1..10
  const TABLE = [null, [26, 1, 10], [44, 1, 16], [70, 1, 26], [100, 2, 18], [134, 2, 24],
    [172, 4, 16], [196, 4, 18], [242, 4, 22], [292, 5, 22], [346, 5, 26]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
    }
    return result;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let version = 1;
    for (; version <= 10; version++) {
      const [total, blocks, ec] = TABLE[version];
      const capacityBits = (total - blocks * ec) * 8;
      const countBits = version <= 9 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= capacityBits) break;
    }
    if (version > 10) throw new Error("Text too long for QR");
    const [totalCw, numBlocks, ecLen] = TABLE[version];
    const dataCw = totalCw - numBlocks * ecLen;

    // ---- bit stream ----
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4);
    put(bytes.length, version <= 9 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    const cap = dataCw * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }

    // ---- error correction + interleaving ----
    const numShort = numBlocks - (totalCw % numBlocks);
    const shortLen = Math.floor(totalCw / numBlocks);
    const div = rsDivisor(ecLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - ecLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((blk, j) => {
        if (i !== shortLen - ecLen || j >= numShort) codewords.push(blk[i]);
      });
    }

    // ---- matrix ----
    const size = version * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = ALIGN[version];
    al.forEach((ax, i) => al.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = (mask) => {
      const d = (0 << 3) | mask; // level M = 0
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((d << 10) | rem) ^ 0x5412;
      const bit = (i) => ((b >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0); // reserve the area
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3);
        set(a, c, bit); set(c, a, bit);
      }
    }
    // data, zig-zag
    let i = 0;
    const totalBits = codewords.length * 8 + REMAINDER_BITS[version];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && i < totalBits) {
            mod[y][x] = i < codewords.length * 8 ? ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0 : false;
            i++;
          }
        }
      }
    }
    const maskFn = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[m](x, y)) mod[y][x] = !mod[y][x];
    };
    // Pick the mask with the lowest penalty (runs, blocks, finder-like patterns, balance)
    const penalty = () => {
      let p = 0;
      const line = (get) => {
        let run = 1;
        for (let k = 1; k < size; k++) {
          if (get(k) === get(k - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
        for (let k = 0; k + 6 < size; k++) {
          const pat = [1, 0, 1, 1, 1, 0, 1].every((v, n) => get(k + n) === !!v);
          if (!pat) continue;
          const before = k >= 4 && [1, 2, 3, 4].every((n) => !get(k - n));
          const after = k + 10 < size && [7, 8, 9, 10].every((n) => !get(k + n));
          if (before || after) p += 40;
        }
      };
      for (let y = 0; y < size; y++) line((k) => mod[y][k]);
      for (let x = 0; x < size; x++) line((k) => mod[k][x]);
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
      }
      let dark = 0;
      mod.forEach((r) => r.forEach((v) => (dark += v ? 1 : 0)));
      p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return p;
    };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const pen = penalty();
      if (pen < bestP) { bestP = pen; best = m; }
      applyMask(m); // undo
    }
    applyMask(best); drawFormat(best);
    return { size, modules: mod };
  }

  function svg(text, { size = 240, dark = "#142130", light = "#ffffff", margin = 4 } = {}) {
    const { size: n, modules } = encode(text);
    const total = n + margin * 2;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modules[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    const NS = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(NS, "svg");
    el.setAttribute("viewBox", `0 0 ${total} ${total}`);
    el.setAttribute("width", size);
    el.setAttribute("height", size);
    el.setAttribute("shape-rendering", "crispEdges");
    const bg = document.createElementNS(NS, "rect");
    bg.setAttribute("width", total); bg.setAttribute("height", total); bg.setAttribute("fill", light);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d); path.setAttribute("fill", dark);
    el.append(bg, path);
    return el;
  }

  window.BoxxieQR = { encode, svg };
})();
