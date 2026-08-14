# 吉田提灯 — 弓張提灯 3D ビューア

弓張提灯(ゆみはりちょうちん)を 360° 鑑賞できる Web ビューアです。
参考写真をもとに、火袋・黒漆の口輪・鉄の弓金具をプロシージャルに再現しています。

## 機能

- **360° オービット / ズーム** — ドラッグ回転、ピンチ / ホイールでズーム(モバイル最適化)
- **昼 / 夜モード** — 夜は蝋燭が灯り、炎の揺らぎ・ブルームで発光を表現
- **PBR + IBL** — PMREM 環境マップによる GI 近似、ACES トーンマッピング、クリアコート漆
- **デカール** — 任意の画像を火袋にドラッグ配置。サイズ / 回転 / 不透明度を調整可能
- **プリセット** — localStorage 保存、URL 共有リンク、JSON 書き出し / 読み込み
- **自動品質調整** — FPS を監視して低スペック端末では解像度・ブルームを自動調整

## ローカル実行

静的サイトなのでビルド不要です。任意の HTTP サーバーで配信してください。

```bash
python -m http.server 8123
```

→ http://localhost:8123 を開く

## GitHub Pages への公開

リポジトリの **Settings → Pages → Source** で `main` ブランチ / `/ (root)` を選ぶだけです。
ビルドステップはありません。

## 構成

```
index.html        エントリ(importmap で three.js を CDN から読み込み)
css/style.css     UI スタイル
js/main.js        シーン・ライティング・昼夜遷移・入力
js/lantern.js     提灯のプロシージャルモデル
js/textures.js    和紙 / 墨文様 / デカールの Canvas 合成
js/presets.js     プリセット保存・共有リンク codec
js/ui.js          DOM バインディング
```

## モデル生成(Meshy)

`assets/lantern.glb` は参考写真4枚(`ref/`、非公開)から Meshy Multi-Image-to-3D で生成した
30万ポリゴンモデル(Draco圧縮済み)。再生成する場合:

```bash
# 300k ポリゴンで生成
MESHY_POLYCOUNT=300000 python tools/meshy_generate.py ref assets/lantern-hq.glb
# Draco 圧縮して配置
npx @gltf-transform/cli draco assets/lantern-hq.glb assets/lantern.glb
```

APIキーは `C:\Users\kanet\meshy_key.txt` から読み込みます(リポジトリには含めません)。

### デカール投影プロキシ

`assets/lantern-proxy.glb` は同モデルを約8%に間引いたジオメトリのみのメッシュで、
デカールのドラッグ中のリアルタイム投影とレイキャストに使用します(確定時は本体へ高品質投影)。
モデルを再生成したら `tools/make_proxy.mjs` 相当の簡約化で作り直してください。
GLB が無い場合はプロシージャルモデル(`js/lantern.js`)にフォールバックします。
生成モデルの正面方向は個体差があるため `js/main.js` の `GLB_FRONT_ROT` で補正します。
