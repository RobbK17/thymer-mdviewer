/**
 * Thymer Markdown Preview — AppPlugin
 *
 * Opens a read-only live preview of the current record in a new panel.
 * Auto-refreshes whenever the record's content changes.
 */

// ── External libs (pinned versions; check changelogs before upgrading) ──────────
const MARKED_VERSION = "9";
const MARKED_CDN = `https://cdn.jsdelivr.net/npm/marked@${MARKED_VERSION}/marked.min.js`;
const DOMPURIFY_CDN = "https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js";

let _markedPromise = null;
let _dompurifyPromise = null;
let _markedLoadFailed = false;

function loadMarked() {
  if (_markedPromise) return _markedPromise;
  _markedPromise = new Promise((resolve, reject) => {
    if (window.marked) { resolve(window.marked); return; }
    const s = document.createElement("script");
    s.src = MARKED_CDN;
    s.onload = () => resolve(window.marked);
    s.onerror = () => {
      _markedLoadFailed = true;
      console.warn("[Markdown Preview] Could not load marked.js from CDN.");
      reject(new Error("Could not load marked.js"));
    };
    document.head.appendChild(s);
  });
  return _markedPromise;
}

function loadDOMPurify() {
  if (_dompurifyPromise) return _dompurifyPromise;
  _dompurifyPromise = new Promise((resolve, reject) => {
    if (window.DOMPurify) { resolve(window.DOMPurify); return; }
    const s = document.createElement("script");
    s.src = DOMPURIFY_CDN;
    s.onload = () => resolve(window.DOMPurify);
    s.onerror = () => {
      console.warn("[Markdown Preview] Could not load DOMPurify; preview will not be sanitized.");
      resolve(null);
    };
    document.head.appendChild(s);
  });
  return _dompurifyPromise;
}

// Ensure tables end at a blank line so headings and other blocks are never inside a table.
// Note: setextUnderlineRe matches "---" which can also be a horizontal rule; we treat it as
// a block boundary so tables end before it. GFM tables require leading/trailing | per row.
function normalizeTableBoundaries(md) {
  if (!md || typeof md !== "string") return md;
  const lines = md.split("\n");
  const out = [];
  let inTable = false;
  const tableRowRe = /^\s*\|.+\|\s*$/;
  const separatorRe = /^\s*\|[\s\-:|]+\|\s*$/;
  const atxHeadingRe = /^#+\s/;           // ## Personal
  const setextUnderlineRe = /^(\s*=+|\s*-+)\s*$/;  // === or --- (also used as setext underline)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const isTableRow = tableRowRe.test(line);
    const isSeparator = separatorRe.test(line);
    const isBlank = /^\s*$/.test(line);
    const isHeading = atxHeadingRe.test(line) || setextUnderlineRe.test(line);

    if (inTable) {
      if (isBlank) {
        inTable = false;
        out.push(line);
      } else if (isHeading || !isTableRow) {
        out.push("");
        out.push(line);
        inTable = false;
      } else {
        out.push(line);
      }
      continue;
    }

    if (isTableRow && next != null && separatorRe.test(next)) {
      inTable = true;
      out.push(line);
      continue;
    }

    out.push(line);
  }
  return out.join("\n");
}

// Get markdown body from a record (strips frontmatter). Returns empty string if no content.
async function getMarkdownContent(record) {
  if (!record) return "";
  const result = await record.getAsMarkdown({ experimental: true });
  let raw = "";
  if (typeof result === "string") raw = result;
  else if (result && typeof result.content === "string") raw = result.content;
  else if (result && typeof result.markdown === "string") raw = result.markdown;
  return raw.replace(/^---[\s\S]*?---\s*\n?/, "");
}

// ── Plugin ────────────────────────────────────────────────────────────────────

class Plugin extends AppPlugin {

  onLoad() {
    loadMarked().catch(() => {});
    loadDOMPurify().catch(() => {});

    this._previewPanel = null;
    this._unloadFns = [];
    this._statusBarItem = null;

    this.ui.injectCSS(`
      .md-preview-status-active { font-weight: 600; background: var(--hover-bg, rgba(0,0,0,0.08)) !important; border-radius: 4px; }
      .md-plugin-wrap {
        width: 100% !important;
        max-width: 100% !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
        display: flex !important;
        flex-direction: column !important;
        min-height: 0 !important;
      }
      .md-toolbar {
        width: 100% !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
        flex-shrink: 0 !important;
      }
      .md-preview {
        max-width: none !important;
        box-sizing: border-box !important;
        min-height: 0 !important;
        flex: 1 1 0 !important;
        overflow-y: auto !important;
        overflow-x: auto !important;
        -webkit-overflow-scrolling: touch !important;
        user-select: text !important;
        -webkit-user-select: text !important;
      }
      .md-preview h1, .md-preview h2, .md-preview h3, .md-preview h4, .md-preview h5, .md-preview h6 {
        font-weight: 700;
        line-height: 1.3;
        margin: 1em 0 0.5em;
      }
      .md-preview h1 { font-size: 1.75em; }
      .md-preview h2 { font-size: 1.4em; }
      .md-preview p { margin: 0 0 1em; }
      .md-preview ul, .md-preview ol { padding-left: 1.6em; margin: 0 0 1em; }
      .md-preview code { font-family: monospace; font-size: 0.9em; background: rgba(0,0,0,0.06); padding: 0.15em 0.4em; border-radius: 3px; }
      .md-preview pre { background: rgba(0,0,0,0.05); padding: 1em; overflow-x: auto; margin: 0 0 1em; border-radius: 6px; }
      .md-preview pre code { background: none; padding: 0; }
      .md-preview blockquote { border-left: 3px solid #4f46e5; margin: 0 0 1em; padding: 0.5em 1em; color: #6b7280; }
      .md-preview a { color: #4f46e5; text-decoration: none; }
      .md-preview table, .md-preview tr { user-select: text !important; -webkit-user-select: text !important; }
      .md-preview table { border-collapse: collapse; width: 100%; }
      .md-preview th, .md-preview td { border: 1px solid #e2e8f0; padding: 6px 12px; text-align: left; user-select: text !important; -webkit-user-select: text !important; }
      .md-preview th { background: #e2e8f0 !important; color: #334155 !important; font-weight: 600 !important; }
      .md-preview tbody td { color: #334155 !important; }
      .md-preview tbody tr:nth-child(even) td { background: #f1f5f9 !important; }
      .md-preview tbody tr:nth-child(odd) td { background: #fff !important; }
    `);

    this.ui.registerCustomPanelType("md-preview-panel", (panel) => {
      this._previewPanel = panel;
      mountPreviewPanel(this, panel);
      this._setStatusBarPreviewActive(true);
    });

    const togglePreviewPanel = async () => {
      if (this._previewPanel) {
        const el = this._previewPanel.getElement();
        if (el && document.body.contains(el)) {
          this.ui.closePanel(this._previewPanel);
          this._previewPanel = null;
          this._setStatusBarPreviewActive(false);
          return;
        }
        this._previewPanel = null;
      }
      const panel = await this.ui.createPanel({ afterPanel: this.ui.getActivePanel() });
      if (panel) panel.navigateToCustomType("md-preview-panel");
    };

    this._statusBarItem = this.ui.addStatusBarItem({
      label:   "MD Preview",
      icon:    "article",
      tooltip: "Toggle Markdown Preview",
      onClick: togglePreviewPanel,
    });

    this._setStatusBarPreviewActive = (active) => {
      if (!this._statusBarItem) return;
      const el = this._statusBarItem.getElement?.();
      if (el) {
        if (active) el.classList.add("md-preview-status-active");
        else el.classList.remove("md-preview-status-active");
      }
    };

    const onPanelClosed = (ev) => {
      if (ev.panel === this._previewPanel) {
        this._previewPanel = null;
        this._setStatusBarPreviewActive(false);
      }
    };

    const onNavigated = (ev) => {
      if (!this._previewPanel) return;
      const el = this._previewPanel.getElement();
      const fn = el ? el._mdRefresh : null;
      if (typeof fn === "function") fn();
    };
    const onLineItem = (ev) => {
      if (!this._previewPanel) return;
      const el = this._previewPanel.getElement();
      const rerender = el ? el._mdRerender : null;
      if (typeof rerender === "function") rerender(ev.recordGuid);
    };

    this.events.on("panel.navigated", onNavigated);
    this.events.on("panel.closed", onPanelClosed);
    this.events.on("lineitem.updated", onLineItem);
    this.events.on("lineitem.created", onLineItem);
    this.events.on("lineitem.deleted", onLineItem);

    const off = typeof this.events.off === "function" ? (name, fn) => this.events.off(name, fn) : () => {};
    this._unloadFns.push(
      () => off("panel.navigated", onNavigated),
      () => off("panel.closed", onPanelClosed),
      () => off("lineitem.updated", onLineItem),
      () => off("lineitem.created", onLineItem),
      () => off("lineitem.deleted", onLineItem),
      () => { if (this._statusBarItem && typeof this._statusBarItem.remove === "function") this._statusBarItem.remove(); }
    );
  }

  onUnload() {
    if (Array.isArray(this._unloadFns)) {
      this._unloadFns.forEach((fn) => { try { fn(); } catch (e) {} });
      this._unloadFns = [];
    }
  }
}

// ── Panel mount ───────────────────────────────────────────────────────────────

function mountPreviewPanel(plugin, panel) {
  panel.setTitle("Markdown Preview");

  function tryMount(attemptsLeft) {
    const root = panel.getElement();
    if (!root) {
      if (attemptsLeft > 0) requestAnimationFrame(() => tryMount(attemptsLeft - 1));
      return;
    }
    buildPanel(root);
  }

  tryMount(60);  // ~1s at 60fps; host may create panel root asynchronously

  function buildPanel(root) {
    root.innerHTML = "";
    root.dataset.mdPreviewPanel = "1";

    root.style.cssText += ";height:100%;display:flex;flex-direction:column;min-height:0;overflow:hidden;box-sizing:border-box;";
    // Ensure height chain up to host panel so preview can scroll (host structure may vary)
    let _el = root.parentElement;
    while (_el && !_el.classList.contains("panel")) {
      _el.style.cssText += ";height:100%;min-height:0;flex:1;overflow:hidden;";
      _el = _el.parentElement;
    }

    // ── State
    let activeRecord = null;

    // ── DOM

    const wrap = document.createElement("div");
    wrap.className = "md-plugin-wrap";

    // Toolbar — title + word count only
    const toolbar = document.createElement("div");
    toolbar.className = "md-toolbar";

    const domTitle = document.createElement("div");
    domTitle.className = "md-toolbar-title";
    domTitle.textContent = "Open a record to preview";

    const domWC = Object.assign(document.createElement("span"), {
      className: "md-pill",
      textContent: "0 words"
    });

    const right = document.createElement("div");
    right.className = "md-toolbar-right";
    right.appendChild(domWC);
    toolbar.append(domTitle, right);

    // Preview area — full width, scrollable
    const domPreview = document.createElement("div");
    domPreview.className = "md-preview empty-state";
    domPreview.textContent = "Nothing to preview yet";
    domPreview.style.cssText = "flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:12px 16px 24px;box-sizing:border-box;width:100%;";

    wrap.append(toolbar, domPreview);
    root.appendChild(wrap);

    // ── Render

    async function renderPreview(markdown) {
      if (!markdown || !markdown.trim()) {
        domPreview.className = "md-preview empty-state";
        domPreview.textContent = "Nothing to preview yet";
        domWC.textContent = "0 words";
        return;
      }
      try {
        if (_markedLoadFailed) {
          domPreview.className = "md-preview";
          domPreview.textContent = "Markdown engine failed to load. Check console.";
          return;
        }
        const normalized = normalizeTableBoundaries(markdown);
        const marked = await loadMarked();
        const parse = typeof marked.parse === "function" ? marked.parse : marked;
        const rawHtml = typeof parse === "function" ? parse(normalized, { breaks: true, gfm: true }) : String(normalized);
        const DOMPurify = await loadDOMPurify();
        const html = DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml;
        domPreview.className = "md-preview";
        domPreview.innerHTML = html;
        domPreview.querySelectorAll("a[href]").forEach((a) => {
          if (a.getAttribute("href").indexOf("#") !== 0) {
            a.target = "_blank";
            a.rel = "noopener noreferrer";
          }
        });
        const wc = markdown.trim() ? markdown.trim().split(/\s+/).length : 0;
        domWC.textContent = wc + " word" + (wc !== 1 ? "s" : "");
      } catch (err) {
        domPreview.className = "md-preview";
        domPreview.textContent = "Preview error: " + err.message;
      }
    }

    async function loadRecord(record) {
      activeRecord = record;

      if (!record) {
        domTitle.textContent = "No record open";
        domWC.textContent = "0 words";
        panel.setTitle("Markdown Preview");
        await renderPreview("");
        return;
      }

      const name = record.getName() || "Untitled";
      domTitle.textContent = name;
      panel.setTitle("Preview: " + name);

      const content = await getMarkdownContent(record);
      await renderPreview(content);
    }

    // refresh — called when panel.navigated fires; only reloads when active record GUID changes
    async function refresh() {
      const panels = plugin.ui.getPanels().filter((p) => {
        const el = p.getElement();
        return !(el && el.dataset && el.dataset.mdPreviewPanel);
      });
      let record = null;
      for (let i = 0; i < panels.length; i++) {
        record = panels[i].getActiveRecord();
        if (record) break;
      }
      const newGuid = record ? record.guid : null;
      const activeGuid = activeRecord ? activeRecord.guid : null;
      if (newGuid !== activeGuid) {
        await loadRecord(record ?? null);
      }
    }

    // rerender — called when a lineitem changes; only re-renders if it's our record
    async function rerender(changedRecordGuid) {
      if (!activeRecord) return;
      if (changedRecordGuid !== activeRecord.guid) return;
      const record = plugin.data.getRecord(activeRecord.guid);
      if (!record) return;
      const content = await getMarkdownContent(record);
      await renderPreview(content);
    }

    root._mdRefresh  = refresh;
    root._mdRerender = rerender;

    refresh();

  } // end buildPanel
}