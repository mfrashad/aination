# Page contract for index.html (published as a claude.ai Artifact)

- The file is wrapped in a `<!doctype html><html><head>..</head><body>` skeleton at publish time. Write page
  content directly: NO `<!DOCTYPE>`, `<html>`, `<head>` or `<body>` tags. Start the file with:
  `<title>AI Nation</title>`, `<meta name="claude:viewport-fit-sides" content="cover">`,
  the Google Fonts `<link>`, then `<style>`.
- For local testing only, a harness page may wrap it; the agent can test by loading a temp wrapper file that
  inlines index.html into a full document with `<meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">`.
- External resources: scripts only from cdnjs.cloudflare.com (exact pinned versions); stylesheets only from
  fonts.googleapis.com. Everything else is blocked silently. Local sibling files (`engine.js`, `store.js`,
  `ui.js`) load by relative URL. Prefer no libraries at all.
- No `alert/confirm/prompt`, no `window.print`, no downloads, no `<a download>`, no iframes, no `window.open`.
- localStorage may throw or be empty: wrap in try/catch, page must work without it.
- Toggle visibility with `el.hidden`, not `style.display`.
- Side gutter on the outer wrapper: `padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right:
  max(16px, env(safe-area-inset-right, 0px));` and vertical padding via `padding-block`. Keep the `:root`
  padding the skeleton sets. A sticky header uses `top: env(safe-area-inset-top, 0px)`.
- Must work at 400 px width with no horizontal page scroll. Flex/grid children holding text get `min-width:0`.
  Only tables/code may scroll sideways inside their own `overflow-x:auto` box.
- Theme: dark-first. Every colour is a token first defined on bare `:root` (dark values, plus
  `color-scheme: dark`). Light values under `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {...; color-scheme: light} }`
  and again under `:root[data-theme="light"] {...; color-scheme: light}`. `body` sets an explicit token
  background. No component rule uses a literal colour. Canvas drawing must read colours from the CSS tokens
  (getComputedStyle) and redraw when the theme changes.
- Runtime capabilities: `window.claude` may be absent (local testing). Access only via
  `const db = await window.claude?.use?.("db")`; `null`/undefined means unavailable. Resolution is async and
  may take up to 10 s; never block first paint on it.
- Visible keyboard focus; respect `prefers-reduced-motion`; stable `id` on every form control.
- Copy: plain, short sentences. No emoji as icons. No em dashes.
