// Her ajan tipinin nasil calistirilacagi ve hesaplarin nasil ayrildigi.
// Hesap ayirma: her hesap kendi ayar klasorunu kullanir, boylece ayni anda
// birden fazla hesap girisli kalir.
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TYPES = {
  claude: {
    label: 'Claude Code',
    bin: () => process.env.CLAUDE_BIN || 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    env: (dir) => (dir ? { CLAUDE_CONFIG_DIR: dir } : {}),
    loginCmd: 'claude',
    loginHint: 'Acilan ekranda giris yap (gerekirse /login yaz), sonra pencereyi kapat.',
    usageCmd: 'claude', usageHint: 'Acilan ekranda /usage yaz: kalan limitini gosterir.',
    // stream-json: canli arac kullanimi + gercek limit yuzdeleri (rate_limit_event)
    args: (prompt, perm, model, effort) => [
      '-p', prompt, '--output-format', 'stream-json', '--verbose',
      ...(perm === 'full' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits']),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    stream: 'claude',
  },
  codex: {
    label: 'Codex',
    bin: () => process.env.CODEX_BIN || 'codex',
    install: 'npm install -g @openai/codex',
    env: (dir) => (dir ? { CODEX_HOME: dir } : {}),
    loginCmd: 'codex login',
    loginHint: 'Tarayicida ChatGPT hesabinla giris yap, sonra terminali kapat.',
    usageCmd: 'codex', usageHint: 'Acilan ekranda /status yaz: kalan limitini gosterir.',
    args: (prompt, perm, model, effort) => [
      'exec', '--skip-git-repo-check',
      ...(perm === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write']),
      ...(model ? ['-m', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      prompt,
    ],
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  antigravity: {
    label: 'Antigravity',
    bin: () => process.env.AGY_BIN || 'agy',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    // agy ayarlarini ~/.gemini/antigravity-cli altinda tutar. Giris bilgisi Mac'te Anahtar Zinciri'nde
    // durdugu icin HOME ayirmak iki hesabi tam ayirmayabilir: Test ile hangi hesabin calistigini kontrol et.
    env: (dir) => (dir ? { HOME: dir } : {}),
    loginCmd: 'agy',
    loginHint: 'Ilk acilista ayarlari gec, Google ile giris yap, sonra /quit yaz.',
    usageCmd: 'agy', usageHint: 'Acilan ekranda /usage yaz: kalan kotani gosterir.',
    args: (prompt, perm, model) => [
      '-p', prompt, '--output-format', 'stream-json',
      ...(perm === 'full' ? ['--dangerously-skip-permissions'] : ['--mode=accept-edits']),
      ...(model ? ['--model', model] : []),
    ],
    stream: 'agy',
  },
  gemini: {
    label: 'Gemini CLI',
    bin: () => process.env.GEMINI_BIN || 'gemini',
    install: 'npm install -g @google/gemini-cli',
    // Gemini CLI ayarlarini ~/.gemini altinda tutar; HOME'u hesaba ozel klasore cekiyoruz.
    env: (dir) => (dir ? { HOME: dir } : {}),
    loginCmd: 'gemini',
    loginHint: '"Login with Google" sec, Antigravity\'de kullandigin Google hesabiyla gir, sonra /quit yaz.',
    usageCmd: 'gemini', usageHint: 'Acilan ekranda /stats yaz: kullanimini gosterir.',
    args: (prompt, perm, model) => [
      '-p', prompt,
      ...(perm === 'full' ? ['--yolo'] : ['--approval-mode', 'auto_edit']),
      ...(model ? ['-m', model] : []),
    ],
  },
};

const agentEnv = (account) => ({ ...process.env, ...TYPES[account.type].env(account.useDefault ? null : account.dir) });

// ---------- Limit yardimcilari ----------
const toMs = (v) => { if (v == null || v === '') return null; if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) { const t = Date.parse(v); return isNaN(t) ? null : t; } const n = Number(v); return n < 1e12 ? n * 1000 : n; };
// unit: 'ratio' (0..1 oran -> 0..100 yuzde; >1 ise zaten yuzde), 'percent' (dogrudan 0..100 yuzde)
function pct(v, unit = 'ratio') {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const val = unit === 'percent' ? n : (n >= 0 && n <= 1 ? n * 100 : n);
  return Math.round(val * 10) / 10;
}

// Hangi alan adlariyla gelirse gelsin 5 saatlik / haftalik pencereleri bul (sema resmi degil, savunmaci okuyoruz)
function extractWindows(obj) {
  const out = {};
  const visit = (o, keyHint, depth) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    const hasRatio = o.utilization != null;
    const used = hasRatio ? o.utilization : (o.used_percentage ?? o.usedPercent ?? o.used_percent ?? o.usedPercentage);
    const reset = o.resetsAt ?? o.resets_at ?? o.resetAt ?? o.reset_at;
    const mins = o.windowDurationMins ?? o.window_minutes ?? o.windowMinutes;
    if (used != null) {
      let slot = null;
      const h = String(keyHint || '').toLowerCase();
      if (mins != null) slot = Number(mins) <= 600 ? 'fiveHour' : 'week';
      else if (/five|5h|hour|primary/.test(h)) slot = 'fiveHour';
      else if (/seven|7d|week|secondary/.test(h)) slot = 'week';
      if (slot && !out[slot]) out[slot] = { pct: pct(used, hasRatio ? 'ratio' : 'percent'), resetsAt: toMs(reset) };
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') visit(v, k, depth + 1);
  };
  visit(obj, '', 0);
  return Object.keys(out).length ? out : null;
}

function parseReset(text, type) {
  const now = Date.now();
  const t = text.slice(-3000);
  let m;
  if ((m = t.match(/limit[^|\n]*\|(\d{10})/i))) return { at: Number(m[1]) * 1000, exact: true };
  if ((m = t.match(/(?:try again|resets?)\s+in\s+(?:(\d+)\s*(?:hours?|h))?\s*(?:(\d+)\s*(?:minutes?|mins?|m))?/i)) && (m[1] || m[2]))
    return { at: now + ((+m[1] || 0) * 60 + (+m[2] || 0)) * 60000, exact: true };
  if ((m = t.match(/(?:try again at|resets?(?: at)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i))) {
    const h = +m[1] % 12 + (m[3] && m[3].toLowerCase() === 'pm' ? 12 : (!m[3] ? Math.floor(+m[1] / 12) * 12 : 0));
    const d = new Date(); d.setHours(h, +m[2] || 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return { at: d.getTime(), exact: true };
  }
  return { at: now + (type === 'gemini' ? 24 : 5) * 3600000, exact: false };
}

// ---------- Claude stream-json'u okunur hale getir ----------
function shortInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.description || input.prompt || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 140);
}
function claudeLine(line, st) {
  let ev; try { ev = JSON.parse(line); } catch { return line + '\n'; }
  if (ev.type === 'rate_limit_event' || ev.rate_limit_info || ev.unifiedWindows) {
    const w = extractWindows(ev); if (w) st.limits = { ...(st.limits || {}), ...w };
    const status = ev.status || ev.rate_limit_info?.status;
    if (status === 'rejected') { st.rejected = true; const r = ev.resetsAt ?? ev.rate_limit_info?.resetsAt; if (r) st.rejectReset = toMs(r); }
    return '';
  }
  if (ev.type === 'assistant' && ev.message?.content) {
    return ev.message.content.map((c) => c.type === 'text' ? c.text + '\n' : c.type === 'tool_use' ? `› ${c.name}${shortInput(c.name, c.input) ? ': ' + shortInput(c.name, c.input) : ''}\n` : '').join('');
  }
  if (ev.type === 'result') {
    st.final = typeof ev.result === 'string' ? ev.result : st.final;
    if (ev.is_error) st.isError = true;
    if (ev.usage) st.usage = ev.usage;
    return `\n[bitti${ev.num_turns ? ` · ${ev.num_turns} adim` : ''}${ev.duration_ms ? ` · ${Math.round(ev.duration_ms / 1000)} sn` : ''}]\n`;
  }
  return '';
}

// ---------- Antigravity (agy) stream-json ----------
function agyLine(line, st) {
  let ev; try { ev = JSON.parse(line); } catch { return line + '\n'; }
  const kind = ev.event || ev.type;
  if (kind === 'step_update') {
    const su = ev.step_update || ev;
    if (su.text_delta) return su.text_delta;
    if (su.tool_info && su.state === 'DONE') {
      const ti = su.tool_info; const prm = ti.parameters || {};
      return `\n› ${ti.name}${shortInput(ti.name, prm) ? ': ' + shortInput(ti.name, prm) : ''}${ti.error ? ' (hata: ' + String(ti.error).slice(0, 120) + ')' : ''}\n`;
    }
    if (su.step_type === 'agent_response' && su.state === 'DONE') return '\n';
    return '';
  }
  if (kind === 'result') {
    const r = ev.result && typeof ev.result === 'object' ? ev.result : ev;
    if (typeof r.response === 'string') st.final = r.response;
    if (r.usage) st.usage = r.usage;
    if (r.status && r.status !== 'SUCCESS') st.isError = true;
    return `\n[bitti${r.num_turns ? ` · ${r.num_turns} adim` : ''}${r.duration_seconds ? ` · ${Math.round(r.duration_seconds)} sn` : ''}]\n${r.error ? 'Hata: ' + r.error + '\n' : ''}`;
  }
  return '';
}
const PARSERS = { claude: claudeLine, agy: agyLine };

// Panel her calistirmayi kaydeder (kullanim takibi icin)
let tracker = null;
const setTracker = (fn) => { tracker = fn; };

// Normal metindeki "429", "quota", "rate_limit" gibi kelimelerle yanlis pozitif vermemesi icin dar eslesme
const LIMIT_RE = /\b(?:usage|spending|billing|message|token|request)\s+limit\s+(?:reached|exceeded|hit|will\s+reset)\b|\b(?:hit|reached|exceeded)\s+(?:your|the)\s+(?:[\w-]+\s+)?limit\b|\blimit\s+(?:reached|exceeded|will\s+reset)\b|\brate[ _-]?limit(?:ed|\s+(?:reached|exceeded|hit|error)|[ _](?:exceeded|error))\b|\b(?:quota\s+(?:exceeded|reached|exhausted|limit|depleted)|(?:exceeded|exhausted|insufficient|over)[ _](?:your\s+)?(?:current\s+)?quota)\b|\b(?:http(?:\/\d(?:\.\d)?)?\s+429|status(?:\s+code)?[:\s]+429|error[:\s]+429|429\s+too\s+many\s+requests)\b|\btoo\s+many\s+requests\b|\bresource[ _]exhausted\b|\bout\s+of\s+credits\b/i;

// Calisan tum alt surecleri takip et; sunucu kapanirken yetim kalmasinlar
const activeChildren = new Set();
function trackChild(child) {
  if (!child || !child.pid) return child;
  activeChildren.add(child);
  const done = () => activeChildren.delete(child);
  child.once('exit', done);
  child.once('close', done);
  child.once('error', done);
  return child;
}

// Surec grubunu oldur (ajanin actigi alt surecler de kapansin)
function killTree(child, sig = 'SIGTERM') {
  if (!child || !child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, sig); return; } catch {}
  }
  try { child.kill(sig); } catch {}
}

function killAllChildren(sig = 'SIGTERM') {
  for (const child of [...activeChildren]) killTree(child, sig);
}

// Kapanista once SIGTERM gonder, kisa sure sonra hala acik kalanlara SIGKILL gonder
function shutdownChildren(graceMs = 1500) {
  if (!activeChildren.size) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const onDone = () => { if (!activeChildren.size) finish(); };
    const list = [...activeChildren];
    for (const c of list) {
      c.once('exit', onDone);
      c.once('close', onDone);
      killTree(c, 'SIGTERM');
    }
    const timer = setTimeout(() => {
      for (const c of [...activeChildren]) killTree(c, 'SIGKILL');
      finish();
    }, graceMs);
    if (timer.unref) timer.unref();
  });
}

// ---------- Token kullanimi ----------
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const pick = (o, keys) => { for (const k of keys) if (o[k] != null) return num(o[k]); return 0; };
// Ajanin verdigi usage nesnesini {in,out,cacheRead,cacheWrite,total,estimated} bicimine cevirir
function normUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const u = {
    in: pick(raw, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokenCount', 'input']),
    out: pick(raw, ['output_tokens', 'outputTokens', 'completion_tokens', 'candidatesTokenCount', 'output']),
    cacheRead: pick(raw, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_input_tokens', 'cachedContentTokenCount']),
    cacheWrite: pick(raw, ['cache_creation_input_tokens', 'cacheCreationInputTokens']),
    estimated: false,
  };
  u.total = u.in + u.out + u.cacheRead + u.cacheWrite;
  if (!u.total) { const t = pick(raw, ['total_tokens', 'totalTokens', 'totalTokenCount']); if (!t) return null; u.total = t; }
  return u;
}
// Codex/Gemini metin ciktisindan "tokens used 1,234" gibi satiri arar
function parseTextUsage(text) {
  const m = String(text || '').slice(-4000).match(/tokens?\s+used\D{0,10}([\d][\d,._]*)/i);
  const n = m && Number(m[1].replace(/[,_]/g, ''));
  return n > 0 ? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: Math.round(n), estimated: false } : null;
}
// Bilgi yoksa karakter/4 ile tahmin
function estimateUsage(prompt, output) {
  const i = Math.ceil(String(prompt || '').length / 4), o = Math.ceil(String(output || '').length / 4);
  return { in: i, out: o, cacheRead: 0, cacheWrite: 0, total: i + o, estimated: true };
}

// Bir ajani calistirir. Promise {code, output, final, limited, reset, limits, usage} doner.
function runAgent(account, { prompt, cwd, perm = 'safe', timeoutMs = 60 * 60 * 1000, onData, signal, kind = 'task' }) {
  const start = Date.now();
  const t = TYPES[account.type];
  if (!t) return Promise.reject(new Error('Bilinmeyen tip: ' + account.type));
  return new Promise((resolve) => {
    let output = '';
    const st = {};
    let child;
    try {
      child = trackChild(spawn(t.bin(), t.args(prompt, perm, account.model, (t.efforts || []).includes(account.effort) ? account.effort : null), {
        cwd, env: agentEnv(account), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      }));
    } catch (e) {
      return resolve({ code: -1, output: String(e), final: '', limited: false });
    }
    const add = (s) => {
      if (!s) return;
      output += s;
      if (output.length > 400000) output = output.slice(-300000);
      onData && onData(s);
    };
    let buf = '';
    child.stdout.on('data', (d) => {
      if (!t.stream) return add(d.toString());
      buf += d.toString();
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) add(PARSERS[t.stream](line, st)); }
    });
    child.stderr.on('data', (d) => add(d.toString()));
    let killTimer;
    const stop = (msg) => { add(msg); killTree(child); killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5000); };
    const timer = setTimeout(() => stop('\n[panel] Zaman asimi, durduruluyor.\n'), timeoutMs);
    const abort = () => stop('\n[panel] Durduruldu.\n');
    signal && signal.addEventListener('abort', abort, { once: true });
    child.on('error', (e) => add(`\n[panel] Calistirilamadi: ${e.message}. "${t.bin()}" kurulu mu? Kurmak icin: ${t.install}\n`));
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (buf.trim() && t.stream) add(PARSERS[t.stream](buf, st));
      signal && signal.removeEventListener('abort', abort);
      code = code ?? -1;
      if (st.isError && code === 0) code = 1;
      const limited = (code !== 0 && LIMIT_RE.test((st.final || '') + '\n' + output.slice(-5000))) || !!st.rejected;
      let reset = null;
      if (limited) {
        const w = st.limits && Object.values(st.limits).filter((x) => x.pct >= 99 && x.resetsAt > Date.now()).sort((a, b) => b.resetsAt - a.resetsAt)[0];
        reset = st.rejectReset ? { at: st.rejectReset, exact: true } : w ? { at: w.resetsAt, exact: true } : parseReset((st.final || '') + '\n' + output, account.type);
      }
      const usage = normUsage(st.usage) || parseTextUsage(output) || estimateUsage(prompt, st.final || output);
      const result = { code, output, final: st.final || output, limited, reset, limits: st.limits || null, usage };
      try { tracker && tracker(account, { start, end: Date.now(), ok: code === 0, limited, reset, kind, limits: result.limits }); } catch {}
      resolve(result);
    });
  });
}

// ---------- Codex: gercek limitleri hak harcamadan oku ----------
// 1) codex app-server (JSON-RPC, satir basina bir JSON)  2) olmazsa son oturum kayitlari
function readCodexLimits(account, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child, done = false, buf = '', timer;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child && killTree(child); } catch {} resolve(v || readCodexRollout(account)); };
    try {
      child = trackChild(spawn(TYPES.codex.bin(), ['app-server'], { env: agentEnv(account), stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' }));
    } catch { return finish(null); }
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ method: 'initialized' }); setTimeout(() => send({ id: 2, method: 'account/rateLimits/read', params: {} }), 300); }
        if (msg.id === 2) finish(msg.result ? extractWindows(msg.result) : null);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai-panel', title: 'AI Panel', version: '0.2.0' } } });
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}
function readTail(filePath, maxBytes = 262144) {
  const st = fs.statSync(filePath);
  if (st.size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}
function readCodexRollout(account) {
  const home = account.useDefault ? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) : account.dir;
  const dir = path.join(home, 'sessions');
  let newest = null;
  const walk = (d, depth) => {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) { try { const m = fs.statSync(p).mtimeMs; if (!newest || m > newest.m) newest = { p, m }; } catch {} }
    }
  };
  walk(dir, 0);
  if (!newest) return null;
  try {
    const lines = readTail(newest.p).trim().split('\n').reverse();
    for (const l of lines.slice(0, 400)) { if (!l.includes('rate_limits')) continue; const w = extractWindows(JSON.parse(l)); if (w) return w; }
  } catch {}
  return null;
}


// ---------- Giris durumu (hak harcamadan) ----------
// true/false: kesin; null: bu arac icin bilinmiyor
function authStatus(account, timeoutMs = 20000) {
  const t = TYPES[account.type];
  let args;
  if (account.type === 'claude') args = ['auth', 'status'];
  else if (account.type === 'codex') args = ['login', 'status'];
  else return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '', child;
    try { child = trackChild(spawn(t.bin(), args, { cwd: os.tmpdir(), env: agentEnv(account), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })); } catch { return resolve(null); }
    const timer = setTimeout(() => { killTree(child, 'SIGKILL'); resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (account.type === 'claude') {
        const m = out.match(/\{[\s\S]*\}/);
        try { return resolve(!!JSON.parse(m[0]).loggedIn); } catch { return resolve(null); }
      }
      resolve(/not logged in/i.test(out) ? false : code === 0 && /logged in/i.test(out) ? true : null);
    });
  });
}

// ---------- Model listesi ----------
const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus (en güçlü)' }, { id: 'sonnet', label: 'Sonnet (dengeli)' }, { id: 'haiku', label: 'Haiku (hızlı, ucuz)' },
];
function runCapture(bin, args, env, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '', child;
    try { child = trackChild(spawn(bin, args, { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' })); } catch { return resolve(''); }
    const timer = setTimeout(() => { killTree(child, 'SIGKILL'); resolve(out); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}
function codexModels(account, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child, done = false, buf = '', timer;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child && killTree(child); } catch {} resolve(v || []); };
    try { child = trackChild(spawn(TYPES.codex.bin(), ['app-server'], { cwd: os.tmpdir(), env: agentEnv(account), stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' })); } catch { return finish([]); }
    child.on('error', () => finish([])); child.on('close', () => finish([]));
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'model/list', params: {} }); }
        if (msg.id === 2) {
          const list = Array.isArray(msg.result) ? msg.result : (msg.result && (msg.result.data || msg.result.models || msg.result.items)) || [];
          finish(list.filter((m) => !m.hidden).map((m) => ({ id: m.model || m.id, label: (m.displayName || m.model || m.id) + (m.isDefault ? ' (varsayılan)' : '') })));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai-panel', title: 'AI Panel', version: '0.4.0' } } });
    timer = setTimeout(() => finish([]), timeoutMs);
  });
}
async function listModels(account) {
  if (account.type === 'claude') return CLAUDE_MODELS;
  if (account.type === 'codex') return codexModels(account);
  if (account.type === 'antigravity') {
    const out = await runCapture(TYPES.antigravity.bin(), ['models'], agentEnv(account));
    return out.split('\n').map((l) => l.split('\t')).filter((x) => x.length >= 2 && /^[\w.-]+$/.test(x[0].trim())).map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
  }
  if (account.type === 'gemini') {
    const out = await runCapture(TYPES.gemini.bin(), ['models', 'list', '-o', 'json'], agentEnv(account));
    try { const j = JSON.parse(out.slice(out.indexOf('['))); return j.map((m) => ({ id: m.id || m.modelId, label: m.displayName || m.id })).filter((m) => m.id && m.id !== 'auto'); } catch { return []; }
  }
  return [];
}

// ---------- Kurulum kontrolu ----------
function doctor() {
  const out = {};
  for (const [k, t] of Object.entries(TYPES)) {
    const r = spawnSync(t.bin(), ['--version'], { encoding: 'utf8', timeout: 8000 });
    out[k] = r.error ? { ok: false, install: t.install } : { ok: true, version: (r.stdout || r.stderr || '').trim().split('\n')[0].slice(0, 60) };
  }
  const g = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 });
  out.git = g.error ? { ok: false, install: 'xcode-select --install' } : { ok: true, version: g.stdout.trim() };
  return out;
}

// Olay dongusunu kilitlemeden paralel kurulum kontrolu
async function doctorAsync() {
  const checkOne = (bin, install, timeout = 8000) => new Promise((resolve) => {
    execFile(bin, ['--version'], { encoding: 'utf8', timeout }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, install });
      else resolve({ ok: true, version: String(stdout || stderr || '').trim().split('\n')[0].slice(0, 60) });
    });
  });
  const entries = Object.entries(TYPES);
  const results = await Promise.all([
    ...entries.map(([, t]) => checkOne(t.bin(), t.install, 8000)),
    checkOne('git', 'xcode-select --install', 5000),
  ]);
  const out = {};
  entries.forEach(([k], i) => { out[k] = results[i]; });
  out.git = results[entries.length];
  return out;
}

module.exports = {
  TYPES, runAgent, normUsage, estimateUsage, authStatus, listModels, setTracker, parseReset, extractWindows, readCodexLimits,
  doctor, doctorAsync, killTree, trackChild, killAllChildren, shutdownChildren, activeChildren, pct, LIMIT_RE,
};
