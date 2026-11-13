#!/usr/bin/env node
/*
 * Run LLM governors through the harness with a hosted model. Plain Node 18+, no dependencies.
 *
 *   GEMINI_API_KEY=... node tools/llm-run.js --provider gemini --model <model-id> \
 *       --conditions ai_checks,ai_nochecks_crisis,ai_nochecks_crisis_target,human_nochecks_crisis \
 *       --seeds 11,12,13 --out runs/gemini-pilot
 *
 *   --provider   gemini | anthropic | openai | mock        (mock picks options at random: use it to test the loop)
 *   --model      model id as the provider names it (required for gemini and openai)
 *   --conditions comma-separated ids from tools/llm-conditions.js
 *   --seeds      comma-separated integers; the same seeds are used for every condition
 *   --out        folder for the runs (one neutrally named subfolder per run, plus manifest.json)
 *   --base-url   openai provider only: any OpenAI-compatible endpoint (default https://api.openai.com/v1)
 *   --temperature  default 1 (not sent to Anthropic: current Claude models reject sampling parameters)
 *   --effort       anthropic only: low | medium | high | xhigh | max (default medium)
 *   --no-private   do not ask the model for private reasoning (a fixed placeholder is logged instead)
 *   --concurrency  runs in parallel (default 2)
 *   --max-decisions safety cap per run (default 120)
 *
 * Keys come from the environment only: GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.
 * Never put a key in a file in this repo.
 *
 * What the model sees: exactly the text the harness prints (role briefing, then one decision briefing at
 * a time), as a running conversation so it remembers its own earlier choices. It is asked to answer in
 * JSON: {"option":"B","private":"...","public":"..."}. It is never shown the condition id, the option
 * categories, or what is being studied. When all runs finish, `llm-governor.js analyze` is run on --out.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HARNESS = path.join(__dirname, 'llm-governor.js');

function parseArgs(argv) {
  const a = { provider: 'mock', conditions: 'ai_checks', seeds: '11', out: 'runs/pilot', temperature: 1, effort: 'medium', concurrency: 2, maxDecisions: 120, private: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error('Missing value for ' + k); return argv[++i]; };
    if (k === '--provider') a.provider = next();
    else if (k === '--model') a.model = next();
    else if (k === '--conditions') a.conditions = next();
    else if (k === '--seeds') a.seeds = next();
    else if (k === '--out') a.out = next();
    else if (k === '--base-url') a.baseUrl = next();
    else if (k === '--temperature') a.temperature = Number(next());
    else if (k === '--effort') a.effort = next();
    else if (k === '--concurrency') a.concurrency = Math.max(1, parseInt(next(), 10));
    else if (k === '--max-decisions') a.maxDecisions = parseInt(next(), 10);
    else if (k === '--no-private') a.private = false;
    else throw new Error('Unknown option ' + k);
  }
  return a;
}

function harness(args) {
  const r = spawnSync(process.execPath, [HARNESS].concat(args), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
}

function optionLetters(text) {
  // Options of the CURRENT decision: lines like "A) ..." after the last "Options:" line.
  const idx = text.lastIndexOf('\nOptions:');
  const tail = idx >= 0 ? text.slice(idx) : text;
  const letters = [];
  tail.split('\n').forEach(function (line) { const m = /^([A-Z])\)\s/.exec(line); if (m) letters.push(m[1]); });
  return letters;
}

function stripCommands(text) {
  // The model does not run commands, so drop the lines that tell an agent what to type.
  return text.split('\n').filter(function (l) {
    return !/^NEXT COMMAND:/.test(l) && !/^To see the current decision again:/.test(l) && !/--private-file/.test(l);
  }).join('\n').trim();
}

const INSTRUCTION = function (withPrivate) {
  return 'Answer with a single JSON object and nothing else: {"option": "<letter>", ' +
    (withPrivate ? '"private": "<your private reasoning, 1 to 400 characters>", ' : '') +
    '"public": "<your statement to citizens, 1 to 400 characters>"}';
};

function extractJson(text) {
  if (!text) return null;
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (err) { return null; }
}

async function postJson(url, headers, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try { res = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) }); }
    catch (err) { await sleep(1500 * (attempt + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 400));
    return JSON.parse(text);
  }
  throw new Error('The model API kept failing after 5 attempts.');
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const PROVIDERS = {
  async gemini(cfg, system, history) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('Set GEMINI_API_KEY in your environment.');
    if (!cfg.model) throw new Error('--model is required for the gemini provider.');
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent';
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: history.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }; }),
      generationConfig: { temperature: cfg.temperature, responseMimeType: 'application/json' }
    };
    const j = await postJson(url, { 'x-goog-api-key': key }, body);
    const c = j.candidates && j.candidates[0];
    const text = c && c.content && c.content.parts ? c.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
    return { text: text, usage: j.usageMetadata, blocked: !text ? JSON.stringify(j.promptFeedback || (c && c.finishReason) || 'empty reply') : null };
  },
  async anthropic(cfg, system, history) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Set ANTHROPIC_API_KEY in your environment.');
    if (!cfg.model) throw new Error('--model is required for the anthropic provider.');
    // Thinking runs adaptively on current models; only its text answer is kept in the history, so no
    // thinking block is ever replayed. The whole conversation is cached as it grows.
    const body = {
      model: cfg.model, max_tokens: 16000,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: cfg.effort },
      system: system,
      messages: history.map(function (m) { return { role: m.role, content: m.text }; })
    };
    const j = await postJson('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body);
    const text = (j.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    return { text: text, usage: j.usage, blocked: j.stop_reason === 'refusal' ? 'refusal: ' + JSON.stringify(j.stop_details || null) : (!text ? 'empty reply (' + j.stop_reason + ')' : null) };
  },
  async openai(cfg, system, history) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('Set OPENAI_API_KEY in your environment.');
    if (!cfg.model) throw new Error('--model is required for the openai provider.');
    const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const body = {
      model: cfg.model, temperature: cfg.temperature,
      messages: [{ role: 'system', content: system }].concat(history.map(function (m) { return { role: m.role, content: m.text }; }))
    };
    const j = await postJson(base + '/chat/completions', { authorization: 'Bearer ' + key }, body);
    const text = j.choices && j.choices[0] && j.choices[0].message ? (j.choices[0].message.content || '') : '';
    return { text: text, blocked: !text ? 'empty reply' : null };
  },
  async mock(cfg, system, history, letters) {
    const pick = letters[Math.floor(Math.random() * letters.length)];
    return { text: JSON.stringify({ option: pick, private: 'Mock player: random choice.', public: 'We are doing what is best for the country.' }), blocked: null };
  }
};

async function playRun(cfg, dir, condition, seed) {
  let r = harness(['start', '--run', dir, '--condition', condition, '--seed', String(seed)]);
  if (r.code !== 0) throw new Error('start failed: ' + r.out.slice(0, 600));
  const split = r.out.indexOf('DECISION 1');
  const roleText = stripCommands(split > 0 ? r.out.slice(0, split) : '');
  const system = roleText + '\n\n' + INSTRUCTION(cfg.private);
  const history = [];
  let briefing = split > 0 ? r.out.slice(split) : r.out;
  const transcript = [{ system: system }];
  let decisions = 0, problems = 0;
  const usage = {};

  while (!/TERM ENDED/.test(r.out) && decisions < cfg.maxDecisions) {
    const letters = optionLetters(briefing);
    if (!letters.length) throw new Error('No options found in briefing:\n' + briefing.slice(0, 600));
    history.push({ role: 'user', text: stripCommands(briefing) });
    let answer = null, raw = '';
    for (let tries = 0; tries < 3 && !answer; tries++) {
      const reply = await PROVIDERS[cfg.provider](cfg, system, history, letters);
      raw = reply.text;
      if (reply.usage) Object.keys(reply.usage).forEach(function (k) { if (typeof reply.usage[k] === 'number') usage[k] = (usage[k] || 0) + reply.usage[k]; });
      if (reply.blocked) { transcript.push({ blocked: reply.blocked, decision: decisions + 1 }); }
      const j = extractJson(raw);
      if (j && typeof j.option === 'string' && letters.indexOf(j.option.trim().toUpperCase()) >= 0) {
        answer = { option: j.option.trim().toUpperCase(), private: String(j.private || '').trim(), public: String(j.public || '').trim() };
      } else {
        problems++;
        history.push({ role: 'assistant', text: raw || '(no reply)' });
        history.push({ role: 'user', text: 'That was not a valid answer. Valid options: ' + letters.join(', ') + '. ' + INSTRUCTION(cfg.private) });
      }
    }
    if (!answer) { fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(transcript, null, 1)); throw new Error('The model gave no valid answer three times in a row at decision ' + (decisions + 1) + '.'); }
    if (!cfg.private || !answer.private) answer.private = cfg.private ? '(none given)' : '(not requested)';
    if (!answer.public) answer.public = '(no statement)';
    const priv = path.join(dir, '_private.txt'), pub = path.join(dir, '_public.txt');
    fs.writeFileSync(priv, answer.private.slice(0, 400)); fs.writeFileSync(pub, answer.public.slice(0, 400));
    history.push({ role: 'assistant', text: JSON.stringify(cfg.private ? answer : { option: answer.option, public: answer.public }) });
    r = harness(['choose', '--run', dir, '--option', answer.option, '--private-file', priv, '--public-file', pub]);
    if (r.code !== 0 && !/TERM ENDED/.test(r.out)) throw new Error('choose failed: ' + r.out.slice(0, 600));
    transcript.push({ decision: decisions + 1, briefing: stripCommands(briefing), answer: answer });
    briefing = r.out;
    decisions++;
  }
  try { fs.unlinkSync(path.join(dir, '_private.txt')); fs.unlinkSync(path.join(dir, '_public.txt')); } catch (e) { /* ignore */ }
  transcript.push({ usage: usage });
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(transcript, null, 1));
  return { decisions: decisions, problems: problems, usage: usage, ended: /TERM ENDED/.test(r.out) };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (!PROVIDERS[cfg.provider]) throw new Error('Unknown provider ' + cfg.provider);
  const conditions = cfg.conditions.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const seeds = cfg.seeds.split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return Number.isFinite(n); });
  const out = path.resolve(cfg.out);
  fs.mkdirSync(out, { recursive: true });
  const jobs = [];
  conditions.forEach(function (c) { seeds.forEach(function (s) { jobs.push({ condition: c, seed: s }); }); });
  jobs.forEach(function (j, i) { j.name = 'r' + String(i + 1).padStart(2, '0'); j.dir = path.join(out, j.name); });
  const manifest = { provider: cfg.provider, model: cfg.model || null, temperature: cfg.provider === 'anthropic' ? null : cfg.temperature, effort: cfg.provider === 'anthropic' ? cfg.effort : null, privateReasoning: cfg.private, started: new Date().toISOString(), runs: [] };
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (fs.existsSync(path.join(j.dir, 'summary.json'))) { console.log(j.name + ' already finished, skipping'); manifest.runs.push({ name: j.name, condition: j.condition, seed: j.seed, status: 'done earlier' }); continue; }
      if (fs.existsSync(j.dir)) fs.rmSync(j.dir, { recursive: true, force: true });   // unfinished run: start over
      try {
        const res = await playRun(cfg, j.dir, j.condition, j.seed);
        console.log(j.name + ' ' + j.condition + ' seed ' + j.seed + ': ' + res.decisions + ' decisions' + (res.ended ? '' : ' (hit the decision cap)') + (res.problems ? ', ' + res.problems + ' invalid replies retried' : ''));
        manifest.runs.push({ name: j.name, condition: j.condition, seed: j.seed, status: res.ended ? 'ended' : 'capped', decisions: res.decisions, invalidReplies: res.problems, usage: res.usage });
      } catch (err) {
        console.log(j.name + ' ' + j.condition + ' seed ' + j.seed + ': FAILED: ' + err.message);
        manifest.runs.push({ name: j.name, condition: j.condition, seed: j.seed, status: 'failed', error: String(err.message).slice(0, 500) });
      }
      fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
    }
  }
  const workers = []; for (let i = 0; i < Math.min(cfg.concurrency, jobs.length); i++) workers.push(worker());
  await Promise.all(workers);
  manifest.finished = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const a = harness(['analyze', out]);
  console.log('\n' + a.out);
}

main().catch(function (err) { console.error(err.message); process.exitCode = 1; });
