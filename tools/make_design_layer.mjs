// ============================================================
// make_design_layer.mjs — 文字レイヤー抽出(大きさ変更・白縁機能用)
//
// アルベドから「吉」等の墨文様を円筒座標(θ, y)のレイヤーに焼き出し、
// 元の位置を紙で埋める消去パッチを生成する。ランタイムはこの2枚を
// シェーダーで合成し、文字だけを任意スケールで再投影できる。
// GLB 自体は無改変(等倍+白縁オフなら素通しで完全に元の見た目)。
//
// 使い方: node make_design_layer.mjs input.glb 出力ディレクトリ
// 出力: design.png / design-patch.png / design-meta.json
// ============================================================
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import Jimp from 'jimp';

const [,, inPath, outDir] = process.argv;

const S = 2048;          // UV→3D ラスタライズ解像度(アルベドと同解像度でモアレ穴を防ぐ)
const DW = 2048, DH = 1024; // 円筒レイヤー解像度(θ×y)
const INK_TH = 100;      // これ未満の輝度 = 墨
const PAPER_TH = 145;    // これ以上 = 紙
const R_MIN = 0.24, R_MAX = 0.475; // 火袋の紙の半径帯(弓金具・口輪を除外)

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const doc = await io.read(inPath);

// ---------- メッシュの UV→3D ----------
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

const px3 = new Float32Array(S * S);
const py3 = new Float32Array(S * S);
const pz3 = new Float32Array(S * S);
const cov = new Uint8Array(S * S);
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
  for (let qy = minY; qy <= maxY; qy++) {
    for (let qx = minX; qx <= maxX; qx++) {
      const sx = qx + 0.5, sy = qy + 0.5;
      const w0 = ((by - cy) * (sx - cx) + (cx - bx) * (sy - cy)) / den;
      const w1 = ((cy - ay) * (sx - cx) + (ax - cx) * (sy - cy)) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
      const i = qy * S + qx;
      px3[i] = w0 * POS[ia * 3] + w1 * POS[ib * 3] + w2 * POS[ic * 3];
      py3[i] = w0 * POS[ia * 3 + 1] + w1 * POS[ib * 3 + 1] + w2 * POS[ic * 3 + 1];
      pz3[i] = w0 * POS[ia * 3 + 2] + w1 * POS[ib * 3 + 2] + w2 * POS[ic * 3 + 2];
      cov[i] = 1;
    }
  }
}

// ---------- アルベド ----------
const mat = doc.getRoot().listMaterials()[0];
const img = await Jimp.read(Buffer.from(mat.getBaseColorTexture().getImage()));
const { width: W, height: H, data } = img.bitmap;
const s2a = (x) => Math.min(S - 1, (x * S / W) | 0); // 2048→1024

// ---------- 紙の y 範囲を推定 ----------
let yLo = 1e9, yHi = -1e9;
const yVals = [];
for (let y = 0; y < H; y += 2) {
  for (let x = 0; x < W; x += 2) {
    const si = s2a(y) * S + s2a(x);
    if (!cov[si]) continue;
    const r = Math.hypot(px3[si], pz3[si]);
    if (r < 0.30 || r > R_MAX) continue;
    const i = (y * W + x) * 4;
    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    if (lum > PAPER_TH) yVals.push(py3[si]);
  }
}
yVals.sort((a, b) => a - b);
yLo = yVals[Math.floor(yVals.length * 0.005)];
yHi = yVals[Math.floor(yVals.length * 0.995)];
const ySpan = yHi - yLo;
console.log('paper y range:', yLo.toFixed(3), '..', yHi.toFixed(3));

// ---------- 円筒レイヤーへ焼き出し ----------
// 連続アルファでベイク: 擦れ・かすれの中間調をそのまま保持する
// a(lum): 95以下=完全な墨(1.0) / 175以上=紙(0.0) / 間は線形
const aSum = new Float64Array(DW * DH);
const aCnt = new Uint32Array(DW * DH);
const cSum = new Float64Array(DW * DH * 3); // αで重み付けした墨色
const cW = new Float64Array(DW * DH);
const pSum = new Float64Array(DW * DH * 3);
const pCnt = new Uint32Array(DW * DH);
let inkTexels = 0;
// デザイン空間(θ,y)へメッシュ三角形を直接ラスタライズし、セルごとに
// 最外半径(zバッファ)の面のUVだけを採用する。テクセル散布方式と違い、
// 内壁の混入・サンプリング穴・UV重複による位置誤りが構造的に起きない。
const TWO_PI = Math.PI * 2;
const rBuf = new Float32Array(DW * DH);
const uBuf = new Float32Array(DW * DH);
const vBuf = new Float32Array(DW * DH);
const covD = new Uint8Array(DW * DH);
for (let t = 0; t < IDX.length; t += 3) {
  const vi = [IDX[t], IDX[t + 1], IDX[t + 2]];
  const th = [], yn = [], rr = [], uu = [], vv = [];
  let rMn = 1e9, rMx = 0;
  for (let k = 0; k < 3; k++) {
    const i3 = vi[k] * 3;
    const r = Math.hypot(POS[i3], POS[i3 + 2]);
    rr.push(r); rMn = Math.min(rMn, r); rMx = Math.max(rMx, r);
    th.push(Math.atan2(POS[i3], POS[i3 + 2]));
    yn.push((POS[i3 + 1] - yLo) / ySpan);
    uu.push(UV[vi[k] * 2]); vv.push(UV[vi[k] * 2 + 1]);
  }
  if (rMx < R_MIN || rMn > R_MAX) continue;
  if (Math.max(...yn) < -0.02 || Math.min(...yn) > 1.02) continue;
  // 外向きの面だけ採用(内向きのゴースト面はレンダラでは裏面カリングで
  // 見えないが、zバッファでは外側にあると誤って勝ってしまう)
  {
    const a3 = vi[0] * 3, b3 = vi[1] * 3, c3 = vi[2] * 3;
    const e1x = POS[b3] - POS[a3], e1y = POS[b3 + 1] - POS[a3 + 1], e1z = POS[b3 + 2] - POS[a3 + 2];
    const e2x = POS[c3] - POS[a3], e2y = POS[c3 + 1] - POS[a3 + 1], e2z = POS[c3 + 2] - POS[a3 + 2];
    const nx = e1y * e2z - e1z * e2y;
    const nz = e1x * e2y - e1y * e2x;
    const cx = (POS[a3] + POS[b3] + POS[c3]) / 3;
    const cz = (POS[a3 + 2] + POS[b3 + 2] + POS[c3 + 2]) / 3;
    if (nx * cx + nz * cz <= 0) continue;
  }
  // θの継ぎ目(±π)を跨ぐ三角形は負側を+2πへシフトして連続にする
  if (Math.max(...th) - Math.min(...th) > Math.PI) {
    for (let k = 0; k < 3; k++) if (th[k] < 0) th[k] += TWO_PI;
  }
  const xs = th.map((a) => (a + Math.PI) / TWO_PI * DW);
  const ys = yn.map((n) => (1 - n) * (DH - 1));
  const den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
  if (Math.abs(den) < 1e-9) continue;
  const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs));
  const minY = Math.max(0, Math.floor(Math.min(...ys))), maxY = Math.min(DH - 1, Math.ceil(Math.max(...ys)));
  for (let qy = minY; qy <= maxY; qy++) {
    for (let qx = minX; qx <= maxX; qx++) {
      const sx = qx + 0.5, sy = qy + 0.5;
      const w0 = ((ys[1] - ys[2]) * (sx - xs[2]) + (xs[2] - xs[1]) * (sy - ys[2])) / den;
      const w1 = ((ys[2] - ys[0]) * (sx - xs[2]) + (xs[0] - xs[2]) * (sy - ys[2])) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const r = w0 * rr[0] + w1 * rr[1] + w2 * rr[2];
      if (r < R_MIN || r > R_MAX) continue;
      const di = qy * DW + (((qx % DW) + DW) % DW);
      if (r <= rBuf[di]) continue;
      rBuf[di] = r;
      uBuf[di] = w0 * uu[0] + w1 * uu[1] + w2 * uu[2];
      vBuf[di] = w0 * vv[0] + w1 * vv[1] + w2 * vv[2];
      covD[di] = 1;
    }
  }
}
// アルベドをバイリニアで参照(glTF: v=0が画像上端)
function sampleAlbedo(u, v) {
  const fx = Math.min(W - 1.001, Math.max(0, u * W - 0.5));
  const fy = Math.min(H - 1.001, Math.max(0, v * H - 0.5));
  const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const i00 = (y0 * W + x0) * 4 + c, i10 = (y0 * W + x0 + 1) * 4 + c;
    const i01 = ((y0 + 1) * W + x0) * 4 + c, i11 = ((y0 + 1) * W + x0 + 1) * 4 + c;
    out[c] = data[i00] * (1 - tx) * (1 - ty) + data[i10] * tx * (1 - ty) +
             data[i01] * (1 - tx) * ty + data[i11] * tx * ty;
  }
  return out;
}
const albC = new Float32Array(DW * DH * 3); // 円筒空間のアルベド(紙の移植元)
for (let di = 0; di < DW * DH; di++) {
  if (!covD[di]) continue;
  const [r, g, b] = sampleAlbedo(uBuf[di], vBuf[di]);
  albC[di * 3] = r; albC[di * 3 + 1] = g; albC[di * 3 + 2] = b;
  const lum = r * 0.299 + g * 0.587 + b * 0.114;
  const a = Math.max(0, Math.min(1, (175 - lum) / 80));
  aSum[di] += a; aCnt[di]++;
  if (a > 0) {
    cSum[di * 3] += r * a; cSum[di * 3 + 1] += g * a; cSum[di * 3 + 2] += b * a;
    cW[di] += a;
    if (a > 0.9) inkTexels++;
  }
  if (lum > 160) {
    pSum[di * 3] += r; pSum[di * 3 + 1] += g; pSum[di * 3 + 2] += b;
    pCnt[di]++;
  }
}
console.log('ink texels baked:', inkTexels);

// 文字レイヤー: コアマスク(濃い墨)で文様域を確定し、その周辺(サポート域)
// にだけ連続アルファを残す。紙の骨影・汚れ等の孤立ノイズはサポート外で消える。
const design = await Jimp.create(DW, DH, 0x00000000);
const dd = design.bitmap.data;
const aAvg = new Float64Array(DW * DH);
for (let i = 0; i < DW * DH; i++) aAvg[i] = aCnt[i] ? aSum[i] / aCnt[i] : 0;
let inkMask = new Uint8Array(DW * DH); // コア(確実に墨)
for (let i = 0; i < DW * DH; i++) {
  if (aAvg[i] > 0.45) inkMask[i] = 1;
}
inkMask = erode(dilate(inkMask, DW, DH, 1), DW, DH, 1); // クロージング(サンプリング穴を閉じる)
removeIslands(inkMask, DW, DH, 40);                      // スペックノイズ除去
// 文様本体(最大成分=吉)から θ で60°超離れた成分(背面の継ぎ目・金具影など)は
// スケール対象にしない = レイヤー外として元のまま残す
keepNearMain(inkMask, DW, DH, Math.PI / 3);
const support = dilate(fillHoles(inkMask, DW, DH), DW, DH, 4); // 擦れ・内部の掠れを含む支持域
// 色: αで重み付けした平均墨色。無いセルは近傍から伝播(白縁サンプリング用に広めに)
const inkCol = new Float64Array(DW * DH * 3);
const haveCol = new Uint8Array(DW * DH);
for (let i = 0; i < DW * DH; i++) {
  if (cW[i] > 0.05) {
    inkCol[i * 3] = cSum[i * 3] / cW[i];
    inkCol[i * 3 + 1] = cSum[i * 3 + 1] / cW[i];
    inkCol[i * 3 + 2] = cSum[i * 3 + 2] / cW[i];
    haveCol[i] = 1;
  }
}
propagateColor(inkCol, haveCol, DW, DH, 8);
let maskCells = 0, softCells = 0;
for (let i = 0; i < DW * DH; i++) {
  if (!support[i] || !haveCol[i]) continue;
  const a = Math.round(Math.min(1, aAvg[i]) * 255);
  if (a < 5) continue;
  dd[i * 4] = inkCol[i * 3];
  dd[i * 4 + 1] = inkCol[i * 3 + 1];
  dd[i * 4 + 2] = inkCol[i * 3 + 2];
  dd[i * 4 + 3] = a;
  if (inkMask[i]) maskCells++; else softCells++;
}
console.log('ink mask cells:', maskCells, ' soft edge cells:', softCells);

// ---------- 白縁用の外側距離場(SDF) ----------
// 多方向タップは太い縁で星形に破綻するため、墨の外側距離を焼いておき
// ランタイムは1タップで任意の太さの縁を滑らかに描く。内側の抜き(口など)
// にも正しく縁が付くよう、穴埋め前の inkMask を種にする。
const SDF_MAX = 96; // テクセル(これ以上は飽和)
let rSum = 0, rN = 0;
for (let i = 0; i < DW * DH; i++) if (inkMask[i] && rBuf[i] > 0) { rSum += rBuf[i]; rN++; }
const rMean = rN ? rSum / rN : (R_MIN + R_MAX) / 2;
// θ方向とy方向でテクセルの実寸が違うので重み付けする
const wy = (ySpan / DH) / ((2 * Math.PI * rMean) / DW);
const wd = Math.hypot(1, wy);
// 種は小島を強めに除去する。数十テクセルの汚れでも、太い縁を付けると
// 紙の上に大きな白い斑点として拡大されてしまうため
const sdfSeed = Uint8Array.from(inkMask);
removeIslands(sdfSeed, DW, DH, 800);
const sdf = new Float32Array(DW * DH);
const BIG = 1e9;
for (let i = 0; i < DW * DH; i++) sdf[i] = sdfSeed[i] ? 0 : BIG;
const relax = (i, j, w) => { if (sdf[j] + w < sdf[i]) sdf[i] = sdf[j] + w; };
for (let y = 0; y < DH; y++) {
  for (let x = 0; x < DW; x++) {
    const i = y * DW + x, xl = (x - 1 + DW) % DW, xr = (x + 1) % DW;
    relax(i, y * DW + xl, 1);
    if (y > 0) {
      relax(i, (y - 1) * DW + x, wy);
      relax(i, (y - 1) * DW + xl, wd);
      relax(i, (y - 1) * DW + xr, wd);
    }
  }
}
for (let y = DH - 1; y >= 0; y--) {
  for (let x = DW - 1; x >= 0; x--) {
    const i = y * DW + x, xl = (x - 1 + DW) % DW, xr = (x + 1) % DW;
    relax(i, y * DW + xr, 1);
    if (y < DH - 1) {
      relax(i, (y + 1) * DW + x, wy);
      relax(i, (y + 1) * DW + xr, wd);
      relax(i, (y + 1) * DW + xl, wd);
    }
  }
}
const sdfImg = await Jimp.create(DW, DH, 0x000000ff);
const sd = sdfImg.bitmap.data;
for (let i = 0; i < DW * DH; i++) {
  const v = Math.round(Math.min(1, sdf[i] / SDF_MAX) * 255);
  sd[i * 4] = sd[i * 4 + 1] = sd[i * 4 + 2] = v;
  sd[i * 4 + 3] = 255;
}
console.log('sdf: rMean', rMean.toFixed(3), 'wy', wy.toFixed(3), 'max', SDF_MAX);

// ---------- 紙パッチ: 同じ行の実物の紙を移植し、階調は勾配ドメインで合わせる ----------
// 提灯は回転体で骨の縞が水平なので、同じ高さ(=同じ行)の別の角度にある「文字が
// 無い紙」は骨も繊維も統計的に同一。そこから実画素を移植して穴を埋め、低周波
// (階調)だけをラプラス方程式(境界=周囲の実際の紙)の解に差し替える。
// 直線補間だとのっぺりした平面になり、夜は透過が濃度の1.8乗で効くため
// わずかな色ズレが「文字のゴースト」として残ってしまう。
const patch = await Jimp.create(DW, DH, 0x00000000);
const pd = patch.bitmap.data;

// 1) 穴 = 文字を確実に覆う領域。かすれ(薄い墨)も取りこぼさない
const glyphCore = fillHoles(inkMask, DW, DH);
const holeNear = dilate(glyphCore, DW, DH, 14);
const holeFar = dilate(glyphCore, DW, DH, 48);
const hole = new Uint8Array(DW * DH);
for (let i = 0; i < DW * DH; i++) {
  hole[i] = (holeNear[i] || (holeFar[i] && aAvg[i] > 0.03)) ? 1 : 0;
}

// 2) 同じ行の使える紙をミラータイルで敷き詰める(骨の縞と繊維がそのまま乗る)
const donor = Float32Array.from(albC);
const mirrorIdx = (t, L) => {
  if (L <= 1) return 0;
  const p = ((t % (2 * L)) + 2 * L) % (2 * L);
  return p < L ? p : 2 * L - 1 - p;
};
let rowsPatched = 0, rowsFailed = 0;
for (let y = 0; y < DH; y++) {
  const row = y * DW;
  let hasHole = false;
  for (let x = 0; x < DW; x++) if (hole[row + x]) { hasHole = true; break; }
  if (!hasHole) continue;
  // この行で移植元に使える x(覆われていて・穴でなく・墨でもない)
  const usable = new Uint8Array(DW);
  for (let x = 0; x < DW; x++) {
    const i = row + x;
    usable[x] = covD[i] && !hole[i] && aAvg[i] < 0.03 ? 1 : 0;
  }
  // 最長の連続区間を探す(θ方向はラップするので2周スキャン)
  let bestStart = -1, bestLen = 0, runStart = -1, runLen = 0;
  for (let k = 0; k < DW * 2; k++) {
    const x = k % DW;
    if (usable[x]) {
      if (runLen === 0) runStart = x;
      runLen++;
      if (runLen > bestLen && runLen <= DW) { bestLen = runLen; bestStart = runStart; }
    } else { runLen = 0; }
  }
  if (bestLen < 24) { rowsFailed++; continue; }
  rowsPatched++;
  for (let x = 0; x < DW; x++) {
    if (!hole[row + x]) continue;
    const sx = (bestStart + mirrorIdx(x - bestStart, bestLen)) % DW;
    const si = row + ((sx % DW) + DW) % DW;
    for (let c = 0; c < 3; c++) donor[(row + x) * 3 + c] = albC[si * 3 + c];
  }
}
console.log('patch rows: filled', rowsPatched, ' skipped', rowsFailed);

// 3) 低周波(階調)はラプラス方程式の解に差し替える。境界が周囲の紙と一致するので
//    段差が原理的に出ない。滑らかな場なので1/8解像度で解けば十分
const SC = 8, CW = Math.ceil(DW / SC), CH = Math.ceil(DH / SC);
const nC = CW * CH;
const refSum = new Float64Array(nC * 3), refCnt = new Uint32Array(nC);
const donSum = new Float64Array(nC * 3), donCnt = new Uint32Array(nC);
const holeCnt = new Uint32Array(nC), allCnt = new Uint32Array(nC);
for (let y = 0; y < DH; y++) {
  for (let x = 0; x < DW; x++) {
    const i = y * DW + x, ci = ((y / SC) | 0) * CW + ((x / SC) | 0);
    allCnt[ci]++;
    if (hole[i]) holeCnt[ci]++;
    else if (covD[i] && aAvg[i] < 0.03) {
      for (let c = 0; c < 3; c++) refSum[ci * 3 + c] += albC[i * 3 + c];
      refCnt[ci]++;
    }
    for (let c = 0; c < 3; c++) donSum[ci * 3 + c] += donor[i * 3 + c];
    donCnt[ci]++;
  }
}
const u = new Float64Array(nC * 3);
const fixed = new Uint8Array(nC);
let gr = 0, gg = 0, gb = 0, gn = 0;
for (let ci = 0; ci < nC; ci++) {
  if (refCnt[ci] > allCnt[ci] * 0.5 && holeCnt[ci] < allCnt[ci] * 0.35) {
    fixed[ci] = 1;
    for (let c = 0; c < 3; c++) u[ci * 3 + c] = refSum[ci * 3 + c] / refCnt[ci];
    gr += u[ci * 3]; gg += u[ci * 3 + 1]; gb += u[ci * 3 + 2]; gn++;
  }
}
for (let ci = 0; ci < nC; ci++) {
  if (fixed[ci]) continue;
  u[ci * 3] = gr / gn; u[ci * 3 + 1] = gg / gn; u[ci * 3 + 2] = gb / gn;
}
for (let it = 0; it < 3000; it++) {
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const ci = y * CW + x;
      if (fixed[ci]) continue;
      const xl = (x - 1 + CW) % CW, xr = (x + 1) % CW;
      const yu = Math.max(0, y - 1), yd = Math.min(CH - 1, y + 1);
      for (let c = 0; c < 3; c++) {
        u[ci * 3 + c] = 0.25 * (
          u[(y * CW + xl) * 3 + c] + u[(y * CW + xr) * 3 + c] +
          u[(yu * CW + x) * 3 + c] + u[(yd * CW + x) * 3 + c]);
      }
    }
  }
}
// 移植した紙の低周波(これを引いて高周波=骨と繊維だけを残す)
const donLow = new Float64Array(nC * 3);
for (let ci = 0; ci < nC; ci++) {
  for (let c = 0; c < 3; c++) donLow[ci * 3 + c] = donSum[ci * 3 + c] / donCnt[ci];
}
blurCoarse(donLow, CW, CH, 5);

// 4) 出力 = ラプラス解(階調) + 移植した紙の高周波(骨・繊維)
const sampleC = (arr, x, y, c) => {
  const fx = x / SC - 0.5, fy = y / SC - 0.5;
  const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(CH - 1, Math.floor(fy)));
  const tx = fx - x0, ty = Math.max(0, Math.min(1, fy - y0));
  const y1 = Math.min(CH - 1, y0 + 1);
  const xa = ((x0 % CW) + CW) % CW, xb = ((x0 + 1) % CW + CW) % CW;
  return (arr[(y0 * CW + xa) * 3 + c] * (1 - tx) + arr[(y0 * CW + xb) * 3 + c] * tx) * (1 - ty)
       + (arr[(y1 * CW + xa) * 3 + c] * (1 - tx) + arr[(y1 * CW + xb) * 3 + c] * tx) * ty;
};
const patchSoft = blurU8(Uint8Array.from(hole, (v) => v * 255), DW, DH, 2);
for (let i = 0; i < DW * DH; i++) {
  const a = hole[i] ? 255 : patchSoft[i];
  if (!a) continue;
  const x = i % DW, y = (i / DW) | 0;
  for (let c = 0; c < 3; c++) {
    const detail = donor[i * 3 + c] - sampleC(donLow, x, y, c);
    pd[i * 4 + c] = Math.max(0, Math.min(255, sampleC(u, x, y, c) + detail));
  }
  pd[i * 4 + 3] = a;
}

// ---------- メタ情報(スケール中心 = マスクの重心) ----------
let sumSin = 0, sumCos = 0, sumV = 0, sumA = 0;
for (let ry = 0; ry < DH; ry++) {
  for (let x = 0; x < DW; x++) {
    const a = dd[(ry * DW + x) * 4 + 3] / 255;
    if (!a) continue;
    const th = (x / DW) * 2 * Math.PI - Math.PI;
    sumSin += Math.sin(th) * a;
    sumCos += Math.cos(th) * a;
    sumV += (1 - ry / (DH - 1)) * a;
    sumA += a;
  }
}
const meta = {
  thetaC: Math.atan2(sumSin, sumCos),
  yLo, ySpan,
  ycN: sumV / sumA,
  rMax: R_MAX,
  texW: DW, texH: DH,
  sdfMax: SDF_MAX,
};
console.log('meta:', JSON.stringify(meta));

await design.writeAsync(`${outDir}/design.png`);
await patch.writeAsync(`${outDir}/design-patch.png`);
await sdfImg.writeAsync(`${outDir}/design-sdf.png`);
const fs = await import('fs');
fs.writeFileSync(`${outDir}/design-meta.json`, JSON.stringify(meta));
console.log('written: design.png / design-patch.png / design-sdf.png / design-meta.json');

// ---------- helpers ----------
function dilate(mask, w, h, r) {
  let m = Uint8Array.from(mask);
  for (let pass = 0; pass < r; pass++) {
    const n = Uint8Array.from(m);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (m[y * w + x]) continue;
        const xl = (x - 1 + w) % w, xr = (x + 1) % w;
        if (m[y * w + xl] || m[y * w + xr] ||
            (y > 0 && m[(y - 1) * w + x]) || (y < h - 1 && m[(y + 1) * w + x])) {
          n[y * w + x] = 1;
        }
      }
    }
    m = n;
  }
  return m;
}

// 粗いグリッドを箱ぼかし(θ方向はラップ)
function blurCoarse(arr, w, h, r) {
  const out = new Float64Array(arr.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      let n = 0, s0 = 0, s1 = 0, s2 = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const j = (yy * w + ((x + dx + w) % w)) * 3;
          s0 += arr[j]; s1 += arr[j + 1]; s2 += arr[j + 2]; n++;
        }
      }
      out[o] = s0 / n; out[o + 1] = s1 / n; out[o + 2] = s2 / n;
    }
  }
  arr.set(out);
}

function blurU8(src, w, h, r) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const xx = (x + dx + w) % w;
          s += src[yy * w + xx]; n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function erode(mask, w, h, r) {
  let m = Uint8Array.from(mask);
  for (let pass = 0; pass < r; pass++) {
    const n = Uint8Array.from(m);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        const xl = (x - 1 + w) % w, xr = (x + 1) % w;
        if (!m[y * w + xl] || !m[y * w + xr] ||
            (y > 0 && !m[(y - 1) * w + x]) || (y < h - 1 && !m[(y + 1) * w + x])) {
          n[y * w + x] = 0;
        }
      }
    }
    m = n;
  }
  return m;
}

// マスクの内部空洞を埋める(外側からの flood fill で到達できない領域)
// θ方向はラップ。上下端の非マスクセルから流し込む。
function fillHoles(mask, w, h) {
  const reach = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = y * w + x;
      if (!mask[i] && !reach[i]) { reach[i] = 1; stack.push(i); }
    }
  }
  while (stack.length) {
    const c = stack.pop();
    const y = (c / w) | 0, x = c % w;
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const xx = (x + ox + w) % w, yy = y + oy;
      if (yy < 0 || yy >= h) continue;
      const j = yy * w + xx;
      if (!mask[j] && !reach[j]) { reach[j] = 1; stack.push(j); }
    }
  }
  const out = Uint8Array.from(mask);
  for (let i = 0; i < w * h; i++) if (!mask[i] && !reach[i]) out[i] = 1;
  return out;
}

// 最大連結成分の θ 重心から maxDth 超離れた成分を除去
function keepNearMain(mask, w, h, maxDth) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let top = 0;
    stack[top++] = i; seen[i] = 1;
    const cells = [];
    let sSin = 0, sCos = 0;
    while (top > 0) {
      const c = stack[--top];
      cells.push(c);
      const th = ((c % w) / w) * 2 * Math.PI - Math.PI;
      sSin += Math.sin(th); sCos += Math.cos(th);
      const y = (c / w) | 0, x = c % w;
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = (x + ox + w) % w, yy = y + oy;
        if (yy < 0 || yy >= h) continue;
        const j = yy * w + xx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    comps.push({ cells, th: Math.atan2(sSin, sCos) });
  }
  if (!comps.length) return;
  comps.sort((a, b) => b.cells.length - a.cells.length);
  const mainTh = comps[0].th;
  for (let k = 1; k < comps.length; k++) {
    const d = Math.abs(Math.atan2(Math.sin(comps[k].th - mainTh), Math.cos(comps[k].th - mainTh)));
    if (d > maxDth) for (const c of comps[k].cells) mask[c] = 0;
  }
}

// minCells 未満の連結成分(スペックノイズ)を除去
function removeIslands(mask, w, h, minCells) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let top = 0, size = 0;
    stack[top++] = i; seen[i] = 1;
    const comp = [];
    while (top > 0) {
      const c = stack[--top];
      comp.push(c); size++;
      const y = (c / w) | 0, x = c % w;
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = (x + ox + w) % w, yy = y + oy;
        if (yy < 0 || yy >= h) continue;
        const j = yy * w + xx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    if (size < minCells) for (const c of comp) mask[c] = 0;
  }
}

// 色を持たないセルへ近傍色を反復伝播(マスク外の縁取り領域もカバー)
function propagateColor(col, have, w, h, passes) {
  for (let pass = 0; pass < passes; pass++) {
    const nh = Uint8Array.from(have);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (have[i]) continue;
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const xx = (x + ox + w) % w, yy = y + oy;
          if (yy < 0 || yy >= h) continue;
          const j = yy * w + xx;
          if (have[j]) { sr += col[j * 3]; sg += col[j * 3 + 1]; sb += col[j * 3 + 2]; n++; }
        }
        if (n) {
          col[i * 3] = sr / n; col[i * 3 + 1] = sg / n; col[i * 3 + 2] = sb / n;
          nh[i] = 1;
        }
      }
    }
    have.set(nh);
  }
}
