// ============================================================
// presets.js — プリセットの保存 / 復元 / 共有リンク / 入出力
// ============================================================

const LS_KEY = 'yoshida-chochin.presets.v1';

// ---------- 現在状態 <-> JSON ----------
export function captureState(app) {
  return {
    version: 2,
    mode: app.state.mode,
    autoRotate: app.state.autoRotate,
    sway: app.state.sway,
    designFx: { ...app.state.designFx },
    camera: {
      px: app.camera.position.x, py: app.camera.position.y, pz: app.camera.position.z,
      tx: app.controls.target.x, ty: app.controls.target.y, tz: app.controls.target.z,
    },
    decals: app.state.decals.map((d) => ({
      id: d.id, name: d.name, image: d.image,
      pos: d.pos.toArray(), normal: d.normal.toArray(),
      roll: d.roll, size: d.size, opacity: d.opacity, under: !!d.under,
    })),
  };
}

export async function applyState(app, data) {
  if (!data || data.version !== 2) throw new Error('unsupported preset');
  const { Vector3 } = await import('three');

  app.clearDecals();
  for (const d of data.decals || []) {
    await app.textures.registerImage(d.id, d.image);
    app.state.decals.push({
      id: d.id, name: d.name, image: d.image,
      pos: new Vector3().fromArray(d.pos),
      normal: new Vector3().fromArray(d.normal),
      roll: d.roll || 0, size: d.size || 0.12, opacity: d.opacity ?? 1,
      under: !!d.under,
    });
  }
  app.rebuildAllDecals();

  app.setAutoRotate(!!data.autoRotate);
  app.setSway(data.sway !== false);
  app.setDesignFx(data.designFx || { scale: 1, outline: false, outlineW: 6 });
  app.setMode(data.mode === 'night' ? 'night' : 'day', true);

  if (data.camera) {
    const c = data.camera;
    app.camera.position.set(c.px, c.py, c.pz);
    app.controls.target.set(c.tx, c.ty, c.tz);
    app.controls.update();
  }
  app.ui.syncAll();
}

// ---------- localStorage ----------
export function listPresets() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch { return []; }
}

export function savePreset(name, data) {
  const list = listPresets();
  const entry = {
    id: 'p' + Math.random().toString(36).slice(2, 9),
    name: name || '無題',
    date: new Date().toISOString(),
    data,
  };
  list.unshift(entry);
  // 容量ガード: 保存に失敗したら古いものから間引く
  while (list.length > 0) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(list));
      return entry;
    } catch {
      list.pop();
      if (list.length === 0) throw new Error('storage full');
    }
  }
  return entry;
}

export function deletePreset(id) {
  const list = listPresets().filter((p) => p.id !== id);
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

// ---------- 共有リンク (deflate + base64url) ----------
function toBase64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeShareURL(data) {
  const json = new TextEncoder().encode(JSON.stringify(data));
  let payload, tag;
  if (typeof CompressionStream !== 'undefined') {
    payload = await deflate(json);
    tag = 'd';
  } else {
    payload = json;
    tag = 'r';
  }
  const hash = `#p=${tag}${toBase64url(payload)}`;
  const url = location.origin + location.pathname + hash;
  return url;
}

export async function decodeShareHash(hash) {
  const m = /#p=([dr])(.+)/.exec(hash);
  if (!m) return null;
  const bytes = fromBase64url(m[2]);
  const json = m[1] === 'd' ? await inflate(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(json));
}

// ---------- ファイル入出力 ----------
export function exportJSON(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chochin-preset-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function importJSON(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try { resolve(JSON.parse(r.result)); }
      catch (e) { reject(e); }
    };
    r.onerror = reject;
    r.readAsText(file);
  });
}
