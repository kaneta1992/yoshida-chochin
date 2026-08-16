// ============================================================
// main.js — 吉田提灯 3D ビューア
// PBR + IBL(PMREM環境マップによるGI近似) + ACES + Bloom
// デカールは本体シェーダー内のプロジェクション合成
// (別メッシュを重ねないため、穴・ちぎれ・Zファイトが構造的に起きない)
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// 注意: JS更新時は index.html の main.js の ?v= と、この4つの ?v= を揃えて上げる
// (GitHub Pages のキャッシュでモジュールだけ古くなる事故を防ぐ)
import { LanternTextures } from './textures.js?v=2026-08-16j';
import { buildLantern, TOTAL_H, BODY_R } from './lantern.js?v=2026-08-16j';
import { UI } from './ui.js?v=2026-08-16j';
import { applyState, decodeShareHash } from './presets.js?v=2026-08-16j';

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
const ASSET_VER = '2026-08-15c';
const DESIGN_VER = '2026-08-16j'; // 文字レイヤー(design*.png/json)を更新したらここを上げる
const GLB_PATH = `assets/lantern.glb?v=${ASSET_VER}`;
const PROXY_PATH = `assets/lantern-proxy.glb?v=${ASSET_VER}`; // レイキャスト用の軽量メッシュ

// ---------- 材質の光学定数 ----------
// 反射率 R と透過率 T は別物。特に白顔料は R が高く T が低い。
// 薄手の提灯紙と実用塗膜に対する代表値(積分球実測ではない校正初期値)。
// 透過光は紙の中の光路が長いぶん反射光より黄色いので、色も別に持つ。
const T_PAPER = [0.40, 0.33, 0.22];  // 裸の和紙
const T_GOFUN = [0.15, 0.135, 0.12]; // 胡粉など白顔料 ≒ 和紙の0.38倍・脱色ぎみ
const T_SUMI = [0.014, 0.011, 0.009];// 濃い墨 ≒ 和紙の0.035倍
const T_STICKER = 0.02;        // 上貼りの不透明デカール
const PAPER_REF_ALBEDO = 0.60; // きれいな和紙のリニアアルベド
const TRANS_GAMMA = 1.8;       // 濃淡が透過へ効く強さ(Beer-Lambert 近似)
const INNER_BOUNCE = 0.35;     // 火袋内部の相互反射(上下が暗くなりすぎるのを防ぐ)
// 炎(蝋燭)の位置。火袋の紙は y=-0.623..0.509、半径は最大 0.475
const FLAME_Y = -0.30;         // 下から約28%の高さ
const FLAME_R = 0.44;          // 照度の正規化に使う代表半径
const PAPER_Y = [-0.623, 0.509]; // 紙の y 範囲。外は口輪・弓などの不透過部品
const FLAME_COLOR = 0xff9a4a;  // 蝋燭の炎(約1900K)
const LED_COLOR = 0xffc99a;    // 電池灯の電球色LED(約2700K)
const CYL_SUNLIT_FRAC = 0.32;  // 円筒の投影面積比(太陽が当たる割合の近似)

// ---------- シェーダープロジェクションデカール ----------
const MAX_DECALS = 8;      // 同時貼付数の上限(シェーダーの固定ループ)
const ATLAS_SIZE = 2048;   // 全デカール画像を1枚に収めるアトラス
const ATLAS_CELL = 512;    // 1デカールあたりのセル
const ATLAS_PAD = 8;       // セル間のにじみ防止マージン

const DECAL_DECL = /* glsl */ `
#define MAX_DECALS ${MAX_DECALS}
uniform sampler2D uDecalAtlas;
uniform mat4 uDecalMat[MAX_DECALS];
uniform vec4 uDecalRect[MAX_DECALS];
uniform vec4 uDecalPrm[MAX_DECALS];  // x:不透明度 y:墨の下 z:有効 w:選択明滅
uniform vec3 uDecalDir[MAX_DECALS];  // 投影方向(オブジェクト空間)
// 文字レイヤー(円筒再投影): x:大きさ y:白縁(0/1) z:縁太さ(px) w:有効
uniform vec4 uDesignPrm;
uniform vec4 uDesignGeoA;            // x:θ中心 y:yLo z:ySpan w:半径ゲート
uniform vec4 uDesignGeoB;            // x:y中心(正規化) y:1/texW z:1/texH
uniform sampler2D uDesign;           // 文字レイヤー(rgb:墨色 a:マスク)
uniform sampler2D uPatch;            // 消去パッチ(rgb:紙色 a:マスク)
uniform sampler2D uDesignSdf;        // 墨の外側距離(0..1 = 0..sdfMax テクセル)
// ---- 光学定数: 透過率は反射率とは別物として持つ ----
// 白顔料(胡粉)は「よく反射するのに光を通しにくい」ため、アルベドを発光へ
// 流用すると夜の明暗が実物と逆になる。材質ごとの透過率を分けて持つ。
// 透過光は紙の中を長く通るぶん反射光より黄色い(色も別に持つ)。
uniform vec3 uTransP;  // 裸の和紙の透過率(RGB)
uniform vec3 uTransG;  // 胡粉など白顔料(白縁)の透過率
uniform vec3 uTransS;  // 墨の透過率
uniform vec4 uTransB;  // x:きれいな和紙の基準アルベド y:透過の濃度指数
                       // z:上貼りシールの透過率 w:火袋内部の相互反射
uniform vec4 uFlame;   // xyz:炎の位置(オブジェクト空間) w:照度の正規化係数
uniform vec2 uBodyY;   // 火袋(紙)の y 範囲。外側は口輪・弓などの不透過部品
uniform vec3 uFlameRad;// 炎の放射(色×強さ)。昼は 0
uniform vec3 uInterior;// 外光が火袋内部に作る照度(昼の透け)
uniform vec3 uBounce;  // 光る火袋から口輪・弓へ回り込む光
varying vec3 vObjPos;
varying vec3 vObjNormal;
vec3 gLanternBase = vec3(1.0);
float gOutlineEdge = 0.0;   // 白縁(胡粉)の被覆率
vec3 gTransCol = vec3(0.0); // 材質ごとの透過率(RGB)
float gFlameE = 0.0;        // 炎による内面照度(正面で約1)
float gFitting = 0.0;       // 1 = 紙ではない不透過部品
`;

const DECAL_APPLY = /* glsl */ `
{
  // ---- 文字レイヤー(大きさ変更・白縁)。無効時は素通し=完全に元の見た目 ----
  if (uDesignPrm.w > 0.5) {
    float rCyl = length(vObjPos.xz);
    float vN = (vObjPos.y - uDesignGeoA.y) / uDesignGeoA.z;
    if (rCyl < uDesignGeoA.w && vN > 0.0 && vN < 1.0) {
      float theta = atan(vObjPos.x, vObjPos.z);
      // 1) 元の文字位置を紙で埋める(等倍座標)
      vec2 uvP = vec2(fract((theta + 3.14159265) / 6.2831853), 1.0 - vN);
      vec4 paperFill = texture2D(uPatch, uvP);
      diffuseColor.rgb = mix(diffuseColor.rgb, paperFill.rgb, paperFill.a);
      // 2) スケールした文字を描き直す(θ中心・y中心基準の等方スケール)
      float s = max(uDesignPrm.x, 0.05);
      float dth = mod(theta - uDesignGeoA.x + 3.14159265, 6.2831853) - 3.14159265;
      float su = fract((uDesignGeoA.x + dth / s + 3.14159265) / 6.2831853);
      float sv = uDesignGeoB.x + (vN - uDesignGeoB.x) / s;
      if (sv > 0.0 && sv < 1.0) {
        vec2 uvD = vec2(su, 1.0 - sv);
        vec4 ink = texture2D(uDesign, uvD);
        if (uDesignPrm.y > 0.5) {
          // 白縁: 墨の外側距離場から一定幅を白く抜く(1タップなので
          // どれだけ太くしても星形にならず輪郭が滑らか)
          float dist = texture2D(uDesignSdf, uvD).r * uDesignGeoB.w;
          float outsideInk = 1.0 - smoothstep(0.10, 0.30, ink.a);
          float edge = outsideInk * (1.0 - smoothstep(uDesignPrm.z - 1.0, uDesignPrm.z + 1.0, dist));
          // 白縁は素の紙ではなく胡粉などの白顔料。反射は紙より白いが、
          // 透過は紙より大幅に低い(夜は暗い輪として出るのが実物)
          gOutlineEdge = edge;
          // 胡粉の反射率は完全拡散白(1.0)より低い。0.95 は物理的にあり得ない白さ
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.80, 0.76), gOutlineEdge);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, ink.rgb, ink.a);
      }
    }
  }
}
{
  float lanternLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float paperMask = smoothstep(0.05, 0.18, lanternLum); // 墨=0 / 和紙=1(リニア輝度)

  // ---- 透過率を材質ごとに決める(デカール適用前の素の状態で分類する) ----
  // 和紙の中の濃淡(骨・継ぎ・汚れ)は Beer-Lambert 的に反射より強く透過へ効く
  float dens = clamp(lanternLum / uTransB.x, 0.0, 1.0);
  vec3 trans = mix(uTransS, uTransP * pow(dens, uTransB.y), paperMask);
  trans = mix(trans, uTransG, gOutlineEdge);   // 胡粉: 高反射・低透過

  for (int i = 0; i < MAX_DECALS; i++) {
    if (uDecalPrm[i].z < 0.5) continue;
    vec3 dp = (uDecalMat[i] * vec4(vObjPos, 1.0)).xyz;
    if (abs(dp.x) > 0.5 || abs(dp.y) > 0.5 || abs(dp.z) > 0.5) continue;
    if (dot(normalize(vObjNormal), uDecalDir[i]) > -0.15) continue; // 裏面へは投影しない
    vec2 duv = uDecalRect[i].xy + vec2(dp.x + 0.5, 0.5 - dp.y) * uDecalRect[i].zw;
    vec4 dc = texture2D(uDecalAtlas, duv);
    float a = dc.a * uDecalPrm[i].x * (1.0 - uDecalPrm[i].w);
    if (uDecalPrm[i].y > 0.5) {
      // 墨の下: 和紙に染み込んだ染料。反射も透過も同じ色で減衰する
      vec3 dye = mix(vec3(1.0), mix(vec3(1.0), dc.rgb, a), paperMask);
      diffuseColor.rgb *= dye;
      trans *= dye;
    } else {
      // 墨の上: 上から貼った不透過のシール。反射は絵柄、透過はほぼ無し
      diffuseColor.rgb = mix(diffuseColor.rgb, dc.rgb, a);
      trans = mix(trans, vec3(uTransB.z), a);
    }
  }
  gLanternBase = diffuseColor.rgb;
  gTransCol = trans;

  // ---- 炎による内面照度 E = cosθ / r^2 ----
  // 定数項は火袋内部での相互反射。これが無いと上下が実物より暗くなりすぎる
  vec3 fd = vObjPos - uFlame.xyz;
  float r2 = max(dot(fd, fd), 1e-4);
  vec3 fw = fd * inversesqrt(r2);
  float cosI = clamp(dot(fw, normalize(vObjNormal)), 0.0, 1.0);
  float aniso = mix(0.35, 1.0, length(fw.xz)); // 炎は真上・真下へは弱く放射する
  gFlameE = uFlame.w * cosI * aniso / r2 + uTransB.w;

  // 紙の y 範囲の外 = 口輪・弓・手さげなどの不透過部品
  gFitting = 1.0 - step(uBodyY.x, vObjPos.y) * step(vObjPos.y, uBodyY.y);
}
`;

// 発光 = 透過光。夜は内部の炎、昼は外光が火袋内部に作る照度が光源になる。
// 反射(diffuse)と同じ1枚の合成結果から材質を分類しているので、昼夜で
// デザインの見え方がずれることはない。
const EMISSIVE_TRANSMISSION = `
	totalEmissiveRadiance = gTransCol * (uFlameRad * gFlameE + uInterior)
		+ gLanternBase * uBounce * gFitting;
`;

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
      // 文字レイヤー(等倍+白縁オフなら素通し=完全に元の見た目)
      designFx: { scale: 1, outline: false, outlineW: 8 },
      lightSource: 'candle', // 中に入れる灯り: ろうそく / 電池灯(LED)
    };
    this.modeT = 0;
    this.modeTarget = 0;
    this.tmpColor = new THREE.Color();
    this.viewShift = 0;        // パネル表示中のビュー上方シフト(px)
    this.viewShiftTarget = 0;
    this.initDecalSystem();
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

    // 共有リンクから復元(デフォルトは昼モード)
    if (location.hash.startsWith('#p=')) {
      decodeShareHash(location.hash)
        .then((data) => data && applyState(this, data))
        .catch((e) => console.warn('share decode failed', e));
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

    // 環境マップ(IBL = GI近似)。屋外シーンなので、実際に見えている空と
    // 地面から作る。屋内スタジオ(RoomEnvironment)を光源にすると、
    // 発注判断に使う昼の色と陰影が屋外の実物とずれる
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this.envDay = this.buildSkyEnv(0);
    this.envNight = this.buildSkyEnv(1);
    this.scene.environment = this.envDay;
    this.scene.environmentIntensity = 1.0;

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
    // 真下は下輪と火皿が光を遮るので暗い。実物は輪状に明るくなる
    const gg = gctx.createRadialGradient(128, 128, 6, 128, 128, 126);
    gg.addColorStop(0, 'rgba(120,50,15,0.0)');
    gg.addColorStop(0.30, 'rgba(170,78,26,0.30)');
    gg.addColorStop(0.46, 'rgba(255,166,80,0.85)');
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
      this.tryLoadDesignLayer();
      // レイキャスト用プロキシ(高ポリゴンモデルの当たり判定負荷対策・任意)
      try {
        const proxy = await loader.loadAsync(PROXY_PATH);
        this.attachProxy(proxy.scene);
        console.info('raycast proxy loaded');
      } catch { /* プロキシ無しなら本体へ直接レイキャスト */ }
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

    // 既存のプロシージャル形状を除去
    for (const child of [...this.lanternGroup.children]) {
      this.lanternGroup.remove(child);
      child.traverse?.((o) => {
        o.geometry?.dispose?.();
      });
    }
    this.lanternGroup.add(root);

    // 夜の発光 = 昼のベースカラーそのもの(単一ソース設計)。
    // 同一テクスチャを emissiveMap に流用するため、昼と夜の見た目が
    // 乖離することは原理的にない(墨は暗いままわずかに透け、紙は光る)
    const mat = bodyMesh.material;
    mat.emissive = new THREE.Color(0xffb066);
    mat.emissiveMap = mat.map;
    mat.emissiveIntensity = 0;
    mat.envMapIntensity = 0.9;
    // ノーマルマップはフォトグラメトリノイズ源のため常に無効
    // (ラフネス等は tools/fix_textures.mjs で焼き直したものをそのまま使う)
    mat.normalMap = null;
    mat.needsUpdate = true;

    this.body = bodyMesh;
    this.bodyMat = mat;
    this.usingGLB = true;

    // デカールのプロジェクション合成を本体シェーダーに組み込む
    this.setupBodyDecals(mat);
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

  // 見えている空+地面と同じ色分布から IBL 用の環境マップを作る
  buildSkyEnv(t) {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64; // 正距円筒(上=天頂 下=足元)
    const ctx = cv.getContext('2d');
    const mix = (a, b) => new THREE.Color(a).lerp(new THREE.Color(b), t);
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, '#' + mix(SKY.day.top, SKY.night.top).getHexString());
    g.addColorStop(0.34, '#' + mix(SKY.day.mid, SKY.night.mid).getHexString());
    g.addColorStop(0.5, '#' + mix(SKY.day.bot, SKY.night.bot).getHexString());
    // 地平線から下は地面のバウンス光
    g.addColorStop(0.52, '#' + GROUND_DAY.clone().lerp(GROUND_NIGHT, t).getHexString());
    g.addColorStop(1, '#' + GROUND_DAY.clone().lerp(GROUND_NIGHT, t).getHexString());
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const env = this.pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    return env;
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
    if (this.state.decals.length >= MAX_DECALS) {
      throw new Error(`デカールは最大 ${MAX_DECALS} 枚までです`);
    }
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
    this.rebuildAllDecals();
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

  // ---------- シェーダープロジェクションデカール ----------
  // デカールは別メッシュではなく、本体マテリアルのフラグメントシェーダー内で
  // 投影合成する。本体表面そのものに合成されるため、穴・ちぎれ・Zファイトは
  // 構造的に発生せず、夜の発光(=昼のアルベド)にも自動で一致する。
  initDecalSystem() {
    this.atlasCanvas = document.createElement('canvas');
    this.atlasCanvas.width = this.atlasCanvas.height = ATLAS_SIZE;
    this.atlasCtx = this.atlasCanvas.getContext('2d');
    this.atlasTex = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlasTex.colorSpace = THREE.SRGBColorSpace;
    this.atlasTex.anisotropy = 4;
    this.atlasTex.flipY = false; // シェーダー側は上原点でセルを参照する
    this.decalSlotOf = new Map(); // decalId -> アトラススロット
    this.decalU = {
      uDecalAtlas: { value: this.atlasTex },
      uDecalMat: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Matrix4()) },
      uDecalRect: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector4()) },
      uDecalPrm: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector4(1, 0, 0, 0)) },
      uDecalDir: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector3(0, 0, 1)) },
      uDesignPrm: { value: new THREE.Vector4(1, 0, 6, 0) },
      uDesignGeoA: { value: new THREE.Vector4(0, 0, 1, 10) },
      uDesignGeoB: { value: new THREE.Vector4(0.5, 1 / 2048, 1 / 1024, 0) },
      uDesign: { value: null },
      uPatch: { value: null },
      uDesignSdf: { value: null },
      // 材質ごとの透過率(反射率とは独立)
      uTransP: { value: new THREE.Vector3(...T_PAPER) },
      uTransG: { value: new THREE.Vector3(...T_GOFUN) },
      uTransS: { value: new THREE.Vector3(...T_SUMI) },
      uTransB: { value: new THREE.Vector4(PAPER_REF_ALBEDO, TRANS_GAMMA, T_STICKER, INNER_BOUNCE) },
      uFlame: { value: new THREE.Vector4(0, FLAME_Y, 0, FLAME_R * FLAME_R) },
      uBodyY: { value: new THREE.Vector2(...PAPER_Y) },
      uFlameRad: { value: new THREE.Color(0, 0, 0) },
      uInterior: { value: new THREE.Color(0, 0, 0) },
      uBounce: { value: new THREE.Color(0, 0, 0) },
    };
    this.flameColor = new THREE.Color(FLAME_COLOR);
    this.flameY = FLAME_Y;
    this.flameFlicker = 1;
    this.flameGain = 2.5;
  }

  // 中に入れる灯りの種類。色温度・配光・揺らぎが変わる
  setLightSource(kind) {
    this.state.lightSource = kind === 'led' ? 'led' : 'candle';
    const led = this.state.lightSource === 'led';
    this.flameColor.set(led ? LED_COLOR : FLAME_COLOR);
    // 電池灯は面光源に近く、位置も高いので陰影が柔らかく均一になる
    this.decalU.uTransB.value.w = led ? 0.72 : INNER_BOUNCE;
    this.flameY = led ? -0.12 : FLAME_Y;
    this.flameFlicker = led ? 0 : 1;
    // 相互反射を強く取るぶん総量を下げ、紙面の明るさを揃える
    this.flameGain = led ? 1.55 : 2.5;
  }

  // 文字レイヤー(大きさ / 白縁)の更新。uniform のみ = 即時反映・即時復元。
  // 等倍かつ白縁オフのときはレイヤーを無効化し、元のテクスチャを素通しする
  setDesignFx(props) {
    Object.assign(this.state.designFx, props);
    const f = this.state.designFx;
    const active = this.designReady && (Math.abs(f.scale - 1) > 0.001 || f.outline);
    this.decalU.uDesignPrm.value.set(f.scale, f.outline ? 1 : 0, f.outlineW, active ? 1 : 0);
  }

  // 文字レイヤーのテクスチャとメタ情報を読み込む
  async tryLoadDesignLayer() {
    try {
      const meta = await (await fetch(`assets/design-meta.json?v=${DESIGN_VER}`)).json();
      const loader = new THREE.TextureLoader();
      const load = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));
      const [design, patch, sdf] = await Promise.all([
        load(`assets/design.png?v=${DESIGN_VER}`),
        load(`assets/design-patch.png?v=${DESIGN_VER}`),
        load(`assets/design-sdf.png?v=${DESIGN_VER}`),
      ]);
      for (const t of [design, patch, sdf]) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.flipY = false;
        t.wrapS = THREE.RepeatWrapping; // θ方向は周期
        t.anisotropy = 4;
        t.needsUpdate = true;
      }
      // 距離場は輝度そのものが数値なので sRGB 変換をかけない
      sdf.colorSpace = THREE.NoColorSpace;
      this.decalU.uDesign.value = design;
      this.decalU.uPatch.value = patch;
      this.decalU.uDesignSdf.value = sdf;
      this.decalU.uDesignGeoA.value.set(meta.thetaC, meta.yLo, meta.ySpan, meta.rMax);
      this.decalU.uDesignGeoB.value.set(meta.ycN, 1 / meta.texW, 1 / meta.texH, meta.sdfMax || 96);
      this.decalU.uBodyY.value.set(meta.yLo, meta.yLo + meta.ySpan);
      // 縁の太さを実寸(mm)で表示するための換算。シーンの単位はメートル
      const rMean = (meta.rMax || 0.475) * 0.88;
      this.mmPerTexel = (2 * Math.PI * rMean * (this.glbXform?.scale || 1) * 1000) / meta.texW;
      this.ui.syncAll();
      this.designReady = true;
      this.setDesignFx({});
      console.info('design layer loaded');
    } catch (e) {
      console.info('design layer not available', e);
    }
  }

  slotRect(slot) {
    const cells = ATLAS_SIZE / ATLAS_CELL;
    const cx = slot % cells, cy = Math.floor(slot / cells);
    return {
      px: cx * ATLAS_CELL + ATLAS_PAD,
      py: cy * ATLAS_CELL + ATLAS_PAD,
      pw: ATLAS_CELL - ATLAS_PAD * 2,
      ph: ATLAS_CELL - ATLAS_PAD * 2,
      u: (cx * ATLAS_CELL + ATLAS_PAD) / ATLAS_SIZE,
      v: (cy * ATLAS_CELL + ATLAS_PAD) / ATLAS_SIZE,
      w: (ATLAS_CELL - ATLAS_PAD * 2) / ATLAS_SIZE,
      h: (ATLAS_CELL - ATLAS_PAD * 2) / ATLAS_SIZE,
    };
  }

  // 本体マテリアルにデカール合成を注入する
  setupBodyDecals(mat) {
    const unifiedEmissive = mat.emissiveMap && mat.emissiveMap === mat.map;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.decalU);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', 'varying vec3 vObjPos;\nvarying vec3 vObjNormal;\n#include <common>')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjNormal = normal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', DECAL_DECL + '\n#include <common>')
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + DECAL_APPLY);
      if (unifiedEmissive) {
        // 発光は透過光として計算する(材質ごとの透過率 × 内側の照度)
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <emissivemap_fragment>', EMISSIVE_TRANSMISSION);
      }
    };
    mat.customProgramCacheKey = () => 'chochin-projected-decals';
    mat.needsUpdate = true;
  }

  // デカールの投影行列・パラメータをシェーダー uniform に反映
  syncDecalUniforms() {
    const U = this.decalU;
    for (let i = 0; i < MAX_DECALS; i++) U.uDecalPrm.value[i].z = 0;
    if (!this.body) return;
    this.withRestPose(() => {
      // 本体オブジェクト空間 → 提灯グループ空間(ポーズ非依存の相対変換)
      const matBodyToGroup = new THREE.Matrix4()
        .copy(this.lanternGroup.matrixWorld).invert()
        .multiply(this.body.matrixWorld);
      const matGroupToBody = matBodyToGroup.clone().invert();
      const h = this._projHelper;
      const P = new THREE.Matrix4();
      for (const d of this.state.decals) {
        const slot = this.decalSlotOf.get(d.id);
        if (slot === undefined || slot >= MAX_DECALS) continue;
        const img = this.textures.images.get(d.id);
        if (!img) continue;
        const sh = d.size;
        const sw = sh * (img.width / img.height);
        const sd = Math.max(sw, sh) * 0.8; // 投影の奥行き(曲面への回り込み量)
        h.position.copy(d.pos);
        h.lookAt(d.pos.clone().add(d.normal));
        h.rotateZ((d.roll * Math.PI) / 180);
        P.compose(d.pos, h.quaternion, new THREE.Vector3(sw, sh, sd));
        U.uDecalMat.value[slot].copy(P).invert().multiply(matBodyToGroup);
        U.uDecalDir.value[slot]
          .copy(d.normal).negate().transformDirection(matGroupToBody);
        const r = this.slotRect(slot);
        U.uDecalRect.value[slot].set(r.u, r.v, r.w, r.h);
        U.uDecalPrm.value[slot].set(d.opacity, d.under ? 1 : 0, 1, U.uDecalPrm.value[slot].w);
      }
    });
  }

  // アトラスの再構築(追加・削除・復元時)+ uniform 反映
  rebuildAllDecals() {
    this.decalSlotOf = new Map();
    this.atlasCtx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.state.decals.slice(0, MAX_DECALS).forEach((d, i) => {
      this.decalSlotOf.set(d.id, i);
      const img = this.textures.images.get(d.id);
      if (!img) return;
      const r = this.slotRect(i);
      this.atlasCtx.drawImage(img, r.px, r.py, r.pw, r.ph);
    });
    this.atlasTex.needsUpdate = true;
    this.syncDecalUniforms();
  }

  // サイズ・回転・不透明度・重なりの編集(UI から)。
  // すべて uniform 更新のみで即時反映(ジオメトリ再構築は不要)
  updateSelectedDecal(props) {
    const d = this.getSelectedDecal();
    if (!d) return;
    Object.assign(d, props);
    this.syncDecalUniforms();
  }

  // 互換API(UIから呼ばれる)。uniform 同期のみ
  commitSelectedDecal() {
    this.syncDecalUniforms();
  }

  deleteSelectedDecal() {
    const id = this.state.selectedDecal;
    if (!id) return;
    this.state.decals = this.state.decals.filter((d) => d.id !== id);
    this.textures.removeImage(id);
    this.state.selectedDecal = null;
    this.rebuildAllDecals();
  }

  clearDecals() {
    this.state.decals = [];
    this.state.selectedDecal = null;
    this.textures.images.clear();
    this.rebuildAllDecals();
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
      this.syncDecalUniforms();
      e.stopImmediatePropagation();
    }, true);

    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const hit = this.raycastPointer(e);
      const d = this.getSelectedDecal();
      if (hit && d) {
        this.hitToLocal(hit, d);
        this.syncDecalUniforms(); // uniform更新のみ = 毎フレーム追従できる
      }
    });

    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.controls.enabled = true;
      document.body.classList.remove('decal-dragging');
      try { el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
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
    const wantNightEnv = m > 0.5;
    if (wantNightEnv !== this.usingNightEnv) {
      this.usingNightEnv = wantNightEnv;
      this.scene.environment = wantNightEnv ? this.envNight : this.envDay;
    }

    // 蝋燭の揺らぎ(電池灯は揺れない)
    const flick = this.flameFlicker * (
      0.55 * Math.sin(t * 11.0) +
      0.30 * Math.sin(t * 17.3 + 1.7) +
      0.15 * Math.sin(t * 29.0 + 4.2));

    // 屋外の直射:天空光は実測でおよそ5:1。従来の1.4:1では立体感が出ず、
    // 紙が露出オーバーぎみでアルベドの差も潰れていた
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.88, 0.86, m);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(0.62, 0.10, m);
    this.sun.intensity = THREE.MathUtils.lerp(2.7, 0.0, m);
    this.moon.intensity = THREE.MathUtils.lerp(0.0, 0.22, m);
    this.hemi.intensity = THREE.MathUtils.lerp(0.36, 0.06, m);
    this.groundMat.color.copy(GROUND_DAY).lerp(GROUND_NIGHT, m);
    this.scene.fog.color.copy(FOG_DAY).lerp(FOG_NIGHT, m);
    this.starMat.opacity = m * 0.85;
    this.blobShadow.material.opacity = THREE.MathUtils.lerp(0.5, 0.3, m);

    // 炎の放射。紙(透過率0.40)を通した後の輝度で校正している
    this.decalU.uFlameRad.value.copy(this.flameColor)
      .multiplyScalar(m * (this.flameGain + 0.38 * flick));
    this.glowPool.material.opacity = m * (0.36 + 0.07 * flick);

    // 炎は軸上で静止せず数cm揺れる。ホットスポットが動いて陰影が揺らぐ
    const fl = this.decalU.uFlame.value;
    fl.x = this.flameFlicker * (0.028 * Math.sin(t * 2.3) + 0.014 * Math.sin(t * 5.1 + 2.0));
    fl.z = this.flameFlicker * (0.028 * Math.sin(t * 1.9 + 1.1) + 0.014 * Math.sin(t * 4.3));
    fl.y = this.flameY + 0.012 * flick;

    // 昼の透け: 外光が火袋の内部に作る照度。向こう側の紙を1回通って
    // 入ってくるので T_PAPER を1回分掛ける(手前の紙でもう1回減衰する)
    const interior = this.decalU.uInterior.value;
    interior.copy(this.sun.color).multiplyScalar(this.sun.intensity * CYL_SUNLIT_FRAC);
    interior.add(this.tmpColor.copy(this.hemi.color).multiplyScalar(this.hemi.intensity));
    interior.multiplyScalar(T_PAPER[0] / Math.PI);

    // 光る火袋から口輪・弓へのバウンス(実光源はメッシュの穴から漏れるため解析的に)
    this.decalU.uBounce.value.copy(this.flameColor).multiplyScalar(m * 0.42);

    // 選択中デカールの明滅(シェーダー uniform のみ)
    for (const d of this.state.decals) {
      const slot = this.decalSlotOf.get(d.id);
      if (slot === undefined || slot >= MAX_DECALS) continue;
      const selected = d.id === this.state.selectedDecal && this.state.decalTabOpen;
      this.decalU.uDecalPrm.value[slot].w = selected ? 0.3 + 0.3 * Math.sin(t * 5.5) : 0;
    }

    // 吊り揺れ(デカール編集中は静止)
    if (this.state.sway && !this.state.decalTabOpen) {
      this.swayPivot.rotation.z = 0.022 * Math.sin(t * 0.66);
      this.swayPivot.rotation.x = 0.014 * Math.sin(t * 0.47 + 1.2);
    } else {
      this.swayPivot.rotation.z *= 0.94;
      this.swayPivot.rotation.x *= 0.94;
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
