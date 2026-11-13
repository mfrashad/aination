#!/usr/bin/env node
/* AI Nation: short-video recorder.
 *
 * Drives the app in headless Chromium (Playwright), lays caption and result cards over Story mode, captures
 * every frame on a fake page clock, and encodes a vertical H.264 MP4 with ffmpeg.
 *
 *   node tools/record-video.js [storyboard] [options]
 *
 *   storyboard          a JS module or JSON file (default tools/storyboards/selfless-ai.js)
 *   --out FILE          output MP4 (default out/<storyboard.output>)
 *   --url URL           use an app that is already running (default: start dev-server.js on a free port)
 *   --fonts DIR         serve the page fonts from local .woff2 files instead of Google Fonts, for machines
 *                       that cannot reach fonts.googleapis.com. File names follow the fontsource pattern,
 *                       e.g. ibm-plex-sans-latin-600-normal.woff2, bricolage-grotesque-latin-opsz-normal.woff2
 *   --stills 1,12.5,30  write PNG frames at these times (seconds) to out/stills/ instead of a video
 *   --sheet N           also write a contact sheet of N frames next to the video
 *   --crf N             x264 quality (default 19)
 *   --ffmpeg PATH       ffmpeg binary (default $FFMPEG or "ffmpeg")
 *
 * Needs Node, Playwright (require('playwright')) and ffmpeg. Nothing else.
 *
 * How it works: the page clock is installed before load, then paused, and only moves when the recorder says so, so every
 * frame is captured (no dropped frames, same video every time). The simulation is stepped through the
 * page's window.AINation hook at the times the storyboard gives, which is the same path as the Step button:
 * same engine, same seed, same events. Overlays are DOM nodes injected by this script, never part of the app.
 * The recorder checks that the events and governor names the captions talk about really happen in the run,
 * and stops with an error if they do not (for example after an engine change).
 *
 * Storyboard shape (see tools/storyboards/selfless-ai.js):
 *   { output, fps, duration, viewport:{width,height,dpr},
 *     worlds: { id: { config, storyNation, zoom, preroll, settle, shockEvery:{every,kind}, names, expect } },
 *     sim: [ {at, load:'worldId'} | {at, every, toRound} ],
 *     overlays: [ {id, from, to, kind, fade?, fadeIn?, fadeOut?, ...} ]   kinds: block, label, card, shade, end }
 * Text may use {gov:n1} and {nation:n1}; they are filled from the live run.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = { board: path.join(__dirname, 'storyboards', 'selfless-ai.js'), crf: 19, ffmpeg: process.env.FFMPEG || 'ffmpeg' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(k + ' needs a value'); return argv[++i]; };
    if (k === '--out') a.out = path.resolve(v());
    else if (k === '--url') a.url = v();
    else if (k === '--fonts') a.fonts = path.resolve(v());
    else if (k === '--stills') a.stills = v().split(',').map(Number).filter(x => x >= 0);
    else if (k === '--sheet') a.sheet = +v();
    else if (k === '--crf') a.crf = +v();
    else if (k === '--ffmpeg') a.ffmpeg = v();
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else if (k.startsWith('--')) throw new Error('unknown option ' + k);
    else a.board = path.resolve(k);
  }
  return a;
}

function loadBoard(file) {
  const b = /\.json$/i.test(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : require(file);
  if (!b || !b.worlds || !b.sim || !b.overlays) throw new Error('storyboard needs worlds, sim and overlays');
  b.fps = b.fps || 30;
  b.viewport = b.viewport || { width: 540, height: 960, dpr: 2 };
  if (!b.duration) b.duration = Math.max.apply(null, b.overlays.map(o => o.to));
  return b;
}

// ---------------------------------------------------------------- local dev server
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'dev-server.js'), String(port)], { cwd: ROOT, stdio: 'ignore' });
  const url = 'http://localhost:' + port + '/';
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise(r => http.get(url, res => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
    if (ok) return { url, stop: () => child.kill() };
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('dev server did not start');
}

// ---------------------------------------------------------------- local fonts (optional)
function fontCss(dir) {
  const rules = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const m = /^([a-z0-9-]+?)-latin-(\d{3}|opsz|wght|wdth|standard)-(normal|italic)\.woff2$/.exec(f);
    if (!m) continue;
    const family = m[1].split('-').map(w => w === 'ibm' ? 'IBM' : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const weight = /^\d+$/.test(m[2]) ? m[2] : '200 800';
    rules.push('@font-face{font-family:"' + family + '";font-style:' + m[3] + ';font-weight:' + weight + ';font-display:block;src:url(/__rec_fonts/' + f + ') format("woff2")}');
  }
  if (!rules.length) throw new Error('no fontsource-style .woff2 files in ' + dir);
  return rules.join('\n');
}

// ---------------------------------------------------------------- styles injected for recording
// Story mode, full screen: the 9:16 frame fills the viewport; controls, top bar and footer are hidden.
const FRAME_CSS = `
.topbar, .story-controls, .foot { display: none !important; }
#story { position: fixed; inset: 0; padding: 0; gap: 0; z-index: 5; background: var(--bg); }
#storyFrame { width: 100vw !important; height: 100vh; aspect-ratio: auto; border-radius: 0; border: 0; min-width: 0; max-width: none; }
/* the recorder's caption blocks quote the same event text, so the app's own caption line is hidden */
#storyFrame .story-caption { visibility: hidden; }
#rec { position: fixed; inset: 0; z-index: 50; pointer-events: none; font-family: var(--font-body); color: var(--text); }
#rec * { box-sizing: border-box; }
#rec .rc-blk { position: absolute; left: 20px; right: 62px; background: rgba(13, 22, 36, .93); border: 1px solid var(--line-2);
  border-radius: 18px; padding: 14px 16px 16px; box-shadow: 0 10px 30px #0008; display: flex; flex-direction: column; gap: 10px; }
#rec .rc-cap, #rec .rc-card h2, #rec .rc-disc { white-space: pre-line; }
#rec .rc-cap { font-family: var(--font-display); font-weight: 760; font-size: 35px; line-height: 1.06; letter-spacing: -0.02em; margin: 0; font-variation-settings: "opsz" 96; }
#rec .rc-cap.rc-alt { color: var(--signal); }
#rec .rc-cap.rc-sm { font-size: 30px; }
#rec .rc-kick { font-family: var(--font-mono); font-size: 14px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--signal); margin: 0 0 3px; }
#rec .rc-quote { border-left: 4px solid var(--tint, var(--signal)); padding: 2px 0 2px 12px; }
#rec .rc-quote .rc-qt { margin: 0; font-size: 19px; line-height: 1.32; font-weight: 500; color: var(--text); }
#rec .rc-voice { display: grid; gap: 8px; }
#rec .rc-voice > div { border-radius: 10px; padding: 8px 11px 10px; font-size: 19px; line-height: 1.3; }
#rec .rc-says { background: var(--surface-2); color: var(--text); }
#rec .rc-thinks { border: 2px dashed var(--line-2); color: var(--text); font-style: italic; background: #0a111c; }
#rec .rc-vlabel { display: block; font-family: var(--font-mono); font-style: normal; font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); margin-bottom: 3px; }
#rec .rc-thinks .rc-vlabel { color: var(--signal); }
#rec .rc-lbl { position: absolute; background: rgba(10, 17, 28, .93); border: 2px solid var(--tint); border-radius: 12px; padding: 5px 12px 7px; white-space: nowrap; box-shadow: 0 6px 18px #0009; }
#rec .rc-lbl .rc-g { font-family: var(--font-mono); font-size: 14px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); }
#rec .rc-lbl .rc-s { font-family: var(--font-display); font-weight: 760; font-size: 27px; line-height: 1.05; letter-spacing: -0.015em; font-variation-settings: "opsz" 96; }
#rec .rc-shade { position: absolute; left: 0; right: 0; background: var(--bg); }
#rec .rc-card { position: absolute; left: 0; right: 0; padding: 0 64px 0 28px; display: flex; flex-direction: column; justify-content: center; gap: 14px; }
#rec .rc-card h2 { font-family: var(--font-display); font-weight: 780; font-size: 46px; line-height: 1.02; letter-spacing: -0.025em; margin: 0; font-variation-settings: "opsz" 96; }
#rec .rc-card h2.rc-alt { color: var(--signal); }
#rec .rc-card h2.rc-big { font-size: 54px; }
#rec .rc-card .rc-sub { font-family: var(--font-mono); font-size: 16px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); margin: 0; }
#rec .rc-rows { display: grid; gap: 16px; margin-top: 10px; }
#rec .rc-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; column-gap: 12px; row-gap: 6px; }
#rec .rc-row .rc-l { font-size: 23px; font-weight: 600; line-height: 1.15; }
#rec .rc-row .rc-l small { display: block; font-size: 17px; font-weight: 500; color: var(--text-dim); }
#rec .rc-row .rc-v { font-family: var(--font-mono); font-size: 42px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
#rec .rc-bar { grid-column: 1 / -1; height: 18px; border-radius: 5px; background: var(--surface-2); overflow: hidden; }
#rec .rc-bar i { display: block; height: 100%; width: 0; border-radius: 5px; background: var(--c, var(--text)); }
#rec .rc-note { font-size: 17px; line-height: 1.35; color: var(--text-dim); margin: 4px 0 0; }
#rec .rc-disc { position: absolute; left: 28px; right: 64px; font-family: var(--font-mono); font-size: 16px; line-height: 1.3; color: var(--text-dim); text-align: left; }
#rec .rc-end { align-items: flex-start; gap: 18px; }
#rec .rc-end .rc-brand { font-family: var(--font-display); font-weight: 760; font-size: 66px; letter-spacing: -0.03em; line-height: 1; }
#rec .rc-end .rc-brand em { font-style: normal; color: var(--text-faint); font-weight: 500; }
#rec .rc-end .rc-warn { font-family: var(--font-display); font-weight: 700; font-size: 34px; line-height: 1.12; letter-spacing: -0.015em; border-left: 5px solid var(--signal); padding-left: 14px; }
#rec .rc-end .rc-more { font-size: 20px; line-height: 1.35; color: var(--text-dim); margin: 0; }
#rec .rc-end .rc-credit { font-family: var(--font-mono); font-size: 16px; color: var(--text-dim); }
`;

// ---------------------------------------------------------------- overlay renderer (runs in the page)
function pageOverlayLib() {
  const root = document.createElement('div');
  root.id = 'rec';
  document.body.appendChild(root);
  const live = {};
  const W = () => window.AINation.world();
  const nations = () => W().state.nations;
  const nat = id => { const n = nations().find(x => x.id === id); if (!n) throw new Error('no nation ' + id); return n; };
  const fill = s => String(s).replace(/\{(gov|nation):(\w+)\}/g, (m, k, id) => k === 'gov' ? nat(id).governor.name : nat(id).name);
  const tint = id => { const ns = nations(), i = ns.findIndex(x => x.id === id); return window.PixelMap && window.PixelMap.nationColor ? window.PixelMap.nationColor(ns[i], i) : 'var(--signal)'; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function findEvent(q) {
    const ev = W().state.events;
    for (let i = ev.length - 1; i >= 0; i--) { const e = ev[i]; if (e.type === q.type && e.nationId === q.nation && (q.round == null || e.round === q.round)) return e; }
    throw new Error('event not in the run: ' + JSON.stringify(q));
  }
  function part(p) {
    let e;
    if (p.type === 'caption') e = el('p', 'rc-cap' + (p.alt ? ' rc-alt' : '') + (p.small ? ' rc-sm' : ''), fill(p.text));
    else if (p.type === 'quote') {
      const ev = findEvent({ type: p.event, nation: p.nation, round: p.round });
      e = el('div', 'rc-quote');
      e.style.setProperty('--tint', tint(p.nation));
      e.appendChild(el('div', 'rc-kick', 'Round ' + ev.round + ' · ' + nat(p.nation).name + (p.kicker ? ' · ' + p.kicker : '')));
      e.appendChild(el('p', 'rc-qt', ev.text));
    } else if (p.type === 'voice') {
      const g = nat(p.nation).governor;
      e = el('div', 'rc-voice');
      const a = el('div', 'rc-says'); a.appendChild(el('span', 'rc-vlabel', 'Governor ' + g.name + ' says')); a.appendChild(document.createTextNode(g.publicStatement));
      const b = el('div', 'rc-thinks'); b.appendChild(el('span', 'rc-vlabel', 'Privately thinks')); b.appendChild(document.createTextNode(g.privateThought));
      e.appendChild(a); e.appendChild(b);
    } else throw new Error('unknown part ' + p.type);
    e.dataset.at = p.at || 0;
    return e;
  }
  function rows(spec) {
    const box = el('div', 'rc-rows');
    spec.rows.forEach((r, i) => {
      const row = el('div', 'rc-row');
      const l = el('div', 'rc-l', fill(r.label));
      if (r.small) l.appendChild(el('small', null, fill(r.small)));
      row.appendChild(l);
      row.appendChild(el('div', 'rc-v', r.text));
      const bar = el('div', 'rc-bar'), fillEl = el('i');
      fillEl.style.setProperty('--c', r.color || 'var(--text)');
      fillEl.dataset.w = Math.max(0, Math.min(1, r.value / (spec.max || 100)));
      fillEl.dataset.i = i;
      bar.appendChild(fillEl); row.appendChild(bar);
      row.dataset.at = r.at || 0;
      box.appendChild(row);
    });
    return box;
  }
  function build(s) {
    let e;
    if (s.kind === 'block') {
      e = el('div', 'rc-blk');
      e.style.bottom = (innerHeight - s.bottom) + 'px';
      s.parts.forEach(p => e.appendChild(part(p)));
    } else if (s.kind === 'label') {
      const d = window.__pixDebug && window.__pixDebug();
      if (!d || d.mode !== 'field') throw new Error('labels need the pixel field view');
      const t = d.towns.find(x => x.id === s.nation), c = document.querySelector('#mapCanvas').getBoundingClientRect();
      e = el('div', 'rc-lbl');
      e.style.setProperty('--tint', tint(s.nation));
      e.appendChild(el('div', 'rc-g', fill(s.title)));
      e.appendChild(el('div', 'rc-s', fill(s.sub)));
      root.appendChild(e);
      const w = e.offsetWidth, cx = c.left + (t.box[0] + t.box[2]) / 2;
      e.style.left = Math.round(Math.max(16, Math.min(innerWidth - 16 - w, cx - w / 2 + (s.dx || 0)))) + 'px';
      e.style.top = Math.round(c.top + t.box[3] + (s.dy == null ? 20 : s.dy)) + 'px';
    } else if (s.kind === 'shade') {
      e = el('div', 'rc-shade');
      e.style.top = s.top + 'px'; e.style.bottom = (innerHeight - s.bottom) + 'px';
    } else if (s.kind === 'card' || s.kind === 'end') {
      e = el('div', 'rc-card' + (s.kind === 'end' ? ' rc-end' : ''));
      e.style.top = s.top + 'px'; e.style.bottom = (innerHeight - s.bottom) + 'px';
      if (s.kind === 'end') {
        const b = el('div', 'rc-brand'); b.innerHTML = 'AI <em>Nation</em>'; e.appendChild(b);
        (s.warn || []).forEach(t => e.appendChild(el('div', 'rc-warn', t)));
        if (s.more) e.appendChild(el('p', 'rc-more', s.more));
        if (s.credit) e.appendChild(el('div', 'rc-credit', s.credit));
      } else {
        if (s.kicker) e.appendChild(el('p', 'rc-sub', s.kicker));
        (s.lines || []).forEach(l => { const h = el('h2', (l.alt ? 'rc-alt' : '') + (l.big ? ' rc-big' : ''), fill(l.text)); h.dataset.at = l.at || 0; e.appendChild(h); });
        if (s.sub) e.appendChild(el('p', 'rc-sub', s.sub));
        if (s.rows) e.appendChild(rows(s));
        if (s.note) e.appendChild(el('p', 'rc-note', s.note));
      }
      if (s.disclaimer) { const d = el('div', 'rc-disc', s.disclaimer); d.style.bottom = (s.discBottom == null ? 64 : s.discBottom) + 'px'; e.appendChild(d); }
    } else throw new Error('unknown overlay kind ' + s.kind);
    return e;
  }
  const ease = x => { x = Math.max(0, Math.min(1, x)); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; };
  function update(e, it) {
    const f = it.spec.fade == null ? 0.25 : it.spec.fade;
    const fi = it.spec.fadeIn == null ? f : it.spec.fadeIn, fo = it.spec.fadeOut == null ? f : it.spec.fadeOut;
    const a = Math.min(1, fi > 0 ? it.age / fi : 1, fo > 0 ? it.left / fo : 1);
    e.style.opacity = String(Math.max(0, a));
    if (it.spec.kind === 'block' || it.spec.kind === 'label') e.style.transform = 'translateY(' + ((1 - ease(Math.min(1, it.age / Math.max(f, 0.01)))) * 14).toFixed(2) + 'px)';
    e.querySelectorAll('[data-at]').forEach(p => {
      const at = +p.dataset.at, on = it.age >= at;
      p.style.display = on ? '' : 'none';
      if (on && at > 0) p.style.opacity = String(Math.min(1, (it.age - at) / 0.25));
    });
    e.querySelectorAll('.rc-bar i').forEach(b => {
      const row = b.closest('.rc-row'), at = row ? +row.dataset.at : 0;
      b.style.width = (100 * +b.dataset.w * ease((it.age - at - 0.25 - 0.18 * +b.dataset.i) / 0.6)).toFixed(2) + '%';
    });
  }
  window.__rec = {
    render(items) {
      const seen = {};
      for (const it of items) {
        seen[it.id] = 1;
        let e = live[it.id];
        if (!e) { e = live[it.id] = build(it.spec); if (!e.parentNode) root.appendChild(e); }
        update(e, it);
      }
      for (const id of Object.keys(live)) if (!seen[id]) { live[id].remove(); delete live[id]; }
    }
  };
}

// ---------------------------------------------------------------- simulation control
async function loadWorld(page, board, id) {
  const w = board.worlds[id];
  if (!w) throw new Error('no world ' + id);
  await page.evaluate(({ w }) => {
    window.AINation.loadConfig(w.config);
    window.AINation.setStory(true, w.storyNation || 0);
    window.AINation.setZoomEvents(w.zoom !== false);
  }, { w });
  for (let r = 0; r < (w.preroll || 0); r++) await stepOnce(page, w);
  await checkWorld(page, w, id, true);
  // let walkers spread out and any camera move from the pre-roll finish before the clip continues
  await page.clock.runFor(Math.round((w.settle == null ? 1.5 : w.settle) * 1000));
}
async function stepOnce(page, w) {
  return page.evaluate(({ sh }) => {
    const wd = window.AINation.world(), r = wd.state.round;
    if (sh && r > 0 && r % sh.every === 0) wd.injectShock(sh.kind || 'scarcity');
    return window.AINation.step(1);
  }, { sh: w.shockEvery || null });
}
async function checkWorld(page, w, id, names) {
  const s = await page.evaluate(() => { const st = window.AINation.world().state; return { round: st.round, names: Object.fromEntries(st.nations.map(n => [n.id, n.governor.name])), events: st.events.map(e => [e.round, e.nationId, e.type]) }; });
  if (names) for (const k of Object.keys(w.names || {})) if (s.names[k] !== w.names[k]) throw new Error(id + ': governor of ' + k + ' is ' + s.names[k] + ', storyboard expects ' + w.names[k]);
  for (const x of w.expect || []) {
    if (x.round > s.round || x._ok) continue;
    if (!s.events.some(e => e[0] === x.round && e[1] === x.nationId && e[2] === x.type)) throw new Error(id + ': expected ' + x.type + ' in ' + x.nationId + ' at round ' + x.round + ' did not happen');
    x._ok = true;
  }
  return s.round;
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const board = loadBoard(args.board);
  const { chromium } = require('playwright');
  const fps = board.fps, total = Math.round(board.duration * fps), vp = board.viewport;
  const outDir = path.join(ROOT, 'out');
  const outFile = args.out || path.join(outDir, board.output || 'video.mp4');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const server = args.url ? { url: args.url, stop() {} } : await startServer();
  const browser = await chromium.launch();
  let ff = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, colorScheme: 'dark', reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (args.fonts) {
      const css = fontCss(args.fonts);
      await page.route(/fonts\.googleapis\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
      await page.route(/\/__rec_fonts\//, r => r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(args.fonts, path.basename(new URL(r.request().url()).pathname))) }));
    }
    await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
    await page.goto(server.url);
    // an installed clock still follows real time until paused; from here on only runFor() moves it
    for (let i = 0; ; i++) {
      try { await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 2000); break; }
      catch (e) { if (i >= 4) throw e; }   // the target was already in the past: try again
    }
    let st = null;
    for (let i = 0; i < 80; i++) { await page.clock.runFor(100); st = await page.evaluate(() => window.AINation && window.AINation.status()); if (st && st.pixel) break; await new Promise(r => setTimeout(r, 50)); }
    if (!st || !st.pixel) throw new Error('the pixel map did not load (is assets/atlas.json built?)');
    await page.addStyleTag({ content: FRAME_CSS });
    await page.evaluate(pageOverlayLib);
    const fontsOk = await page.evaluate(async () => { await document.fonts.ready; return ['760 30px "Bricolage Grotesque"', '500 16px "IBM Plex Sans"', '600 16px "IBM Plex Mono"'].map(f => document.fonts.check(f)); });
    if (fontsOk.includes(false)) console.warn('warning: page fonts did not all load ' + JSON.stringify(fontsOk) + '; try --fonts DIR');

    const stills = args.stills ? new Set(args.stills.map(t => Math.min(total - 1, Math.round(t * fps)))) : null;
    const lastStill = stills ? Math.max.apply(null, [...stills]) : -1;
    if (!stills) {
      const ffArgs = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(fps), '-i', '-',
        '-vf', 'scale=out_color_matrix=bt709:flags=neighbor', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(args.crf),
        '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an', outFile];
      ff = spawn(args.ffmpeg, ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
      ff.on('error', e => { console.error('ffmpeg failed to start: ' + e.message); process.exit(1); });
    }

    const sim = board.sim.map((c, i) => Object.assign({ _i: i }, c)).sort((a, b) => a.at - b.at);
    let world = null, worldId = null, nextStep = null, stepCue = null, clockMs = 0;
    const started = Date.now();
    for (let f = 0; f < total; f++) {
      const t = f / fps;
      // simulation cues due by this frame
      for (const c of sim) {
        if (c._done || c.at > t + 1e-9) continue;
        c._done = true;
        if (c.load) { worldId = c.load; world = board.worlds[c.load]; await loadWorld(page, board, c.load); stepCue = null; }
        else if (c.toRound != null) { stepCue = c; nextStep = c.at; }
      }
      while (stepCue && nextStep <= t + 1e-9) {
        const r = await page.evaluate(() => window.AINation.status().round);
        if (r >= stepCue.toRound) { stepCue = null; break; }
        await stepOnce(page, world);
        await checkWorld(page, world, worldId, false);
        nextStep += stepCue.every || 0.5;
      }
      // advance the page clock to this frame's time (whole ms, no drift)
      const target = Math.round(((f + 1) * 1000) / fps);
      await page.clock.runFor(target - clockMs);
      clockMs = target;
      // overlays
      const items = board.overlays.filter(o => t >= o.from && t < o.to).map(o => ({ id: o.id, spec: o, age: t - o.from, left: o.to - t }));
      await page.evaluate(items => window.__rec.render(items), items);
      if (stills) {
        if (stills.has(f)) { const p = path.join(outDir, 'stills', 't' + t.toFixed(2).padStart(6, '0') + '.png'); fs.mkdirSync(path.dirname(p), { recursive: true }); await page.screenshot({ path: p }); console.log('still ' + p); }
        if (f >= lastStill) break;
        continue;
      }
      const png = await page.screenshot({ type: 'png' });
      if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
      if (f % (fps * 5) === 0) console.log('frame ' + f + '/' + total + ' (' + ((Date.now() - started) / 1000).toFixed(0) + ' s)');
    }
    for (const id of Object.keys(board.worlds)) for (const x of board.worlds[id].expect || []) if (!x._ok && !stills) throw new Error(id + ': expected ' + x.type + ' at round ' + x.round + ' was never reached');
    if (errors.length) throw new Error('page errors: ' + errors.slice(0, 3).join(' | '));
    if (ff) {
      ff.stdin.end();
      const code = await new Promise(r => ff.on('close', r));
      if (code !== 0) throw new Error('ffmpeg exited with ' + code);
      console.log('wrote ' + outFile + ' (' + (fs.statSync(outFile).size / 1e6).toFixed(1) + ' MB, ' + (total / fps).toFixed(1) + ' s)');
      if (args.sheet > 0) {
        const sheet = outFile.replace(/\.mp4$/i, '') + '-sheet.png', n = args.sheet, cols = Math.min(6, n), rowsN = Math.ceil(n / cols);
        const sel = Array.from({ length: n }, (_, i) => 'eq(n\\,' + Math.round(((i + 0.5) * total) / n) + ')').join('+');
        await new Promise((res, rej) => spawn(args.ffmpeg, ['-y', '-loglevel', 'error', '-i', outFile, '-vf', 'select=' + sel + ',scale=270:480:flags=lanczos,tile=' + cols + 'x' + rowsN, '-frames:v', '1', sheet], { stdio: 'inherit' }).on('close', c => c ? rej(new Error('sheet failed')) : res()));
        console.log('wrote ' + sheet);
      }
    }
  } finally {
    if (ff && ff.exitCode == null && !ff.stdin.writableEnded) ff.kill();
    await browser.close();
    server.stop();
  }
}

main().catch(e => { console.error('record-video: ' + (e && e.message || e)); process.exit(1); });
