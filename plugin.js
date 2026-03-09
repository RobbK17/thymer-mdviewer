/**
 * Thymer Markdown Preview — AppPlugin
 *
 * Opens a read-only live preview of the current record in a new panel.
 * Auto-refreshes whenever the record's content changes.
 *
 * genvalue: 2026-03-09-15
 * version: 1.2.0
 */

// ── External libs (pinned versions; check changelogs before upgrading) ──────────
const MARKED_VERSION = "9";
const MARKED_CDN = `https://cdn.jsdelivr.net/npm/marked@${MARKED_VERSION}/marked.min.js`;
const DOMPURIFY_CDN = "https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js";
const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@9/dist/mermaid.min.js";

let _markedPromise = null;
let _dompurifyPromise = null;
let _mermaidPromise = null;
let _markedLoadFailed = false;


function loadMermaid() {
  if (_mermaidPromise) return _mermaidPromise;
  _mermaidPromise = new Promise((resolve) => {
    const initMermaid = () => {
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const theme = "base";
      const readCssVar = (name, fallback) => {
        try {
          const root = document.querySelector(".md-plugin-wrap") || document.body || document.documentElement;
          if (!root) return fallback;
          const value = window.getComputedStyle(root).getPropertyValue(name).trim();
          return value || fallback;
        } catch (e) { return fallback; }
      };
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme,
          pie: { useWidth: 800},
          themeVariables: {
            background:         "transparent",
            primaryColor:       readCssVar("--md-mermaid-primary",       prefersDark ? "#1e293b" : "#e2e8f0"),
            primaryTextColor:   readCssVar("--md-mermaid-primary-text",  prefersDark ? "#e5e7eb" : "#020617"),
            secondaryColor:     readCssVar("--md-mermaid-secondary",     prefersDark ? "#0f172a" : "#f9fafb"),
            tertiaryColor:      readCssVar("--md-mermaid-tertiary",      prefersDark ? "#020617" : "#ffffff"),
            lineColor:          readCssVar("--md-mermaid-line",          prefersDark ? "#e5e7eb" : "#334155"),
            secondaryTextColor: readCssVar("--md-mermaid-secondary-text",prefersDark ? "#e5e7eb" : "#111827"),
            actorTextColor:     readCssVar("--md-mermaid-actor-text",    prefersDark ? "#f9fafb" : "#111827"),
            signalTextColor:    readCssVar("--md-mermaid-signal-text",   prefersDark ? "#e5e7eb" : "#111827"),
            labelTextColor:     readCssVar("--md-mermaid-label-text",    prefersDark ? "#e5e7eb" : "#111827"),
            actorLineColor:     readCssVar("--md-mermaid-actor-line",    prefersDark ? "#56B4E9" : "#334155"),
            noteTextColor:      readCssVar("--md-mermaid-note-text",     "#111827")
          }
        });
      } catch (e) {}
      resolve(window.mermaid);
    };
    if (window.mermaid) { initMermaid(); return; }
    const s = document.createElement("script");
    s.src = MERMAID_CDN;
    s.onload = () => initMermaid();
    s.onerror = () => { console.warn("[Markdown Preview] Could not load mermaid.js from CDN."); resolve(null); };
    document.head.appendChild(s);
  });
  return _mermaidPromise;
}

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
  _dompurifyPromise = new Promise((resolve) => {
    if (window.DOMPurify) { resolve(window.DOMPurify); return; }
    const s = document.createElement("script");
    s.src = DOMPURIFY_CDN;
    s.onload = () => resolve(window.DOMPurify);
    s.onerror = () => { console.warn("[Markdown Preview] Could not load DOMPurify."); resolve(null); };
    document.head.appendChild(s);
  });
  return _dompurifyPromise;
}

function normalizeTableBoundaries(md) {
  if (!md || typeof md !== "string") return md;
  const lines = md.split("\n");
  const out = [];
  let inTable = false;
  const tableRowRe     = /^\s*\|.+\|\s*$/;
  const separatorRe    = /^\s*\|[\s\-:|]+\|\s*$/;
  const atxHeadingRe   = /^#+\s/;
  const setextUnderRe  = /^(\s*=+|\s*-+)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const isTableRow = tableRowRe.test(line);
    const isBlank    = /^\s*$/.test(line);
    const isHeading  = atxHeadingRe.test(line) || setextUnderRe.test(line);

    if (inTable) {
      if (isBlank)                      { inTable = false; out.push(line); }
      else if (isHeading || !isTableRow){ out.push(""); out.push(line); inTable = false; }
      else                              { out.push(line); }
      continue;
    }
    if (isTableRow && next != null && separatorRe.test(next)) { inTable = true; out.push(line); continue; }
    out.push(line);
  }
  return out.join("\n");
}

function extractMermaidBlocks(markdown) {
  const blocks = [];
  if (!markdown || typeof markdown !== "string") return { markdown: markdown || "", blocks };

  const lines = markdown.split(/\r\n|\r|\n/);
  const outLines = [];
  let inBlock = false, current = [], blockIndex = 0;

  const isMermaidDeclarationLine = (s) =>
    /^\s*(graph|flowchart|pie(\s|$)|sequenceDiagram|gantt|stateDiagram|erDiagram|journey)\b/i.test(String(s || "").trim());

  const mermaidishLookahead = (startIndex, kind) => {
    for (let j = startIndex; j < lines.length && j < startIndex + 8; j++) {
      const ln = lines[j];
      if (/^\s*```/.test(ln)) break;
      if (!ln || !ln.trim()) continue;
      if (kind === "pie") { if (/^\s*("?[^"]+"?)\s*:\s*-?\d+(\.\d+)?\s*$/.test(ln)) return true; continue; }
      if (/(-->|---|==>|->>|-->>|<-|subgraph\b|classDef\b|participant\b|actor\b|state\b|note\b)/i.test(ln)) return true;
      if (/\w+\s*--+\s*\w+/.test(ln)) return true;
      if (/[A-Za-z0-9_]+\s*\[.*\]\s*--?>\s*[A-Za-z0-9_]+/.test(ln)) return true;
    }
    return false;
  };

  const stripStrayFences = (body) => String(body || "").replace(/^\s*```[ \t]*\s*$/gm, "").trimEnd();

  const finalizeBlock = () => {
    let bodyLines = current.slice();
    const nonEmpty = bodyLines.filter((l) => /\S/.test(l));
    let minIndent = Infinity;
    nonEmpty.forEach((l) => { const m = l.match(/^(\s*)\S/); if (m) minIndent = Math.min(minIndent, m[1].length); });
    if (isFinite(minIndent) && minIndent > 0) {
      bodyLines = bodyLines.map((l) => { const lead = (l.match(/^\s*/) || [""])[0].length; return l.slice(Math.min(minIndent, lead)); });
    }
    let body = bodyLines.join("\n").trimEnd();
    body = body.replace(/\n\s*```[ \t]*$/, "");
    body = stripStrayFences(body);
    blocks.push(body);
    outLines.push(`<div data-md-mermaid-id="${blockIndex++}"></div>`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^\s*```[ \t]*mermaid\b/i.test(line)) { inBlock = true; current = []; continue; }
    if (inBlock && /^```[ \t]*$/.test(line)) {
      if (current.length === 1 && isMermaidDeclarationLine(current[0])) {
        const kind = /^\s*pie(\s|$)/i.test(current[0].trim()) ? "pie" : "other";
        if (mermaidishLookahead(i + 1, kind)) { current.push(line); continue; }
      }
      finalizeBlock(); inBlock = false; current = []; continue;
    }
    if (inBlock) { current.push(line); } else { outLines.push(line); }
  }
  if (inBlock) finalizeBlock();

  return { markdown: outLines.join("\n"), blocks };
}

async function getMarkdownContent(record) {
  if (!record) return "";
  const result = await record.getAsMarkdown({ experimental: true });
  let raw = "";
  if (typeof result === "string")                   raw = result;
  else if (result && typeof result.content === "string")  raw = result.content;
  else if (result && typeof result.markdown === "string") raw = result.markdown;
  return raw.replace(/^---[\s\S]*?---\s*\n?/, "");
}

// ── Plugin ────────────────────────────────────────────────────────────────────

class Plugin extends AppPlugin {

  onLoad() {
    loadMarked().catch(() => {});
    loadDOMPurify().catch(() => {});
    loadMermaid().catch(() => {});

    this._previewPanel   = null;
    this._unloadFns      = [];
    this._statusBarItem  = null;
    this._lastActivePanel = null;

    this.ui.injectCSS(`
      /* ── Status bar ── */
      .md-preview-status-active { font-weight: 600; background: var(--hover-bg, rgba(0,0,0,0.08)) !important; border-radius: 4px; }
      :has(> [data-md-preview-panel="1"]) { position: relative !important; z-index: 10 !important; }

      /* ── Wrap ── */
      .md-plugin-wrap {
        width: 100% !important; max-width: 100% !important; overflow: hidden !important;
        box-sizing: border-box !important; display: flex !important; flex-direction: column !important;
        min-height: 0 !important; font-family: inherit !important;
      }
      .md-plugin-wrap, .md-plugin-wrap * { box-sizing: border-box; }

      /* ── Toolbar ── */
      .md-toolbar {
        display: flex !important; align-items: center !important; gap: 8px !important;
        padding: 6px 12px !important; border-bottom: 1px solid rgba(0,0,0,0.12) !important;
        flex-shrink: 0 !important; flex-wrap: wrap !important; min-height: 40px !important;
        width: 100% !important; box-sizing: border-box !important; overflow: hidden !important;
      }
      .md-toolbar-title {
        font-weight: 600; font-size: 14px; flex: 1 1 0; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; min-width: 0;
      }
      .md-toolbar-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }

      /* ── Selects ── */
      .md-table-style-select, .md-mermaid-theme-select {
        font-size: 11px; padding: 2px 4px; border-radius: 4px;
        border: 1px solid rgba(0,0,0,0.2); background: #ffffff; color: #111827; cursor: pointer;
      }
      @media (prefers-color-scheme: dark) {
        .md-table-style-select, .md-mermaid-theme-select {
          background: #1f2937; color: #e5e7eb; border-color: rgba(255,255,255,0.2);
        }
      }

      /* ── Zoom controls ── */
      .md-zoom-btn {
        font-size: 14px; line-height: 1; padding: 1px 7px; border-radius: 4px;
        border: 1px solid rgba(0,0,0,0.2); background: transparent;
        cursor: pointer; color: inherit; flex-shrink: 0; user-select: none;
      }
      .md-zoom-btn:hover { background: rgba(0,0,0,0.07); }
      @media (prefers-color-scheme: dark) {
        .md-zoom-btn { border-color: rgba(255,255,255,0.2); }
        .md-zoom-btn:hover { background: rgba(255,255,255,0.07); }
      }
      .md-zoom-label {
        font-size: 11px; padding: 2px 5px; border-radius: 999px; min-width: 42px;
        text-align: center; background: rgba(0,0,0,0.06); white-space: nowrap;
        cursor: pointer; user-select: none;
      }
      .md-zoom-label:hover { background: rgba(0,0,0,0.12); }
      @media (prefers-color-scheme: dark) {
        .md-zoom-label { background: rgba(255,255,255,0.08); }
        .md-zoom-label:hover { background: rgba(255,255,255,0.14); }
      }

      /* ── Word count pill ── */
      .md-pill { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: rgba(0,0,0,0.06); white-space: nowrap; }

      /* ── Preview area ── */
      .md-preview {
        max-width: none !important; box-sizing: border-box !important; min-height: 0 !important;
        flex: 1 1 0 !important; overflow-y: auto !important; overflow-x: auto !important;
        -webkit-overflow-scrolling: touch !important; user-select: text !important;
        -webkit-user-select: text !important; font-size: 14px !important; line-height: 1.75 !important;
        padding: 12px 16px 24px !important;
      }
      .md-preview h1,.md-preview h2,.md-preview h3,.md-preview h4,.md-preview h5,.md-preview h6 { font-weight: 700; line-height: 1.3; margin: 1em 0 0.5em; }
      .md-preview h1 { font-size: 1.75em; } .md-preview h2 { font-size: 1.4em; }
      .md-preview p { margin: 0 0 1em; }
      .md-preview ul,.md-preview ol { padding-left: 1.6em; margin: 0 0 1em; }
      .md-preview li { margin-bottom: 0.25em; }
      .md-preview code { font-family: monospace; font-size: 0.9em; background: rgba(0,0,0,0.06); padding: 0.15em 0.4em; border-radius: 3px; }
      .md-preview pre { background: rgba(0,0,0,0.05); padding: 1em; overflow-x: auto; margin: 0 0 1em; border-radius: 6px; }
      .md-preview pre code { background: none; padding: 0; }
      .md-preview blockquote { border-left: 3px solid #4f46e5; margin: 0 0 1em; padding: 0.5em 1em; color: #6b7280; }
      .md-preview a { color: #4f46e5; text-decoration: none; }
      .md-preview a:hover { text-decoration: underline; }
      .md-preview hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.5em 0; }
      .md-preview img { max-width: 100%; border-radius: 4px; }

      /* ── Tables ── */
      .md-preview table,.md-preview tr { user-select: text !important; -webkit-user-select: text !important; }
      .md-preview table { border-collapse: collapse !important; width: 100% !important; margin: 0 0 1em !important; }
      .md-preview th,.md-preview td { border: 1px solid #94a3b8 !important; padding: 6px 12px !important; text-align: left !important; user-select: text !important; -webkit-user-select: text !important; }
      .md-preview th { font-weight: 700 !important; }

      /* High Contrast */
      .md-plugin-wrap[data-table-style="hc"] .md-preview th { background: #1e3a5f !important; color: #ffffff !important; border-color: #94a3b8 !important; }
      .md-plugin-wrap[data-table-style="hc"] .md-preview td { color: #0f172a !important; border-color: #94a3b8 !important; }
      .md-plugin-wrap[data-table-style="hc"] .md-preview tbody tr:nth-child(even) td { background: #e8f4fd !important; }
      .md-plugin-wrap[data-table-style="hc"] .md-preview tbody tr:nth-child(odd) td  { background: #ffffff !important; }
      .md-plugin-wrap[data-table-style="hc"] .md-preview tbody tr:hover td { background: #fef3c7 !important; color: #0f172a !important; }
      @media (prefers-color-scheme: dark) {
        .md-plugin-wrap[data-table-style="hc"] .md-preview th { background: #1e40af !important; color: #ffffff !important; border-color: #475569 !important; }
        .md-plugin-wrap[data-table-style="hc"] .md-preview td { color: #e2e8f0 !important; border-color: #475569 !important; }
        .md-plugin-wrap[data-table-style="hc"] .md-preview tbody tr:nth-child(even) td { background: #1e293b !important; }
        .md-plugin-wrap[data-table-style="hc"] .md-preview tbody tr:nth-child(odd) td  { background: #0f172a !important; }
        .md-plugin-wrap[data-table-style="hc"] .md-preview tbody tr:hover td { background: #78350f !important; color: #fef3c7 !important; }
      }
      /* Monochrome */
      .md-plugin-wrap[data-table-style="mono"] .md-preview th { background: #111827 !important; color: #ffffff !important; border: 2px solid #374151 !important; }
      .md-plugin-wrap[data-table-style="mono"] .md-preview td { color: #111827 !important; border-color: #6b7280 !important; }
      .md-plugin-wrap[data-table-style="mono"] .md-preview tbody tr:nth-child(even) td { background: #f3f4f6 !important; }
      .md-plugin-wrap[data-table-style="mono"] .md-preview tbody tr:nth-child(odd) td  { background: #ffffff !important; }
      .md-plugin-wrap[data-table-style="mono"] .md-preview tbody tr:hover td { background: #e5e7eb !important; }
      @media (prefers-color-scheme: dark) {
        .md-plugin-wrap[data-table-style="mono"] .md-preview th { background: #1f2937 !important; color: #f9fafb !important; border-color: #6b7280 !important; }
        .md-plugin-wrap[data-table-style="mono"] .md-preview td { color: #e5e7eb !important; border-color: #4b5563 !important; }
        .md-plugin-wrap[data-table-style="mono"] .md-preview tbody tr:nth-child(even) td { background: #111827 !important; }
        .md-plugin-wrap[data-table-style="mono"] .md-preview tbody tr:nth-child(odd) td  { background: #1f2937 !important; }
        .md-plugin-wrap[data-table-style="mono"] .md-preview tbody tr:hover td { background: #374151 !important; color: #f9fafb !important; }
      }
      /* Blue Stripe */
      .md-plugin-wrap[data-table-style="blue"] .md-preview th { background: #1d4ed8 !important; color: #ffffff !important; border-color: #3b82f6 !important; }
      .md-plugin-wrap[data-table-style="blue"] .md-preview td { color: #1e3a5f !important; border-color: #93c5fd !important; }
      .md-plugin-wrap[data-table-style="blue"] .md-preview tbody tr:nth-child(even) td { background: #dbeafe !important; }
      .md-plugin-wrap[data-table-style="blue"] .md-preview tbody tr:nth-child(odd) td  { background: #ffffff !important; }
      .md-plugin-wrap[data-table-style="blue"] .md-preview tbody tr:hover td { background: #bfdbfe !important; }
      @media (prefers-color-scheme: dark) {
        .md-plugin-wrap[data-table-style="blue"] .md-preview th { background: #1e40af !important; color: #ffffff !important; border-color: #3b82f6 !important; }
        .md-plugin-wrap[data-table-style="blue"] .md-preview td { color: #bfdbfe !important; border-color: #1d4ed8 !important; }
        .md-plugin-wrap[data-table-style="blue"] .md-preview tbody tr:nth-child(even) td { background: #1e3a5f !important; }
        .md-plugin-wrap[data-table-style="blue"] .md-preview tbody tr:nth-child(odd) td  { background: #172554 !important; }
        .md-plugin-wrap[data-table-style="blue"] .md-preview tbody tr:hover td { background: #1e40af !important; color: #e0f2fe !important; }
      }
      /* Auto */
      .md-plugin-wrap[data-table-style="auto"] .md-preview th { background: #e2e8f0 !important; color: #334155 !important; border-color: #e2e8f0 !important; }
      .md-plugin-wrap[data-table-style="auto"] .md-preview td { color: #334155 !important; border-color: #e2e8f0 !important; }
      .md-plugin-wrap[data-table-style="auto"] .md-preview tbody tr:nth-child(even) td { background: #f1f5f9 !important; }
      .md-plugin-wrap[data-table-style="auto"] .md-preview tbody tr:nth-child(odd) td  { background: #ffffff !important; }
      .md-plugin-wrap[data-table-style="auto"] .md-preview tbody tr:hover td { background: #f8fafc !important; }
      @media (prefers-color-scheme: dark) {
        .md-plugin-wrap[data-table-style="auto"] .md-preview th { background: #334155 !important; color: #e2e8f0 !important; border-color: #475569 !important; }
        .md-plugin-wrap[data-table-style="auto"] .md-preview td { color: #e2e8f0 !important; border-color: #334155 !important; }
        .md-plugin-wrap[data-table-style="auto"] .md-preview tbody tr:nth-child(even) td { background: #1e293b !important; }
        .md-plugin-wrap[data-table-style="auto"] .md-preview tbody tr:nth-child(odd) td  { background: #0f172a !important; }
        .md-plugin-wrap[data-table-style="auto"] .md-preview tbody tr:hover td { background: #334155 !important; }
      }

      /* ── Mermaid ── */
      .md-preview .md-mermaid { overflow-x: auto; margin: 1em 0; }
    `);

    // ── Panel focus guard — keep real panel active so records open in the right place
    const onPanelFocused = (ev) => {
      const isPreview = ev.panel === this._previewPanel ||
                        ev.panel?.getElement()?.dataset?.mdPreviewPanel === "1";
      if (!isPreview) { this._lastActivePanel = ev.panel; return; }
      const active = document.activeElement;
      if (active && active.closest(".md-toolbar")) return;
      const target = this._lastActivePanel ||
                     this.ui.getPanels().find(p => p !== this._previewPanel && !p.isSidebar());
      if (target && typeof this.ui.setActivePanel === "function") this.ui.setActivePanel(target);
    };
    const focusHandlerId = this.events.on("panel.focused", onPanelFocused);
    this._unloadFns.push(() => this.events.off(focusHandlerId));

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
      const panels = this.ui.getPanels();
      const rightmost = panels.length > 0 ? panels[panels.length - 1] : null;
      const panel = await this.ui.createPanel({ afterPanel: rightmost || undefined });
      if (panel) panel.navigateToCustomType("md-preview-panel");
    };

    this._statusBarItem = this.ui.addStatusBarItem({
      label: "", icon: "article", tooltip: "Markdown Preview", onClick: togglePreviewPanel,
    });

    this._setStatusBarPreviewActive = (active) => {
      if (!this._statusBarItem) return;
      const el = this._statusBarItem.getElement?.();
      if (el) {
        if (active) el.classList.add("md-preview-status-active");
        else        el.classList.remove("md-preview-status-active");
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
      if (ev.panel === this._previewPanel) {
        const nav = ev.panel.getNavigation();
        if (nav && nav.type !== "md-preview-panel") {
          const target = this._lastActivePanel ||
                         this.ui.getPanels().find(p => p !== this._previewPanel && !p.isSidebar());
          if (target) target.navigateTo(nav);
          ev.panel.navigateToCustomType("md-preview-panel");
          return;
        }
      }
      const el = this._previewPanel.getElement();
      const fn = el ? el._mdRefresh : null;
      if (typeof fn === "function") fn();
      if (typeof this.ui.setActivePanel === "function") {
        const others = this.ui.getPanels().filter((p) => p !== this._previewPanel);
        if (others.length > 0) this.ui.setActivePanel(others[0]);
      }
    };

    const onLineItem = (ev) => {
      if (!this._previewPanel) return;
      const el = this._previewPanel.getElement();
      const rerender = el ? el._mdRerender : null;
      if (typeof rerender === "function") rerender(ev.recordGuid);
    };

    const navId      = this.events.on("panel.navigated",   onNavigated);
    const closedId   = this.events.on("panel.closed",      onPanelClosed);
    const updatedId  = this.events.on("lineitem.updated",  onLineItem);
    const createdId  = this.events.on("lineitem.created",  onLineItem);
    const deletedId  = this.events.on("lineitem.deleted",  onLineItem);

    this._unloadFns.push(
      () => this.events.off(navId),
      () => this.events.off(closedId),
      () => this.events.off(updatedId),
      () => this.events.off(createdId),
      () => this.events.off(deletedId),
      () => { if (this._statusBarItem?.remove) this._statusBarItem.remove(); }
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
  tryMount(60);

  function buildPanel(root) {
    root.innerHTML = "";
    root.dataset.mdPreviewPanel = "1";
    root.style.cssText += ";height:100%;display:flex;flex-direction:column;min-height:0;overflow:hidden;box-sizing:border-box;";

    // Propagate height up through host wrappers
    let _el = root.parentElement;
    while (_el && !_el.classList.contains("panel")) {
      _el.style.cssText += ";height:100%;min-height:0;flex:1;overflow:hidden;";
      _el = _el.parentElement;
    }

    // ── State
    let activeRecord       = null;
    let currentTableStyleId = "hc";
    let zoomLevel          = 1.0;
    const ZOOM_STEP = 0.1;
    const ZOOM_MIN  = 0.4;
    const ZOOM_MAX  = 2.5;

    // ── Wrap
    const wrap = document.createElement("div");
    wrap.className = "md-plugin-wrap";
    wrap.dataset.tableStyle = "hc";

    // ── Mermaid theme presets
    const MERMAID_THEME_PRESETS = {
      auto: null,
      "cb-blue-slate": {
        light: { "--md-mermaid-bg":"#f0f9ff","--md-mermaid-primary":"#bfdbfe","--md-mermaid-secondary":"#e0f2fe","--md-mermaid-tertiary":"#f0f9ff","--md-mermaid-line":"#1e40af","--md-mermaid-primary-text":"#1e3a5f","--md-mermaid-secondary-text":"#1e3a5f","--md-mermaid-actor-text":"#1e3a5f","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#1e3a5f","--md-mermaid-label-text":"#1e3a5f","--md-mermaid-actor-line":"#1e40af" },
        dark:  { "--md-mermaid-bg":"#051428","--md-mermaid-primary":"#1e3a5f","--md-mermaid-secondary":"#0c2340","--md-mermaid-tertiary":"#051428","--md-mermaid-line":"#56B4E9","--md-mermaid-primary-text":"#e0f2fe","--md-mermaid-secondary-text":"#e0f2fe","--md-mermaid-actor-text":"#e0f2fe","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#93c5fd","--md-mermaid-label-text":"#93c5fd","--md-mermaid-actor-line":"#56B4E9" }
      },
      "cb-orange-blue": {
        light: { "--md-mermaid-bg":"#fff7ed","--md-mermaid-primary":"#fed7aa","--md-mermaid-secondary":"#bfdbfe","--md-mermaid-tertiary":"#eff6ff","--md-mermaid-line":"#0072B2","--md-mermaid-primary-text":"#7c2d12","--md-mermaid-secondary-text":"#1e3a5f","--md-mermaid-actor-text":"#7c2d12","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#7c2d12","--md-mermaid-label-text":"#7c2d12","--md-mermaid-actor-line":"#0072B2" },
        dark:  { "--md-mermaid-bg":"#040e1a","--md-mermaid-primary":"#431407","--md-mermaid-secondary":"#0c2340","--md-mermaid-tertiary":"#051428","--md-mermaid-line":"#E69F00","--md-mermaid-primary-text":"#fed7aa","--md-mermaid-secondary-text":"#bfdbfe","--md-mermaid-actor-text":"#fed7aa","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#fbbf24","--md-mermaid-label-text":"#fbbf24","--md-mermaid-actor-line":"#E69F00" }
      },
      "cb-purple-amber": {
        light: { "--md-mermaid-bg":"#faf5ff","--md-mermaid-primary":"#e9d5ff","--md-mermaid-secondary":"#fef3c7","--md-mermaid-tertiary":"#fffbeb","--md-mermaid-line":"#7c3aed","--md-mermaid-primary-text":"#4c1d95","--md-mermaid-secondary-text":"#4c1d95","--md-mermaid-actor-text":"#4c1d95","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#4c1d95","--md-mermaid-label-text":"#78350f","--md-mermaid-actor-line":"#7c3aed" },
        dark:  { "--md-mermaid-bg":"#0f0520","--md-mermaid-primary":"#2e1065","--md-mermaid-secondary":"#451a03","--md-mermaid-tertiary":"#1a0533","--md-mermaid-line":"#a78bfa","--md-mermaid-primary-text":"#e9d5ff","--md-mermaid-secondary-text":"#fef3c7","--md-mermaid-actor-text":"#e9d5ff","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#c4b5fd","--md-mermaid-label-text":"#fde68a","--md-mermaid-actor-line":"#a78bfa" }
      },
      "cb-dark-blue": {
        light: { "--md-mermaid-bg":"#030d1a","--md-mermaid-primary":"#1e3a5f","--md-mermaid-secondary":"#0c2340","--md-mermaid-tertiary":"#051428","--md-mermaid-line":"#56B4E9","--md-mermaid-primary-text":"#e0f2fe","--md-mermaid-secondary-text":"#e0f2fe","--md-mermaid-actor-text":"#e0f2fe","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#93c5fd","--md-mermaid-label-text":"#93c5fd","--md-mermaid-actor-line":"#56B4E9" },
        dark:  { "--md-mermaid-bg":"#030d1a","--md-mermaid-primary":"#1e3a5f","--md-mermaid-secondary":"#0c2340","--md-mermaid-tertiary":"#051428","--md-mermaid-line":"#56B4E9","--md-mermaid-primary-text":"#e0f2fe","--md-mermaid-secondary-text":"#e0f2fe","--md-mermaid-actor-text":"#e0f2fe","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#93c5fd","--md-mermaid-label-text":"#93c5fd","--md-mermaid-actor-line":"#56B4E9" }
      },
      "cb-dark-amber": {
        light: { "--md-mermaid-bg":"#080604","--md-mermaid-primary":"#292524","--md-mermaid-secondary":"#1c1917","--md-mermaid-tertiary":"#0c0a09","--md-mermaid-line":"#E69F00","--md-mermaid-primary-text":"#fef3c7","--md-mermaid-secondary-text":"#fef3c7","--md-mermaid-actor-text":"#fef3c7","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#fbbf24","--md-mermaid-label-text":"#fbbf24","--md-mermaid-actor-line":"#E69F00" },
        dark:  { "--md-mermaid-bg":"#080604","--md-mermaid-primary":"#292524","--md-mermaid-secondary":"#1c1917","--md-mermaid-tertiary":"#0c0a09","--md-mermaid-line":"#E69F00","--md-mermaid-primary-text":"#fef3c7","--md-mermaid-secondary-text":"#fef3c7","--md-mermaid-actor-text":"#fef3c7","--md-mermaid-note-text":"#111827","--md-mermaid-signal-text":"#fbbf24","--md-mermaid-label-text":"#fbbf24","--md-mermaid-actor-line":"#E69F00" }
      }
    };

    function applyMermaidThemePreset(id) {
      const entry = MERMAID_THEME_PRESETS[id];
      let preset = null;
      if (entry && typeof entry === "object" && (entry.light || entry.dark)) {
        const prefersDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        preset = prefersDark ? (entry.dark || entry.light) : (entry.light || entry.dark);
      } else { preset = entry || null; }
      const keys = Object.keys(MERMAID_THEME_PRESETS["cb-blue-slate"].light);
      keys.forEach((name) => {
        if (!preset) wrap.style.removeProperty(name);
        else if (preset[name]) wrap.style.setProperty(name, preset[name]);
        else wrap.style.removeProperty(name);
      });
      _mermaidPromise = null;
      loadMermaid().catch(() => {});
      if (activeRecord) rerender(activeRecord.guid);
    }

    function applyTableStylePreset(id) { currentTableStyleId = id; wrap.dataset.tableStyle = id; }

    // ── Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "md-toolbar";

    const domTitle = document.createElement("div");
    domTitle.className = "md-toolbar-title";
    domTitle.textContent = "Open a record to preview";

    const right = document.createElement("div");
    right.className = "md-toolbar-right";

    // Table style select
    const tableStyleSelect = document.createElement("select");
    tableStyleSelect.className = "md-table-style-select";
    [
      { value: "hc",   label: "Table: Hi-Contrast" },
      { value: "mono", label: "Table: Monochrome" },
      { value: "blue", label: "Table: Blue Stripe" },
      { value: "auto", label: "Table: Auto" }
    ].forEach(({ value, label }) => {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      tableStyleSelect.appendChild(opt);
    });
    tableStyleSelect.value = "hc";
    tableStyleSelect.addEventListener("change", () => applyTableStylePreset(tableStyleSelect.value));

    // Mermaid theme select
    const themeSelect = document.createElement("select");
    themeSelect.className = "md-mermaid-theme-select";
    [
      { value: "auto",            label: "Mermaid: Auto" },
      { value: "cb-blue-slate",   label: "CB: Blue/Slate" },
      { value: "cb-orange-blue",  label: "CB: Orange/Blue" },
      { value: "cb-purple-amber", label: "CB: Purple/Amber" },
      { value: "cb-dark-blue",    label: "CB: Dark Blue" },
      { value: "cb-dark-amber",   label: "CB: Dark Amber" }
    ].forEach(({ value, label }) => {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      themeSelect.appendChild(opt);
    });
    themeSelect.value = "cb-blue-slate";
    themeSelect.addEventListener("change", () => applyMermaidThemePreset(themeSelect.value));

    // Restore focus to real panel after dropdown interaction
    const restoreFocusAfterDropdown = () => {
      setTimeout(() => {
        const target = plugin._lastActivePanel ||
                       plugin.ui.getPanels().find(p => p !== panel && !p.isSidebar());
        if (target && typeof plugin.ui.setActivePanel === "function") plugin.ui.setActivePanel(target);
      }, 50);
    };
    tableStyleSelect.addEventListener("change", restoreFocusAfterDropdown);
    tableStyleSelect.addEventListener("blur",   restoreFocusAfterDropdown);
    themeSelect.addEventListener("change",      restoreFocusAfterDropdown);
    themeSelect.addEventListener("blur",        restoreFocusAfterDropdown);

    // ── Zoom controls
    function applyZoom(level) {
      zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(level * 10) / 10));
      domPreview.style.zoom = zoomLevel;
      domZoomLabel.textContent = Math.round(zoomLevel * 100) + "%";
    }

    const domZoomOut = document.createElement("button");
    domZoomOut.className = "md-zoom-btn";
    domZoomOut.textContent = "−";
    domZoomOut.title = "Zoom out  (Ctrl + scroll)";
    domZoomOut.addEventListener("click", () => { applyZoom(zoomLevel - ZOOM_STEP); restoreFocusAfterDropdown(); });
    domZoomOut.addEventListener("blur",  restoreFocusAfterDropdown);

    const domZoomLabel = document.createElement("span");
    domZoomLabel.className = "md-zoom-label";
    domZoomLabel.textContent = "100%";
    domZoomLabel.title = "Double-click to reset to 100%";
    domZoomLabel.addEventListener("dblclick", () => { applyZoom(1.0); restoreFocusAfterDropdown(); });

    const domZoomIn = document.createElement("button");
    domZoomIn.className = "md-zoom-btn";
    domZoomIn.textContent = "+";
    domZoomIn.title = "Zoom in  (Ctrl + scroll)";
    domZoomIn.addEventListener("click", () => { applyZoom(zoomLevel + ZOOM_STEP); restoreFocusAfterDropdown(); });
    domZoomIn.addEventListener("blur",  restoreFocusAfterDropdown);
    
    // Word count pill
    const domWC = Object.assign(document.createElement("span"), {
      className: "md-pill", textContent: "0 words"
    });

    right.append(tableStyleSelect, themeSelect, domZoomOut, domZoomLabel, domZoomIn, domWC);
    toolbar.append(domTitle, right);

    // ── Preview area
    const domPreview = document.createElement("div");
    domPreview.className = "md-preview empty-state";
    domPreview.textContent = "Nothing to preview yet";
    domPreview.style.cssText = "flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:12px 16px 24px;box-sizing:border-box;width:100%;";

    // Ctrl/Cmd + scroll wheel to zoom
    domPreview.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      applyZoom(zoomLevel + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      restoreFocusAfterDropdown(); 
    }, { passive: false });

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

        const { markdown: mdWithPlaceholders, blocks: mermaidBlocks } = extractMermaidBlocks(markdown);

        const normalized = normalizeTableBoundaries(mdWithPlaceholders);
        const marked     = await loadMarked();
        const parse      = typeof marked.parse === "function" ? marked.parse : marked;
        const rawHtml    = typeof parse === "function" ? parse(normalized, { breaks: true, gfm: true }) : String(normalized);
        const DOMPurify  = await loadDOMPurify();
        const html       = DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml;

        domPreview.className = "md-preview";
        domPreview.innerHTML = html;

        domPreview.querySelectorAll("a[href]").forEach((a) => {
          if (a.getAttribute("href").indexOf("#") !== 0) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
        });

        if (mermaidBlocks.length > 0) {
          const mermaid = await loadMermaid();
          if (mermaid && typeof mermaid.render === "function") {
            const badNum      = /-?Infinity|NaN/;
            const placeholders = domPreview.querySelectorAll("[data-md-mermaid-id]");

            const renderOne = (container, code, index) => {
              let body = code.trim();
              if (!body) { container.textContent = "Empty Mermaid diagram."; return; }
              if (/^\s*flowchart\s+/.test(body)) body = body.replace(/^\s*flowchart\s+/, "graph ");
        
              const id = "md-mermaid-" + Date.now() + "-" + index;

              const handleSvg = (svg) => {
                let s2 = svg || "";
                const isPie = /^\s*pie\b/i.test(body);
                s2 = s2.replace(/\bviewBox="[^"]*"/g, (m) => (badNum.test(m) ? 'viewBox="0 0 450 450"' : m));
                if (isPie) {
                  s2 = s2.replace(/<svg\b([^>]*)>/i, (_, attrs) => {
                    attrs = attrs.replace(/\bwidth="[^"]*"/, 'width="100%"');
                    attrs = attrs.replace(/\bheight="[^"]*"/, 'height="auto"');
                    attrs = attrs.replace(/\bstyle="[^"]*"/, 'style=""');
                    return `<svg${attrs}>`;
                  });
                } else {
                  s2 = s2.replace(/\bwidth="[^"]*"/g,  (m) => (badNum.test(m) ? 'width="450"'  : m));
                  s2 = s2.replace(/\bheight="[^"]*"/g, (m) => (badNum.test(m) ? 'height="450"' : m));
                }
                container.innerHTML = s2;
                const svgEl = container.querySelector("svg");
                if (svgEl) {
                  const w = parseFloat(svgEl.getAttribute("width") || "");
                  const h = parseFloat(svgEl.getAttribute("height") || "");
                  if (!svgEl.getAttribute("viewBox") && isFinite(w) && isFinite(h) && w > 0 && h > 0) svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
                  if (isPie) {
                      svgEl.style.cssText = "width:100% !important;height:auto !important;display:block !important;";
                    } else {
                      svgEl.removeAttribute("width"); svgEl.removeAttribute("height");
                      if (!svgEl.getAttribute("preserveAspectRatio")) svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
                      svgEl.style.width = "100%"; svgEl.style.height = "auto"; svgEl.style.display = "block";
                    }
                }
                container.querySelectorAll("path").forEach((p) => {
                  const f = p.getAttribute("fill");
                  if (f && f !== "none") { p.style.fill = f; }
                  else { const c = window.getComputedStyle(p).fill; if (c && c !== "none" && c !== "rgba(0, 0, 0, 0)") p.style.fill = c; }
                });
                const _pd  = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
                const _alc = wrap.style.getPropertyValue("--md-mermaid-actor-line").trim() ||
                             (window.getComputedStyle(wrap).getPropertyValue("--md-mermaid-actor-line") || "").trim() ||
                             (_pd ? "#56B4E9" : "#334155");
                container.querySelectorAll(".actor-line, .actor-line line, .actor-line path").forEach((el) => {
                  el.style.setProperty("stroke", _alc, "important"); el.style.setProperty("stroke-width", "2", "important");
                });
                container.querySelectorAll("svg line").forEach((el) => {
                  const x1 = parseFloat(el.getAttribute("x1") || ""), x2 = parseFloat(el.getAttribute("x2") || "");
                  if (!isNaN(x1) && !isNaN(x2) && Math.abs(x1 - x2) < 2) {
                    el.style.setProperty("stroke", _alc, "important"); el.style.setProperty("stroke-width", "2", "important");
                  }
                });
                const _ps = _pd ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.25)";
                container.querySelectorAll(".pieCircle, path[class*='pie'], .slices path").forEach((el) => {
                  el.style.setProperty("stroke", _ps, "important"); el.style.setProperty("stroke-width", "2", "important");
                });
                container.querySelectorAll("svg path").forEach((el) => {
                  const d = el.getAttribute("d") || "", f = el.getAttribute("fill") || el.style.fill || "";
                  if (/[Aa]/.test(d) && /[Zz]/.test(d) && f && f !== "none") {
                    el.style.setProperty("stroke", _ps, "important"); el.style.setProperty("stroke-width", "2", "important");
                  }
                });
              };

              try {
                const result = mermaid.render(id, body);
                if (result && typeof result.then === "function") {
                  result.then((out) => handleSvg(out && (out.svg || out)))
                        .catch((e) => { container.textContent = "Diagram error: " + (e.message || "failed to render"); });
                } else {
                  const svg = result && typeof result === "object" && "svg" in result ? result.svg : result;
                  handleSvg(typeof svg === "string" ? svg : "");
                }
              } catch (e) { container.textContent = "Diagram error: " + (e.message || "failed to render"); }
            };

            placeholders.forEach((ph) => {
              const idx = parseInt(ph.getAttribute("data-md-mermaid-id") || "0", 10);
              const container = document.createElement("div");
              container.className = "md-mermaid";
              ph.replaceWith(container);
              renderOne(container, mermaidBlocks[idx] || "", idx);
            });
          }
        }

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

    async function refresh() {
      const panels = plugin.ui.getPanels().filter((p) => {
        const el = p.getElement();
        return !(el && el.dataset && el.dataset.mdPreviewPanel);
      });
      let record = null;
      for (let i = 0; i < panels.length; i++) { record = panels[i].getActiveRecord(); if (record) break; }
      const newGuid    = record ? record.guid : null;
      const activeGuid = activeRecord ? activeRecord.guid : null;
      if (newGuid !== activeGuid) await loadRecord(record ?? null);
    }

    async function rerender(changedRecordGuid) {
      if (!activeRecord || changedRecordGuid !== activeRecord.guid) return;
      const record = plugin.data.getRecord(activeRecord.guid);
      if (!record) return;
      const content = await getMarkdownContent(record);
      await renderPreview(content);
    }

    root._mdRefresh  = refresh;
    root._mdRerender = rerender;

    applyMermaidThemePreset("cb-blue-slate");
    refresh();

  } // end buildPanel
}