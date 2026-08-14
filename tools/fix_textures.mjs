// ============================================================
// fix_textures.mjs — Meshy フォトグラメトリGLBのテクスチャ整備
//
// Meshy の UV アトラスは細かく分断されているため、テクスチャ空間の
// 近傍処理は 3D 上で隣接しない断片を混ぜてしまい破綻する。
// 本スクリプトはメッシュの UV→3D 対応をラスタライズし、
// 「3D 空間での近傍平均輝度」で墨/紙を分類する(アトラス継ぎ目に不変)。
//
// 処理内容:
//  1. 明部の黒カス除去(デスペックル)
//  2. 3D近傍輝度で墨領域を判定し、墨中の明るい欠けを墨色で充填
//  3. サテン調ラフネスマップ生成(墨・漆=0.52 / 和紙=0.88)
//  4. 夜の透過光用エミッシブ生成(紙=クリーム発光、墨=黒)
//  5. ノーマルマップ除去(ベイクノイズ源)
//
// 使い方: node fix_textures.mjs input.glb output.glb
// ============================================================
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import Jimp from 'jimp';

const [,, inPath, outPath] = process.argv;

const S = 512;          // 3D分類の作業解像度
const R3D = 0.045;      // 3D近傍半径(モデルローカル単位。全高≈1.86)
const INK_LO = 80;      // 3D近傍輝度がこれ以下 → 完全に墨
const INK_HI = 118;     // これ以上 → 完全に紙

const io = new NodeIO();
const doc = await io.read(inPath);

// ---------- メッシュの UV → 3D 対応をラスタライズ ----------
let prim = null, primCount = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const p of mesh.listPrimitives()) {
    const c = p.getAttribute('POSITION').getCount();
    if (c > primCount) { primCount = c; prim = p; }
  }
}
const POS = prim.getAttribute('POSITION').getArray();
const UV = prim.getAttribute('TEXCOORD_0').getArray();
const IDX = prim.getIndices().getArray();

const tex3d = {
  x: new Float32Array(S * S),
  y: new Float32Array(S * S),
  z: new Float32Array(S * S),
  cov: new Uint8Array(S * S),
};
for (let t = 0; t < IDX.length; t += 3) {
  const ia = IDX[t], ib = IDX[t + 1], ic = IDX[t + 2];
  const ax = UV[ia * 2] * S, ay = UV[ia * 2 + 1] * S;
  const bx = UV[ib * 2] * S, by = UV[ib * 2 + 1] * S;
  const cx = UV[ic * 2] * S, cy = UV[ic * 2 + 1] * S;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(S - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(S - 1, Math.ceil(Math.max(ay, by, cy)));
  const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(den) < 1e-9) continue;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const qx = px + 0.5, qy = py + 0.5;
      const w0 = ((by - cy) * (qx - cx) + (cx - bx) * (qy - cy)) / den;
      const w1 = ((cy - ay) * (qx - cx) + (ax - cx) * (qy - cy)) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
      const i = py * S + px;
      tex3d.x[i] = w0 * POS[ia * 3] + w1 * POS[ib * 3] + w2 * POS[ic * 3];
      tex3d.y[i] = w0 * POS[ia * 3 + 1] + w1 * POS[ib * 3 + 1] + w2 * POS[ic * 3 + 1];
      tex3d.z[i] = w0 * POS[ia * 3 + 2] + w1 * POS[ib * 3 + 2] + w2 * POS[ic * 3 + 2];
      tex3d.cov[i] = 1;
    }
  }
}
console.log('rasterized texels:', tex3d.cov.reduce((a, b) => a + b, 0), '/', S * S);

// ---------- 3D 近傍平均輝度(ボクセルハッシュ) ----------
function computeBg3D(lumS, R = R3D) {
  const cells = new Map();
  for (let i = 0; i < S * S; i++) {
    if (!tex3d.cov[i]) continue;
    const key = (Math.floor(tex3d.x[i] / R) + 512)
      + (Math.floor(tex3d.y[i] / R) + 512) * 1024
      + (Math.floor(tex3d.z[i] / R) + 512) * 1048576;
    let arr = cells.get(key);
    if (!arr) { arr = []; cells.set(key, arr); }
    arr.push(i);
  }
  const bg = new Float32Array(S * S);
  const R2 = R * R;
  for (let i = 0; i < S * S; i++) {
    if (!tex3d.cov[i]) continue;
    const xi = tex3d.x[i], yi = tex3d.y[i], zi = tex3d.z[i];
    const cx = Math.floor(xi / R) + 512;
    const cy = Math.floor(yi / R) + 512;
    const cz = Math.floor(zi / R) + 512;
    let sum = 0, wsum = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = cells.get((cx + dx) + (cy + dy) * 1024 + (cz + dz) * 1048576);
          if (!arr) continue;
          for (const j of arr) {
            const ddx = tex3d.x[j] - xi, ddy = tex3d.y[j] - yi, ddz = tex3d.z[j] - zi;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 > R2) continue;
            const w = 1 - Math.sqrt(d2) / R;
            sum += lumS[j] * w;
            wsum += w;
          }
        }
      }
    }
    bg[i] = wsum > 0 ? sum / wsum : lumS[i];
  }
  padField(bg, tex3d.cov);
  return bg;
}

// 未カバー画素(UVガター)に最近傍の値をフラッド充填する。
// これをしないとバイリニア補間が 0 と混ざり、断片の縁が黒ずむ
function padField(field, cov) {
  const covered = Uint8Array.from(cov);
  for (let pass = 0; pass < 64; pass++) {
    let changed = 0;
    const next = Uint8Array.from(covered);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (covered[i]) continue;
        let sum = 0, n = 0;
        if (x > 0 && covered[i - 1]) { sum += field[i - 1]; n++; }
        if (x < S - 1 && covered[i + 1]) { sum += field[i + 1]; n++; }
        if (y > 0 && covered[i - S]) { sum += field[i - S]; n++; }
        if (y < S - 1 && covered[i + S]) { sum += field[i + S]; n++; }
        if (n > 0) { field[i] = sum / n; next[i] = 1; changed++; }
      }
    }
    covered.set(next);
    if (!changed) break;
  }
}

function lumAt512(img) {
  const small = img.clone().resize(S, S);
  const sd = small.bitmap.data;
  const out = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    out[i] = sd[i * 4] * 0.299 + sd[i * 4 + 1] * 0.587 + sd[i * 4 + 2] * 0.114;
  }
  return out;
}

const smooth = (v, lo, hi) => {
  let t = (v - lo) / (hi - lo);
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

// バイリニアで bg3d を任意解像度から参照
function makeSampler(field, W, H) {
  return (x, y) => {
    const fx = Math.min(S - 1.001, Math.max(0, (x * S) / W));
    const fy = Math.min(S - 1.001, Math.max(0, (y * S) / H));
    const x0 = fx | 0, y0 = fy | 0;
    const tx = fx - x0, ty = fy - y0;
    const a = field[y0 * S + x0], b = field[y0 * S + x0 + 1];
    const c = field[(y0 + 1) * S + x0], d = field[(y0 + 1) * S + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

// ---------- マテリアルごとの処理 ----------
for (const mat of doc.getRoot().listMaterials()) {
  const baseTex = mat.getBaseColorTexture();
  if (!baseTex) continue;

  console.log('processing material:', mat.getName() || '(unnamed)');
  const img = await Jimp.read(Buffer.from(baseTex.getImage()));
  const { width: W, height: H, data } = img.bitmap;
  console.log('  base color:', W, 'x', H);

  // --- 1. 明部の黒カス除去 ---
  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
  }
  const dilated = new Uint8ClampedArray(data.length);
  morphRGB(data, dilated, W, H, 2, true);
  const fillBright = new Uint8ClampedArray(dilated.length);
  blurRGB(dilated, fillBright, W, H, 2);
  const eroded = new Uint8ClampedArray(data.length);
  morphRGB(data, eroded, W, H, 2, false);
  const fillDark = new Uint8ClampedArray(eroded.length);
  blurRGB(eroded, fillDark, W, H, 2);

  // --- 2. 3D近傍輝度による墨判定と欠け充填 ---
  let bg3d = computeBg3D(lumAt512(img));
  let bgSample = makeSampler(bg3d, W, H);
  let filled = 0, despeck = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const b3 = bgSample(x, y);
      const inkness = 1 - smooth(b3, INK_LO, INK_HI);
      const l = lum[i];
      if (inkness > 0.42 && l > b3 + 28) {
        // 墨・漆ゾーン内の明るい欠け・傷 → 暗い下地で充填
        const t = Math.min(1, (l - b3 - 28) / 22 + inkness * 0.4);
        for (let c = 0; c < 3; c++) {
          const o = data[i * 4 + c];
          data[i * 4 + c] = o + (fillDark[i * 4 + c] - o) * Math.min(1, t);
        }
        filled++;
      } else if (inkness < 0.2 && b3 > 150 && l < b3 - 55) {
        // 紙ゾーンの強い黒カス → 紙色で充填
        const t = Math.min(1, (b3 - l - 55) / 26);
        for (let c = 0; c < 3; c++) {
          const o = data[i * 4 + c];
          data[i * 4 + c] = o + (fillBright[i * 4 + c] - o) * t;
        }
        despeck++;
      }
    }
  }
  console.log('  ink-zone filled:', filled, ' paper despeckled:', despeck);

  const jpg = await img.quality(92).getBufferAsync(Jimp.MIME_JPEG);
  baseTex.setImage(new Uint8Array(jpg)).setMimeType('image/jpeg');

  // 修復後のアルベドで 3D 背景輝度を再計算(発光と完全一致させる)
  const lumFixed = lumAt512(img);
  bg3d = computeBg3D(lumFixed);
  // 広半径版: 折りジワ(細い線)は紙に埋もれ、墨(太い塊)は暗いまま
  const bg3dWide = computeBg3D(lumFixed, 0.085);

  // --- 3. ラフネスマップ ---
  const RW = 1024, RH = Math.max(1, Math.round(1024 * H / W));
  const mr = await Jimp.create(RW, RH);
  const bgSampleR = makeSampler(bg3d, RW, RH);
  const md = mr.bitmap.data;
  for (let y = 0; y < RH; y++) {
    for (let x = 0; x < RW; x++) {
      const i = y * RW + x;
      const t = smooth(bgSampleR(x, y), INK_LO, INK_HI);
      const rough = 0.52 + (0.88 - 0.52) * t;
      md[i * 4] = 255;
      md[i * 4 + 1] = (rough * 255) | 0;
      md[i * 4 + 2] = 0;
      md[i * 4 + 3] = 255;
    }
  }
  const mrPng = await mr.getBufferAsync(Jimp.MIME_PNG);
  const mrTex = doc.createTexture('metal-rough')
    .setImage(new Uint8Array(mrPng))
    .setMimeType('image/png');
  mat.setMetallicRoughnessTexture(mrTex)
    .setRoughnessFactor(1.0)
    .setMetallicFactor(0.0);

  // --- 4. エミッシブ(夜の透過光) ---
  const EW = 1024, EH = Math.max(1, Math.round(1024 * H / W));
  const emis = img.clone().resize(EW, EH);
  const ed = emis.bitmap.data;
  const eN = EW * EH;
  const eLum = new Uint8Array(eN);
  for (let i = 0; i < eN; i++) {
    eLum[i] = (ed[i * 4] * 0.299 + ed[i * 4 + 1] * 0.587 + ed[i * 4 + 2] * 0.114) | 0;
  }
  const eDetailBg = boxBlurU8(eLum, EW, EH, 8);
  const bgSampleE = makeSampler(bg3d, EW, EH);
  const bgSampleWide = makeSampler(bg3dWide, EW, EH);
  const CREAM = [222, 188, 146];
  for (let y = 0; y < EH; y++) {
    for (let x = 0; x < EW; x++) {
      const i = y * EW + x;
      // 細スケール: 筆エッジに忠実 / 広スケール: 折りジワを紙として扱う
      const mFine = smooth(bgSampleE(x, y), INK_LO + 6, INK_HI + 6);
      const mWide = smooth(bgSampleWide(x, y), 100, 132);
      const m = Math.max(mFine, mWide);
      let detail = eLum[i] / Math.max(20, eDetailBg[i]);
      detail = Math.max(0.9, Math.min(1.07, detail));
      for (let c = 0; c < 3; c++) {
        ed[i * 4 + c] = Math.min(255, CREAM[c] * detail * m);
      }
    }
  }
  // UVガター(アトラス断片の隙間)を被覆領域からフラッド充填する。
  // 黒いガターが残っているとデカールのUV外挿やミップマップが黒を拾い、
  // 「墨の下」デカールに穴あきノイズが出る
  {
    const covE = new Uint8Array(eN);
    for (let y = 0; y < EH; y++) {
      for (let x = 0; x < EW; x++) {
        const sx = Math.min(S - 1, (x * S / EW) | 0);
        const sy = Math.min(S - 1, (y * S / EH) | 0);
        covE[y * EW + x] = tex3d.cov[sy * S + sx];
      }
    }
    padImageRGB(ed, covE, EW, EH);
  }

  // PNG(可逆)で保存: JPEG圧縮ノイズがあると墨内部が完全な黒にならず、
  // デカールの墨マスク判定が誤動作する
  const emisPng = await emis.getBufferAsync(Jimp.MIME_PNG);
  const emisTex = doc.createTexture('emissive')
    .setImage(new Uint8Array(emisPng))
    .setMimeType('image/png');
  mat.setEmissiveTexture(emisTex).setEmissiveFactor([1, 1, 1]);

  // --- 5. ノーマルマップ除去 ---
  mat.setNormalTexture(null);
}

await doc.transform(prune());
await io.write(outPath, doc);
console.log('written:', outPath);

// ---------- helpers ----------

// RGBA画像の未被覆画素をBFSで最近傍の被覆値へ充填
function padImageRGB(data, cov, W, H) {
  const covered = Uint8Array.from(cov);
  const queue = new Int32Array(W * H);
  let qh = 0, qt = 0;
  const tryEnqueue = (i) => {
    if (covered[i] !== 0) return;
    covered[i] = 2; // queued
    queue[qt++] = i;
  };
  for (let i = 0; i < W * H; i++) {
    if (covered[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if ((x > 0 && covered[i - 1] === 1) || (x < W - 1 && covered[i + 1] === 1) ||
        (y > 0 && covered[i - W] === 1) || (y < H - 1 && covered[i + W] === 1)) {
      tryEnqueue(i);
    }
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W, y = (i / W) | 0;
    let r = 0, g = 0, b = 0, n = 0;
    const nbs = [
      x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1,
      y > 0 ? i - W : -1, y < H - 1 ? i + W : -1,
    ];
    for (const nb of nbs) {
      if (nb >= 0 && covered[nb] === 1) {
        r += data[nb * 4]; g += data[nb * 4 + 1]; b += data[nb * 4 + 2]; n++;
      }
    }
    if (n > 0) {
      data[i * 4] = r / n; data[i * 4 + 1] = g / n; data[i * 4 + 2] = b / n;
    }
    covered[i] = 1;
    for (const nb of nbs) if (nb >= 0) tryEnqueue(nb);
  }
}

function boxBlurU8(src, W, H, r) {
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row;
    }
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const sum = integ[(y1 + 1) * (W + 1) + x1 + 1] - integ[y0 * (W + 1) + x1 + 1]
                - integ[(y1 + 1) * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
      out[y * W + x] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return out;
}

// dilate=false: min(侵食) / dilate=true: max(膨張)
function morphRGB(src, dst, W, H, r, dilate) {
  const tmp = new Uint8ClampedArray(src.length);
  const init = dilate ? 0 : 255;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let m = init;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(W - 1, Math.max(0, x + k));
          const v = src[(y * W + xx) * 4 + c];
          if (dilate ? v > m : v < m) m = v;
        }
        tmp[(y * W + x) * 4 + c] = m;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let m = init;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(H - 1, Math.max(0, y + k));
          const v = tmp[(yy * W + x) * 4 + c];
          if (dilate ? v > m : v < m) m = v;
        }
        dst[(y * W + x) * 4 + c] = m;
      }
    }
  }
}

function blurRGB(src, dst, W, H, r) {
  const tmp = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(W - 1, Math.max(0, x + k));
          s += src[(y * W + xx) * 4 + c];
        }
        tmp[(y * W + x) * 4 + c] = s / n;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(H - 1, Math.max(0, y + k));
          s += tmp[(yy * W + x) * 4 + c];
        }
        dst[(y * W + x) * 4 + c] = s / n;
      }
    }
  }
}
