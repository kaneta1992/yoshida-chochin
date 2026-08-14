# ============================================================
# meshy_generate.py — 参考写真から Meshy Multi-Image-to-3D で
# 提灯の GLB モデルを生成する
#
# 使い方:
#   python tools/meshy_generate.py <画像フォルダ> <出力GLBパス>
# ============================================================
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.request
import urllib.error

KEY_PATH = r"C:\Users\kanet\meshy_key.txt"
API = "https://api.meshy.ai/openapi/v1/multi-image-to-3d"
POLL_SEC = 20
TIMEOUT_MIN = 45


def api_request(url, key, data=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode() if data is not None else None,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode())


def to_data_uri(path, max_px=1568):
    """画像を data URI に。Pillow があれば縮小してリクエストを軽くする"""
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    try:
        from io import BytesIO
        from PIL import Image

        im = Image.open(path)
        im.thumbnail((max_px, max_px))
        buf = BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=90)
        raw = buf.getvalue()
        mime = "image/jpeg"
    except Exception:
        with open(path, "rb") as f:
            raw = f.read()
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def main():
    img_dir, out_path = sys.argv[1], sys.argv[2]
    with open(KEY_PATH) as f:
        key = f.read().strip()

    exts = (".jpg", ".jpeg", ".png", ".webp")
    names = [n for n in os.listdir(img_dir) if n.lower().endswith(exts)]
    # 正面を先頭に(Meshy は先頭画像を主ビューとして扱う)
    priority = {"front": 0, "right": 1, "back": 2, "left": 3}
    names.sort(key=lambda n: (priority.get(os.path.splitext(n)[0].lower(), 9), n))
    images = [os.path.join(img_dir, n) for n in names][:4]
    if not images:
        print("ERROR: no images found in", img_dir)
        sys.exit(1)

    print(f"uploading {len(images)} images:", [os.path.basename(p) for p in images], flush=True)
    polycount = int(os.environ.get("MESHY_POLYCOUNT", "30000"))
    payload = {
        "image_urls": [to_data_uri(p) for p in images],
        "should_remesh": True,
        "should_texture": True,
        "enable_pbr": True,
        "topology": "triangle",
        "target_polycount": polycount,
    }

    try:
        created = api_request(API, key, payload)
    except urllib.error.HTTPError as e:
        print("ERROR: create failed:", e.code, e.read().decode()[:500])
        sys.exit(1)

    task_id = created.get("result")
    print("task created:", task_id, flush=True)

    deadline = time.time() + TIMEOUT_MIN * 60
    while time.time() < deadline:
        time.sleep(POLL_SEC)
        try:
            task = api_request(f"{API}/{task_id}", key)
        except urllib.error.HTTPError as e:
            print("poll error:", e.code, flush=True)
            continue
        status = task.get("status")
        print(f"status={status} progress={task.get('progress')}", flush=True)
        if status == "SUCCEEDED":
            url = task["model_urls"]["glb"]
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            print("downloading glb ...", flush=True)
            urllib.request.urlretrieve(url, out_path)
            print("saved:", out_path, os.path.getsize(out_path), "bytes")
            # サムネイルも保存しておく
            thumb = task.get("thumbnail_url")
            if thumb:
                urllib.request.urlretrieve(thumb, out_path + ".thumb.png")
            return
        if status in ("FAILED", "CANCELED"):
            print("ERROR: task", status, json.dumps(task.get("task_error", {})))
            sys.exit(1)

    print("ERROR: timeout")
    sys.exit(1)


if __name__ == "__main__":
    main()
