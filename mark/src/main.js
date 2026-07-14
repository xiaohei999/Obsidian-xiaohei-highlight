/*
 * Text Highlight Marker — Obsidian 插件
 * 编辑模式：使用 CodeMirror 6 Decoration（装饰层）渲染高亮，
 *   不修改文档、不包裹编辑器文本节点 —— 即"不污染原文"。
 * 阅读模式：仅对渲染后的 DOM 做包裹（不改变 .md 源文件）。
 * 高亮数据存于 highlight-data.json（与 data.json 设置分离）。
 */
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownView,
  Menu,
  setIcon,
  ItemView,
} = require('obsidian');
const { StateEffect, RangeSetBuilder } = require('@codemirror/state');
const { Decoration, ViewPlugin } = require('@codemirror/view');

const HIGHLIGHT_CLASS = 'highlight-marker';

const DEFAULT_SETTINGS = {
  colors: {
    blue: { name: '蓝色', color: '#4a90d9' },
    red: { name: '红色', color: '#e0524d' },
    green: { name: '绿色', color: '#3fa66a' },
    yellow: { name: '黄色', color: '#e6c34a' },
  },
  opacity: 50,
  // 批注弹窗外观
  noteFontSize: 14, // 批注文字字号(px)
  tipWidth: 320, // 弹出窗宽度(px)
  noteRows: 3, // 批注编辑框行数
  // 高亮/批注数据的持久化目录（相对 vault 根目录）。留空则存于插件目录下，
  // 设为自定义目录（如 "thm-data"）可避免更新/重装插件时被覆盖。
  dataDir: '',
};

// 高亮数据文件名
const DATA_FILE = 'highlight-data.json';

// 每个 EditorView 对应的文件路径（用于多窗格正确匹配高亮数据）
const cmFileMap = new WeakMap();

// 触发装饰层重建的副作用
const HIGHLIGHT_REFRESH = StateEffect.define();

class TextHighlightMarker extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.settings = null;
    this.highlightData = {};
    this.tooltipEl = null;
    this.hideTooltipTimer = null;
    this._selTimer = null;
    this._selBtn = null;
    this._selRange = null;
    this._refreshTimer = null;
    this._saveTimer = null;
    this._domObserver = null;
    this._domObserverTarget = null;
    this._appliedSig = null;
    this._applying = false;
    this.rightBtn = null;
    this._btnWatcher = null;
    this._rightBtnFloating = false;
    this._hlViewPlugin = null;
    this._editingId = null; // 标记面板中正在编辑批注的项，渲染时强制可编辑以避免搜索命中变只读丢焦点
  }

  /* ===================== 生命周期 ===================== */
  async onload() {
    await this.loadAllData();
    this.injectHighlightStyles();

    this.initHoverTooltip();
    this.initSelectionHighlighter();
    this.registerView('annotation-panel', (leaf) => new AnnotationPanelView(leaf, this));
    this.registerEvents();

    // 编辑模式高亮装饰层（CM6，不污染原文）
    this._hlViewPlugin = this.buildHighlightPlugin();
    this.registerEditorExtension(this._hlViewPlugin);

    // 左侧 ribbon：点开后选择颜色再标记选中文本
    this.addRibbonIcon('highlighter', '高亮选中文本（选择颜色）', (evt) => this.showColorMenu(evt));

    this.addCommand({
      id: 'export-annotations',
      name: '全局导出：所有文档批注',
      callback: () => this.exportAnnotationsToNote('all'),
    });
    this.addCommand({
      id: 'export-current-annotations',
      name: '导出当前文档批注',
      callback: () => this.exportAnnotationsToNote('current'),
    });
    this.addCommand({
      id: 'toggle-annotation-panel',
      name: '打开/收起批注面板',
      callback: () => this.toggleAnnotationPanel(),
    });
    for (const [key, c] of Object.entries(this.settings.colors)) {
      this.addCommand({
        id: `highlight-${key}`,
        name: `标记为${c.name}`,
        editorCallback: () => this.highlightSelection(key),
      });
    }

    this.addSettingTab(new TextHighlightMarkerSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.refreshCmFileMap();
      this.startRightButtonWatcher();
      this.scheduleRefresh();
    });

    // 安全网：阅读模式下定期（幂等）重绘高亮，确保任何异步渲染/切模式后都能显示
    this.registerInterval(
      window.setInterval(() => {
        const view = this.getMarkdownView();
        if (!view || this.getViewMode(view) !== 'preview') return;
        const fp = this.getCurrentFilePath();
        if (!fp || !(this.highlightData[fp] && this.highlightData[fp].length)) return;
        this.applyHighlights();
      }, 1500)
    );
  }

  onunload() {
    // 卸载前立即落盘，避免防抖窗口内未保存的数据丢失
    this.flushHighlightData();
    this.hideHighlightTooltip();
    this.hideSelectionButton();
    if (this._domObserver) this._domObserver.disconnect();
    if (this._btnWatcher) {
      this._btnWatcher.disconnect();
      this._btnWatcher = null;
    }
    if (this.rightBtn && this.rightBtn.isConnected) this.rightBtn.remove();
    const styleEl = document.getElementById('thm-highlight-styles');
    if (styleEl) styleEl.remove();
  }

  /* ===================== 设置 ===================== */
  async loadSettings() {
    // 兼容旧入口；实际数据由 loadAllData 一并加载
    let data = {};
    try {
      data = (await this.loadData()) || {};
    } catch (e) {
      data = {};
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    this.settings.colors = Object.assign({}, DEFAULT_SETTINGS.colors, this.settings.colors || {});
    if (typeof this.settings.opacity !== 'number') this.settings.opacity = 50;
    if (typeof this.settings.dataDir !== 'string') this.settings.dataDir = '';
  }

  /* ===================== 统一持久化（Obsidian 原生 data.json，重启可靠） =====================
   * 高亮数据与设置一起写入 Obsidian 托管的 data.json（<configDir>/plugins/<id>/data.json），
   * 由 Obsidian 负责落盘与重载 —— 这是 Obsidian 中最可靠的持久化方式，
   * 不依赖 vault.adapter 对任意路径的写入，重启/重装都不会丢。
   */
  async persistAll() {
    try {
      await this.saveData(
        Object.assign({}, this.settings, { highlights: this.highlightData })
      );
    } catch (e) {
      console.error('TextHighlightMarker: 保存数据失败', e);
    }
    // 可选：额外镜像一份到 vault 内自定义目录（best-effort，便于查阅/备份）
    if (this.settings.dataDir) this.mirrorToCustomDir();
  }

  async saveSettings() {
    await this.persistAll();
    this.injectHighlightStyles();
    this.scheduleRefresh();
  }

  scheduleSaveHighlightData() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.persistAll();
    }, 250);
  }

  // 立即落盘（用于卸载场景，避免防抖窗口内的数据丢失）
  async flushHighlightData() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this.persistAll();
  }

  // 额外镜像到 vault 内自定义目录（仅作便利副本，非数据真源）
  mirrorToCustomDir() {
    const custom = this.getCustomDir();
    if (!custom) return;
    const path = `${custom}/${DATA_FILE}`;
    const write = () =>
      this.app.vault.adapter.write(path, JSON.stringify(this.highlightData, null, 2)).catch(() => {});
    this.app.vault.adapter
      .exists(custom)
      .then((ex) => (ex ? write() : this.app.vault.adapter.mkdir(custom).then(write).catch(() => {})))
      .catch(() => {});
  }

  getCustomDir() {
    const custom = this.settings && this.settings.dataDir ? String(this.settings.dataDir).trim() : '';
    if (!custom) return '';
    return custom.replace(/^\/+|\/+$/g, '');
  }

  getPluginDir() {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  // ============ 加载（含一次性旧版迁移） ============
  async loadAllData() {
    let raw = {};
    try {
      raw = (await this.loadData()) || {};
    } catch (e) {
      raw = {};
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    this.settings.colors = Object.assign({}, DEFAULT_SETTINGS.colors, this.settings.colors || {});
    if (typeof this.settings.opacity !== 'number') this.settings.opacity = 50;
    if (typeof this.settings.dataDir !== 'string') this.settings.dataDir = '';

    if (raw && raw.highlights && typeof raw.highlights === 'object' && !Array.isArray(raw.highlights)) {
      this.highlightData = raw.highlights;
    } else {
      this.highlightData = {};
      // 一次性迁移旧版独立 highlight-data.json（插件目录或旧自定义目录）
      await this.migrateLegacyOnce();
    }
    this.ensureHighlightIds();
  }

  async migrateLegacyOnce() {
    const candidates = [];
    candidates.push(`${this.getPluginDir()}/${DATA_FILE}`);
    const custom = this.getCustomDir();
    if (custom) candidates.push(`${custom}/${DATA_FILE}`);
    for (const p of candidates) {
      try {
        if (await this.app.vault.adapter.exists(p)) {
          const raw = await this.app.vault.adapter.read(p);
          const obj = JSON.parse(raw || '{}');
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            this.highlightData = obj;
            this.ensureHighlightIds();
            new Notice('已自动迁移旧版高亮数据');
            return;
          }
        }
      } catch (e) {
        /* ignore */
      }
    }
  }

  /* ===================== 备份：导出 / 导入 ===================== */
  // 统计当前数据规模
  getDataStats() {
    let files = 0;
    let count = 0;
    for (const fp in this.highlightData) {
      const arr = this.highlightData[fp];
      if (Array.isArray(arr) && arr.length) {
        files += 1;
        count += arr.length;
      }
    }
    return { files, count };
  }

  // 导出为下载文件（浏览器/Electron 下载，不污染 vault）
  exportBackup() {
    const stats = this.getDataStats();
    if (!stats.count) {
      new Notice('当前没有可导出的高亮/批注数据');
      return;
    }
    const payload = {
      plugin: this.manifest.id,
      version: this.manifest.version,
      exportedAt: new Date().toISOString(),
      data: this.highlightData,
    };
    const json = JSON.stringify(payload, null, 2);
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `highlight-backup-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      new Notice(`已导出 ${stats.count} 条批注（${stats.files} 个文件）`);
    } catch (e) {
      console.error('TextHighlightMarker: 导出备份失败', e);
      new Notice('导出失败，请查看控制台');
    }
  }

  // 从选择的 JSON 文件导入。mode: 'merge' 合并 | 'replace' 覆盖
  importBackup(mode) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        // 兼容两种格式：{plugin,data:{...}} 或直接 {filePath:[...]} 
        const incoming = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
          new Notice('导入失败：文件格式不正确');
          return;
        }
        const applied = this.applyImportedData(incoming, mode);
        this.ensureHighlightIds();
        await this.flushHighlightData();
        this.scheduleRefresh();
        this.refreshPanel();
        new Notice(`导入完成：${mode === 'replace' ? '覆盖' : '合并'} ${applied} 条批注`);
      } catch (e) {
        console.error('TextHighlightMarker: 导入备份失败', e);
        new Notice('导入失败：无法解析文件');
      }
    });
    input.click();
  }

  // 将导入数据应用到 highlightData，返回导入的条数
  applyImportedData(incoming, mode) {
    let total = 0;
    if (mode === 'replace') {
      this.highlightData = {};
    }
    for (const fp in incoming) {
      const arr = incoming[fp];
      if (!Array.isArray(arr)) continue;
      if (!this.highlightData[fp]) this.highlightData[fp] = [];
      const target = this.highlightData[fp];
      for (const h of arr) {
        if (!h || typeof h.text !== 'string') continue;
        // 合并去重：同一文件内按 id 或 (text+start) 判定是否已存在
        const dup = target.some(
          (x) =>
            (h.id != null && String(x.id) === String(h.id)) ||
            (x.text === h.text && x.start === h.start && x.end === h.end)
        );
        if (dup) continue;
        target.push({
          id: h.id != null ? h.id : this.generateHighlightId(),
          text: h.text,
          start: typeof h.start === 'number' ? h.start : 0,
          end: typeof h.end === 'number' ? h.end : h.text.length,
          color: h.color || Object.keys(this.settings.colors)[0],
          prefix: h.prefix || '',
          suffix: h.suffix || '',
          note: typeof h.note === 'string' ? h.note : '',
        });
        total += 1;
      }
    }
    return total;
  }

  ensureHighlightIds() {
    for (const fp in this.highlightData) {
      const arr = this.highlightData[fp];
      if (!Array.isArray(arr)) {
        this.highlightData[fp] = [];
        continue;
      }
      for (const h of arr) {
        if (h.id === undefined || h.id === null || h.id === '') h.id = this.generateHighlightId();
        if (h.note === undefined) h.note = '';
      }
    }
  }

  generateHighlightId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'hl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  getCurrentFilePath() {
    const f = this.app.workspace.getActiveFile();
    return f ? f.path : null;
  }

  getMarkdownView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  // 取得已打开且指向指定文件路径的 Markdown 视图（跨文档跳转用）
  getMarkdownViewForFile(fp) {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const v = leaf.view;
      if (v && v.file && v.file.path === fp) return v;
    }
    return null;
  }

  getViewMode(view) {
    if (!view) return null;
    if (typeof view.getMode === 'function') return view.getMode();
    if (view.previewMode && typeof view.previewMode.isActive === 'boolean') {
      return view.previewMode.isActive ? 'preview' : 'source';
    }
    return view.mode || 'source';
  }

  /* ===================== CM6 装饰层（编辑模式，不污染原文） ===================== */
  buildHighlightPlugin() {
    const plugin = this;
    return ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.view = view;
          this.decorations = this.compute(view);
        }
        update(u) {
          if (
            u.docChanged ||
            u.viewportChanged ||
            u.transactions.some((tr) => tr.effects.some((e) => e.is(HIGHLIGHT_REFRESH)))
          ) {
            this.decorations = this.compute(u.view);
          }
        }
        compute(view) {
          const fp = cmFileMap.get(view) || plugin.getCurrentFilePath();
          const data = fp ? plugin.highlightData[fp] || [] : [];
          const docLen = view.state.doc.length;
          const list = data
            .filter((h) => h && h.start >= 0 && h.end <= docLen && h.start < h.end)
            .sort((a, b) => a.start - b.start);
          const builder = new RangeSetBuilder();
          let lastEnd = -1;
          for (const h of list) {
            if (h.start < lastEnd) continue; // 跳过重叠，保证 RangeSet 有序
            builder.add(
              h.start,
              h.end,
              Decoration.mark({
                class: `${HIGHLIGHT_CLASS} ${HIGHLIGHT_CLASS}-${h.color}`,
                attributes: { 'data-hl-id': String(h.id) },
              })
            );
            lastEnd = h.end;
          }
          return builder.finish();
        }
      },
      { decorations: (v) => v.decorations }
    );
  }

  // 把当前所有 markdown 窗格的 EditorView 映射到其文件路径
  refreshCmFileMap() {
    const { workspace } = this.app;
    for (const leaf of workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (v && v.editor && v.editor.cm && v.file) {
        cmFileMap.set(v.editor.cm, v.file.path);
      }
    }
  }

  // 触发编辑模式装饰层重建
  refreshActiveEditor() {
    const view = this.getMarkdownView();
    if (!view || this.getViewMode(view) !== 'source') return;
    const cm = view.editor && view.editor.cm;
    if (!cm) return;
    try {
      cm.dispatch({ effects: HIGHLIGHT_REFRESH.of(null) });
    } catch (e) {
      /* ignore */
    }
  }

  /* ===================== 高亮创建 ===================== */
  showColorMenu(evt) {
    const menu = new Menu();
    for (const [key, c] of Object.entries(this.settings.colors)) {
      menu.addItem((item) =>
        item
          .setTitle(`标记为${c.name}`)
          .setIcon('circle')
          .onClick(() => this.highlightSelection(key))
      );
    }
    if (evt && evt instanceof MouseEvent) {
      menu.showAtMouseEvent(evt);
    } else {
      menu.showAtPosition({ x: 120, y: 120 });
    }
  }

  highlightSelection(colorKey, range) {
    const view = this.getMarkdownView();
    if (!view) return;
    if (this.getViewMode(view) === 'preview') {
      new Notice('请在编辑模式下选中文本进行标记');
      return;
    }
    const fp = this.getCurrentFilePath();
    if (!fp) return;
    const editor = view.editor;
    if (!editor) return;

    let start, end, text;
    if (range && typeof range.from === 'number' && typeof range.to === 'number') {
      start = range.from;
      end = range.to;
      text = editor.getValue().slice(start, end);
    } else {
      const selection = editor.getSelection();
      if (!selection || !selection.trim()) {
        new Notice('请先选中要标记的文本');
        return;
      }
      const fromPos = editor.getCursor('from');
      const toPos = editor.getCursor('to');
      start = editor.posToOffset(fromPos);
      end = editor.posToOffset(toPos);
      text = selection;
    }
    if (end <= start) return;

    if (!this.highlightData[fp]) this.highlightData[fp] = [];
    const arr = this.highlightData[fp];
    if (arr.some((h) => start < h.end && end > h.start)) {
      new Notice('该区域已有高亮');
      return;
    }
    arr.push({
      id: this.generateHighlightId(),
      text,
      start,
      end,
      color: colorKey,
      prefix: this.getHighlightPrefix(editor.getValue(), start),
      suffix: this.getHighlightSuffix(editor.getValue(), end),
      note: '',
    });
    this.scheduleSaveHighlightData();
    this.scheduleRefresh();
    this.refreshPanel();
    new Notice(`已标记为${this.settings.colors[colorKey] ? this.settings.colors[colorKey].name : ''}`);
  }

  /* ===================== 渲染调度 ===================== */
  scheduleRefresh() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.refreshCmFileMap();
      this.refreshHighlights();
      this.ensureDomObserver();
      this.refreshPanel();
    }, 120);
  }

  refreshHighlights() {
    const view = this.getMarkdownView();
    if (!view) return;
    const mode = this.getViewMode(view);
    if (mode === 'preview') {
      this.applyHighlights(); // 阅读模式：渲染后 DOM 包裹（不改动源文件）
    } else {
      this.refreshActiveEditor(); // 编辑模式：CM6 装饰层
    }
  }

  /* ===================== 阅读模式 DOM 包裹（仅渲染，不改源文件） ===================== */
  // 取得真正的预览渲染根节点（不同 Obsidian 版本内部结构不同，逐个兜底）
  getPreviewRoot(view) {
    if (!view) return null;
    if (view.previewMode && view.previewMode.renderer && view.previewMode.renderer.previewEl) {
      return view.previewMode.renderer.previewEl;
    }
    const el = view.contentEl;
    if (!el || !el.querySelector) return el || null;
    const preview = el.querySelector('.markdown-preview-view');
    return preview || el;
  }

  applyHighlights() {
    if (this._applying) return;
    const view = this.getMarkdownView();
    if (!view) return;
    const root = this.getPreviewRoot(view);
    if (!root) return;
    const fp = this.getCurrentFilePath();
    const data = fp ? this.highlightData[fp] || [] : [];
    // 幂等保护：当前 DOM 已正确反映高亮数据时不再改动，
    // 既避免重复重绘，也避免 MutationObserver 因自身改动而陷入死循环
    const sig = this.computePreviewSig(root, fp, data);
    if (sig === this._appliedSig) return;
    this._applying = true;
    try {
      this.unwrap(root);
      if (data.length) this.renderHighlights(root, data, false);
      this._appliedSig = this.computePreviewSig(root, fp, data);
    } catch (e) {
      console.error('TextHighlightMarker: applyHighlights 出错', e);
    } finally {
      this._applying = false;
    }
  }

  // 计算当前预览 DOM 与期望高亮数据是否一致（用于幂等判断）
  computePreviewSig(root, fp, data) {
    const wraps = Array.from(root.querySelectorAll('.highlight-marker-wrap'));
    const cur = wraps.map((s) => {
      const id = s.getAttribute('data-hl-id');
      let color = null;
      for (const c of s.classList) {
        if (c.startsWith('highlight-marker-') && c !== 'highlight-marker-wrap' && c !== 'highlight-marker') {
          color = c;
          break;
        }
      }
      return { id: id || '', color: color || '', text: s.textContent };
    });
    const want = data.map((h) => ({ id: String(h.id), color: `highlight-marker-${h.color}`, text: h.text }));
    return JSON.stringify({ fp, cur, want });
  }

  // 监听预览容器变化，预览异步渲染/重渲染后自动重绘高亮
  ensureDomObserver() {
    const view = this.getMarkdownView();
    const root = view && this.getViewMode(view) === 'preview' ? this.getPreviewRoot(view) : null;
    if (!root) {
      if (this._domObserver) {
        this._domObserver.disconnect();
        this._domObserver = null;
        this._domObserverTarget = null;
      }
      return;
    }
    if (this._domObserverTarget === root && this._domObserver) return; // 无需重建
    if (this._domObserver) this._domObserver.disconnect();
    this._domObserverTarget = root;
    this._domObserver = new MutationObserver(() => {
      if (this._applying) return;
      this.applyHighlights();
    });
    try {
      this._domObserver.observe(root, { childList: true, characterData: true, subtree: true });
    } catch (e) {
      /* ignore */
    }
  }

  buildViewMap(root) {
    const nodes = [];
    let viewText = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('script,style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const start = viewText.length;
      const end = start + n.nodeValue.length;
      nodes.push({ node: n, start, end });
      viewText += n.nodeValue;
    }
    return { nodes, viewText };
  }

  findOccurrences(viewText, text) {
    const out = [];
    if (!text) return out;
    let i = 0;
    while ((i = viewText.indexOf(text, i)) !== -1) {
      out.push(i);
      i += 1;
    }
    return out;
  }

  chooseOccurrence(occurrences, h, viewText) {
    if (occurrences.length === 0) return -1;
    if (occurrences.length === 1) return occurrences[0];
    let best = -1;
    let bestScore = -1;
    for (const idx of occurrences) {
      let score = 0;
      if (h.prefix) {
        const before = viewText.slice(Math.max(0, idx - h.prefix.length), idx);
        const tail = h.prefix.slice(-Math.min(h.prefix.length, before.length));
        if (before.endsWith(tail)) score += 2;
      }
      if (h.suffix) {
        const after = viewText.slice(idx + h.text.length, idx + h.text.length + h.suffix.length);
        const head = h.suffix.slice(0, Math.min(h.suffix.length, after.length));
        if (after.startsWith(head)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    return best;
  }

  renderHighlights(root, data, isCm) {
    if (!root) return;
    const { nodes, viewText } = this.buildViewMap(root);
    if (!nodes.length) return;
    const used = [];
    const byNode = new Map();
    for (const h of data) {
      const occ = this.findOccurrences(viewText, h.text);
      const idx = this.chooseOccurrence(occ, h, viewText);
      if (idx < 0) continue;
      const s = idx;
      const e = idx + h.text.length;
      if (used.some((r) => s < r[1] && e > r[0])) continue;
      used.push([s, e]);
      for (const nd of nodes) {
        if (nd.end <= s || nd.start >= e) continue;
        const localStart = Math.max(0, s - nd.start);
        const localEnd = Math.min(nd.node.nodeValue.length, e - nd.start);
        if (localEnd <= localStart) continue;
        if (!byNode.has(nd.node)) byNode.set(nd.node, []);
        byNode.get(nd.node).push({ start: localStart, end: localEnd, color: h.color, id: h.id });
      }
    }
    for (const [node, segs] of byNode) {
      segs.sort((a, b) => a.start - b.start);
      this.wrapSegmentsInNode(node, segs);
    }
  }

  wrapSegmentsInNode(textNode, segs) {
    const full = textNode.nodeValue;
    const parent = textNode.parentNode;
    if (!parent) return;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const seg of segs) {
      const s = Math.max(cursor, seg.start);
      if (s > cursor) frag.appendChild(document.createTextNode(full.slice(cursor, s)));
      const span = document.createElement('span');
      span.className = `highlight-marker-wrap ${HIGHLIGHT_CLASS} ${HIGHLIGHT_CLASS}-${seg.color}`;
      span.setAttribute('data-hl-id', String(seg.id));
      span.textContent = full.slice(s, seg.end);
      frag.appendChild(span);
      cursor = seg.end;
    }
    if (cursor < full.length) frag.appendChild(document.createTextNode(full.slice(cursor)));
    parent.replaceChild(frag, textNode);
  }

  unwrap(root) {
    if (!root) return;
    const wraps = root.querySelectorAll('.highlight-marker-wrap');
    wraps.forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parent.normalize();
    });
  }

  /* ===================== 校验/重定位（删除字符自动取消整段） ===================== */
  pruneHighlightsForDoc(filePath, docText) {
    const highlights = this.highlightData[filePath];
    if (!highlights || highlights.length === 0) return false;
    let hasChanges = false;
    for (let i = highlights.length - 1; i >= 0; i--) {
      const h = highlights[i];
      const idx = this.findBestOccurrence(docText, h);
      if (idx === -1) {
        highlights.splice(i, 1);
        hasChanges = true;
        continue;
      }
      const ns = idx;
      const ne = idx + h.text.length;
      if (ns !== h.start || ne !== h.end) {
        h.start = ns;
        h.end = ne;
        h.prefix = this.getHighlightPrefix(docText, ns);
        h.suffix = this.getHighlightSuffix(docText, ne);
        hasChanges = true;
      }
    }
    return hasChanges;
  }

  findBestOccurrence(docText, h) {
    const occ = this.findOccurrences(docText, h.text);
    return this.chooseOccurrence(occ, h, docText);
  }

  getHighlightPrefix(docText, start) {
    return docText.slice(Math.max(0, start - 24), start);
  }

  getHighlightSuffix(docText, end) {
    return docText.slice(end, Math.min(docText.length, end + 24));
  }

  /* ===================== 悬浮提示（点击高亮出现，两种模式共用） ===================== */
  initHoverTooltip() {
    // 点击高亮出现悬浮窗（不再用 mouseover/mouseout，避免移动到批注框时自动隐藏造成的"闪退"）
    this.registerDomEvent(document, 'click', (e) => this.handleHighlightClick(e));
    this.registerDomEvent(document, 'keydown', (e) => {
      if (e.key === 'Escape') this.hideHighlightTooltip();
    });
  }

  handleHighlightClick(e) {
    const t = e.target.closest && e.target.closest('.highlight-marker');
    if (t) {
      const id = t.getAttribute('data-hl-id');
      const colorKey = this.extractColorKey(t);
      this.showHighlightTooltip(t, colorKey, id);
      return;
    }
    // 点击落在高亮之外、且不在悬浮窗内 → 关闭
    if (this.tooltipEl && !this.tooltipEl.contains(e.target)) {
      this.hideHighlightTooltip();
    }
  }

  extractColorKey(el) {
    if (!el) return null;
    for (const key of Object.keys(this.settings.colors)) {
      if (el.classList.contains(`${HIGHLIGHT_CLASS}-${key}`)) return key;
    }
    return null;
  }

  showHighlightTooltip(anchorEl, colorKey, id) {
    const fp = this.getCurrentFilePath();
    const arr = fp ? this.highlightData[fp] : null;
    const h = arr && arr.find((x) => String(x.id) === String(id));
    if (!h) return;
    this.hideHighlightTooltip();

    const view = this.getMarkdownView();
    const readOnly = view ? this.getViewMode(view) === 'preview' : false;

    const tip = document.createElement('div');
    tip.className = 'highlight-tooltip' + (readOnly ? ' highlight-tooltip--readonly' : '');
    tip.setAttribute('data-tip-for', String(id));

    const colorInfo = this.settings.colors[h.color] || (colorKey ? this.settings.colors[colorKey] : null);
    const colorHex = colorInfo ? colorInfo.color : 'var(--interactive-accent)';
    const colorName = colorInfo ? colorInfo.name : '高亮';

    // 头部：色块 + 颜色名 + 关闭（不显示原文）
    const header = tip.createDiv({ cls: 'highlight-tooltip__header' });
    const swatch = header.createSpan({ cls: 'highlight-tooltip__swatch' });
    swatch.style.background = colorHex;
    header.createSpan({ cls: 'highlight-tooltip__title', text: `${colorName}${readOnly ? '（只读）' : ''}` });
    const closeBtn = header.createEl('button', { cls: 'highlight-tooltip__close', text: '×' });
    closeBtn.setAttribute('aria-label', '关闭');

    // 正文：批注内容
    const body = tip.createDiv({ cls: 'highlight-tooltip__body' });
    if (readOnly) {
      // 阅读模式：仅展示批注，不可编辑
      const noteEl = body.createDiv({ cls: 'highlight-tooltip__note-readonly' });
      noteEl.textContent = h.note && h.note.trim() ? h.note : '（暂无批注）';
    } else {
      const ta = body.createEl('textarea', { cls: 'highlight-tooltip__note', placeholder: '添加批注…' });
      ta.rows = this.settings.noteRows || 3;
      ta.value = h.note || '';
      ta.addEventListener('input', () => this.updateHighlightNote(fp, id, ta.value));
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      ta.addEventListener('mousedown', (e) => e.stopPropagation());

      // 底部：颜色选择器（左） + 取消高亮（右，缩小）
      const footer = tip.createDiv({ cls: 'highlight-tooltip__footer' });
      const colorRow = footer.createDiv({ cls: 'highlight-tooltip__colors' });
      for (const [key, c] of Object.entries(this.settings.colors)) {
        const cb = colorRow.createEl('button', {
          cls: 'highlight-tooltip__color' + (key === h.color ? ' is-active' : ''),
        });
        cb.style.background = c.color;
        cb.setAttribute('data-color', key);
        cb.setAttribute('aria-label', `改为${c.name}`);
        cb.addEventListener('click', () => this.changeHighlightColor(fp, id, key));
      }
      const removeBtn = footer.createEl('button', {
        cls: 'highlight-tooltip__remove highlight-tooltip__remove--sm',
        text: '取消高亮',
      });
      removeBtn.addEventListener('click', () => this.removeHighlightFromTooltip(id));
    }

    closeBtn.addEventListener('click', () => this.hideHighlightTooltip());

    document.body.appendChild(tip);
    this.tooltipEl = tip;
    // 应用弹窗外观设置（字号/宽度），通过 CSS 变量作用到本弹窗，不污染全局
    tip.style.setProperty('--thm-note-font-size', (this.settings.noteFontSize || 14) + 'px');
    tip.style.setProperty('--thm-tip-maxw', (this.settings.tipWidth || 320) + 'px');
    tip.style.setProperty('--thm-tip-minw', (this.settings.tipWidth || 320) + 'px');
    this.positionTooltip(tip, anchorEl);
    this.makeTooltipDraggable(tip);
  }

  positionTooltip(tip, anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let top = r.bottom + 8;
    let left = r.left;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    if (left < 8) left = 8;
    if (top + th > window.innerHeight - 8) top = r.top - th - 8;
    if (top < 8) top = 8;
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }

  // 让悬浮窗可被拖动：按住标题栏移动（关闭按钮除外），限制在视口内
  makeTooltipDraggable(tip) {
    const header = tip.querySelector('.highlight-tooltip__header');
    if (!header) return;
    header.classList.add('highlight-tooltip__header--draggable');
    header.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return; // 仅左键
      if (e.target.closest('.highlight-tooltip__close')) return; // 关闭按钮不触发拖动
      e.preventDefault(); // 避免选中文本/出现原生拖影
      const rect = tip.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      tip.classList.add('highlight-tooltip--dragging');
      const onMove = (ev) => {
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        let left = ev.clientX - offsetX;
        let top = ev.clientY - offsetY;
        left = Math.max(0, Math.min(left, window.innerWidth - tw));
        top = Math.max(0, Math.min(top, window.innerHeight - th));
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        tip.classList.remove('highlight-tooltip--dragging');
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  removeHighlightFromTooltip(id) {
    const fp = this.getCurrentFilePath();
    this.removeHighlightById(fp, id);
    this.hideHighlightTooltip();
  }

  removeHighlightById(filePath, id) {
    const arr = this.highlightData[filePath];
    if (!arr) return;
    const i = arr.findIndex((h) => String(h.id) === String(id));
    if (i < 0) return;
    arr.splice(i, 1);
    this.scheduleSaveHighlightData();
    this.scheduleRefresh();
    this.refreshPanel();
  }

  updateHighlightNote(filePath, id, note) {
    const arr = this.highlightData[filePath];
    if (!arr) return;
    const h = arr.find((x) => String(x.id) === String(id));
    if (!h) return;
    h.note = note;
    this.scheduleSaveHighlightData();
    // 新增/修改批注后，自动同步刷新右侧面板（无需手动点击）
    // 标记正在编辑的项，使刷新后该项的批注框保持可编辑、焦点与光标不丢失
    this._editingId = id;
    this.refreshPanel();
  }

  changeHighlightColor(filePath, id, colorKey) {
    const arr = this.highlightData[filePath];
    if (!arr) return;
    const h = arr.find((x) => String(x.id) === String(id));
    if (!h || !this.settings.colors[colorKey]) return;
    h.color = colorKey;
    this.scheduleSaveHighlightData();
    this.scheduleRefresh();
    this.refreshPanel();
    // 同步更新当前悬浮窗的色块/标题/激活态
    if (this.tooltipEl && this.tooltipEl.getAttribute('data-tip-for') === String(id)) {
      const sw = this.tooltipEl.querySelector('.highlight-tooltip__swatch');
      const ti = this.tooltipEl.querySelector('.highlight-tooltip__title');
      if (sw) sw.style.background = this.settings.colors[colorKey].color;
      if (ti) ti.textContent = this.settings.colors[colorKey].name;
      this.tooltipEl.querySelectorAll('.highlight-tooltip__color').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-color') === colorKey);
      });
    }
  }

  // 在文本中高亮匹配关键词，返回 DOM 片段（大小写不敏感）
  highlightMatches(text, query) {
    const frag = document.createDocumentFragment();
    const q = (query || '').trim();
    if (!q) {
      frag.append(document.createTextNode(text || ''));
      return frag;
    }
    const lower = (text || '').toLowerCase();
    const ql = q.toLowerCase();
    let i = 0;
    let idx;
    while ((idx = lower.indexOf(ql, i)) !== -1) {
      if (idx > i) frag.append(document.createTextNode(text.slice(i, idx)));
      const mark = document.createElement('mark');
      mark.className = 'thm-hl-match';
      mark.textContent = text.slice(idx, idx + q.length);
      frag.append(mark);
      i = idx + q.length;
    }
    if (i < text.length) frag.append(document.createTextNode(text.slice(i)));
    return frag;
  }

  hideHighlightTooltip() {
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
    this.cancelHideTooltip();
  }

  cancelHideTooltip() {
    if (this.hideTooltipTimer) {
      clearTimeout(this.hideTooltipTimer);
      this.hideTooltipTimer = null;
    }
  }

  /* ===================== 选中即出颜色选择（编辑模式） ===================== */
  initSelectionHighlighter() {
    this.registerDomEvent(document, 'selectionchange', () => this.onSelectionChange());
  }

  onSelectionChange() {
    if (this._selTimer) clearTimeout(this._selTimer);
    this._selTimer = setTimeout(() => this.updateSelectionButton(), 60);
  }

  updateSelectionButton() {
    const view = this.getMarkdownView();
    const mode = view ? this.getViewMode(view) : null;
    if (!view || mode !== 'source') {
      this.hideSelectionButton();
      return;
    }
    const cm = view.editor && view.editor.cm;
    if (!cm) {
      this.hideSelectionButton();
      return;
    }
    const domSel = window.getSelection();
    if (!domSel || !domSel.anchorNode || !cm.dom.contains(domSel.anchorNode)) {
      this.hideSelectionButton();
      return;
    }
    const sel = cm.state.selection.main;
    if (sel.empty) {
      this.hideSelectionButton();
      return;
    }
    const fromCoords = cm.coordsAtPos(sel.from);
    const toCoords = cm.coordsAtPos(sel.to);
    if (!fromCoords || !toCoords) {
      this.hideSelectionButton();
      return;
    }
    const top = Math.min(fromCoords.top, toCoords.top);
    const left = Math.min(fromCoords.left, toCoords.left);
    this._selRange = { from: sel.from, to: sel.to };
    this.showSelectionButton(left, top);
  }

  showSelectionButton(x, y) {
    if (!this._selBtn) {
      this._selBtn = document.createElement('div');
      this._selBtn.className = 'thm-sel-btn';
      this._selBtn.textContent = '高亮';
      this._selBtn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 保持当前选区
        this.onSelectionButtonClick(e);
      });
      document.body.appendChild(this._selBtn);
    }
    const h = this._selBtn.offsetHeight || 24;
    this._selBtn.style.left = `${Math.round(x)}px`;
    this._selBtn.style.top = `${Math.round(y - h - 6)}px`;
    this._selBtn.style.display = 'block';
  }

  hideSelectionButton() {
    if (this._selBtn) this._selBtn.style.display = 'none';
    this._selRange = null;
  }

  onSelectionButtonClick(e) {
    const range = this._selRange;
    if (!range) return;
    const menu = new Menu();
    for (const [key, c] of Object.entries(this.settings.colors)) {
      menu.addItem((item) =>
        item
          .setTitle(`标记为${c.name}`)
          .setIcon('circle')
          .onClick(() => {
            this.highlightSelection(key, range);
            this.hideSelectionButton();
          })
      );
    }
    const rect = this._selBtn.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  /* ===================== 右侧图标按钮 + 面板 ===================== */
  async toggleAnnotationPanel() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType('annotation-panel');
    if (leaves.length) {
      leaves.forEach((l) => l.detach());
      return;
    }
    let leaf = workspace.getRightLeaf(true);
    if (!leaf) leaf = workspace.getLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: 'annotation-panel', active: true });
    if (this.app.workspace.rightSplit && this.app.workspace.rightSplit.expand) {
      this.app.workspace.rightSplit.expand();
    }
    this.refreshPanel();
  }

  // 尝试把按钮注入到右边栏的操作区；找不到容器时返回 false
  injectRightSidebarButton() {
    // 若当前是悬浮兜底按钮，先移除，等真实容器就绪再挂回右边栏
    if (this.rightBtn && this._rightBtnFloating) {
      this.rightBtn.remove();
      this.rightBtn = null;
      this._rightBtnFloating = false;
    }
    const candidates = [
      '.workspace-split.mod-right .side-dock-actions',
      '.workspace-split.mod-right .workspace-sidedock-header-actions',
      '.mod-right .side-dock-actions',
      '.mod-right .workspace-sidedock-header-inner',
      '.workspace-split.mod-right .workspace-sidedock-header',
      '.mod-right .workspace-sidedock-header',
    ];
    let container = null;
    for (const sel of candidates) {
      container = document.querySelector(sel);
      if (container) break;
    }
    if (!container) return false;
    if (this.rightBtn && this.rightBtn.isConnected) {
      // 容器变了，重新挂载到当前容器
      this.rightBtn.remove();
      this.rightBtn = null;
    }
    const btn = document.createElement('div');
    btn.classList.add('side-dock-action', 'thm-right-btn');
    btn.setAttribute('aria-label', '批注面板');
    btn.setAttribute('aria-label-position', 'top');
    setIcon(btn, 'sticky-note');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      this.toggleAnnotationPanel();
    });
    if (container.classList.contains('workspace-sidedock-header') || container.classList.contains('workspace-sidedock-header-inner')) {
      container.appendChild(btn);
    } else {
      container.prepend(btn);
    }
    this.rightBtn = btn;
    this._rightBtnFloating = false;
    return true;
  }

  // 右栏始终不出现时的兜底：固定在视口右下角（仍在"右侧"）
  ensureFloatingButton() {
    if (this.rightBtn && this.rightBtn.isConnected) return;
    const btn = document.createElement('div');
    btn.className = 'thm-floating-btn';
    setIcon(btn, 'sticky-note');
    btn.setAttribute('aria-label', '批注面板');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      this.toggleAnnotationPanel();
    });
    document.body.appendChild(btn);
    this.rightBtn = btn;
    this._rightBtnFloating = true;
  }

  _stopBtnWatcher() {
    if (this._btnWatcher) {
      this._btnWatcher.disconnect();
      this._btnWatcher = null;
    }
  }

  // 用 MutationObserver 监视右侧栏容器出现即注入；多次重试失败则退化为悬浮按钮
  startRightButtonWatcher() {
    if (this._btnWatcher) return;
    let attempts = 0;
    const tryInject = () => {
      attempts++;
      if (this.rightBtn && this.rightBtn.isConnected) {
        this._stopBtnWatcher();
        return;
      }
      const ok = this.injectRightSidebarButton();
      if (ok) {
        this._stopBtnWatcher();
        return;
      }
      if (attempts >= 6) {
        this.ensureFloatingButton();
        this._stopBtnWatcher();
      }
    };
    this._btnWatcher = new MutationObserver(() => tryInject());
    try {
      this._btnWatcher.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      /* ignore */
    }
    tryInject();
    for (const t of [600, 1500, 3000, 5000, 8000]) setTimeout(tryInject, t);
  }

  refreshPanel() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType('annotation-panel');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view && view instanceof AnnotationPanelView)) continue;
      // 只刷新内容（统计 + 列表），不重建整个面板，
      // 这样搜索输入框（render 中只构建一次）不会被销毁，焦点得以保持。
      view.updatePanel();
    }
  }

  /* ===================== 导出为笔记（全局 / 当前文档） ===================== */
  // 面板头部「导出」按钮点击后弹出的选项菜单
  showExportMenu(evt, el) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('全局导出（所有文档）')
        .setIcon('files')
        .onClick(() => this.exportAnnotationsToNote('all'))
    );
    menu.addItem((item) =>
      item
        .setTitle('当前文档导出')
        .setIcon('file')
        .onClick(() => this.exportAnnotationsToNote('current'))
    );
    if (el && el instanceof HTMLElement && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    } else if (evt && evt instanceof MouseEvent) {
      menu.showAtMouseEvent(evt);
    } else {
      menu.showAtPosition({ x: 120, y: 120 });
    }
  }

  // scope: 'all' 导出所有文档；'current' 仅导出当前打开的文档
  async exportAnnotationsToNote(scope = 'current') {
    const fp = this.getCurrentFilePath();
    const targets = [];
    if (scope === 'all') {
      for (const fpath in this.highlightData) {
        const arr = this.highlightData[fpath];
        if (Array.isArray(arr) && arr.length) targets.push({ fp: fpath, arr });
      }
      targets.sort((a, b) => a.fp.localeCompare(b.fp));
    } else {
      if (!fp) {
        new Notice('未打开笔记，无法导出当前文档批注');
        return;
      }
      const arr = this.highlightData[fp] || [];
      if (!arr.length) {
        new Notice('当前笔记没有可导出的批注');
        return;
      }
      targets.push({ fp, arr });
    }
    if (!targets.length) {
      new Notice('没有可导出的批注');
      return;
    }

    const total = targets.reduce((s, t) => s + t.arr.length, 0);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let content = '';
    let fileName = '';

    if (scope === 'all') {
      fileName = `全部批注-${ts}.md`;
      content += `# 全部批注导出\n\n`;
      content += `> [!info] 说明\n> 本导出包含 ${targets.length} 个文档、共 ${total} 条高亮批注。\n\n---\n\n`;
      for (const { fp: fpath, arr } of targets) {
        const basename = this.getBasename(fpath);
        content += `## 文档：${basename}\n\n> 路径：${fpath} · 共 ${arr.length} 条\n\n`;
        for (const h of arr) content += this.buildAnnotationBlock(h);
        content += `---\n\n`;
      }
    } else {
      const cur = targets[0].arr;
      const basename = this.getBasename(fp);
      fileName = `${basename}-批注.md`;
      content += `# 《${basename}》批注\n\n`;
      content += `> [!info] 说明\n> 本笔记共包含 ${cur.length} 条高亮批注，按原文顺序排列。\n\n---\n\n`;
      for (const h of cur) content += this.buildAnnotationBlock(h);
    }

    const folder = scope === 'all' ? '' : fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/') + 1) : '';
    const finalName = await this.getUniqueFileName(folder + fileName);
    const file = await this.app.vault.create(finalName, content);
    new Notice(`已导出 ${total} 条批注到 ${finalName}`);
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  // 生成单条批注的 Markdown 块（全局/当前文档导出共用）
  buildAnnotationBlock(h) {
    const heading = (h.text || '').replace(/\s+/g, ' ').trim() || '（高亮内容为空）';
    const note = h.note && h.note.trim() ? h.note.trim() : '_(暂无批注)_';
    const colorInfo = this.settings.colors[h.color];
    const colorName = colorInfo ? colorInfo.name : '高亮';
    return `### ${heading}\n\n${note}\n\n> 标记颜色：${colorName}\n\n---\n\n`;
  }

  async getUniqueFileName(name) {
    let candidate = name;
    let i = 1;
    while (await this.app.vault.adapter.exists(candidate)) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      candidate = `${base} ${i}${ext}`;
      i++;
    }
    return candidate;
  }

  getBasename(path) {
    const f = path.split('/').pop();
    return f ? f.replace(/\.md$/i, '') : path;
  }

  async jumpToHighlight(fp, id) {
    const file = this.app.vault.getAbstractFileByPath(fp);
    if (!file) {
      new Notice('未找到文件：' + fp);
      return;
    }
    // 1. 已打开则复用对应视图并激活；否则在活跃叶子打开该文档并激活
    let view = this.getMarkdownViewForFile(fp);
    if (view) {
      await this.app.workspace.setActiveLeaf(view.leaf);
    } else {
      const activeMd = this.getMarkdownView();
      const leaf = activeMd ? this.app.workspace.getLeaf(false) : this.app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });
      view = this.getMarkdownViewForFile(fp);
    }
    if (!view) {
      new Notice('无法打开文件：' + fp);
      return;
    }
    // 2. 确保在编辑（source）模式，才能用 editor 精确定位
    if (this.getViewMode(view) !== 'source') {
      try {
        await view.leaf.setViewState({ type: 'markdown', state: { file: fp, mode: 'source' } });
      } catch (e) {
        /* ignore */
      }
      view = this.getMarkdownViewForFile(fp) || view;
      // CM6 editor 异步挂载，稍等一帧确保 editor 就绪
      await new Promise((r) => setTimeout(r, 50));
    }
    const h = (this.highlightData[fp] || []).find((x) => String(x.id) === String(id));
    if (!h) {
      new Notice('未找到对应的高亮批注');
      return;
    }
    if (!view.editor) {
      new Notice('该视图暂不支持定位，请切换到编辑模式后重试');
      return;
    }
    // 3. 定位到高亮起止位置并滚动到可见区域
    const pos = view.editor.offsetToPos(h.start);
    view.editor.setCursor(pos);
    view.editor.scrollIntoView({ from: pos, to: view.editor.offsetToPos(h.end) }, true);
    this.scheduleRefresh();
  }

  /* ===================== 事件注册 ===================== */
  registerEvents() {
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor) => {
        const fp = this.getCurrentFilePath();
        if (!fp) return;
        const cm = editor && editor.cm;
        const docText = cm ? cm.state.doc.toString() : editor.getValue();
        const changed = this.pruneHighlightsForDoc(fp, docText);
        if (changed) this.scheduleSaveHighlightData();
        this.scheduleRefresh();
      })
    );

    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        this._appliedSig = null;
        this._editingId = null;
        this.refreshCmFileMap();
        this.scheduleRefresh();
        this.refreshPanel();
      })
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this._appliedSig = null;
        this._editingId = null;
        this.refreshCmFileMap();
        this.scheduleRefresh();
        this.refreshPanel();
      })
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.refreshCmFileMap();
        this.injectRightSidebarButton();
        this.scheduleRefresh();
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        const fp = this.getCurrentFilePath();
        if (fp && file.path === fp) {
          const view = this.getMarkdownView();
          const cm = view && view.editor && view.editor.cm;
          const docText = cm ? cm.state.doc.toString() : view && view.editor ? view.editor.getValue() : null;
          if (docText !== null) {
            const changed = this.pruneHighlightsForDoc(fp, docText);
            if (changed) this.scheduleSaveHighlightData();
          }
          this.scheduleRefresh();
          this.refreshPanel();
        }
      })
    );
  }

  /* ===================== 动态样式（按设置生成高亮颜色） ===================== */
  injectHighlightStyles() {
    const opacity = ((this.settings && this.settings.opacity) != null ? this.settings.opacity : 50) / 100;
    let css = '';
    for (const [key, c] of Object.entries(this.settings.colors)) {
      const rgb = this.hexToRgb(c.color);
      css += `.${HIGHLIGHT_CLASS}-${key}{ background-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity}); }\n`;
    }
    css += `.${HIGHLIGHT_CLASS}{ border-radius: 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone; cursor: pointer; }\n`;
    let el = document.getElementById('thm-highlight-styles');
    if (!el) {
      el = document.createElement('style');
      el.id = 'thm-highlight-styles';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  hexToRgb(hex) {
    const m = (hex || '').replace('#', '');
    const v = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
    const int = parseInt(v, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
  }
}

/* ===================== 批注面板视图 ===================== */
class AnnotationPanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return 'annotation-panel';
  }

  getDisplayText() {
    return '批注面板';
  }

  getIcon() {
    return 'sticky-note';
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    /* noop */
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('thm-panel');
    this._query = this._query || '';

    // 头部（只在 render 时构建一次，刷新时只改文字，不重建输入框）
    const header = contentEl.createDiv({ cls: 'thm-panel-header' });
    header.createEl('h3', { cls: 'thm-panel-title', text: '批注面板' });
    this.metaEl = header.createDiv({ cls: 'thm-panel-meta' });
    const exportBtn = header.createEl('button', { cls: 'thm-panel-export', text: '导出 ▾' });
    exportBtn.setAttribute('aria-label', '导出批注');
    exportBtn.addEventListener('click', (evt) => this.plugin.showExportMenu(evt, exportBtn));

    // 搜索框：跨全部文档，按高亮文本或批注内容实时筛选并高亮关键词
    const searchWrap = contentEl.createDiv({ cls: 'thm-panel-search' });
    this.searchInput = searchWrap.createEl('input', {
      cls: 'thm-panel-search-input',
      type: 'text',
      placeholder: '跨全部文档搜索高亮文本或批注…',
    });
    this.searchInput.setAttribute('autocomplete', 'off');
    this.searchInput.value = this._query;
    this.searchInput.addEventListener('input', () => {
      this._query = this.searchInput.value;
      this.renderList();
    });
    // 阻止 mousedown 冒泡被外层 click 处理器吞掉焦点
    this.searchInput.addEventListener('mousedown', (e) => e.stopPropagation());
    searchWrap.createDiv({
      cls: 'thm-panel-search-hint',
      text: '输入关键词可跨所有文档检索高亮与批注',
    });

    this.listEl = contentEl.createDiv({ cls: 'thm-panel-list' });
    this.updateMeta();
    this.renderList();
  }

  // 只刷新头部统计文字（不重建搜索框），避免输入框被替换导致焦点丢失
  updateMeta() {
    if (!this.metaEl) this.metaEl = this.contentEl.querySelector('.thm-panel-meta');
    if (!this.metaEl) return;
    const fp = this.plugin.getCurrentFilePath();
    const curArr = fp ? this.plugin.highlightData[fp] || [] : [];
    this.metaEl.textContent = fp
      ? `${this.plugin.getBasename(fp)} · 当前文档 ${curArr.length} 条`
      : '未打开笔记';
  }

  // 刷新面板内容（统计 + 列表），但不重建搜索框 → 保持输入框焦点
  updatePanel() {
    this.updateMeta();
    this.renderList();
  }

  renderList() {
    if (!this.listEl) return;
    // 重建前记录正在编辑的批注文本框焦点与光标，重建后恢复，避免输入时失焦
    const active = document.activeElement;
    let focusHlId = null;
    let ss = 0;
    let se = 0;
    if (active && active.classList && active.classList.contains('thm-panel-note')) {
      focusHlId = active.getAttribute('data-hl-id');
      try {
        ss = active.selectionStart;
        se = active.selectionEnd;
      } catch (e) {
        /* ignore */
      }
    }
    const query = (this._query || '').trim().toLowerCase();
    const fp = this.plugin.getCurrentFilePath();
    this.listEl.empty();

    // 收集分组：有搜索词 -> 遍历全部文档；否则 -> 仅当前文档
    let groups = [];
    if (query) {
      for (const fpath in this.plugin.highlightData) {
        const arr = this.plugin.highlightData[fpath];
        if (!Array.isArray(arr)) continue;
        const items = arr.filter((h) => {
          const t = (h.text || '').toLowerCase();
          const n = (h.note || '').toLowerCase();
          return t.includes(query) || n.includes(query);
        });
        if (items.length) {
          groups.push({
            fp: fpath,
            basename: this.plugin.getBasename(fpath),
            items,
            isCurrent: fpath === fp,
          });
        }
      }
      // 当前文档优先，其余按文件名排序
      groups.sort(
        (a, b) =>
          (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0) || a.basename.localeCompare(b.basename)
      );
    } else {
      if (!fp) {
        this.listEl.createDiv({
          cls: 'thm-panel-empty',
          text: '暂无批注。在编辑模式下选中文本，点击浮现的「高亮」按钮并选择颜色即可添加（批注可留空）；或在上方搜索框跨文档检索。',
        });
        return;
      }
      const arr = this.plugin.highlightData[fp] || [];
      if (!arr.length) {
        this.listEl.createDiv({
          cls: 'thm-panel-empty',
          text: '当前笔记暂无批注。在编辑模式下选中文本，点击浮现的「高亮」按钮并选择颜色即可添加（批注可留空）。',
        });
        return;
      }
      groups.push({ fp, basename: this.plugin.getBasename(fp), items: arr, isCurrent: true });
    }

    if (!groups.length) {
      this.listEl.createDiv({
        cls: 'thm-panel-empty',
        text: query ? `没有跨文档匹配“${this._query}”的批注。` : '暂无批注。',
      });
      return;
    }

    for (const g of groups) {
      const groupEl = this.listEl.createDiv({ cls: 'thm-panel-group' });
      const gh = groupEl.createDiv({ cls: 'thm-panel-group-head' });
      const nameEl = gh.createDiv({ cls: 'thm-panel-group-name' });
      nameEl.append(this.plugin.highlightMatches(g.basename, this._query || ''));
      gh.createSpan({ cls: 'thm-panel-group-count', text: `${g.items.length} 条` });

      for (const h of g.items) {
        const item = groupEl.createDiv({ cls: 'thm-panel-item' });
        const itemHead = item.createDiv({ cls: 'thm-panel-item-head' });
        const colorInfo = this.plugin.settings.colors[h.color] || { color: 'var(--interactive-accent)', name: '高亮' };
        const sw = itemHead.createSpan({ cls: 'thm-panel-swatch' });
        sw.style.background = colorInfo.color;
        const title = itemHead.createDiv({ cls: 'thm-panel-item-title' });
        title.append(this.plugin.highlightMatches(h.text || '', this._query || ''));
        title.title = g.isCurrent ? '点击跳转到原文' : `点击跳转到：${g.basename}`;
        if (!g.isCurrent) {
          itemHead.createSpan({ cls: 'thm-panel-item-badge', text: '跨文档' });
        }
        title.addEventListener('click', () => this.plugin.jumpToHighlight(g.fp, h.id));
        const del = itemHead.createEl('button', { cls: 'thm-panel-del', text: '删除' });
        del.addEventListener('click', () => this.plugin.removeHighlightById(g.fp, h.id));

        // 批注：命中搜索词且非正在编辑时，显示带高亮的只读预览；否则显示可编辑文本框
        const isEditing = this.plugin._editingId != null && String(this.plugin._editingId) === String(h.id);
        const noteMatches = !isEditing && query && h.note && h.note.toLowerCase().includes(query);
        if (noteMatches) {
          const noteHl = item.createDiv({ cls: 'thm-panel-note-hl' });
          noteHl.append(this.plugin.highlightMatches(h.note || '', this._query || ''));
        } else {
          const ta = item.createEl('textarea', { cls: 'thm-panel-note', placeholder: '添加批注…' });
          ta.rows = 3;
          ta.setAttribute('data-hl-id', String(h.id));
          ta.value = h.note || '';
          ta.addEventListener('input', () => this.plugin.updateHighlightNote(g.fp, h.id, ta.value));
          ta.addEventListener('keydown', (e) => e.stopPropagation());
        }
      }
    }

    // 恢复批注文本框焦点与光标（搜索框因未被重建，焦点自然保留）
    if (focusHlId !== null) {
      const el = this.listEl.querySelector(`.thm-panel-note[data-hl-id="${focusHlId}"]`);
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(ss, se);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
}

/* ===================== 设置页 ===================== */
class TextHighlightMarkerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'peko标注 设置' });

    new Setting(containerEl)
      .setName('高亮不透明度')
      .setDesc('取值 0 - 100，数值越小越透明。')
      .addSlider((slider) =>
        slider
          .setLimits(10, 100, 5)
          .setValue(this.plugin.settings.opacity)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.opacity = val;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: '批注弹窗外观' });

    new Setting(containerEl)
      .setName('批注文字大小')
      .setDesc('批注框内文字的字号（px），10 - 28。')
      .addSlider((slider) =>
        slider
          .setLimits(10, 28, 1)
          .setValue(this.plugin.settings.noteFontSize)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.noteFontSize = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('弹出窗宽度')
      .setDesc('批注弹窗卡片的横向宽度（px），200 - 520。')
      .addSlider((slider) =>
        slider
          .setLimits(200, 520, 10)
          .setValue(this.plugin.settings.tipWidth)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.tipWidth = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('批注框高度（行数）')
      .setDesc('编辑批注的文本框高度，以行数计（仅编辑模式生效），2 - 12。')
      .addSlider((slider) =>
        slider
          .setLimits(2, 12, 1)
          .setValue(this.plugin.settings.noteRows)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.noteRows = val;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: '高亮颜色' });
    for (const [key, c] of Object.entries(this.plugin.settings.colors)) {
      new Setting(containerEl)
        .setName(c.name)
        .addText((text) =>
          text.setPlaceholder('名称').setValue(c.name).onChange(async (val) => {
            this.plugin.settings.colors[key].name = val;
            await this.plugin.saveSettings();
          })
        )
        .addText((text) =>
          text.setPlaceholder('#rrggbb').setValue(c.color).onChange(async (val) => {
            this.plugin.settings.colors[key].color = val;
            await this.plugin.saveSettings();
          })
        );
    }

    /* ===================== 数据持久化 ===================== */
    containerEl.createEl('h3', { text: '数据持久化' });

    const stats = this.plugin.getDataStats();
    const mirror = this.plugin.getCustomDir();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        `当前共 ${stats.count} 条批注（${stats.files} 个文件）。` +
        `主存储：Obsidian 原生 data.json（重启自动恢复，不会丢失）。` +
        (mirror ? `额外镜像目录：仓库内「${mirror}」。 ` : ''),
    });

    new Setting(containerEl)
      .setName('额外镜像目录（可选）')
      .setDesc(
        '相对 vault 根目录的文件夹路径（如 thm-data）。留空则只使用 Obsidian 原生存储。' +
          '设置后会把高亮数据额外复制一份到该 vault 文件夹，便于查阅与手动备份；修改后立即生效。'
      )
      .addText((text) => {
        text
          .setPlaceholder('留空 = 仅原生存储')
          .setValue(this.plugin.settings.dataDir || '');
        // 失焦时才应用，避免每敲一个字符就写入一次
        text.inputEl.addEventListener('blur', async () => {
          const val = (text.getValue() || '').trim().replace(/^\/+|\/+$/g, '');
          if (val === (this.plugin.settings.dataDir || '')) return;
          this.plugin.settings.dataDir = val;
          await this.plugin.persistAll();
          new Notice(val ? `已开启额外镜像目录：${val}` : '已关闭额外镜像目录');
          this.display(); // 刷新显示
        });
      });

    new Setting(containerEl)
      .setName('备份：导出数据')
      .setDesc('将所有高亮与批注导出为一个 JSON 备份文件（下载到本地，不写入 vault）。')
      .addButton((btn) =>
        btn
          .setButtonText('导出备份')
          .setCta()
          .onClick(() => this.plugin.exportBackup())
      );

    new Setting(containerEl)
      .setName('恢复：导入数据（合并）')
      .setDesc('从备份 JSON 文件导入并与现有数据合并（自动去重，不会删除已有批注）。')
      .addButton((btn) =>
        btn.setButtonText('选择文件合并导入').onClick(() => this.plugin.importBackup('merge'))
      );

    new Setting(containerEl)
      .setName('恢复：导入数据（覆盖）')
      .setDesc('⚠️ 用备份文件完全替换当前所有数据。当前数据将被清空后再导入，请谨慎使用。')
      .addButton((btn) =>
        btn
          .setButtonText('选择文件覆盖导入')
          .setWarning()
          .onClick(() => this.plugin.importBackup('replace'))
      );
  }
}

module.exports = TextHighlightMarker;
