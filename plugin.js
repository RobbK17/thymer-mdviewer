/**
 * Thymer Markdown Preview — AppPlugin
 *
 * Opens a read-only live preview of the current record in a new panel.
 * Auto-refreshes whenever the record's content changes.
 *
 * genvalue: 2026-03-03-13
 * version: 1.0.2
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

function isMermaidDebug() {
  try { return localStorage.getItem("mdPreviewMermaidDebug") === "1"; } catch (e) { return false; }
}

function loadMermaid() {
  if (_mermaidPromise) return _mermaidPromise;
  _mermaidPromise = new Promise((resolve) => {
    const initMermaid = () => {
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      // Use base theme so themeVariables fully control colors
      const theme = "base";
      const readCssVar = (name, fallback) => {
        try {
          const root = document.querySelector(".md-plugin-wrap") || document.body || document.documentElement;
          if (!root) return fallback;
          const value = window.getComputedStyle(root).getPropertyValue(name).trim();
          return value || fallback;
        } catch (e) {
          return fallback;
        }
      };
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme,
          themeVariables: {
            background: "transparent",
            primaryColor: readCssVar("--md-mermaid-primary", prefersDark ? "#1e293b" : "#e2e8f0"),
            primaryTextColor: readCssVar("--md-mermaid-primary-text", prefersDark ? "#e5e7eb" : "#020617"),
            secondaryColor: readCssVar("--md-mermaid-secondary", prefersDark ? "#0f172a" : "#f9fafb"),
            tertiaryColor: readCssVar("--md-mermaid-tertiary", prefersDark ? "#020617" : "#ffffff"),
            lineColor: readCssVar("--md-mermaid-line", prefersDark ? "#e5e7eb" : "#334155"),
            secondaryTextColor: readCssVar("--md-mermaid-secondary-text", prefersDark ? "#e5e7eb" : "#111827"),
            actorTextColor: readCssVar("--md-mermaid-actor-text", prefersDark ? "#f9fafb" : "#111827"),
            noteTextColor: readCssVar("--md-mermaid-note-text", prefersDark ? "#f9fafb" : "#111827")
          }
        });
      } catch (e) {
        // fall back silently; Mermaid will use its defaults
      }
      resolve(window.mermaid);
    };
    if (window.mermaid) {
      initMermaid();
      return;
    }
    const s = document.createElement("script");
    s.src = MERMAID_CDN;
    s.onload = () => {
      initMermaid();
    };
    s.onerror = () => {
      console.warn("[Markdown Preview] Could not load mermaid.js from CDN.");
      resolve(null);
    };
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

// Extract fenced ```mermaid``` blocks from raw markdown and replace them with
// lightweight placeholders that survive Markdown parsing.
function extractMermaidBlocks(markdown) {
  const blocks = [];
  if (!markdown || typeof markdown !== "string") {
    return { markdown: markdown || "", blocks };
  }

  const lines = markdown.split(/\r\n|\r|\n/);
  const outLines = [];
  let inBlock = false;
  let current = [];
  let blockIndex = 0;

  const isMermaidDeclarationLine = (s) =>
    /^\s*(graph|flowchart|pie(\s|$)|sequenceDiagram|gantt|stateDiagram|erDiagram|journey)\b/i.test(String(s || "").trim());

  const mermaidishLookahead = (startIndex, kind) => {
    const maxLookahead = 8;
    for (let j = startIndex; j < lines.length && j < startIndex + maxLookahead; j++) {
      const ln = lines[j];
      if (/^\s*```/.test(ln)) break;
      if (!ln || !ln.trim()) continue;

      if (kind === "pie") {
        // pie rows like: "Dogs" : 50  (quotes optional; spaces flexible)
        if (/^\s*("?[^"]+"?)\s*:\s*-?\d+(\.\d+)?\s*$/.test(ln)) return true;
        continue;
      }

      // generic Mermaid continuation signals (good enough to detect "diagram lines outside fence")
      if (/(-->|---|==>|->>|-->>|<-|subgraph\b|classDef\b|participant\b|actor\b|state\b|note\b)/i.test(ln)) return true;
      if (/\w+\s*--+\s*\w+/.test(ln)) return true;
      if (/[A-Za-z0-9_]+\s*\[.*\]\s*--?>\s*[A-Za-z0-9_]+/.test(ln)) return true;
    }
    return false;
  };

  const stripStrayFenceLines = (body) => {
    // If we had to treat a fence as content (host serialization quirk), remove those lines
    // before passing to Mermaid.
    return String(body || "").replace(/^\s*```[ \t]*\s*$/gm, "").trimEnd();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Allow optional leading indentation before the opening fence
    if (!inBlock && /^\s*```[ \t]*mermaid\b/i.test(line)) {
      // Start of a fenced mermaid block
      inBlock = true;
      current = [];
      continue;
    }

    // Only close on a fence at column 0 so indented "   ```" is treated as content (we strip it from body later)
    if (inBlock && /^```[ \t]*$/.test(line)) {
      // Host serialization quirk: sometimes we see:
      // ```mermaid
      // graph LR
      // ```
      // A --> B
      //
      // (i.e. close fence immediately after declaration, diagram lines outside the fence).
      // If it looks like that's what's happening, treat this fence as content and keep collecting.
      if (current.length === 1 && isMermaidDeclarationLine(current[0])) {
        const kind = /^\s*pie(\s|$)/i.test(current[0].trim()) ? "pie" : "other";
        if (mermaidishLookahead(i + 1, kind)) {
          current.push(line);
          continue;
        }
      }
      // End of current fenced block
      // Dedent: remove common leading whitespace (strip at most each line's own leading space)
      let bodyLines = current.slice();
      const nonEmpty = bodyLines.filter((l) => /\S/.test(l));
      let minIndent = Infinity;
      nonEmpty.forEach((l) => {
        const m = l.match(/^(\s*)\S/);
        if (m) minIndent = Math.min(minIndent, m[1].length);
      });
      if (isFinite(minIndent) && minIndent > 0) {
        bodyLines = bodyLines.map((l) => {
          const lead = (l.match(/^\s*/) || [""])[0].length;
          const strip = Math.min(minIndent, lead);
          return l.slice(strip);
        });
      }
      let body = bodyLines.join("\n").trimEnd();
      body = body.replace(/\n\s*```[ \t]*$/, "");
      body = stripStrayFenceLines(body);
      blocks.push(body);
      outLines.push(`<div data-md-mermaid-id="${blockIndex++}"></div>`);
      inBlock = false;
      current = [];
      continue;
    }

    if (inBlock) {
      current.push(line);
    } else {
      outLines.push(line);
    }
  }

  // If file ended while still in a block, keep the captured body
  if (inBlock) {
    let bodyLines = current.slice();
    const nonEmpty = bodyLines.filter((l) => /\S/.test(l));
    let minIndent = Infinity;
    nonEmpty.forEach((l) => {
      const m = l.match(/^(\s*)\S/);
      if (m) minIndent = Math.min(minIndent, m[1].length);
    });
    if (isFinite(minIndent) && minIndent > 0) {
      bodyLines = bodyLines.map((l) => {
        const lead = (l.match(/^\s*/) || [""])[0].length;
        const strip = Math.min(minIndent, lead);
        return l.slice(strip);
      });
    }
    let body = bodyLines.join("\n").trimEnd();
    body = body.replace(/\n\s*```[ \t]*$/, "");
    body = stripStrayFenceLines(body);
    blocks.push(body);
    outLines.push(`<div data-md-mermaid-id="${blockIndex++}"></div>`);
  }

  return { markdown: outLines.join("\n"), blocks };
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
    loadMermaid().catch(() => {});

    this._previewPanel = null;
    this._unloadFns = [];
    this._statusBarItem = null;

    this.ui.injectCSS(`
      .md-preview-status-active { font-weight: 600; background: var(--hover-bg, rgba(0,0,0,0.08)) !important; border-radius: 4px; }
      /* Keep preview panel on top when record panels would overlay it */
      :has(> [data-md-preview-panel="1"]) {
        position: relative !important;
        z-index: 10 !important;
      }
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
      .md-preview .md-mermaid { overflow-x: auto; margin: 1em 0; }
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
      const panels = this.ui.getPanels();
      const rightmost = panels.length > 0 ? panels[panels.length - 1] : null;
      const panel = await this.ui.createPanel({ afterPanel: rightmost || undefined });
      if (panel) {
        panel.navigateToCustomType("md-preview-panel");
      }
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

    // Mermaid theme presets (3 light + 3 dark)
    const MERMAID_THEME_PRESETS = {
      auto: null,
      "light-1": {
        "--md-mermaid-primary": "#e5e7eb",
        "--md-mermaid-secondary": "#f9fafb",
        "--md-mermaid-tertiary": "#ffffff",
        "--md-mermaid-line": "#334155",
        "--md-mermaid-primary-text": "#020617"
      },
      "light-2": {
        "--md-mermaid-primary": "#d1fae5",
        "--md-mermaid-secondary": "#ecfdf5",
        "--md-mermaid-tertiary": "#ffffff",
        "--md-mermaid-line": "#059669",
        "--md-mermaid-primary-text": "#064e3b"
      },
      "light-3": {
        "--md-mermaid-primary": "#fee2e2",
        "--md-mermaid-secondary": "#fef2f2",
        "--md-mermaid-tertiary": "#ffffff",
        "--md-mermaid-line": "#b91c1c",
        "--md-mermaid-primary-text": "#7f1d1d"
      },
      "dark-1": {
        "--md-mermaid-primary": "#1e293b",
        "--md-mermaid-secondary": "#020617",
        "--md-mermaid-tertiary": "#0f172a",
        "--md-mermaid-line": "#e5e7eb",
        "--md-mermaid-primary-text": "#f9fafb"
      },
      "dark-2": {
        "--md-mermaid-primary": "#334155",
        "--md-mermaid-secondary": "#020617",
        "--md-mermaid-tertiary": "#020617",
        "--md-mermaid-line": "#a5b4fc",
        "--md-mermaid-primary-text": "#e5e7eb"
      },
      "dark-3": {
        "--md-mermaid-primary": "#0f172a",
        "--md-mermaid-secondary": "#020617",
        "--md-mermaid-tertiary": "#020617",
        "--md-mermaid-line": "#22c55e",
        "--md-mermaid-primary-text": "#ecfeff"
      }
    };

    function applyMermaidThemePreset(id) {
      const preset = MERMAID_THEME_PRESETS[id] || null;
      const keys = Object.keys(MERMAID_THEME_PRESETS["light-1"]);
      keys.forEach((name) => {
        if (!preset) wrap.style.removeProperty(name);
        else if (preset[name]) wrap.style.setProperty(name, preset[name]);
        else wrap.style.removeProperty(name);
      });
      // Reinitialize Mermaid with updated theme variables and rerender
      _mermaidPromise = null;
      loadMermaid().catch(() => {});
      if (activeRecord) rerender(activeRecord.guid);
    }

    // Toolbar — title + word count + theme selector
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

    const themeSelect = document.createElement("select");
    themeSelect.className = "md-mermaid-theme-select";
    [
      { value: "auto", label: "Mermaid: Auto" },
      { value: "light-1", label: "Light 1" },
      { value: "light-2", label: "Light 2" },
      { value: "light-3", label: "Light 3" },
      { value: "dark-1", label: "Dark 1" },
      { value: "dark-2", label: "Dark 2" },
      { value: "dark-3", label: "Dark 3" }
    ].forEach(({ value, label }) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      themeSelect.appendChild(opt);
    });
    themeSelect.value = "auto";
    themeSelect.addEventListener("change", () => {
      applyMermaidThemePreset(themeSelect.value);
    });

    right.appendChild(themeSelect);
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

        // 1) Extract fenced ```mermaid``` blocks and replace them with placeholders
        const { markdown: mdWithPlaceholders, blocks: mermaidBlocks } = extractMermaidBlocks(markdown);

        if (isMermaidDebug()) {
          const debug = {
            rawMarkdownLength: markdown.length,
            rawMarkdownSnippet: markdown.slice(0, 2000),
            rawMarkdownJson: JSON.stringify(markdown.slice(0, 3000)),
            blockCount: mermaidBlocks.length,
            blocks: mermaidBlocks.map((body, i) => ({
              index: i,
              bodyLength: body.length,
              lineCount: body.split(/\n/).length,
              body,
              bodyJson: JSON.stringify(body),
              firstCharsHex: Array.from(body.slice(0, 80)).map((c) => c.charCodeAt(0).toString(16)).join(" ")
            }))
          };
          window.__mdPreviewMermaidDebugLast = debug;
          console.group("[Markdown Preview] Mermaid debug");
          console.log("Raw markdown length:", debug.rawMarkdownLength);
          console.log("Raw markdown snippet (first 2000 chars):", debug.rawMarkdownSnippet);
          console.log("Extracted blocks:", debug.blockCount);
          debug.blocks.forEach((b) => {
            console.group("Block " + b.index);
            console.log("Length:", b.bodyLength, "Lines:", b.lineCount);
            console.log("Body (string):", b.body);
            console.log("Body (JSON, shows \\n and \\r):", b.bodyJson);
            console.log("First 80 chars hex (check for \\r=0d):", b.firstCharsHex);
            console.groupEnd();
          });
          console.log("Copy full debug: JSON.stringify(window.__mdPreviewMermaidDebugLast, null, 2)");
          console.groupEnd();
        }

        // 2) Render the rest of the markdown normally
        const normalized = normalizeTableBoundaries(mdWithPlaceholders);
        const marked = await loadMarked();
        const parse = typeof marked.parse === "function" ? marked.parse : marked;
        const rawHtml = typeof parse === "function"
          ? parse(normalized, { breaks: true, gfm: true })
          : String(normalized);
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

        // 3) Render each Mermaid block into its placeholder
        if (mermaidBlocks.length > 0) {
          const mermaid = await loadMermaid();
          if (mermaid && typeof mermaid.render === "function") {
            const badNum = /-?Infinity|NaN/;
            const placeholders = domPreview.querySelectorAll("[data-md-mermaid-id]");

            const renderOne = (container, code, index) => {
              let body = code.trim();
              if (!body) {
                container.textContent = "Empty Mermaid diagram.";
                return;
              }
              // Normalize both syntaxes so Mermaid accepts them consistently
              if (/^\s*flowchart\s+/.test(body)) {
                body = body.replace(/^\s*flowchart\s+/, "graph ");
              }
              if (isMermaidDebug()) {
                if (window.__mdPreviewMermaidDebugLast) {
                  window.__mdPreviewMermaidDebugLast.lastBodySentToMermaid = body;
                  window.__mdPreviewMermaidDebugLast.lastBodyJson = JSON.stringify(body);
                }
                console.log("[Markdown Preview] Mermaid block " + index + " body sent to render:", JSON.stringify(body));
              }
              const id = "md-mermaid-" + Date.now() + "-" + index;

              const handleSvg = (svg) => {
                let sanitized = svg || "";
                sanitized = sanitized.replace(/\bviewBox="[^"]*"/g, (m) => (badNum.test(m) ? 'viewBox="0 0 450 450"' : m));
                sanitized = sanitized.replace(/\bwidth="[^"]*"/g, (m) => (badNum.test(m) ? 'width="450"' : m));
                sanitized = sanitized.replace(/\bheight="[^"]*"/g, (m) => (badNum.test(m) ? 'height="450"' : m));
                container.innerHTML = sanitized;
                const svgEl = container.querySelector("svg");
                if (svgEl) {
                  const w = parseFloat(svgEl.getAttribute("width") || "");
                  const h = parseFloat(svgEl.getAttribute("height") || "");
                  if (!svgEl.getAttribute("viewBox") && isFinite(w) && isFinite(h) && w > 0 && h > 0) {
                    svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
                  }
                  svgEl.removeAttribute("width");
                  svgEl.removeAttribute("height");
                  if (!svgEl.getAttribute("preserveAspectRatio")) {
                    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
                  }
                  svgEl.style.width = "100%";
                  svgEl.style.height = "100%";
                  svgEl.style.display = "block";
                }
                container.querySelectorAll("path").forEach((p) => {
                  const f = p.getAttribute("fill");
                  if (f && f !== "none") {
                    p.style.fill = f;
                  } else {
                    const computed = window.getComputedStyle(p).fill;
                    if (computed && computed !== "none" && computed !== "rgba(0, 0, 0, 0)") {
                      p.style.fill = computed;
                    }
                  }
                });
              };

              try {
                const result = mermaid.render(id, body);
                if (result && typeof result.then === "function") {
                  result
                    .then((out) => handleSvg(out && (out.svg || out)))
                    .catch((e) => {
                      console.warn("[Markdown Preview] Mermaid render error", e);
                      container.textContent = "Diagram error: " + (e.message || "failed to render");
                    });
                } else {
                  const svg = result && typeof result === "object" && "svg" in result ? result.svg : result;
                  handleSvg(typeof svg === "string" ? svg : "");
                }
              } catch (e) {
                console.warn("[Markdown Preview] Mermaid render error", e);
                container.textContent = "Diagram error: " + (e.message || "failed to render");
              }
            };

            placeholders.forEach((ph) => {
              const idx = parseInt(ph.getAttribute("data-md-mermaid-id") || "0", 10);
              const code = mermaidBlocks[idx] || "";
              const container = document.createElement("div");
              container.className = "md-mermaid";
              ph.replaceWith(container);
              renderOne(container, code, idx);
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