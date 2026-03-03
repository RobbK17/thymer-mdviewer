# Thymer Markdown Preview

A [Thymer](https://thymer.com) **App Plugin** that shows a read-only, live-rendered Markdown preview of the current record in a separate panel.

## Features

- **Status bar toggle** — “MD Preview” with icon in the app footer; click to open or close the preview panel.
- **Live preview** — Renders the active record as Markdown (GitHub Flavored Markdown, tables, code, etc.).
- **Auto-refresh** — Updates when you switch records or when content is edited.
- **Tables** — Headings and blocks are kept outside tables; header row and alternating row styling; selectable text.
- **Safe rendering** — HTML is sanitized with DOMPurify when available.
- **Dark mode** — Table and preview styling adapt to `prefers-color-scheme: dark` when using the included CSS.

## How to use

1. Install or enable the plugin in Thymer (Global Plugin).
2. Open a record whose content is (or includes) Markdown.
3. In the **status bar** (footer), click **MD Preview** to open the preview panel.
4. Click **MD Preview** again to close the panel. Closing the panel via the app’s close button also turns off the status bar highlight.

Preview content is selectable and copyable.

## Files

| File        | Purpose |
|------------|---------|
| `plugin.js` | Plugin logic: status bar item, panel, marked + DOMPurify loading, table normalization, render and refresh. |
| `plugin.css` | Styles for toolbar, preview area, markdown content, tables, dark mode. |
| `plugin.json` | Plugin manifest and collection config (name, views, fields, etc.). |

## Dependencies

The plugin loads from CDN at runtime:

- **marked** (v9) — Markdown to HTML.
- **DOMPurify** (v3) — HTML sanitization.

No build step is required; use the files as-is in Thymer’s plugin editor or your own build if you have one.

## License

Use and modify as needed for your workspace. Check Thymer’s plugin terms for distribution.
