// HQ GLB からデカール投影用の軽量プロキシ(ジオメトリのみ)を作る
import { NodeIO } from '@gltf-transform/core';
import { weld, simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [,, inPath, outPath, ratioArg] = process.argv;
const ratio = parseFloat(ratioArg || '0.08');

const io = new NodeIO();
const doc = await io.read(inPath);

await doc.transform(
  dedup(),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01 }),
);

// マテリアル・テクスチャを全て除去
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    prim.setMaterial(null);
    // 位置・法線・UV(デカールの墨マスク参照に必要)以外の頂点属性を落とす
    for (const sem of prim.listSemantics()) {
      if (sem !== 'POSITION' && sem !== 'NORMAL' && sem !== 'TEXCOORD_0') {
        prim.setAttribute(sem, null);
      }
    }
  }
}
for (const tex of doc.getRoot().listTextures()) tex.dispose();
for (const mat of doc.getRoot().listMaterials()) mat.dispose();
await doc.transform(prune());

await io.write(outPath, doc);
console.log('proxy written:', outPath);
