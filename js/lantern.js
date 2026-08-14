// ============================================================
// lantern.js — 弓張提灯のプロシージャルモデル
// 火袋(LatheGeometry・骨の実体形状) / 黒漆の口輪 / 鉄の弓金具
// ============================================================
import * as THREE from 'three';
import { RIBS } from './textures.js';

// 寸法(メートル)— 参考写真の比率から
export const BODY_H = 0.44;        // 火袋の高さ
export const BODY_R = 0.155;       // 最大半径
const CAP_R_TOP = 0.082;           // 上口輪の半径
const CAP_R_BOT = 0.088;           // 下口輪の半径
const CAP_H_TOP = 0.085;           // 上口輪の高さ
const CAP_H_BOT = 0.115;           // 下口輪の高さ(写真では深め)
export const TOTAL_H = BODY_H + CAP_H_TOP + CAP_H_BOT;

// 火袋のプロファイル(下→上)。骨のヒダを実ジオメトリで刻む
function bodyProfile() {
  const pts = [];
  const N = 560;
  for (let i = 0; i <= N; i++) {
    const t = i / N; // 0=下端, 1=上端
    // 卵形: 中央やや下が最も膨らむ
    const shape = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.94)), 0.66);
    let r = CAP_R_BOT + (BODY_R - CAP_R_BOT * 0.98) * shape;
    if (t > 0.985) r = THREE.MathUtils.lerp(r, CAP_R_TOP, (t - 0.985) / 0.015);
    if (t < 0.015) r = THREE.MathUtils.lerp(CAP_R_BOT, r, t / 0.015);

    // 骨のヒダ: 骨位置に鋭い凸、間の紙はわずかに窪む
    const f = (t * RIBS) % 1;
    const d = Math.min(f, 1 - f) * 2;            // 0=骨の真上, 1=中間
    const fade = Math.pow(Math.sin(Math.PI * t), 0.5); // 端はヒダを弱く
    const ridge = Math.exp(-(d * d) / 0.06);
    r += (ridge * 0.0042 - (1 - ridge) * 0.0012) * fade * (BODY_R / 0.155);

    pts.push(new THREE.Vector2(r, t * BODY_H));
  }
  return pts;
}

function lacquerMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x0a0a0b,
    roughness: 0.42,
    metalness: 0.0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.3,
    envMapIntensity: 0.7,
  });
}

function ironMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x141416,
    roughness: 0.52,
    metalness: 0.82,
    envMapIntensity: 0.6,
  });
}

// 帯板(薄い鉄のストラップ)を曲線に沿って生成
function strapAlongCurve(curve, width, thickness, segments, material) {
  const frames = curve.computeFrenetFrames(segments, false);
  const pts = curve.getSpacedPoints(segments);
  const geo = new THREE.BufferGeometry();
  const verts = [], norms = [], idx = [];
  const hw = width / 2, ht = thickness / 2;
  for (let i = 0; i <= segments; i++) {
    const p = pts[i];
    const n = frames.normals[i];
    const b = frames.binormals[i];
    // 断面: 幅方向 = binormal, 厚み方向 = normal
    const corners = [
      p.clone().addScaledVector(b, -hw).addScaledVector(n, ht),
      p.clone().addScaledVector(b, hw).addScaledVector(n, ht),
      p.clone().addScaledVector(b, hw).addScaledVector(n, -ht),
      p.clone().addScaledVector(b, -hw).addScaledVector(n, -ht),
    ];
    for (const c of corners) verts.push(c.x, c.y, c.z);
    const faceN = [n.clone(), b.clone(), n.clone().negate(), b.clone().negate()];
    for (const fn of [faceN[0], faceN[0], faceN[2], faceN[2]]) norms.push(fn.x, fn.y, fn.z);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 4, c = (i + 1) * 4;
    // 4面
    idx.push(a, c, a + 1, a + 1, c, c + 1);         // 上面
    idx.push(a + 1, c + 1, a + 2, a + 2, c + 1, c + 2); // 外側
    idx.push(a + 2, c + 2, a + 3, a + 3, c + 2, c + 3); // 下面
    idx.push(a + 3, c + 3, a, a, c + 3, c);         // 内側
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

export function buildLantern(textures) {
  const group = new THREE.Group();
  const iron = ironMaterial();

  // ---------- 火袋(和紙ボディ) ----------
  const bodyGeo = new THREE.LatheGeometry(bodyProfile(), 128);
  const bodyMat = new THREE.MeshStandardMaterial({
    map: textures.map,
    bumpMap: textures.bumpMap,
    bumpScale: 1.4,
    emissiveMap: textures.emissiveMap,
    emissive: new THREE.Color(0xffb066),
    emissiveIntensity: 0.0,
    roughness: 0.62,
    metalness: 0.0,
    envMapIntensity: 0.9,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = CAP_H_BOT;
  body.name = 'body';
  group.add(body);

  // 内側(裏面): 透けを抑えつつ厚みを見せる
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0x2a2017,
    side: THREE.BackSide,
  });
  const inner = new THREE.Mesh(bodyGeo, innerMat);
  inner.position.y = CAP_H_BOT;
  inner.scale.setScalar(0.998);
  group.add(inner);

  // ---------- 黒漆の口輪(上下) ----------
  const lacquer = lacquerMaterial();
  const botCap = new THREE.Mesh(
    new THREE.CylinderGeometry(CAP_R_BOT * 1.01, CAP_R_BOT * 0.96, CAP_H_BOT, 64, 1, false),
    lacquer
  );
  botCap.position.y = CAP_H_BOT / 2;
  group.add(botCap);

  const topCap = new THREE.Mesh(
    new THREE.CylinderGeometry(CAP_R_TOP * 0.97, CAP_R_TOP * 1.03, CAP_H_TOP, 64, 1, false),
    lacquer
  );
  topCap.position.y = CAP_H_BOT + BODY_H + CAP_H_TOP / 2;
  group.add(topCap);

  // 上蓋
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(CAP_R_TOP * 0.97, CAP_R_TOP * 0.97, 0.006, 64),
    lacquer
  );
  lid.position.y = CAP_H_BOT + BODY_H + CAP_H_TOP - 0.003;
  group.add(lid);

  // ---------- 提手(上部の半円ハンドル) ----------
  const topY = CAP_H_BOT + BODY_H + CAP_H_TOP;
  const handleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-CAP_R_TOP * 0.85, topY - 0.02, 0),
    new THREE.Vector3(-CAP_R_TOP * 0.9, topY + 0.045, 0),
    new THREE.Vector3(0, topY + 0.085, 0),
    new THREE.Vector3(CAP_R_TOP * 0.9, topY + 0.045, 0),
    new THREE.Vector3(CAP_R_TOP * 0.85, topY - 0.02, 0),
  ]);
  const handle = strapAlongCurve(handleCurve, 0.020, 0.004, 48, iron);
  group.add(handle);

  // ---------- 弓金具(側面を弧を描いて上下を結ぶ鉄帯) ----------
  const bowR = BODY_R + 0.052; // 火袋との間隔
  const bowCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-CAP_R_BOT * 0.9, 0.012, 0),
    new THREE.Vector3(-(CAP_R_BOT + 0.045), CAP_H_BOT * 0.8, 0),
    new THREE.Vector3(-bowR, CAP_H_BOT + BODY_H * 0.30, 0),
    new THREE.Vector3(-(bowR + 0.008), CAP_H_BOT + BODY_H * 0.58, 0),
    new THREE.Vector3(-bowR * 0.94, CAP_H_BOT + BODY_H * 0.88, 0),
    new THREE.Vector3(-(CAP_R_TOP + 0.055), topY + 0.030, 0),
    new THREE.Vector3(-CAP_R_TOP * 0.35, topY + 0.085, 0),
    new THREE.Vector3(0.012, topY + 0.088, 0),
  ]);
  const bow = strapAlongCurve(bowCurve, 0.022, 0.0045, 96, iron);
  group.add(bow);

  // 弓上部の吊りフック
  const hookCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.010, topY + 0.088, 0),
    new THREE.Vector3(0.030, topY + 0.093, 0),
    new THREE.Vector3(0.040, topY + 0.075, 0),
    new THREE.Vector3(0.028, topY + 0.062, 0),
  ]);
  const hook = new THREE.Mesh(
    new THREE.TubeGeometry(hookCurve, 24, 0.0035, 8, false),
    iron
  );
  group.add(hook);

  // 弓の下端の留め具
  const clamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.020, 0.035, 0.026),
    iron
  );
  clamp.position.set(-CAP_R_BOT * 0.98, 0.028, 0);
  group.add(clamp);

  // 蝋燭はポイントライトではなくエミッシブ+地面の発光ディスクで表現する
  // (実光源はフォトグラメトリメッシュの微細な穴から漏れて輝点になるため)
  return { group, body, bodyMat };
}
