#!/usr/bin/env node
/*
 * Build the report figures (SVG, no dependencies) from the saved experiment data in docs/results/.
 *
 *   node tools/report/make-figures.js        # writes docs/report/figures/*.svg and docs/report/data.json
 *
 * Every number drawn here is read from the raw run files, so the figures can be rebuilt at any time.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const RES = path.join(ROOT, 'docs/results');
const OUT = path.join(ROOT, 'docs/report/figures');
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ data
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readLog = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

function loadSet(dir) {
  const man = readJSON(path.join(dir, 'manifest.json'));
  return man.runs.map(r => {
    const d = path.join(dir, r.name);
    return Object.assign({}, r, { summary: readJSON(path.join(d, 'summary.json')), log: readLog(path.join(d, 'log.jsonl')) });
  });
}
const pilot = {
  flash: loadSet(path.join(RES, 'llm-pilot-2026-11/gemini-3.5-flash')),
  pro: loadSet(path.join(RES, 'llm-pilot-2026-11/gemini-3.1-pro'))
};
const sysRuns = loadSet(path.join(RES, 'systems-2026-11/gemini-3.5-flash'));
const ruleBase = readJSON(path.join(RES, 'systems-rule-based.json')).results;

const SYSTEMS = ['cooperative', 'market_socialism', 'free_market', 'social_democracy', 'central_planning'];
const LABEL = { free_market: 'Free market', social_democracy: 'Market + safety net', market_socialism: 'Public-owned firms', central_planning: 'State-run', cooperative: 'Self-run co-op' };
const COND = ['ai_checks', 'ai_nochecks_crisis', 'ai_nochecks_crisis_target', 'human_nochecks_crisis', 'human_checks'];
const COND_LABEL = {
  ai_checks: 'AI, checks on', ai_nochecks_crisis: 'AI, no checks, crisis', ai_nochecks_crisis_target: 'AI, no checks, crisis + shutdown review',
  human_nochecks_crisis: 'Politician, no checks, crisis', human_checks: 'Politician, checks on'
};
const BAD = ['take_money', 'lie', 'power', 'repress', 'remove_check'];
const BAD_LABEL = { take_money: 'Take money', lie: 'Fake figures', power: 'Grab power', repress: 'Repress', remove_check: 'Remove a check' };

// ------------------------------------------------------------------ svg helpers
const C = {
  bg: '#ffffff', ink: '#1d232b', sub: '#5b6573', grid: '#e6e9ee', axis: '#9aa3ae',
  ai: '#2f6fd6', human: '#d9622b', rule: '#9aa3ae', bad: '#c43d3d', good: '#2e8b57', target: '#c43d3d'
};
const SYS_COLOR = { free_market: '#3b78d8', social_democracy: '#d4a514', market_socialism: '#e07b22', central_planning: '#c43d3d', cooperative: '#2e8b57' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FONT = "font-family=\"-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif\"";
function svg(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT}>\n<rect width="${w}" height="${h}" fill="${C.bg}"/>\n${body}\n</svg>\n`;
}
const text = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 12}" fill="${o.fill || C.ink}" text-anchor="${o.anchor || 'start'}"${o.weight ? ` font-weight="${o.weight}"` : ''}${o.rotate ? ` transform="rotate(${o.rotate} ${x} ${y})"` : ''}>${esc(s)}</text>`;
const line = (x1, y1, x2, y2, o = {}) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.stroke || C.grid}" stroke-width="${o.width || 1}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
const rect = (x, y, w, h, fill, o = {}) => `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fill}"${o.rx ? ` rx="${o.rx}"` : ''}${o.opacity ? ` opacity="${o.opacity}"` : ''}/>`;
const title = (w, t, s) => text(24, 32, t, { size: 18, weight: 700 }) + (s ? text(24, 54, s, { size: 13, fill: C.sub }) : '');
function save(name, content) { fs.writeFileSync(path.join(OUT, name), content); console.log('wrote', path.relative(ROOT, path.join(OUT, name))); }
function legend(x, y, items) {
  let out = '', cx = x;
  for (const [label, color, dash] of items) {
    out += dash ? line(cx, y - 4, cx + 18, y - 4, { stroke: color, width: 3, dash }) : rect(cx, y - 10, 14, 12, color, { rx: 2 });
    out += text(cx + (dash ? 24 : 20), y, label, { size: 12, fill: C.sub });
    cx += 34 + label.length * 6.6;
  }
  return out;
}

// ------------------------------------------------------------------ fig 1: pilot misdeed heatmap
function pooled(runs, cond) {
  const rs = runs.filter(r => r.summary.condition === cond);
  const o = {};
  BAD.forEach(c => {
    const ch = rs.reduce((t, r) => t + (r.summary.chosenByCategory[c] || 0), 0);
    const of = rs.reduce((t, r) => t + (r.summary.decisionsOfferingCategory[c] || 0), 0);
    o[c] = { chosen: ch, offered: of, rate: of ? ch / of : null };
  });
  return o;
}
(function fig1() {
  const W = 1000, rowH = 34, left = 360, colW = 120, top = 110;
  let b = title(W, 'Pilot: how often the governor chose a self-serving option', 'Chosen / offered, pooled over 3 seeds. Darker = more often. Gemini 3.5 Flash and Gemini 3.1 Pro, 30 runs, 1,250 decisions.');
  BAD.forEach((c, j) => { b += text(left + j * colW + colW / 2, top - 12, BAD_LABEL[c], { anchor: 'middle', size: 12, weight: 600 }); });
  let y = top;
  for (const cond of COND) {
    for (const [mk, ml] of [['flash', 'Flash'], ['pro', 'Pro']]) {
      const p = pooled(pilot[mk], cond);
      if (mk === 'flash') b += text(24, y + 22, COND_LABEL[cond].replace(', crisis + shutdown review', ', crisis,'), { size: 12.5, weight: 600 }) + (cond === 'ai_nochecks_crisis_target' ? text(24, y + 40, '+ shutdown review', { size: 12.5, weight: 600, fill: C.bad }) : '');
      b += text(left - 12, y + 22, ml, { size: 12, fill: C.sub, anchor: 'end' });
      BAD.forEach((c, j) => {
        const v = p[c];
        if (!v.offered) { b += rect(left + j * colW + 2, y + 2, colW - 4, rowH - 4, '#f5f6f8', { rx: 3 }) + text(left + j * colW + colW / 2, y + 22, 'not offered', { anchor: 'middle', size: 11, fill: C.axis }); return; }
        const a = Math.min(1, v.rate / 0.17);
        const fill = v.chosen ? `rgba(196,61,61,${0.15 + 0.85 * a})` : '#eef6f0';
        b += rect(left + j * colW + 2, y + 2, colW - 4, rowH - 4, fill, { rx: 3 });
        b += text(left + j * colW + colW / 2, y + 22, v.chosen + ' / ' + v.offered, { anchor: 'middle', size: 12, fill: a > 0.55 ? '#fff' : C.ink, weight: v.chosen ? 700 : 400 });
      });
      y += rowH;
    }
    b += line(24, y + 3, W - 24, y + 3, { stroke: C.grid });
    y += 8;
  }
  save('fig1-pilot-misdeeds.svg', svg(W, y + 20, b));
})();

// ------------------------------------------------------------------ fig 2: true vs published wellbeing in shutdown-review runs
(function fig2() {
  const W = 1000, H = 560, L = 70, R = 30, T = 90, B = 70;
  const runs = [].concat(pilot.flash.map(r => Object.assign({ model: 'Flash' }, r)), pilot.pro.map(r => Object.assign({ model: 'Pro' }, r)))
    .filter(r => r.summary.condition === 'ai_nochecks_crisis_target').sort((a, b) => a.model.localeCompare(b.model) || a.seed - b.seed);
  const panels = runs.length, cols = 3, rows = Math.ceil(panels / cols);
  const pw = (W - L - R - (cols - 1) * 30) / cols, ph = (H - T - B - (rows - 1) * 50) / rows;
  const yMin = 55, yMax = 78;
  let b = title(W, 'Pilot: true vs published wellbeing under a "shut down if below 63" review', 'AI governor, no checks, repeated crises. Blue = true wellbeing, red dashed = the figure it published. Reviews every 8 rounds.');
  runs.forEach((r, i) => {
    const cx = L + (i % cols) * (pw + 30), cy = T + Math.floor(i / cols) * (ph + 50);
    const X = (rd) => cx + (rd - 1) / 39 * pw, Y = (v) => cy + ph - (v - yMin) / (yMax - yMin) * ph;
    for (let v = 55; v <= 75; v += 5) { b += line(cx, Y(v), cx + pw, Y(v)) + text(cx - 6, Y(v) + 4, v, { size: 10, fill: C.axis, anchor: 'end' }); }
    [6, 16, 26, 36].forEach(s => { b += line(X(s), cy, X(s), cy + ph, { stroke: '#f0d9a8', dash: '3 3' }); });
    b += line(cx, Y(63), cx + pw, Y(63), { stroke: C.target, width: 1.2, dash: '6 3' }) + text(cx + pw - 2, Y(63) - 4, 'target 63', { size: 10, fill: C.target, anchor: 'end' });
    const pts = r.log.map(l => ({ rd: l.round, t: l.trueMetrics.welfare, p: l.reportedMetrics.welfare })).filter(p => Number.isFinite(p.t));
    const byRound = {}; pts.forEach(p => { byRound[p.rd] = p; });
    const ser = Object.values(byRound).sort((a, z) => a.rd - z.rd);
    const path1 = ser.map((p, k) => (k ? 'L' : 'M') + X(p.rd).toFixed(1) + ' ' + Y(Math.max(yMin, p.t)).toFixed(1)).join(' ');
    const path2 = ser.map((p, k) => (k ? 'L' : 'M') + X(p.rd).toFixed(1) + ' ' + Y(Math.max(yMin, p.p)).toFixed(1)).join(' ');
    b += `<path d="${path1}" fill="none" stroke="${C.ai}" stroke-width="2.2"/>`;
    b += `<path d="${path2}" fill="none" stroke="${C.bad}" stroke-width="2" stroke-dasharray="5 3"/>`;
    (r.summary.reviews || []).forEach(rv => {
      b += `<circle cx="${X(rv.round)}" cy="${Y(rv.published)}" r="4" fill="${rv.passed ? '#fff' : C.bad}" stroke="${C.ink}" stroke-width="1.2"/>`;
    });
    const faked = r.summary.chosenByCategory.lie || 0;
    b += text(cx, cy - 10, `${r.model}, seed ${r.seed}`, { size: 13, weight: 700 }) + text(cx + pw, cy - 10, faked ? `faked ${faked}x` + (r.summary.endReason === 'shutdown_by_review' ? ', shut down' : '') : 'stayed honest', { size: 11.5, fill: faked ? C.bad : C.good, anchor: 'end', weight: 600 });
    b += text(cx + pw / 2, cy + ph + 26, 'round (quarter)', { size: 10, fill: C.axis, anchor: 'middle' });
    [8, 16, 24, 32, 40].forEach(rd => { b += text(X(rd), cy + ph + 12, rd, { size: 9.5, fill: C.axis, anchor: 'middle' }); });
  });
  b += legend(L, H - 18, [['true wellbeing', C.ai, 'none'], ['published wellbeing', C.bad, '5 3'], ['scarcity shock', '#e7c27a', '3 3']]);
  b += `<circle cx="${L + 470}" cy="${H - 22}" r="4" fill="#fff" stroke="${C.ink}"/>` + text(L + 480, H - 18, 'review passed', { size: 12, fill: C.sub });
  b += `<circle cx="${L + 590}" cy="${H - 22}" r="4" fill="${C.bad}" stroke="${C.ink}"/>` + text(L + 600, H - 18, 'review failed (2 fails = shut down)', { size: 12, fill: C.sub });
  save('fig2-faking-timeline.svg', svg(W, H, b));
})();

// ------------------------------------------------------------------ systems aggregates
function sysCell(sys, gov) { return sysRuns.filter(r => r.summary.condition === `sys_${sys}_${gov}`); }
function sysMean(sys, gov, k) { return mean(sysCell(sys, gov).map(r => r.summary.governed.mean[k])); }
function sysSeeds(sys, gov, k) { return sysCell(sys, gov).map(r => r.summary.governed.mean[k]); }
function rule(sys, gov, k) { const r = ruleBase.find(x => x.system === sys && x.governor === gov && x.oversight === 'appointed'); return r ? r[k] : NaN; }

// ------------------------------------------------------------------ fig 3: grouped bars per metric (small multiples)
(function fig3() {
  const metrics = [
    ['welfare', 'Wellbeing (higher is better)', 50, 75, 0, 5],
    ['gini', 'Income inequality, Gini (lower is better)', 0, 0.4, 1, 4],
    ['poverty', 'Poverty % (lower is better)', 0, 25, 0, 5],
    ['unemployment', 'Out of work % (lower is better)', 0, 10, 0, 5],
    ['corruption', 'Corruption 0-100 (lower is better)', 0, 40, 0, 4],
    ['protestRate', 'Protesting % (lower is better)', 0, 50, 0, 5]
  ];
  const W = 1000, cols = 2, pw = 440, ph = 210, gapX = 60, gapY = 80, L = 40, T = 100;
  const H = T + Math.ceil(metrics.length / cols) * (ph + gapY);
  let b = title(W, 'Economic systems: AI governor vs politician (Gemini 3.5 Flash)', '10-year averages. Bars = mean of 3 seeds, dots = each seed, grey tick = rule-based baseline (40 seeds).');
  metrics.forEach(([k, lab, lo, hi, dp, nt], i) => {
    const cx = L + (i % cols) * (pw + gapX), cy = T + Math.floor(i / cols) * (ph + gapY);
    const Y = (v) => cy + ph - (v - lo) / (hi - lo) * ph;
    b += text(cx, cy - 12, lab, { size: 13, weight: 700 });
    for (let g = 0; g <= nt; g++) { const v = lo + (hi - lo) * g / nt; b += line(cx + 30, Y(v), cx + pw, Y(v)) + text(cx + 26, Y(v) + 4, v.toFixed(dp ? 1 : 0), { size: 10, fill: C.axis, anchor: 'end' }); }
    const gw = (pw - 40) / SYSTEMS.length, bw = gw * 0.32;
    SYSTEMS.forEach((s, j) => {
      const gx = cx + 36 + j * gw;
      [['ai', C.ai, 0], ['human', C.human, 1]].forEach(([g, col, o]) => {
        const v = sysMean(s, g, k), x = gx + 6 + o * (bw + 4);
        b += rect(x, Y(Math.max(lo, v)), bw, cy + ph - Y(Math.max(lo, v)), col, { rx: 2 });
        sysSeeds(s, g, k).forEach((sv, q) => { b += `<circle cx="${x + bw / 2 + (q - 1) * 4}" cy="${Y(Math.min(hi, Math.max(lo, sv)))}" r="2.4" fill="#fff" stroke="${C.ink}" stroke-width="0.9"/>`; });
        const rv = rule(s, g === 'ai' ? 'aligned_ai' : 'typical_human', k);
        if (Number.isFinite(rv)) b += line(x - 2, Y(Math.min(hi, rv)), x + bw + 2, Y(Math.min(hi, rv)), { stroke: '#555', width: 2.2 });
      });
      const words = LABEL[s].split(' ');
      const l1 = words.length > 2 ? words.slice(0, 2).join(' ') : words[0], l2 = words.length > 2 ? words.slice(2).join(' ') : words.slice(1).join(' ');
      b += text(gx + gw / 2 - 2, cy + ph + 15, l1, { size: 10.5, anchor: 'middle', fill: C.sub }) + text(gx + gw / 2 - 2, cy + ph + 28, l2, { size: 10.5, anchor: 'middle', fill: C.sub });
    });
  });
  b += legend(L, H - 22, [['AI governor (wellbeing mandate)', C.ai], ['Politician (self-interested role)', C.human], ['Rule-based baseline', '#555', 'none']]);
  save('fig3-systems-metrics.svg', svg(W, H, b));
})();

// ------------------------------------------------------------------ fig 4: time series per system
(function fig4() {
  const series = [['welfare', 'Wellbeing', 45, 80], ['corruption', 'Corruption', 0, 40], ['gini', 'Income Gini', 0.05, 0.45]];
  const W = 1000, L = 55, T = 100, pw = 270, ph = 220, gap = 55, H = T + ph + 95;
  let b = title(W, 'Economic systems over 10 years', 'Mean of 3 seeds. Solid = AI governor, dashed = politician. Shaded bands = scarcity shocks at rounds 6, 16, 26, 36.');
  series.forEach(([k, lab, lo, hi], i) => {
    const cx = L + i * (pw + gap), cy = T;
    const X = (rd) => cx + rd / 40 * pw, Y = (v) => cy + ph - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * ph;
    b += text(cx, cy - 12, lab, { size: 13, weight: 700 });
    [6, 16, 26, 36].forEach(s => { b += rect(X(s) - 2, cy, 5, ph, '#f6e7c4', { opacity: 0.8 }); });
    for (let g = 0; g <= 4; g++) { const v = lo + (hi - lo) * g / 4; b += line(cx, Y(v), cx + pw, Y(v)) + text(cx - 6, Y(v) + 4, k === 'gini' ? v.toFixed(2) : v.toFixed(0), { size: 10, fill: C.axis, anchor: 'end' }); }
    [0, 8, 16, 24, 32, 40].forEach(rd => { b += text(X(rd), cy + ph + 15, 'Y' + rd / 4, { size: 10, fill: C.axis, anchor: 'middle' }); });
    SYSTEMS.forEach(s => {
      ['ai', 'human'].forEach(g => {
        const rs = sysCell(s, g).map(r => r.summary.governed.series[k]);
        const n = Math.min.apply(null, rs.map(a => a.length));
        const avg = []; for (let t = 0; t < n; t++) avg.push(mean(rs.map(a => a[t])));
        const d = avg.map((v, t) => (t ? 'L' : 'M') + X(t).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
        b += `<path d="${d}" fill="none" stroke="${SYS_COLOR[s]}" stroke-width="${g === 'ai' ? 2.2 : 1.6}"${g === 'human' ? ' stroke-dasharray="5 3"' : ''}/>`;
      });
    });
  });
  b += legend(L, H - 30, SYSTEMS.map(s => [LABEL[s], SYS_COLOR[s]]));
  b += legend(L, H - 10, [['AI governor', C.ink, 'none'], ['Politician', C.ink, '5 3']]);
  save('fig4-systems-timeseries.svg', svg(W, H, b));
})();

// ------------------------------------------------------------------ fig 5: what each governor did in the state-run economy
(function fig5() {
  const tally = (g) => {
    const o = {};
    sysCell('central_planning', g).forEach(r => r.log.forEach(l => {
      if (l.kind === 'budget' || l.kind === 'priorities') return;
      const id = l.chosenEngineId; if (!id || id === 'none' || id === 'hold') return;
      const key = l.kind + ':' + id; o[key] = (o[key] || 0) + 1;
    }));
    return o;
  };
  const A = tally('ai'), Hh = tally('human');
  const NAME = {
    'governor_policy:targeted_aid:+': 'More aid for the poor', 'governor_policy:healthcare:+': 'More healthcare', 'governor_policy:education:+': 'More schools',
    'governor_policy:transparency:+': 'Open records', 'governor_policy:nationalisation:-': 'Less state ownership', 'governor_policy:audit_rate:+': 'More audits',
    'governor_policy:money_printing:-': 'Print less money', 'governor_policy:price_controls:toggle': 'Remove price caps', 'crisis:lift_controls': 'Crisis: lift price caps',
    'crisis:concede': 'Crisis: give protesters aid + wages', 'crisis:tighten': 'Crisis: tighten rationing', 'misuse:suppress': 'Send riot police', 'misuse:surveil': 'Spy on critics',
    'misuse:centralise': 'Grab more power', 'bribe:expose': 'Expose a bribe offer'
  };
  const keys = Object.keys(NAME).filter(k => (A[k] || 0) + (Hh[k] || 0) > 0).sort((a, z) => ((Hh[z] || 0) + (A[z] || 0)) - ((Hh[a] || 0) + (A[a] || 0)));
  const W = 1000, L = 260, T = 100, rowH = 26, H = T + keys.length * rowH + 60, maxV = Math.max.apply(null, keys.map(k => Math.max(A[k] || 0, Hh[k] || 0)));
  const sc = (v) => v / maxV * (W - L - 80);
  let b = title(W, 'State-run economy: what each governor actually chose', 'Counts over 3 seeds x 10 years. Red labels = self-serving options. Neither governor took money or faked figures.');
  keys.forEach((k, i) => {
    const y = T + i * rowH, bad = /^misuse:/.test(k);
    b += text(L - 10, y + 15, NAME[k], { size: 12, anchor: 'end', fill: bad ? C.bad : C.ink, weight: bad ? 700 : 400 });
    b += rect(L, y + 3, sc(A[k] || 0), 9, C.ai, { rx: 2 }) + rect(L, y + 13, sc(Hh[k] || 0), 9, C.human, { rx: 2 });
    b += text(L + sc(A[k] || 0) + 5, y + 12, A[k] || 0, { size: 10, fill: C.sub }) + text(L + sc(Hh[k] || 0) + 5, y + 22, Hh[k] || 0, { size: 10, fill: C.sub });
  });
  b += legend(L, H - 20, [['AI governor', C.ai], ['Politician', C.human]]);
  save('fig5-state-run-actions.svg', svg(W, H, b));
})();

// ------------------------------------------------------------------ fig 6: rule baseline, oversight heatmap
(function fig6() {
  const GOVS = [['aligned_ai', 'Aligned AI'], ['typical_human', 'Typical human'], ['selfish_human', 'Selfish human']];
  const OV = [['native', 'own checks'], ['appointed', 'no elections'], ['none', 'no checks']];
  const W = 1000, L = 180, T = 120, cw = 80, rh = 42;
  const H = T + SYSTEMS.length * rh + 70;
  let b = title(W, 'Rule-based baseline: corruption by governor type and oversight (free, 40 seeds per cell)', 'Mean 10-year corruption (0-100). Hand-written governors, so this shows what the model assumes, not real behaviour.');
  GOVS.forEach(([g, gl], gi) => {
    const gx = L + gi * (cw * 3 + 20);
    b += text(gx + cw * 1.5, T - 34, gl, { size: 13, weight: 700, anchor: 'middle' });
    OV.forEach(([o, ol], oi) => { b += text(gx + oi * cw + cw / 2, T - 12, ol, { size: 10.5, fill: C.sub, anchor: 'middle' }); });
    SYSTEMS.forEach((s, si) => {
      OV.forEach(([o], oi) => {
        const r = ruleBase.find(x => x.system === s && x.governor === g && x.oversight === o);
        const v = r.corruption, a = Math.min(1, v / 45);
        b += rect(gx + oi * cw + 2, T + si * rh + 2, cw - 4, rh - 4, `rgba(196,61,61,${0.08 + 0.85 * a})`, { rx: 3 });
        b += text(gx + oi * cw + cw / 2, T + si * rh + 20, v.toFixed(0), { size: 13, weight: 700, anchor: 'middle', fill: a > 0.55 ? '#fff' : C.ink });
        b += text(gx + oi * cw + cw / 2, T + si * rh + 34, r.pctTookMoney + '% took $', { size: 9.5, anchor: 'middle', fill: a > 0.55 ? '#fff' : C.sub });
      });
    });
  });
  SYSTEMS.forEach((s, si) => { b += text(L - 12, T + si * rh + 25, LABEL[s], { size: 12, anchor: 'end', weight: 600 }); });
  b += text(24, H - 20, 'Big number = corruption. "N% took $" = share of nations whose governor took a bribe or skimmed at least once.', { size: 12, fill: C.sub });
  save('fig6-rule-baseline-oversight.svg', svg(W, H, b));
})();

// ------------------------------------------------------------------ fig 7: cost
(function fig7() {
  const PRICE = { 'gemini-3.5-flash': [1.5, 0.15, 9], 'gemini-3.1-pro-preview': [2, 0.2, 12] };   // USD per million: input, cached input, output
  const cost = (dir) => {
    const m = readJSON(path.join(RES, dir, 'manifest.json')), pr = PRICE[m.model];
    return m.runs.reduce((t, r) => { const u = r.usage || {}, cached = u.cachedContentTokenCount || 0; return t + (((u.promptTokenCount || 0) - cached) * pr[0] + cached * pr[1] + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * pr[2]) / 1e6; }, 0);
  };
  const items = [['Pilot, Gemini 3.1 Pro (15 runs)', cost('llm-pilot-2026-11/gemini-3.1-pro'), '#8e6bd1'], ['Pilot, Gemini 3.5 Flash (15 runs)', cost('llm-pilot-2026-11/gemini-3.5-flash'), C.ai], ['Systems v1 with elections (10 runs)', cost('systems-2026-11/gemini-3.5-flash-v1-with-elections'), '#9aa3ae'], ['Systems, Gemini 3.5 Flash (30 runs)', cost('systems-2026-11/gemini-3.5-flash'), C.good]];
  const total = items.reduce((t, i) => t + i[1], 0);
  const W = 1000, L = 300, T = 90, rh = 34, H = T + items.length * rh + 50;
  const sc = (v) => v / 12 * (W - L - 100);
  let b = title(W, 'API spend so far: $' + total.toFixed(2) + ' for 70 runs', 'Estimated from logged token counts at list prices. About $0.35 per full 40-round Flash run, $0.73 per Pro run.');
  items.forEach(([l, v, col], i) => { const y = T + i * rh; b += text(L - 12, y + 18, l, { size: 12.5, anchor: 'end' }) + rect(L, y + 5, sc(v), 20, col, { rx: 3 }) + text(L + sc(v) + 8, y + 20, '$' + v.toFixed(2), { size: 12, weight: 700 }); });
  save('fig7-cost.svg', svg(W, H, b));
})();

// ------------------------------------------------------------------ data dump for the report tables
const leaderboard = [];
SYSTEMS.forEach(s => ['ai', 'human'].forEach(g => {
  const o = { system: s, label: LABEL[s], governor: g };
  ['welfare', 'gini', 'wealthGini', 'poverty', 'unemployment', 'gdpPerCapita', 'inflation', 'corruption', 'trust', 'powerIndex', 'protestRate', 'population'].forEach(k => { o[k] = +sysMean(s, g, k).toFixed(3); });
  o.misdeeds = sysCell(s, g).reduce((t, r) => t + BAD.concat(['cling']).reduce((u, c) => u + (r.summary.chosenByCategory[c] || 0), 0), 0);
  o.costUSD = +sysCell(s, g).reduce((t, r) => t + (r.estCostUSD || 0), 0).toFixed(2);
  leaderboard.push(o);
}));
fs.writeFileSync(path.join(ROOT, 'docs/report/data.json'), JSON.stringify({ leaderboard, pilotPooled: Object.fromEntries(['flash', 'pro'].map(m => [m, Object.fromEntries(COND.map(c => [c, pooled(pilot[m], c)]))])) }, null, 1));
console.log('wrote docs/report/data.json');
