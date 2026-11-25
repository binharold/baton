// AI Panel - yerel sunucu. Sadece bu bilgisayardan (127.0.0.1) erisilebilir.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Panel bir Claude Code oturumunun icinden baslatilirsa o oturumun degiskenleri (giris, proxy adresi,
// oturum kimligi) isci ajanlara gecer ve "Not logged in" hatasina yol acar. Hepsini temizle.
if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
  for (const k of Object.keys(process.env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'ANTHROPIC_BASE_URL' || k === '__CFBundleIdentifier'
      || /^CLAUDE_(CODE|AGENT_SDK|PREVIEW)_/.test(k)) delete process.env[k];
  }
}
const { execFile, execFileSync, spawn } = require('child_process');
const { TYPES, runAgent, authStatus, listModels, setTracker, readCodexLimits, doctorAsync, killAllChildren, shutdownChildren } = require('./lib/agents');
const { Orchestrator, headTail, buildHistory, lastRealManager, carrySummary, STATUS_TEXTS, isLimited, isGit, cleanupBranches, adoptLegacyMerges } = require('./lib/orchestrator');
const { scanProject, enhancePrompt, extractEnhanced, SAME, isDue, dueKey, dayKey } = require('./lib/smart');
const { computeStats } = require('./lib/stats');
const { focusExisting } = require('./lib/focus');

const PORT = Number(process.env.PORT || 4545);
const HOME = process.env.AI_PANEL_HOME || path.join(os.homedir(), '.ai-panel');
const PUBLIC = path.join(__dirname, 'public');
// Kullanici verisi sadece sahibi tarafindan okunabilsin (klasor 0700, dosya 0600)
fs.mkdirSync(path.join(HOME, 'accounts'), { recursive: true, mode: 0o700 });
// Her acilista yeni oturum jetonu: sayfaya gomulur, GET disindaki istekler ve canli baglanti bunu ister
const TOKEN = crypto.randomBytes(24).toString('hex');
const tokenOk = (given) => { const a = Buffer.from(String(given || '')); const b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};

const id = () => crypto.randomBytes(4).toString('hex');
const tail = (s, n) => (s && s.length > n ? '...\n' + s.slice(-n) : s || '');
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const resolveDir = (d) => path.resolve(expand(String(d || '').trim()) || os.homedir());
// Klasorsuz (bulut) mod: cloud:true ya da dir bos. Bos dir ASLA ev klasorune dusmez
const isCloud = (p) => !!p && (p.cloud === true || !String(p.dir || '').trim());
// Projenin calisma klasoru: bulut modda HOME/workspaces/<id> (0700), degilse secilen klasor
function workDir(p) {
  if (!isCloud(p)) return resolveDir(p.dir);
  const d = path.join(HOME, 'workspaces', String(p.id).replace(/[^\w-]/g, '_'));
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
const CLOUD_NOTE = 'Bu proje yerel bir klasore bagli degil (bulut/uzak is). Calisma klasoru bos ve gecici; is uzak servislerde ya da komutlarla yapilir. Raporda hangi uzak kaynagi degistirdigini acikca yaz.';

// ---------------- Durum ----------------
// accounts: hesaplar · projects: her projenin klasoru, notu, bitis adimi ve sohbeti
// runs: calismalar · settings: ekip ve genel ayarlar · templates: kayitli mesaj sablonlari
const STATE_FILE = path.join(HOME, 'state.json');
const DEFAULT_SETTINGS = { managerId: '', workerIds: null, perm: 'full', maxRounds: 2, timeoutMin: 60, waitForLimits: true, notify: true, notifySound: false, managerWorks: false, lastProjectId: '', managerRules: '' };
const DEFAULT_FINISH = { mode: 'none', text: '' };
const store = {
  home: HOME,
  state: { accounts: [], projects: [], runs: [], settings: { ...DEFAULT_SETTINGS }, templates: [] },
  _timer: null,
  _maxTimer: null,
  _dirty: false,
  _lastSaved: null,
  // Port alinana kadar (ikinci ornek olabilir) state dosyasina yazma
  _owner: false,
  // Diske yazmayi topla (debounce + en fazla 2 sn bekleme); kapanista hemen yaz
  save() {
    this._dirty = true;
    bumpState();
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 400);
    if (!this._maxTimer) this._maxTimer = setTimeout(() => this.saveNow(), 2000);
  },
  saveNow() {
    if (!this._owner) return;
    clearTimeout(this._timer); this._timer = null;
    clearTimeout(this._maxTimer); this._maxTimer = null;
    if (!this._dirty && this._lastSaved !== null) return;
    this._dirty = false;
    const st = this.state;
    const runs = st.runs.slice(-40).map((r) => (['running', 'queued'].includes(r.status) ? r : slimRun(r, 30000)));
    const projects = st.projects.map((p) => ({ ...p, messages: p.messages.slice(-300) }));
    const data = JSON.stringify({ ...st, runs, projects });
    if (data === this._lastSaved) return;
    fs.writeFileSync(STATE_FILE + '.tmp', data, { mode: 0o600 });
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    this._lastSaved = data;
  },
};
const S = store.state;
try { const raw = fs.readFileSync(STATE_FILE, 'utf8'); Object.assign(S, JSON.parse(raw)); store._lastSaved = raw; } catch {}
S.settings = { ...DEFAULT_SETTINGS, ...(S.settings || {}) };
S.accounts ||= []; S.runs ||= []; S.projects ||= []; S.templates ||= []; S.schedules ||= [];
// Eski surumden gecis: tek sohbet -> "Genel" projesi
if (S.chat || !S.projects.length) {
  const old = S.settings.projectDir || '';
  const p = { id: id(), name: old ? path.basename(old) : 'Genel', dir: old, notes: '', finish: { ...DEFAULT_FINISH }, createdAt: Date.now(), messages: S.chat || [] };
  S.projects.push(p);
  for (const r of S.runs) r.projectId ||= p.id;
  delete S.chat;
}
delete S.settings.projectDir; delete S.settings.autoSubmit;
for (const p of S.projects) { p.finish ||= { ...DEFAULT_FINISH }; p.notes ||= ''; p.messages ||= []; }
function recoverInterruptedRuns() {
  const now = Date.now();
  for (const r of S.runs) {
    const live = ['running', 'queued'].includes(r.status);
    // Eski surum yalnizca ust kaydi durdurup bitis zamanini bos birakiyordu: sadece onar, cevaba ve sohbete dokunma
    if (!live && !(r.status === 'stopped' && !r.finishedAt)) continue;
    r.status = 'stopped'; r.finishedAt = now; r.waitingUntil = null;
    if (live) r.reply = 'Panel yeniden başlatıldığı için iş durduruldu.';
    for (const round of r.rounds || []) {
      for (const task of round.tasks || []) {
        // Commit'i hazir, dogrulamasi yarida kalan gorev done kalir; dogrulama sonucu bos birakilir
        if (task.status === 'done') { if (task.phase) { task.phase = null; delete task.check; } continue; }
        if (!['running', 'queued', 'pending'].includes(task.status) && !task.phase) continue;
        task.status = 'stopped'; task.endedAt = now; task.phase = null;
        try { orch.recoverTaskWorktree(r, task); } catch {}
      }
    }
    if (r.submit?.status === 'running') { r.submit.status = 'stopped'; r.submit.endedAt = now; }
    const p = proj(r.projectId);
    if (live && p && r.fromChat) p.messages.push({ id: id(), role: 'manager', text: r.reply, runId: r.id, status: r.status, at: now });
    store.save();
  }
}
// ---- Uygulama surumu ve yeniden baslatma ----
const readHead = () => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const BOOT_HEAD = readHead();
const BOOT_ID = crypto.randomBytes(8).toString('hex');
let headCache = { v: BOOT_HEAD, at: Date.now() };
const curHead = () => { if (Date.now() - headCache.at > 30000) headCache = { v: readHead(), at: Date.now() }; return headCache.v; };
let restartPending = false;
const hasLiveRun = () => S.runs.some((r) => ['running', 'queued'].includes(r.status));
function appInfo() {
  const head = curHead();
  return { bootHead: BOOT_HEAD, head, updateAvailable: !!(BOOT_HEAD && head && head !== BOOT_HEAD), bootId: BOOT_ID, restartPending };
}
let restartTimer = null;
function doRestart() {
  if (shuttingDown) return;
  // Durum dosyasi yeni ornek acilmadan once guncel olsun
  try { store.saveNow(); } catch {}
  if (process.env.AI_PANEL_NO_RESPAWN) {
    // Test: gercek yeniden baslatma yok; sadece bekleme bitti diye isaretle
    restartPending = false; store.save(); emit('state', {}); return;
  }
  {
    try {
      let out = 'ignore';
      try { const st = fs.fstatSync(1); if (st.isFile() || st.isCharacterDevice()) out = 1; } catch {}
      if (out === 'ignore') { try { out = fs.openSync(path.join(os.tmpdir(), 'ai-panel-restart.log'), 'a'); } catch {} }
      spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname, env: { ...process.env, AI_PANEL_RESTARTED: '1' }, detached: true, stdio: ['ignore', out, out],
      }).unref();
    } catch (e) { console.log('Yeniden baslatma hatasi: ' + e.message); restartPending = false; store.save(); emit('state', {}); return; }
  }
  exitSave();
}
function checkRestart() {
  if (!restartPending) { clearInterval(restartTimer); restartTimer = null; return; }
  if (!hasLiveRun()) { clearInterval(restartTimer); restartTimer = null; doRestart(); }
}
function setRestartPending(on) {
  restartPending = on; bumpState(); emit('state', {});
  if (on && !restartTimer) restartTimer = setInterval(checkRestart, 2000);
  if (!on && restartTimer) { clearInterval(restartTimer); restartTimer = null; }
}
let shuttingDown = false;
const exitSave = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { store.saveNow(); } catch {}
  try { server.close(); } catch {}
  shutdownChildren(1000).finally(() => process.exit(0));
};
process.on('SIGINT', exitSave); process.on('SIGTERM', exitSave);
process.on('exit', () => killAllChildren('SIGKILL'));

// ---------------- Canli guncellemeler (SSE) ----------------
const clients = new Set();
let stateVer = 0;
let stateCache = { ver: -1, at: 0, str: '', etag: '' };
function bumpState() { stateVer++; }
function buildStateSnapshot() {
  const now = Date.now();
  if (stateCache.ver === stateVer && now - stateCache.at < 5000 && stateCache.str) return stateCache;
  const busy = busyAccounts();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();
  const pids = new Set(S.projects.map((x) => x.id));
  const str = JSON.stringify({
    accounts: S.accounts.map((a) => publicAcct(a, busy, now, midnightMs)),
    projects: S.projects,
    runs: S.runs.filter((r) => pids.has(r.projectId)).slice(-60).map((r) => slimRun(r)),
    settings: S.settings, templates: S.templates, schedules: S.schedules,
    types: Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, t.label])),
    efforts: Object.fromEntries(Object.entries(TYPES).filter(([, t]) => t.efforts).map(([k, t]) => [k, t.efforts])),
    home: HOME, platform: process.platform, app: appInfo(),
  });
  const etag = '"' + crypto.createHash('sha1').update(str).digest('base64url').slice(0, 16) + '"';
  stateCache = { ver: stateVer, at: now, str, etag };
  return stateCache;
}
let lastStateEtag = '';
const lastRunSig = new Map();
const emit = (type, data) => {
  if (type === 'state' || type === 'run' || type === 'log') bumpState();
  if (!clients.size) return;
  if (type === 'chunk' && (!data || !data.d)) return;
  let payload = data;
  if (type === 'state') {
    const snap = buildStateSnapshot();
    if (snap.etag === lastStateEtag) return;
    lastStateEtag = snap.etag;
    payload = { v: snap.etag };
  } else if (type === 'run' && data && data.id) {
    // Buyuk run nesnesini SSE'den yollamak yerine sadece degisen ozeti kontrol et
    const sig = JSON.stringify([
      data.status, data.waitingUntil || 0, data.bestBranch || '', data.submit?.status || '',
      (data.rounds || []).map((R) => (R.tasks || []).map((t) => `${t.id}:${t.status}:${t.phase || ''}:${t.merged ? 1 : 0}`).join(',')).join('|'),
    ]);
    if (lastRunSig.get(data.id) === sig) return;
    lastRunSig.set(data.id, sig);
    if (lastRunSig.size > 100) lastRunSig.delete(lastRunSig.keys().next().value);
    payload = { id: data.id, status: data.status, projectId: data.projectId };
  }
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of [...clients]) {
    if (c.destroyed || c.writableEnded) { clients.delete(c); continue; }
    try { c.write(msg); } catch { clients.delete(c); }
  }
};

// ---------------- Kullanim ve limitler ----------------
const WEEK = 7 * 24 * 3600000;
setTracker((account, ev) => {
  const a = S.accounts.find((x) => x.id === account.id);
  if (!a) return;
  a.usage = (a.usage || []).filter((u) => u.end > Date.now() - WEEK).slice(-2000);
  a.usage.push({ start: ev.start, end: ev.end, ok: ev.ok, limited: ev.limited, kind: ev.kind });
  if (ev.limits) applyLimits(a, ev.limits);
  if (ev.limited && ev.reset) { a.limitUntil = ev.reset.at; a.limitExact = ev.reset.exact; a.limitHitAt = Date.now(); }
  else if (ev.ok && !(a.limits && limitFromWindows(a.limits))) a.limitUntil = null;
  store.save(); emit('state', {});
});
function limitFromWindows(l) {
  const full = ['fiveHour', 'week'].map((k) => l[k]).filter((w) => w && w.pct >= 100 && w.resetsAt > Date.now());
  return full.length ? Math.max(...full.map((w) => w.resetsAt)) : null;
}
function applyLimits(a, w) {
  a.limits = { ...(a.limits || {}), ...w, at: Date.now() };
  const until = limitFromWindows(a.limits);
  if (until) { a.limitUntil = until; a.limitExact = true; a.limitHitAt ||= Date.now(); }
}
async function refreshLimits(a) {
  if (a.type === 'codex') { const w = await readCodexLimits(a); if (w) { applyLimits(a, w); store.save(); emit('state', {}); } return !!w; }
  if (a.type === 'claude') { const r = await runAgent(a, { prompt: 'Sadece OK yaz.', cwd: os.tmpdir(), timeoutMs: 120000, kind: 'probe' }); return !!r.limits; }
  return false;
}
// Codex limitleri hak harcamadan okunabiliyor: 10 dakikada bir yenile
setInterval(() => { for (const a of S.accounts) if (a.type === 'codex' && !busyAccounts().has(a.id)) refreshLimits(a).catch(() => {}); }, 10 * 60000);
setTimeout(() => { for (const a of S.accounts) if (a.type === 'codex') refreshLimits(a).catch(() => {}); }, 3000);

// Giris durumu: hak harcamadan kontrol (Claude: auth status, Codex: login status)
async function checkAuth(a) {
  const r = await authStatus(a).catch(() => null);
  if (r === null || !S.accounts.includes(a)) return null;
  const changed = !a.auth || a.auth.ok !== r;
  a.auth = { ok: r, at: Date.now() };
  if (r && a.lastTest && !a.lastTest.ok && !a.lastTest.limited) a.lastTest = null; // eski "giris gerekli" sonucunu temizle
  if (changed) { store.save(); emit('state', {}); }
  return r;
}
const checkAllAuth = () => { for (const a of S.accounts) if (!busyAccounts().has(a.id)) checkAuth(a).catch(() => {}); };
setTimeout(checkAllAuth, 2000);
setInterval(checkAllAuth, 5 * 60000);
// Giris terminali acildiktan sonra 10 dk boyunca birkac saniyede bir bak: giris yapilinca kendiliginden yesile doner
const loginWatch = new Map();
function watchLogin(a) {
  if (!['claude', 'codex'].includes(a.type)) return;
  clearInterval(loginWatch.get(a.id));
  const until = Date.now() + 10 * 60000;
  const iv = setInterval(async () => {
    if (Date.now() > until || !S.accounts.includes(a)) { clearInterval(iv); loginWatch.delete(a.id); return; }
    if (await checkAuth(a)) { clearInterval(iv); loginWatch.delete(a.id); emit('notice', { text: `${a.name}: giriş yapıldı`, kind: 'ok' }); }
  }, 4000);
  loginWatch.set(a.id, iv);
}
const modelCache = new Map();

function busyAccounts() {
  const set = new Set();
  for (const r of S.runs) {
    if (r.status !== 'running') continue;
    for (const R of r.rounds) for (const t of R.tasks || []) if (t.status === 'running') set.add(t.assigneeId);
    const lastR = r.rounds.at(-1);
    if (lastR && !(lastR.tasks || []).some((t) => t.status === 'running')) set.add(r.managerId); // yonetici dusunuyor
    if (r.submit && r.submit.status === 'running') set.add(r.managerId);
  }
  return set;
}
function usageSummary(a, busy, now = Date.now(), midnightMs = null) {
  const u = a.usage || [];
  const cut5h = now - 5 * 3600000;
  if (midnightMs == null) { const m = new Date(now); m.setHours(0, 0, 0, 0); midnightMs = m.getTime(); }
  let runs5h = 0, ms5h = 0, runsToday = 0, msToday = 0;
  for (const x of u) {
    if (x.end > cut5h) { runs5h++; ms5h += x.end - x.start; }
    if (x.end > midnightMs) { runsToday++; msToday += x.end - x.start; }
  }
  const lim = isLimited(a);
  return {
    runs5h, mins5h: Math.round(ms5h / 60000), runsToday, minsToday: Math.round(msToday / 60000),
    limited: lim, limitUntil: lim ? a.limitUntil : null, limitExact: !!a.limitExact,
    lastLimitAt: a.limitHitAt || null, limits: a.limits || null, busy: busy.has(a.id),
  };
}

let doctorCache = null, doctorPending = null;
async function getDoctor() {
  if (doctorCache && Date.now() - doctorCache.at <= 60000) return doctorCache.data;
  if (!doctorPending) doctorPending = doctorAsync().then((data) => { doctorCache = { at: Date.now(), data }; doctorPending = null; return data; });
  return doctorPending;
}

// Bildirimler: gorunur istemci varsa atlanir, kisa surede biten isler tek bildirimde toplanir
const NOTIFY_GROUP_MS = Number(process.env.AI_PANEL_NOTIFY_GROUP_MS) || 10000;
const VISIBLE_TTL_MS = 30000;
let uiVisibleAt = 0; // istemcinin en son "gorunur" dedigi an (gizlenince 0)
let notifyQueue = [], notifyTimer = null;
function deliverNotification(title, text) {
  // Test ortami: gercek osascript yerine log dosyasina yaz
  if (process.env.AI_PANEL_NOTIFY_LOG) { try { fs.appendFileSync(process.env.AI_PANEL_NOTIFY_LOG, JSON.stringify({ title, text }) + '\n'); } catch {} return; }
  if (process.platform !== 'darwin') return;
  const q = (x) => String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 200);
  const sound = S.settings.notifySound ? ' sound name "Glass"' : '';
  execFile('osascript', ['-e', `display notification "${q(text)}" with title "${q(title)}"${sound}`], () => {});
}
function flushNotifications() {
  notifyTimer = null;
  const list = notifyQueue; notifyQueue = [];
  if (!list.length || !S.settings.notify) return;
  if (uiVisibleAt && Date.now() - uiVisibleAt < VISIBLE_TTL_MS) return; // panel onde, bildirim gereksiz
  if (list.length === 1) return deliverNotification(list[0].title, list[0].text);
  const errs = list.filter((x) => x.status === 'error').length;
  deliverNotification(`${list.length} iş bitti`, errs ? `${errs} işte hata var.` : 'Ayrıntılar panelde.');
}
function notify(title, text, status) {
  if (status !== 'done' && status !== 'error') return; // durdurulan isler icin bildirim yok
  notifyQueue.push({ title, text, status });
  if (!notifyTimer) notifyTimer = setTimeout(flushNotifications, NOTIFY_GROUP_MS);
}

// ---------------- Projeler ve sohbet ----------------
const proj = (pid) => S.projects.find((p) => p.id === pid);
const activeRun = (pid) => S.runs.find((r) => r.projectId === pid && ['running', 'queued'].includes(r.status));
function sysMsg(p, text) { p.messages.push({ id: id(), role: 'system', text, at: Date.now() }); store.save(); emit('state', {}); }

// ---------------- Zamanlanmis gorevler ----------------
// Saati gelen gorev, kullanici yazmis gibi projenin sohbetine eklenir ve siraya girer.
function fireSchedule(s) {
  const p = proj(s.projectId);
  if (!p) { s.enabled = false; store.save(); return null; }
  const now = new Date();
  s.lastKey = dueKey(s, now) || dayKey(now); s.lastRunAt = now.getTime();
  const msg = { id: id(), role: 'user', text: s.text, at: now.getTime(), queued: true, mode: s.mode === 'race' ? 'race' : 'split', scheduled: s.id };
  p.messages.push(msg); store.save(); emit('state', {});
  nextQueued(p.id);
  return msg;
}
setInterval(() => { for (const s of S.schedules) if (isDue(s)) fireSchedule(s); }, 30000);
function teamIds() {
  const ids = new Set(S.accounts.map((a) => a.id));
  const list = (S.settings.workerIds || S.accounts.map((a) => a.id)).filter((x) => ids.has(x) && x !== S.settings.managerId);
  // Ayarlarda acildiysa yonetici de ekipte isci olarak is alir
  if (S.settings.managerWorks && ids.has(S.settings.managerId)) list.push(S.settings.managerId);
  return list;
}
function newRun(p, fields) {
  const s = S.settings;
  const run = {
    id: id(), projectId: p.id, projectName: p.name, projectDir: workDir(p), cloud: isCloud(p),
    // Proje notu bossa klasor taranir: dil ve test komutu otomatik olarak ekibe iletilir
    notes: [s.managerRules ? `Genel kurallar (her projede gecerli):\n${String(s.managerRules).slice(0, 6000)}` : '',
      isCloud(p) ? [CLOUD_NOTE, p.notes].filter(Boolean).join('\n') : p.notes || (() => { const n = scanProject(workDir(p)).notes; return n ? `Otomatik algilanan:\n${n}` : ''; })()].filter(Boolean).join('\n\n'),
    finish: p.finish || { ...DEFAULT_FINISH }, managerId: s.managerId, workerIds: teamIds(),
    setup: p.setup || '', copyFiles: p.copyFiles || '', check: p.autoCheck ? (p.check || '') : '',
    perm: s.perm === 'safe' ? 'safe' : 'full', waitForLimits: s.waitForLimits !== false,
    maxRounds: Math.min(Math.max(Number(s.maxRounds) || 2, 1), 10),
    timeoutMs: Math.min(Math.max(Number(s.timeoutMin) || 60, 1), 600) * 60000,
    status: 'queued', rounds: [], log: [], createdAt: Date.now(), mode: 'split', ...fields,
  };
  S.runs.push(run); store.save(); emit('run', run);
  orch.start(run);
  return run;
}
function checkReady(p) {
  if (!isCloud(p)) {
    const dir = resolveDir(p.dir);
    if (!fs.existsSync(dir)) return 'Proje klasörü bulunamadı: ' + dir;
  }
  if (!S.accounts.some((a) => a.id === S.settings.managerId)) return 'Önce bir yönetici seç.';
  if (!teamIds().length) return 'Ayarlardan en az bir işçi seç.';
  return null;
}
function startFromChat(p, msg) {
  const err = checkReady(p);
  if (err) { msg.queued = false; msg.dropped = true; return sysMsg(p, err); }
  const history = buildHistory(p.messages, msg);
  const race = msg.mode === 'race';
  const baseRounds = Math.min(Math.max(Number(S.settings.maxRounds) || 2, 1), 10);
  const fields = { goal: msg.text, history, fromChat: msg.id, mode: race ? 'race' : 'split', maxRounds: race ? Math.max(2, baseRounds) : baseRounds };
  if (race) {
    // Yaris: ayni gorev her isciye; sonra yonetici hakem olarak en iyisini secer
    fields.presetTasks = teamIds().map((w) => ({
      assigneeId: w, title: 'Yarış: ' + msg.text.replace(/\s+/g, ' ').slice(0, 60),
      instructions: msg.text + '\n\nBu bir yaris: ayni gorevi baska isciler de bagimsiz olarak cozuyor. Kendi en iyi cozumunu uret ve sonucunu olcum/kanitla raporla.',
    }));
  }
  msg.queued = false;
  const run = newRun(p, fields);
  msg.runId = run.id; store.save();
}
function nextQueued(pid) {
  const p = proj(pid);
  while (p && !shuttingDown && !activeRun(pid)) {
    const msg = p.messages.find((m) => m.queued);
    if (!msg) return;
    try { startFromChat(p, msg); }
    catch (e) { msg.queued = false; msg.dropped = true; sysMsg(p, 'Hata: ' + e.message); }
  }
}
const orch = new Orchestrator(store, emit, {
  onFinish(run) {
    const p = proj(run.projectId);
    if (p && run.fromChat) {
      const text = run.reply || run.result || ({ stopped: STATUS_TEXTS[0], error: STATUS_TEXTS[2] }[run.status]) || STATUS_TEXTS[1];
      p.messages.push({ id: id(), role: 'manager', text, runId: run.id, status: run.status, at: Date.now(), ...(run.status === 'done' && run.next && run.next.length ? { next: run.next } : {}) });
      store.save(); emit('state', {});
      notify(`${p.name}: ${run.status === 'done' ? 'iş bitti' : 'hata'}`, text.replace(/[*_`#>|]/g, '').split('\n').find((l) => l.trim()) || '', run.status);
    }
    setTimeout(() => nextQueued(run.projectId), 100);
  },
});

// ---------------- Yardimcilar ----------------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, bad) => {
  let s = ''; req.on('data', (d) => { s += d; if (s.length > 2e6) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
});
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function terminalCommand(a, which) {
  const t = TYPES[a.type];
  const envs = Object.entries(t.env(a.useDefault ? null : a.dir)).map(([k, v]) => `export ${k}=${shq(v)}; `).join('');
  const cmd = which === 'usage' ? t.usageCmd : t.loginCmd;
  const hint = which === 'usage' ? t.usageHint : t.loginHint;
  return `${envs}echo ${shq(`== ${a.name} == ${hint}`)}; ${cmd.replace(/^\S+/, t.bin())}`;
}
function openTerminal(cmd) {
  return new Promise((ok) => {
    if (process.platform !== 'darwin') return ok(false);
    const as = `tell application "Terminal"\n activate\n do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    execFile('osascript', ['-e', as], (err) => ok(!err));
  });
}
const execGitAsync = (dir, args) => new Promise((ok) => {
  execFile('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 8000 }, (err, stdout) => ok(err ? null : String(stdout || '').trim()));
});
async function gitInfo(dirRaw) {
  if (!dirRaw) return { set: false };
  const dir = resolveDir(dirRaw);
  if (!fs.existsSync(dir)) return { set: true, dir, exists: false };
  const [wt, branch, status, branches] = await Promise.all([
    execGitAsync(dir, ['rev-parse', '--is-inside-work-tree']),
    execGitAsync(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    execGitAsync(dir, ['status', '--porcelain', '--untracked-files=no']),
    execGitAsync(dir, ['branch', '--list', 'ai-panel/*']),
  ]);
  const out = { set: true, dir, exists: true, isGit: wt === 'true' };
  if (out.isGit) {
    out.branch = branch || '';
    out.dirty = (status || '').split('\n').filter(Boolean).length;
    out.panelBranches = (branches || '').split('\n').filter(Boolean).length;
  }
  return out;
}
// Ekrana gonderirken buyuk ciktilari kirp (her olayda yenilendigi icin onemli)
function slimRun(r, n = 8000) {
  const { presetTasks, history, ...rest } = r;
  return {
    ...rest,
    rounds: r.rounds.map((R) => ({ ...R, managerOutput: tail(R.managerOutput, Math.min(n, 5000)), tasks: (R.tasks || []).map((t) => ({ ...t, output: tail(t.output, n), report: tail(t.report, 6000) })) })),
    submit: r.submit && { ...r.submit, output: tail(r.submit.output, Math.min(n, 6000)) },
    log: (r.log || []).slice(-120),
  };
}
const publicAcct = (a, busy, now, midnightMs) => { const { usage, ...rest } = a; return { ...rest, typeLabel: TYPES[a.type]?.label, stats: usageSummary(a, busy, now, midnightMs) }; };
const findTask = (run, tid) => run && run.rounds.flatMap((R) => R.tasks || []).find((t) => t.id === tid);
const runBranches = (list) => list.flatMap((r) => (r.rounds || []).flatMap((R) => (R.tasks || []).map((t) => t.branch).filter(Boolean)));

// ---------------- HTTP ----------------
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/tokens.css': 'tokens.css', '/style.css': 'style.css', '/prompts.js': 'prompts.js', '/i18n.js': 'i18n.js', '/themes.css': 'themes.css', '/theme.js': 'theme.js' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const staticCache = new Map();
function readStatic(f) {
  const full = path.join(PUBLIC, f);
  const now = Date.now();
  const c = staticCache.get(f);
  if (c && now - c.checkedAt < 2000) return c;
  const st = fs.statSync(full);
  if (c && c.mtimeMs === st.mtimeMs) { c.checkedAt = now; return c; }
  const buf = fs.readFileSync(full);
  const entry = { buf, mtimeMs: st.mtimeMs, checkedAt: now, etag: `"${st.mtimeMs.toString(36)}-${buf.length.toString(36)}"` };
  staticCache.set(f, entry);
  return entry;
}

const server = http.createServer(async (req, res) => {
  // Baska sitelerin tarayicindan bu panele istek atmasini engelle
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'forbidden host' });
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  if (req.method !== 'GET' && req.headers['x-ai-panel'] !== '1') return json(res, 403, { error: 'missing header' });
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method !== 'GET' && !tokenOk(req.headers['x-ai-token'])) return json(res, 403, { error: 'Oturum jetonu geçersiz. Sayfayı yenile.' });
  let m;
  try {
    if (req.method === 'GET' && STATIC[p]) {
      const f = STATIC[p];
      const entry = readStatic(f);
      // index.html'e oturum jetonu gomulur; jeton her surecte degisir, ETag'e de katilir
      const isIndex = f === 'index.html';
      const etag = isIndex ? entry.etag.slice(0, -1) + '-' + TOKEN.slice(0, 8) + '"' : entry.etag;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-cache', ETag: etag });
      return res.end(isIndex ? entry.buf.toString('utf8').replace('__AIP_TOKEN__', TOKEN) : entry.buf);
    }
    if (p === '/api/events') {
      if (!tokenOk(url.searchParams.get('t'))) return json(res, 403, { error: 'Oturum jetonu geçersiz. Sayfayı yenile.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'GET' && p === '/api/state') {
      const snap = buildStateSnapshot();
      if (req.headers['if-none-match'] === snap.etag) { res.writeHead(304, { ETag: snap.etag, 'Cache-Control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: snap.etag });
      return res.end(snap.str);
    }
    if (req.method === 'GET' && p === '/api/doctor') return json(res, 200, await getDoctor());
    if (req.method === 'GET' && p === '/api/git-info') return json(res, 200, await gitInfo(url.searchParams.get('dir')));
    if (req.method === 'POST' && p === '/api/pick-folder') {
      if (process.platform !== 'darwin') return json(res, 200, { unsupported: true });
      return execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Proje klasörünü seç")'], { timeout: 300000 }, (err, out) => {
        if (err) return json(res, 200, { cancelled: true });
        json(res, 200, { dir: String(out).trim().replace(/\/$/, '') });
      });
    }
    if (req.method === 'POST' && p === '/api/restart') {
      const b = await body(req);
      if (b.cancel) { setRestartPending(false); return json(res, 200, { ok: true, restartPending: false }); }
      if (hasLiveRun()) { setRestartPending(true); return json(res, 200, { ok: true, restartPending: true }); }
      json(res, 200, { ok: true, restarting: true });
      setTimeout(doRestart, 300);
      return;
    }
    if (req.method === 'POST' && p === '/api/visibility') {
      const b = await body(req);
      uiVisibleAt = b.visible ? Date.now() : 0;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/settings') {
      const b = await body(req);
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in b) S.settings[k] = b[k];
      store.save(); emit('state', {}); return json(res, 200, S.settings);
    }

    // ---- Projeler ----
    if (req.method === 'POST' && p === '/api/projects') {
      const b = await body(req);
      const dir = String(b.dir || '').trim();
      const pr = { id: id(), name: String(b.name || '').trim().slice(0, 60) || (dir ? path.basename(resolveDir(dir)) : 'Yeni proje'), dir, cloud: b.cloud === true, notes: '', finish: { ...DEFAULT_FINISH }, createdAt: Date.now(), messages: [] };
      S.projects.push(pr); S.settings.lastProjectId = pr.id; store.save(); emit('state', {});
      return json(res, 200, pr);
    }
    if ((m = p.match(/^\/api\/projects\/([\w-]+)(?:\/(\w+))?$/))) {
      const pr = proj(m[1]);
      if (!pr) return json(res, 404, { error: 'Proje yok' });
      if (req.method === 'DELETE' && !m[2]) {
        const removed = S.runs.filter((r) => r.projectId === pr.id);
        for (const r of removed) orch.stop(r.id);
        S.projects = S.projects.filter((x) => x !== pr); S.runs = S.runs.filter((r) => r.projectId !== pr.id);
        if (!S.projects.length) S.projects.push({ id: id(), name: 'Genel', dir: '', notes: '', finish: { ...DEFAULT_FINISH }, createdAt: Date.now(), messages: [] });
        if (S.settings.lastProjectId === pr.id) S.settings.lastProjectId = S.projects[0].id;
        // Sadece birlesmis ya da bos dallar temizlenir; incelenmemis is dallari kalir (onay metni boyle soyluyor)
        if (!isCloud(pr)) { try { cleanupBranches(store, { projectDir: resolveDir(pr.dir) }); } catch {} }
        store.save(); emit('state', {}); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && !m[2]) {
        const b = await body(req);
        if (typeof b.name === 'string' && b.name.trim()) pr.name = b.name.trim().slice(0, 60);
        if (typeof b.dir === 'string') pr.dir = b.dir.trim();
        if (typeof b.cloud === 'boolean') pr.cloud = b.cloud;
        if (typeof b.notes === 'string') pr.notes = b.notes.slice(0, 8000);
        if (b.finish && ['none', 'merge', 'custom'].includes(b.finish.mode)) pr.finish = { mode: b.finish.mode, text: String(b.finish.text || '').slice(0, 4000) };
        // Calisma kopyasi hazirligi ve otomatik dogrulama
        if (typeof b.setup === 'string') pr.setup = b.setup.trim().slice(0, 1000);
        if (typeof b.copyFiles === 'string') pr.copyFiles = b.copyFiles.trim().slice(0, 500);
        if (typeof b.check === 'string') pr.check = b.check.trim().slice(0, 1000);
        if (typeof b.autoCheck === 'boolean') pr.autoCheck = b.autoCheck;
        store.save(); emit('state', {}); return json(res, 200, pr);
      }
      if (req.method === 'POST' && m[2] === 'resume') {
        nextQueued(pr.id); emit('state', {});
        return json(res, 200, { ok: true, started: !!activeRun(pr.id) });
      }
      if (req.method === 'POST' && m[2] === 'clear') {
        if (activeRun(pr.id)) return json(res, 409, { error: 'Bu projede çalışan bir iş var. Önce durdur.' });
        const b = await body(req).catch(() => ({}));
        // Yeni sohbete gec: onceki sohbetin kirpilmis ozeti ilk mesaj olur (ek model cagrisi yok)
        const carry = b.carry ? carrySummary(pr.messages) : '';
        pr.messages = carry ? [{ id: id(), role: 'manager', text: carry, carried: true, at: Date.now() }] : []; S.runs = S.runs.filter((r) => r.projectId !== pr.id);
        // Sadece birlesmis ya da bos dallar temizlenir; incelenmemis is dallari kalir (onay metni boyle soyluyor)
        if (!isCloud(pr)) { try { cleanupBranches(store, { projectDir: resolveDir(pr.dir) }); } catch {} }
        store.save(); emit('state', {}); return json(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && p === '/api/chat') {
      const b = await body(req);
      const pr = proj(b.projectId) || S.projects[0];
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { error: 'Boş mesaj' });
      const msg = { id: id(), role: 'user', text, at: Date.now(), queued: true, mode: b.mode === 'race' ? 'race' : 'split' };
      pr.messages.push(msg); S.settings.lastProjectId = pr.id; store.save(); emit('state', {});
      nextQueued(pr.id);
      return json(res, 200, msg);
    }

    // ---- Akilli ozellikler ----
    if (req.method === 'GET' && p === '/api/project-scan') return json(res, 200, scanProject(url.searchParams.get('dir') ? resolveDir(url.searchParams.get('dir')) : ''));
    if (req.method === 'GET' && p === '/api/stats') {
      const days = [7, 30, 0].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
      return json(res, 200, computeStats(S, { days, projectId: url.searchParams.get('project') || '' }));
    }
    if (req.method === 'POST' && p === '/api/enhance') {
      const b = await body(req);
      const text = String(b.text || '').trim().slice(0, 6000);
      if (!text) return json(res, 400, { error: 'Boş metin' });
      const pr = proj(b.projectId);
      const ok = (a) => a && !isLimited(a) && !(a.auth && a.auth.ok === false);
      // Hesap secimi: once mesgul olmayan, sonra limiti en dusuk olan; esitlikte yonetici
      const busy = busyAccounts();
      const load = (a) => Math.max(0, ...['fiveHour', 'week'].map((k) => Number(a.limits?.[k]?.pct) || 0));
      const cands = S.accounts.filter(ok).sort((x, y) => (busy.has(x.id) - busy.has(y.id)) || (load(x) - load(y)) || ((y.id === S.settings.managerId) - (x.id === S.settings.managerId)));
      if (!cands.length) return json(res, 409, { error: 'Kullanılabilir hesap yok (hepsi limitte ya da girişsiz).' });
      const scan = pr && !isCloud(pr) ? scanProject(resolveDir(pr.dir)) : null;
      // Baglam: son yonetici cevabi (bas+son) ve son 1-2 kullanici mesaji; atiflari cozmek icin
      const msgs = (pr?.messages || []).filter((m) => m.role === 'user' || m.role === 'manager');
      const lastMgr = lastRealManager(msgs);
      const context = { manager: lastMgr ? headTail(lastMgr.text, 1000, 500) : '', users: msgs.filter((m) => m.role === 'user').slice(-2).map((m) => String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 300)) };
      const prompt = enhancePrompt(text, { project: pr?.name, notes: pr?.notes || '', scan, context, mode: b.mode === 'race' ? 'race' : 'split' });
      const ENH_TIMEOUT = 90000;
      let a, out = '', err = '';
      // Istemci baglantiyi kapatirsa (Iptal) ajan surecini de durdur
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      // Limite takilirsa bir sonraki hesapla bir kez daha dene; hizli olsun diye dusunme seviyesi dusuk
      for (a of cands.slice(0, 2)) {
        const r = await runAgent({ ...a, effort: 'low' }, { prompt, cwd: os.tmpdir(), perm: 'safe', timeoutMs: ENH_TIMEOUT, kind: 'enhance', signal: ac.signal });
        if (ac.signal.aborted) return;
        out = extractEnhanced(r.final) || extractEnhanced(r.output);
        if (out) break;
        err = r.limited ? `${a.name} limitte.`
          : /Zaman asimi/.test(r.output || '') ? `${a.name} ${ENH_TIMEOUT / 1000} sn içinde cevap vermedi. Metni kısaltıp tekrar dene.`
          : `${a.name} metni iyileştiremedi. Tekrar dene ya da metni kendin düzenle.`;
        if (!r.limited) break;
      }
      if (!out) return json(res, 502, { error: err });
      if (out === SAME) return json(res, 200, { same: true, by: a.name });
      return json(res, 200, { text: out, by: a.name });
    }
    if (req.method === 'POST' && p === '/api/schedules') {
      const b = await body(req);
      const pr = proj(b.projectId); const text = String(b.text || '').trim().slice(0, 8000);
      if (!pr || !text || !/^\d{1,2}:\d{2}$/.test(b.time || '')) return json(res, 400, { error: 'Proje, metin ve saat gerekli.' });
      const s = { id: id(), projectId: pr.id, text, time: b.time, days: Array.isArray(b.days) ? b.days.map(Number).filter((d) => d >= 0 && d <= 6) : [], mode: b.mode === 'race' ? 'race' : 'split', enabled: true, createdAt: Date.now() };
      // Bugunun (veya gece yarisi telafisinin) saati gectiyse simdi calismasin, sonraki gunden baslasin
      const dk = dueKey(s); if (dk) s.lastKey = dk;
      S.schedules.push(s); store.save(); emit('state', {}); return json(res, 200, s);
    }
    if ((m = p.match(/^\/api\/schedules\/([\w-]+)(?:\/(\w+))?$/))) {
      const s = S.schedules.find((x) => x.id === m[1]);
      if (!s) return json(res, 404, { error: 'Zamanlama yok' });
      if (req.method === 'POST' && m[2] === 'run') { const msg = fireSchedule(s); return json(res, msg ? 200 : 404, msg || { error: 'Proje yok' }); }
      if (req.method === 'POST' && !m[2]) {
        const b = await body(req);
        if (typeof b.enabled === 'boolean') { s.enabled = b.enabled; if (b.enabled) { const dk = dueKey(s); if (dk) s.lastKey = dk; } }
        if (typeof b.text === 'string' && b.text.trim()) s.text = b.text.trim().slice(0, 8000);
        if (typeof b.time === 'string' && /^\d{1,2}:\d{2}$/.test(b.time)) s.time = b.time;
        if (Array.isArray(b.days)) s.days = b.days.map(Number).filter((d) => d >= 0 && d <= 6);
        store.save(); emit('state', {}); return json(res, 200, s);
      }
      if (req.method === 'DELETE' && !m[2]) { S.schedules = S.schedules.filter((x) => x !== s); store.save(); emit('state', {}); return json(res, 200, { ok: true }); }
    }

    // ---- Sablonlar ----
    if (req.method === 'POST' && p === '/api/templates') {
      const b = await body(req);
      const t = { id: id(), title: String(b.title || '').trim().slice(0, 60) || 'Şablon', text: String(b.text || '').slice(0, 8000) };
      if (!t.text.trim()) return json(res, 400, { error: 'Şablon metni boş' });
      S.templates.push(t); store.save(); emit('state', {}); return json(res, 200, t);
    }
    if ((m = p.match(/^\/api\/templates\/([\w-]+)$/)) && req.method === 'DELETE') {
      S.templates = S.templates.filter((t) => t.id !== m[1]); store.save(); emit('state', {}); return json(res, 200, { ok: true });
    }

    // ---- Calismalar ve gorevler ----
    if ((m = p.match(/^\/api\/runs\/([\w-]+)\/(stop|delete)$/)) && req.method === 'POST') {
      const run = S.runs.find((r) => r.id === m[1]);
      if (!run) return json(res, 404, { error: 'Yok' });
      orch.stop(run.id);
      if (m[2] === 'delete') {
        S.runs = S.runs.filter((r) => r !== run);
        try { cleanupBranches(store, { projectDir: run.projectDir, discardBranches: runBranches([run]) }); } catch {}
        store.save(); emit('state', {});
      }
      return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/runs\/([\w-]+)\/tasks\/([\w-]+)\/(diff|files|preview|merge|unmerge|stop|continue)$/))) {
      const run = S.runs.find((r) => r.id === m[1]);
      const task = findTask(run, m[2]);
      if (!task) return json(res, 404, { error: 'Görev bulunamadı' });
      if (m[3] === 'stop' && req.method === 'POST') return json(res, 200, { ok: orch.stopTask(run.id, task.id) });
      if (m[3] === 'continue' && req.method === 'POST') {
        const b = await body(req);
        const pr = proj(run.projectId);
        const text = String(b.text || '').trim();
        if (!pr) return json(res, 404, { error: 'Proje yok' });
        if (!text) return json(res, 400, { error: 'Ne yapılacağını yaz' });
        if (activeRun(pr.id)) return json(res, 409, { error: 'Bu projede çalışan bir iş var. Bitince tekrar dene.' });
        const acc = S.accounts.find((a) => a.id === b.accountId) || S.accounts.find((a) => a.id === task.assigneeId);
        if (!acc) return json(res, 400, { error: 'Hesap bulunamadı' });
        const msg = { id: id(), role: 'user', text, at: Date.now(), kind: 'continue', ref: `${task.title} · ${acc.name}` };
        pr.messages.push(msg);
        const run2 = newRun(pr, {
          goal: text, mode: 'continue', maxRounds: 1, finish: { mode: 'none' }, workerIds: [acc.id], fromChat: msg.id,
          presetTasks: [{ assigneeId: acc.id, title: 'Devam: ' + task.title.replace(/^Devam: /, ''), fromBranch: task.branch || null,
            instructions: `${task.instructions}\n\nONCEKI CALISMANIN RAPORU:\n${tail(task.report || task.output, 3000)}\n\nYENI TALIMAT:\n${text}` }],
        });
        msg.runId = run2.id; store.save();
        return json(res, 200, { ok: true, runId: run2.id });
      }
      // Degisen dosyalar ve cakisma onizlemesi: dal yoksa hata degil bos sonuc
      if (m[3] === 'files' && req.method === 'GET') return json(res, 200, orch.taskFiles(run, task));
      if (m[3] === 'preview' && req.method === 'POST') return json(res, 200, orch.mergePreview(run, task));
      if (!task.branch) return json(res, 404, { error: 'Bu görevin dalı yok' });
      if (m[3] === 'diff') {
        let diff;
        try {
          diff = execFileSync('git', ['-C', run.projectDir, 'diff', `${task.base || task.branch + '~1'}..${task.branch}`], { encoding: 'utf8', maxBuffer: 20e6 });
        } catch (e) {
          if (task.merged && task.mergeCommit) {
            diff = execFileSync('git', ['-C', run.projectDir, 'diff', `${task.mergeFrom || task.base || task.mergeCommit + '~1'}..${task.mergeCommit}`], { encoding: 'utf8', maxBuffer: 20e6 });
          } else throw e;
        }
        if (diff.length > 300000) diff = diff.slice(0, 300000) + '\n... (kısaltıldı)';
        return json(res, 200, { diff, branch: task.branch });
      }
      if (m[3] === 'merge' && req.method === 'POST') {
        const b = await body(req);
        if (b.reason !== undefined && typeof b.reason !== 'string') return json(res, 400, { ok: false, error: 'Gerekçe metin olmalı.' });
        const r = orch.mergeBranch(run, task, { force: b.force === true, reason: b.reason });
        return r.ok ? json(res, 200, r) : json(res, 400, r);
      }
      if (m[3] === 'unmerge' && req.method === 'POST') {
        const r = orch.unmergeBranch(run, task);
        return r.ok ? json(res, 200, r) : json(res, 400, r);
      }
    }

    // ---- Hesaplar ----
    if (req.method === 'POST' && p === '/api/accounts') {
      const b = await body(req);
      if (!TYPES[b.type]) return json(res, 400, { error: 'Geçersiz tür' });
      const count = S.accounts.filter((a) => a.type === b.type).length;
      const aid = `${b.type}-${id()}`;
      const a = {
        id: aid, type: b.type,
        name: (b.name || '').trim().slice(0, 40) || `${{ claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini' }[b.type]} ${count + 1}`,
        dir: path.join(HOME, 'accounts', aid), useDefault: !!b.useDefault, createdAt: Date.now(), usage: [],
      };
      fs.mkdirSync(a.dir, { recursive: true, mode: 0o700 });
      S.accounts.push(a);
      if (!S.settings.managerId) S.settings.managerId = a.id;
      store.save(); emit('state', {}); checkAuth(a).catch(() => {});
      return json(res, 200, publicAcct(a, busyAccounts()));
    }
    if ((m = p.match(/^\/api\/accounts\/([\w-]+)(?:\/(\w+))?$/))) {
      const a = S.accounts.find((x) => x.id === m[1]);
      if (!a) return json(res, 404, { error: 'Hesap yok' });
      const action = m[2];
      if (req.method === 'DELETE' && !action) {
        S.accounts = S.accounts.filter((x) => x !== a);
        if (!a.useDefault && a.dir.startsWith(path.join(HOME, 'accounts'))) fs.rmSync(a.dir, { recursive: true, force: true });
        if (S.settings.managerId === a.id) S.settings.managerId = S.accounts[0]?.id || '';
        if (Array.isArray(S.settings.workerIds)) S.settings.workerIds = S.settings.workerIds.filter((x) => x !== a.id);
        store.save(); emit('state', {}); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (action === 'rename' || action === 'update')) {
        const b = await body(req);
        if (b.name) a.name = String(b.name).trim().slice(0, 40);
        if ('model' in b) a.model = String(b.model || '').trim().slice(0, 60) || null;
        // Dusunme seviyesi: sadece aracin destekledigi degerler (Claude: --effort, Codex: model_reasoning_effort)
        if ('effort' in b) { const e = String(b.effort || ''); a.effort = (TYPES[a.type]?.efforts || []).includes(e) ? e : null; }
        store.save(); emit('state', {}); return json(res, 200, publicAcct(a, busyAccounts()));
      }
      if (req.method === 'POST' && action === 'refresh') { const ok = await refreshLimits(a); return json(res, 200, { ok, limits: a.limits || null }); }
      if (req.method === 'POST' && (action === 'login' || action === 'usage')) {
        const cmd = terminalCommand(a, action);
        if (action === 'login') watchLogin(a);
        return json(res, 200, { opened: await openTerminal(cmd), cmd });
      }
      if (req.method === 'GET' && action === 'models') {
        const key = `${a.id}:${a.useDefault ? 'd' : a.dir}`; const c = modelCache.get(key);
        if (c && Date.now() - c.at < 10 * 60000 && c.list.length) return json(res, 200, { models: c.list });
        const list = await listModels(a).catch(() => []);
        modelCache.set(key, { at: Date.now(), list });
        return json(res, 200, { models: list });
      }
      if (req.method === 'POST' && action === 'authcheck') return json(res, 200, { ok: await checkAuth(a) });
      if (req.method === 'POST' && action === 'clearlimit') { a.limitUntil = null; store.save(); emit('state', {}); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && action === 'test') {
        const r = await runAgent(a, { prompt: 'Sadece TAMAM yaz, baska bir sey yazma.', cwd: os.tmpdir(), timeoutMs: 120000, kind: 'test' });
        a.lastTest = { ok: r.code === 0, at: Date.now(), limited: r.limited, out: r.output.slice(-600) };
        if (r.code === 0) a.auth = { ok: true, at: Date.now() }; else checkAuth(a).catch(() => {});
        store.save(); emit('state', {}); return json(res, 200, a.lastTest);
      }
    }
    json(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// Limit suresi dolan hesaplar icin arayuzu guncelle; limit yoksa gereksiz tick gonderme
setInterval(() => {
  const now = Date.now();
  let expired = false, anyLimited = false;
  for (const a of S.accounts) {
    if (a.limitUntil) {
      if (a.limitUntil <= now) { a.limitUntil = null; expired = true; }
      else anyLimited = true;
    }
  }
  if (expired) { store.save(); emit('state', {}); }
  if (!clients.size) return;
  for (const c of [...clients]) {
    if (c.destroyed || c.writableEnded) { clients.delete(c); continue; }
    try { c.write(': ping\n\n'); } catch { clients.delete(c); }
  }
  if (anyLimited) emit('tick', {});
}, 30000);

function openWindow(url) {
  const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Arc'];
  const tryApp = (i) => {
    if (i >= apps.length) return execFile('open', [url]);
    execFile('open', ['-na', apps[i], '--args', `--app=${url}`, '--window-size=1320,860'], (err) => err && tryApp(i + 1));
  };
  tryApp(0);
}
const startedAt = Date.now();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && process.env.AI_PANEL_RESTARTED) {
    // Yeniden baslatma: eski ornek portu birakana kadar (en fazla 15 sn) tekrar dene
    if (Date.now() - startedAt > 15000) { console.log('Port bosalmadi, vazgecildi.'); return process.exit(1); }
    return setTimeout(() => server.listen(PORT, '127.0.0.1'), 250);
  }
  if (e.code === 'EADDRINUSE') {
    console.log(`AI Panel zaten calisiyor: http://localhost:${PORT}`);
    // Acik pencere varsa one getir, yoksa yenisini ac; is bitince cik (ust sinir 6 sn)
    const bye = () => process.exit(0);
    setTimeout(bye, 6000);
    if (process.platform === 'darwin' && !process.env.NO_OPEN) {
      focusExisting(PORT, (found) => { if (!found) openWindow(`http://localhost:${PORT}`); setTimeout(bye, 1500); });
    } else setTimeout(bye, 1500);
  } else throw e;
});
server.on('listening', () => {
  // Portu yalniz bu ornek aldi: artik yazabilir ve temizlik yapabilir
  store._owner = true;
  recoverInterruptedRuns();
  // Yarim kalmis kopyalari ve birlesmis/bos ai-panel/* dallarini temizle (birlesmemis dallara dokunmaz)
  try { cleanupBranches(store); } catch {}
  // Kuyruk korunur ama kendiliginden baslamaz: yeni mesaj ya da "Kuyrugu surdur" ile devam eder
  try { if (adoptLegacyMerges(S.runs)) store.save(); } catch {}
  const url = `http://localhost:${PORT}`;
  console.log(`\n  AI Panel hazir:  ${url}\n  Veriler:         ${HOME}\n  Kapatmak icin:   Ctrl+C\n`);
  if (process.platform === 'darwin' && !process.env.NO_OPEN && !process.env.AI_PANEL_RESTARTED) openWindow(url);
});
server.listen(PORT, '127.0.0.1');
