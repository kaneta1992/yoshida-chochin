// lantern-hq.glb から浮遊アーティファクト(肩上部 +Z 側の帯状ゴミ)を削除する
// 判定: 方位角 +Z±25°、y 0.20..0.62、半径が本体プロファイル+0.028 超の三角形
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';

const [,, inPath, outPath] = process.argv;

// ビューア上の実測による本体半径プロファイル(メッシュローカル座標)
const PROF = [
  [0.20, 0.435], [0.30, 0.420], [0.35, 0.404], [0.40, 0.385],
  [0.45, 0.365], [0.50, 0.315], [0.55, 0.240], [0.62, 0.230],
];
function rBody(y) {
  if (y <= PROF[0][0]) return PROF[0][1];
  for (let i = 1; i < PROF.length; i++) {
    if (y <= PROF[i][0]) {
      const [y0, r0] = PROF[i - 1], [y1, r1] = PROF[i];
      return r0 + (r1 - r0) * (y - y0) / (y1 - y0);
    }
  }
  return PROF[PROF.length - 1][1];
}

const io = new NodeIO();
const doc = await io.read(inPath);

let totalRemoved = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const idxAccessor = prim.getIndices();
    const idx = idxAccessor.getArray();
    const keep = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
      const cy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3;
      const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
      const r = Math.hypot(cx, cz);
      const inAz = cz > 0.2 && Math.abs(cx) < cz * 0.47;
      const delStrip = inAz && cy > 0.20 && cy < 0.62 && r > rBody(cy) + 0.028;
      // 帯の付け根の「つの」: az 0°±7°, 肩上端の corner から立ち上がる残骸
      const azDeg = Math.abs(Math.atan2(cx, cz) * 180 / Math.PI);
      const delHorn = cz > 0 && azDeg < 7 && cy > 0.502 && cy < 0.63 &&
        r > Math.max(0.26, 0.29 - (cy - 0.505) * 0.8);
      if (delStrip || delHorn) totalRemoved++;
      else keep.push(a, b, c);
    }
    idxAccessor.setArray(keep.length > 65535 ? new Uint32Array(keep) : new Uint16Array(keep));
  }
}
await doc.transform(prune());
await io.write(outPath, doc);
console.log(`removed ${totalRemoved} triangles ->`, outPath);
