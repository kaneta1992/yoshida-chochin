// ============================================================
// ui.js — DOM UI とアプリ状態のバインディング
// ============================================================
import * as P from './presets.js';

export class UI {
  constructor(app) {
    this.app = app;
    this.activePanel = null;
    this.$ = (s) => document.querySelector(s);

    this.bindDock();
    this.bindView();
    this.bindDecal();
    this.bindPreset();

    this.$('#modeToggle').addEventListener('click', () => {
      app.setMode(app.state.mode === 'day' ? 'night' : 'day');
    });

    setTimeout(() => this.$('#hint')?.classList.add('gone'), 6000);
  }

  // パネルの高さ変化(デカール選択など)に合わせてビューシフトを更新
  updatePanelShift() {
    const panel = this.$('#panel');
    this.app.setPanelShift(this.activePanel && !panel.hidden ? panel.getBoundingClientRect().height : 0);
  }

  toast(msg, ms = 2400) {
    const t = this.$('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- ドック / パネル ----------
  bindDock() {
    const panel = this.$('#panel');
    document.querySelectorAll('.dock-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.panel;
        if (this.activePanel === name) {
          this.activePanel = null;
          panel.hidden = true;
          btn.classList.remove('active');
          this.app.state.decalTabOpen = false;
          this.app.setPanelShift(0);
          return;
        }
        this.activePanel = name;
        document.querySelectorAll('.dock-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.panel-page').forEach((p) => { p.hidden = p.dataset.page !== name; });
        panel.hidden = false;
        this.app.state.decalTabOpen = name === 'decal';
        this.app.setPanelShift(panel.getBoundingClientRect().height);
        if (name === 'preset') this.renderPresetList();
        if (name !== 'decal' && this.app.state.selectedDecal) {
          this.app.selectDecal(null);
          this.renderDecalList();
        }
      });
    });
    // 初期状態はパネルを閉じておく
    document.querySelectorAll('.dock-btn').forEach((b) => b.classList.remove('active'));
  }

  // ---------- 表示 ----------
  bindView() {
    this.$('#optAutoRotate').addEventListener('change', (e) => this.app.setAutoRotate(e.target.checked));
    this.$('#optSway').addEventListener('change', (e) => this.app.setSway(e.target.checked));
    this.$('#optBloom').addEventListener('change', (e) => this.app.setBloom(e.target.checked));
    this.$('#segQuality').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        this.$('#segQuality').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        this.app.setQuality(b.dataset.q);
      });
    });
    this.$('#btnResetCam').addEventListener('click', () => this.app.resetCamera());
  }

  // ---------- デカール ----------
  bindDecal() {
    this.$('#decalFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        await this.app.addDecal(file);
        this.renderDecalList();
        this.toast('提灯をドラッグして位置を調整できます');
      } catch (err) {
        console.error(err);
        this.toast('画像を読み込めませんでした');
      }
    });

    this.$('#dScale').addEventListener('input', (e) => {
      this.app.updateSelectedDecal({ size: parseFloat(e.target.value) });
    });
    this.$('#dRot').addEventListener('input', (e) => {
      this.app.updateSelectedDecal({ roll: parseFloat(e.target.value) });
    });
    // スライダーを離したら本体へ高品質投影
    ['#dScale', '#dRot'].forEach((s) =>
      this.$(s).addEventListener('change', () => this.app.commitSelectedDecal()));
    this.$('#dOpacity').addEventListener('input', (e) => {
      this.app.updateSelectedDecal({ opacity: parseFloat(e.target.value) });
    });

    this.$('#dDelete').addEventListener('click', () => {
      this.app.deleteSelectedDecal();
      this.renderDecalList();
    });
  }

  renderDecalList() {
    const ul = this.$('#decalList');
    ul.innerHTML = '';
    for (const d of this.app.state.decals) {
      const li = document.createElement('li');
      li.className = 'decal-item' + (d.id === this.app.state.selectedDecal ? ' selected' : '');
      li.style.backgroundImage = `url(${d.image})`;
      li.title = d.name || 'デカール';
      li.addEventListener('click', () => {
        this.app.selectDecal(d.id === this.app.state.selectedDecal ? null : d.id);
        this.renderDecalList();
      });
      ul.appendChild(li);
    }
    const sel = this.app.getSelectedDecal();
    const ed = this.$('#decalEditor');
    ed.hidden = !sel;
    if (sel) {
      this.$('#dScale').value = sel.size;
      this.$('#dRot').value = sel.roll;
      this.$('#dOpacity').value = sel.opacity;
    }
    this.updatePanelShift();
  }

  // ---------- プリセット ----------
  bindPreset() {
    this.$('#btnSavePreset').addEventListener('click', () => {
      const name = this.$('#presetName').value.trim() || `プリセット ${new Date().toLocaleDateString('ja-JP')}`;
      try {
        P.savePreset(name, P.captureState(this.app));
        this.$('#presetName').value = '';
        this.renderPresetList();
        this.toast(`「${name}」を保存しました`);
      } catch {
        this.toast('保存容量が不足しています。画像の少ないプリセットにしてください');
      }
    });

    this.$('#btnShare').addEventListener('click', async () => {
      try {
        const url = await P.encodeShareURL(P.captureState(this.app));
        if (url.length > 25000) {
          this.toast('画像が大きすぎて共有リンク化できません。「書き出し」をご利用ください', 3600);
          return;
        }
        await navigator.clipboard.writeText(url);
        this.toast(url.length > 8000
          ? 'リンクをコピーしました(長いURLのため一部アプリでは開けない場合があります)'
          : '共有リンクをコピーしました');
      } catch (err) {
        console.error(err);
        this.toast('コピーに失敗しました');
      }
    });

    this.$('#btnExport').addEventListener('click', () => {
      P.exportJSON(P.captureState(this.app));
      this.toast('JSONを書き出しました');
    });

    this.$('#importFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const data = await P.importJSON(file);
        await P.applyState(this.app, data);
        this.renderDecalList();
        this.toast('プリセットを読み込みました');
      } catch (err) {
        console.error(err);
        this.toast('読み込みに失敗しました');
      }
    });
  }

  renderPresetList() {
    const ul = this.$('#presetList');
    const list = P.listPresets();
    ul.innerHTML = '';
    if (list.length === 0) {
      const li = document.createElement('li');
      li.className = 'preset-empty';
      li.textContent = '保存されたプリセットはありません';
      ul.appendChild(li);
      return;
    }
    for (const p of list) {
      const li = document.createElement('li');
      li.className = 'preset-item';
      const date = new Date(p.date);
      li.innerHTML = `
        <span class="p-name">${escapeHTML(p.name)}</span>
        <span class="p-date">${date.getMonth() + 1}/${date.getDate()}</span>`;
      const apply = document.createElement('button');
      apply.textContent = '適用';
      apply.addEventListener('click', async () => {
        await P.applyState(this.app, p.data);
        this.renderDecalList();
        this.toast(`「${p.name}」を適用しました`);
      });
      const del = document.createElement('button');
      del.className = 'p-del';
      del.textContent = '削除';
      del.addEventListener('click', () => {
        P.deletePreset(p.id);
        this.renderPresetList();
      });
      li.appendChild(apply);
      li.appendChild(del);
      ul.appendChild(li);
    }
  }

  // 状態→UI 全同期(プリセット適用後など)
  syncAll() {
    const s = this.app.state;
    this.$('#optAutoRotate').checked = s.autoRotate;
    this.$('#optSway').checked = s.sway;
    this.$('#optBloom').checked = s.bloomEnabled;
    this.renderDecalList();
  }
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
