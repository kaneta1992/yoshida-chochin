// ============================================================
// textures.js — 和紙テクスチャ・墨文様・デカールのプロシージャル合成
// カラー / バンプ / エミッシブの3種を Canvas で生成する
// ============================================================
import * as THREE from 'three';

export const TEX_W = 2048;
export const TEX_H = 1024;
export const RIBS = 34; // 提灯の骨の本数(ジオメトリと共有)

// 決定論的な乱数(毎回同じ和紙のムラを再現する)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 和紙の下地 ----------
function paintWashiBase(ctx, W, H) {
  // ベース色(生成り)
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.0, '#efe6cf');
  g.addColorStop(0.18, '#f4edda');
  g.addColorStop(0.55, '#f6f0df');
  g.addColorStop(0.85, '#f0e8d2');
  g.addColorStop(1.0, '#e9dfc6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const rnd = mulberry32(20260814);

  // 経年の淡いシミ・ムラ
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W, y = rnd() * H;
    const r = 20 + rnd() * 130;
    const alpha = 0.015 + rnd() * 0.035;
    const warm = rnd() > 0.5;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, warm ? `rgba(190,160,110,${alpha})` : `rgba(120,110,90,${alpha * 0.7})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // 和紙の繊維(短い明暗ストローク)
  ctx.lineCap = 'round';
  for (let i = 0; i < 5200; i++) {
    const x = rnd() * W, y = rnd() * H;
    const len = 4 + rnd() * 26;
    const ang = (rnd() - 0.5) * 0.9 + (rnd() > 0.85 ? Math.PI / 2 : 0);
    const light = rnd() > 0.45;
    ctx.strokeStyle = light
      ? `rgba(255,252,240,${0.04 + rnd() * 0.09})`
      : `rgba(160,140,105,${0.03 + rnd() * 0.06})`;
    ctx.lineWidth = 0.6 + rnd() * 1.1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  // 縦の貼り合わせ目(和紙の柱)をごく淡く
  const cols = 8;
  for (let i = 0; i < cols; i++) {
    const x = (i / cols) * W + W / cols * 0.5;
    const grad = ctx.createLinearGradient(x - 7, 0, x + 7, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, 'rgba(130,115,85,0.075)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - 7, 0, 14, H);
  }
}

// ---------- 骨(ひご)の陰影 ----------
// v=1 が提灯の上端 → canvas の y=0
function paintRibShading(ctx, W, H) {
  for (let i = 1; i < RIBS; i++) {
    const t = i / RIBS;              // 0(下)→1(上)
    const y = (1 - t) * H;           // canvas 座標
    // 骨の上側に落ちる影
    let grad = ctx.createLinearGradient(0, y - 6, 0, y);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(90,75,50,0.16)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - 6, W, 6);
    // 骨の稜線ハイライト
    grad = ctx.createLinearGradient(0, y, 0, y + 2.5);
    grad.addColorStop(0, 'rgba(255,252,242,0.30)');
    grad.addColorStop(1, 'rgba(255,252,242,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, W, 2.5);
    // 骨の下側のわずかな影
    grad = ctx.createLinearGradient(0, y + 2.5, 0, y + 7);
    grad.addColorStop(0, 'rgba(90,75,50,0.10)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y + 2.5, W, 5);
  }
  // 上下端の焼け込み(口輪付近のAO)
  let g = ctx.createLinearGradient(0, 0, 0, H * 0.09);
  g.addColorStop(0, 'rgba(45,35,20,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 0.09);
  g = ctx.createLinearGradient(0, H, 0, H * 0.91);
  g.addColorStop(0, 'rgba(45,35,20,0.38)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, H * 0.91, W, H * 0.09);
}

// ---------- 墨の筆文様(参考写真の意匠を再現) ----------
// 正面(u=0.5 付近)に大きな草書風の流水文。側面に雫形の飛沫。
function strokePath(ctx, pts, width, taper = true) {
  // pts: [{x,y}] を Catmull-Rom 的に滑らかに描く。筆の入り抜きを再現
  const N = 90;
  const smooth = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    smooth.push(sampleSpline(pts, t));
  }
  for (let i = 0; i < N; i++) {
    const t = i / N;
    // 入りは太く、抜きは細く
    const w = width * (taper ? (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.25))) : 1);
    ctx.strokeStyle = 'rgba(16,14,12,0.96)';
    ctx.lineWidth = Math.max(2, w);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(smooth[i].x, smooth[i].y);
    ctx.lineTo(smooth[i + 1].x, smooth[i + 1].y);
    ctx.stroke();
  }
}

function sampleSpline(pts, t) {
  const n = pts.length - 1;
  const f = t * n;
  const i = Math.min(n - 1, Math.floor(f));
  const u = f - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const cr = (a, b, c, d) =>
    0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
}

function blob(ctx, x, y, rx, ry, rot) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = 'rgba(16,14,12,0.96)';
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function paintPattern(ctx, W, H) {
  const cx = W * 0.5; // 正面中心
  ctx.save();

  // --- 上段: 右へ流れて鉤状に返す太い横画 ---
  strokePath(ctx, [
    { x: cx - W * 0.115, y: H * 0.170 },
    { x: cx - W * 0.030, y: H * 0.128 },
    { x: cx + W * 0.060, y: H * 0.130 },
    { x: cx + W * 0.108, y: H * 0.185 },
    { x: cx + W * 0.080, y: H * 0.260 },
    { x: cx + W * 0.012, y: H * 0.295 },
  ], H * 0.085);

  // --- 中段: 画面を横切る大きな S 字の流水 ---
  strokePath(ctx, [
    { x: cx - W * 0.150, y: H * 0.300 },
    { x: cx - W * 0.095, y: H * 0.365 },
    { x: cx + W * 0.010, y: H * 0.400 },
    { x: cx + W * 0.095, y: H * 0.455 },
    { x: cx + W * 0.060, y: H * 0.545 },
    { x: cx - W * 0.045, y: H * 0.565 },
    { x: cx - W * 0.125, y: H * 0.535 },
  ], H * 0.105);

  // --- 下段: 巻き込んで雫で終わる curl ---
  strokePath(ctx, [
    { x: cx - W * 0.130, y: H * 0.620 },
    { x: cx - W * 0.040, y: H * 0.660 },
    { x: cx + W * 0.070, y: H * 0.655 },
    { x: cx + W * 0.115, y: H * 0.730 },
    { x: cx + W * 0.055, y: H * 0.800 },
    { x: cx - W * 0.030, y: H * 0.790 },
  ], H * 0.095);

  // 起筆・終筆の雫だまり
  blob(ctx, cx - W * 0.115, H * 0.172, H * 0.052, H * 0.038, -0.5);
  blob(ctx, cx + W * 0.010, H * 0.298, H * 0.040, H * 0.030, 0.9);
  blob(ctx, cx - W * 0.128, H * 0.532, H * 0.048, H * 0.036, 2.6);
  blob(ctx, cx - W * 0.032, H * 0.788, H * 0.042, H * 0.032, 0.4);

  // --- 側面(裏側)の飛沫: 参考写真の巴状の雫 ---
  const bx = (cx + W * 0.5) % W; // 真裏
  blob(ctx, bx - W * 0.055, H * 0.330, H * 0.055, H * 0.042, -0.7);
  blob(ctx, bx + W * 0.030, H * 0.415, H * 0.048, H * 0.060, 0.5);
  blob(ctx, bx - W * 0.040, H * 0.520, H * 0.060, H * 0.045, 2.2);
  strokePath(ctx, [
    { x: bx - W * 0.050, y: H * 0.335 },
    { x: bx + W * 0.020, y: H * 0.395 },
    { x: bx + W * 0.028, y: H * 0.420 },
  ], H * 0.055);
  strokePath(ctx, [
    { x: bx + W * 0.026, y: H * 0.440 },
    { x: bx - W * 0.020, y: H * 0.495 },
    { x: bx - W * 0.042, y: H * 0.520 },
  ], H * 0.055);

  // --- 落款(小さな格子の印) ---
  const sx = cx - W * 0.020, sy = H * 0.630, sw = W * 0.026, sh = H * 0.075;
  ctx.strokeStyle = 'rgba(16,14,12,0.75)';
  ctx.lineWidth = 2.2;
  ctx.strokeRect(sx, sy, sw, sh);
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(sx, sy + (sh * i) / 6); ctx.lineTo(sx + sw, sy + (sh * i) / 6);
    ctx.stroke();
  }
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(sx + (sw * i) / 4, sy); ctx.lineTo(sx + (sw * i) / 4, sy + sh);
    ctx.stroke();
  }

  ctx.restore();

  // 墨のかすれ(エッジを紙色で細かく欠けさせる)
  const rnd = mulberry32(1911);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 900; i++) {
    const x = rnd() * W, y = rnd() * H;
    ctx.globalAlpha = 0.10 + rnd() * 0.18;
    ctx.beginPath();
    ctx.arc(x, y, 0.5 + rnd() * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ---------- バンプマップ ----------
function paintBump(ctx, W, H) {
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, W, H);
  const rnd = mulberry32(777);
  // 繊維の凹凸
  for (let i = 0; i < 4000; i++) {
    const x = rnd() * W, y = rnd() * H;
    const len = 3 + rnd() * 18;
    const ang = (rnd() - 0.5) * 0.8;
    const v = rnd() > 0.5 ? 255 : 0;
    ctx.strokeStyle = `rgba(${v},${v},${v},${0.05 + rnd() * 0.07})`;
    ctx.lineWidth = 0.7 + rnd();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  // 骨の稜線(強い凸)
  for (let i = 1; i < RIBS; i++) {
    const y = (1 - i / RIBS) * H;
    const g = ctx.createLinearGradient(0, y - 5, 0, y + 5);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(30,30,30,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 5, W, 10);
  }
}

// ============================================================
// LanternTextures — 合成管理クラス
// ============================================================
export class LanternTextures {
  constructor() {
    this.colorCanvas = document.createElement('canvas');
    this.colorCanvas.width = TEX_W; this.colorCanvas.height = TEX_H;
    this.emissiveCanvas = document.createElement('canvas');
    this.emissiveCanvas.width = TEX_W / 2; this.emissiveCanvas.height = TEX_H / 2;
    this.bumpCanvas = document.createElement('canvas');
    this.bumpCanvas.width = TEX_W / 2; this.bumpCanvas.height = TEX_H / 2;

    // 下地(和紙+骨陰影+文様)は不変なのでキャッシュしておく
    this.baseCanvas = document.createElement('canvas');
    this.baseCanvas.width = TEX_W; this.baseCanvas.height = TEX_H;
    const bctx = this.baseCanvas.getContext('2d');
    paintWashiBase(bctx, TEX_W, TEX_H);
    paintRibShading(bctx, TEX_W, TEX_H);
    paintPattern(bctx, TEX_W, TEX_H);

    const bumpCtx = this.bumpCanvas.getContext('2d');
    paintBump(bumpCtx, this.bumpCanvas.width, this.bumpCanvas.height);

    this.map = new THREE.CanvasTexture(this.colorCanvas);
    this.map.colorSpace = THREE.SRGBColorSpace;
    this.map.anisotropy = 4;
    this.emissiveMap = new THREE.CanvasTexture(this.emissiveCanvas);
    this.emissiveMap.colorSpace = THREE.SRGBColorSpace;
    this.bumpMap = new THREE.CanvasTexture(this.bumpCanvas);

    this.images = new Map(); // decalId -> HTMLImageElement
    this.compose();
  }

  // デカール画像を登録(dataURL から)。アスペクト比取得と3D投影用に保持
  async registerImage(id, dataURL) {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = dataURL;
    });
    this.images.set(id, img);
    return img;
  }

  removeImage(id) { this.images.delete(id); }

  // カラー+エミッシブを合成(デカールは3D投影のため含まない)
  compose() {
    const ctx = this.colorCanvas.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.baseCanvas, 0, 0);

    // エミッシブ: カラーに蝋燭の高さ方向グラデーションを乗算
    const ec = this.emissiveCanvas.getContext('2d');
    const eW = this.emissiveCanvas.width, eH = this.emissiveCanvas.height;
    ec.globalCompositeOperation = 'source-over';
    ec.drawImage(this.colorCanvas, 0, 0, eW, eH);
    ec.globalCompositeOperation = 'multiply';
    const g = ec.createLinearGradient(0, 0, 0, eH);
    g.addColorStop(0.00, '#5a3714');
    g.addColorStop(0.16, '#c46b1d');
    g.addColorStop(0.42, '#ffb257');
    g.addColorStop(0.60, '#ffc26e');
    g.addColorStop(0.82, '#c46b1d');
    g.addColorStop(1.00, '#4a2c10');
    ec.fillStyle = g;
    ec.fillRect(0, 0, eW, eH);
    ec.globalCompositeOperation = 'source-over';

    this.map.needsUpdate = true;
    this.emissiveMap.needsUpdate = true;
  }
}
