// src/main.js
var {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownView,
  Menu,
  setIcon,
  ItemView
} = require("obsidian");
var { StateEffect, RangeSetBuilder } = require("@codemirror/state");
var { Decoration, ViewPlugin } = require("@codemirror/view");
var HIGHLIGHT_CLASS = "highlight-marker";
var DEFAULT_SETTINGS = {
  colors: {
    blue: { name: "\u84DD\u8272", color: "#4a90d9" },
    red: { name: "\u7EA2\u8272", color: "#e0524d" },
    green: { name: "\u7EFF\u8272", color: "#3fa66a" },
    yellow: { name: "\u9EC4\u8272", color: "#e6c34a" }
  },
  opacity: 50,
  // 批注弹窗外观
  noteFontSize: 14,
  // 批注文字字号(px)
  tipWidth: 320,
  // 弹出窗宽度(px)
  noteRows: 3,
  // 批注编辑框行数
  // 高亮/批注数据的持久化目录（相对 vault 根目录）。留空则存于插件目录下，
  // 设为自定义目录（如 "thm-data"）可避免更新/重装插件时被覆盖。
  dataDir: ""
};
var DATA_FILE = "highlight-data.json";
var cmFileMap = /* @__PURE__ */ new WeakMap();
var HIGHLIGHT_REFRESH = StateEffect.define();
var TextHighlightMarker = class extends Plugin {
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
    this._editingId = null;
  }
  /* ===================== 生命周期 ===================== */
  async onload() {
    await this.loadAllData();
    this.injectHighlightStyles();
    this.initHoverTooltip();
    this.initSelectionHighlighter();
    this.registerView("annotation-panel", (leaf) => new AnnotationPanelView(leaf, this));
    this.registerEvents();
    this._hlViewPlugin = this.buildHighlightPlugin();
    this.registerEditorExtension(this._hlViewPlugin);
    this.addRibbonIcon("highlighter", "\u9AD8\u4EAE\u9009\u4E2D\u6587\u672C\uFF08\u9009\u62E9\u989C\u8272\uFF09", (evt) => this.showColorMenu(evt));
    this.addCommand({
      id: "export-annotations",
      name: "\u5168\u5C40\u5BFC\u51FA\uFF1A\u6240\u6709\u6587\u6863\u6279\u6CE8",
      callback: () => this.exportAnnotationsToNote("all")
    });
    this.addCommand({
      id: "export-current-annotations",
      name: "\u5BFC\u51FA\u5F53\u524D\u6587\u6863\u6279\u6CE8",
      callback: () => this.exportAnnotationsToNote("current")
    });
    this.addCommand({
      id: "toggle-annotation-panel",
      name: "\u6253\u5F00/\u6536\u8D77\u6279\u6CE8\u9762\u677F",
      callback: () => this.toggleAnnotationPanel()
    });
    for (const [key, c] of Object.entries(this.settings.colors)) {
      this.addCommand({
        id: `highlight-${key}`,
        name: `\u6807\u8BB0\u4E3A${c.name}`,
        editorCallback: () => this.highlightSelection(key)
      });
    }
    this.addSettingTab(new TextHighlightMarkerSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.refreshCmFileMap();
      this.startRightButtonWatcher();
      this.scheduleRefresh();
    });
    this.registerInterval(
      window.setInterval(() => {
        const view = this.getMarkdownView();
        if (!view || this.getViewMode(view) !== "preview") return;
        const fp = this.getCurrentFilePath();
        if (!fp || !(this.highlightData[fp] && this.highlightData[fp].length)) return;
        this.applyHighlights();
      }, 1500)
    );
  }
  onunload() {
    this.flushHighlightData();
    this.hideHighlightTooltip();
    this.hideSelectionButton();
    if (this._domObserver) this._domObserver.disconnect();
    if (this._btnWatcher) {
      this._btnWatcher.disconnect();
      this._btnWatcher = null;
    }
    if (this.rightBtn && this.rightBtn.isConnected) this.rightBtn.remove();
    const styleEl = document.getElementById("thm-highlight-styles");
    if (styleEl) styleEl.remove();
  }
  /* ===================== 设置 ===================== */
  async loadSettings() {
    let data = {};
    try {
      data = await this.loadData() || {};
    } catch (e) {
      data = {};
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    this.settings.colors = Object.assign({}, DEFAULT_SETTINGS.colors, this.settings.colors || {});
    if (typeof this.settings.opacity !== "number") this.settings.opacity = 50;
    if (typeof this.settings.dataDir !== "string") this.settings.dataDir = "";
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
      console.error("TextHighlightMarker: \u4FDD\u5B58\u6570\u636E\u5931\u8D25", e);
    }
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
    const write = () => this.app.vault.adapter.write(path, JSON.stringify(this.highlightData, null, 2)).catch(() => {
    });
    this.app.vault.adapter.exists(custom).then((ex) => ex ? write() : this.app.vault.adapter.mkdir(custom).then(write).catch(() => {
    })).catch(() => {
    });
  }
  getCustomDir() {
    const custom = this.settings && this.settings.dataDir ? String(this.settings.dataDir).trim() : "";
    if (!custom) return "";
    return custom.replace(/^\/+|\/+$/g, "");
  }
  getPluginDir() {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }
  // ============ 加载（含一次性旧版迁移） ============
  async loadAllData() {
    let raw = {};
    try {
      raw = await this.loadData() || {};
    } catch (e) {
      raw = {};
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    this.settings.colors = Object.assign({}, DEFAULT_SETTINGS.colors, this.settings.colors || {});
    if (typeof this.settings.opacity !== "number") this.settings.opacity = 50;
    if (typeof this.settings.dataDir !== "string") this.settings.dataDir = "";
    if (raw && raw.highlights && typeof raw.highlights === "object" && !Array.isArray(raw.highlights)) {
      this.highlightData = raw.highlights;
    } else {
      this.highlightData = {};
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
          const obj = JSON.parse(raw || "{}");
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            this.highlightData = obj;
            this.ensureHighlightIds();
            new Notice("\u5DF2\u81EA\u52A8\u8FC1\u79FB\u65E7\u7248\u9AD8\u4EAE\u6570\u636E");
            return;
          }
        }
      } catch (e) {
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
      new Notice("\u5F53\u524D\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u9AD8\u4EAE/\u6279\u6CE8\u6570\u636E");
      return;
    }
    const payload = {
      plugin: this.manifest.id,
      version: this.manifest.version,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      data: this.highlightData
    };
    const json = JSON.stringify(payload, null, 2);
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `highlight-backup-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2e3);
      new Notice(`\u5DF2\u5BFC\u51FA ${stats.count} \u6761\u6279\u6CE8\uFF08${stats.files} \u4E2A\u6587\u4EF6\uFF09`);
    } catch (e) {
      console.error("TextHighlightMarker: \u5BFC\u51FA\u5907\u4EFD\u5931\u8D25", e);
      new Notice("\u5BFC\u51FA\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63A7\u5236\u53F0");
    }
  }
  // 从选择的 JSON 文件导入。mode: 'merge' 合并 | 'replace' 覆盖
  importBackup(mode) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const incoming = parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
        if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
          new Notice("\u5BFC\u5165\u5931\u8D25\uFF1A\u6587\u4EF6\u683C\u5F0F\u4E0D\u6B63\u786E");
          return;
        }
        const applied = this.applyImportedData(incoming, mode);
        this.ensureHighlightIds();
        await this.flushHighlightData();
        this.scheduleRefresh();
        this.refreshPanel();
        new Notice(`\u5BFC\u5165\u5B8C\u6210\uFF1A${mode === "replace" ? "\u8986\u76D6" : "\u5408\u5E76"} ${applied} \u6761\u6279\u6CE8`);
      } catch (e) {
        console.error("TextHighlightMarker: \u5BFC\u5165\u5907\u4EFD\u5931\u8D25", e);
        new Notice("\u5BFC\u5165\u5931\u8D25\uFF1A\u65E0\u6CD5\u89E3\u6790\u6587\u4EF6");
      }
    });
    input.click();
  }
  // 将导入数据应用到 highlightData，返回导入的条数
  applyImportedData(incoming, mode) {
    let total = 0;
    if (mode === "replace") {
      this.highlightData = {};
    }
    for (const fp in incoming) {
      const arr = incoming[fp];
      if (!Array.isArray(arr)) continue;
      if (!this.highlightData[fp]) this.highlightData[fp] = [];
      const target = this.highlightData[fp];
      for (const h of arr) {
        if (!h || typeof h.text !== "string") continue;
        const dup = target.some(
          (x) => h.id != null && String(x.id) === String(h.id) || x.text === h.text && x.start === h.start && x.end === h.end
        );
        if (dup) continue;
        target.push({
          id: h.id != null ? h.id : this.generateHighlightId(),
          text: h.text,
          start: typeof h.start === "number" ? h.start : 0,
          end: typeof h.end === "number" ? h.end : h.text.length,
          color: h.color || Object.keys(this.settings.colors)[0],
          prefix: h.prefix || "",
          suffix: h.suffix || "",
          note: typeof h.note === "string" ? h.note : ""
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
        if (h.id === void 0 || h.id === null || h.id === "") h.id = this.generateHighlightId();
        if (h.note === void 0) h.note = "";
      }
    }
  }
  generateHighlightId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "hl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
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
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const v = leaf.view;
      if (v && v.file && v.file.path === fp) return v;
    }
    return null;
  }
  getViewMode(view) {
    if (!view) return null;
    if (typeof view.getMode === "function") return view.getMode();
    if (view.previewMode && typeof view.previewMode.isActive === "boolean") {
      return view.previewMode.isActive ? "preview" : "source";
    }
    return view.mode || "source";
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
          if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(HIGHLIGHT_REFRESH)))) {
            this.decorations = this.compute(u.view);
          }
        }
        compute(view) {
          const fp = cmFileMap.get(view) || plugin.getCurrentFilePath();
          const data = fp ? plugin.highlightData[fp] || [] : [];
          const docLen = view.state.doc.length;
          const list = data.filter((h) => h && h.start >= 0 && h.end <= docLen && h.start < h.end).sort((a, b) => a.start - b.start);
          const builder = new RangeSetBuilder();
          let lastEnd = -1;
          for (const h of list) {
            if (h.start < lastEnd) continue;
            builder.add(
              h.start,
              h.end,
              Decoration.mark({
                class: `${HIGHLIGHT_CLASS} ${HIGHLIGHT_CLASS}-${h.color}`,
                attributes: { "data-hl-id": String(h.id) }
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
    for (const leaf of workspace.getLeavesOfType("markdown")) {
      const v = leaf.view;
      if (v && v.editor && v.editor.cm && v.file) {
        cmFileMap.set(v.editor.cm, v.file.path);
      }
    }
  }
  // 触发编辑模式装饰层重建
  refreshActiveEditor() {
    const view = this.getMarkdownView();
    if (!view || this.getViewMode(view) !== "source") return;
    const cm = view.editor && view.editor.cm;
    if (!cm) return;
    try {
      cm.dispatch({ effects: HIGHLIGHT_REFRESH.of(null) });
    } catch (e) {
    }
  }
  /* ===================== 高亮创建 ===================== */
  showColorMenu(evt) {
    const menu = new Menu();
    for (const [key, c] of Object.entries(this.settings.colors)) {
      menu.addItem(
        (item) => item.setTitle(`\u6807\u8BB0\u4E3A${c.name}`).setIcon("circle").onClick(() => this.highlightSelection(key))
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
    if (this.getViewMode(view) === "preview") {
      new Notice("\u8BF7\u5728\u7F16\u8F91\u6A21\u5F0F\u4E0B\u9009\u4E2D\u6587\u672C\u8FDB\u884C\u6807\u8BB0");
      return;
    }
    const fp = this.getCurrentFilePath();
    if (!fp) return;
    const editor = view.editor;
    if (!editor) return;
    let start, end, text;
    if (range && typeof range.from === "number" && typeof range.to === "number") {
      start = range.from;
      end = range.to;
      text = editor.getValue().slice(start, end);
    } else {
      const selection = editor.getSelection();
      if (!selection || !selection.trim()) {
        new Notice("\u8BF7\u5148\u9009\u4E2D\u8981\u6807\u8BB0\u7684\u6587\u672C");
        return;
      }
      const fromPos = editor.getCursor("from");
      const toPos = editor.getCursor("to");
      start = editor.posToOffset(fromPos);
      end = editor.posToOffset(toPos);
      text = selection;
    }
    if (end <= start) return;
    if (!this.highlightData[fp]) this.highlightData[fp] = [];
    const arr = this.highlightData[fp];
    if (arr.some((h) => start < h.end && end > h.start)) {
      new Notice("\u8BE5\u533A\u57DF\u5DF2\u6709\u9AD8\u4EAE");
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
      note: ""
    });
    this.scheduleSaveHighlightData();
    this.scheduleRefresh();
    this.refreshPanel();
    new Notice(`\u5DF2\u6807\u8BB0\u4E3A${this.settings.colors[colorKey] ? this.settings.colors[colorKey].name : ""}`);
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
    if (mode === "preview") {
      this.applyHighlights();
    } else {
      this.refreshActiveEditor();
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
    const preview = el.querySelector(".markdown-preview-view");
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
    const sig = this.computePreviewSig(root, fp, data);
    if (sig === this._appliedSig) return;
    this._applying = true;
    try {
      this.unwrap(root);
      if (data.length) this.renderHighlights(root, data, false);
      this._appliedSig = this.computePreviewSig(root, fp, data);
    } catch (e) {
      console.error("TextHighlightMarker: applyHighlights \u51FA\u9519", e);
    } finally {
      this._applying = false;
    }
  }
  // 计算当前预览 DOM 与期望高亮数据是否一致（用于幂等判断）
  computePreviewSig(root, fp, data) {
    const wraps = Array.from(root.querySelectorAll(".highlight-marker-wrap"));
    const cur = wraps.map((s) => {
      const id = s.getAttribute("data-hl-id");
      let color = null;
      for (const c of s.classList) {
        if (c.startsWith("highlight-marker-") && c !== "highlight-marker-wrap" && c !== "highlight-marker") {
          color = c;
          break;
        }
      }
      return { id: id || "", color: color || "", text: s.textContent };
    });
    const want = data.map((h) => ({ id: String(h.id), color: `highlight-marker-${h.color}`, text: h.text }));
    return JSON.stringify({ fp, cur, want });
  }
  // 监听预览容器变化，预览异步渲染/重渲染后自动重绘高亮
  ensureDomObserver() {
    const view = this.getMarkdownView();
    const root = view && this.getViewMode(view) === "preview" ? this.getPreviewRoot(view) : null;
    if (!root) {
      if (this._domObserver) {
        this._domObserver.disconnect();
        this._domObserver = null;
        this._domObserverTarget = null;
      }
      return;
    }
    if (this._domObserverTarget === root && this._domObserver) return;
    if (this._domObserver) this._domObserver.disconnect();
    this._domObserverTarget = root;
    this._domObserver = new MutationObserver(() => {
      if (this._applying) return;
      this.applyHighlights();
    });
    try {
      this._domObserver.observe(root, { childList: true, characterData: true, subtree: true });
    } catch (e) {
    }
  }
  buildViewMap(root) {
    const nodes = [];
    let viewText = "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest("script,style")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while (n = walker.nextNode()) {
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
    const byNode = /* @__PURE__ */ new Map();
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
      const span = document.createElement("span");
      span.className = `highlight-marker-wrap ${HIGHLIGHT_CLASS} ${HIGHLIGHT_CLASS}-${seg.color}`;
      span.setAttribute("data-hl-id", String(seg.id));
      span.textContent = full.slice(s, seg.end);
      frag.appendChild(span);
      cursor = seg.end;
    }
    if (cursor < full.length) frag.appendChild(document.createTextNode(full.slice(cursor)));
    parent.replaceChild(frag, textNode);
  }
  unwrap(root) {
    if (!root) return;
    const wraps = root.querySelectorAll(".highlight-marker-wrap");
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
    this.registerDomEvent(document, "click", (e) => this.handleHighlightClick(e));
    this.registerDomEvent(document, "keydown", (e) => {
      if (e.key === "Escape") this.hideHighlightTooltip();
    });
  }
  handleHighlightClick(e) {
    const t = e.target.closest && e.target.closest(".highlight-marker");
    if (t) {
      const id = t.getAttribute("data-hl-id");
      const colorKey = this.extractColorKey(t);
      this.showHighlightTooltip(t, colorKey, id);
      return;
    }
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
    const readOnly = view ? this.getViewMode(view) === "preview" : false;
    const tip = document.createElement("div");
    tip.className = "highlight-tooltip" + (readOnly ? " highlight-tooltip--readonly" : "");
    tip.setAttribute("data-tip-for", String(id));
    const colorInfo = this.settings.colors[h.color] || (colorKey ? this.settings.colors[colorKey] : null);
    const colorHex = colorInfo ? colorInfo.color : "var(--interactive-accent)";
    const colorName = colorInfo ? colorInfo.name : "\u9AD8\u4EAE";
    const header = tip.createDiv({ cls: "highlight-tooltip__header" });
    const swatch = header.createSpan({ cls: "highlight-tooltip__swatch" });
    swatch.style.background = colorHex;
    header.createSpan({ cls: "highlight-tooltip__title", text: `${colorName}${readOnly ? "\uFF08\u53EA\u8BFB\uFF09" : ""}` });
    const closeBtn = header.createEl("button", { cls: "highlight-tooltip__close", text: "\xD7" });
    closeBtn.setAttribute("aria-label", "\u5173\u95ED");
    const body = tip.createDiv({ cls: "highlight-tooltip__body" });
    if (readOnly) {
      const noteEl = body.createDiv({ cls: "highlight-tooltip__note-readonly" });
      noteEl.textContent = h.note && h.note.trim() ? h.note : "\uFF08\u6682\u65E0\u6279\u6CE8\uFF09";
    } else {
      const ta = body.createEl("textarea", { cls: "highlight-tooltip__note", placeholder: "\u6DFB\u52A0\u6279\u6CE8\u2026" });
      ta.rows = this.settings.noteRows || 3;
      ta.value = h.note || "";
      ta.addEventListener("input", () => this.updateHighlightNote(fp, id, ta.value));
      ta.addEventListener("keydown", (e) => e.stopPropagation());
      ta.addEventListener("mousedown", (e) => e.stopPropagation());
      const footer = tip.createDiv({ cls: "highlight-tooltip__footer" });
      const colorRow = footer.createDiv({ cls: "highlight-tooltip__colors" });
      for (const [key, c] of Object.entries(this.settings.colors)) {
        const cb = colorRow.createEl("button", {
          cls: "highlight-tooltip__color" + (key === h.color ? " is-active" : "")
        });
        cb.style.background = c.color;
        cb.setAttribute("data-color", key);
        cb.setAttribute("aria-label", `\u6539\u4E3A${c.name}`);
        cb.addEventListener("click", () => this.changeHighlightColor(fp, id, key));
      }
      const removeBtn = footer.createEl("button", {
        cls: "highlight-tooltip__remove highlight-tooltip__remove--sm",
        text: "\u53D6\u6D88\u9AD8\u4EAE"
      });
      removeBtn.addEventListener("click", () => this.removeHighlightFromTooltip(id));
    }
    closeBtn.addEventListener("click", () => this.hideHighlightTooltip());
    document.body.appendChild(tip);
    this.tooltipEl = tip;
    tip.style.setProperty("--thm-note-font-size", (this.settings.noteFontSize || 14) + "px");
    tip.style.setProperty("--thm-tip-maxw", (this.settings.tipWidth || 320) + "px");
    tip.style.setProperty("--thm-tip-minw", (this.settings.tipWidth || 320) + "px");
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
    const header = tip.querySelector(".highlight-tooltip__header");
    if (!header) return;
    header.classList.add("highlight-tooltip__header--draggable");
    header.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest(".highlight-tooltip__close")) return;
      e.preventDefault();
      const rect = tip.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      tip.classList.add("highlight-tooltip--dragging");
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
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        tip.classList.remove("highlight-tooltip--dragging");
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
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
    if (this.tooltipEl && this.tooltipEl.getAttribute("data-tip-for") === String(id)) {
      const sw = this.tooltipEl.querySelector(".highlight-tooltip__swatch");
      const ti = this.tooltipEl.querySelector(".highlight-tooltip__title");
      if (sw) sw.style.background = this.settings.colors[colorKey].color;
      if (ti) ti.textContent = this.settings.colors[colorKey].name;
      this.tooltipEl.querySelectorAll(".highlight-tooltip__color").forEach((b) => {
        b.classList.toggle("is-active", b.getAttribute("data-color") === colorKey);
      });
    }
  }
  // 在文本中高亮匹配关键词，返回 DOM 片段（大小写不敏感）
  highlightMatches(text, query) {
    const frag = document.createDocumentFragment();
    const q = (query || "").trim();
    if (!q) {
      frag.append(document.createTextNode(text || ""));
      return frag;
    }
    const lower = (text || "").toLowerCase();
    const ql = q.toLowerCase();
    let i = 0;
    let idx;
    while ((idx = lower.indexOf(ql, i)) !== -1) {
      if (idx > i) frag.append(document.createTextNode(text.slice(i, idx)));
      const mark = document.createElement("mark");
      mark.className = "thm-hl-match";
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
    this.registerDomEvent(document, "selectionchange", () => this.onSelectionChange());
  }
  onSelectionChange() {
    if (this._selTimer) clearTimeout(this._selTimer);
    this._selTimer = setTimeout(() => this.updateSelectionButton(), 60);
  }
  updateSelectionButton() {
    const view = this.getMarkdownView();
    const mode = view ? this.getViewMode(view) : null;
    if (!view || mode !== "source") {
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
      this._selBtn = document.createElement("div");
      this._selBtn.className = "thm-sel-btn";
      this._selBtn.textContent = "\u9AD8\u4EAE";
      this._selBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.onSelectionButtonClick(e);
      });
      document.body.appendChild(this._selBtn);
    }
    const h = this._selBtn.offsetHeight || 24;
    this._selBtn.style.left = `${Math.round(x)}px`;
    this._selBtn.style.top = `${Math.round(y - h - 6)}px`;
    this._selBtn.style.display = "block";
  }
  hideSelectionButton() {
    if (this._selBtn) this._selBtn.style.display = "none";
    this._selRange = null;
  }
  onSelectionButtonClick(e) {
    const range = this._selRange;
    if (!range) return;
    const menu = new Menu();
    for (const [key, c] of Object.entries(this.settings.colors)) {
      menu.addItem(
        (item) => item.setTitle(`\u6807\u8BB0\u4E3A${c.name}`).setIcon("circle").onClick(() => {
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
    const leaves = workspace.getLeavesOfType("annotation-panel");
    if (leaves.length) {
      leaves.forEach((l) => l.detach());
      return;
    }
    let leaf = workspace.getRightLeaf(true);
    if (!leaf) leaf = workspace.getLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: "annotation-panel", active: true });
    if (this.app.workspace.rightSplit && this.app.workspace.rightSplit.expand) {
      this.app.workspace.rightSplit.expand();
    }
    this.refreshPanel();
  }
  // 尝试把按钮注入到右边栏的操作区；找不到容器时返回 false
  injectRightSidebarButton() {
    if (this.rightBtn && this._rightBtnFloating) {
      this.rightBtn.remove();
      this.rightBtn = null;
      this._rightBtnFloating = false;
    }
    const candidates = [
      ".workspace-split.mod-right .side-dock-actions",
      ".workspace-split.mod-right .workspace-sidedock-header-actions",
      ".mod-right .side-dock-actions",
      ".mod-right .workspace-sidedock-header-inner",
      ".workspace-split.mod-right .workspace-sidedock-header",
      ".mod-right .workspace-sidedock-header"
    ];
    let container = null;
    for (const sel of candidates) {
      container = document.querySelector(sel);
      if (container) break;
    }
    if (!container) return false;
    if (this.rightBtn && this.rightBtn.isConnected) {
      this.rightBtn.remove();
      this.rightBtn = null;
    }
    const btn = document.createElement("div");
    btn.classList.add("side-dock-action", "thm-right-btn");
    btn.setAttribute("aria-label", "\u6279\u6CE8\u9762\u677F");
    btn.setAttribute("aria-label-position", "top");
    setIcon(btn, "sticky-note");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      this.toggleAnnotationPanel();
    });
    if (container.classList.contains("workspace-sidedock-header") || container.classList.contains("workspace-sidedock-header-inner")) {
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
    const btn = document.createElement("div");
    btn.className = "thm-floating-btn";
    setIcon(btn, "sticky-note");
    btn.setAttribute("aria-label", "\u6279\u6CE8\u9762\u677F");
    btn.addEventListener("click", (e) => {
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
    }
    tryInject();
    for (const t of [600, 1500, 3e3, 5e3, 8e3]) setTimeout(tryInject, t);
  }
  refreshPanel() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType("annotation-panel");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view && view instanceof AnnotationPanelView)) continue;
      view.updatePanel();
    }
  }
  /* ===================== 导出为笔记（全局 / 当前文档） ===================== */
  // 面板头部「导出」按钮点击后弹出的选项菜单
  showExportMenu(evt, el) {
    const menu = new Menu();
    menu.addItem(
      (item) => item.setTitle("\u5168\u5C40\u5BFC\u51FA\uFF08\u6240\u6709\u6587\u6863\uFF09").setIcon("files").onClick(() => this.exportAnnotationsToNote("all"))
    );
    menu.addItem(
      (item) => item.setTitle("\u5F53\u524D\u6587\u6863\u5BFC\u51FA").setIcon("file").onClick(() => this.exportAnnotationsToNote("current"))
    );
    if (el && el instanceof HTMLElement && typeof el.getBoundingClientRect === "function") {
      const rect = el.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    } else if (evt && evt instanceof MouseEvent) {
      menu.showAtMouseEvent(evt);
    } else {
      menu.showAtPosition({ x: 120, y: 120 });
    }
  }
  // scope: 'all' 导出所有文档；'current' 仅导出当前打开的文档
  async exportAnnotationsToNote(scope = "current") {
    const fp = this.getCurrentFilePath();
    const targets = [];
    if (scope === "all") {
      for (const fpath in this.highlightData) {
        const arr = this.highlightData[fpath];
        if (Array.isArray(arr) && arr.length) targets.push({ fp: fpath, arr });
      }
      targets.sort((a, b) => a.fp.localeCompare(b.fp));
    } else {
      if (!fp) {
        new Notice("\u672A\u6253\u5F00\u7B14\u8BB0\uFF0C\u65E0\u6CD5\u5BFC\u51FA\u5F53\u524D\u6587\u6863\u6279\u6CE8");
        return;
      }
      const arr = this.highlightData[fp] || [];
      if (!arr.length) {
        new Notice("\u5F53\u524D\u7B14\u8BB0\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u6279\u6CE8");
        return;
      }
      targets.push({ fp, arr });
    }
    if (!targets.length) {
      new Notice("\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u6279\u6CE8");
      return;
    }
    const total = targets.reduce((s, t) => s + t.arr.length, 0);
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let content = "";
    let fileName = "";
    if (scope === "all") {
      fileName = `\u5168\u90E8\u6279\u6CE8-${ts}.md`;
      content += `# \u5168\u90E8\u6279\u6CE8\u5BFC\u51FA

`;
      content += `> [!info] \u8BF4\u660E
> \u672C\u5BFC\u51FA\u5305\u542B ${targets.length} \u4E2A\u6587\u6863\u3001\u5171 ${total} \u6761\u9AD8\u4EAE\u6279\u6CE8\u3002

---

`;
      for (const { fp: fpath, arr } of targets) {
        const basename = this.getBasename(fpath);
        content += `## \u6587\u6863\uFF1A${basename}

> \u8DEF\u5F84\uFF1A${fpath} \xB7 \u5171 ${arr.length} \u6761

`;
        for (const h of arr) content += this.buildAnnotationBlock(h);
        content += `---

`;
      }
    } else {
      const cur = targets[0].arr;
      const basename = this.getBasename(fp);
      fileName = `${basename}-\u6279\u6CE8.md`;
      content += `# \u300A${basename}\u300B\u6279\u6CE8

`;
      content += `> [!info] \u8BF4\u660E
> \u672C\u7B14\u8BB0\u5171\u5305\u542B ${cur.length} \u6761\u9AD8\u4EAE\u6279\u6CE8\uFF0C\u6309\u539F\u6587\u987A\u5E8F\u6392\u5217\u3002

---

`;
      for (const h of cur) content += this.buildAnnotationBlock(h);
    }
    const folder = scope === "all" ? "" : fp.includes("/") ? fp.slice(0, fp.lastIndexOf("/") + 1) : "";
    const finalName = await this.getUniqueFileName(folder + fileName);
    const file = await this.app.vault.create(finalName, content);
    new Notice(`\u5DF2\u5BFC\u51FA ${total} \u6761\u6279\u6CE8\u5230 ${finalName}`);
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }
  // 生成单条批注的 Markdown 块（全局/当前文档导出共用）
  buildAnnotationBlock(h) {
    const heading = (h.text || "").replace(/\s+/g, " ").trim() || "\uFF08\u9AD8\u4EAE\u5185\u5BB9\u4E3A\u7A7A\uFF09";
    const note = h.note && h.note.trim() ? h.note.trim() : "_(\u6682\u65E0\u6279\u6CE8)_";
    const colorInfo = this.settings.colors[h.color];
    const colorName = colorInfo ? colorInfo.name : "\u9AD8\u4EAE";
    return `### ${heading}

${note}

> \u6807\u8BB0\u989C\u8272\uFF1A${colorName}

---

`;
  }
  async getUniqueFileName(name) {
    let candidate = name;
    let i = 1;
    while (await this.app.vault.adapter.exists(candidate)) {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      candidate = `${base} ${i}${ext}`;
      i++;
    }
    return candidate;
  }
  getBasename(path) {
    const f = path.split("/").pop();
    return f ? f.replace(/\.md$/i, "") : path;
  }
  async jumpToHighlight(fp, id) {
    const file = this.app.vault.getAbstractFileByPath(fp);
    if (!file) {
      new Notice("\u672A\u627E\u5230\u6587\u4EF6\uFF1A" + fp);
      return;
    }
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
      new Notice("\u65E0\u6CD5\u6253\u5F00\u6587\u4EF6\uFF1A" + fp);
      return;
    }
    if (this.getViewMode(view) !== "source") {
      try {
        await view.leaf.setViewState({ type: "markdown", state: { file: fp, mode: "source" } });
      } catch (e) {
      }
      view = this.getMarkdownViewForFile(fp) || view;
      await new Promise((r) => setTimeout(r, 50));
    }
    const h = (this.highlightData[fp] || []).find((x) => String(x.id) === String(id));
    if (!h) {
      new Notice("\u672A\u627E\u5230\u5BF9\u5E94\u7684\u9AD8\u4EAE\u6279\u6CE8");
      return;
    }
    if (!view.editor) {
      new Notice("\u8BE5\u89C6\u56FE\u6682\u4E0D\u652F\u6301\u5B9A\u4F4D\uFF0C\u8BF7\u5207\u6362\u5230\u7F16\u8F91\u6A21\u5F0F\u540E\u91CD\u8BD5");
      return;
    }
    const pos = view.editor.offsetToPos(h.start);
    view.editor.setCursor(pos);
    view.editor.scrollIntoView({ from: pos, to: view.editor.offsetToPos(h.end) }, true);
    this.scheduleRefresh();
  }
  /* ===================== 事件注册 ===================== */
  registerEvents() {
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor) => {
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
      this.app.workspace.on("file-open", () => {
        this._appliedSig = null;
        this._editingId = null;
        this.refreshCmFileMap();
        this.scheduleRefresh();
        this.refreshPanel();
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this._appliedSig = null;
        this._editingId = null;
        this.refreshCmFileMap();
        this.scheduleRefresh();
        this.refreshPanel();
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshCmFileMap();
        this.injectRightSidebarButton();
        this.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
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
    let css = "";
    for (const [key, c] of Object.entries(this.settings.colors)) {
      const rgb = this.hexToRgb(c.color);
      css += `.${HIGHLIGHT_CLASS}-${key}{ background-color: rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity}); }
`;
    }
    css += `.${HIGHLIGHT_CLASS}{ border-radius: 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone; cursor: pointer; }
`;
    let el = document.getElementById("thm-highlight-styles");
    if (!el) {
      el = document.createElement("style");
      el.id = "thm-highlight-styles";
      document.head.appendChild(el);
    }
    el.textContent = css;
  }
  hexToRgb(hex) {
    const m = (hex || "").replace("#", "");
    const v = m.length === 3 ? m.split("").map((x) => x + x).join("") : m;
    const int = parseInt(v, 16);
    return { r: int >> 16 & 255, g: int >> 8 & 255, b: int & 255 };
  }
};
var AnnotationPanelView = class extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return "annotation-panel";
  }
  getDisplayText() {
    return "\u6279\u6CE8\u9762\u677F";
  }
  getIcon() {
    return "sticky-note";
  }
  async onOpen() {
    this.render();
  }
  async onClose() {
  }
  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("thm-panel");
    this._query = this._query || "";
    const header = contentEl.createDiv({ cls: "thm-panel-header" });
    header.createEl("h3", { cls: "thm-panel-title", text: "\u6279\u6CE8\u9762\u677F" });
    this.metaEl = header.createDiv({ cls: "thm-panel-meta" });
    const exportBtn = header.createEl("button", { cls: "thm-panel-export", text: "\u5BFC\u51FA \u25BE" });
    exportBtn.setAttribute("aria-label", "\u5BFC\u51FA\u6279\u6CE8");
    exportBtn.addEventListener("click", (evt) => this.plugin.showExportMenu(evt, exportBtn));
    const searchWrap = contentEl.createDiv({ cls: "thm-panel-search" });
    this.searchInput = searchWrap.createEl("input", {
      cls: "thm-panel-search-input",
      type: "text",
      placeholder: "\u8DE8\u5168\u90E8\u6587\u6863\u641C\u7D22\u9AD8\u4EAE\u6587\u672C\u6216\u6279\u6CE8\u2026"
    });
    this.searchInput.setAttribute("autocomplete", "off");
    this.searchInput.value = this._query;
    this.searchInput.addEventListener("input", () => {
      this._query = this.searchInput.value;
      this.renderList();
    });
    this.searchInput.addEventListener("mousedown", (e) => e.stopPropagation());
    searchWrap.createDiv({
      cls: "thm-panel-search-hint",
      text: "\u8F93\u5165\u5173\u952E\u8BCD\u53EF\u8DE8\u6240\u6709\u6587\u6863\u68C0\u7D22\u9AD8\u4EAE\u4E0E\u6279\u6CE8"
    });
    this.listEl = contentEl.createDiv({ cls: "thm-panel-list" });
    this.updateMeta();
    this.renderList();
  }
  // 只刷新头部统计文字（不重建搜索框），避免输入框被替换导致焦点丢失
  updateMeta() {
    if (!this.metaEl) this.metaEl = this.contentEl.querySelector(".thm-panel-meta");
    if (!this.metaEl) return;
    const fp = this.plugin.getCurrentFilePath();
    const curArr = fp ? this.plugin.highlightData[fp] || [] : [];
    this.metaEl.textContent = fp ? `${this.plugin.getBasename(fp)} \xB7 \u5F53\u524D\u6587\u6863 ${curArr.length} \u6761` : "\u672A\u6253\u5F00\u7B14\u8BB0";
  }
  // 刷新面板内容（统计 + 列表），但不重建搜索框 → 保持输入框焦点
  updatePanel() {
    this.updateMeta();
    this.renderList();
  }
  renderList() {
    if (!this.listEl) return;
    const active = document.activeElement;
    let focusHlId = null;
    let ss = 0;
    let se = 0;
    if (active && active.classList && active.classList.contains("thm-panel-note")) {
      focusHlId = active.getAttribute("data-hl-id");
      try {
        ss = active.selectionStart;
        se = active.selectionEnd;
      } catch (e) {
      }
    }
    const query = (this._query || "").trim().toLowerCase();
    const fp = this.plugin.getCurrentFilePath();
    this.listEl.empty();
    let groups = [];
    if (query) {
      for (const fpath in this.plugin.highlightData) {
        const arr = this.plugin.highlightData[fpath];
        if (!Array.isArray(arr)) continue;
        const items = arr.filter((h) => {
          const t = (h.text || "").toLowerCase();
          const n = (h.note || "").toLowerCase();
          return t.includes(query) || n.includes(query);
        });
        if (items.length) {
          groups.push({
            fp: fpath,
            basename: this.plugin.getBasename(fpath),
            items,
            isCurrent: fpath === fp
          });
        }
      }
      groups.sort(
        (a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0) || a.basename.localeCompare(b.basename)
      );
    } else {
      if (!fp) {
        this.listEl.createDiv({
          cls: "thm-panel-empty",
          text: "\u6682\u65E0\u6279\u6CE8\u3002\u5728\u7F16\u8F91\u6A21\u5F0F\u4E0B\u9009\u4E2D\u6587\u672C\uFF0C\u70B9\u51FB\u6D6E\u73B0\u7684\u300C\u9AD8\u4EAE\u300D\u6309\u94AE\u5E76\u9009\u62E9\u989C\u8272\u5373\u53EF\u6DFB\u52A0\uFF08\u6279\u6CE8\u53EF\u7559\u7A7A\uFF09\uFF1B\u6216\u5728\u4E0A\u65B9\u641C\u7D22\u6846\u8DE8\u6587\u6863\u68C0\u7D22\u3002"
        });
        return;
      }
      const arr = this.plugin.highlightData[fp] || [];
      if (!arr.length) {
        this.listEl.createDiv({
          cls: "thm-panel-empty",
          text: "\u5F53\u524D\u7B14\u8BB0\u6682\u65E0\u6279\u6CE8\u3002\u5728\u7F16\u8F91\u6A21\u5F0F\u4E0B\u9009\u4E2D\u6587\u672C\uFF0C\u70B9\u51FB\u6D6E\u73B0\u7684\u300C\u9AD8\u4EAE\u300D\u6309\u94AE\u5E76\u9009\u62E9\u989C\u8272\u5373\u53EF\u6DFB\u52A0\uFF08\u6279\u6CE8\u53EF\u7559\u7A7A\uFF09\u3002"
        });
        return;
      }
      groups.push({ fp, basename: this.plugin.getBasename(fp), items: arr, isCurrent: true });
    }
    if (!groups.length) {
      this.listEl.createDiv({
        cls: "thm-panel-empty",
        text: query ? `\u6CA1\u6709\u8DE8\u6587\u6863\u5339\u914D\u201C${this._query}\u201D\u7684\u6279\u6CE8\u3002` : "\u6682\u65E0\u6279\u6CE8\u3002"
      });
      return;
    }
    for (const g of groups) {
      const groupEl = this.listEl.createDiv({ cls: "thm-panel-group" });
      const gh = groupEl.createDiv({ cls: "thm-panel-group-head" });
      const nameEl = gh.createDiv({ cls: "thm-panel-group-name" });
      nameEl.append(this.plugin.highlightMatches(g.basename, this._query || ""));
      gh.createSpan({ cls: "thm-panel-group-count", text: `${g.items.length} \u6761` });
      for (const h of g.items) {
        const item = groupEl.createDiv({ cls: "thm-panel-item" });
        const itemHead = item.createDiv({ cls: "thm-panel-item-head" });
        const colorInfo = this.plugin.settings.colors[h.color] || { color: "var(--interactive-accent)", name: "\u9AD8\u4EAE" };
        const sw = itemHead.createSpan({ cls: "thm-panel-swatch" });
        sw.style.background = colorInfo.color;
        const title = itemHead.createDiv({ cls: "thm-panel-item-title" });
        title.append(this.plugin.highlightMatches(h.text || "", this._query || ""));
        title.title = g.isCurrent ? "\u70B9\u51FB\u8DF3\u8F6C\u5230\u539F\u6587" : `\u70B9\u51FB\u8DF3\u8F6C\u5230\uFF1A${g.basename}`;
        if (!g.isCurrent) {
          itemHead.createSpan({ cls: "thm-panel-item-badge", text: "\u8DE8\u6587\u6863" });
        }
        title.addEventListener("click", () => this.plugin.jumpToHighlight(g.fp, h.id));
        const del = itemHead.createEl("button", { cls: "thm-panel-del", text: "\u5220\u9664" });
        del.addEventListener("click", () => this.plugin.removeHighlightById(g.fp, h.id));
        const isEditing = this.plugin._editingId != null && String(this.plugin._editingId) === String(h.id);
        const noteMatches = !isEditing && query && h.note && h.note.toLowerCase().includes(query);
        if (noteMatches) {
          const noteHl = item.createDiv({ cls: "thm-panel-note-hl" });
          noteHl.append(this.plugin.highlightMatches(h.note || "", this._query || ""));
        } else {
          const ta = item.createEl("textarea", { cls: "thm-panel-note", placeholder: "\u6DFB\u52A0\u6279\u6CE8\u2026" });
          ta.rows = 3;
          ta.setAttribute("data-hl-id", String(h.id));
          ta.value = h.note || "";
          ta.addEventListener("input", () => this.plugin.updateHighlightNote(g.fp, h.id, ta.value));
          ta.addEventListener("keydown", (e) => e.stopPropagation());
        }
      }
    }
    if (focusHlId !== null) {
      const el = this.listEl.querySelector(`.thm-panel-note[data-hl-id="${focusHlId}"]`);
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(ss, se);
        } catch (e) {
        }
      }
    }
  }
};
var TextHighlightMarkerSettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "peko\u6807\u6CE8 \u8BBE\u7F6E" });
    new Setting(containerEl).setName("\u9AD8\u4EAE\u4E0D\u900F\u660E\u5EA6").setDesc("\u53D6\u503C 0 - 100\uFF0C\u6570\u503C\u8D8A\u5C0F\u8D8A\u900F\u660E\u3002").addSlider(
      (slider) => slider.setLimits(10, 100, 5).setValue(this.plugin.settings.opacity).setDynamicTooltip().onChange(async (val) => {
        this.plugin.settings.opacity = val;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "\u6279\u6CE8\u5F39\u7A97\u5916\u89C2" });
    new Setting(containerEl).setName("\u6279\u6CE8\u6587\u5B57\u5927\u5C0F").setDesc("\u6279\u6CE8\u6846\u5185\u6587\u5B57\u7684\u5B57\u53F7\uFF08px\uFF09\uFF0C10 - 28\u3002").addSlider(
      (slider) => slider.setLimits(10, 28, 1).setValue(this.plugin.settings.noteFontSize).setDynamicTooltip().onChange(async (val) => {
        this.plugin.settings.noteFontSize = val;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u5F39\u51FA\u7A97\u5BBD\u5EA6").setDesc("\u6279\u6CE8\u5F39\u7A97\u5361\u7247\u7684\u6A2A\u5411\u5BBD\u5EA6\uFF08px\uFF09\uFF0C200 - 520\u3002").addSlider(
      (slider) => slider.setLimits(200, 520, 10).setValue(this.plugin.settings.tipWidth).setDynamicTooltip().onChange(async (val) => {
        this.plugin.settings.tipWidth = val;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("\u6279\u6CE8\u6846\u9AD8\u5EA6\uFF08\u884C\u6570\uFF09").setDesc("\u7F16\u8F91\u6279\u6CE8\u7684\u6587\u672C\u6846\u9AD8\u5EA6\uFF0C\u4EE5\u884C\u6570\u8BA1\uFF08\u4EC5\u7F16\u8F91\u6A21\u5F0F\u751F\u6548\uFF09\uFF0C2 - 12\u3002").addSlider(
      (slider) => slider.setLimits(2, 12, 1).setValue(this.plugin.settings.noteRows).setDynamicTooltip().onChange(async (val) => {
        this.plugin.settings.noteRows = val;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "\u9AD8\u4EAE\u989C\u8272" });
    for (const [key, c] of Object.entries(this.plugin.settings.colors)) {
      new Setting(containerEl).setName(c.name).addText(
        (text) => text.setPlaceholder("\u540D\u79F0").setValue(c.name).onChange(async (val) => {
          this.plugin.settings.colors[key].name = val;
          await this.plugin.saveSettings();
        })
      ).addText(
        (text) => text.setPlaceholder("#rrggbb").setValue(c.color).onChange(async (val) => {
          this.plugin.settings.colors[key].color = val;
          await this.plugin.saveSettings();
        })
      );
    }
    containerEl.createEl("h3", { text: "\u6570\u636E\u6301\u4E45\u5316" });
    const stats = this.plugin.getDataStats();
    const mirror = this.plugin.getCustomDir();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `\u5F53\u524D\u5171 ${stats.count} \u6761\u6279\u6CE8\uFF08${stats.files} \u4E2A\u6587\u4EF6\uFF09\u3002\u4E3B\u5B58\u50A8\uFF1AObsidian \u539F\u751F data.json\uFF08\u91CD\u542F\u81EA\u52A8\u6062\u590D\uFF0C\u4E0D\u4F1A\u4E22\u5931\uFF09\u3002` + (mirror ? `\u989D\u5916\u955C\u50CF\u76EE\u5F55\uFF1A\u4ED3\u5E93\u5185\u300C${mirror}\u300D\u3002 ` : "")
    });
    new Setting(containerEl).setName("\u989D\u5916\u955C\u50CF\u76EE\u5F55\uFF08\u53EF\u9009\uFF09").setDesc(
      "\u76F8\u5BF9 vault \u6839\u76EE\u5F55\u7684\u6587\u4EF6\u5939\u8DEF\u5F84\uFF08\u5982 thm-data\uFF09\u3002\u7559\u7A7A\u5219\u53EA\u4F7F\u7528 Obsidian \u539F\u751F\u5B58\u50A8\u3002\u8BBE\u7F6E\u540E\u4F1A\u628A\u9AD8\u4EAE\u6570\u636E\u989D\u5916\u590D\u5236\u4E00\u4EFD\u5230\u8BE5 vault \u6587\u4EF6\u5939\uFF0C\u4FBF\u4E8E\u67E5\u9605\u4E0E\u624B\u52A8\u5907\u4EFD\uFF1B\u4FEE\u6539\u540E\u7ACB\u5373\u751F\u6548\u3002"
    ).addText((text) => {
      text.setPlaceholder("\u7559\u7A7A = \u4EC5\u539F\u751F\u5B58\u50A8").setValue(this.plugin.settings.dataDir || "");
      text.inputEl.addEventListener("blur", async () => {
        const val = (text.getValue() || "").trim().replace(/^\/+|\/+$/g, "");
        if (val === (this.plugin.settings.dataDir || "")) return;
        this.plugin.settings.dataDir = val;
        await this.plugin.persistAll();
        new Notice(val ? `\u5DF2\u5F00\u542F\u989D\u5916\u955C\u50CF\u76EE\u5F55\uFF1A${val}` : "\u5DF2\u5173\u95ED\u989D\u5916\u955C\u50CF\u76EE\u5F55");
        this.display();
      });
    });
    new Setting(containerEl).setName("\u5907\u4EFD\uFF1A\u5BFC\u51FA\u6570\u636E").setDesc("\u5C06\u6240\u6709\u9AD8\u4EAE\u4E0E\u6279\u6CE8\u5BFC\u51FA\u4E3A\u4E00\u4E2A JSON \u5907\u4EFD\u6587\u4EF6\uFF08\u4E0B\u8F7D\u5230\u672C\u5730\uFF0C\u4E0D\u5199\u5165 vault\uFF09\u3002").addButton(
      (btn) => btn.setButtonText("\u5BFC\u51FA\u5907\u4EFD").setCta().onClick(() => this.plugin.exportBackup())
    );
    new Setting(containerEl).setName("\u6062\u590D\uFF1A\u5BFC\u5165\u6570\u636E\uFF08\u5408\u5E76\uFF09").setDesc("\u4ECE\u5907\u4EFD JSON \u6587\u4EF6\u5BFC\u5165\u5E76\u4E0E\u73B0\u6709\u6570\u636E\u5408\u5E76\uFF08\u81EA\u52A8\u53BB\u91CD\uFF0C\u4E0D\u4F1A\u5220\u9664\u5DF2\u6709\u6279\u6CE8\uFF09\u3002").addButton(
      (btn) => btn.setButtonText("\u9009\u62E9\u6587\u4EF6\u5408\u5E76\u5BFC\u5165").onClick(() => this.plugin.importBackup("merge"))
    );
    new Setting(containerEl).setName("\u6062\u590D\uFF1A\u5BFC\u5165\u6570\u636E\uFF08\u8986\u76D6\uFF09").setDesc("\u26A0\uFE0F \u7528\u5907\u4EFD\u6587\u4EF6\u5B8C\u5168\u66FF\u6362\u5F53\u524D\u6240\u6709\u6570\u636E\u3002\u5F53\u524D\u6570\u636E\u5C06\u88AB\u6E05\u7A7A\u540E\u518D\u5BFC\u5165\uFF0C\u8BF7\u8C28\u614E\u4F7F\u7528\u3002").addButton(
      (btn) => btn.setButtonText("\u9009\u62E9\u6587\u4EF6\u8986\u76D6\u5BFC\u5165").setWarning().onClick(() => this.plugin.importBackup("replace"))
    );
  }
};
module.exports = TextHighlightMarker;
