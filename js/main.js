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
const INITIAL_ROT_Y = Math.PI;  // 文様が正面を向く回転
const GLB_PATH = 'assets/lantern.glb';

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
    const { group, body, bodyMat, candle } = buildLantern(this.textures);
    this.body = body;
    this.bodyMat = bodyMat;
    this.candle = candle;
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
      const gltf = await new GLTFLoader().loadAsync(GLB_PATH);
      this.swapToGLB(gltf.scene);
      console.info('GLB model loaded');
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

    // 既存のプロシージャル形状を除去(蝋燭・デカールは残す)
    const keep = new Set([this.candle, ...this.decalMeshes.values()]);
    for (const child of [...this.lanternGroup.children]) {
      if (keep.has(child)) continue;
      this.lanternGroup.remove(child);
      child.traverse?.((o) => {
        o.geometry?.dispose?.();
      });
    }
    this.lanternGroup.add(root);

    // 夜の発光: ベースカラーをエミッシブに流用(墨は光を通さない)
    const mat = bodyMesh.material;
    mat.emissive = new THREE.Color(0xffb066);
    mat.emissiveMap = mat.map;
    mat.emissiveIntensity = 0;
    mat.envMapIntensity = 0.9;

    this.body = bodyMesh;
    this.bodyMat = mat;
    this.usingGLB = true;

    // デカールを新しいボディに再投影
    this.rebuildAllDecals();
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

  buildDecalMesh(d) {
    const img = this.textures.images.get(d.id);
    if (!img || !this.body) return;

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
      const geo = new DecalGeometry(this.body, wp, h.rotation.clone(), new THREE.Vector3(sw, sh, sz));

      let mesh = this.decalMeshes.get(d.id);
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
        mesh.material.opacity = d.opacity;
      } else {
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        const mat = new THREE.MeshStandardMaterial({
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
        mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 2;
        this.scene.add(mesh);
        this.lanternGroup.attach(mesh);
        this.decalMeshes.set(d.id, mesh);
      }
    });
  }

  // サイズ・回転・不透明度の編集(UI から)
  updateSelectedDecal(props) {
    const d = this.getSelectedDecal();
    if (!d) return;
    Object.assign(d, props);
    const mesh = this.decalMeshes.get(d.id);
    if (mesh && 'opacity' in props && !('size' in props) && !('roll' in props)) {
      mesh.material.opacity = d.opacity; // 不透明度だけなら再投影不要
      return;
    }
    this.requestDecalRebuild(d.id);
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
      const hit = this.raycaster.intersectObject(this.body, false)[0];
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
      try { el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      // ドラッグ終了時は必ず最終位置で確定
      const d = this.getSelectedDecal();
      if (d) { this.buildDecalMesh(d); this.decalRebuildId = null; }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  raycastPointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    return this.raycaster.intersectObject(this.body, false)[0] || null;
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
    this.candle.intensity = m * (1.7 + 0.5 * flick);
    this.candle.position.x = 0.006 * Math.sin(t * 7.1);
    this.candle.position.z = 0.006 * Math.cos(t * 6.3);

    // デカールも紙と一緒に光る + 選択中はわずかに明滅
    for (const [id, mesh] of this.decalMeshes) {
      mesh.material.emissiveIntensity = emiss * 0.9;
      const d = this.state.decals.find((x) => x.id === id);
      if (!d) continue;
      const selected = id === this.state.selectedDecal && this.state.decalTabOpen;
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

    // デカール再投影(スロットル: DecalGeometry 生成は重い)
    if (this.decalRebuildId && performance.now() - this.lastDecalBuild > 120) {
      const d = this.state.decals.find((x) => x.id === this.decalRebuildId);
      if (d) this.buildDecalMesh(d);
      this.decalRebuildId = null;
      this.lastDecalBuild = performance.now();
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
