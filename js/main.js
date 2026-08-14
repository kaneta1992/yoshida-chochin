// ============================================================
// main.js — 吉田提灯 3D ビューア
// PBR + IBL(PMREM環境マップによるGI近似) + ACES + Bloom
// デカールは DecalGeometry による3D投影(GLBモデルにも対応)
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import { LanternTextures } from './textures.js';
import { buildLantern, TOTAL_H, BODY_R } from './lantern.js';
import { UI } from './ui.js';
import { applyState, decodeShareHash } from './presets.js';

// ---------- 色定義(昼 / 夜) ----------
const SKY = {
  day:   { top: '#8fb0d6', mid: '#ccd9e6', bot: '#eae4d3' },
  night: { top: '#04060e', mid: '#0c1322', bot: '#212a42' },
};
const GROUND_DAY = new THREE.Color('#b3ada0');
const GROUND_NIGHT = new THREE.Color('#0f1219');
const FOG_DAY = new THREE.Color('#d6dde6');
const FOG_NIGHT = new THREE.Color('#0a0f1c');

const HANG_GAP = 0.14;          // 地面から火袋下端までの距離
const PIVOT_Y = HANG_GAP + TOTAL_H;
const TARGET_Y = HANG_GAP + TOTAL_H * 0.52;
const INITIAL_ROT_Y = Math.PI;  // 文様が正面を向く回転(プロシージャル)
const GLB_FRONT_ROT = Math.PI;  // GLB の正面補正(生成モデルごとに要調整)
// モデル更新時は ASSET_VER を上げる(GitHub Pages のキャッシュ対策)
const ASSET_VER = '2026-08-15b';
const GLB_PATH = `assets/lantern.glb?v=${ASSET_VER}`;
const PROXY_PATH = `assets/lantern-proxy.glb?v=${ASSET_VER}`; // デカール投影・レイキャスト用
const DECAL_LIFT_FINAL = 0.0018; // 本体投影時に表面から浮かせる量
const DECAL_LIFT_PROXY = 0.004;  // プロキシ投影時(ドラッグ中)の浮かせ量

class App {
  constructor() {
    this.state = {
      mode: 'day',
      autoRotate: false,
      sway: true,
      quality: 'auto',
      bloomEnabled: true,
      decals: [],          // {id, name, image, pos:V3, normal:V3, roll, size, opacity}
      selectedDecal: null,
      decalTabOpen: false,
    };
    this.modeT = 0;
    this.modeTarget = 0;
    this.viewShift = 0;        // パネル表示中のビュー上方シフト(px)
    this.viewShiftTarget = 0;
    this.decalMeshes = new Map();   // id -> Mesh
    this.decalRebuildId = null;     // 再投影待ちのデカールID
    this.lastDecalBuild = 0;
    this.clock = new THREE.Clock();
    this.fpsEMA = 16;
    this.usingGLB = false;

    this.initRenderer();
    this.initScene();
    this.initPost();
    this.initPointer();

    this.ui = new UI(this);
    this.applyQuality();
    this.tryLoadGLB();

    // 共有リンクから復元
    if (location.hash.startsWith('#p=')) {
      decodeShareHash(location.hash)
        .then((data) => data && applyState(this, data))
        .catch((e) => console.warn('share decode failed', e));
    } else {
      // 初期は夜モードでドラマチックに
      setTimeout(() => this.setMode('night'), 900);
    }

    window.addEventListener('resize', () => this.onResize());
    this.onResize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------- レンダラ ----------
  initRenderer() {
    const canvas = document.getElementById('stage');
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
  }

  // ---------- シーン ----------
  initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(FOG_DAY.clone(), 4, 15);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 40);
    this.camera.position.set(0.32, TARGET_Y + 0.18, 1.18);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, TARGET_Y, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 3.2;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.minPolarAngle = Math.PI * 0.12;
    this.controls.autoRotateSpeed = 1.1;
    this.controls.enablePan = false;
    this.controls.update();

    // 環境マップ(IBL = GI近似)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 1.0;
    pmrem.dispose();

    // 空ドーム
    this.skyCanvas = document.createElement('canvas');
    this.skyCanvas.width = 64; this.skyCanvas.height = 512;
    this.skyTex = new THREE.CanvasTexture(this.skyCanvas);
    this.skyTex.colorSpace = THREE.SRGBColorSpace;
    this.paintSky(0);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(13, 32, 16),
      new THREE.MeshBasicMaterial({ map: this.skyTex, side: THREE.BackSide, fog: false })
    );
    this.scene.add(dome);

    // 星(夜のみ)
    const starGeo = new THREE.BufferGeometry();
    const starPos = [];
    for (let i = 0; i < 380; i++) {
      const phi = Math.random() * Math.PI * 2;
      const theta = Math.acos(Math.random() * 0.85);
      const r = 12.4;
      starPos.push(
        r * Math.sin(theta) * Math.cos(phi),
        r * Math.cos(theta) + 0.5,
        r * Math.sin(theta) * Math.sin(phi)
      );
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xcfd8ef, size: 0.035, transparent: true, opacity: 0,
      sizeAttenuation: true, fog: false, depthWrite: false,
    });
    this.scene.add(new THREE.Points(starGeo, this.starMat));

    // 地面
    this.groundMat = new THREE.MeshStandardMaterial({
      color: GROUND_DAY.clone(), roughness: 0.96, metalness: 0,
    });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(8, 48), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // 夜の灯だまり(加算ブレンドの発光ディスク。実光源は使わない)
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 256;
    const gctx = glowCanvas.getContext('2d');
    const gg = gctx.createRadialGradient(128, 128, 6, 128, 128, 126);
    gg.addColorStop(0, 'rgba(255,166,80,0.95)');
    gg.addColorStop(0.35, 'rgba(224,120,40,0.5)');
    gg.addColorStop(1, 'rgba(160,70,20,0)');
    gctx.fillStyle = gg;
    gctx.fillRect(0, 0, 256, 256);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    this.glowPool = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({
        map: glowTex, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    this.glowPool.rotation.x = -Math.PI / 2;
    this.glowPool.position.y = 0.004;
    this.scene.add(this.glowPool);

    // 接地影(ブロブシャドウ)
    const shCanvas = document.createElement('canvas');
    shCanvas.width = shCanvas.height = 256;
    const sctx = shCanvas.getContext('2d');
    const sg = sctx.createRadialGradient(128, 128, 8, 128, 128, 124);
    sg.addColorStop(0, 'rgba(0,0,0,0.55)');
    sg.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = sg; sctx.fillRect(0, 0, 256, 256);
    const shTex = new THREE.CanvasTexture(shCanvas);
    this.blobShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(BODY_R * 4.4, BODY_R * 4.4),
      new THREE.MeshBasicMaterial({ map: shTex, transparent: true, opacity: 0.5, depthWrite: false })
    );
    this.blobShadow.rotation.x = -Math.PI / 2;
    this.blobShadow.position.y = 0.002;
    this.scene.add(this.blobShadow);

    // ライティング
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.3);
    this.sun.position.set(1.9, 2.8, 1.3);
    this.scene.add(this.sun);
    this.moon = new THREE.DirectionalLight(0x8093c9, 0.0);
    this.moon.position.set(-1.4, 2.2, -1.8);
    this.scene.add(this.moon);
    this.hemi = new THREE.HemisphereLight(0xdfe8f5, 0x8a7a63, 0.55);
    this.scene.add(this.hemi);

    // 提灯(プロシージャル版。GLB があれば後で差し替え)
    this.textures = new LanternTextures();
    const { group, body, bodyMat } = buildLantern(this.textures);
    this.body = body;
    this.bodyMat = bodyMat;
    this.lanternGroup = group;

    this.swayPivot = new THREE.Group();
    this.swayPivot.position.y = PIVOT_Y;
    group.position.y = -TOTAL_H;
    group.rotation.y = INITIAL_ROT_Y;
    this.swayPivot.add(group);
    this.scene.add(this.swayPivot);

    this.raycaster = new THREE.Raycaster();
    this._projHelper = new THREE.Object3D();
  }

  // ---------- Meshy 生成モデル(GLB)への差し替え ----------
  async tryLoadGLB() {
    try {
      const head = await fetch(GLB_PATH, { method: 'HEAD' });
      if (!head.ok) return;
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/');
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(GLB_PATH);
      this.swapToGLB(gltf.scene);
      console.info('GLB model loaded');
      // デカール用プロキシ(高ポリゴンモデルの投影負荷対策・任意)
      try {
        const proxy = await loader.loadAsync(PROXY_PATH);
        this.attachProxy(proxy.scene);
        console.info('decal proxy loaded');
      } catch { /* プロキシ無しなら本体に直接投影 */ }
    } catch (e) {
      console.info('GLB not available, using procedural model');
    }
  }

  swapToGLB(root) {
    // 正規化: 高さを TOTAL_H に、底面を y=0 に、XZ 中心へ
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const scale = TOTAL_H / size.y;
    root.scale.setScalar(scale);
    box.setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    root.position.x -= center.x;
    root.position.z -= center.z;
    root.position.y -= box.min.y;
    root.rotation.y = GLB_FRONT_ROT;
    // プロキシに同一変換を適用するため記録しておく
    this.glbXform = { scale, pos: root.position.clone(), rotY: GLB_FRONT_ROT };

    // 最大メッシュ = 火袋(デカール・発光の対象)
    let bodyMesh = null, maxVol = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const s = o.geometry.boundingBox.getSize(new THREE.Vector3());
      const vol = s.x * s.y * s.z;
      if (vol > maxVol) { maxVol = vol; bodyMesh = o; }
    });
    if (!bodyMesh) return;

    // 既存のプロシージャル形状を除去(デカールは残す)
    const keep = new Set([...this.decalMeshes.values()]);
    for (const child of [...this.lanternGroup.children]) {
      if (keep.has(child)) continue;
      this.lanternGroup.remove(child);
      child.traverse?.((o) => {
        o.geometry?.dispose?.();
      });
    }
    this.lanternGroup.add(root);

    // 夜の発光: GLB内蔵のエミッシブ(墨を黒マスク済み)を優先し、
    // 無ければベースカラーを流用
    const mat = bodyMesh.material;
    mat.emissive = new THREE.Color(0xffb066);
    if (!mat.emissiveMap) mat.emissiveMap = mat.map;
    mat.emissiveIntensity = 0;
    mat.envMapIntensity = 0.9;
    // ノーマルマップはフォトグラメトリノイズ源のため常に無効
    // (ラフネス等は tools/fix_textures.mjs で焼き直したものをそのまま使う)
    mat.normalMap = null;
    mat.needsUpdate = true;

    this.body = bodyMesh;
    this.bodyMat = mat;
    this.usingGLB = true;

    // デカールを新しいボディに再投影
    this.rebuildAllDecals();
  }

  // デカール投影・レイキャスト用の不可視プロキシ(本体と同一座標系)
  attachProxy(root) {
    if (!this.glbXform) return;
    root.scale.setScalar(this.glbXform.scale);
    root.position.copy(this.glbXform.pos);
    root.rotation.y = this.glbXform.rotY;
    root.visible = false;

    let mesh = null, maxVol = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const s = o.geometry.boundingBox.getSize(new THREE.Vector3());
      const vol = s.x * s.y * s.z;
      if (vol > maxVol) { maxVol = vol; mesh = o; }
    });
    if (!mesh) return;
    this.lanternGroup.add(root);
    this.proxyBody = mesh;
    this.rebuildAllDecals();
  }

  // デカールの投影先(プロキシ優先)
  get decalBody() {
    return this.proxyBody || this.body;
  }

  paintSky(t) {
    const ctx = this.skyCanvas.getContext('2d');
    const lerpHex = (a, b) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, lerpHex(SKY.day.top, SKY.night.top));
    g.addColorStop(0.55, lerpHex(SKY.day.mid, SKY.night.mid));
    g.addColorStop(1, lerpHex(SKY.day.bot, SKY.night.bot));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 512);
    this.skyTex.needsUpdate = true;
  }

  // ---------- ポストプロセス ----------
  initPost() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: this.renderer.capabilities.isWebGL2 ? 4 : 0,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.55, 0.78);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  // ---------- 品質 ----------
  setQuality(q) {
    this.state.quality = q;
    this.qualityDowngraded = false;
    this.applyQuality();
  }

  applyQuality() {
    const dpr = window.devicePixelRatio || 1;
    let cap;
    switch (this.state.quality) {
      case 'low': cap = 1.25; break;
      case 'high': cap = 2.5; break;
      default: cap = this.qualityDowngraded ? 1.5 : 2.0;
    }
    this.renderer.setPixelRatio(Math.min(dpr, cap));
    this.onResize();
  }

  get bloomActive() {
    if (!this.state.bloomEnabled) return false;
    if (this.state.quality === 'low') return false;
    if (this.state.quality === 'auto' && this.qualityDowngraded) return false;
    return true;
  }

  setBloom(on) { this.state.bloomEnabled = on; }

  // ---------- 昼夜 ----------
  setMode(mode, instant = false) {
    this.state.mode = mode;
    this.modeTarget = mode === 'night' ? 1 : 0;
    if (instant) {
      this.modeT = this.modeTarget;
      this.paintSky(this.modeT);
    }
    document.body.classList.toggle('mode-night', mode === 'night');
    document.body.classList.toggle('mode-day', mode === 'day');
  }

  // ---------- 表示オプション ----------
  setAutoRotate(on) { this.state.autoRotate = on; this.controls.autoRotate = on; }
  setSway(on) { this.state.sway = on; }

  // パネル表示中は 3D ビューを上へずらして提灯が隠れないようにする
  setPanelShift(panelHeightPx) {
    this.viewShiftTarget = panelHeightPx / 2;
  }

  resetCamera() {
    this.camera.position.set(0.32, TARGET_Y + 0.18, 1.18);
    this.controls.target.set(0, TARGET_Y, 0);
    this.controls.update();
  }

  // ---------- デカール ----------
  getSelectedDecal() {
    return this.state.decals.find((d) => d.id === this.state.selectedDecal) || null;
  }

  selectDecal(id) {
    this.state.selectedDecal = id;
  }

  async addDecal(file) {
    const dataURL = await fileToDataURL(file, 768);
    const id = 'd' + Math.random().toString(36).slice(2, 9);
    await this.textures.registerImage(id, dataURL);

    // カメラ正面へ配置
    const hit = this.raycastCenter();
    const d = {
      id, name: file.name, image: dataURL,
      pos: new THREE.Vector3(0, TOTAL_H * 0.55, BODY_R),
      normal: new THREE.Vector3(0, 0, 1),
      roll: 0, size: 0.12, opacity: 1,
      under: false, // true = 墨の下(和紙に直接印刷された見た目)
    };
    if (hit) this.hitToLocal(hit, d);
    this.state.decals.push(d);
    this.state.selectedDecal = id;
    this.buildDecalMesh(d);
  }

  // レイキャスト結果 → 提灯ローカル座標のデカール位置・法線
  hitToLocal(hit, d) {
    this.withRestPose(() => {
      d.pos = this.lanternGroup.worldToLocal(hit.point.clone());
      const wn = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      const gq = this.lanternGroup.getWorldQuaternion(new THREE.Quaternion()).invert();
      d.normal = wn.applyQuaternion(gq).normalize();
    });
  }

  // 吊り揺れを一時的に静止させて処理(投影の座標系を安定させる)
  withRestPose(fn) {
    const rx = this.swayPivot.rotation.x, rz = this.swayPivot.rotation.z;
    this.swayPivot.rotation.set(0, 0, 0);
    this.swayPivot.updateMatrixWorld(true);
    try { fn(); } finally {
      this.swayPivot.rotation.x = rx;
      this.swayPivot.rotation.z = rz;
      this.swayPivot.updateMatrixWorld(true);
    }
  }

  // 三角形の空間グリッド(デカール頂点 → 本体UVの対応付けに使用)
  getTriGrid(mesh) {
    if (mesh.userData.triGrid) return mesh.userData.triGrid;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    if (!uv) return null;
    const idx = geo.index;
    const cell = 0.03;
    const map = new Map();
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const getI = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    for (let t = 0; t < triCount; t++) {
      let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
      for (let k = 0; k < 3; k++) {
        const i = getI(t, k);
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      for (let ix = Math.floor(minX / cell); ix <= Math.floor(maxX / cell); ix++) {
        for (let iy = Math.floor(minY / cell); iy <= Math.floor(maxY / cell); iy++) {
          for (let iz = Math.floor(minZ / cell); iz <= Math.floor(maxZ / cell); iz++) {
            const key = `${ix},${iy},${iz}`;
            let arr = map.get(key);
            if (!arr) { arr = []; map.set(key, arr); }
            arr.push(t);
          }
        }
      }
    }
    const grid = { cell, map, pos, uv, getI };
    mesh.userData.triGrid = grid;
    return grid;
  }

  // デカール各頂点に本体メッシュのUVを対応付ける(墨マスク参照用)。
  // 重要: デカール三角形ごとに「同一の」ソース三角形からUVを外挿する。
  // 頂点ごとに最近傍を探すと、隣接頂点が別々のUVアトラス島に対応してしまい、
  // 三角形内の補間がテクスチャ全域を横切ってひび状のノイズになる。
  assignBodyUV(geo, targetMesh) {
    const grid = this.getTriGrid(targetMesh);
    if (!grid) return;
    const pAttr = geo.attributes.position;
    const out = new Float32Array(pAttr.count * 2);
    const valid = new Float32Array(pAttr.count); // 対応付けの信頼フラグ
    const MAX_D2 = 0.03 * 0.03; // これ以上離れた対応付けは信用しない
    const p = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    const tri = new THREE.Triangle();
    const cp = new THREE.Vector3();
    const uvA = new THREE.Vector2(), uvB = new THREE.Vector2(), uvC = new THREE.Vector2();
    const res = new THREE.Vector2();
    const verts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

    // DecalGeometry は非インデックスで 3 頂点 = 1 三角形
    for (let t0 = 0; t0 < pAttr.count; t0 += 3) {
      centroid.set(0, 0, 0);
      for (let k = 0; k < 3; k++) {
        verts[k].fromBufferAttribute(pAttr, t0 + k); // ワールド(rest)座標
        targetMesh.worldToLocal(verts[k]);
        centroid.add(verts[k]);
      }
      centroid.multiplyScalar(1 / 3);

      // 重心の最近傍ソース三角形を1つ選ぶ
      const cx = Math.floor(centroid.x / grid.cell);
      const cy = Math.floor(centroid.y / grid.cell);
      const cz = Math.floor(centroid.z / grid.cell);
      let bestD = Infinity, bestT = -1;
      for (let ring = 0; ring <= 1 && bestT < 0; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            for (let dz = -ring; dz <= ring; dz++) {
              if (ring === 1 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) < 1) continue;
              const arr = grid.map.get(`${cx + dx},${cy + dy},${cz + dz}`);
              if (!arr) continue;
              for (const t of arr) {
                const ia = grid.getI(t, 0), ib = grid.getI(t, 1), ic = grid.getI(t, 2);
                tri.a.fromBufferAttribute(grid.pos, ia);
                tri.b.fromBufferAttribute(grid.pos, ib);
                tri.c.fromBufferAttribute(grid.pos, ic);
                tri.closestPointToPoint(centroid, cp);
                const dd = cp.distanceToSquared(centroid);
                if (dd < bestD) { bestD = dd; bestT = t; }
              }
            }
          }
        }
      }
      if (bestT < 0) continue;

      // 選んだソース三角形の平面上で3頂点それぞれのUVを外挿
      const ia = grid.getI(bestT, 0), ib = grid.getI(bestT, 1), ic = grid.getI(bestT, 2);
      tri.a.fromBufferAttribute(grid.pos, ia);
      tri.b.fromBufferAttribute(grid.pos, ib);
      tri.c.fromBufferAttribute(grid.pos, ic);
      uvA.fromBufferAttribute(grid.uv, ia);
      uvB.fromBufferAttribute(grid.uv, ib);
      uvC.fromBufferAttribute(grid.uv, ic);
      const ok = bestD < MAX_D2 ? 1 : 0;
      for (let k = 0; k < 3; k++) {
        THREE.Triangle.getInterpolation(verts[k], tri.a, tri.b, tri.c, uvA, uvB, uvC, res);
        out[(t0 + k) * 2] = res.x;
        out[(t0 + k) * 2 + 1] = res.y;
        valid[t0 + k] = ok;
      }
    }
    geo.setAttribute('uvBody', new THREE.Float32BufferAttribute(out, 2));
    geo.setAttribute('uvBodyValid', new THREE.Float32BufferAttribute(valid, 1));
  }

  // final=true: 本体メッシュへ投影(高品質・確定時)
  // final=false: 軽量プロキシへ投影(ドラッグ中のプレビュー)
  buildDecalMesh(d, final = true) {
    const img = this.textures.images.get(d.id);
    if (!img || !this.body) return;

    const target = final ? this.body : this.decalBody;
    const lift = final || target === this.body ? DECAL_LIFT_FINAL : DECAL_LIFT_PROXY;

    this.withRestPose(() => {
      const wp = this.lanternGroup.localToWorld(d.pos.clone());
      const gq = this.lanternGroup.getWorldQuaternion(new THREE.Quaternion());
      const wn = d.normal.clone().applyQuaternion(gq).normalize();

      const h = this._projHelper;
      h.position.copy(wp);
      h.lookAt(wp.clone().add(wn));
      h.rotateZ((d.roll * Math.PI) / 180);

      const sh = d.size;
      const sw = sh * (img.width / img.height);
      const sz = Math.max(sw, sh);
      const geo = new DecalGeometry(target, wp, h.rotation.clone(), new THREE.Vector3(sw, sh, sz));

      // 表面から法線方向へわずかに浮かせる(骨のヒダ・プロキシ誤差との Z ファイト防止)
      const pAttr = geo.attributes.position, nAttr = geo.attributes.normal;
      for (let i = 0; i < pAttr.count; i++) {
        pAttr.setXYZ(
          i,
          pAttr.getX(i) + nAttr.getX(i) * lift,
          pAttr.getY(i) + nAttr.getY(i) * lift,
          pAttr.getZ(i) + nAttr.getZ(i) * lift
        );
      }

      // 「墨の下」モードは本体UVを対応付けて墨マスクを参照できるようにする
      if (d.under) this.assignBodyUV(geo, target);

      let mesh = this.decalMeshes.get(d.id);
      if (mesh && (mesh.userData.under !== !!d.under || d.under)) {
        // モード変更時と「下」モードは毎回マテリアルを作り直す
        // (墨マスクのuniformを現在の本体テクスチャに揃えるため)
        mesh.material.map?.dispose();
        mesh.material.dispose();
        mesh.material = this.makeDecalMaterial(d, img);
        mesh.userData.under = !!d.under;
      }
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geo;
        // 親から一旦外してワールド基準で再配置
        this.scene.attach(mesh);
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        mesh.scale.setScalar(1);
        mesh.updateMatrixWorld(true);
        this.lanternGroup.attach(mesh);
        if (!d.under) mesh.material.opacity = d.opacity;
      } else {
        mesh = new THREE.Mesh(geo, this.makeDecalMaterial(d, img));
        mesh.userData.under = !!d.under;
        mesh.renderOrder = 2;
        this.scene.add(mesh);
        this.lanternGroup.attach(mesh);
        this.decalMeshes.set(d.id, mesh);
      }
    });
  }

  // デカールのマテリアル生成
  // 上(over): 通常合成 = 墨の上に貼ったシール
  // 下(under): 乗算合成 = 和紙に直接印刷され、墨が上から覆う
  makeDecalMaterial(d, img) {
    if (d.under) {
      const tex = this.makeUnderTexture(d, img);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        blending: THREE.MultiplyBlending,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        toneMapped: false, // 乗算係数にトーンマッピングを掛けない
      });
      // 本体の墨マスク(エミッシブ=墨が黒)を参照し、墨の上では乗算係数を
      // 1(=無効果)へ寄せる → 墨に完全に覆われ、透けない
      const inkMask = this.bodyMat.emissiveMap || this.bodyMat.map;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.inkMask = { value: inkMask };
        shader.uniforms.uPulse = { value: 0 }; // 選択中の明滅(0=通常, 1=消灯)
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', 'attribute vec2 uvBody;\nattribute float uvBodyValid;\nvarying vec2 vUvBody;\nvarying float vUvValid;\n#include <common>')
          .replace('#include <uv_vertex>', '#include <uv_vertex>\nvUvBody = uvBody;\nvUvValid = uvBodyValid;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', 'uniform sampler2D inkMask;\nuniform float uPulse;\nvarying vec2 vUvBody;\nvarying float vUvValid;\n#include <common>')
          .replace('#include <map_fragment>', `#include <map_fragment>
            // 意味マスクはエミッシブのαチャンネル(1=紙, 0=墨)。
            // min 5タップで墨側へ保守的に膨張(細い筆線を消さない)
            float o = 1.0 / 2048.0;
            float aC = texture2D( inkMask, vUvBody ).a;
            float aL = texture2D( inkMask, vUvBody + vec2( -o, 0.0 ) ).a;
            float aR = texture2D( inkMask, vUvBody + vec2(  o, 0.0 ) ).a;
            float aD = texture2D( inkMask, vUvBody + vec2( 0.0, -o ) ).a;
            float aU = texture2D( inkMask, vUvBody + vec2( 0.0,  o ) ).a;
            float paper = min( aC, min( min( aL, aR ), min( aD, aU ) ) );
            // UV対応付けに失敗した三角形は隠す側に倒す
            paper *= step( 0.5, vUvValid );
            diffuseColor.rgb = mix( vec3( 1.0 ), diffuseColor.rgb, paper * ( 1.0 - uPulse ) );`);
        mat.userData.shader = shader;
      };
      return mat;
    }
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return new THREE.MeshStandardMaterial({
      map: tex,
      emissive: new THREE.Color(0xffb066),
      emissiveMap: tex,
      emissiveIntensity: 0,
      transparent: true,
      opacity: d.opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      roughness: 0.62,
      metalness: 0,
    });
  }

  // 乗算用テクスチャ: 白地に不透明度を掛けて合成(透明部=白=乗算で不変)
  makeUnderTexture(d, img) {
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = d.opacity;
    ctx.drawImage(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  // サイズ・回転・不透明度・重なりの編集(UI から)
  updateSelectedDecal(props) {
    const d = this.getSelectedDecal();
    if (!d) return;
    Object.assign(d, props);
    const mesh = this.decalMeshes.get(d.id);
    if ('under' in props) {
      // モード切替はマテリアル再生成が必要 → 即時に本体へ再投影
      this.decalRebuildId = null;
      this.buildDecalMesh(d, true);
      return;
    }
    if (mesh && 'opacity' in props && !('size' in props) && !('roll' in props)) {
      if (d.under) {
        // 乗算テクスチャは不透明度を白へのブレンドで表現するため再ベイク
        mesh.material.map?.dispose();
        mesh.material.map = this.makeUnderTexture(d, this.textures.images.get(d.id));
        mesh.material.needsUpdate = true;
      } else {
        mesh.material.opacity = d.opacity;
      }
      return;
    }
    this.requestDecalRebuild(d.id);
  }

  // スライダー確定時などに本体へ高品質投影し直す
  commitSelectedDecal() {
    const d = this.getSelectedDecal();
    if (!d) return;
    this.decalRebuildId = null;
    this.buildDecalMesh(d, true);
  }

  requestDecalRebuild(id) {
    this.decalRebuildId = id;
  }

  deleteSelectedDecal() {
    const id = this.state.selectedDecal;
    if (!id) return;
    const mesh = this.decalMeshes.get(id);
    if (mesh) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
      this.decalMeshes.delete(id);
    }
    this.state.decals = this.state.decals.filter((d) => d.id !== id);
    this.textures.removeImage(id);
    this.state.selectedDecal = null;
  }

  clearDecals() {
    for (const [, mesh] of this.decalMeshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
    this.decalMeshes.clear();
    this.state.decals = [];
    this.state.selectedDecal = null;
    this.textures.images.clear();
  }

  rebuildAllDecals() {
    for (const d of this.state.decals) this.buildDecalMesh(d);
  }

  raycastCenter() {
    for (const ny of [0.05, 0, 0.15, -0.15]) {
      this.raycaster.setFromCamera(new THREE.Vector2(0, ny), this.camera);
      const hit = this.raycaster.intersectObject(this.decalBody, false)[0];
      if (hit) return hit;
    }
    return null;
  }

  // ---------- ポインタ(デカール移動) ----------
  initPointer() {
    const el = this.renderer.domElement;
    this.dragging = false;

    el.addEventListener('pointerdown', (e) => {
      if (!this.state.decalTabOpen || this.state.decals.length === 0) return;
      const hit = this.raycastPointer(e);
      if (!hit) return;

      // タップ位置にあるデカールを探す
      const found = this.findDecalAt(hit.point);
      if (found) {
        this.state.selectedDecal = found.id;
        this.ui.renderDecalList();
      } else if (!this.state.selectedDecal) {
        return; // 選択なし & 空振り → オービットに任せる
      }
      const d = this.getSelectedDecal();
      if (!d) return;

      this.dragging = true;
      this.controls.enabled = false;
      document.body.classList.add('decal-dragging');
      el.setPointerCapture(e.pointerId);
      this.hitToLocal(hit, d);
      this.requestDecalRebuild(d.id);
      e.stopImmediatePropagation();
    }, true);

    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const hit = this.raycastPointer(e);
      const d = this.getSelectedDecal();
      if (hit && d) {
        this.hitToLocal(hit, d);
        this.requestDecalRebuild(d.id);
      }
    });

    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.controls.enabled = true;
      document.body.classList.remove('decal-dragging');
      try { el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      // ドラッグ終了時は本体へ高品質投影で確定
      const d = this.getSelectedDecal();
      if (d) { this.buildDecalMesh(d, true); this.decalRebuildId = null; }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  raycastPointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    return this.raycaster.intersectObject(this.decalBody, false)[0] || null;
  }

  findDecalAt(worldPoint) {
    for (let i = this.state.decals.length - 1; i >= 0; i--) {
      const d = this.state.decals[i];
      const center = this.lanternGroup.localToWorld(d.pos.clone());
      if (center.distanceTo(worldPoint) < Math.max(d.size * 0.7, 0.03)) return d;
    }
    return null;
  }

  // ---------- リサイズ ----------
  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.composer?.setPixelRatio(pr);
  }

  // ---------- メインループ ----------
  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    // FPS 監視 → 自動品質(一方向ダウングレード)
    this.fpsEMA = this.fpsEMA * 0.97 + dt * 1000 * 0.03;
    if (this.state.quality === 'auto' && !this.qualityDowngraded && t > 6 && this.fpsEMA > 26) {
      this.qualityDowngraded = true;
      this.applyQuality();
    }

    // 昼夜トランジション
    const prevT = this.modeT;
    this.modeT += (this.modeTarget - this.modeT) * (1 - Math.exp(-dt * 3.2));
    if (Math.abs(this.modeT - this.modeTarget) < 0.001) this.modeT = this.modeTarget;
    const m = THREE.MathUtils.smoothstep(this.modeT, 0, 1);

    if (Math.abs(this.modeT - prevT) > 0.0015) this.paintSky(m);

    // 蝋燭の揺らぎ
    const flick =
      0.55 * Math.sin(t * 11.0) +
      0.30 * Math.sin(t * 17.3 + 1.7) +
      0.15 * Math.sin(t * 29.0 + 4.2);

    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.98, 0.88, m);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(0.85, 0.12, m);
    this.sun.intensity = THREE.MathUtils.lerp(1.9, 0.0, m);
    this.moon.intensity = THREE.MathUtils.lerp(0.0, 0.22, m);
    this.hemi.intensity = THREE.MathUtils.lerp(0.55, 0.06, m);
    this.groundMat.color.copy(GROUND_DAY).lerp(GROUND_NIGHT, m);
    this.scene.fog.color.copy(FOG_DAY).lerp(FOG_NIGHT, m);
    this.starMat.opacity = m * 0.85;
    this.blobShadow.material.opacity = THREE.MathUtils.lerp(0.5, 0.3, m);

    const emiss = m * (1.45 + 0.22 * flick);
    this.bodyMat.emissiveIntensity = emiss;
    this.glowPool.material.opacity = m * (0.36 + 0.07 * flick);

    // デカールも紙と一緒に光る + 選択中はわずかに明滅
    for (const [id, mesh] of this.decalMeshes) {
      const d = this.state.decals.find((x) => x.id === id);
      if (!d) continue;
      const selected = id === this.state.selectedDecal && this.state.decalTabOpen;
      if (mesh.userData.under) {
        // 乗算モードはシェーダーの uniform で明滅させる
        const sh = mesh.material.userData.shader;
        if (sh) sh.uniforms.uPulse.value = selected ? 0.3 + 0.3 * Math.sin(t * 5.5) : 0;
        continue;
      }
      mesh.material.emissiveIntensity = emiss * 0.9;
      mesh.material.opacity = selected
        ? d.opacity * (0.72 + 0.28 * Math.sin(t * 5.5))
        : d.opacity;
    }

    // 吊り揺れ(デカール編集中は静止)
    if (this.state.sway && !this.state.decalTabOpen) {
      this.swayPivot.rotation.z = 0.022 * Math.sin(t * 0.66);
      this.swayPivot.rotation.x = 0.014 * Math.sin(t * 0.47 + 1.2);
    } else {
      this.swayPivot.rotation.z *= 0.94;
      this.swayPivot.rotation.x *= 0.94;
    }

    // デカール再投影(ドラッグ中はプロキシへ・スロットル)
    if (this.decalRebuildId && performance.now() - this.lastDecalBuild > 120) {
      const d = this.state.decals.find((x) => x.id === this.decalRebuildId);
      if (d) this.buildDecalMesh(d, false);
      this.decalRebuildId = null;
      this.lastDecalBuild = performance.now();
    }

    // パネル分のビューシフト(スムーズに追従)
    this.viewShift += (this.viewShiftTarget - this.viewShift) * (1 - Math.exp(-dt * 8));
    if (Math.abs(this.viewShift) > 0.5) {
      const w = window.innerWidth, h = window.innerHeight;
      this.camera.setViewOffset(w, h, 0, this.viewShift, w, h);
    } else if (this.camera.view?.enabled) {
      this.camera.clearViewOffset();
    }

    this.controls.update();

    if (this.bloomActive) {
      this.bloomPass.strength = 0.1 + 0.6 * m;
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

// ---------- 画像 → dataURL(縮小) ----------
async function fileToDataURL(file, maxDim) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej; img.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const hasAlpha = /png|webp|gif|svg/.test(file.type);
    return hasAlpha ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 起動 ----------
const app = new App();
window.__app = app;

// ローディング解除
let frames = 0;
(function waitReady() {
  frames++;
  if (frames > 12) {
    document.getElementById('loading').classList.add('done');
    return;
  }
  requestAnimationFrame(waitReady);
})();
