// ベースカラーの白擦り傷ノイズ除去 + 墨/漆用ラフネスマップ生成
// 使い方: node fix_textures.mjs input.glb output.glb
// (Meshy の焼いたテクスチャは暗部に白いひび状ノイズが乗るため、
//  暗い領域の明るい外れ値を侵食+ぼかし値へ置換する)
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import Jimp from 'jimp';

const [,, inPath, outPath] = process.argv;

const io = new NodeIO();
const doc = await io.read(inPath);

const mats = doc.getRoot().listMaterials();
for (const mat of mats) {
  const baseTex = mat.getBaseColorTexture();
  if (!baseTex) continue;

  console.log('processing material:', mat.getName() || '(unnamed)');
  const img = await Jimp.read(Buffer.from(baseTex.getImage()));
  const { width: W, height: H, data } = img.bitmap;
  console.log('  base color:', W, 'x', H);

  // 輝度
  const lum = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
  }

  // 背景輝度(積分画像で box blur r=8)
  const bg = boxBlurU8(lum, W, H, 8);

  // 侵食(min フィルタ)→ ぼかし: 暗部の白傷を埋める下地色
  const eroded = new Uint8ClampedArray(data.length);
  erodeRGB(data, eroded, W, H, 2, false);
  const fillDark = new Uint8ClampedArray(eroded.length);
  blurRGB(eroded, fillDark, W, H, 2);

  // 膨張(max フィルタ)→ ぼかし: 明部の黒カスを埋める紙色
  const dilated = new Uint8ClampedArray(data.length);
  erodeRGB(data, dilated, W, H, 2, true);
  const fillBright = new Uint8ClampedArray(dilated.length);
  blurRGB(dilated, fillBright, W, H, 2);

  let fixedW = 0, fixedB = 0;
  for (let i = 0; i < W * H; i++) {
    // 暗い領域(墨・漆)の明るい外れ値 → 白傷除去
    if (bg[i] < 115 && lum[i] > bg[i] + 20) {
      const t = Math.min(1, (lum[i] - bg[i] - 20) / 22);
      for (let c = 0; c < 3; c++) {
        const o = data[i * 4 + c];
        data[i * 4 + c] = o + (fillDark[i * 4 + c] - o) * t;
      }
      fixedW++;
    }
    // 明るい領域(和紙)の黒カス → 除去。2段階:
    //  - 開けた紙面: 中程度の黒でも除去(骨の陰影線 delta<45 は残す)
    //  - 墨の縁近傍: 深い黒のみ除去(筆エッジの階調は温存)
    else {
      const openPaper = bg[i] > 165 && lum[i] < bg[i] - 48;
      const nearEdge = bg[i] > 126 && lum[i] < bg[i] - 76;
      if (openPaper || nearEdge) {
        const d = bg[i] - lum[i] - (openPaper ? 48 : 76);
        const t = Math.min(1, d / 26);
        for (let c = 0; c < 3; c++) {
          const o = data[i * 4 + c];
          data[i * 4 + c] = o + (fillBright[i * 4 + c] - o) * t;
        }
        fixedB++;
      }
    }
  }
  console.log('  despeckled: white-on-dark', fixedW, ', dark-on-bright', fixedB);

  // クリーン後のベースカラーを書き戻し
  const jpg = await img.quality(92).getBufferAsync(Jimp.MIME_JPEG);
  baseTex.setImage(new Uint8Array(jpg)).setMimeType('image/jpeg');

  // ラフネスマップ: 明部(和紙)=0.88 / 暗部(墨・漆)=0.52 を輝度で補間
  const RW = 1024, RH = Math.max(1, Math.round(1024 * H / W));
  const mr = await Jimp.create(RW, RH);
  const small = img.clone().resize(RW, RH);
  const sd = small.bitmap.data;
  const md = mr.bitmap.data;
  for (let i = 0; i < RW * RH; i++) {
    const l = sd[i * 4] * 0.299 + sd[i * 4 + 1] * 0.587 + sd[i * 4 + 2] * 0.114;
    let t = (l - 55) / (165 - 55);
    t = Math.max(0, Math.min(1, t));
    t = t * t * (3 - 2 * t); // smoothstep
    const rough = 0.52 + (0.88 - 0.52) * t;
    md[i * 4] = 255;                    // R: 未使用(occlusion=1)
    md[i * 4 + 1] = (rough * 255) | 0;  // G: roughness
    md[i * 4 + 2] = 0;                  // B: metalness = 0
    md[i * 4 + 3] = 255;
  }
  const mrPng = await mr.getBufferAsync(Jimp.MIME_PNG);
  const mrTex = doc.createTexture('metal-rough')
    .setImage(new Uint8Array(mrPng))
    .setMimeType('image/png');
  mat.setMetallicRoughnessTexture(mrTex)
    .setRoughnessFactor(1.0)
    .setMetallicFactor(0.0);

  // エミッシブ(夜の透過光)専用テクスチャ:
  // 「近傍の平均輝度」でマスクする — 墨の中の孤立した明ノイズは周囲が暗いので
  // 確実に消え、和紙の面だけが光る
  const EW = 1024, EH = Math.max(1, Math.round(1024 * H / W));
  const emis = img.clone().resize(EW, EH);
  const ed2 = emis.bitmap.data;
  const eLum = new Uint8Array(EW * EH);
  for (let i = 0; i < EW * EH; i++) {
    eLum[i] = (ed2[i * 4] * 0.299 + ed2[i * 4 + 1] * 0.587 + ed2[i * 4 + 2] * 0.114) | 0;
  }
  const eBg = boxBlurU8(eLum, EW, EH, 6);
  for (let i = 0; i < EW * EH; i++) {
    let m2 = (eBg[i] - 68) / (108 - 68);      // 近傍が墨 → 0, 和紙 → 1
    m2 = Math.max(0, Math.min(1, m2));
    m2 = m2 * m2 * (3 - 2 * m2);
    ed2[i * 4] *= m2;
    ed2[i * 4 + 1] *= m2;
    ed2[i * 4 + 2] *= m2;
  }
  const emisJpg = await emis.quality(90).getBufferAsync(Jimp.MIME_JPEG);
  const emisTex = doc.createTexture('emissive')
    .setImage(new Uint8Array(emisJpg))
    .setMimeType('image/jpeg');
  mat.setEmissiveTexture(emisTex).setEmissiveFactor([1, 1, 1]);

  // ノーマルマップはノイズ源なので除去(形状は300kポリゴンが担う)
  mat.setNormalTexture(null);
}

await doc.transform(prune());
await io.write(outPath, doc);
console.log('written:', outPath);

// ---------- helpers ----------
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

// dilate=false: min(侵食) / dilate=true: max(膨張)。分離適用
function erodeRGB(src, dst, W, H, r, dilate = false) {
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
