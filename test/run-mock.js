// Sahte ajanlarla uctan uca test:  npm test   (LIMIT_TEST=1 npm test ile limit devrini de dener)
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipanel-'));
const mkRepo = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d); execSync('git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init', { cwd: d }); return d; };
const projA = mkRepo('projA'), projB = mkRepo('projB');
const mock = path.join(__dirname, 'mock-agent.js');
// Birden fazla calisma kopyasinda ayni anda kosabilsin diye her test kendi portunu kullanir
const PORT = Number(process.env.TEST_PORT) || 4600 + Math.floor(Math.random() * 400);
const env = { ...process.env, PORT, AI_PANEL_HOME: path.join(tmp, 'home'), NO_OPEN: '1', AI_PANEL_NO_RESPAWN: '1', AI_PANEL_NOTIFY_LOG: path.join(tmp, 'notify.log'), AI_PANEL_NOTIFY_GROUP_MS: '700', CLAUDE_BIN: mock, CODEX_BIN: mock, GEMINI_BIN: mock, AGY_BIN: path.join(__dirname, 'mock-agy.js') };
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
let TOKEN = ''; // oturum jetonu: sayfadan (meta etiketi) okunur, tum GET disi isteklerde gonderilir
const call = async (m, u, b) => { const r = await fetch(`http://localhost:${PORT}${u}`, { method: m, headers: { 'Content-Type': 'application/json', 'X-AI-Panel': '1', 'X-AI-Token': TOKEN }, body: b && JSON.stringify(b) }); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'OK   ' : 'FAIL ') + msg); if (!ok) fails++; };
const state = () => call('GET', '/api/state');
const project = async (pid) => (await state()).projects.find((p) => p.id === pid);
// Projede n tane yonetici/sistem cevabi olana kadar bekle
async function waitReplies(pid, n, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await sleep(150); const s = await state(); const p = s.projects.find((x) => x.id === pid); if (p.messages.filter((m) => m.role !== 'user').length >= n) return s; }
  return state();
}
const runOf = (s, pred) => s.runs.filter(pred).at(-1);

(async () => {
  for (let i = 0; i < 40; i++) { try { await state(); break; } catch { await sleep(100); } }
  // 0) Oturum jetonu ve guvenlik basliklari
  const page = await fetch(`http://localhost:${PORT}/`); const html = await page.text();
  TOKEN = (html.match(/<meta name="aip-token" content="([0-9a-f]{32,})"/) || [])[1] || '';
  check(TOKEN.length >= 32 && !html.includes('__AIP_TOKEN__'), 'jeton sayfaya gomuldu');
  const raw = (h, body = '{}') => fetch(`http://localhost:${PORT}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body });
  check((await raw({ 'X-AI-Panel': '1' })).status === 403, 'jetonsuz POST reddedildi');
  check((await raw({ 'X-AI-Panel': '1', 'X-AI-Token': 'yanlis' + TOKEN })).status === 403, 'yanlis jetonlu POST reddedildi');
  check((await raw({ 'X-AI-Token': TOKEN })).status === 403, 'jeton var ama X-AI-Panel basligi yok: reddedildi');
  check((await raw({ 'X-AI-Panel': '1', 'X-AI-Token': TOKEN })).status === 200, 'dogru jetonlu POST kabul edildi');
  check((await fetch(`http://localhost:${PORT}/api/events`)).status === 403, 'jetonsuz canli baglanti reddedildi');
  const ac = new AbortController();
  const ev = await fetch(`http://localhost:${PORT}/api/events?t=${TOKEN}`, { signal: ac.signal }); ac.abort();
  check(ev.status === 200 && /text\/event-stream/.test(ev.headers.get('content-type')), 'jetonlu canli baglanti acildi');
  const hd = page.headers;
  check(/default-src 'self'/.test(hd.get('content-security-policy')) && /frame-ancestors 'none'/.test(hd.get('content-security-policy')) && hd.get('x-frame-options') === 'DENY'
    && hd.get('x-content-type-options') === 'nosniff' && hd.get('referrer-policy') === 'no-referrer', 'guvenlik basliklari var');
  check((await fetch(`http://localhost:${PORT}/api/state`)).headers.get('x-frame-options') === 'DENY', 'basliklar API yanitlarinda da var');
  check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'index.html icinde satir ici script yok (CSP ile uyumlu)');
  check((await fetch(`http://localhost:${PORT}/theme.js`)).status === 200, 'theme.js sunuluyor');
  check((await fetch(`http://localhost:${PORT}/i18n.js`)).status === 200, 'i18n.js sunuluyor');

  const mk = (type, name) => call('POST', '/api/accounts', { type, name });
  const c1 = await mk('claude'), c2 = await mk('claude'), c3 = await mk('claude');
  const g1 = await mk('antigravity'), g2 = await mk('antigravity'), cx = await mk('codex');
  check([c1, c2, c3, g1, g2, cx].map((a) => a.name).join(',') === 'Claude 1,Claude 2,Claude 3,Antigravity 1,Antigravity 2,Codex 1', 'hesaplar eklendi');
  await call('POST', '/api/settings', { managerId: c1.id, workerIds: [c2.id, g1.id, cx.id], maxRounds: 3 });
  if (process.env.LIMIT_TEST) fs.writeFileSync(path.join(env.AI_PANEL_HOME, 'accounts', c2.id, 'LIMIT'), '');

  // Ilk acilista "Genel" projesi var; klasoru yok -> klasorsuz (bulut) modda calisir, ev klasorune dusmez
  let s = await state();
  const gen = s.projects[0];
  check(s.projects.length === 1 && !gen.dir, 'varsayilan proje olustu');

  // Proje A: klasor + "en iyisini ana dala al" bitis adimi
  const A = await call('POST', '/api/projects', { name: 'Uygulama', dir: projA });
  await call('POST', `/api/projects/${A.id}`, { notes: 'Test komutu: npm test', finish: { mode: 'merge' } });
  const gi = await call('GET', '/api/git-info?dir=' + encodeURIComponent(projA));
  check(gi.isGit && gi.exists && gi.dirty === 0, 'git bilgisi okunuyor (dal: ' + gi.branch + ')');

  // 1) Soru: ekibe is vermeden cevap
  await call('POST', '/api/chat', { projectId: A.id, text: 'soru: nasilsin' });
  s = await waitReplies(A.id, 1);
  check((await project(A.id)).messages.at(-1).text.includes('sadece bir soru'), 'soruya dogrudan cevap');

  // 2) Bol modu: yonetici boler, isciler calisir, yonetici kontrol eder, en iyi dal otomatik birlestirilir
  await call('POST', '/api/chat', { projectId: A.id, text: 'uygulamayi iyilestir', mode: 'split' });
  s = await waitReplies(A.id, 2);
  let run = runOf(s, (r) => r.projectId === A.id && r.goal === 'uygulamayi iyilestir');
  check(run && run.status === 'done', 'bol modu tamamlandi: ' + (run && run.status));
  check(run.rounds[0].tasks.length === 3 && run.rounds[0].tasks.every((t) => t.status === 'done'), 'gorevler: ' + run.rounds[0].tasks.map((t) => `${t.assignee}=${t.status}`).join(', '));
  check(run.notes === 'Test komutu: npm test', 'proje notu ise iletildi');
  // Token sayaci: gorev/yonetici/run bazinda birikir, hesap bazinda dolar
  const tu = run.rounds[0].tasks;
  const sumTasks = tu.reduce((a, t) => a + (t.usage ? t.usage.total : 0), 0);
  const sumMgr = run.rounds.reduce((a, R) => a + (R.managerUsage ? R.managerUsage.total : 0), 0);
  check(tu.every((t) => t.usage && t.usage.total > 0) && run.rounds[0].managerUsage.total > 0, 'her gorevde task.usage, her turda round.managerUsage var');
  check(run.usage && run.usage.total === sumTasks + sumMgr && sumTasks > 0, 'run.usage = yonetici + isciler: ' + (run.usage && run.usage.total) + ' = ' + sumTasks + ' + ' + sumMgr);
  check(run.usage.in > 0 && run.usage.out > 0 && Object.keys(run.usage.byAgent).length >= 3 && Object.values(run.usage.byAgent).every((b) => b.name && b.calls > 0 && b.total > 0), 'run.usage.byAgent hesap bazinda doldu: ' + Object.values(run.usage.byAgent).map((b) => `${b.name}=${b.total}/${b.calls}`).join(', '));
  const cl = tu.find((t) => /^Claude/.test(t.assignee) && t.usage.cacheRead).usage, cdx = tu.find((t) => t.assignee === 'Codex 1').usage;
  const k = cl.total / 190; // limitte devredilen gorevde iki cagri birikir
  check(Number.isInteger(k) && k >= 1 && cl.in === 100 * k && cl.out === 30 * k && cl.cacheRead === 50 * k && cl.cacheWrite === 10 * k && !cl.estimated, 'Claude usage stream-json\'dan okundu');
  check(cdx.estimated === true && cdx.total > 0 && run.usage.estimated === true, 'Codex icin usage karakter/4 ile tahmin edildi (estimated:true)');
  const firstTotal = run.usage.total;
  check(run.bestBranch && run.rounds[0].tasks.find((t) => t.branch === run.bestBranch)?.merged, 'bitis adimi: en iyi dal ana dala alindi (' + run.bestBranch + ')');
  check(fs.readdirSync(projA).some((f) => f.startsWith('out-')), 'birlesen degisiklik proje klasorunde');
  const agT = run.rounds[0].tasks.find((t) => t.assignee === 'Antigravity 1');
  check(agT && agT.output.includes('› run_command: cargo test') && agT.report.includes('Rapor'), 'Antigravity (agy) ciktisi ve raporu okundu');

  // 3) Yaristir modu: ayni gorev herkese, hakem secer
  await call('POST', `/api/projects/${A.id}`, { finish: { mode: 'none' } });
  await call('POST', '/api/chat', { projectId: A.id, text: 'hizlandir', mode: 'race' });
  s = await waitReplies(A.id, 3);
  run = runOf(s, (r) => r.projectId === A.id && r.mode === 'race');
  check(run && run.status === 'done' && run.rounds[0].tasks.length === 3 && new Set(run.rounds[0].tasks.map((t) => t.title)).size === 1, 'yaris: ayni gorev 3 isciye verildi');
  check(run.rounds.length === 2 && run.bestBranch && (await project(A.id)).messages.at(-1).text.includes('| Dal |'), 'yaris: hakem en iyiyi secti, tabloyla cevap verdi');
  const projTotal = s2 => s2.runs.filter((r) => r.projectId === A.id).reduce((a, r) => a + (r.usage ? r.usage.total : 0), 0);
  check(run.usage && run.usage.total > 0 && projTotal(s) > firstTotal + run.usage.total - 1, 'ikinci mesajda proje toplami birikti: ' + projTotal(s) + ' > ' + firstTotal);
  check(!run.rounds[0].tasks.some((t) => t.merged), 'bitis adimi "yok": hicbir sey birlestirilmedi');

  // 4) Devam ettir: bir gorevin dali uzerinden yeni talimat
  const t0 = run.rounds[0].tasks[1];
  const cont = await call('POST', `/api/runs/${run.id}/tasks/${t0.id}/continue`, { text: 'bir de sunu ekle', accountId: c3.id });
  check(cont.ok, 'devam gorevi basladi');
  s = await waitReplies(A.id, 4);
  const crun = s.runs.find((r) => r.id === cont.runId);
  const ct = crun && crun.rounds[0].tasks[0];
  const baseOk = ct && ct.base === execSync(`git rev-parse ${t0.branch}`, { cwd: projA }).toString().trim();
  check(crun && crun.status === 'done' && ct.assignee === 'Claude 3' && baseOk, 'devam: secilen iscide, onceki dalin ustunde calisti');
  check(execSync(`git show --stat ${ct.branch}`, { cwd: projA }).toString().includes('devam.txt'), 'devam: yeni degisiklik yeni dalda');

  // 5) Tek gorevi durdur + iki proje ayni anda calisabilir
  const B = await call('POST', '/api/projects', { name: 'Ikinci', dir: projB });
  await call('POST', '/api/chat', { projectId: B.id, text: 'YAVAS is' });
  await call('POST', '/api/chat', { projectId: A.id, text: 'soru: paralel mi' });
  let slowTask = null;
  for (let i = 0; i < 60 && !slowTask; i++) { await sleep(150); s = await state(); const r = runOf(s, (x) => x.projectId === B.id); slowTask = r && r.rounds[0]?.tasks.find((t) => t.status === 'running' && t.instructions.startsWith('YAVAS')); }
  const bothRunning = s.runs.filter((r) => r.status === 'running').length;
  check(!!slowTask, 'yavas gorev calisiyor');
  const rB = runOf(s, (x) => x.projectId === B.id);
  const st = await call('POST', `/api/runs/${rB.id}/tasks/${slowTask.id}/stop`);
  check(st.ok, 'tek gorev durdurma istegi alindi');
  s = await waitReplies(B.id, 1);
  const rB2 = s.runs.find((r) => r.id === rB.id);
  const tasksB = rB2.rounds[0].tasks;
  check(tasksB.find((t) => t.id === slowTask.id).status === 'stopped' && tasksB.filter((t) => t.id !== slowTask.id).every((t) => t.status === 'done'), 'sadece o gorev durdu, digerleri bitti');
  check(bothRunning >= 1 && (await project(A.id)).messages.some((m) => m.text === 'Merhaba, bu sadece bir soruydu, ekibe is vermedim.'), 'iki proje birbirini beklemeden calisti');

  // 6) Sablonlar
  const tp = await call('POST', '/api/templates', { title: 'Benim sablonum', text: 'testleri calistir' });
  s = await state();
  check(s.templates.some((t) => t.id === tp.id), 'sablon kaydedildi');
  await call('DELETE', `/api/templates/${tp.id}`);
  check(!(await state()).templates.length, 'sablon silindi');

  // 7) Limitler, fark, kurulum kontrolu
  s = await state();
  const acc = Object.fromEntries(s.accounts.map((a) => [a.name, a.stats]));
  check(acc['Claude 1'].limits && acc['Claude 1'].limits.fiveHour.pct === 24 && acc['Claude 1'].limits.week.pct === 41, 'Claude limit yuzdesi okundu');
  const cxr = await call('POST', `/api/accounts/${cx.id}/refresh`);
  check(cxr.ok && cxr.limits.fiveHour.pct === 37, 'Codex limiti hak harcamadan okundu');
  const df = await call('GET', `/api/runs/${crun.id}/tasks/${ct.id}/diff`);
  check(df.diff && df.diff.includes('devam edildi'), 'dal farki gorunuyor');
  check(!fs.existsSync(path.join(env.AI_PANEL_HOME, 'worktrees', `${crun.id}-1-1`)), 'gecici kopya temizlendi');
  const doc = await call('GET', '/api/doctor');
  check(doc.claude.ok && doc.git.ok, 'kurulum kontrolu calisiyor');
  if (process.env.LIMIT_TEST) {
    check(acc['Claude 2'].limited && acc['Claude 2'].limitUntil > Date.now(), 'Claude 2 limitte gorunuyor');
    check(acc['Claude 2'].limits && acc['Claude 2'].limits.fiveHour.pct === 100, 'Claude 2 utilization:1 -> %100 okundu');
    const firstRun = s.runs.find((r) => r.goal === 'uygulamayi iyilestir');
    check(!firstRun.rounds[0].tasks.some((t) => t.assignee === 'Claude 2' && t.status === 'done'), 'limitteki Claude 2 is bitirmedi (devredildi)');
  }

  // 7b) Giris durumu (hak harcamadan) ve model listesi
  const cm = await call('GET', `/api/accounts/${cx.id}/models`);
  check(cm.models.length === 1 && cm.models[0].id === 'mock-a', 'Codex model listesi okundu (gizli model elendi)');
  const clm = await call('GET', `/api/accounts/${c1.id}/models`);
  check(clm.models.some((m) => m.id === 'opus'), 'Claude model secenekleri var');
  check((await call('POST', `/api/accounts/${c2.id}/authcheck`)).ok === true, 'giris durumu: girisli');
  fs.writeFileSync(path.join(env.AI_PANEL_HOME, 'accounts', c2.id, 'LOGGEDOUT'), '');
  check((await call('POST', `/api/accounts/${c2.id}/authcheck`)).ok === false, 'giris durumu: girissiz fark edildi');
  const before = (await project(A.id)).messages.filter((m) => m.role !== 'user').length;
  await call('POST', '/api/chat', { projectId: A.id, text: 'girissiz hesabi atla', mode: 'split' });
  s = await waitReplies(A.id, before + 1);
  const lo = runOf(s, (r) => r.goal === 'girissiz hesabi atla');
  check(lo && lo.rounds[0].tasks.length && !lo.rounds[0].tasks.some((t) => t.assigneeId === c2.id), 'girissiz hesaba is verilmedi: ' + (lo ? lo.rounds[0].tasks.map((t) => t.assignee).join(', ') : 'yok'));
  fs.rmSync(path.join(env.AI_PANEL_HOME, 'accounts', c2.id, 'LOGGEDOUT'));
  check((await call('POST', `/api/accounts/${c2.id}/authcheck`)).ok === true, 'giris yapilinca tekrar girisli');

  // 7c) Akilli ozellikler
  const nodeDir = path.join(tmp, 'nodeproj'); fs.mkdirSync(nodeDir);
  fs.writeFileSync(path.join(nodeDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest', build: 'tsc' }, devDependencies: { typescript: '5', react: '19' } }));
  const scan = await call('GET', '/api/project-scan?dir=' + encodeURIComponent(nodeDir));
  check(scan.stack[0].includes('Node.js') && scan.stack[0].includes('React') && scan.cmds.test === 'npm test' && scan.cmds.build === 'npm run build', 'proje tarayici: ' + scan.stack.join(', ') + ' · test: ' + scan.cmds.test);
  const enh = await call('POST', '/api/enhance', { projectId: A.id, text: 'giris sayfasini duzelt' });
  check(enh.text && enh.text.startsWith('Hedef: giris sayfasini duzelt') && enh.by, 'prompt iyilestirici: ' + (enh.text || enh.error || '').split('\n')[0]);
  {
    // AYNI cevabi, sohbet baglami ve tekrar basma
    const same = await call('POST', '/api/enhance', { projectId: A.id, text: 'AYNI_TEST zaten net' });
    check(same.same === true && !same.text, 'iyilestirme: model <<<AYNI>>> donerse {same:true}');
    const lastM = [...(await project(A.id)).messages].reverse().find((m) => m.role === 'manager');
    check(lastM && /Baglam: /.test(enh.text), 'iyilestirme: son yonetici cevabi istemde (ONCEKI KONUSMA)');
  }
  const enhBad = await call('POST', '/api/enhance', { projectId: A.id, text: 'ENH_FAIL bunu yap' });
  check(!enhBad.text && /metni iyileştiremedi\. Tekrar dene/.test(enhBad.error || ''), 'prompt iyilestirici hata yolu anlasilir mesaj: ' + enhBad.error);
  check((await call('POST', '/api/enhance', { projectId: A.id, text: '  ' })).error === 'Boş metin', 'prompt iyilestirici bos metni reddeder');
  {
    // Iptal: istemci baglantiyi kapatinca iyilestiren ajan sureci de kapanir
    const pf = path.join(tmp, 'enh-slow.pid'); const ac = new AbortController();
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const pr = fetch(`http://localhost:${PORT}/api/enhance`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'X-AI-Panel': '1', 'X-AI-Token': TOKEN }, body: JSON.stringify({ projectId: A.id, text: `ENH_SLOW_PID:${pf}` }) }).catch((e) => e);
    for (let i = 0; i < 80 && !fs.existsSync(pf); i++) await sleep(100);
    const epid = fs.existsSync(pf) ? Number(fs.readFileSync(pf, 'utf8')) : 0;
    const wasAlive = epid > 0 && alive(epid);
    ac.abort(); await pr;
    for (let i = 0; i < 60 && epid && alive(epid); i++) await sleep(100);
    check(wasAlive && !alive(epid), 'iyilestirme iptal edilince ajan sureci kapandi');
  }
  {
    const sm = require('../lib/smart');
    const { findBlanks, PROMPTS: PP, PROMPT_EN: PE } = require('../public/prompts.js');
    check(findBlanks('a [renk? varsayılan: koyu] [ ] [x] [link](http://x) [dal]\n[b\nc]').length === 2 && findBlanks('').length === 0, 'parantez sayimi: [ ], [x], link ve satir asan sayilmaz');
    check(sm.extractEnhanced('x\n<<<METIN\n...yeni metin...\nMETIN>>>') === '' && sm.extractEnhanced('<<<METIN\nilk\nMETIN>>> sonra <<<METIN\nson\nMETIN>>>') === 'son'
      && sm.extractEnhanced('<<<METIN\n```\nHedef: a\n```\nMETIN>>>') === 'Hedef: a' && sm.extractEnhanced('isaret yok') === '', 'extractEnhanced: ornek metin, son blok, kod citi, isaretsiz');
    const ep = sm.enhancePrompt('X', { project: 'P', scan: { stack: ['Node.js (npm)'], cmds: { test: 'npm test' } }, mode: 'race' });
    const es = sm.enhancePrompt('X', {});
    check(ep.includes('Test komutu: npm test') && ep.includes('Mod Yaris') && es.includes('Mod Bol') && /EN FAZLA 2/.test(es) && /varsayilan:/.test(es) && es.length < 1900, 'iyilestirme istemi: tarama bilgisi, moda gore kural, en fazla 2 soru ve varsayilan; uzunluk ' + es.length);
    const { applyDefaults: ad, enhanceOutcome: eo } = require('../public/prompts.js');
    check(ad('Tema [tema? varsayılan: koyu], dil [dil? default: TR].') === 'Tema koyu, dil TR.' && ad('[hangi sayfa?] [x? varsayilan: ] [l](http://u)') === '[hangi sayfa?] [x? varsayilan: ] [l](http://u)'
      && ad('[a? varsayilan: 3 satir]\n[b? Varsayılan:  evet ]') === '3 satir\nevet' && ad('') === '' && findBlanks(ad('x [r? varsayılan: mavi]')).length === 0,
      'varsayilanlari uygula: TR/EN, bos varsayilan ve varsayilansiz soru kalir, link bozulmaz');
    check(eo({ pid: 'a', text: 'x' }, { pid: 'a', text: ' x ' }) === 'apply' && eo({ pid: 'a', text: 'x' }, { pid: 'a', text: 'xy' }) === 'offer' && eo({ pid: 'a', text: 'x' }, { pid: 'b', text: 'x' }) === 'drop',
      'geciken yanit: ayni metin uygula, degisen metin cip, proje degisti birak');
    const cp = sm.enhancePrompt('bulunan hatalari duzelt', { notes: 'Bagimlilik ekleme. npm test calistir.', context: { manager: 'Bulgu 1: a\nBulgu 2: b', users: ['incele'] } });
    check(/ONCEKI KONUSMA \(sadece referanslari cozmek icin\)/.test(cp) && cp.includes('Bulgu 2: b') && !/ONCEKI KONUSMA/.test(es) && /yoneticiye zaten ayrica gidiyor[^\n]*YAZMA/.test(cp)
      && /yeni soru ekleme, yapiyi koru/.test(cp) && /EN FAZLA 2/.test(cp) && /8 satir/.test(cp) && /<<<AYNI>>>/.test(cp) && cp.indexOf('ONCEKI KONUSMA') < cp.indexOf('KULLANICININ ISTEGI:'), 'istem: baglam basligi, proje notunu kopyalama yasagi, ikinci gecis, 2 soru, 8 satir, AYNI');
    check(sm.extractEnhanced('<<<AYNI>>>') === sm.SAME && sm.extractEnhanced('<<<METIN\nyeni\nMETIN>>>') === 'yeni' && sm.extractEnhanced('<<<METIN\n...yeni metin...\nMETIN>>>\n(<<<AYNI>>>)') === sm.SAME && sm.extractEnhanced('bos') === '', 'extractEnhanced: AYNI ayri sonuc');
    const { enhanceRepeat: er } = require('../public/prompts.js');
    check(er('Hedef: x [a? varsayilan: b]', ' Hedef: x [a? varsayilan: b] ') === 'questions' && er('Hedef: x', 'Hedef: x') === 'done' && er('Hedef: y', 'Hedef: x') === '' && er('x', '') === '' && er('', 'x') === '', 'ayni metinde ikinci basis: istek yok (soru varsa menu, yoksa bildirim)');
    const sq = sm.enhancePrompt('Hangi test kaldı?', {});
    check(/kisa bir soruysa[^\n]*soru olarak koru; plan/.test(sq) && sq.length - es.length === 'Hangi test kaldı?'.length - 1, 'kisa soru kurali istemde (uzunluk ' + sq.length + ')');
    const nw = ['p-simplify', 'p-glitch', 'p-ideas', 'p-branch', 'p-errors'];
    check(nw.every((k) => PP.some((p) => p.id === k) && PE[k] && PE[k].text) && new Set(PP.map((p) => p.title)).size === PP.length, 'yeni hazir istemler Turkce ve Ingilizce, basliklar tekrarsiz');
  }
  check((await project(A.id)).messages.some((m) => m.role === 'manager' && Array.isArray(m.next) && m.next.length === 2), 'yonetici sonraki adim onerdi');
  const { isDue } = require('../lib/smart');
  const mon = new Date(2026, 0, 5, 10, 30); // pazartesi 10:30
  check(isDue({ enabled: true, time: '10:00', days: [] }, mon) && !isDue({ enabled: true, time: '10:00', days: [], lastKey: '2026-1-5' }, mon)
    && !isDue({ enabled: true, time: '10:00', days: [2] }, mon) && isDue({ enabled: true, time: '10:00', days: [1] }, mon)
    && !isDue({ enabled: true, time: '14:00', days: [] }, mon) && !isDue({ enabled: true, time: '06:00', days: [] }, mon) && !isDue({ enabled: false, time: '10:00' }, mon), 'zamanlama saat/gun kurallari');
  const sch = await call('POST', '/api/schedules', { projectId: A.id, text: 'zamanli is', time: '03:17', days: [], mode: 'split' });
  check(sch.id && sch.enabled && (await state()).schedules.length === 1, 'zamanlama eklendi');
  const beforeS = (await project(A.id)).messages.filter((m) => m.role !== 'user').length;
  await call('POST', `/api/schedules/${sch.id}/run`);
  s = await waitReplies(A.id, beforeS + 1);
  const sm = (await project(A.id)).messages.find((m) => m.scheduled === sch.id);
  const srun = sm && s.runs.find((r) => r.id === sm.runId);
  check(sm && srun && srun.status === 'done', 'zamanlanmis gorev calisti: ' + (srun && srun.status));
  await call('DELETE', `/api/schedules/${sch.id}`);
  check((await state()).schedules.length === 0, 'zamanlama silindi');

  // 7d) Istatistik
  const all = await call('GET', '/api/stats?days=0');
  const nRuns = (await state()).runs.length;
  check(all.totals.runs === nRuns && all.totals.tasks > 0 && all.daily.length >= 1 && all.daily.at(-1).done > 0, `istatistik: ${all.totals.runs} is, %${all.totals.success} basari, ${all.totals.tasks} gorev`);
  const raced = all.accounts.filter((a) => a.raceRuns > 0);
  check(all.totals.races >= 1 && raced.length >= 2 && raced.reduce((s, a) => s + a.raceWins, 0) === all.totals.races, 'istatistik: yaris katilim ve galibiyetleri sayildi');
  check(all.highlights.some((h) => h.k === 'champ'), 'istatistik: yaris sampiyonu one cikanlarda');
  const one = await call('GET', `/api/stats?days=7&project=${A.id}`);
  check(one.totals.runs <= all.totals.runs && one.daily.length === 7 && one.projects.every((p) => p.runs >= 0), 'istatistik: proje ve 7 gun filtresi');

  // 7e) Calisma kopyasi hazirligi, otomatik dogrulama, birlestirmeyi geri alma
  const projC = mkRepo('projC');
  fs.writeFileSync(path.join(projC, '.env'), 'GIZLI=1\n'); // git'te yok
  const C = await call('POST', '/api/projects', { name: 'Kopya', dir: projC });
  await call('POST', `/api/projects/${C.id}`, { setup: 'echo hazir > .hazirlik', copyFiles: '.env, yok.txt, ../disari', check: 'test -f .env && test -f .hazirlik', autoCheck: true, finish: { mode: 'none' } });
  await call('POST', '/api/chat', { projectId: C.id, text: 'kopya testi', mode: 'split' });
  s = await waitReplies(C.id, 1, 30000);
  const crun2 = runOf(s, (r) => r.projectId === C.id);
  const ctasks = crun2.rounds.flatMap((R) => R.tasks || []);
  check(ctasks.length && ctasks.every((t) => t.check && t.check.ok), 'otomatik dogrulama: hazirlik + .env kopyasi ile testler gecti (' + ctasks.map((t) => t.check && t.check.ok).join(',') + ')');
  check(ctasks.every((t) => /kopyalandi: \.env\n/.test(t.output)), 'hazirlik: sadece .env kopyalandi (yok.txt ve ../ atlandi)');
  const ct0 = ctasks.find((t) => t.branch);
  let leaked = true; try { execSync(`git show ${ct0.branch}:.env`, { cwd: projC, stdio: 'ignore' }); } catch { leaked = false; }
  check(!leaked, 'kopyalanan .env dala commit edilmedi');
  fs.appendFileSync(path.join(projC, '.git/info/exclude'), '\n.env\n');
  const mergeR = await call('POST', `/api/runs/${crun2.id}/tasks/${ct0.id}/merge`);
  const headAfter = execSync('git rev-parse HEAD', { cwd: projC }).toString().trim();
  const um = await call('POST', `/api/runs/${crun2.id}/tasks/${ct0.id}/unmerge`);
  const headBack = execSync('git rev-parse HEAD', { cwd: projC }).toString().trim();
  check(mergeR.ok && um.ok && um.how === 'reset' && headBack !== headAfter && execSync('git log --oneline', { cwd: projC }).toString().trim().split('\n').length === 1, 'birlestirme geri alindi (ana dal eski haline dondu)');
  await call('POST', `/api/projects/${C.id}`, { check: 'echo kirik; exit 3' });
  const beforeC = (await project(C.id)).messages.filter((m) => m.role !== 'user').length;
  await call('POST', '/api/chat', { projectId: C.id, text: 'kirik test', mode: 'split' });
  s = await waitReplies(C.id, beforeC + 1, 30000);
  const crun3 = runOf(s, (r) => r.projectId === C.id && r.goal === 'kirik test');
  const bad = crun3.rounds.flatMap((R) => R.tasks || []).filter((t) => t.check);
  check(bad.length && bad.every((t) => !t.check.ok && t.check.code === 3 && t.check.out.includes('kirik')), 'otomatik dogrulama: kalan test fark edildi');

  // 7f) Basarisiz / dogrulanmamis dal ana dala alinamaz
  const failedTask = bad[0]; const headC0 = execSync('git rev-parse HEAD', { cwd: projC }).toString().trim();
  const mb = await call('POST', `/api/runs/${crun3.id}/tasks/${failedTask.id}/merge`);
  check(mb.ok === false && /doğrulama/.test(mb.error) && execSync('git rev-parse HEAD', { cwd: projC }).toString().trim() === headC0, 'dogrulamasi kalan dal birlesmedi: ' + mb.error);
  const { Orchestrator } = require('../lib/orchestrator');
  const o = new Orchestrator({ state: { accounts: [] }, save() {}, home: tmp }, () => {});
  const okTask = { status: 'done', check: { ok: true } };
  check(/başarısız/.test(o.mergeBlocker({}, { ...okTask, status: 'failed' })) && /bitmedi/.test(o.mergeBlocker({}, { status: 'running' })) && /bitmedi/.test(o.mergeBlocker({}, { status: 'limit' })), 'bitmemis / basarisiz gorev engellendi');
  check(/yapılmamış ya da bitmemiş/.test(o.mergeBlocker({ check: 'npm test' }, { status: 'done' })) && /henüz bitmedi/.test(o.mergeBlocker({}, { status: 'done', phase: 'check' })), 'dogrulamasi bitmemis gorev engellendi');
  check(o.mergeBlocker({ check: 'x' }, okTask) === null && o.mergeBlocker({}, { status: 'done' }) === null, 'dogrulamasi gecen / dogrulama gerektirmeyen gorev engellenmedi');
  // Birlestirme aninda dalda gizli dosya varsa engellenir (dal elle .env ile hazirlandi)
  const projE = mkRepo('projE'); const baseE = execSync('git rev-parse HEAD', { cwd: projE }).toString().trim();
  execSync('git checkout -q -b sizan && echo GIZLI=1 > .env && git add -f .env && git -c user.name=t -c user.email=t@t commit -q -m sizdir && git checkout -q -', { cwd: projE, shell: '/bin/bash' });
  const eb = o.mergeBlocker({ projectDir: projE }, { status: 'done', base: baseE, branch: 'sizan', copied: ['.env'] });
  check(/gizli dosya/.test(eb || '') && o.mergeBlocker({ projectDir: projE }, { status: 'done', base: baseE, branch: 'sizan', copied: [] }) === null, 'dalda gizli dosya varsa birlestirme engellendi: ' + eb);

  // Birlestirme ve geri alma hatalari gercek Git durumunu korumali.
  {
    const { execFileSync } = require('child_process');
    const dir = mkRepo('geri-alma');
    const g = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
    const put = (file, value) => fs.writeFileSync(path.join(dir, file), value);
    const run = { projectDir: dir };
    const target = g('branch', '--show-current');
    const base = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'isci');
    put('ortak dosya', 'isci'); g('add', '.'); g('commit', '-qm', 'isci');
    g('checkout', '-q', target);
    const task = () => ({ status: 'done', base, branch: 'isci' });
    const merge = (t = task()) => o.mergeBranch(run, t);
    const lock = path.join(dir, '.git/index.lock');
    put('.git/index.lock', 'kilit');
    check(/kilit/i.test(merge().error) && fs.readFileSync(lock, 'utf8') === 'kilit', 'Git kilidi bildirildi ve korundu');
    fs.unlinkSync(lock);
    check(/bulunamadı/.test(merge({ ...task(), branch: 'silinmis' }).error), 'kayip isci dali bildirildi');
    g('checkout', '-q', '--detach');
    check(/ayrık/.test(merge().error) && g('rev-parse', 'HEAD') === base, 'ayrik HEAD birlestirmesi reddedildi');
    g('checkout', '-q', target);
    put('ortak dosya', 'hedef'); g('add', '.'); g('commit', '-qm', 'hedef');
    const before = g('rev-parse', 'HEAD');
    const conflict = merge();
    check(/çakış/i.test(conflict.error) && conflict.error.includes('ortak dosya') && !g('status', '--porcelain') &&
      !fs.existsSync(path.join(dir, '.git/MERGE_HEAD')) && g('rev-parse', 'HEAD') === before, 'cakisma dosya adiyla bildirildi ve birlestirme iptal edildi');
    try { g('merge', 'isci'); } catch {}
    const userMerge = g('rev-parse', 'MERGE_HEAD');
    const userIndex = g('ls-files', '-u');
    check(/devam eden/.test(merge().error) && g('rev-parse', 'MERGE_HEAD') === userMerge &&
      g('ls-files', '-u') === userIndex, 'kullanicinin devam eden birlestirmesi ve cakismalari korundu');
    g('merge', '--abort');
    g('reset', '--hard', base);
    for (const operation of ['merge', 'unmerge']) {
      // Izlenmeyen dosya artik engel degil (tur4 testleri)
      for (const kind of ['staged', 'unstaged']) {
        put('yerel', 'temel'); g('add', '.'); g('commit', '-qm', 'temel');
        const t = task();
        if (operation === 'unmerge') merge(t);
        const head = g('rev-parse', 'HEAD');
        const file = 'yerel';
        put(file, 'kullanici');
        if (kind === 'staged') g('add', file);
        const status = g('status', '--porcelain');
        const r = operation === 'merge' ? merge(t) : o.unmergeBranch(run, t);
        check(!r.ok && /değişiklik/.test(r.error) && g('rev-parse', 'HEAD') === head && g('status', '--porcelain') === status &&
          fs.readFileSync(path.join(dir, file), 'utf8') === 'kullanici', operation + ' yerel degisikligi korudu: ' + kind);
        g('reset', '--hard', base); g('clean', '-fd');
      }
    }
    const t = task(); merge(t);
    const merged = g('rev-parse', 'HEAD');
    const repeat = merge(t);
    check(!repeat.ok && /zaten/.test(repeat.error) && t.mergeFrom === base && t.mergeCommit === merged, 'yinelenen birlestirme geri alma kaydini korudu');
    g('checkout', '-qb', 'diger');
    const wrong = o.unmergeBranch(run, { ...t });
    check(/hedef dal/i.test(wrong.error) && g('rev-parse', 'HEAD') === merged, 'ayni committeki farkli dalda geri alma reddedildi');
    g('checkout', '-q', target); g('reset', '--hard', base);
    const unrelated = o.unmergeBranch(run, { ...t });
    check(/geçmiş/.test(unrelated.error) && g('rev-parse', 'HEAD') === base, 'gecmisi degisen hedef dalda geri alma reddedildi');
    g('reset', '--hard', merged);
    // Hedefi kayitsiz eski birlestirme: yedek yol (tur4) etkin dali hedef kabul eder
    const legacy = { ...t }; delete legacy.mergeTarget;
    const legacyUndo = o.unmergeBranch(run, legacy);
    check(legacyUndo.ok && legacyUndo.how === 'reset' && g('rev-parse', 'HEAD') === base && !legacy.undoUnavailable, 'hedefi kaydedilmemis eski birlestirme etkin dalda geri alindi');
    g('reset', '--hard', merged);
    g('reset', '--hard', merged);
    put('ortak dosya', 'sonradan degisti'); g('add', '.'); g('commit', '-qm', 'duzenle');
    const changed = g('rev-parse', 'HEAD');
    const failedUndo = o.unmergeBranch(run, t);
    check(!failedUndo.ok && failedUndo.error.includes('ortak dosya') && t.merged && !g('status', '--porcelain') &&
      !fs.existsSync(path.join(dir, '.git/REVERT_HEAD')) && g('rev-parse', 'HEAD') === changed, 'cakisan revert temizlendi ve geri alma kaydi korundu');
    g('reset', '--hard', merged);
    put('sonraki', 'kalsin'); g('add', '.'); g('commit', '-qm', 'sonraki');
    const reverted = o.unmergeBranch(run, t);
    check(reverted.ok && reverted.how === 'revert' && !fs.existsSync(path.join(dir, 'ortak dosya')) &&
      fs.existsSync(path.join(dir, 'sonraki')), 'dogru dalda sonraki commit korunarak geri alindi');
  }

  // ==== Alan C: islev ====
  // Yine de al, degisen dosyalar (numstat), cakisma onizlemesi
  {
    const gitc = (cwd, c) => execSync(c, { cwd, shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    const G = '-c user.name=t -c user.email=t@t';
    const projF = mkRepo('projF');
    gitc(projF, `printf 'a\\nb\\nc\\n' > ortak.txt && git add -A && git ${G} commit -q -m ilk`);
    const baseF = gitc(projF, 'git rev-parse HEAD');
    const mkBranch = (name, cmd) => gitc(projF, `git checkout -q -b ${name} ${baseF} && ${cmd} && git add -f -A && git ${G} commit -q -m ${name} && git checkout -q -`);
    mkBranch('ai-panel/f-ok', `printf 'x\\ny\\n' > yeni.txt && printf 'a\\nB\\nc\\n' > ortak2.txt`);
    mkBranch('ai-panel/f-bad', `printf '1\\n2\\n3\\n' > kalan.txt && printf '\\0\\1' > ikili.bin`);
    mkBranch('ai-panel/f-sec', `echo GIZLI=1 > .env`);
    mkBranch('ai-panel/f-conf', `printf 'a\\nDAL\\nc\\n' > ortak.txt`);
    gitc(projF, `printf 'a\\nANA\\nc\\n' > ortak.txt && git add -A && git ${G} commit -q -m ana`);
    const mkTask = (id, branch, extra = {}) => ({ id, status: 'done', branch, base: baseF, assigneeId: c2.id, assignee: 'x', title: id, instructions: 'x', output: '', diffstat: 'x | 1 +', ...extra });
    const failChk = { cmd: 'npm test', ok: false, code: 3, ms: 1, out: 'kirik' };
    const tasksF = [mkTask('tf1', 'ai-panel/f-ok', { check: { cmd: 'npm test', ok: true, code: 0, ms: 1, out: '' } }), mkTask('tf2', 'ai-panel/f-bad', { check: failChk }), mkTask('tf3', 'ai-panel/f-sec', { check: failChk, copied: ['.env'] }),
      mkTask('tf4', 'ai-panel/f-conf', { check: { cmd: 'npm test', ok: true, code: 0, ms: 1, out: '' } }), mkTask('tf5', 'ai-panel/f-bad', { check: failChk, status: 'failed' })];
    const runF = { id: 'runf', projectId: 'x', projectDir: projF, goal: 'f', status: 'done', check: 'npm test', log: [], rounds: [{ tasks: tasksF }], messages: [] };
    const sF = { state: { accounts: [] }, save() {}, home: path.join(tmp, 'homeF') };
    const oF = new Orchestrator(sF, () => {});
    const hf = () => gitc(projF, 'git rev-parse HEAD');

    // Force: gerekcesiz / kisa reddedilir, hicbir sey degismez
    const h0 = hf();
    const f1 = oF.mergeBranch(runF, tasksF[1], { force: true }), f2 = oF.mergeBranch(runF, tasksF[1], { force: true, reason: '  kisa ' });
    check(!f1.ok && !f2.ok && /gerekçe/.test(f1.error) && hf() === h0 && !tasksF[1].forced, 'yine de al: gerekcesiz ve cok kisa gerekce reddedildi');
    // Force olmadan hala engelli; basarisiz / gizli dosyali dalda force ise yaramaz
    check(!oF.mergeBranch(runF, tasksF[1]).ok, 'yine de al: force olmadan dogrulamasi kalan dal hala engelli');
    const f3 = oF.mergeBranch(runF, tasksF[2], { force: true, reason: 'bilerek aliyorum' });
    check(!f3.ok && /gizli dosya/.test(f3.error) && hf() === h0, 'yine de al: gizli dosyali dalda force reddedildi');
    const f4 = oF.mergeBranch(runF, tasksF[4], { force: true, reason: 'bilerek aliyorum' });
    check(!f4.ok && /başarısız|bitmedi/.test(f4.error) && hf() === h0, 'yine de al: bitmemis/basarisiz gorevde force ise yaramadi');
    const f5 = oF.mergeBranch(runF, { ...tasksF[1], phase: 'check' }, { force: true, reason: 'bilerek aliyorum' });
    check(!f5.ok && /henüz bitmedi/.test(f5.error), 'yine de al: dogrulama surerken force ise yaramadi');
    // Gerekceli force kabul edilir ve kayda gecer
    const f6 = oF.mergeBranch(runF, tasksF[1], { force: true, reason: '  Test ortami\n bozuk, elle baktim ' });
    check(f6.ok && f6.forced && tasksF[1].merged && tasksF[1].forced.reason === 'Test ortami bozuk, elle baktim' && tasksF[1].forced.checkCode === 3 && tasksF[1].forced.cmd === 'npm test' && tasksF[1].forced.at > 0, 'yine de al: gerekceli kabul edildi ve gorev kaydina yazildi');
    // Dogrulamasi gecen gorevde force kayit birakmaz
    const f7 = oF.mergeBranch(runF, tasksF[0], { force: true, reason: 'gerek yoktu ama yazdim' });
    check(f7.ok && !f7.forced && !tasksF[0].forced, 'yine de al: dogrulamasi gecen dalda force kayit birakmadi');
    // HTTP ucu: gerekcesiz 400
    const cFsrv = await call('POST', `/api/runs/${crun3.id}/tasks/${failedTask.id}/merge`, { force: true, reason: 'x' });
    check(cFsrv.ok === false && /gerekçe/.test(cFsrv.error), 'yine de al: sunucu ucu kisa gerekceyi reddetti');
    // Uctan uca: sunucu uzerinden gerekceli force, is gunlugune yazilir
    const cFok = await call('POST', `/api/runs/${crun3.id}/tasks/${failedTask.id}/merge`, { force: true, reason: 'test komutu bilerek kirik' });
    const sAfter = await state(); const tAfter = sAfter.runs.find((r) => r.id === crun3.id).rounds.flatMap((R) => R.tasks).find((t) => t.id === failedTask.id);
    check(cFok.ok && tAfter.merged && tAfter.forced && tAfter.forced.reason === 'test komutu bilerek kirik' && tAfter.forced.checkCode === 3, 'yine de al: sunucu ucu gerekceli force ile birlestirdi, kayit durumda');
    check(JSON.stringify(sAfter.runs.find((r) => r.id === crun3.id)).includes('yine de alindi'), 'yine de al: is gunlugune yazildi');

    // numstat
    const nsOk = oF.taskFiles(runF, tasksF[0]);
    check(nsOk.n === 2 && nsOk.add === 5 && nsOk.del === 0 && nsOk.files.some((f) => f.path === 'yeni.txt' && f.add === 2), 'degisen dosyalar: dosya sayisi ve satirlar dogru');
    const nsBin = oF.taskFiles(runF, tasksF[3]);
    check(nsBin.n === 1 && nsBin.add === 1 && nsBin.del === 1, 'degisen dosyalar: degistirilen satir +1 -1');
    const nsB = oF.taskFiles(runF, mkTask('tfb', 'ai-panel/f-bad'));
    check(nsB.n === 2 && nsB.files.find((f) => f.path === 'ikili.bin').bin === true && nsB.add === 3, 'degisen dosyalar: ikili dosya isaretlendi');
    check(tasksF[0].stat && tasksF[0].stat.tip && oF.taskFiles(runF, tasksF[0]) === tasksF[0].stat, 'degisen dosyalar: sonuc gorevde onbellekte');
    const nsGone = oF.taskFiles(runF, mkTask('tfx', 'ai-panel/yok-boyle-dal'));
    check(nsGone.n === 0 && nsGone.files.length === 0 && oF.taskFiles(runF, { id: 'z' }).n === 0, 'degisen dosyalar: silinmis / dalsiz gorev sessizce bos dondu');
    // HTTP ucu (sunucudaki gercek calisma)
    const ctNs = crun2.rounds.flatMap((R) => R.tasks).find((t) => t.branch);
    const httpFiles = await call('GET', `/api/runs/${crun2.id}/tasks/${ctNs.id}/files`);
    check(Array.isArray(httpFiles.files) && httpFiles.n === httpFiles.files.length, 'degisen dosyalar: sunucu ucu calisiyor');

    // cakisma onizlemesi: proje klasoru degismez
    const stBefore = gitc(projF, 'git status --porcelain; git rev-parse HEAD; git branch | wc -l');
    const tPv = mkTask('tfp', 'ai-panel/f-ok');
    const pvClean = oF.mergePreview(runF, tPv);
    const pvConf = oF.mergePreview(runF, tasksF[3]);
    const pvGone = oF.mergePreview(runF, mkTask('tfy', 'ai-panel/yok-boyle-dal'));
    check(pvClean.ok && pvClean.clean && pvClean.files.length === 0, 'cakisma onizlemesi: cakismayan dal temiz (' + pvClean.method + ')');
    check(pvConf.ok && !pvConf.clean && pvConf.files.join() === 'ortak.txt', 'cakisma onizlemesi: cakisan dalda dosya adi bildirildi (' + pvConf.files + ')');
    check(!pvGone.ok, 'cakisma onizlemesi: silinmis dal hata firlatmadan ok:false');
    const pvC2 = oF.mergePreview(runF, tPv, { fallback: true }), pvK2 = oF.mergePreview(runF, tasksF[3], { fallback: true });
    check(pvC2.clean && pvC2.method === 'worktree' && !pvK2.clean && pvK2.files.join() === 'ortak.txt', 'cakisma onizlemesi: eski git yedek yolu (gecici worktree) ayni sonucu verdi');
    check(gitc(projF, 'git status --porcelain; git rev-parse HEAD; git branch | wc -l') === stBefore && !gitc(projF, 'git worktree list').includes('onizleme'), 'cakisma onizlemesi: proje klasoru ve dallar degismedi, gecici worktree kalmadi');
    const hv = await call('POST', `/api/runs/${crun2.id}/tasks/${ctNs.id}/preview`);
    check(typeof hv.ok === 'boolean', 'cakisma onizlemesi: sunucu ucu calisiyor');
    // i18n: yeni anahtarlar iki dilde
    const i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
    check(['task.force', 'force.title', 'force.note', 'fstat.sum', 'pv.clean', 'pv.conf', 'help.merge.h'].every((k) => new RegExp("\\['" + k.replace('.', '\\.') + "', `[^`]+`, `[^`]+`\\]").test(i18nSrc)), 'yeni metinler Turkce ve Ingilizce sozlukte');
    check(/data-i18n-html="help.merge.h"/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')), 'yardim penceresinde yeni islev var');
  }

  // 7g) Ajan .env dosyasini kendisi commit atsa bile dala girmez
  const projD = mkRepo('projD');
  fs.writeFileSync(path.join(projD, '.env'), 'GIZLI=2\n');
  const D = await call('POST', '/api/projects', { name: 'Sizinti', dir: projD });
  await call('POST', `/api/projects/${D.id}`, { copyFiles: '.env', finish: { mode: 'none' } });
  await call('POST', '/api/chat', { projectId: D.id, text: 'SIZDIR denemesi', mode: 'split' });
  s = await waitReplies(D.id, 1, 30000);
  const drun = runOf(s, (r) => r.projectId === D.id);
  const dtasks = drun.rounds.flatMap((R) => R.tasks || []).filter((t) => t.branch);
  const sizan = dtasks.find((t) => t.stripped);
  check(!!sizan && sizan.stripped.includes('.env'), 'zorla commit edilen .env fark edildi ve cikarildi');
  const everLeaked = dtasks.some((t) => execSync(`git log ${t.branch} --format= --name-only`, { cwd: projD }).toString().split('\n').includes('.env'));
  check(!everLeaked, 'hicbir dalin gecmisinde .env yok');
  check(sizan && /diff --git a\/out-/.test(execSync(`git diff ${sizan.base}..${sizan.branch}`, { cwd: projD }).toString()), 'diger degisiklikler dalda korundu');
  fs.appendFileSync(path.join(projD, '.git/info/exclude'), '\n.env\n');
  const dm = await call('POST', `/api/runs/${drun.id}/tasks/${sizan.id}/merge`);
  check(dm.ok && !fs.readFileSync(path.join(projD, '.env'), 'utf8').includes('GIZLI=1') && execSync('git ls-files', { cwd: projD }).toString().indexOf('.env') < 0, 'temizlenen dal birlesti, .env takibe girmedi');

  // 9) Bildirimler: gorunur istemci varken yok, stopped icin yok, art arda bitenler tek bildirim
  {
    const nlog = env.AI_PANEL_NOTIFY_LOG;
    const lines = () => (fs.existsSync(nlog) ? fs.readFileSync(nlog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const msgCount = async (pid) => (await project(pid)).messages.filter((m) => m.role !== 'user').length;
    const askAndWait = async (pid, text) => { const n = await msgCount(pid); await call('POST', '/api/chat', { projectId: pid, text }); await waitReplies(pid, n + 1); };
    await sleep(1500); fs.writeFileSync(nlog, '');
    await call('POST', '/api/settings', { notify: true });
    check((await call('GET', '/api/state')).settings.notifySound === false, 'bildirim sesi varsayilan kapali');
    await call('POST', '/api/visibility', { visible: true });
    await askAndWait(A.id, 'soru: gorunur');
    await sleep(1200);
    check(lines().length === 0, 'gorunur istemci varken bildirim yok');
    await call('POST', '/api/visibility', { visible: false });
    await askAndWait(A.id, 'soru: gizli');
    await sleep(1200);
    check(lines().length === 1 && /iş bitti/.test(lines()[0].title), 'istemci gizliyken tek bildirim geldi');
    fs.writeFileSync(nlog, '');
    await call('POST', '/api/chat', { projectId: B.id, text: 'YAVAS is' });
    let rs = null;
    for (let i = 0; i < 60 && !rs; i++) { await sleep(150); const x = runOf(await state(), (r) => r.projectId === B.id && r.status === 'running'); if (x) rs = x; }
    await call('POST', `/api/runs/${rs.id}/stop`);
    for (let i = 0; i < 60; i++) { await sleep(150); if (runOf(await state(), (r) => r.id === rs.id).status === 'stopped') break; }
    await sleep(1200);
    check(lines().length === 0, 'durdurulan is icin bildirim yok');
    const na = await msgCount(A.id), nb = await msgCount(B.id);
    await call('POST', '/api/chat', { projectId: A.id, text: 'soru: bir' });
    await call('POST', '/api/chat', { projectId: B.id, text: 'soru: iki' });
    await waitReplies(A.id, na + 1); await waitReplies(B.id, nb + 1);
    await sleep(1500);
    check(lines().length === 1 && /^2 iş bitti/.test(lines()[0].title), 'art arda biten isler tek bildirimde toplandi');
    check(!/Glass/.test(JSON.stringify(lines())), 'bildirim kaydinda ses yok');
    // Iyilestir baglami: son yonetici mesaji "Durduruldu." ise ondan onceki gercek cevap kullanilir
    {
      const nb2 = await msgCount(B.id);
      await call('POST', '/api/chat', { projectId: B.id, text: 'soru: baglam icin' });
      await waitReplies(B.id, nb2 + 1);
      await call('POST', '/api/chat', { projectId: B.id, text: 'YAVAS is' });
      let rs2 = null;
      for (let i = 0; i < 60 && !rs2; i++) { await sleep(150); const x = runOf(await state(), (r) => r.projectId === B.id && r.status === 'running'); if (x) rs2 = x; }
      await call('POST', `/api/runs/${rs2.id}/stop`);
      for (let i = 0; i < 60; i++) { await sleep(150); if (runOf(await state(), (r) => r.id === rs2.id).status === 'stopped') break; }
      await sleep(300);
      const mgrMsgs = (await project(B.id)).messages.filter((m) => m.role === 'manager');
      const enhB = await call('POST', '/api/enhance', { projectId: B.id, text: 'bunu duzelt' });
      check(mgrMsgs.at(-1).text === 'Durduruldu.' && /Baglam: Merhaba, bu sadece/.test(enhB.text || '') && !/Baglam: Durduruldu/.test(enhB.text || ''),
        'iyilestir: son yonetici mesaji "Durduruldu." iken onceki gercek cevap baglama girer');
      const { lastRealManager } = require('../lib/orchestrator');
      check(lastRealManager([{ role: 'manager', text: 'x'.repeat(200) }, { role: 'manager', text: 'Bitti.' }, { role: 'manager', text: 'kisa' }, { role: 'user', text: 'u' }])?.text.length === 200,
        'iyilestir: durum metinleri ve 40 karakterden kisa mesajlar atlanir');
    }
  }

  await call('POST', '/api/chat', { projectId: gen.id, text: 'bir sey yap' });
  s = await waitReplies(gen.id, 1);
  const genRun = runOf(s, (r) => r.projectId === gen.id);
  const wsGen = path.join(env.AI_PANEL_HOME, 'workspaces', gen.id);
  check(!s.projects[0].messages.some((m) => m.role === 'system' && /klasör/.test(m.text)), 'klasorsuz projede hata mesaji yok');
  check(genRun && genRun.projectDir === wsGen && genRun.projectDir !== os.homedir() && fs.existsSync(wsGen), 'klasorsuz proje workspaces/<id> klasorunde calisti');
  check(genRun && /bulut\/uzak is/.test(genRun.notes), 'klasorsuz modda bulut notu eklendi');
  check((fs.statSync(wsGen).mode & 0o077) === 0, 'workspace klasoru 0700');
  // cloud:true + dir dolu -> yine workspace
  const CL = await call('POST', '/api/projects', { name: 'Bulut', dir: projA, cloud: true });
  check(CL.cloud === true, 'cloud alani kaydedildi');
  await call('POST', '/api/chat', { projectId: CL.id, text: 'bulutta bir sey yap' });
  s = await waitReplies(CL.id, 1);
  const clRun = runOf(s, (r) => r.projectId === CL.id);
  check(clRun && clRun.projectDir === path.join(env.AI_PANEL_HOME, 'workspaces', CL.id) && clRun.projectDir !== projA, 'cloud:true projede dir dolu olsa da workspace kullanildi');
  // Secili ama olmayan klasor -> eski hata
  const MS = await call('POST', '/api/projects', { name: 'Yok', dir: path.join(tmp, 'yok-boyle-klasor') });
  await call('POST', '/api/chat', { projectId: MS.id, text: 'bir sey yap' });
  s = await waitReplies(MS.id, 1);
  check(/Proje klasörü bulunamadı/.test((await project(MS.id)).messages.at(-1).text), 'secili ama olmayan klasorde eski hata korundu');
  // Calisan isler bitsin ki sonraki testler etkilenmesin
  for (let i = 0; i < 100; i++) { const st = await state(); if (!st.runs.some((r) => ['queued', 'running'].includes(r.status))) break; await sleep(200); }

  // 8) Durum dosyasi kalici (yeniden baslatinca projeler duruyor)
  // 7f) Limit okuma (pct + LIMIT_RE) birim testleri
  const { pct, extractWindows, LIMIT_RE, trackChild, shutdownChildren, activeChildren } = require('../lib/agents');
  check(pct(0) === 0 && pct(0.24) === 24 && pct(1) === 100 && pct(1, 'ratio') === 100
    && pct(1, 'percent') === 1 && pct(0.5, 'percent') === 0.5 && pct(37, 'percent') === 37
    && pct(null) === null && pct('') === null && pct('abc') === null, 'pct oran ve yuzde tutarli');
  const wRatio = extractWindows({ unifiedWindows: { five_hour: { utilization: 1 }, seven_day: { utilization: 0.41 } } });
  const wPct = extractWindows({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 }, secondary: { usedPercent: 0.5, windowDurationMins: 10080 } } });
  check(wRatio.fiveHour.pct === 100 && wRatio.week.pct === 41 && wPct.fiveHour.pct === 1 && wPct.week.pct === 0.5, 'extractWindows oran (utilization:1->100) ve yuzde (usedPercent:1->1) dogru');
  const limitTrue = [
    'Claude AI usage limit reached',
    'RESOURCE_EXHAUSTED: individual quota reached',
    'Rate limit exceeded. Try again in 2 hours.',
    'You have hit your limit, limit will reset at 5pm',
    'HTTP 429 Too Many Requests',
    'Request failed with status code 429',
    'Error: 429 rate_limit_error',
    'You exceeded your current quota',
    'insufficient_quota',
    'You are out of credits',
  ];
  const limitFalse = [
    'Test failed in 429ms',
    'Listening on port 4290',
    'SyntaxError at server.js:429:12',
    'FAIL test/rate_limit.test.js: expected 200 got 500',
    'Implemented rate-limit middleware for API',
    'Added user quota field to database schema',
    'Updated usage limit documentation in README',
    '429 tests passed, 1 failed',
  ];
  check(limitTrue.every((x) => LIMIT_RE.test(x)) && limitFalse.every((x) => !LIMIT_RE.test(x)), 'LIMIT_RE gercek hatalari yakalar, normal metinde yanlis pozitif vermez');

  // 7g) Zamanlanmis gorevler: gece yarisi (00:00, 23:59, gun/yil donumu) sinirlari
  const { dueKey } = require('../lib/smart');
  const s2359 = { enabled: true, time: '23:59', days: [] };
  check(!isDue(s2359, new Date(2026, 0, 5, 23, 58, 59))
    && dueKey(s2359, new Date(2026, 0, 5, 23, 59, 0)) === '2026-1-5'
    && dueKey(s2359, new Date(2026, 0, 6, 0, 0, 0)) === '2026-1-5'
    && !isDue({ ...s2359, lastKey: '2026-1-5' }, new Date(2026, 0, 6, 0, 5, 0))
    && dueKey({ ...s2359, lastKey: '2026-1-5' }, new Date(2026, 0, 6, 23, 59, 0)) === '2026-1-6'
    && dueKey(s2359, new Date(2026, 0, 6, 2, 58, 59)) === '2026-1-5'
    && !isDue(s2359, new Date(2026, 0, 6, 2, 59, 0)), 'zamanlama 23:59 gece yarisi telafisi ve cift calismama');
  const sMonLate = { enabled: true, time: '23:30', days: [1] }; // pazartesi
  const sTueLate = { enabled: true, time: '23:30', days: [2] }; // sali
  const sMidTue = { enabled: true, time: '00:00', days: [2] };  // sali 00:00
  check(dueKey(sMonLate, new Date(2026, 0, 6, 0, 30, 0)) === '2026-1-5'
    && !isDue(sTueLate, new Date(2026, 0, 6, 0, 30, 0))
    && !isDue(sMidTue, new Date(2026, 0, 5, 23, 59, 59))
    && dueKey(sMidTue, new Date(2026, 0, 6, 0, 0, 0)) === '2026-1-6'
    && !isDue(sMidTue, new Date(2026, 0, 6, 3, 0, 0))
    && dueKey({ enabled: true, time: '23:30', days: [] }, new Date(2026, 0, 1, 0, 30, 0)) === '2025-12-31'
    && !isDue({ enabled: true, time: '24:00', days: [] }, new Date(2026, 0, 6, 0, 5, 0)), 'zamanlama 00:00, gun filtresi ve yil donumu');

  // 7h) Worktree acilamazsa ana klasorde calismamali, Turkce hatayla failed/error olmali
  const projWT = mkRepo('projWT');
  const WT = await call('POST', '/api/projects', { name: 'WTTest', dir: projWT });
  await call('POST', `/api/projects/${WT.id}`, { finish: { mode: 'none' } });
  await call('POST', '/api/chat', { projectId: WT.id, text: 'wt hazirlik', mode: 'split' });
  s = await waitReplies(WT.id, 1, 20000);
  const wtRun = runOf(s, (r) => r.projectId === WT.id);
  const wtTask = wtRun.rounds[0].tasks.find((t) => t.branch);
  // Dali silerek devam isinin worktree acmasini basarisizliga ugrat
  execSync(`git branch -D ${wtTask.branch}`, { cwd: projWT, stdio: 'ignore' });
  const wtFilesBefore = fs.readdirSync(projWT).sort().join(',');
  const wtCont = await call('POST', `/api/runs/${wtRun.id}/tasks/${wtTask.id}/continue`, { text: 'bozuk dal testi', accountId: c3.id });
  s = await waitReplies(WT.id, 2, 20000);
  const wtFailRun = s.runs.find((r) => r.id === wtCont.runId);
  const wtFailTask = wtFailRun && wtFailRun.rounds[0]?.tasks[0];
  const wtFilesAfter = fs.readdirSync(projWT).sort().join(',');
  check(wtFailRun && wtFailRun.status === 'error' && wtFailTask && wtFailTask.status === 'failed' && !wtFailTask.branch
    && /Çalışma kopyası \(worktree\) oluşturulamadı/.test(wtFailTask.report || '')
    && wtFilesBefore === wtFilesAfter && !execSync('git status --porcelain', { cwd: projWT }).toString().trim(),
  'worktree hatasi: ana klasore dokunmadan failed/error durumuna gecti');

  // 7i) Kullanilmayan ai-panel/* dallari ve worktree temizligi (birlesmemis dallar korunur)
  const { cleanupBranches } = require('../lib/orchestrator');
  const projAFirstRun = s.runs.find((r) => r.projectId === A.id && r.goal === 'uygulamayi iyilestir');
  const projABranches = execSync('git branch --list "ai-panel/*" --format="%(refname:short)"', { cwd: projA }).toString().trim().split('\n').filter(Boolean);
  check(!projABranches.includes(projAFirstRun.bestBranch) && projABranches.includes(ct.branch),
    'otomatik temizlik: birlesen dal silindi, bekleyen birlesmemis dal korundu');
  // Birlesmis, bos ve birlesmemis dallari cleanupBranches ile dogrudan test et
  const projCL = mkRepo('projCL');
  execSync('git branch ai-panel/cl-empty HEAD', { cwd: projCL });
  execSync('git checkout -q -b ai-panel/cl-pending && echo x > pending.txt && git add -A && git -c user.name=t -c user.email=t@t commit -q -m p', { cwd: projCL });
  execSync('git checkout -q -b ai-panel/cl-discard HEAD~1 && echo y > disc.txt && git add -A && git -c user.name=t -c user.email=t@t commit -q -m d', { cwd: projCL });
  execSync('git checkout -q -b ai-panel/cl-merged HEAD~1 && echo z > m.txt && git add -A && git -c user.name=t -c user.email=t@t commit -q -m m', { cwd: projCL });
  execSync('git checkout -q - && git checkout -q master 2>/dev/null || git checkout -q main', { cwd: projCL });
  execSync('git merge -q --no-ff --no-edit ai-panel/cl-merged', { cwd: projCL });
  const fakeWt = path.join(tmp, 'cl-home', 'worktrees', 'oldrun-1-1');
  fs.mkdirSync(fakeWt, { recursive: true });
  const clRes = cleanupBranches({
    home: path.join(tmp, 'cl-home'),
    state: { projects: [{ dir: projCL }], runs: [{ id: 'oldrun', status: 'done', projectDir: projCL, rounds: [] }] },
  }, { projectDir: projCL, discardBranches: ['ai-panel/cl-discard'] });
  const leftCl = execSync('git branch --list "ai-panel/*" --format="%(refname:short)"', { cwd: projCL }).toString().trim().split('\n').filter(Boolean);
  check(clRes.removedBranches.includes('ai-panel/cl-merged') && clRes.removedBranches.includes('ai-panel/cl-empty')
    && clRes.removedBranches.includes('ai-panel/cl-discard') && !fs.existsSync(fakeWt)
    && leftCl.length === 1 && leftCl[0] === 'ai-panel/cl-pending',
  'cleanupBranches: birlesmis/bos/atilmis dallar ve artik worktree temizlendi, birlesmemis dal korundu');

  // 7i2) Sohbeti temizlemek / projeyi silmek incelenmemis is dallarini silmemeli
  {
    const dir = mkRepo('projKeep');
    const brs = () => execSync("git branch --list 'ai-panel/*'", { cwd: dir, encoding: 'utf8' }).split('\n').filter((x) => x.trim()).length;
    const K = await call('POST', '/api/projects', { name: 'Dal koru', dir });
    await call('POST', '/api/chat', { projectId: K.id, text: 'uygulamayi iyilestir', mode: 'split' });
    await waitReplies(K.id, 1, 20000);
    const before = brs();
    await call('POST', `/api/projects/${K.id}/clear`);
    const afterClear = brs();
    await call('DELETE', `/api/projects/${K.id}`);
    const afterDel = brs();
    check(before > 0 && afterClear === before && afterDel === before, `temizle/sil incelenmemis dallari silmedi (${before} -> ${afterClear} -> ${afterDel})`);
  }

  // 7i2b) Yeni sohbete gec: ozet tasinir, incelenmemis dal silinmez; gecmis ayiklama
  {
    const dir = mkRepo('projCarry');
    const brs = () => execSync("git branch --list 'ai-panel/*'", { cwd: dir, encoding: 'utf8' }).split('\n').filter((x) => x.trim()).length;
    const K = await call('POST', '/api/projects', { name: 'Yeni sohbet', dir });
    await call('POST', '/api/chat', { projectId: K.id, text: 'uygulamayi iyilestir', mode: 'split' });
    await waitReplies(K.id, 1, 20000);
    const before = brs();
    const oldMgr = (await project(K.id)).messages.filter((m) => m.role === 'manager').at(-1).text;
    await call('POST', `/api/projects/${K.id}/clear`, { carry: true });
    const pk = await project(K.id);
    check(pk.messages.length === 1 && pk.messages[0].role === 'manager' && pk.messages[0].text.startsWith('**Önceki sohbetin özeti**')
      && pk.messages[0].text.includes(oldMgr.slice(0, 30)) && brs() === before && before > 0,
    `yeni sohbete gecis: ozet ilk mesaj, incelenmemis dal silinmedi (${before} -> ${brs()})`);
    await call('POST', `/api/projects/${K.id}/clear`);
    check((await project(K.id)).messages.length === 0, 'duz temizle: ozet tasimaz');
    await call('DELETE', `/api/projects/${K.id}`);

    const { buildHistory, formatHistory, carrySummary, CTX } = require('../lib/orchestrator');
    const A = 'Uzun istek A. ' + 'a'.repeat(600) + '\nBagimlilik ekleme.\n' + 'b'.repeat(600);
    const M = (id, role, text) => ({ id, role, text });
    const cur = M('cur', 'user', 'yeni istek');
    const hist = buildHistory([M(1, 'user', A), M(2, 'manager', 'Durduruldu.'), M(3, 'user', A), M(4, 'manager', 'Bitti.'),
      M(5, 'user', A.replace(/ /g, '   ')), M(6, 'manager', 'Bir hata oldu, ayrıntılara bak.'), M(7, 'manager', 'r'.repeat(500)), M(8, 'system', 'sys'), cur], cur);
    check(hist.length === 2 && hist[0].role === 'user' && hist[1].role === 'manager', 'gecmis: ardisik ayni kullanici mesaji tek kez, durum mesajlari ve sistem mesaji girmez');
    check(buildHistory([M(1, 'user', 'ayni  istek'), M(2, 'manager', 'x'.repeat(100)), M(3, 'user', 'ayni istek')], M(3, 'user', 'ayni istek')).length === 2
      && buildHistory([M(1, 'user', 'a'), M(2, 'manager', 'Durduruldu.'), M(3, 'user', 'a')], M(9, 'user', 'b')).length === 1, 'gecmis: son kullanici mesaji mevcut istekle aynıysa tekrarlanmaz');
    // Eski turlar kisalir ama kural satiri tasinir; son 3 tur ve son kullanici mesaji tam kalir
    const turns = Array.from({ length: 6 }, (_, i) => [M('u' + i, 'user', `TUR${i}_BASI ` + 'x'.repeat(900) + (i === 0 ? '\nGit push yapma.\n' : '') + 'y'.repeat(900) + ` TUR${i}_SONU`), M('m' + i, 'manager', 'rapor ' + i)]).flat();
    const fh = formatHistory(turns);
    check(!fh.includes('x'.repeat(400)) === false && fh.includes('KULLANICI (kisaltildi): TUR0_BASI') && fh.includes('Git push yapma.')
      && turns.filter((m) => m.role === 'user').slice(-CTX.recentTurns).every((m) => fh.includes(m.text)),
    'gecmis: eski tur kisalir ve kural satiri tasinir, son turlar ve son kullanici mesaji tam kalir');
    const longLast = [M(1, 'user', 'k'.repeat(5000)), M(2, 'manager', 'm'.repeat(100)), M(3, 'user', 'z'.repeat(5000))];
    check(formatHistory(longLast).includes('z'.repeat(5000)), 'gecmis: son kullanici mesaji asla kisaltilmaz');
    const cs = carrySummary([M(1, 'user', 'istek'), M(2, 'manager', 'S'.repeat(3000)), M(3, 'manager', 'Durduruldu.')]);
    check(cs.length < 1000 && cs.includes('Son istek: istek') && cs.includes('S'.repeat(100)) && !cs.includes('Durduruldu') && carrySummary([M(1, 'user', 'a')]) === '', 'ozet: son gercek cevaptan kirpilir, durum metni girmez, cevap yoksa bos');
    const i18nH = require(path.join(__dirname, '..', 'public', 'i18n.js'));
    const appH = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const htmlH = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check(['hist.tip', 'hist.go', 'hist.close', 'hist.title', 'hist.text', 'hist.ok', 'help.hist.k', 'help.hist.h'].every((k) => i18nH.DICT.tr[k] && i18nH.DICT.en[k])
      && i18nH.DICT.tr['hist.tip'] === 'Sohbet uzadı; yeni sohbete geçmek token tasarrufu sağlar.' && /data-i18n="help\.hist\.k"/.test(htmlH)
      && /data-hist-new/.test(appH) && /carry: true/.test(appH) && /histTip/.test(appH), 'yeni sohbete gec: oneri, dugme, TR/EN metinleri ve yardim satiri var');
    const ms = require('./measure-history').measure();
    check(ms[0].chars < 6000 && ms[1].chars < 4500, `gecmis olcumu: istem ${ms[0].chars}, gecmis bolumu ${ms[1].chars} karakter (onceki 7133 / 5839)`);
  }

  // 7i3) Dusunme seviyesi (effort) ve "yonetici de is alsin"
  {
    const { TYPES } = require('../lib/agents');
    const ca = TYPES.claude.args('x'.repeat(50), 'full', 'opus', 'high');
    const xa = TYPES.codex.args('x'.repeat(50), 'full', '', 'medium');
    check(ca.join(' ').includes('--model opus --effort high') && xa.includes('model_reasoning_effort="medium"') && !TYPES.antigravity.efforts, 'effort bayraklari: Claude --effort, Codex model_reasoning_effort, Antigravity yok');
    const okE = await call('POST', `/api/accounts/${c3.id}/update`, { effort: 'high' });
    const badE = await call('POST', `/api/accounts/${g1.id}/update`, { effort: 'high' });
    const st0 = await state();
    check(okE.effort === 'high' && !badE.effort && st0.efforts && st0.efforts.claude.includes('max'), 'effort sadece destekleyen hesaplara kaydedilir');
    await call('POST', `/api/accounts/${c3.id}/update`, { effort: '' });
    const dir = mkRepo('projMgr');
    const P = await call('POST', '/api/projects', { name: 'Yonetici calisir', dir });
    await call('POST', '/api/settings', { managerWorks: true });
    await call('POST', '/api/chat', { projectId: P.id, text: 'uygulamayi iyilestir', mode: 'split' });
    const sM = await waitReplies(P.id, 1, 20000);
    const rM = runOf(sM, (r) => r.projectId === P.id);
    await call('POST', '/api/settings', { managerWorks: false });
    await call('DELETE', `/api/projects/${P.id}`);
    check(rM && rM.workerIds.includes(c1.id) && rM.rounds[0].tasks.some((t) => t.assigneeId === c1.id), 'yonetici de is alsin acikken yonetici kendine gorev aldi');
  }

  // 7j) ETag / 304 optimizasyonu (/api/state degismediyse 304 doner)
  const stRes1 = await fetch(`http://localhost:${PORT}/api/state`, { headers: { 'X-AI-Panel': '1' } });
  const etag = stRes1.headers.get('etag');
  const stRes2 = await fetch(`http://localhost:${PORT}/api/state`, { headers: { 'X-AI-Panel': '1', 'If-None-Match': etag } });
  check(Boolean(etag) && stRes1.status === 200 && stRes2.status === 304, 'ETag/304: degismeyen durum tekrar gonderilmedi');

  // 7j2) Paneli yeniden baslat: baslik zorunlu, canli is varken bekler, iptal edilir (gercek respawn kapali)
  {
    const noHdr = await fetch(`http://localhost:${PORT}/api/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check(noHdr.status === 403, 'restart: X-AI-Panel basligi olmadan 403');
    const app0 = (await state()).app || {};
    check(typeof app0.bootId === 'string' && app0.bootId.length > 0 && 'bootHead' in app0 && 'head' in app0 && app0.updateAvailable === false && app0.restartPending === false, 'state.app alanlari var (bootId, bootHead, head, updateAvailable, restartPending)');
    await call('POST', '/api/chat', { projectId: B.id, text: 'YAVAS restart testi' });
    let liveRun = null;
    for (let i = 0; i < 60 && !liveRun; i++) { await sleep(150); liveRun = (await state()).runs.find((r) => r.projectId === B.id && ['running', 'queued'].includes(r.status)); }
    check(!!liveRun, 'restart: canli is basladi');
    const rq = await call('POST', '/api/restart', {});
    check(rq.restartPending === true && (await state()).app.restartPending === true, 'restart: canli is varken restartPending true oldu (hemen kapanmadi)');
    const rc = await call('POST', '/api/restart', { cancel: true });
    check(rc.restartPending === false && (await state()).app.restartPending === false, 'restart: cancel beklemeyi iptal etti');
    await call('POST', '/api/restart', {});
    for (let i = 0; i < 120; i++) { await sleep(250); if (!(await state()).runs.some((r) => r.id === liveRun.id && ['running', 'queued'].includes(r.status))) break; }
    let pend = true;
    for (let i = 0; i < 40 && pend; i++) { await sleep(250); pend = (await state()).app.restartPending; }
    check(pend === false, 'restart: is bitince bekleyen yeniden baslatma tetiklendi (respawn kapali)');
    const rNow = await call('POST', '/api/restart', {});
    check(rNow.restarting === true, 'restart: canli is yokken hemen baslatilir');
  }

  // 7k) Alt surec kapatma: SIGTERM yok sayan cocuk + torun surec grubu SIGKILL ile kapanir
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pidMarker = path.join(tmp, 'trap.pid');
  const stubborn = trackChild(spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    const { spawn } = require('child_process');
    const sub = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    require('fs').writeFileSync(${JSON.stringify(pidMarker)}, process.pid + ':' + sub.pid);
    setTimeout(() => {}, 60000);
  `], { detached: process.platform !== 'win32', stdio: 'ignore' }));
  for (let i = 0; i < 40 && !fs.existsSync(pidMarker); i++) await sleep(50);
  const [parentPid, grandPid] = fs.readFileSync(pidMarker, 'utf8').split(':').map(Number);
  const beforeTrack = activeChildren.has(stubborn);
  await shutdownChildren(250);
  await sleep(150);
  check(beforeTrack && !alive(parentPid) && !alive(grandPid), 'shutdownChildren: SIGTERM yok sayan cocuk ve torun surec grubu SIGKILL ile kapandi');

  // --- tur4 i18n/onizleme ---
  {
    // 1) Bulgu 14b: merge ucunda reason metin degilse 400 doner
    const sT4 = await state();
    let mRun = null, mTask = null;
    for (const r of sT4.runs) {
      for (const R of r.rounds || []) {
        const t = (R.tasks || []).find((x) => x.branch);
        if (t) { mRun = r; mTask = t; break; }
      }
      if (mTask) break;
    }
    check(Boolean(mRun && mTask), 'tur4: merge reason testi icin dalli gorev bulundu');
    if (mRun && mTask) {
      const postMerge = async (payload) => {
        const res = await fetch(`http://localhost:${PORT}/api/runs/${mRun.id}/tasks/${mTask.id}/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AI-Panel': '1', 'X-AI-Token': TOKEN },
          body: JSON.stringify(payload),
        });
        return { status: res.status, body: await res.json() };
      };
      const rObj = await postMerge({ force: true, reason: {} });
      const rNum = await postMerge({ force: true, reason: 12345678 });
      const rNull = await postMerge({ force: true, reason: null });
      check(rObj.status === 400 && rObj.body.ok === false && /metin/.test(rObj.body.error), 'tur4: merge reason nesne gelince 400 dondu');
      check(rNum.status === 400 && rNull.status === 400, 'tur4: merge reason sayi veya null gelince 400 dondu');
    }

    // 2) Bulgu 11: TR -> EN sunucu hata metinleri ve Git onek gecisi
    const i18nT4 = require(path.join(__dirname, '..', 'public', 'i18n.js'));
    i18nT4.setLang('en');
    const t4Cases = [
      ['Birleştirme tamamlanamadı. fatal: refusing to merge', /^Merge could not be completed\. fatal: refusing to merge$/],
      ['Geri alma tamamlanamadı. fatal: bad revision', /^Undo could not be completed\. fatal: bad revision$/],
      ['Birleştirme tamamlanamadı. HEAD ayrık. Önce hedef dala geç.', /^Merge could not be completed\. HEAD is detached\. Switch to the target branch first\.$/],
      ['Birleştirme tamamlanamadı. Görev dalı bulunamadı: ai-panel/abc', /^Merge could not be completed\. Task branch not found: ai-panel\/abc$/],
      ['Birleştirme tamamlanamadı. Çakışan dosyalar: a.js, b.js. İşlem iptal edildi.', /^Merge could not be completed\. Conflicting files: a\.js, b\.js\. The operation was aborted\.$/],
      ['Geri alma tamamlanamadı. Git indeksi kilitli (index.lock). Diğer Git işlemini kontrol et.', /^Undo could not be completed\. The Git index is locked \(index\.lock\)\. Check the other Git process\.$/],
      ['Geri alma tamamlanamadı. Projede devam eden bir Git işlemi var (REVERT_HEAD). Önce o işlemi tamamla.', /^Undo could not be completed\. A Git operation is in progress in the project \(REVERT_HEAD\)\. Finish it first\.$/],
      ['Görev dalı bulunamadı: ai-panel/t1', /^Task branch not found: ai-panel\/t1$/],
      ['Görev dalı zaten hedef dalın geçmişinde.', /^The task branch is already in the target branch history\.$/],
      ['HEAD ayrık. Önce hedef dala geç.', /^HEAD is detached\. Switch to the target branch first\.$/],
      ['Git indeksi kilitli (index.lock). Diğer Git işlemini kontrol et.', /^The Git index is locked \(index\.lock\)\. Check the other Git process\.$/],
      ['Projede devam eden bir Git işlemi var (MERGE_HEAD). Önce o işlemi tamamla.', /^A Git operation is in progress in the project \(MERGE_HEAD\)\. Finish it first\.$/],
      ['Hedef dal main. Geri almak için o dala geç. Etkin dal: feature.', /^The target branch is main\. Switch to it to undo\. Current branch: feature\.$/],
      ['Eski kayıtta hedef dal bilgisi yok. Geri alma için Git geçmişini kontrol et.', /^The old record has no target branch\. Check the Git history to undo\.$/],
      ['Birleştirme commit’i etkin dalın geçmişinde yok.', /^The merge commit is not in the current branch history\.$/],
      ['Çakışan dosyalar: x.js. İşlem iptal edildi.', /^Conflicting files: x\.js\. The operation was aborted\.$/],
      ['Panel yeniden başlatıldığı için iş durduruldu.', /^The job was stopped because the panel restarted\.$/],
      ['Otomatik doğrulama başarısız (npm test, kod -1). Başarısız dal ana dala alınamaz; önce düzelt (Devam ettir) ya da gerekçe yazarak "Yine de al".', /^Automatic check failed \(npm test, code -1\)\. A failed branch cannot be merged; fix it first \(Continue\) or write a reason to "Merge anyway"\.$/],
      ['Gerekçe metin olmalı.', /^Reason must be text\.$/],
      ['Bu görev bitmedi ya da başarısız oldu (durum: failed). Başarısız ya da yarım bir dal ana dala alınamaz.', /^This task did not finish or failed \(status: failed\)\./],
      ['Dal gizli dosya içeriyor (.env). Güvenlik için birleştirme engellendi.', /^The branch contains secret files \(\.env\)\./],
    ];
    const t4Bad = t4Cases.filter(([tr, re]) => !re.test(i18nT4.srv(tr))).map(([tr]) => `${tr} => ${i18nT4.srv(tr)}`);
    check(!t4Bad.length, 'tur4: tum sunucu hata metinleri TR->EN cevrilir' + (t4Bad.length ? ' -> ' + t4Bad.join(' | ') : ''));
    i18nT4.setLang('tr');

    // 3) Bulgu 12: pvCache basarili birlestirme, geri alma ve run SSE olayinda temizlenir
    const appSrcT4 = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    check(/async function mergeTask[\s\S]*?\/merge[\s\S]*?pvCache\.clear\(\)/.test(appSrcT4), 'tur4: mergeTask basarili birlestirme sonrasi pvCache temizler');
    check(/async function forceMerge[\s\S]*?\/merge[\s\S]*?pvCache\.clear\(\)/.test(appSrcT4), 'tur4: forceMerge basarili birlestirme sonrasi pvCache temizler');
    check(/\/unmerge`\)[\s\S]{0,120}pvCache\.clear\(\)/.test(appSrcT4), 'tur4: unmerge basarili geri alma sonrasi pvCache temizler');
    check(/es\.addEventListener\('run',\s*\(\)\s*=>\s*\{\s*pvCache\.clear\(\);\s*refresh\(\);\s*\}\)/.test(appSrcT4), 'tur4: run SSE olayinda pvCache temizlenir');

    // 4) Yardim penceresinde emoji yok (diger satirlarla uyumlu)
    const htmlT4 = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check(!htmlT4.includes('🔍') && i18nT4.DICT.tr['help.b.search.k'] === 'Ara' && i18nT4.DICT.en['help.b.search.k'] === 'Search', 'tur4: yardim penceresinde Ara satiri emojisiz ve digerleriyle uyumlu');
  }

  // 7l) Sunucu SIGTERM alinca calisan ajan alt sureci ve torunu da kapanir
  const srvPidFile = path.join(tmp, 'srv-child.pid');
  await call('POST', '/api/chat', { projectId: B.id, text: `BEKLE_PID:${srvPidFile}` });
  for (let i = 0; i < 80 && !fs.existsSync(srvPidFile); i++) await sleep(100);
  const hasSrvChild = fs.existsSync(srvPidFile);
  const [srvAgentPid, srvGrandPid] = hasSrvChild ? fs.readFileSync(srvPidFile, 'utf8').split(':').map(Number) : [0, 0];
  srv.kill('SIGTERM');
  for (let i = 0; i < 40 && srv.exitCode === null; i++) await sleep(100);
  await sleep(150);
  check(hasSrvChild && !alive(srvAgentPid) && !alive(srvGrandPid), 'sunucu kapaninca calisan ajan ve alt sureci kapandi');
  const saved = JSON.parse(fs.readFileSync(path.join(env.AI_PANEL_HOME, 'state.json'), 'utf8'));
  const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
  check(mode(env.AI_PANEL_HOME) === '700' && mode(path.join(env.AI_PANEL_HOME, 'accounts')) === '700' && mode(path.join(env.AI_PANEL_HOME, 'accounts', c1.id)) === '700' && mode(path.join(env.AI_PANEL_HOME, 'state.json')) === '600',
    'veri klasorleri 0700, state.json 0600 (' + [env.AI_PANEL_HOME, path.join(env.AI_PANEL_HOME, 'state.json')].map(mode).join('/') + ')');
  check(saved.projects.length === 8 && saved.projects.some((p) => p.name === 'Uygulama' && p.finish.mode === 'none'), 'durum diske kaydedildi');

  // 8) Iki dilli arayuz (tr / en): sozluk esitligi, anahtar kapsami, dil degistirme
  {
    const vm = require('vm');
    const pub = path.join(__dirname, '..', 'public');
    const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
    const html = read('index.html'), appJs = read('app.js');
    check(html.indexOf('/i18n.js') > 0 && html.indexOf('/i18n.js') < html.indexOf('/app.js') && html.indexOf('/prompts.js') < html.indexOf('/app.js'), 'i18n.js, app.js\'ten once yukleniyor');
    // Sahte tarayici ortaminda i18n.js'i calistir
    const mkEnv = (stored) => {
      const store = stored ? { 'aip.lang': JSON.stringify(stored) } : {};
      const docEl = { lang: 'tr' };
      const ctx = { module: { exports: {} }, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } }, document: { documentElement: docEl, title: '', querySelectorAll: () => [] } };
      ctx.window = ctx; vm.runInNewContext(read('i18n.js'), ctx);
      return { I: ctx.module.exports, store, docEl, ctx };
    };
    const { I: I18, store, docEl, ctx: bctx } = mkEnv();
    const { tr, en } = I18.DICT;
    const trK = Object.keys(tr).sort(), enK = Object.keys(en).sort();
    check(trK.length > 400 && trK.join() === enK.join(), `tr ve en sozlukleri ayni ${trK.length} anahtara sahip`);
    const empty = trK.filter((k) => !String(en[k] || '').trim() || (!String(tr[k] || '').trim() && !['cont.pre'].includes(k)));
    check(!empty.length, 'sozluklerde bos deger yok' + (empty.length ? ': ' + empty.slice(0, 5).join(',') : ''));
    const same = trK.filter((k) => tr[k] === en[k] && /[ğüşıöçĞÜŞİÖÇ]/.test(en[k]));
    check(!same.length, 'Ingilizce sozlukte Turkce karakterli metin kalmadi' + (same.length ? ': ' + same.slice(0, 5).join(',') : ''));
    const ph = (o, k) => (o[k].match(/\{\w+\}/g) || []).sort().join();
    const badPh = trK.filter((k) => ph(tr, k) !== ph(en, k));
    check(!badPh.length, 'her anahtarda {degisken} yer tutucular iki dilde ayni' + (badPh.length ? ': ' + badPh.slice(0, 5).join(',') : ''));
    // Anahtar kapsami: HTML ozellikleri ve app.js icindeki L('anahtar') cagrilari
    const htmlKeys = [...html.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria)?="([^"]+)"/g)].map((m) => m[1]);
    const miss1 = [...new Set(htmlKeys)].filter((k) => !(k in tr));
    check(htmlKeys.length > 150 && !miss1.length, `index.html'deki ${new Set(htmlKeys).size} data-i18n anahtarinin hepsi sozlukte` + (miss1.length ? ': ' + miss1.join(',') : ''));
    const jsKeys = [...appJs.matchAll(/\bL\(\s*'([\w.]+)'/g)].map((m) => m[1]);
    const miss2 = [...new Set(jsKeys)].filter((k) => !k.endsWith('.') && !(k in tr)); // 'oneki.' ile biten anahtarlar dinamik (asagida ayri denetlenir)
    check(jsKeys.length > 200 && !miss2.length, `app.js'deki ${new Set(jsKeys).size} L('anahtar') cagrisinin hepsi sozlukte` + (miss2.length ? ': ' + miss2.join(',') : ''));
    // Dinamik anahtar aileleri
    const prompts = require(path.join(pub, 'prompts.js'));
    const fam = [
      ...['queued', 'running', 'waiting', 'done', 'error', 'stopped', 'pending', 'failed', 'limit'].map((x) => 'status.' + x),
      ...['claude', 'codex', 'antigravity', 'gemini'].map((x) => 'typeHint.' + x), ...['none', 'merge', 'custom'].map((x) => 'fin.' + x),
      ...prompts.PROMPT_CATS.map((c) => 'cat.' + c.id), 'cat.mine',
      ...prompts.RULE_PRESETS.flatMap((r) => [`rule.${r.id}.t`, `rule.${r.id}.r`]),
      ...[0, 1, 2, 3, 4, 5, 6].map((d) => 'day.' + d), ...[1, 2, 3, 4].flatMap((n) => [`sp.${n}.t`, `sp.${n}.x`]),
      ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`tour.${n}.t`, `tour.${n}.x`]), ...['reliable', 'fast', 'champ', 'busy', 'warn'].map((x) => 'hl.' + x),
      ...['nova', 'control', 'studio', 'classic', 'minimal', 'terminal', 'paper', 'airy', 'crisp'].map((x) => 'theme.' + x),
    ];
    const miss3 = fam.filter((k) => !(k in tr));
    check(!miss3.length, `dinamik anahtar aileleri (durum, kategori, kural, gun, tur, tema...) tamam` + (miss3.length ? ': ' + miss3.join(',') : ''));
    // Hazir promptlar: her biri Ingilizce, [koseli] alan sayisi ayni
    const pmiss = prompts.PROMPTS.filter((p) => { const e = prompts.PROMPT_EN[p.id]; const n = (x) => (x.match(/\[[^\]\n]+\]/g) || []).length; return !e || !e.title || !e.desc || !e.text || n(e.text) !== n(p.text); });
    check(prompts.PROMPTS.length === 35 && !pmiss.length && Object.keys(prompts.PROMPT_EN).length === prompts.PROMPTS.length, 'hazir promptlarin hepsi Ingilizce (baslik, aciklama, metin; [koseli] alanlar korunmus)' + (pmiss.length ? ': ' + pmiss.map((p) => p.id).join(',') : ''));
    check(prompts.localizePrompt(prompts.PROMPTS[0], 'en').title !== prompts.PROMPTS[0].title && prompts.localizePrompt(prompts.PROMPTS[0], 'tr') === prompts.PROMPTS[0], 'localizePrompt dile gore doner');
    // Davranis: varsayilan tr, degistirince en, saklama, <html lang>, yer tutucu, sunucu metni cevirisi
    check(I18.getLang() === 'tr' && docEl.lang === 'tr' && I18.t('ok') === 'Tamam', 'ilk acilista varsayilan dil Turkce');
    check(I18.t('sub.limited', { left: '5 dk' }) === 'Limitte · 5 dk kaldı' && I18.t('yok.anahtar') === 'yok.anahtar', 't(): degisken yerlestirme ve eksik anahtarda anahtarin kendisi');
    check(I18.setLang('en') && I18.getLang() === 'en' && docEl.lang === 'en' && store['aip.lang'] === '"en"' && I18.t('ok') === 'OK' && I18.locale() === 'en-US', 'dil en olunca <html lang>, localStorage ve t() guncellendi');
    check(!I18.setLang('de') && I18.getLang() === 'en', 'desteklenmeyen dil reddedildi');
    check(I18.srv('Proje yok') === 'No such project' && I18.srv('Claude 1 limitte.') === 'Claude 1 is rate-limited.' && I18.srv('bilinmeyen metin') === 'bilinmeyen metin', 'srv(): sunucudan gelen sabit Turkce metinler cevrilir');
    I18.setLang('tr'); check(I18.srv('Proje yok') === 'Proje yok' && bctx.t('ok') === 'Tamam', 'srv() Turkce modda metni oldugu gibi birakir');
    check(mkEnv('en').I.getLang() === 'en' && mkEnv('en').docEl.lang === 'en' && mkEnv('xx').I.getLang() === 'tr', 'kayitli dil acilista okunur, gecersiz deger tr olur');
    // Sunucu sabit metinleri sozlukte karsiliklariyla duruyor mu
    const srvSrc = read('../server.js');
    const srvMiss = [...srvSrc.matchAll(/error: '([^']+)'/g)].map((m) => m[1]).filter((m) => /[ğüşıöçĞÜŞİÖÇ]|^[A-ZÇĞİÖŞÜ][a-zçğıöşü ]+$/.test(m) && !/forbidden|missing/.test(m) && !Object.values(tr).includes(m));
    check(!srvMiss.length, 'server.js hata metinlerinin hepsi sozlukte' + (srvMiss.length ? ': ' + srvMiss.join(' | ') : ''));
    // Sunucu/yonetici sabit metinleri hala kaynakta ayni yazimla duruyor (sozluk eskimesin)
    const srcAll = srvSrc + read('../lib/orchestrator.js');
    const drift = Object.keys(I18.DICT.tr).filter((k) => k.startsWith('srv.') && !['srv.token', 'srv.stopped', 'srv.error', 'srv.done'].includes(k) && !srcAll.includes(tr[k]));
    check(!drift.length, 'srv.* sozluk metinleri sunucu kaynaginda birebir var' + (drift.length ? ': ' + drift.join(',') : ''));
    I18.setLang('en');
    check(I18.srv('Proje klasörü bulunamadı: /tmp/x') === 'Project folder not found: /tmp/x' && I18.srv('Hata: boom') === 'Error: boom' && I18.srv('Ayarlardan en az bir işçi seç.') === 'Choose at least one worker in Settings.', 'srv(): kalip eslesmeli sunucu metinleri cevrilir');
    I18.setLang('tr');
    // app.js'te sabit Turkce metin kalmamali (yorumlar haric); ceviri sozlukte
    const stray = appJs.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /[ğüşıöçĞÜŞİÖÇ]/.test(l) && !l.trim().startsWith('//'));
    check(!stray.length, 'app.js icinde sabit Turkce metin kalmadi' + (stray.length ? ': satir ' + stray.slice(0, 5).map((x) => x[0]).join(',') : ''));
    // Dil secici ve tema etiketi baglantisi
    check(/id="langSeg"/.test(html) && /data-v="tr"/.test(html) && /data-v="en"/.test(html), 'Ayarlar > Gorunum icinde dil secici var');
    const themeBtns = [...html.matchAll(/<div class="theme-pick" id="themeSeg">([\s\S]*?)<\/div>/g)][0][1];
    const themeIds = [...themeBtns.matchAll(/data-v="(\w+)"/g)].map((m) => m[1]);
    check(themeIds.length >= 6 && themeIds.every((x) => `theme.${x}` in tr), 'her tema dugmesinin sozlukte adi var');
    // Sunucu gercekten yeni davranisi bozmadi: istatistik one cikanlar yapisal alan tasiyor
    const stSrc = read('../lib/stats.js');
    check((stSrc.match(/a: \{ name:/g) || []).length === 5, 'istatistik one cikanlari yapisal alan (a) tasiyor');
  }

  // 8) Ikinci panel ornegi: port doluysa hicbir klasore/state dosyasina dokunmamali; port bossa artik klasor temizlenmeli
  {
    const net = require('net');
    const mkHome = (name) => {
      const h = path.join(tmp, name); const wt = path.join(h, 'worktrees', 'liverun-1-1');
      fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, 'work.txt'), 'is suruyor');
      const st = JSON.stringify({ accounts: [], projects: [], runs: [{ id: 'liverun', status: 'running', projectDir: projA, rounds: [] }], settings: {}, templates: [] });
      fs.writeFileSync(path.join(h, 'state.json'), st);
      return { h, wt, st };
    };
    const runSrv = (h, port) => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...env, PORT: port, AI_PANEL_HOME: h }, stdio: 'ignore' });
    const busy = net.createServer(); await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    const busyPort = busy.address().port;
    const a = mkHome('second-home');
    const second = runSrv(a.h, busyPort);
    const code = await new Promise((r) => { const t = setTimeout(() => { second.kill(); r('timeout'); }, 8000); second.on('exit', (c) => { clearTimeout(t); r(c); }); });
    check(code === 0 && fs.existsSync(path.join(a.wt, 'work.txt')) && fs.readFileSync(path.join(a.h, 'state.json'), 'utf8') === a.st,
      'port doluyken ikinci ornek calisan is klasorune ve state dosyasina dokunmadi');
    // NO_OPEN varken osascript/open cagrilmaz: sahte osascript ve open PATH'e konur, iz birakirsa test kalir
    const fakeBin = path.join(tmp, 'fakebin'); fs.mkdirSync(fakeBin, { recursive: true });
    const trace = path.join(tmp, 'trace.txt');
    for (const n of ['osascript', 'open']) { const f = path.join(fakeBin, n); fs.writeFileSync(f, `#!/bin/sh\necho ${n} >> "${trace}"\n`); fs.chmodSync(f, 0o755); }
    const a2 = mkHome('second-home2');
    const second2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...env, PORT: busyPort, AI_PANEL_HOME: a2.h, PATH: fakeBin + path.delimiter + process.env.PATH }, stdio: 'ignore' });
    const code2 = await new Promise((r) => { const t = setTimeout(() => { second2.kill(); r('timeout'); }, 8000); second2.on('exit', (c) => { clearTimeout(t); r(c); }); });
    check(code2 === 0 && !fs.existsSync(trace), 'NO_OPEN iken ikinci ornek osascript/open cagirmadi ve temiz cikti');
    // AppleScript metni (saf fonksiyon)
    const { focusScript, BROWSERS } = require('../lib/focus');
    const fs1 = focusScript('Google Chrome', 4545), fs2 = focusScript('Arc', 4545);
    check(fs1.includes('tell application "Google Chrome"') && fs1.includes('http://localhost:4545') && fs1.includes('http://127.0.0.1:4545') && fs1.includes('active tab index') && fs1.includes('activate'), 'odak AppleScript metni port ve tarayiciyi iceriyor');
    check(fs2.includes('select') && !fs2.includes('active tab index'), 'Arc icin sekme secimi select ile');
    let bad = 0; for (const [app, port] of [['Safari', 4545], ['Arc', '1; do shell script'], ['Arc', 0]]) { try { focusScript(app, port); } catch { bad++; } }
    check(bad === 3 && BROWSERS.length === 4, 'odak AppleScript gecersiz tarayici/port reddediyor');
    await new Promise((r) => busy.close(r));
    // ==== Alan A: saglamlik ====
    const b = mkHome('first-home');
    const empty = path.join(b.h, 'worktrees', 'empty');
    fs.mkdirSync(empty);
    const dir = mkRepo('recovery');
    const dirty = path.join(b.h, 'worktrees', 'interrupted-1-1');
    require('child_process').execFileSync('git', ['-C', dir, 'worktree', 'add', '-qb', 'ai-panel/interrupted-1-1', dirty]);
    fs.writeFileSync(path.join(dirty, 'taslak'), 'koru');
    const clean = path.join(b.h, 'worktrees', 'interrupted-1-2');
    require('child_process').execFileSync('git', ['-C', dir, 'worktree', 'add', '-qb', 'ai-panel/interrupted-1-2', clean]);
    const pending = { id: 'later', role: 'user', queued: true, text: 'soru: kuyruk' };
    const fixture = {
      projects: [{ id: 'p', dir, messages: [pending], setup: 'touch "$(git rev-parse --git-path index.lock)"' }],
      accounts: saved.accounts, settings: { managerId: c1.id, workerIds: [c3.id] },
      runs: [{ id: 'interrupted', projectId: 'p', projectDir: dir, status: 'running', waitingUntil: Date.now(), submit: { status: 'running' },
        rounds: [{ tasks: [{ status: 'done', phase: 'check' }, { id: '1-1', branch: 'ai-panel/interrupted-1-1', status: 'running' },
          { id: '1-2', branch: 'ai-panel/interrupted-1-2', status: 'pending' }, { status: 'done' }] }] },
        { id: 'legacy', projectId: 'p', status: 'stopped', rounds: [{ tasks: [{ status: 'running' }] }] }],
    };
    const stateFile = path.join(b.h, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(fixture));
    const first = runSrv(b.h, busyPort);
    try {
      let snapshot;
      for (let i = 0; i < 60; i++) {
        try { snapshot = await (await fetch(`http://127.0.0.1:${busyPort}/api/state`)).json(); } catch {}
        if (snapshot?.runs.find((r) => r.id === 'interrupted')?.finishedAt) break;
        await sleep(100);
      }
      const recovered = snapshot.runs.find((r) => r.id === 'interrupted');
      check(recovered.status === 'stopped' && recovered.finishedAt && !recovered.waitingUntil && recovered.submit.status === 'stopped'
        && recovered.rounds[0].tasks.every((t, i) => i === 0 || i === 3 ? t.status === 'done' && !t.phase : t.status === 'stopped' && !t.phase && t.endedAt),
        'yeniden acilista yarim is ve bekleyen gorevler durdu, commiti hazir gorev done kaldi');
      await sleep(500);
      snapshot = await (await fetch(`http://127.0.0.1:${busyPort}/api/state`)).json();
      const pq = snapshot.projects.find((x) => x.id === 'p').messages.find((m) => m.id === pending.id);
      check(pq?.queued && !snapshot.runs.some((r) => r.fromChat === pending.id), 'yeniden acilista kuyruktaki mesaj korundu ve kendiliginden baslamadi');
      const recTask = recovered.rounds[0].tasks.find((t) => t.id === '1-1');
      const recMsg = require('child_process').execFileSync('git', ['-C', dir, 'log', '-1', '--pretty=%s', 'ai-panel/interrupted-1-1'], { encoding: 'utf8' }).trim();
      const recContent = require('child_process').execFileSync('git', ['-C', dir, 'show', 'ai-panel/interrupted-1-1:taslak'], { encoding: 'utf8' }).trim();
      check(!fs.existsSync(empty) && fs.existsSync(path.join(b.wt, 'work.txt'))
        && recMsg === '[ai-panel] kurtarma' && recContent === 'koru' && recTask?.diffstat?.includes('taslak') && recTask?.stat?.n === 1,
        'temizlik bos klasoru kaldirdi, kayitsiz dosyalari korudu ve yarim worktree taslagini kurtarma commitine aldi');

      check(!fs.existsSync(clean), 'temiz ve kayitli eski worktree Git ile kaldirildi');
      check(snapshot.runs.find((r) => r.id === 'legacy').rounds[0].tasks[0].status === 'stopped',
        'eski surumde durmus isin calisiyor kalan gorevi onarildi');

      // Kilitli Git indeksiyle panel commit atamaz; isci dosyasi kurtarilabilmeli.
      const url = `http://127.0.0.1:${busyPort}`;
      const token = (await (await fetch(url)).text()).match(/name="aip-token" content="([^"]+)"/)[1];
      await fetch(url + '/api/chat', { method: 'POST', headers: { 'X-AI-Panel': '1', 'X-AI-Token': token },
        body: JSON.stringify({ projectId: 'p', text: 'dosya yaz', mode: 'race' }) });
      let job;
      for (let i = 0; i < 100; i++) {
        job = (await (await fetch(url + '/api/state')).json()).runs.find((r) => r.goal === 'dosya yaz');
        if (job && !['running', 'queued'].includes(job.status)) break;
        await sleep(100);
      }
      const t = job?.rounds[0]?.tasks[0];
      check(job?.status === 'error' && t?.status === 'failed' && t.cwd && fs.existsSync(t.cwd) && fs.readdirSync(t.cwd).some((f) => f.startsWith('out-')),
        'commit hatasinda gorev basarisiz ve kaydedilemeyen dosya kurtarilabilir');
    } finally {
      const exited = new Promise((resolve) => first.once('exit', resolve));
      first.kill(); await exited;
    }
    check(JSON.parse(fs.readFileSync(stateFile)).runs[0].rounds[0].tasks[1].status === 'stopped', 'kurtarma sonucu diske yazildi');

    const collision = path.join(b.h, 'worktrees', 'collision-1-1');
    fs.mkdirSync(collision, { recursive: true }); fs.writeFileSync(path.join(collision, 'taslak'), 'koru');
    const { Orchestrator } = require('../lib/orchestrator');
    const runner = new Orchestrator({ home: b.h, state: fixture, save() {} }, () => {});
    const task = { id: '1-1', assigneeId: c3.id };
    await runner.runTask({ id: 'collision', projectDir: dir, log: [] }, task, true, new AbortController().signal);
    check(task.status === 'failed' && fs.existsSync(path.join(collision, 'taslak')), 'worktree olusturma hatasi mevcut klasoru korudu');
  }

  // ==== Alan D: token ====
  {
    const { CTX, managerPrompt, workerPrompt, finishPrompt, reportsText, headTail } = require('../lib/orchestrator');
    const { measure, sample } = require('./measure-prompts');
    const { run, workers, tasks } = sample();
    const reps = reportsText(tasks);
    const branches = tasks.map((t) => `- ${t.branch} (${t.assignee}: ${t.title})`).join('\n');
    const m1 = managerPrompt(run, workers, 1, null);
    const m2 = managerPrompt(run, workers, 2, reps);
    const mRace = managerPrompt({ ...run, mode: 'race' }, workers, 2, reps);
    const wp = workerPrompt(run, tasks[0]);
    const fp = finishPrompt(run, reps, tasks[0], branches);

    // Gerekli bolumler ve PLAN JSON formati korunmus
    check(m1.includes('YONETICI') && m1.includes('PROJE NOTU:') && m1.includes('KULLANICININ SON MESAJI:\n' + run.goal)
      && m1.includes('EKIP') && m1.includes('id: "w1"') && m1.includes('<<<PLAN') && m1.includes('PLAN>>>')
      && m1.includes('"done"') && m1.includes('"best"') && m1.includes('"next"') && m1.includes('tum sohbeti kopyalama'),
    'token: managerPrompt tur 1 gerekli bolumleri ve son mesaji tam koruyor');
    check(m2.includes('ONCEKI TURUN RAPORLARI:') && m2.includes('dal: ai-panel/sample-1-1') && m2.includes('KULLANICININ SON MESAJI:\n' + run.goal)
      && mRace.includes('HAKEMsin') && mRace.includes('<<<PLAN'),
    'token: managerPrompt tur 2 ve hakem modu gerekli bolumleri koruyor');
    check(wp.includes('SENIN GOREVIN: ' + tasks[0].title) && wp.includes(tasks[0].instructions) && wp.includes('PROJE NOTU:')
      && wp.includes('KULLANICININ ISTEGI (baglam):'),
    'token: workerPrompt talimati, proje notunu ve hedef baglamini korur');
    const wpDup = workerPrompt({ ...run, goal: 'ayni hedef metni burada' }, { title: 'Yaris', instructions: 'ayni hedef metni burada\nEk aciklama' });
    check(!wpDup.includes('KULLANICININ ISTEGI'), 'token: workerPrompt talimatta zaten gecen hedefi tekrarlamaz');

    // workerPrompt: uzun goal bas+son kirpilir; task.instructions ve run.notes ASLA kirpilmaz
    const longGoalW = 'HEDEF_BASI_KRITIK\n' + 'g'.repeat(6400) + '\nHEDEF_SONU_KRITIK';
    const longInstr = 'TALIMAT_BASI_' + 'i'.repeat(3500) + '_TALIMAT_SONU';
    const longNotes = 'NOT_BASI_' + 'n'.repeat(3000) + '_NOT_SONU';
    const wpBig = workerPrompt({ ...run, goal: longGoalW, notes: longNotes }, { title: 'Buyuk gorev', instructions: longInstr });
    check(wpBig.includes('HEDEF_BASI_KRITIK') && wpBig.includes('HEDEF_SONU_KRITIK') && wpBig.includes('karakter kirpildi') && !wpBig.includes(longGoalW),
      'token: workerPrompt uzun hedefi bas+son kirpar');
    check(wpBig.includes(longInstr) && wpBig.includes(longNotes),
      'token: workerPrompt task.instructions ve run.notes asla kirpilmaz');

    // Bas+son kirpma: ilk ve son satirlar kalir
    const ht = headTail('ILK_SATIR\n' + 'a'.repeat(3000) + '\nSON_SATIR', 400, 1800);
    check(ht.startsWith('ILK_SATIR\n') && ht.endsWith('\nSON_SATIR') && /…\[\d+ karakter kirpildi\]…/.test(ht),
      'token: headTail ilk ve son satirlari korur, ortayi isaretle kirpar');

    // Uzun gecmiste eski mesajlar tek satir ozet olur; son yonetici cevabi (plan) tur 2'de korunur; son kullanici mesaji tam kalir
    const longGoal = 'SON_HEDEF_TAM_KALMALI_' + 'z'.repeat(1600) + '_SON';
    const longHist = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? 'manager' : 'user',
      text: `MESAJ_${i}_BASI_` + (i % 2 ? 'x' : 'u').repeat(3000) + `_MESAJ_${i}_SONU`,
      ...(i % 2 ? { summary: `ozet_${i}` } : {}),
    }));
    const runWithPrevPlan = {
      ...run,
      history: longHist,
      goal: longGoal,
      rounds: [{ n: 1, plan: { summary: 'Tur 1 plan ozeti: 4 alan ayrildi', reply: 'Tur 1 yonetici plani ayrintilari' }, tasks }],
    };
    const mpLong1 = managerPrompt(runWithPrevPlan, workers, 1, null);
    const mpLong2 = managerPrompt(runWithPrevPlan, workers, 2, reps);
    check(mpLong1.includes(longGoal) && mpLong2.includes(longGoal), 'token: uzun gecmiste son kullanici mesaji her turda tam kalir');
    check(mpLong1.includes('ozet_1') && mpLong2.includes('ozet_1') && !mpLong2.includes('MESAJ_1_BASI_'),
      'token: eski gecmis mesajlari tek satir ozet kalir');
    check(mpLong2.includes('MESAJ_11_BASI_') && mpLong2.includes('_MESAJ_11_SONU')
      && !mpLong2.includes('x'.repeat(CTX.lastManagerChars + 1))
      && mpLong2.includes('Tur 1 plan ozeti: 4 alan ayrildi'),
    'token: tur 2 isteminde onceki yonetici cevabi ve plani (~1200 siniri icinde) korunur');

    // reportsText: baslik (durum, dal, baz), Otomatik dogrulama, diffstat ozeti, basarisiz cikti sonu ve rapor bas+son korunur
    const bigDiff = Array.from({ length: 60 }, (_, i) => ` src/dosya_${i}.js | 10 +++++-----`).join('\n')
      + '\n 60 files changed, 300 insertions(+), 300 deletions(-)';
    const repOne = reportsText([{
      id: '1-9',
      assignee: 'Claude 1',
      title: 'Genis degisiklik',
      status: 'done',
      branch: 'ai-panel/test-1-9',
      base: 'abcdef1234567890',
      diffstat: bigDiff,
      check: { cmd: 'npm test', ok: false, code: 1, out: 'HATA_BASI\n' + 'e'.repeat(2000) + '\nHATA_SONU_KRITIK' },
      report: 'RAPOR_ILK_SATIR\n' + 'r'.repeat(3500) + '\nRAPOR_SON_SATIR',
    }]);
    check(repOne.includes('durum: done | dal: ai-panel/test-1-9 | baz: abcdef12')
      && repOne.includes('Otomatik dogrulama (npm test): KALDI')
      && repOne.includes('60 files changed, 300 insertions(+), 300 deletions(-)')
      && repOne.includes('HATA_SONU_KRITIK') && !repOne.includes('HATA_BASI')
      && repOne.includes('RAPOR_ILK_SATIR') && repOne.includes('RAPOR_SON_SATIR')
      && /…\[\d+ karakter kirpildi\]…/.test(repOne),
    'token: reportsText baslik, dogrulama, diffstat ozeti, hata sonu ve rapor bas+sonunu korur');
    check(reps.includes('lib/mod1.js') && reps.includes('Otomatik dogrulama (npm test): KALDI') && !reps.includes(tasks[0].report),
      'token: reportsText ornek gorevlerde diffstat ve dogrulamayi korur, uzun raporu kirpar');

    // finishPrompt: 6 uzun raporda butce adil bolunur, 6 dalin da adi, durumu ve dogrulama satiri kalir
    const sixTasks = Array.from({ length: 6 }, (_, i) => ({
      id: `1-${i + 1}`,
      assignee: `Isci ${i + 1}`,
      title: `Gorev ${i + 1}`,
      status: 'done',
      branch: `ai-panel/six-1-${i + 1}`,
      base: '1234567890abcdef',
      diffstat: ` lib/f${i + 1}.js | 20 ++++\n 1 file changed, 20 insertions(+)`,
      check: { cmd: 'npm test', ok: i !== 4, code: i !== 4 ? 0 : 1, out: 'hata ciktisi ' + 'x'.repeat(1500) },
      report: `BAS_${i + 1}\n` + 'y'.repeat(3000) + `\nSON_${i + 1}`,
    }));
    const sixReps = reportsText(sixTasks);
    const sixBranches = sixTasks.map((t) => `- ${t.branch} (${t.assignee}: ${t.title})`).join('\n');
    const fp6 = finishPrompt(run, sixReps, sixTasks[0], sixBranches);
    const allSixKept = sixTasks.every((t) => fp6.includes(`dal: ${t.branch}`) && fp6.includes(`### ${t.id} |`) && fp6.includes('durum: done'));
    const checkCount = (fp6.match(/Otomatik dogrulama \(npm test\):/g) || []).length;
    check(fp.includes('BITIS ADIMI') && fp.includes('ai-panel/sample-1-1') && fp.includes(run.finish.text) && fp.length < 7500,
      'token: finishPrompt gerekli bolumleri korur ve sinirli kalir');
    check(allSixKept && checkCount === 6 && fp6.length < 8000,
      `token: 6 raporlu finishPrompt 6 dal adini ve dogrulama satirini korur (len=${fp6.length}, check=${checkCount})`);

    // Olcum betigi esiklerinin altinda
    const rows = measure();
    const by = Object.fromEntries(rows.map((r) => [r.name, r.chars]));
    check(by['yonetici istemi (tur 1)'] < 6500 && by['yonetici istemi (tur 2)'] < 18000
      && by['isci istemi'] < 2500 && by['bitis istemi'] < 7500 && by['TOPLAM (4 istem)'] < 33500,
    `token: olcum esikleri altinda (tur1=${by['yonetici istemi (tur 1)']}, tur2=${by['yonetici istemi (tur 2)']}, isci=${by['isci istemi']}, bitis=${by['bitis istemi']}, toplam=${by['TOPLAM (4 istem)']})`);
  }

  // --- tur4 istem baglami ---
  {
    const { managerPrompt, workerPrompt, reportsText, Orchestrator } = require('../lib/orchestrator');
    const { run, workers, tasks } = require('./measure-prompts').sample();
    const goal = 'a'.repeat(1400) + 'Dosya adlarini koru.' + 'b'.repeat(1400);
    const partial = { ...tasks[0], instructions: goal.slice(0, 120) };
    check(workerPrompt({ ...run, goal }, partial).includes(goal),
      'tur4: talimat hedefin basini alintilasa bile ortadaki kisit isciye ulasir');

    const history = [1, 2, 3].flatMap((i) => [
      { role: 'user', text: 'a'.repeat(330) + `Kisit ${i}: yerlesik modulleri kullan.` + 'b'.repeat(630) },
      { role: 'manager', text: 'Sonuc ' + i },
    ]);
    const second = managerPrompt({ ...run, history }, workers, 2, reportsText(tasks));
    check(history.filter((m) => m.role === 'user').every((m) => second.includes(m.text)),
      'tur4: ikinci turda son uc kullanici mesajinin 300. karakterden sonraki kisitlari korunur');
    check(second.includes('"best": tam dal adi (ai-panel/...)') &&
      second.includes('"next": sadece done:true iken, kullanicinin agzindan 2-3 kisa istek'),
      'tur4: plan tam dal adini ve son turda kullanici agzindan onerileri ister');

    const judge = managerPrompt({ ...run, mode: 'race' }, workers, 2, reportsText(tasks, 'race'));
    check(judge.includes('Iscilerin iddialarina degil kanita guven.') && judge.includes('git diff <baz>..<dal>') &&
      judge.includes('baz: a1b2c3d4e5f6\n') && judge.includes(tasks[0].report),
      'tur4: hakeme kanit talimati, diff araligi, 12 karakterlik baz ve genis rapor gider');

    const runner = new Orchestrator({}, () => {});
    const ambiguous = { rounds: [{ tasks: [...tasks, { ...tasks[1], branch: 'ai-panel/diger-1-2' }] }] };
    check(runner.resolveBest(run, '1-2') === tasks[1] && runner.resolveBest(ambiguous, '1-2') === null &&
      runner.resolveBest(ambiguous, tasks[1].branch) === tasks[1] &&
      runner.resolveBest({ rounds: [{ tasks: [tasks[0]] }] }, 'yanlis') === null,
      'tur4: yalnizca tam ad veya tek adaya uyan kisa ad secilir');
  }

  // ==== Alan B: tasarim ====
  {
    const net = require('net');
    const pub = path.join(__dirname, '..', 'public');
    const readP = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
    const html = readP('index.html'), styleCss = readP('style.css'), themesCss = readP('themes.css'), tokCss = readP('tokens.css'), appJs = readP('app.js');
    // 1) tokens.css HTTP ile sunuluyor ve index.html'de style.css'ten once yukleniyor
    const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const pPort = probe.address().port; await new Promise((r) => probe.close(r));
    const tHome = path.join(tmp, 'design-home'); fs.mkdirSync(tHome, { recursive: true });
    const tSrv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...env, PORT: pPort, AI_PANEL_HOME: tHome }, stdio: 'ignore' });
    let tokRes = null;
    for (let i = 0; i < 40; i++) { try { tokRes = await fetch(`http://127.0.0.1:${pPort}/tokens.css`); break; } catch { await sleep(100); } }
    const tokBody = tokRes ? await tokRes.text() : '';
    tSrv.kill();
    check(tokRes && tokRes.status === 200 && /text\/css/.test(tokRes.headers.get('content-type') || ''), 'tokens.css 200 ve text/css olarak sunuluyor');
    check(html.indexOf('/tokens.css') > -1 && html.indexOf('/tokens.css') < html.indexOf('/style.css'), 'tokens.css, style.css oncesinde yukleniyor');
    check(['--sp-4', '--r-md', '--fs-sm', '--elev-2', '--dur-fast', '--ring-w', 'color-scheme'].every((v) => tokBody.includes(v)), 'tokens.css temel tasarim olceklerini iceriyor');
    // 2) themes.css suslu parantez dengesi ve tum temalarin ust seviyede tanimli olmasi (crisp @media icine hapsolmasin)
    const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    const cleanThemes = stripCssComments(themesCss);
    let depth = 0, minDepth = 0;
    const themeAtTop = {};
    const lines = cleanThemes.split('\n');
    for (const l of lines) {
      const m = l.match(/^html\[data-theme="(\w+)"\]\s*\{/);
      if (m && !(m[1] in themeAtTop)) themeAtTop[m[1]] = depth;
      for (const ch of l) { if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth < minDepth) minDepth = depth; } }
    }
    const allThemed = ['nova', 'terminal', 'minimal', 'paper', 'control', 'studio', 'airy', 'crisp'];
    check(depth === 0 && minDepth === 0, `themes.css suslu parantezleri dengeli (son=${depth}, min=${minDepth})`);
    check(allThemed.every((t) => themeAtTop[t] === 0), 'tum data-theme bloklari ust seviyede tanimli (@media icine hapsolmamis): ' + JSON.stringify(themeAtTop));
    // 3) 8 tema x acik/koyu WCAG AA (>= 4.5:1) kontrast dogrulamasi
    const hexRgb = (h) => {
      const s = h.replace('#', '');
      const x = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
      return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
    };
    const lum = (h) => { const [r, g, b] = hexRgb(h).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const cr = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const parseVars = (block) => { const o = {}; for (const m of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) o[m[1]] = m[2]; return o; };
    const grab = (src, re) => { const m = src.match(re); return m ? parseVars(m[1]) : {}; };
    const pairs = [
      ['classic-light', grab(styleCss, /:root\s*\{([\s\S]*?)\n\}/)],
      ['classic-dark', { ...grab(styleCss, /:root\s*\{([\s\S]*?)\n\}/), ...grab(styleCss, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n  \}/) }],
      ...allThemed.flatMap((t) => {
        const light = grab(themesCss, new RegExp(`html\\[data-theme="${t}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
        const darkM = themesCss.match(new RegExp(`@media \\(prefers-color-scheme: dark\\)\\s*\\{\\s*html\\[data-theme="${t}"\\]\\s*\\{([\\s\\S]*?)\\}\\s*\\}`));
        return darkM ? [[`${t}-light`, light], [`${t}-dark`, { ...light, ...parseVars(darkM[1]) }]] : [[`${t}-dark`, light]];
      }),
    ];
    const rgbLum = ([r, g, b]) => [r, g, b].map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    const crRgb = (a, b) => { const l1 = rgbLum(a), l2 = rgbLum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const mixRgb = (fg, bg, p) => fg.map((v, i) => v * p + bg[i] * (1 - p));
    const warnMixM = styleCss.match(/\.tact button\.warn\s*\{[^}]*?background:\s*color-mix\(in srgb,\s*var\(--bad\)\s*(\d+)%/);
    const warnPct = warnMixM ? Number(warnMixM[1]) / 100 : 0.14;
    const aaFails = [];
    for (const [name, v] of pairs) {
      for (const k of ['--muted', '--ok', '--busy', '--bad', '--wait']) {
        if (v[k] && v['--pane'] && cr(v[k], v['--pane']) < 4.5) aaFails.push(`${name} ${k}/${v['--pane']}=${cr(v[k], v['--pane']).toFixed(2)}`);
      }
      if (v['--bad'] && v['--pane']) {
        const wRatio = crRgb(hexRgb(v['--bad']), mixRgb(hexRgb(v['--bad']), hexRgb(v['--pane']), warnPct));
        if (wRatio < 4.5) aaFails.push(`${name} warn-btn=${wRatio.toFixed(2)}`);
      }
      if (v['--on-accent'] && v['--accent'] && cr(v['--on-accent'], v['--accent']) < 4.5) aaFails.push(`${name} on-accent/accent=${cr(v['--on-accent'], v['--accent']).toFixed(2)}`);
    }
    check(!aaFails.length, '8 tema acik/koyu WCAG AA (>=4.5:1) kontrast gecti (yeni warn/pv/flist/forced-note dahil)' + (aaFails.length ? ': ' + aaFails.join(', ') : ''));
    // 4) Erisilebilirlik, klavye, odak ve tasma duzeltmeleri
    check(/id="palInput"[^>]*role="combobox"[^>]*aria-controls="palItems"/.test(html), 'komut paleti combobox ve aria-controls niteliklerine sahip');
    check(/id="acctErr"[^>]*role="alert"/.test(html) && /id="pCheck"[^>]*data-i18n-aria="ps\.checkAria"/.test(html), 'form hata ve dogrulama alani ARIA etiketlerine sahip');
    check(/id="dlgInput"[^>]*aria-labelledby="dlgTitle"[^>]*aria-describedby="dlgText"/.test(html) && /id="dlgArea"[^>]*aria-labelledby="dlgTitle"[^>]*aria-describedby="dlgText"/.test(html), 'genel diyalog girisleri aria-labelledby ve aria-describedby tasiyor');
    check(/id="inboxBtn"[^>]*aria-haspopup="dialog"/.test(html) && /id="projMenuBtn"[^>]*aria-haspopup="menu"/.test(html), 'acilir panel ve menu dugmeleri aria-haspopup tasiyor');
    check(!/Yeni proje \(⌘N\)/.test(html) && /data-v="paper">[\s\S]*?<\/i>Kâğıt/.test(html), 'hayalet Cmd+N kaldirildi ve Kagit yazimi duzeltildi');
    check(/\.inert\s*=\s*modal/.test(appJs) && /role['"],\s*['"]menuitem/.test(appJs) && /aria-activedescendant/.test(appJs), 'modal inert, menu klavye/menuitem ve palet aria-activedescendant etkin');
    check(!/confirmDlg\([^)]*\besc\(/.test(appJs), 'confirmDlg cift kacis (esc) hatasi yok');
    check(/\.banner\s+code\s*\{[^}]*overflow-wrap:\s*anywhere/.test(styleCss) && /@media \(max-width:\s*1100px\)/.test(styleCss) && /\.field select:focus-visible/.test(styleCss), 'kenar cubugu tasma, 1024px duzen ve select odak halkasi tanimli');
    // 5) B2: C kart ogelerinin erisilebilirligi, tema renkleri, dar ekran ve i18n
    check(/<button[^>]*data-force=/.test(appJs) && /<button[^>]*data-preview=/.test(appJs), 'B2: Yine de al ve Cakismayi kontrol et gercek <button>');
    check(/<summary aria-expanded="\$\{open\}">/.test(appJs) && /setAttribute\('aria-expanded',\s*String\(d\.open\)\)/.test(appJs), 'B2: acilir dosya listesi summary aria-expanded tasiyor ve toggle ile guncelleniyor');
    check(/async function forceMerge[\s\S]*?dialog\(\{[^}]*area:\s*true/.test(appJs) && /activateTrap\(EL\.dlgSheet,\s*\{\s*onClose:\s*onCancel,\s*initialFocus:\s*\(\)\s*=>\s*\(wantText \? field/.test(appJs) && /releaseTrap\(EL\.dlgSheet,\s*true\)/.test(appJs), 'B2: gerekce penceresi odak metin alanina gidiyor, kapaninca acan dugmeye donuyor ve arka plan inert');
    check(/class="pv[^"]*" role="status" aria-live="polite"/.test(appJs) && /class="forced-note" role="status"/.test(appJs), 'B2: cakisma sonucu ve forced-note role=status ile duyuruluyor');
    const islevCss = (styleCss.match(/\/\* islev:[\s\S]*?(?=\/\* Dar masaustu)/) || [''])[0];
    check(islevCss.length > 0 && !/#[0-9a-fA-F]{3,6}\b|rgba?\(/.test(islevCss), 'B2: yeni kart siniflarinda sabit renk yok, sadece tema degiskenleri');
    check(/<span class="fp" title="\$\{esc\(f\.path\)\}">/.test(appJs) && /class="pv bad"[^>]*title="\$\{esc\(pv\.files\.join/.test(appJs), 'B2: uzun dosya yollari ve cakisma listesi title tasiyor');
    check(/\.flist \.fp\s*\{[^}]*text-overflow:\s*ellipsis/.test(styleCss) && /\.flist \.fn\s*\{[^}]*tabular-nums/.test(styleCss) && /\.pv\s*\{[^}]*overflow-wrap:\s*anywhere/.test(styleCss) && /@media \(max-width:\s*1100px\)[\s\S]*?\.fsum\s*\{/.test(styleCss), 'B2: 1024px/dar ekranda dosya yollari ve cakisma listesi tasmaz, +/- sayilari hizali');
    // Bulaniklik: backdrop-filter blur, .5px kenarlik ve hover transform'u yok
    const allCss = stripCssComments(styleCss) + stripCssComments(themesCss);
    check(!/backdrop-filter:\s*(?!none)[^;]*blur/.test(allCss), 'Bulaniklik: hicbir yerde backdrop-filter blur yok');
    check(!/(^|[^0-9])\.5px/.test(allCss), 'Bulaniklik: .5px kenarlik / golge halkasi yok (1px kullanilir)');
    check(!/:(hover|focus-visible)\s*\{[^}]*transform:\s*(translate|scale)/.test(allCss.replace(/transform:\s*none/g, '')), 'Bulaniklik: hover/focus durumunda metin tasiyan ogelerde transform yok');
    // Nova teması: tanim, sozluk, varsayilan ve sadelestirme
    const novaCss = (themesCss.match(/html\[data-theme="nova"\]\s*\{[\s\S]*?\n\}/) || [''])[0];
    check(novaCss.includes('--accent: #38bdf8') && /prefers-color-scheme: light\) \{ html\[data-theme="nova"\][\s\S]*?--accent: #2f5bea/.test(themesCss) && /--pop-shadow: none/.test(novaCss), 'Nova: themes.css icinde koyu varsayilan + acik palet, golgesiz');
    const novaRest = themesCss.slice(themesCss.indexOf('9) Nova'));
    check(!/box-shadow:\s*[^;n]*(rgba|#)/.test(novaRest.replace(/inset 2px 0 0 var\(--accent\)/g, '')) && !/text-transform:\s*uppercase|linear-gradient|radial-gradient|backdrop-filter:\s*(?!none)/.test(novaRest), 'Nova: glow, izgara, uppercase, blur yok');
    check(/data-v="nova"/.test(html) && require(path.join(pub, 'i18n.js')).DICT.tr['theme.nova'] && require(path.join(pub, 'i18n.js')).DICT.en['theme.nova'], 'Nova: tema seciciye ve TR/EN sozluge eklendi');
    const runTheme = (saved) => { const vm = require('vm'); const doc = { documentElement: { dataset: {} } }; vm.runInNewContext(readP('theme.js'), { document: doc, JSON, localStorage: { getItem: () => saved } }); return doc.documentElement.dataset.theme; };
    check(runTheme(null) === 'nova' && runTheme(JSON.stringify('airy')) === 'airy' && runTheme(JSON.stringify('classic')) === undefined, 'Nova: yeni kurulumda varsayilan, kayitli aip.theme korunur');
    check(!/id="tbStack"|id="libBtn"|class="org"/.test(html) && !/tbStack|libBtn|class="org"/.test(appJs) && !/\.org\b|\.toolbar \.stack/.test(styleCss + themesCss) && /id="tplBtn"/.test(html) && /e\.key === '\/'/.test(appJs), 'Sadelestirme: ust cubuk avatar dizisi, tekrar Promptlar dugmesi ve .org yok; mesaj kutusu Promptlar + / kaliyor');
    // 6) i18n tasarim ve B2 anahtarlari (TR ve EN)
    const i18n = require(path.join(pub, 'i18n.js'));
    check(i18n.DICT.tr['ps.checkAria'] && i18n.DICT.en['ps.checkAria'] && i18n.DICT.tr['theme.paper'] === 'Kâğıt' && !/'da\b/.test(i18n.DICT.tr['sub.opensAt']), 'i18n tasarim anahtarlari TR/EN tamam ve ek/yazim duzeltildi');
    const cKeys = ['task.force', 'task.forceTitle', 'force.title', 'force.text', 'force.ph', 'force.ok', 'force.short', 'force.note', 'fstat.sum', 'fstat.one', 'fstat.list', 'fstat.bin', 'fstat.more', 'pv.check', 'pv.checking', 'pv.clean', 'pv.conf', 'pv.fail', 'help.merge.k', 'help.merge.h'];
    check(cKeys.every((k) => i18n.DICT.tr[k] && i18n.DICT.en[k] && !/[ğüşıöçĞÜŞİÖÇ]/.test(i18n.DICT.en[k])), 'B2: yeni kart metinlerinin tamami TR ve EN sozlukte, karakterler dogru');
    i18n.setLang('en');
    check(i18n.srv('"Yine de al" için gerekçe yaz (en az 8 karakter).') === 'Write a reason for "Merge anyway" (at least 8 characters).' && /Automatic check failed \(npm test, code 2\)/.test(i18n.srv('Otomatik doğrulama başarısız (npm test, kod 2). Başarısız dal ana dala alınamaz; önce düzelt (Devam ettir) ya da gerekçe yazarak "Yine de al".')), 'B2: yeni sunucu hata metinleri I18N.srv() ile Ingilizceye cevrilir');
    const A2 = [
      ['Git indeksi kilitli (index.lock). Diğer Git işlemini kontrol et.', /index is locked/],
      ['Projede devam eden bir Git işlemi var (MERGE_HEAD). Önce o işlemi tamamla.', /operation is in progress.*MERGE_HEAD/],
      ['HEAD ayrık. Önce hedef dala geç.', /HEAD is detached/],
      ['Proje klasöründe kaydedilmemiş değişiklik var. Önce değişiklikleri kaydet veya sakla.', /uncommitted changes/],
      ['Çakışan dosyalar: a.js, b.js. İşlem iptal edildi.', /Conflicting files: a\.js, b\.js\. The operation was aborted/],
      ['Çakışan dosyalar: a.js. İşlem iptal edilemedi: fatal', /could not be aborted: fatal/],
      ['CONFLICT x Dosya listesi okunamadı: boom. İşlem iptal edildi.', /Could not read the file list: boom/],
      ['Görev dalı bulunamadı: ai-panel/x', /Task branch not found: ai-panel\/x/],
      ['Görev dalı zaten hedef dalın geçmişinde.', /already in the target branch/],
      ['Birleştirme tamamlanamadı. fatal: x', /Merge could not be completed\. fatal: x/],
      ['Geri alma tamamlanamadı. fatal: x', /Undo could not be completed\. fatal: x/],
      ['Eski kayıtta hedef dal bilgisi yok. Geri alma için Git geçmişini kontrol et.', /no target branch/],
      ['Hedef dal main. Geri almak için o dala geç. Etkin dal: dev.', /target branch is main.*Current branch: dev/],
      ['Birleştirme commit’i etkin dalın geçmişinde yok.', /merge commit is not in/],
      ['Panel yeniden başlatıldığı için iş durduruldu.', /panel restarted/],
      ['Değişiklikler kaydedilemedi. Çalışma kopyası korundu: /tmp/x', /Changes could not be saved.*\/tmp\/x/],
      ['Çalışma kopyası korundu: /tmp/x', /Working copy kept: \/tmp\/x/],
    ];
    i18n.setLang('en');
    const bad = A2.filter(([tr, re]) => !re.test(i18n.srv(tr))).map(([tr]) => tr);
    check(!bad.length, 'A2: tum yeni Turkce hata metinleri I18N.srv() ile cevrilir' + (bad.length ? ' -> ' + bad.join(' | ') : ''));
    i18n.setLang('tr');

    // 7) Sekme basligi (titleFor) ve rapor/cevap/dal kopyalama dugmeleri
    const vm = require('vm');
    const tfM = appJs.match(/function titleFor\([\s\S]*?\n\}/);
    check(Boolean(tfM), 'app.js icinde saf titleFor fonksiyonu tanimli');
    if (tfM) {
      const titleFor = vm.runInNewContext(`(${tfM[0]})`);
      const donePending = { id: 'r2', status: 'done', rounds: [{ tasks: [{ branch: 'ai-panel/r2-1-1', diffstat: ' a.js | 2 ++', merged: false }] }] };
      const doneMerged = { id: 'r3', status: 'done', rounds: [{ tasks: [{ branch: 'ai-panel/r3-1-1', diffstat: ' a.js | 2 ++', merged: true }] }] };
      const runTwo = { id: 'r1', status: 'running', rounds: [{ tasks: [{ status: 'running' }, { status: 'running' }, { status: 'done' }] }] };
      const runPlan = { id: 'r4', status: 'running', rounds: [] };
      check(titleFor({ runs: [] }) === 'AI Panel', 'titleFor: bosta sade baslik');
      check(titleFor({ runs: [runTwo] }) === '(● 2) AI Panel' && titleFor({ runs: [runPlan] }) === '(● 1) AI Panel', 'titleFor: calisan is varken (● N) AI Panel');
      check(titleFor({ runs: [donePending] }) === '(✓) AI Panel', 'titleFor: karar bekleyen is varken (✓) AI Panel');
      check(titleFor({ runs: [doneMerged] }) === 'AI Panel' && titleFor({ runs: [donePending], dismissed: new Set(['run:r2']) }) === 'AI Panel', 'titleFor: birlesmis veya kapatilmis is varken sade baslik');
      check(titleFor({ runs: [runTwo, donePending] }) === '(● 2) AI Panel', 'titleFor: calisan is karar bekleyene oncelikli');
      check(titleFor({ runs: [] }, 'AI Panel', 3) === '(3) AI Panel' && titleFor({ runs: [donePending] }, 'AI Panel', 2) === '(2) AI Panel', 'titleFor: gelen kutusu n>0 ise (n) AI Panel, (✓) den onceliklidir');
      check(titleFor({ runs: [runTwo] }, 'AI Panel', 5) === '(● 2) AI Panel', 'titleFor: calisan is gelen kutusundan onceliklidir');
    }
    check(/<button[^>]*data-copy-report=[^>]*aria-label="\$\{esc\(L\('copy\.report'\)\)\}"/.test(appJs), 'rapor kopyala dugmesi button, aria-label ve i18n anahtari tasiyor');
    check(/<button[^>]*data-copy-msg=[^>]*aria-label="\$\{esc\(L\('copy\.reply'\)\)\}"/.test(appJs), 'yonetici cevabi kopyala dugmesi button, aria-label ve i18n anahtari tasiyor');
    check(/<button[^>]*data-copy-branch=[^>]*title="\$\{esc\(L\('copy\.branchTitle'[^>]*aria-label="\$\{esc\(L\('copy\.branchAria'/.test(appJs), 'dal adi kopyala dugmesi title, aria-label ve i18n anahtari tasiyor');
    check(/data-i18n="help\.copy\.k"/.test(html) && /data-i18n-html="help\.copy\.h"/.test(html), 'yardim penceresinde kopyala ve sekme durumu aciklamasi var');
    const cpKeys = ['copy.report', 'copy.reply', 'copy.branchTitle', 'copy.branchAria', 'help.copy.k', 'help.copy.h'];
    check(cpKeys.every((k) => i18n.DICT.tr[k] && i18n.DICT.en[k] && !/[ğüşıöçĞÜŞİÖÇ]/.test(i18n.DICT.en[k])), 'kopyala/sekme i18n anahtarlari TR ve EN sozlukte, karakterler dogru');
  }

  // --- tur4 git/kurtarma ---
  {
    const { execFileSync } = require('child_process');
    const { Orchestrator, parseNumstat } = require('../lib/orchestrator');
    const o4 = new Orchestrator({ state: { accounts: [] }, save() {}, home: tmp }, () => {});
    const dir = mkRepo('tur4-git');
    const g = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
    const put = (file, value) => fs.writeFileSync(path.join(dir, file), value);
    const run = { projectDir: dir };
    const target = g('branch', '--show-current');
    const base = g('rev-parse', 'HEAD');
    // Bulgu 1: izlenmeyen dosya birlestirmeyi engellemez
    g('checkout', '-qb', 'tur4-a'); put('a.txt', 'isci'); g('add', '.'); g('commit', '-qm', 'a'); g('checkout', '-q', target);
    put('notlar.txt', 'kullanici notu');
    const ta = { status: 'done', base, branch: 'tur4-a' };
    const ra = o4.mergeBranch(run, ta);
    check(ra.ok && ta.merged && fs.readFileSync(path.join(dir, 'notlar.txt'), 'utf8') === 'kullanici notu' && fs.existsSync(path.join(dir, 'a.txt')),
      'tur4: izlenmeyen dosya varken birlestirme gecti ve dosya korundu');
    // Ayni adli izlenmeyen dosyanin uzerine yazmayi Git reddeder
    const head1 = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'tur4-b'); put('cakis.txt', 'isci surumu'); g('add', 'cakis.txt'); g('commit', '-qm', 'b'); g('checkout', '-q', target);
    put('cakis.txt', 'kullanicinin izlenmeyen dosyasi');
    const rb = o4.mergeBranch(run, { status: 'done', base: head1, branch: 'tur4-b' });
    check(!rb.ok && /cakis\.txt|untracked|overwritten/i.test(rb.error) && g('rev-parse', 'HEAD') === head1 && !fs.existsSync(path.join(dir, '.git/MERGE_HEAD')) &&
      fs.readFileSync(path.join(dir, 'cakis.txt'), 'utf8') === 'kullanicinin izlenmeyen dosyasi', 'tur4: izlenmeyen dosyanin uzerine yazma Git tarafindan reddedildi, dosya korundu');
    fs.unlinkSync(path.join(dir, 'cakis.txt')); fs.unlinkSync(path.join(dir, 'notlar.txt'));

    // Bulgu 13: yeniden adlandirma tek dosya sayilir
    put('eski.js', Array.from({ length: 300 }, (_, i) => `satir ${i}`).join('\n') + '\n'); g('add', '.'); g('commit', '-qm', 'eski');
    const rbase = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'tur4-mv'); fs.mkdirSync(path.join(dir, 'src')); g('mv', 'eski.js', 'src/yeni ad.js'); put('ek.txt', 'x\ny\n'); g('add', '.'); g('commit', '-qm', 'tasi');
    g('checkout', '-q', target);
    const st = o4.taskFiles(run, { branch: 'tur4-mv', base: rbase });
    const mv = st.files.find((f) => f.from === 'eski.js');
    check(st.n === 2 && st.add === 2 && st.del === 0 && mv && mv.path === 'src/yeni ad.js' && mv.add === 0 && !mv.bin && st.files.some((f) => f.path === 'ek.txt' && f.add === 2),
      'tur4: yeniden adlandirma tek dosya, 0 satir sayildi: ' + JSON.stringify(st.files));
    const pn = parseNumstat('1\t2\t\0a\tb\0c d\0-\t-\tikili.png\0');
    check(pn.length === 2 && pn[0].from === 'a\tb' && pn[0].path === 'c d' && pn[0].add === 1 && pn[0].del === 2 && pn[1].bin && pn[1].path === 'ikili.png',
      'tur4: numstat -z rename kaydi ozel karakterli yollarla ayristirildi');

    // Bulgu 7: hedefi kayitsiz eski birlestirme
    g('reset', '-q', '--hard', head1);
    const tl = { status: 'done', base: head1, branch: 'tur4-b' };
    check(o4.mergeBranch(run, tl).ok, 'tur4: eski kayit icin birlestirme hazir');
    const mergedL = g('rev-parse', 'HEAD');
    const bad = { ...tl, mergeFrom: base }; delete bad.mergeTarget;
    const rbad = o4.unmergeBranch(run, bad);
    check(!rbad.ok && bad.undoUnavailable && !bad.mergeTarget && g('rev-parse', 'HEAD') === mergedL, 'tur4: ilk ebeveyni tutmayan eski kayitta geri alma reddedildi ve dugme gizlenecek');
    const good = { ...tl }; delete good.mergeTarget;
    put('sonra.txt', '1'); g('add', '.'); g('commit', '-qm', 'sonra');
    const rgood = o4.unmergeBranch(run, good);
    check(rgood.ok && rgood.how === 'revert' && !fs.existsSync(path.join(dir, 'cakis.txt')) && fs.existsSync(path.join(dir, 'sonra.txt')),
      'tur4: gecmisteki eski kayit etkin dal hedef kabul edilip geri alindi');
    const appJs4 = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    check(/t\.mergeCommit && !t\.undoUnavailable/.test(appJs4), 'tur4: geri alinamayan eski kayitta Geri al dugmesi gizli');

    // Bulgu 6 ve 8: yeniden acilis kuyrugu baslatmaz, eski kayitlara sohbet mesaji eklemez
    const net4 = require('net');
    const sock = net4.createServer(); await new Promise((r) => sock.listen(0, '127.0.0.1', r));
    const port4 = sock.address().port; await new Promise((r) => sock.close(r));
    const h4 = path.join(tmp, 'tur4-home'); fs.mkdirSync(h4);
    const pdir = mkRepo('tur4-proj');
    const g4 = (...args) => execFileSync('git', ['-C', pdir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
    const pbase = g4('rev-parse', 'HEAD');
    g4('checkout', '-qb', 'eski-is'); fs.writeFileSync(path.join(pdir, 'e.txt'), 'e'); g4('add', '.'); g4('commit', '-qm', 'e'); g4('checkout', '-q', '-');
    g4('merge', '-q', '--no-ff', '--no-edit', 'eski-is');
    const pmerge = g4('rev-parse', 'HEAD');
    const st4 = {
      projects: [{ id: 'p4', name: 'p4', dir: pdir, messages: [
        { id: 'm0', role: 'user', text: 'eski' }, { id: 'm1', role: 'user', text: 'yarim' }, { id: 'q1', role: 'user', text: 'kuyruk mesaji', queued: true }] }],
      accounts: saved.accounts, settings: { managerId: c1.id, workerIds: [c3.id] },
      runs: [
        { id: 'old', projectId: 'p4', projectDir: pdir, status: 'stopped', fromChat: 'm0', reply: 'asil cevap', rounds: [
          { tasks: [{ id: '1-1', status: 'done', merged: true, mergeCommit: pmerge, mergeFrom: pbase }, { id: '1-2', status: 'done', merged: true, mergeCommit: pmerge, mergeFrom: pmerge }] }] },
        { id: 'live', projectId: 'p4', projectDir: pdir, status: 'running', fromChat: 'm1', rounds: [
          { tasks: [{ id: '1-1', status: 'done', phase: 'check', check: { running: true } }, { id: '1-2', status: 'running' }] }] }],
    };
    fs.writeFileSync(path.join(h4, 'state.json'), JSON.stringify(st4));
    const s4 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...env, PORT: port4, AI_PANEL_HOME: h4 }, stdio: 'ignore' });
    const url4 = `http://127.0.0.1:${port4}`;
    try {
      let snap;
      for (let i = 0; i < 80; i++) { try { snap = await (await fetch(url4 + '/api/state')).json(); if (snap.runs.find((r) => r.id === 'live')?.finishedAt) break; } catch {} await sleep(100); }
      await sleep(400);
      snap = await (await fetch(url4 + '/api/state')).json();
      const pr4 = snap.projects.find((x) => x.id === 'p4');
      const oldR = snap.runs.find((r) => r.id === 'old'), liveR = snap.runs.find((r) => r.id === 'live');
      const notes = pr4.messages.filter((m) => /yeniden başlatıldığı/.test(m.text || ''));
      check(oldR.finishedAt && oldR.reply === 'asil cevap' && !notes.some((m) => m.runId === 'old'), 'tur4: eski durmus kayda sadece finishedAt yazildi, cevap ve sohbet korundu');
      check(notes.length === 1 && notes[0].runId === 'live' && liveR.status === 'stopped', 'tur4: sohbet mesaji yalnizca calisan is icin eklendi');
      check(liveR.rounds[0].tasks[0].status === 'done' && !liveR.rounds[0].tasks[0].phase && !liveR.rounds[0].tasks[0].check && liveR.rounds[0].tasks[1].status === 'stopped',
        'tur4: dogrulamasi yarida kalan gorev done kaldi, check bos');
      const [l1, l2] = oldR.rounds[0].tasks;
      check(l1.mergeTarget && !l1.undoUnavailable && !l2.mergeTarget && l2.undoUnavailable, 'tur4: acilista eski birlestirme kayitlari etkin dala baglandi ya da Geri al gizlendi');
      check(pr4.messages.find((m) => m.id === 'q1').queued && !snap.runs.some((r) => r.fromChat === 'q1'), 'tur4: yeniden acilista kuyruk korundu, kendiliginden baslamadi');
      const tok4 = (await (await fetch(url4)).text()).match(/name="aip-token" content="([^"]+)"/)[1];
      const noHdr = await fetch(url4 + '/api/projects/p4/resume', { method: 'POST' });
      check(noHdr.status === 403 || noHdr.status === 401, 'tur4: kuyrugu surdur ucu basliksiz istegi reddetti');
      const res4 = await fetch(url4 + '/api/projects/p4/resume', { method: 'POST', headers: { 'X-AI-Panel': '1', 'X-AI-Token': tok4 } });
      let started;
      for (let i = 0; i < 30; i++) { started = (await (await fetch(url4 + '/api/state')).json()).runs.find((r) => r.fromChat === 'q1'); if (started) break; await sleep(100); }
      check(res4.ok && started, 'tur4: Kuyrugu surdur kuyruktaki mesaji baslatti');
    } finally {
      const ex = new Promise((r) => s4.once('exit', r)); s4.kill(); await ex;
    }
    const i18n4 = require(path.join(__dirname, '..', 'public', 'i18n.js'));
    const html4 = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check(['msg.resume', 'msg.resumeTitle', 'help.queue.k', 'help.queue.h'].every((k) => i18n4.DICT.tr[k] && i18n4.DICT.en[k]) && /data-i18n="help\.queue\.k"/.test(html4) && /data-resume-q=/.test(appJs4),
      'tur4: Kuyrugu surdur dugmesi, TR/EN metinleri ve yardim satiri var');
  }

  // --- tur4 kopya/temizlik ---
  {
    const { execFileSync } = require('child_process');
    const { Orchestrator, cleanupBranches } = require('../lib/orchestrator');
    const g = (d, args) => execFileSync('git', ['-C', d, ...args], { encoding: 'utf8' }).trim();

    // 1) Bulgu 9: yarim calisma kopyasi kurtarma commit'i (.env sizmaz, ajan commit'lediyse de cikarilir, diffstat/stat dolar)
    const rDir = mkRepo('tur4-recover');
    const rHome = path.join(tmp, 'tur4-recover-home');
    fs.mkdirSync(path.join(rHome, 'worktrees'), { recursive: true });
    const baseSha = g(rDir, ['rev-parse', 'HEAD']);

    // 1a) Uncommitted gercek dosya + kopyalanan .env (gitignore'da degil)
    const wt1 = path.join(rHome, 'worktrees', 'rec1-1-1');
    g(rDir, ['worktree', 'add', '-qb', 'ai-panel/rec1-1-1', wt1, baseSha]);
    fs.writeFileSync(path.join(wt1, 'kurtarilan.txt'), 'yarim is\n');
    fs.writeFileSync(path.join(wt1, '.env'), 'SECRET=gizli-deger\n');

    // 1b) Ajan .env'yi force-commit etmis + ustune yeni dosya yazmis
    const wt2 = path.join(rHome, 'worktrees', 'rec1-1-2');
    g(rDir, ['worktree', 'add', '-qb', 'ai-panel/rec1-1-2', wt2, baseSha]);
    fs.writeFileSync(path.join(wt2, '.env'), 'SECRET=ajan-commit\n');
    fs.writeFileSync(path.join(wt2, 'ajan.txt'), 'ajan dosyasi\n');
    g(wt2, ['add', '-f', '.env', 'ajan.txt']);
    g(wt2, ['-c', 'user.name=Ajan', '-c', 'user.email=a@b', 'commit', '-q', '-m', 'ajan']);
    fs.writeFileSync(path.join(wt2, 'ek.txt'), 'ek degisiklik\n');

    // 1c) Kilitli index.lock nedeniyle kurtarma commit'i atilamayan kopya: commitError=true, kopya korunur
    const wt3 = path.join(rHome, 'worktrees', 'rec1-1-3');
    g(rDir, ['worktree', 'add', '-qb', 'ai-panel/rec1-1-3', wt3, baseSha]);
    fs.writeFileSync(path.join(wt3, 'kilitli.txt'), 'koru\n');
    const wt3GitDir = g(wt3, ['rev-parse', '--absolute-git-dir']);
    fs.writeFileSync(path.join(wt3GitDir, 'index.lock'), '');

    const t1 = { id: '1-1', branch: 'ai-panel/rec1-1-1', base: baseSha, cwd: wt1, copied: ['.env'], status: 'stopped' };
    const t2 = { id: '1-2', branch: 'ai-panel/rec1-1-2', base: baseSha, cwd: wt2, copied: ['.env'], status: 'stopped' };
    const t3 = { id: '1-3', branch: 'ai-panel/rec1-1-3', base: baseSha, cwd: wt3, copied: ['.env'], status: 'stopped' };
    const recRun = { id: 'rec1', projectDir: rDir, status: 'stopped', log: [], rounds: [{ tasks: [t1, t2, t3] }] };
    let recSaves = 0;
    const recStore = { home: rHome, state: { runs: [recRun], projects: [] }, save() { recSaves++; } };
    const recOrch = new Orchestrator(recStore, () => {});

    check(recOrch.recoverTaskWorktree(recRun, t1) === true, 'tur4 bulgu 9: yarim kopya kurtarma commitine alindi');
    const c1Msg = g(rDir, ['log', '-1', '--pretty=%s', 'ai-panel/rec1-1-1']);
    const c1Files = g(rDir, ['diff', '--name-only', `${baseSha}..ai-panel/rec1-1-1`]).split('\n').filter(Boolean);
    check(c1Msg === '[ai-panel] kurtarma' && c1Files.includes('kurtarilan.txt') && !c1Files.includes('.env'),
      'tur4 bulgu 9: kurtarma commitinde gercek dosya var, kopyalanan .env YOK');
    check(Boolean(t1.diffstat && !t1.diffstat.startsWith('(') && t1.stat && t1.stat.n === 1 && t1.stat.files[0].path === 'kurtarilan.txt'),
      'tur4 bulgu 9: kurtarilan gorevde diffstat ve stat/files bilgisi doldu');

    check(recOrch.recoverTaskWorktree(recRun, t2) === true, 'tur4 bulgu 9: ajan .env commit ettiyse de kurtarma calisti');
    const c2Files = g(rDir, ['diff', '--name-only', `${baseSha}..ai-panel/rec1-1-2`]).split('\n').filter(Boolean);
    check(!c2Files.includes('.env') && c2Files.includes('ajan.txt') && c2Files.includes('ek.txt') && Array.isArray(t2.stripped) && t2.stripped.includes('.env'),
      'tur4 bulgu 9: leakedFiles korumasi ajan commitindeki .env dosyasini kurtarma sirasinda cikardi');

    check(recOrch.recoverTaskWorktree(recRun, t3) === false && t3.commitError === true && t3.cwd === wt3,
      'tur4 bulgu 9: kilitli kopyada commitError isaretlendi ve cwd korundu');
    fs.unlinkSync(path.join(wt3GitDir, 'index.lock'));

    // 2) Bulgu 10: cleanupBranches --ignored/copied filtresi
    const cDir = mkRepo('tur4-clean');
    fs.writeFileSync(path.join(cDir, '.gitignore'), 'node_modules/\n*.log\n');
    g(cDir, ['add', '.gitignore']);
    g(cDir, ['-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore']);
    const cBase = g(cDir, ['rev-parse', 'HEAD']);
    const cHome = path.join(tmp, 'tur4-clean-home');
    fs.mkdirSync(path.join(cHome, 'worktrees'), { recursive: true });

    // 2a) Sadece task.copied (.env) + ignore edilmis node_modules ve log -> temizlenmeli
    const wtClean = path.join(cHome, 'worktrees', 'cln1-1-1');
    g(cDir, ['worktree', 'add', '-qb', 'ai-panel/cln1-1-1', wtClean, cBase]);
    fs.writeFileSync(path.join(wtClean, '.env'), 'K=V\n');
    fs.mkdirSync(path.join(wtClean, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(wtClean, 'node_modules', 'pkg', 'index.js'), 'module.exports=1;\n');
    fs.writeFileSync(path.join(wtClean, 'debug.log'), 'log\n');

    // 2b) Gercek izlenmeyen (ignore edilmemis) dosya -> korunmali
    const wtUntracked = path.join(cHome, 'worktrees', 'cln1-1-2');
    g(cDir, ['worktree', 'add', '-qb', 'ai-panel/cln1-1-2', wtUntracked, cBase]);
    fs.writeFileSync(path.join(wtUntracked, 'gercek.txt'), 'koru\n');

    // 2c) Izlenen dosyada degisiklik -> korunmali
    const wtTracked = path.join(cHome, 'worktrees', 'cln1-1-3');
    g(cDir, ['worktree', 'add', '-qb', 'ai-panel/cln1-1-3', wtTracked, cBase]);
    fs.appendFileSync(path.join(wtTracked, '.gitignore'), 'dist/\n');

    const cStore = {
      home: cHome,
      state: {
        projects: [],
        runs: [{
          id: 'cln1', projectDir: cDir, status: 'stopped',
          rounds: [{
            tasks: [
              { id: '1-1', branch: 'ai-panel/cln1-1-1', base: cBase, copied: ['.env'], status: 'stopped' },
              { id: '1-2', branch: 'ai-panel/cln1-1-2', base: cBase, copied: ['.env'], status: 'stopped' },
              { id: '1-3', branch: 'ai-panel/cln1-1-3', base: cBase, copied: ['.env'], status: 'stopped' },
            ],
          }],
        }],
      },
    };
    cleanupBranches(cStore, { projectDir: cDir });
    check(!fs.existsSync(wtClean), 'tur4 bulgu 10: sadece task.copied (.env) ve node_modules iceren worktree temizlendi');
    check(fs.existsSync(path.join(wtUntracked, 'gercek.txt')), 'tur4 bulgu 10: ignore edilmemis izlenmeyen dosya olan worktree korundu');
    check(fs.existsSync(wtTracked), 'tur4 bulgu 10: izlenen degisiklik olan worktree korundu');

    // 3) Bulgu 14a: preview POST + X-AI-Panel/jeton zorunlu; GET files diske yazmaz
    const net14 = require('net');
    const p14Srv = net14.createServer(); await new Promise((r) => p14Srv.listen(0, '127.0.0.1', r));
    const port14 = p14Srv.address().port; await new Promise((r) => p14Srv.close(r));
    const h14 = path.join(tmp, 'tur4-http-home');
    fs.mkdirSync(h14, { recursive: true });
    fs.writeFileSync(path.join(h14, 'state.json'), JSON.stringify({
      accounts: [], projects: [{ id: 'p14', name: 'P14', dir: rDir, messages: [] }],
      runs: [{ id: 'rec1', projectId: 'p14', projectDir: rDir, status: 'done', rounds: [{ tasks: [{ id: '1-1', branch: 'ai-panel/rec1-1-1', base: baseSha, status: 'done' }] }] }],
      settings: {}, templates: [],
    }));
    const srv14 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...env, PORT: port14, AI_PANEL_HOME: h14 }, stdio: 'ignore' });
    try {
      const u14 = `http://127.0.0.1:${port14}`;
      let html14 = '';
      for (let i = 0; i < 40; i++) { try { html14 = await (await fetch(u14)).text(); break; } catch { await sleep(100); } }
      const tok14 = (html14.match(/name="aip-token" content="([^"]+)"/) || [])[1];
      const pvGet = await fetch(`${u14}/api/runs/rec1/tasks/1-1/preview`);
      check(pvGet.status === 404, 'tur4 bulgu 14a: GET .../preview artik 404 doner');
      const pvNoHdr = await fetch(`${u14}/api/runs/rec1/tasks/1-1/preview`, { method: 'POST' });
      check(pvNoHdr.status === 403, 'tur4 bulgu 14a: X-AI-Panel/jeton olmadan POST .../preview 403 ile reddedildi');
      const pvNoTok = await fetch(`${u14}/api/runs/rec1/tasks/1-1/preview`, { method: 'POST', headers: { 'X-AI-Panel': '1' } });
      check(pvNoTok.status === 403, 'tur4 bulgu 14a: jetonsuz POST .../preview 403 ile reddedildi');
      const pvOkRes = await fetch(`${u14}/api/runs/rec1/tasks/1-1/preview`, { method: 'POST', headers: { 'X-AI-Panel': '1', 'X-AI-Token': tok14 } });
      const pvOk = await pvOkRes.json();
      check(pvOkRes.status === 200 && pvOk.ok === true && pvOk.clean === true, 'tur4 bulgu 14a: gecerli baslik ve jetonla POST .../preview calisti');

      const stBefore14 = fs.readFileSync(path.join(h14, 'state.json'), 'utf8');
      const fRes14 = await (await fetch(`${u14}/api/runs/rec1/tasks/1-1/files`)).json();
      await sleep(550);
      const stAfter14 = fs.readFileSync(path.join(h14, 'state.json'), 'utf8');
      check(fRes14.n === 1 && stAfter14 === stBefore14, 'tur4 bulgu 14a: GET .../files sonucu dondu ve state.json dosyasina yazmadi');
    } finally {
      const ex14 = new Promise((r) => srv14.once('exit', r));
      srv14.kill(); await ex14;
    }

    const appSrc14 = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    check(appSrc14.includes("api('POST', `/api/runs/${runId}/tasks/${taskId}/preview`)") && !appSrc14.includes("api('GET', `/api/runs/${runId}/tasks/${taskId}/preview`)"),
      'tur4 bulgu 14a: arayuz preview cagrisi POST olarak guncellendi');
    check(appSrc14.includes("task.keptCopy"), 'tur4 bulgu 9: commit hatasinda kartta Kopya korundu satiri gosteriliyor');

    // GET .../files (taskFiles) store.save() cagirmaz
    let filesSaves = 0;
    const fOrch = new Orchestrator({ home: rHome, state: { runs: [recRun], projects: [] }, save() { filesSaves++; } }, () => {});
    delete t1.stat;
    const tfRes = fOrch.taskFiles(recRun, t1);
    check(tfRes.n === 1 && filesSaves === 0, 'tur4 bulgu 14a: taskFiles (GET .../files) store.save() cagirmaz, diske yazmaz');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} test basarisiz` : 'Tum testler gecti');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
