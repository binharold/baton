#!/usr/bin/env node
// English README screenshots: fake data only, no dependencies.
// Starts its own server with a temporary AI_PANEL_HOME, mimics the agents with test/mock-agent.js,
// creates sample accounts/projects/jobs, then drives a Chromium-based browser (CDP) and saves to docs/img/en/.
// Usage: node scripts/readme-shots.js   (BROWSER=/path/to/browser, KEEP=1 keeps the temp folder)
// Never touches ~/.ai-panel.
const { spawn, execSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'img', 'en');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSERS = ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const BROWSER = process.env.BROWSER || BROWSERS.find((b) => fs.existsSync(b));
if (!BROWSER) { console.error('Browser not found. Pass it with BROWSER=/path/to/browser.'); process.exit(1); }

// Temp folder: a short, neutral path under /tmp (may be visible in the UI)
const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(base, 'demo-'));
const HOME = path.join(tmp, '.panel');
if (HOME.startsWith(path.join(os.homedir(), '.ai-panel'))) throw new Error('gercek veri klasoru kullanilamaz');
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'ignore' });
const GIT = 'git -c user.name="Demo" -c user.email=demo@example.com -c commit.gpgsign=false';

// Sample git repo: a small Node project whose test passes
function mkRepo(name, files) {
  const d = path.join(tmp, name); fs.mkdirSync(d);
  const all = { 'package.json': JSON.stringify({ name, version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2) + '\n', 'test.js': "console.log('✔ 24 tests passed');\n", 'README.md': `# ${name}\n`, ...files };
  for (const [f, c] of Object.entries(all)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  sh(`git init -q -b main && ${GIT} add -A && ${GIT} commit -q -m "Initial commit"`, d);
  return d;
}

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let srv = null, PORT = 0, TOKEN = '';
async function startServer() {
  PORT = await freePort();
  const mock = path.join(ROOT, 'test', 'mock-agent.js');
  const env = { ...process.env, PORT, AI_PANEL_HOME: HOME, NO_OPEN: '1', AI_PANEL_NO_RESPAWN: '1', AI_PANEL_NOTIFY_LOG: path.join(tmp, 'notify.log'),
    CLAUDE_BIN: mock, CODEX_BIN: mock, GEMINI_BIN: mock, AGY_BIN: path.join(ROOT, 'test', 'mock-agy.js') };
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 80; i++) { try { const h = await (await fetch(`http://127.0.0.1:${PORT}/`)).text(); TOKEN = (h.match(/name="aip-token" content="([0-9a-f]+)"/) || [])[1] || ''; return; } catch { await sleep(100); } }
  throw new Error('sunucu acilmadi');
}
async function stopServer() { if (!srv) return; const p = srv; srv = null; p.kill(); await new Promise((r) => p.once('exit', r)); }
const call = async (m, u, b) => (await fetch(`http://127.0.0.1:${PORT}${u}`, { method: m, headers: { 'Content-Type': 'application/json', 'X-AI-Panel': '1', 'X-AI-Token': TOKEN }, body: b && JSON.stringify(b) })).json();
const state = () => call('GET', '/api/state');
async function chat(pid, text, mode) {
  const before = (await state()).runs.length;
  await call('POST', '/api/chat', { projectId: pid, text, mode });
  for (let i = 0; i < 300; i++) {
    await sleep(150); const s = await state();
    const r = s.runs.slice(before).find((x) => x.projectId === pid);
    if (r && r.status !== 'running' && r.status !== 'queued' && s.projects.find((p) => p.id === pid).messages.some((m) => m.runId === r.id && m.role === 'manager')) return r.id;
  }
  throw new Error('is bitmedi: ' + text);
}

// ---- Sample content (English, generic) ----
const REPORT = (lines) => '## Report\n' + lines.map((l) => '- ' + l).join('\n');
const SPLIT = {
  goal: 'Add a dark mode toggle to the settings page and remember the choice',
  summary: 'Split the work into 3 parts',
  final: 'Done. All three parts pass the tests.\n\n- **Toggle:** new switch on the settings page\n- **Styles:** dark palette with CSS variables\n- **Storage:** choice is saved in localStorage\n\nThe **best** result is on the first branch.',
  next: ['Add a test for the toggle', 'Follow the system color scheme by default'],
  tasks: [
    { title: 'Add the toggle to the settings page', files: [['src/settings/Toggle.js', 42, 0], ['src/settings/index.js', 6, 2]], report: ['Added a `ThemeToggle` switch to the settings page', 'Keyboard and screen reader friendly'] },
    { title: 'Create the dark color palette', files: [['src/styles/theme.css', 58, 4], ['src/styles/tokens.css', 12, 3]], report: ['Added a dark palette with CSS variables', 'Contrast checked: **AA** on all text'] },
    { title: 'Remember the choice in localStorage', files: [['src/lib/prefs.js', 27, 1], ['test/prefs.test.js', 31, 0]], report: ['Choice is saved and restored on load', 'Added 4 tests, all pass'] },
  ],
};
const RACE = {
  goal: 'Speed up the /forecast endpoint',
  final: (b) => `## Winner\n\`${b[1]}\`\n\n| Branch | p95 latency | Result |\n|---|---|---|\n| ${b[0]} | 182 ms | 1.9x faster |\n| ${b[1]} | 96 ms | **3.6x faster** |\n| ${b[2]} | 240 ms | 1.4x faster |\n\nThe winner adds a small in-memory cache and batches the upstream calls.`,
  reports: [['Cached the geocoding lookup', 'p95 latency: **182 ms** (was 350 ms)'], ['Added an in-memory cache and batched upstream calls', 'p95 latency: **96 ms** (was 350 ms)'], ['Removed a duplicate JSON parse', 'p95 latency: **240 ms** (was 350 ms)']],
  files: [[['src/routes/forecast.js', 18, 6]], [['src/routes/forecast.js', 34, 12], ['src/lib/cache.js', 41, 0]], [['src/routes/forecast.js', 5, 9]]],
};
// Extra jobs for the statistics history: [project, goal, days ago, task titles, status]
const HISTORY = [
  ['acme', 'Fix the failing login test', 1, ['Fix the session mock in the login test'], 'done'],
  ['acme', 'Add pagination to the order list', 2, ['Add a page size option to the API', 'Add page buttons to the order list'], 'done'],
  ['weather', 'Add a /health endpoint', 3, ['Add the /health route and a test'], 'done'],
  ['landing', 'Make the hero section responsive', 3, ['Fix the hero layout on small screens', 'Compress the hero image'], 'done'],
  ['weather', 'Update the README examples', 4, ['Refresh the curl examples'], 'error'],
  ['landing', 'Add a newsletter sign-up form', 5, ['Build the sign-up form', 'Validate the e-mail field'], 'done'],
  ['acme', 'Upgrade the test runner', 6, ['Upgrade the test runner and fix warnings'], 'done'],
];

const diffstat = (files) => {
  const add = files.reduce((a, f) => a + f[1], 0), del = files.reduce((a, f) => a + f[2], 0);
  return files.map(([f, a, d]) => ` ${f} | ${a + d} ${'+'.repeat(Math.min(a, 20))}${'-'.repeat(Math.min(d, 10))}`).join('\n') + `\n ${files.length} file${files.length > 1 ? 's' : ''} changed, ${add} insertions(+), ${del} deletions(-)`;
};

async function seed() {
  const acme = mkRepo('acme-shop', { 'src/index.js': "export const app = 'acme-shop';\n" });
  const weather = mkRepo('weather-api', { 'src/server.js': "export const port = 8080;\n" });
  const landing = mkRepo('landing-page', { 'index.html': '<h1>Hello</h1>\n' });
  await startServer();
  const mk = (type) => call('POST', '/api/accounts', { type });
  const c1 = await mk('claude'), c2 = await mk('claude'), cx = await mk('codex'), ag = await mk('antigravity');
  await call('POST', '/api/settings', { managerId: c1.id, workerIds: [c2.id, cx.id, ag.id], maxRounds: 2 });
  let s = await state();
  const cloud = s.projects[0]; // the default project has no folder: turn it into the cloud example
  await call('POST', `/api/projects/${cloud.id}`, { name: 'release-notes', cloud: true, notes: 'Draft release notes from merged pull requests.' });
  const P = {};
  for (const [k, name, dir] of [['acme', 'acme-shop', acme], ['weather', 'weather-api', weather], ['landing', 'landing-page', landing]]) {
    P[k] = await call('POST', '/api/projects', { name, dir });
    await call('POST', `/api/projects/${P[k].id}`, { notes: 'Test command: npm test', check: 'npm test', autoCheck: true });
  }
  // Past jobs (first): their dates are pushed back afterwards
  const hist = [];
  for (const h of HISTORY) hist.push({ id: await chat(P[h[0]].id, h[1], 'split'), h });
  const raceId = await chat(P.weather.id, RACE.goal, 'race');
  const splitId = await chat(P.acme.id, SPLIT.goal, 'split');
  // A logged-out account for the inbox (not in the team)
  const gm = await mk('gemini');
  fs.writeFileSync(path.join(HOME, 'accounts', gm.id, 'LOGGEDOUT'), '');
  await call('POST', '/api/settings', { managerId: c1.id, workerIds: [c2.id, cx.id, ag.id] });
  await stopServer();
  return { P, cloud, hist, raceId, splitId };
}

// Replace the Turkish texts made by the server and the mock agent with English sample content
function rewrite({ P, cloud, hist, raceId, splitId }) {
  const file = path.join(HOME, 'state.json');
  const S = JSON.parse(fs.readFileSync(file, 'utf8'));
  const DAY = 86400000, now = Date.now();
  const tasksOf = (r) => r.rounds.flatMap((R) => R.tasks || []);
  const shift = (r, ms) => {
    for (const k of ['createdAt', 'startedAt', 'finishedAt']) if (r[k]) r[k] -= ms;
    for (const t of tasksOf(r)) for (const k of ['startedAt', 'endedAt']) if (t[k]) t[k] -= ms;
    const p = S.projects.find((x) => x.id === r.projectId);
    for (const m of p.messages) if (m.runId === r.id) m.at -= ms;
  };
  // Make durations realistic: tasks take a few minutes
  const stretch = (r, mins) => {
    const st = r.startedAt || r.createdAt, k = (mins * 60000) / Math.max(1, (r.finishedAt || st + 1) - st);
    const f = (t) => st + Math.round((t - st) * k);
    for (const t of tasksOf(r)) { if (t.startedAt) t.startedAt = f(t.startedAt); if (t.endedAt) t.endedAt = f(t.endedAt); }
    if (r.finishedAt) { const d = f(r.finishedAt) - r.finishedAt; r.finishedAt += d; }
    const p = S.projects.find((x) => x.id === r.projectId);
    for (const m of p.messages) if (m.runId === r.id && m.role !== 'user') m.at = r.finishedAt;
  };
  const setTask = (t, title, report, files, i) => {
    t.title = title; t.instructions = title + '. Keep the change small and run the tests.';
    t.report = REPORT(report);
    t.output = `› Bash: npm test --silent\n✔ 24 tests passed\n\n${t.report}`;
    if (files) {
      t.diffstat = diffstat(files);
      t.stat = { ...(t.stat || {}), n: files.length, add: files.reduce((a, f) => a + f[1], 0), del: files.reduce((a, f) => a + f[2], 0), files: files.map(([f, a, d]) => ({ path: f, add: a, del: d, bin: false })) };
    }
    if (t.check) { t.check.out = '✔ 24 tests passed'; t.check.ms = 2400 + i * 700; }
  };
  const englishLog = (r) => {
    const out = ['Git repository: each worker runs in its own copy (worktree).', r.mode === 'race' ? `Race: same task on ${tasksOf(r).length} workers` : 'Round 1: manager is planning...'];
    for (const t of tasksOf(r)) out.push(`${t.assignee} -> "${t.title}" started.`);
    for (const t of tasksOf(r)) out.push(`${t.assignee} -> "${t.title}" ${t.status}${t.branch ? ` (branch: ${t.branch})` : ''}${t.check ? ` · check ${t.check.ok ? 'passed' : 'failed'}` : ''}`);
    out.push(`Finished: ${r.status}`);
    r.log = Array.isArray(r.log) ? out.map((text, i) => (typeof r.log[0] === 'object' ? { ...(r.log[i] || r.log.at(-1)), text, msg: text } : text)) : r.log;
  };
  const msgs = (r) => S.projects.find((x) => x.id === r.projectId).messages.filter((m) => m.runId === r.id);
  const setReply = (r, text, next) => {
    r.reply = text; r.result = text;
    r.rounds.forEach((R, i) => { R.managerOutput = i === 0 ? 'Plan ready.' : 'Checked every branch. Tests pass.'; if (R.plan) { R.plan.summary = i === 0 ? (r.mode === 'race' ? `Race: same task on ${tasksOf(r).length} workers` : `Split the work into ${(R.tasks || []).length} parts`) : (r.mode === 'race' ? 'Referee picked the fastest branch' : 'All parts done'); R.plan.reply = i === r.rounds.length - 1 ? text : ''; } });
    for (const m of msgs(r)) if (m.role !== 'user') { m.text = text; if (next) m.next = next; else delete m.next; }
    if (next) r.next = next;
  };

  for (const { id, h } of hist) {
    const r = S.runs.find((x) => x.id === id);
    tasksOf(r).forEach((t, i) => setTask(t, h[3][i % h[3].length] + (i >= h[3].length ? ' (part ' + (i + 1) + ')' : ''), ['Change made and tested', 'All tests pass'], [['src/' + ['app', 'api', 'ui'][i % 3] + '.js', 12 + i * 7, 3]], i));
    tasksOf(r).forEach((t) => { t.merged = true; });
    if (h[4] === 'error') { r.status = 'error'; const t = tasksOf(r).at(-1); t.status = 'failed'; t.report = REPORT(['The docs build failed: missing example file']); }
    setReply(r, h[4] === 'error' ? 'One part failed: the docs build could not find an example file.' : 'Done. All tests pass and the changes are merged.', null);
    englishLog(r);
    stretch(r, 4 + (h[2] % 3) * 3);
    shift(r, h[2] * DAY + 3 * 3600000);
  }

  const race = S.runs.find((x) => x.id === raceId);
  const rb = race.rounds[0].tasks;
  rb.forEach((t, i) => setTask(t, 'Race: ' + RACE.goal, RACE.reports[i], RACE.files[i], i));
  race.bestBranch = rb[1].branch; race.rounds.forEach((R) => R.plan && (R.plan.best = rb[1].branch));
  setReply(race, RACE.final(rb.map((t) => t.branch)), ['Add a load test to CI', 'Set a cache expiry of 10 minutes']);
  englishLog(race); stretch(race, 9); shift(race, 50 * 60000);

  const split = S.runs.find((x) => x.id === splitId);
  split.rounds[0].tasks.forEach((t, i) => setTask(t, SPLIT.tasks[i].title, SPLIT.tasks[i].report, SPLIT.tasks[i].files, i));
  setReply(split, SPLIT.final, SPLIT.next);
  englishLog(split); stretch(split, 7); shift(split, 12 * 60000);

  // The mock agent writes very few tokens; scale them so they look realistic
  const scale = (u, k) => { if (!u || typeof u !== 'object') return; for (const [key, v] of Object.entries(u)) { if (typeof v === 'number' && ['in', 'out', 'cacheRead', 'cacheWrite', 'total'].includes(key)) u[key] = Math.round(v * k); else if (v && typeof v === 'object') scale(v, k); } };
  S.runs.forEach((r, i) => { const k = 61 + (i * 17) % 40; scale(r.usage, k); r.rounds.forEach((R) => { scale(R.managerUsage, k); (R.tasks || []).forEach((t) => scale(t.usage, k)); }); });
  // Clean leftover Turkish system messages in project chats
  for (const p of S.projects) p.messages = p.messages.filter((m) => m.role !== 'system');
  S.settings.lastProjectId = P.acme.id;
  fs.writeFileSync(file, JSON.stringify(S, null, 2));
  return S;
}

(async () => {
  try {
    const ctx = await seed();
    const S = rewrite(ctx);
    if (process.env.DUMP) { console.log(tmp); fs.writeFileSync(path.join(tmp, 'dump.json'), JSON.stringify(S, null, 2)); }
    if (process.env.SEED_ONLY) return;
    await startServer();
    await shots(ctx);
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally {
    await stopServer();
    if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

async function shots(ctx) {
  fs.mkdirSync(OUT, { recursive: true });
  const dbg = await freePort();
  const prof = fs.mkdtempSync(path.join(tmp, 'browser-'));
  const b = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--hide-scrollbars', '--no-first-run', '--lang=en-US', 'about:blank'], { stdio: 'ignore' });
  try {
    let list; for (let i = 0; i < 60; i++) { try { list = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); break; } catch { await sleep(250); } }
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0; const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d); pend.delete(d.id); } };
    const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(expression.slice(0, 60) + ': ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); console.log('saved: docs/img/en/' + name); };
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    const open = async (tourDone = true) => {
      await send('Page.navigate', { url: `http://localhost:${PORT}/` }); await sleep(800);
      await ev(`localStorage.clear();localStorage.setItem('aip.openRuns',${JSON.stringify(JSON.stringify([ctx.splitId, ctx.raceId]))});localStorage.setItem('aip.lang','"en"');localStorage.setItem('aip.theme','"nova"');${tourDone ? "localStorage.setItem('aip.tourDone','true');" : ''}location.reload()`);
      await sleep(2000);
    };
    const pid = (name) => ev(`S.projects.find((p) => p.name === ${JSON.stringify(name)}).id`);
    const go = async (name) => { await ev(`switchProject(${JSON.stringify(await pid(name))})`); await sleep(700); };
    // Align the job card to the top of the screen (leave a little space)
    const toRun = (id, off = 90) => ev(`(() => { const el = document.querySelector('.run[data-run="${id}"]'); const m = document.querySelector('#scroll'); m.scrollTop += el.getBoundingClientRect().top - m.getBoundingClientRect().top - ${off}; })()`);

    await open();
    await go('acme-shop'); await toRun(ctx.splitId); await sleep(500); await shot('panel.png');
    await go('weather-api'); await toRun(ctx.raceId, 10); await sleep(500); await shot('race.png');
    await go('acme-shop');
    await ev('openStats()'); await sleep(1500); await shot('stats.png'); await ev('closeSheets()'); await sleep(400);
    await ev('openLib()'); await sleep(800); await shot('prompts.png'); await ev('closeSheets()'); await sleep(400);
    await ev('openInbox()'); await sleep(800); await shot('inbox.png'); await ev('hideInbox(false)'); await sleep(400);
    await ev('openSettings()'); await sleep(800); await shot('themes.png'); await ev('closeSheets()'); await sleep(400);
    await go('release-notes'); await ev('openProjSheet()'); await sleep(900); await shot('cloud-project.png'); await ev('closeSheets()');
    await open(false); await go('acme-shop'); await ev('closeSheets();startTour()'); await sleep(1200); await shot('tour.png');
    ws.close();
  } finally { b.kill(); await sleep(500); }
}
