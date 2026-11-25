// Yonetici -> iscilere is dagitimi -> yonetici kontrolu dongusu.
// Modlar:
//   split    : yonetici isi parcalara boler, iscilere dagitir, sonuclari kontrol eder
//   race     : ayni gorev her isciye verilir, yonetici hakem olarak en iyisini secer
//   continue : tek bir isciye, onceki gorevinin dali uzerinden ek talimat verilir
// Bitis adimi (proje ayari):
//   none   : hicbir sey yapma, dallar kalir
//   merge  : yoneticinin sectigi en iyi dali panel kendisi ana dala alir
//   custom : yonetici, kullanicinin yazdigi bitis talimatini uygular (ör. "testleri calistir, PR ac")
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { TYPES, runAgent, trackChild, killTree } = require('./agents');

const MIN_FORCE_REASON = 8; // "Yine de al" gerekcesi en az bu kadar karakter
// Baglam butcesi: yonetici, isci ve bitis istemlerinde metin sinirlari (karakter)
const CTX = {
  recentTurns: 3,          // gecmiste bu kadar son tur oldugu gibi kalir (son kullanici mesaji hic kisaltilmaz)
  olderUserChars: 300,     // daha eski kullanici mesaji: bas+son kesit
  olderRuleChars: 500,     // kisaltilan eski mesajdan tasinan kural/kisit satirlari ust siniri
  lastManagerChars: 1200,  // onceki yonetici cevabi (plan/gorevler) ust siniri (tur 2+ dahil)
  olderChars: 180,         // eski gecmis mesajlari icin tek satirlik ozet
  reportHead: 400,         // yoneticiye giden her isci raporunun bas kismi
  reportTail: 1800,        // yoneticiye giden her isci raporunun son kismi
  judgeReportTail: 3500,   // hakemin karsilastiracagi raporun son kismi
  checkChars: 1200,        // yoneticiye giden basarisiz dogrulama ciktisi (son kisim)
  finishReportChars: 4500, // bitis isteminde toplam rapor ozeti butcesi
  finishPerReport: 1200,   // bitis isteminde tek rapor ust siniri
  goalInFinish: 1200,      // bitis istemindeki hedef butcesi
  goalInWorker: 6000,      // isci istemindeki kullanici istegi baglam siniri (bas+son)
};
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n).trimEnd() + '...' : s; };
// Bas ve son kismi koruyarak ortadan kirpar; baslik ve sonuc ozetini birlikte tutar
function headTail(s, headN, tailN) {
  s = String(s || '');
  if (s.length <= headN + tailN) return s;
  const cut = s.length - headN - tailN;
  return `${s.slice(0, headN)}\n…[${cut} karakter kirpildi]…\n${s.slice(-tailN)}`;
}
// Uzun diffstat ciktisinda dosya listesinin basini ve sondaki ozet satirini her zaman korur
function clipDiffstat(s, max = 1200) {
  s = String(s || '').trimEnd();
  if (s.length <= max) return s;
  const lines = s.split('\n');
  if (lines.length <= 2) return headTail(s, Math.floor(max / 2), Math.ceil(max / 2));
  const summary = lines[lines.length - 1];
  const body = lines.slice(0, -1);
  const keep = [];
  let used = summary.length + 32;
  for (const l of body) {
    if (used + l.length + 1 > max) break;
    keep.push(l);
    used += l.length + 1;
  }
  const dropped = body.length - keep.length;
  return dropped > 0
    ? `${keep.join('\n')}${keep.length ? '\n' : ''}…[${dropped} satir kirpildi]…\n${summary}`
    : s;
}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const isGit = (dir) => { try { return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; } };
const tail = (s, n) => (s && s.length > n ? '...\n' + s.slice(-n) : s || '');
const isLimited = (a) => !!(a && a.limitUntil && a.limitUntil > Date.now());
// Giris yapilmadigi kesin olan hesap (panel hak harcamadan kontrol eder)
const loggedOut = (a) => !!(a && a.auth && a.auth.ok === false);
const usable = (a) => !!a && !isLimited(a) && !loggedOut(a);

// Limit acilana kadar bekle (en fazla 6 saat). Durdurulursa false doner.
const sleepUntil = (t, signal) => new Promise((ok) => {
  const ms = Math.min(Math.max(t - Date.now(), 5000), 6 * 3600000);
  const tm = setTimeout(() => ok(true), ms);
  signal.addEventListener('abort', () => { clearTimeout(tm); ok(false); }, { once: true });
});

function parsePlan(text) {
  const all = [...String(text || '').matchAll(/<<<PLAN([\s\S]*?)PLAN>>>/g)];
  let raw = all.length ? all[all.length - 1][1] : null;
  if (!raw) { const m = String(text || '').match(/\{[\s\S]*"tasks"[\s\S]*\}/); raw = m && m[0]; }
  if (!raw) return null;
  try { return JSON.parse(raw.trim().replace(/^```(json)?|```$/g, '').trim()); } catch { return null; }
}

// Hesabin limit doluluk orani (0-100): 5 saatlik ve haftalik pencerenin buyugu. Bilinmiyorsa 0.
const load = (a) => { const l = a && a.limits; if (!l) return 0; return Math.max(Number(l.fiveHour?.pct) || 0, Number(l.week?.pct) || 0); };
const loadText = (a) => { const l = a.limits; if (!l || !(l.fiveHour || l.week)) return ''; const f = (w) => (w && w.pct != null ? `%${Math.round(w.pct)}` : '?'); return ` | 5s:${f(l.fiveHour)} h:${f(l.week)}`; };
const teamLines = (workers) => workers.map((w) =>
  `- id: "${w.id}" | ${w.name} (${TYPES[w.type]?.label || w.type}${w.model ? ', ' + w.model : ''})${loadText(w)}${isLimited(w) ? ' [LIMITTE]' : loggedOut(w) ? ' [GIRISSIZ]' : ''}`).join('\n');

const PLAN_FMT = `

Sonda gecerli JSON blogunu yaz ("reply": kullaniciya kisa Turkce Markdown; is bittiginde "best": tam dal adi (ai-panel/...), "next": sadece done:true iken, kullanicinin agzindan 2-3 kisa istek):
<<<PLAN
{"done": false, "reply": "", "summary": "", "best": "", "next": [], "tasks": [{"assignee": "<isci id>", "title": "", "instructions": ""}]}
PLAN>>>`;

// Run bitince sohbete yazilan sabit durum metinleri (server.js onFinish); gecmise ve Iyilestir baglamina girmez
const STATUS_TEXTS = ['Durduruldu.', 'Bitti.', 'Bir hata oldu, ayrıntılara bak.'];
const isStatusText = (t) => STATUS_TEXTS.includes(String(t || '').trim());
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Kullanicinin kural/kisit satirlari (eski turlarda kisaltilsa bile tasinir)
const RULE_RE = /(asla|sakın|sakin|yapma|etme\b|ekleme|dokunma|silme|kullanma|değiştirme|degistirme|yasak|zorunlu|mutlaka|olmasın|olmasin|kural|kısıt|kisit|never|don'?t|do not|must|always)/i;

// Sohbet mesajlarindan yonetici gecmisi: durum mesajlari atlanir, ardisik ayni kullanici mesaji tek kez girer,
// mevcut istekle ayni olan son kullanici mesaji (zaten KULLANICININ SON MESAJI'nda) tekrarlanmaz.
function buildHistory(messages, cur, max = 10) {
  const out = [];
  for (const m of messages || []) {
    if (!m || (cur && m.id === cur.id) || (m.role !== 'user' && m.role !== 'manager')) continue;
    if (m.role === 'manager' && isStatusText(m.text)) continue;
    const prev = out[out.length - 1];
    if (m.role === 'user' && prev && prev.role === 'user' && normText(prev.text) === normText(m.text)) continue;
    out.push({ role: m.role, text: m.text });
  }
  const last = out[out.length - 1];
  if (cur && last && last.role === 'user' && normText(last.text) === normText(cur.text)) out.pop();
  return out.slice(-max);
}

// Iyilestir baglami icin son GERCEK yonetici cevabi: durum metinleri ve cok kisa mesajlar atlanir
function lastRealManager(messages, minLen = 40) {
  return [...(messages || [])].reverse().find((m) => m && m.role === 'manager' && !isStatusText(m.text) && normText(m.text).length >= minLen) || null;
}

// Yeni sohbete gecerken ilk mesaj: son gercek yonetici cevabindan kirpilmis ozet (model cagrisi yok)
function carrySummary(messages, max = 800) {
  const m = lastRealManager(messages, 1);
  if (!m) return '';
  const lastUser = [...(messages || [])].reverse().find((x) => x && x.role === 'user');
  const half = Math.floor(max * 0.6);
  return `**Önceki sohbetin özeti**\n${lastUser ? `Son istek: ${clip(lastUser.text, 200)}\n` : ''}${headTail(m.text, half, max - half)}`;
}

function formatHistory(hist) {
  const list = hist || [];
  let lastMgr = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'manager') { lastMgr = i; break; }
  }
  // Son CTX.recentTurns tur (kullanici mesajindan baslayarak) oldugu gibi kalir
  let recentFrom = 0, seen = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'user' && ++seen === CTX.recentTurns) { recentFrom = i; break; }
  }
  const mgrHead = Math.floor(CTX.lastManagerChars / 3);
  const mgrTail = CTX.lastManagerChars - mgrHead;
  return list.map((m, i) => {
    if (m.role === 'user') {
      const text = String(m.text || '');
      if (i >= recentFrom) return `KULLANICI: ${text}`;
      const half = Math.floor(CTX.olderUserChars / 2);
      const short = headTail(text, half, CTX.olderUserChars - half);
      if (short === text) return `KULLANICI: ${text}`;
      // Kisaltilan eski mesajda kural/kisit satirlari tasinir
      const rules = text.split('\n').map((l) => l.trim()).filter((l) => l && RULE_RE.test(l) && !short.includes(l)).map((l) => clip(l, 200));
      const extra = rules.join(' | ').slice(0, CTX.olderRuleChars);
      return `KULLANICI (kisaltildi): ${short}${extra ? `\nKURALLAR: ${extra}` : ''}`;
    }
    if (i === lastMgr) return `YONETICI: ${headTail(m.text, mgrHead, mgrTail)}`;
    return `YONETICI (ozet): ${clip(m.summary || m.text, CTX.olderChars)}`;
  }).join('\n');
}

function managerPrompt(run, workers, round, lastReports) {
  const history = formatHistory(run.history);
  const prevRound = round > 1 && Array.isArray(run.rounds) ? run.rounds[round - 2] : null;
  const prevPlanText = prevRound && prevRound.plan
    ? [prevRound.plan.summary, prevRound.plan.reply].filter(Boolean).join('\n').trim()
    : '';
  const mgrHead = Math.floor(CTX.lastManagerChars / 3);
  const prevPlan = prevPlanText
    ? `\nONCEKI TUR PLANIN:\n${headTail(prevPlanText, mgrHead, CTX.lastManagerChars - mgrHead)}\n`
    : '';
  const head = `Sen YONETICI ajansin. Kod YAZMA, dosya DEGISTIRME; incele, planla, is dagit ve cevap ver.
Proje: ${run.projectName || '-'} | Klasor: ${run.projectDir} | Tur: ${round}/${run.maxRounds}
${run.notes ? `\nPROJE NOTU:\n${run.notes}\n` : ''}${history ? `\nGECMIS:\n${history}\n` : ''}${prevPlan}
KULLANICININ SON MESAJI:
${run.goal}

EKIP (sadece bu id'lerle is ver; [LIMITTE]/[GIRISSIZ] olanlara verme):
${teamLines(workers)}

Kurallar: Limiti dusuk iscilere oncelik ver (%85+ ise sadece kucuk is). Her isci ayri git dalinda calisir (gerekirse talimatta "once git merge <dal> yap" de). Iscilere sadece gorevi icin gereken baglami ver; tum sohbeti kopyalama.`;

  if (run.mode === 'race' && lastReports) {
    return head + `

YARIS turu bitti, simdi HAKEMsin.
ISCILERIN SONUCLARI:
${lastReports}

1. Iscilerin iddialarina degil kanita guven. Dallari git diff <baz>..<dal> ile karsilastir, mumkunse test/olcumle dogrula.
2. En iyi dali "best"e yaz; "reply"de kazanani, nedenini ve kisa Markdown karsilastirma tablosunu ver.
3. Normalde done:true yap; hicbiri ise yaramadiysa ve tur hakkin varsa yeni gorev ver.` + PLAN_FMT;
  }
  const reports = lastReports
    ? `\n\nONCEKI TURUN RAPORLARI:\n${lastReports}\n\nRaporlari degerlendir. Hedefe ulasildiysa done:true, "best"e en iyi dali ve "reply"de sonucu yaz; degilse yeni gorev ver.`
    : `\n\nSadece soru/sohbetse is verme (done:true, cevabi "reply"e yaz). Is gerekiyorsa parcalara bol, net talimat ver; gereksiz is uretme.`;
  return head + reports + PLAN_FMT;
}

function workerPrompt(run, task) {
  const goal = String(run.goal || '').trim();
  const instr = String(task.instructions || '');
  const needGoal = goal && !instr.includes(goal);
  const gHalf = Math.floor(CTX.goalInWorker / 2);
  return `ISCI ajansin. ${run.mode === 'continue' ? 'Onceki calismanin uzerine devam ediyorsun.' : 'Yoneticin su gorevi verdi.'}
${needGoal ? `\nKULLANICININ ISTEGI (baglam):\n${headTail(goal, gHalf, CTX.goalInWorker - gHalf)}\n` : ''}${run.notes ? `\nPROJE NOTU:\n${run.notes}\n` : ''}
SENIN GOREVIN: ${task.title}
${instr}

Isini bu klasorde yap. Bitirince kisa RAPOR yaz: ne yaptin, sonuc/olcum, ne kaldi, sorun var mi.`;
}

// Proje komutunu (hazirlik / dogrulama) kullanicinin kabuguyla calistirir. Ciktiyi ve kodu dondurur.
function runShell(cmd, cwd, { timeoutMs = 10 * 60000, signal, onData } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = ''; let child; let killTimer;
    try { child = trackChild(spawn(process.env.SHELL || '/bin/zsh', ['-lc', cmd], { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })); }
    catch (e) { return resolve({ code: -1, out: String(e), ms: 0 }); }
    const add = (d) => { const x = d.toString(); out += x; if (out.length > 200000) out = out.slice(-100000); onData && onData(x); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const kill = () => { killTree(child, 'SIGTERM'); clearTimeout(killTimer); killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5000); };
    const timer = setTimeout(() => { add(`\n[panel] ${Math.round(timeoutMs / 60000)} dk zaman asimi.\n`); kill(); }, timeoutMs);
    signal && signal.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => add(String(e)));
    child.on('close', (code) => { clearTimeout(timer); clearTimeout(killTimer); signal && signal.removeEventListener('abort', kill); resolve({ code: code ?? -1, out, ms: Date.now() - t0 }); });
  });
}
// "Kopyalanacak dosyalar" listesini (.env gibi, git'te olmayanlar) proje klasorunden calisma kopyasina tasir
function copyInto(src, dst, list) {
  const done = [];
  for (const raw of String(list || '').split(/[,\n]/)) {
    const f = raw.trim(); if (!f || path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) continue;
    const from = path.join(src, f); if (!fs.existsSync(from)) continue;
    try { fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true }); fs.cpSync(from, path.join(dst, f), { recursive: true }); done.push(f); } catch {}
  }
  return done;
}

// Kopyalanan dosyalardan (.env gibi) hangileri bu degisiklik listesinde? Baz commit'te zaten takipli olanlar sayilmaz.
const underCopied = (n, c) => { const d = c.replace(/^\.?\//, '').replace(/\/+$/, ''); return n === d || n.startsWith(d + '/'); };
function leakedFiles(cwd, base, ref, copied) {
  if (!copied || !copied.length || !base) return [];
  let names; try { names = git(cwd, ['diff', '--name-only', '-z', base, ref]).split('\0').filter(Boolean); } catch { return []; }
  return names.filter((n) => copied.some((c) => underCopied(n, c)) && !git(cwd, ['ls-tree', base, '--', n]));
}

// git diff -M -z --numstat ciktisi. Yeniden adlandirma: "a\td\t\0eski\0yeni\0", digerleri: "a\td\tyol\0".
function parseNumstat(out) {
  const parts = out.split('\0'), files = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/); if (!m) continue;
    const a = m[1] === '-' ? 0 : +m[1], d = m[2] === '-' ? 0 : +m[2], f = { path: m[3], add: a, del: d, bin: m[1] === '-' };
    if (!m[3]) { f.from = parts[i + 1] || ''; f.path = parts[i + 2] || ''; i += 2; }
    files.push(f);
  }
  return files;
}

// mergeTarget kaydi olmayan eski birlestirme: commit etkin dalin gecmisindeyse ve ilk ebeveyni mergeFrom ise
// hedef etkin dal kabul edilir. Olmazsa false (geri alma sunulmaz).
function adoptLegacyMerge(dir, task, branch) {
  if (task.mergeTarget || !task.mergeCommit || !task.mergeFrom || !branch) return !!task.mergeTarget;
  try {
    git(dir, ['merge-base', '--is-ancestor', task.mergeCommit, 'HEAD']);
    if (git(dir, ['rev-parse', '--verify', '-q', task.mergeCommit + '^1']) !== git(dir, ['rev-parse', '--verify', '-q', task.mergeFrom + '^{commit}'])) return false;
  } catch { return false; }
  task.mergeTarget = branch; delete task.undoUnavailable;
  return true;
}

// Acilista: hedefi kayitsiz eski birlestirmeleri etkin dala bagla; baglanamayanlarda Geri al gizlenir.
function adoptLegacyMerges(runs) {
  let changed = false;
  for (const run of runs || []) for (const round of run.rounds || []) for (const task of round.tasks || []) {
    if (!task.merged || !task.mergeCommit || task.mergeTarget || task.undoUnavailable) continue;
    let branch = ''; try { branch = git(run.projectDir, ['branch', '--show-current']); } catch {}
    if (!adoptLegacyMerge(run.projectDir, task, branch)) task.undoUnavailable = true;
    changed = true;
  }
  return changed;
}

// Kopyada gercek (izlenen veya ignore edilmemis izlenmeyen) degisiklik var mi?
// task.copied (.env gibi) ve ignore edilmis dosyalar (node_modules vb.) kopyayi kirli saymaz.
function isWorktreeDirty(cwd, copied = []) {
  const raw = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!raw) return false;
  const copiedList = Array.isArray(copied) ? copied : [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++;
    if (xy === '??' && copiedList.some((c) => underCopied(file, c))) continue;
    return true;
  }
  return false;
}

// Kopyalanan dosyalari (.env gibi sirlar) exclude'a yaz, degisiklikleri commit'le, sizinti varsa gecmisten cikar, diffstat uret
function commitWorktree(cwd, task, message, { onStrip } = {}) {
  if (task.copied && task.copied.length) {
    try {
      const ex = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
      const f = path.resolve(cwd, ex);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      const add = task.copied.map((c) => '/' + c.replace(/^\.?\//, '')).filter((l) => !old.split('\n').includes(l));
      if (add.length) fs.appendFileSync(f, '\n# ai-panel: kopyalanan dosyalar\n' + add.join('\n') + '\n');
    } catch {}
  }
  const headBefore = (() => { try { return git(cwd, ['rev-parse', 'HEAD']); } catch { return ''; } })();
  if (!task.base && headBefore) task.base = headBefore;
  git(cwd, ['add', '-A']);
  if (task.copied && task.copied.length) {
    try { git(cwd, ['reset', '-q', '--', ...task.copied]); } catch {}
  }
  const changed = git(cwd, ['diff', '--cached', '--name-only']);
  let committed = false;
  if (changed) {
    execFileSync('git', ['-C', cwd, '-c', 'user.name=AI Panel', '-c', 'user.email=ai-panel@localhost', 'commit', '-q', '--no-verify', '-m', message]);
    committed = true;
  }
  // Ajan kendisi commit atmis olabilir (git add -f): gizli dosyalari dalin gecmisinden cikar
  const leaked = leakedFiles(cwd, task.base, 'HEAD', task.copied);
  if (leaked.length) {
    const id = ['-c', 'user.name=AI Panel', '-c', 'user.email=ai-panel@localhost'];
    git(cwd, ['reset', '--soft', task.base]);
    git(cwd, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...leaked]);
    if (git(cwd, ['diff', '--cached', '--name-only'])) {
      execFileSync('git', ['-C', cwd, ...id, 'commit', '-q', '--no-verify', '-m', message]);
    }
    task.stripped = leaked;
    onStrip && onStrip(leaked);
  }
  const stat = task.base ? git(cwd, ['diff', '--stat', task.base, 'HEAD']) : '';
  task.diffstat = stat || '(dosya degisikligi yok)';
  return { committed, leaked };
}

// Git'in islem dosyalari her worktree'nin kendi git klasorundedir.
function mergeWorktree(dir) {
  const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']);
  if (fs.existsSync(path.join(gitDir, 'index.lock'))) throw new Error('Git indeksi kilitli (index.lock). Diğer Git işlemini kontrol et.');
  const pending = ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']
    .find(name => fs.existsSync(path.join(gitDir, name)));
  if (pending) throw new Error(`Projede devam eden bir Git işlemi var (${pending}). Önce o işlemi tamamla.`);
  const branch = git(dir, ['branch', '--show-current']);
  if (!branch) throw new Error('HEAD ayrık. Önce hedef dala geç.');
  // Izlenmeyen dosyalar engel degil: uzerine yazilacaksa Git birlestirmeyi kendisi reddeder
  if (git(dir, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none'])) {
    throw new Error('Proje klasöründe kaydedilmemiş değişiklik var. Önce değişiklikleri kaydet veya sakla.');
  }
  return { gitDir, branch };
}

function gitFailure(e) {
  return String(e.stderr || e.message).trim();
}

// Sadece baslattigimiz komut yarim kaldiysa iptal et.
function failedIntegration(dir, gitDir, command, marker, cause) {
  if (!fs.existsSync(path.join(gitDir, marker))) throw cause;
  let detail = gitFailure(cause);
  try {
    const files = git(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U']);
    if (files) detail = 'Çakışan dosyalar: ' + files.split('\n').join(', ');
  } catch (e) { detail += ' Dosya listesi okunamadı: ' + gitFailure(e); }
  try { git(dir, [command, '--abort']); }
  catch (e) { throw new Error(`${detail}. İşlem iptal edilemedi: ${gitFailure(e)}`); }
  throw new Error(`${detail}. İşlem iptal edildi.`);
}

// Kullanimi (token) toplar: run.usage birikimli, byAgent hesap bazinda
const zeroU = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0, estimated: false });
function addUsage(run, acct, u) {
  if (!u) return;
  const R = (run.usage ||= { ...zeroU(), byAgent: {} });
  for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'total']) R[k] += u[k] || 0;
  if (u.estimated) R.estimated = true;
  const b = (R.byAgent[acct.id] ||= { name: acct.name, in: 0, out: 0, total: 0, calls: 0 });
  b.name = acct.name; b.in += u.in || 0; b.out += u.out || 0; b.total += u.total || 0; b.calls++;
}
const sumU = (a, u) => { if (!u) return a; const r = a || zeroU(); for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'total']) r[k] += u[k] || 0; if (u.estimated) r.estimated = true; return r; };

// Bitis isteminde rapor butcesini raporlar arasinda adil boler; her raporun baslik ve dogrulama satiri mutlaka kalir
function compactFinishReports(reports, totalBudget = CTX.finishReportChars, maxPer = CTX.finishPerReport) {
  const text = String(reports || '').trim();
  if (!text) return '';
  if (text.length <= totalBudget) return text;
  const blocks = text.split(/\n+(?=### )/);
  if (blocks.length <= 1 && !text.startsWith('### ')) {
    const h = Math.floor(totalBudget * 0.25);
    return headTail(text, h, totalBudget - h);
  }
  const per = Math.min(maxPer, Math.floor(totalBudget / blocks.length));
  return blocks.map((b) => {
    if (b.length <= per) return b;
    const lines = b.split('\n');
    const head = lines[0];
    const checkLines = [];
    const rest = [];
    for (let i = 1; i < lines.length; i++) {
      if (/^(Otomatik )?[Dd]ogrulama\b/.test(lines[i])) checkLines.push(lines[i]);
      else rest.push(lines[i]);
    }
    const must = [head, ...checkLines].join('\n');
    const body = rest.join('\n').trim();
    const rem = per - must.length - 1;
    if (!body || rem <= 60) return must;
    const h = Math.floor(rem * 0.25);
    return `${must}\n${headTail(body, h, rem - h)}`;
  }).join('\n\n');
}

function finishPrompt(run, reports, bestTask, branches) {
  const f = run.finish || { mode: 'none' };
  const gHalf = Math.floor(CTX.goalInFinish / 2);
  const repText = compactFinishReports(reports);
  return `YONETICI — BITIS ADIMI.
Klasor: ${run.projectDir}
ISTEK: ${headTail(String(run.goal || '').trim(), gHalf, CTX.goalInFinish - gHalf)}
Durum: ${run.result || run.reply || ''}
${run.notes ? `PROJE NOTU:\n${run.notes}\n` : ''}${repText ? 'Son raporlar:\n' + repText + '\n' : ''}
Dallar:
${branches || '(dal yok, degisiklikler klasorde)'}
${bestTask ? `En iyi dal: ${bestTask.branch}\n` : ''}
BITIS TALIMATI:
${f.text || '(bos)'}

Uygula. Dogrulayamadigin veya testi gecmeyen geri donulmez adimlari (push/yayinlama) YAPMA, nedenini yaz. Sonda kisa Turkce ozet ver.`;
}

function reportsText(tasks, mode) {
  const reportTail = mode === 'race' ? CTX.judgeReportTail : CTX.reportTail;
  return tasks.map((t) =>
    `### ${t.id} | ${t.assignee} | ${t.title} | durum: ${t.status}${t.branch ? ` | dal: ${t.branch}` : ''}${t.base ? ` | baz: ${t.base.slice(0, 12)}` : ''}\n${t.diffstat ? 'Fark:\n' + clipDiffstat(t.diffstat) + '\n' : ''}${t.check ? `Otomatik dogrulama (${t.check.cmd}): ${t.check.ok ? 'GECTI' : 'KALDI'}\n${t.check.ok ? '' : tail(t.check.out, CTX.checkChars) + '\n'}` : ''}Rapor:\n${headTail(t.report || t.output, CTX.reportHead, reportTail)}`
  ).join('\n\n');
}

class Orchestrator {
  constructor(store, emit, hooks = {}) {
    this.store = store; this.emit = emit; this.hooks = hooks;
    this.ctrl = new Map();      // runId -> AbortController
    this.taskCtrl = new Map();  // runId:taskId -> AbortController
  }

  log(run, msg) {
    const line = `[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`;
    run.log.push(line); if (run.log.length > 500) run.log.shift();
    this.emit('log', { runId: run.id, line });
  }

  stop(runId) { const c = this.ctrl.get(runId); if (c) c.abort(); return !!c; }
  stopTask(runId, taskId) { const c = this.taskCtrl.get(`${runId}:${taskId}`); if (c) c.abort(); return !!c; }
  acct(id) { return this.store.state.accounts.find((a) => a.id === id); }

  // Limitte olmayan bir yedek hesap bul (once ayni tip)
  pickAlt(exclude, preferType) {
    const pool = this.store.state.accounts.filter((a) => !exclude.has(a.id) && usable(a));
    return pool.find((a) => a.type === preferType) || pool[0] || null;
  }

  async runManager(run, R, prompt, signal, perm = 'safe') {
    let manager = this.acct(run.managerId);
    if (!manager) throw new Error('Yonetici hesabi bulunamadi');
    if (!usable(manager)) {
      const alt = this.pickAlt(new Set([manager.id, ...run.workerIds]), manager.type);
      if (alt) { this.log(run, `${manager.name} ${loggedOut(manager) ? 'girissiz' : 'limitte'}, yonetici gecici olarak ${alt.name}.`); manager = alt; }
    }
    const onData = (d) => { R.managerOutput += d; this.emit('chunk', { runId: run.id, round: R.n, who: 'manager', accountId: manager.id, d }); };
    const book = (r) => { R.managerUsage = sumU(R.managerUsage, r.usage); addUsage(run, manager, r.usage); this.emit('run', run); };
    let res = await runAgent(manager, { prompt, cwd: run.projectDir, perm, signal, timeoutMs: run.timeoutMs, kind: 'manager', onData });
    book(res);
    if (res.limited && !signal.aborted) {
      const alt = this.pickAlt(new Set([manager.id, ...run.workerIds]), manager.type);
      if (!alt && run.waitForLimits !== false && res.reset) {
        this.log(run, `${manager.name} limitte, bos yedek yok. Limit acilinca (${new Date(res.reset.at).toLocaleTimeString('tr-TR')}) devam edilecek.`);
        run.waitingUntil = res.reset.at; this.emit('run', run);
        const ok = await sleepUntil(res.reset.at + 60000, signal); run.waitingUntil = null;
        if (!ok) return { res, manager };
      } else if (alt) {
        this.log(run, `${manager.name} limiti doldu, yonetici ${alt.name} hesabina geciyor.`);
        manager = alt;
      }
      R.managerOutput = '';
      res = await runAgent(manager, { prompt, cwd: run.projectDir, perm, signal, timeoutMs: run.timeoutMs, kind: 'manager', onData });
      book(res);
    }
    return { res, manager };
  }

  // Tum isciler limitteyse bekle. Bos isci listesi doner (bos dizi = vazgec).
  async freeWorkers(run, workers, signal) {
    const out = workers.filter(loggedOut);
    if (out.length) this.log(run, `Giris yapilmamis, is verilmeyecek: ${out.map((w) => w.name).join(', ')}`);
    workers = workers.filter((w) => !loggedOut(w));
    if (!workers.length) return [];
    let free = workers.filter((w) => !isLimited(w));
    if (free.length) return free;
    const soonest = Math.min(...workers.map((w) => w.limitUntil || Infinity));
    if (run.waitForLimits === false || !isFinite(soonest)) return [];
    this.log(run, `Tum isciler limitte. ${new Date(soonest).toLocaleTimeString('tr-TR')} civarinda devam edilecek.`);
    run.waitingUntil = soonest; this.emit('run', run);
    const ok = await sleepUntil(soonest + 60000, signal); run.waitingUntil = null;
    if (!ok) return [];
    for (const w of workers) if (w.limitUntil && w.limitUntil <= Date.now()) w.limitUntil = null;
    free = workers.filter((w) => !isLimited(w));
    return free.length ? free : workers;
  }

  allTasks(run) { return run.rounds.flatMap((R) => R.tasks || []); }

  // Yoneticinin "best" dedigi dali bul; yoksa tek basarili degisiklik varsa onu al
  resolveBest(run, best) {
    const tasks = this.allTasks(run).filter((t) => t.branch && t.status === 'done' && t.diffstat && !t.diffstat.startsWith('('));
    if (best) {
      const b = String(best).trim().replace(/^`|`$/g, '');
      const exact = tasks.find((t) => t.branch === b);
      if (exact) return exact;
      const matches = tasks.filter((t) => t.branch.split('/').pop() === b ||
        (/^\d+-\d+$/.test(b) && t.branch.endsWith('-' + b)));
      return matches.length === 1 ? matches[0] : null;
    }
    return tasks.length === 1 ? tasks[0] : null;
  }

  async start(run) {
    const ac = new AbortController(); this.ctrl.set(run.id, ac);
    const S = this.store;
    let manager = this.acct(run.managerId);
    try {
      run.status = 'running'; run.startedAt = Date.now(); S.save(); this.emit('run', run);
      const useGit = isGit(run.projectDir);
      this.log(run, useGit ? 'Git deposu: her isci ayri kopyada (worktree) calisacak.' : 'Git deposu degil: isciler ayni klasorde calisacak (cakisma olabilir).');
      let lastReports = null;
      let best = null;
      for (let round = 1; round <= run.maxRounds; round++) {
        if (ac.signal.aborted) break;
        const workers = run.workerIds.map((id) => this.acct(id)).filter(Boolean);
        if (!workers.length) { run.reply = 'Ekipte calisabilecek isci yok.'; run.status = 'error'; break; }
        const R = { n: round, managerOutput: '', plan: null, tasks: [] };
        run.rounds.push(R); this.emit('run', run);
        let planTasks;

        if (round === 1 && Array.isArray(run.presetTasks) && run.presetTasks.length) {
          // Yaris / devam: yonetici planlamasi atlanir, gorevler hazir
          R.plan = { done: false, summary: run.mode === 'race' ? `Yaris: ayni gorev ${run.presetTasks.length} iscide` : 'Devam gorevi', reply: '' };
          planTasks = run.presetTasks;
          this.log(run, R.plan.summary);
        } else {
          const judging = run.mode === 'race' && lastReports;
          this.log(run, `Tur ${round}: yonetici ${judging ? 'hakemlik yapiyor' : 'planliyor'}...`);
          const out = await this.runManager(run, R, managerPrompt(run, workers, round, lastReports), ac.signal, judging ? run.perm : 'safe');
          manager = out.manager;
          R.managerOutput = tail(out.res.output, 20000);
          if (ac.signal.aborted) break;
          const plan = parsePlan(out.res.final || '') || parsePlan(out.res.output);
          if (!plan) {
            this.log(run, out.res.limited ? 'Yonetici limitte ve yedek hesap yok.' : 'Yonetici gecerli bir plan vermedi.');
            run.reply = out.res.limited ? 'Yonetici hesabin limitte, bos yedek hesap da yok. Limit acilinca tekrar dene.' : 'Yonetici anlasilir bir plan vermedi. Ciktisina bak.';
            run.status = 'error'; break;
          }
          R.plan = { done: !!plan.done, summary: plan.summary || '', reply: plan.reply || '', best: plan.best || '' };
          if (Array.isArray(plan.next)) run.next = plan.next.map((x) => String(x || '').trim().slice(0, 160)).filter(Boolean).slice(0, 3);
          if (plan.reply) run.reply = plan.reply;
          if (plan.best) best = plan.best;
          this.log(run, `Yonetici: ${plan.summary || plan.reply || '(ozet yok)'}`);
          if (plan.done || !Array.isArray(plan.tasks) || !plan.tasks.length) {
            run.result = plan.summary || plan.reply;
            if (round > 1) {
              // En iyi dal her durumda isaretlenir (kartta "En iyi" rozeti); bitis adimi ayrica uygulanir
              const bt = this.resolveBest(run, best);
              if (bt) run.bestBranch = bt.branch;
              await this.finish(run, manager, ac.signal, lastReports, best);
            }
            break;
          }
          planTasks = plan.tasks;
        }

        // Gorevleri iscilere ata. Bilinmeyen veya limitteki isci gelirse bos olana ver.
        const free = await this.freeWorkers(run, workers, ac.signal);
        if (!free.length) {
          if (!ac.signal.aborted) { run.reply = 'Uygun işçi yok: hepsi limitte ya da giriş yapılmamış. Hesaplara giriş yap ya da limit açılınca tekrar dene.'; run.status = 'error'; }
          break;
        }
        let rr = 0;
        const byLoad = [...free].sort((a, b) => load(a) - load(b)); // bos kalanlara once en az yuklu hesaplar
        R.tasks = planTasks.map((t, i) => {
          let w = workers.find((x) => x.id === (t.assigneeId || t.assignee)) || workers.find((x) => x.name === t.assignee);
          if (!w || !free.includes(w)) w = byLoad[rr++ % byLoad.length];
          return {
            id: `${round}-${i + 1}`, assigneeId: w.id, assignee: w.name, title: t.title || `Gorev ${i + 1}`,
            instructions: t.instructions || '', fromBranch: t.fromBranch || null, status: 'pending', output: '',
          };
        });
        this.emit('run', run);

        // Ayni isciye birden fazla gorev duserse sirayla, farkli isciler paralel calisir
        const byWorker = {};
        R.tasks.forEach((t) => (byWorker[t.assigneeId] ||= []).push(t));
        await Promise.all(Object.values(byWorker).map(async (list) => {
          for (const task of list) await this.runTask(run, task, useGit, ac.signal);
        }));
        if (ac.signal.aborted) break;
        if (R.tasks.length && R.tasks.every((t) => t.status === 'failed' && (t.worktreeError || t.commitError))) {
          run.reply = R.tasks[0].report || 'Çalışma kopyası (worktree) oluşturulamadı.';
          run.status = 'error';
          break;
        }

        lastReports = reportsText(R.tasks, run.mode);
        if (round === run.maxRounds) {
          if (run.mode === 'continue' || run.maxRounds === 1) {
            run.reply = R.tasks.map((t) => `**${t.assignee}** · ${t.title} · ${t.status === 'done' ? 'bitti' : t.status}\n\n${tail(t.report || t.output, 2500).trim()}`).join('\n\n---\n\n');
          } else {
            run.result = 'Tur siniri doldu. Son tur raporlarina bak.';
            run.reply = run.reply || run.result;
            await this.finish(run, manager, ac.signal, lastReports, best);
          }
        }
      }
      if (ac.signal.aborted) run.status = 'stopped';
      else if (run.status === 'running') run.status = 'done';
    } catch (e) {
      this.log(run, 'Hata: ' + e.message); run.status = 'error'; run.reply = 'Hata: ' + e.message;
    } finally {
      this.ctrl.delete(run.id); run.finishedAt = Date.now(); run.waitingUntil = null;
      this.log(run, `Bitti: ${run.status}`); S.save(); this.emit('run', run);
      try { cleanupBranches(S, { projectDir: run.projectDir }); } catch {}
      this.hooks.onFinish && this.hooks.onFinish(run);
    }
  }

  // Bitis adimi: projenin ayarina gore en iyi dali birlestir ya da ozel talimati uygula.
  async finish(run, manager, signal, reports, best) {
    const f = run.finish || { mode: 'none' };
    const bestTask = this.resolveBest(run, best);
    if (bestTask) run.bestBranch = bestTask.branch;
    if (signal.aborted || !f || f.mode === 'none') return;

    if (f.mode === 'merge') {
      if (!bestTask) { run.reply = (run.reply || '') + '\n\n_Bitiş adımı: en iyi dal belirlenemedi, birleştirme yapılmadı._'; return; }
      const r = this.mergeBranch(run, bestTask);
      run.finishResult = r;
      run.reply = (run.reply || '') + (r.ok ? `\n\n✓ \`${bestTask.branch}\` ana dala alındı.` : `\n\n**Birleştirme yapılmadı:** ${r.error}`);
      this.log(run, r.ok ? `Bitis: ${bestTask.branch} birlestirildi.` : `Bitis: birlestirme yapilmadi (${r.error})`);
      return;
    }

    // Ozel bitis talimati: yonetici tam yetkiyle uygular
    const branches = this.allTasks(run).filter((t) => t.branch && t.status === 'done').map((t) => `- ${t.branch} (${t.assignee}: ${t.title})`).join('\n');
    this.log(run, 'Bitis adimi: yonetici bitis talimatini uyguluyor...');
    run.submit = { status: 'running', output: '', startedAt: Date.now() }; this.emit('run', run);
    const prompt = finishPrompt(run, reports, bestTask, branches);
    const R = { n: 'bitis', managerOutput: '' };
    const { res } = await this.runManager(run, R, prompt, signal, 'full');
    run.submit.output = tail(res.output, 100000);
    run.submit.status = signal.aborted ? 'stopped' : res.code === 0 ? 'done' : (res.limited ? 'limit' : 'failed');
    run.submit.endedAt = Date.now();
    if (res.code === 0) run.reply = (run.reply ? run.reply + '\n\n' : '') + '**Bitiş adımı:** ' + tail((res.final || res.output).trim(), 1500);
    this.log(run, `Bitis adimi: ${run.submit.status}`);
  }

  // Otomatik dogrulama: gorev basariyla bittiyse projenin test komutunu calisma kopyasinda calistirir
  async verify(run, task, cwd, signal) {
    if (!run.check || task.status !== 'done' || signal.aborted) return;
    task.phase = 'check'; this.emit('run', run);
    const say = (d) => { task.output += d; this.emit('chunk', { runId: run.id, taskId: task.id, accountId: task.assigneeId, d }); };
    say(`\n[dogrulama] $ ${run.check}\n`);
    const r = await runShell(run.check, cwd, { signal, onData: say });
    task.check = { cmd: run.check, ok: r.code === 0, code: r.code, ms: r.ms, out: tail(r.out, 4000) };
    say(`[dogrulama] ${task.check.ok ? 'GECTI' : 'KALDI (kod ' + r.code + ')'} · ${Math.round(r.ms / 1000)} sn\n`);
    task.phase = null;
  }

  // Dali proje klasorundeki mevcut dala al. Temiz degilse veya cakisirsa dokunmaz.
  // Birlestirmeden once: dal bitmis, dogrulamasi gecmis ve gizli dosya icermiyor mu?
  // opts.allowCheckFail: SADECE "dogrulamasi kaldi" engelini atlar (onayli "Yine de al"); diger engeller aynen kalir
  mergeBlocker(run, task, opts = {}) {
    if (task.status !== 'done') return `Bu görev bitmedi ya da başarısız oldu (durum: ${task.status}). Başarısız ya da yarım bir dal ana dala alınamaz.`;
    if (task.phase === 'check') return 'Otomatik doğrulama henüz bitmedi. Bitince tekrar dene.';
    if (run.check && !task.check) return 'Bu dalın otomatik doğrulaması yapılmamış ya da bitmemiş. Doğrulanmamış dal ana dala alınamaz.';
    if (task.check && !task.check.ok && !opts.allowCheckFail) return `Otomatik doğrulama başarısız (${task.check.cmd}, kod ${task.check.code}). Başarısız dal ana dala alınamaz; önce düzelt (Devam ettir) ya da gerekçe yazarak "Yine de al".`;
    try {
      const leaked = leakedFiles(run.projectDir, task.base, task.branch, task.copied);
      if (leaked.length) return `Dal gizli dosya içeriyor (${leaked.join(', ')}). Güvenlik için birleştirme engellendi.`;
    } catch {}
    return null;
  }

  // opts: { force, reason }. force sadece dogrulamasi kalan dal icin ise yarar ve en az 8 karakterlik gerekce ister.
  mergeBranch(run, task, opts = {}) {
    let forced = null;
    if (opts.force) {
      const reason = String(opts.reason || '').trim().replace(/\s+/g, ' ');
      if (reason.length < MIN_FORCE_REASON) return { ok: false, error: `"Yine de al" için gerekçe yaz (en az ${MIN_FORCE_REASON} karakter).` };
      if (task.check && !task.check.ok) forced = { reason: reason.slice(0, 300), at: Date.now(), checkCode: task.check.code, cmd: task.check.cmd };
    }
    const blocked = this.mergeBlocker(run, task, { allowCheckFail: !!forced });
    if (blocked) return { ok: false, error: blocked };
    try {
      const dir = run.projectDir;
      const { gitDir, branch } = mergeWorktree(dir);
      const source = 'refs/heads/' + task.branch;
      try { git(dir, ['show-ref', '--verify', '--quiet', source]); }
      catch (e) { if (e.status === 1) throw new Error(`Görev dalı bulunamadı: ${task.branch}`); throw e; }
      const before = git(dir, ['rev-parse', 'HEAD']);
      try { git(dir, ['merge', '--no-ff', '--commit', '--no-edit', '--no-overwrite-ignore', source]); }
      catch (e) { failedIntegration(dir, gitDir, 'merge', 'MERGE_HEAD', e); }
      const commit = git(dir, ['rev-parse', 'HEAD']);
      if (before === commit) return { ok: false, error: 'Görev dalı zaten hedef dalın geçmişinde.' };
      task.mergeTarget = branch; task.mergeFrom = before; task.mergeCommit = commit; task.mergedAt = Date.now();
      task.merged = true; delete task.undoUnavailable;
      if (forced) { task.forced = forced; try { this.log(run, `Dogrulamasi kalan dal yine de alindi (${task.branch}, kod ${forced.checkCode}). Gerekce: ${forced.reason}`); } catch {} }
      this.store.save(); this.emit('run', run);
      return { ok: true, forced: !!forced };
    } catch (e) {
      return { ok: false, error: 'Birleştirme tamamlanamadı. ' + gitFailure(e) };
    }
  }

  // Gorevin degisen dosyalari ve satir sayilari (git diff --numstat). Dal yoksa sessizce bos doner; sonuc gorevde onbelleklenir.
  taskFiles(run, task) {
    const empty = { n: 0, add: 0, del: 0, files: [] };
    if (!task || !task.branch) return empty;
    try {
      let from = task.base || `${task.branch}~1`, to = task.branch, tip;
      try { tip = git(run.projectDir, ['rev-parse', '--verify', '-q', task.branch + '^{commit}']); }
      catch {
        if (task.stat) return task.stat; // dal silinmis: eldeki onbellek
        if (task.merged && task.mergeCommit) { from = task.mergeFrom || task.mergeCommit + '~1'; to = task.mergeCommit; tip = to; } else return empty;
      }
      if (task.stat && task.stat.tip === tip) return task.stat;
      const files = parseNumstat(git(run.projectDir, ['diff', '-M', '-z', '--numstat', `${from}..${to}`]));
      let add = 0, del = 0;
      for (const f of files) { add += f.add; del += f.del; }
      task.stat = { tip, n: files.length, add, del, files: files.slice(0, 200) };
      return task.stat;
    } catch { return empty; }
  }

  // Yeniden baslatmada korunan yarim calisma kopyasinda commit'lenmemis degisiklik varsa '[ai-panel] kurtarma' commit'i atar.
  recoverTaskWorktree(run, task) {
    if (!run || !task || !task.branch || !run.projectDir || !fs.existsSync(run.projectDir) || !isGit(run.projectDir)) return false;
    const safe = task.branch.startsWith('ai-panel/') ? task.branch.slice('ai-panel/'.length) : '';
    const cwd = (task.cwd && fs.existsSync(task.cwd)) ? task.cwd
      : (safe && this.store?.home ? path.join(this.store.home, 'worktrees', safe) : '');
    if (!cwd || cwd === run.projectDir || !fs.existsSync(cwd)) return false;
    try {
      if (git(cwd, ['symbolic-ref', '--short', 'HEAD']) !== task.branch) return false;
      const dirty = isWorktreeDirty(cwd, task.copied);
      const hasCommits = !!(task.base && (() => { try { return git(cwd, ['rev-parse', 'HEAD']) !== task.base; } catch { return false; } })());
      if (!dirty && !(hasCommits && !task.diffstat)) return false;
      commitWorktree(cwd, task, '[ai-panel] kurtarma', {
        onStrip: (leaked) => {
          if (Array.isArray(run.log)) this.log(run, `Gizli dosya kurtarma commit'inden cikarildi (${task.id}): ${leaked.join(', ')}`);
        },
      });
      this.taskFiles(run, task);
      task.recovered = true;
      if (Array.isArray(run.log)) this.log(run, `Yarim calisma kopyasi kurtarildi (${task.id}): [ai-panel] kurtarma`);
      return true;
    } catch (e) {
      task.commitError = true;
      task.cwd = cwd;
      if (Array.isArray(run.log)) this.log(run, `Yarim calisma kopyasi kurtarilamadi (${task.id}), kopya korundu: ${cwd} (${gitFailure(e).split('\n')[0]})`);
      return false;
    }
  }

  // Cakisma onizlemesi: proje klasorune DOKUNMADAN dal mevcut dala temiz girer mi?
  // Once git merge-tree --write-tree (git 2.38+); olmazsa gecici bir worktree'de deneme birlestirmesi.
  mergePreview(run, task, opts = {}) {
    if (!task || !task.branch || task.merged) return { ok: false, reason: task && task.merged ? 'merged' : 'nobranch' };
    const dir = run.projectDir;
    try { git(dir, ['rev-parse', '--verify', '-q', task.branch + '^{commit}']); } catch { return { ok: false, reason: 'nobranch' }; }
    if (!opts.fallback) {
      const r = spawnSync('git', ['-C', dir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', task.branch], { encoding: 'utf8' });
      if (r.status === 0) return { ok: true, clean: true, files: [], method: 'merge-tree' };
      if (r.status === 1) {
        const lines = String(r.stdout || '').split('\n').slice(1); const end = lines.indexOf('');
        return { ok: true, clean: false, files: (end < 0 ? lines : lines.slice(0, end)).filter(Boolean), method: 'merge-tree' };
      }
    }
    // Eski git: gecici worktree (panelin kendi klasorunde), sonunda silinir
    const tmpDir = path.join(this.store.home, 'worktrees', `onizleme-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(path.dirname(tmpDir), { recursive: true, mode: 0o700 });
      git(dir, ['worktree', 'add', '--detach', tmpDir, 'HEAD']);
      let clean = true;
      try { git(tmpDir, ['-c', 'user.name=AI Panel', '-c', 'user.email=ai-panel@localhost', 'merge', '--no-commit', '--no-ff', task.branch]); } catch { clean = false; }
      const files = clean ? [] : git(tmpDir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      return { ok: true, clean: clean || !files.length, files, method: 'worktree' };
    } catch { return { ok: false, reason: 'error' }; }
    finally {
      try { git(dir, ['worktree', 'remove', '--force', tmpDir]); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); git(dir, ['worktree', 'prune']); } catch {}
    }
  }

  // Birlestirmeyi geri al: son commit buysa ondan oncesine doner, degilse geri alan (revert) bir commit ekler
  unmergeBranch(run, task) {
    if (!task.merged || !task.mergeCommit) return { ok: false, error: 'Bu görev panelden birleştirilmemiş ya da eski bir sürümle birleştirilmiş.' };
    try {
      const dir = run.projectDir;
      const { gitDir, branch } = mergeWorktree(dir);
      if (!task.mergeTarget && !adoptLegacyMerge(dir, task, branch)) {
        task.undoUnavailable = true; this.store.save(); this.emit('run', run);
        return { ok: false, error: 'Eski kayıtta hedef dal bilgisi yok. Geri alma için Git geçmişini kontrol et.' };
      }
      if (branch !== task.mergeTarget) return { ok: false, error: `Hedef dal ${task.mergeTarget}. Geri almak için o dala geç. Etkin dal: ${branch}.` };
      try { git(dir, ['merge-base', '--is-ancestor', task.mergeCommit, 'HEAD']); }
      catch (e) {
        if (e.status === 1) return { ok: false, error: 'Birleştirme commit’i etkin dalın geçmişinde yok.' };
        throw e;
      }
      const head = git(dir, ['rev-parse', 'HEAD']);
      let how;
      if (head === task.mergeCommit) { git(dir, ['reset', '--keep', task.mergeFrom]); how = 'reset'; }
      else {
        try { git(dir, ['-c', 'user.name=AI Panel', '-c', 'user.email=ai-panel@localhost', 'revert', '-m', '1', '--no-edit', task.mergeCommit]); }
        catch (e) { failedIntegration(dir, gitDir, 'revert', 'REVERT_HEAD', e); }
        how = 'revert';
      }
      task.merged = false; task.unmergedAt = Date.now(); delete task.mergeCommit; delete task.mergeFrom; delete task.mergeTarget;
      this.store.save(); this.emit('run', run);
      return { ok: true, how };
    } catch (e) {
      return { ok: false, error: 'Geri alma tamamlanamadı. ' + gitFailure(e) };
    }
  }

  async runTask(run, task, useGit, runSignal) {
    const S = this.store;
    // Gorev bazinda durdurma: kendi kontrolcusu, is durursa o da durur
    const tac = new AbortController();
    const onRunAbort = () => tac.abort();
    runSignal.addEventListener('abort', onRunAbort, { once: true });
    const key = `${run.id}:${task.id}`;
    this.taskCtrl.set(key, tac);
    const signal = tac.signal;
    let worker = this.acct(task.assigneeId);
    let cwd = run.projectDir;
    let worktreeCreated = false;
    try {
      if (useGit) {
        const safe = `${run.id}-${task.id}`.replace(/[^a-zA-Z0-9-]/g, '-');
        task.branch = `ai-panel/${safe}`;
        cwd = path.join(S.home, 'worktrees', safe);
        try {
          fs.mkdirSync(path.dirname(cwd), { recursive: true, mode: 0o700 });
          task.base = git(run.projectDir, ['rev-parse', task.fromBranch || 'HEAD']);
          git(run.projectDir, ['worktree', 'add', '-b', task.branch, cwd, task.base]);
          worktreeCreated = true; task.cwd = cwd;
        } catch (e) {
          const reason = String(e.stderr || e.message || '').trim().split('\n')[0];
          const errMsg = `Çalışma kopyası (worktree) oluşturulamadı; güvenlik için ana klasörde çalıştırılmadı.${reason ? ` (${reason})` : ''}`;
          this.log(run, `Worktree acilamadi (${task.id}): ${reason || e.message}`);
          task.branch = null;
          task.cwd = null;
          task.status = 'failed';
          task.worktreeError = true;
          task.startedAt = Date.now();
          task.output = errMsg + '\n';
          task.report = errMsg;
          return;
        }
      }
      const say = (d) => { task.output += d; this.emit('chunk', { runId: run.id, taskId: task.id, accountId: task.assigneeId, d }); };
      // Calisma kopyasini hazirla: git'te olmayan dosyalari (.env) kopyala, hazirlik komutunu (npm install) calistir
      if (cwd !== run.projectDir) {
        const copied = copyInto(run.projectDir, cwd, run.copyFiles);
        task.copied = copied;
        if (copied.length) say(`[hazirlik] kopyalandi: ${copied.join(', ')}\n`);
        if (run.setup && !signal.aborted) {
          task.status = 'running'; task.phase = 'setup'; this.emit('run', run);
          say(`[hazirlik] $ ${run.setup}\n`);
          const r = await runShell(run.setup, cwd, { signal, onData: say });
          say(`[hazirlik] ${r.code === 0 ? 'tamam' : 'HATA (kod ' + r.code + '), yine de devam ediliyor'} · ${Math.round(r.ms / 1000)} sn\n`);
          this.log(run, `Hazirlik (${task.id}): ${r.code === 0 ? 'tamam' : 'hata'}`);
          task.phase = null;
        }
      }
      task.prepLog = task.output || '';
      task.cwd = cwd; task.status = 'running'; task.startedAt = Date.now(); this.emit('run', run);
      this.log(run, `${worker.name} -> "${task.title}" basladi.`);
      const go = (w) => runAgent(w, {
        prompt: workerPrompt(run, task), cwd, perm: run.perm, signal, timeoutMs: run.timeoutMs,
        onData: (d) => { task.output += d; if (task.output.length > 200000) task.output = task.output.slice(-150000); this.emit('chunk', { runId: run.id, taskId: task.id, accountId: w.id, d }); },
      });
      let res = await go(worker);
      task.usage = sumU(task.usage, res.usage); addUsage(run, worker, res.usage);
      if (res.limited && !signal.aborted) {
        // Limit doldu: bosta olan baska bir hesaba devret (once ayni tip)
        const busy = new Set(run.rounds.at(-1).tasks.filter((t) => t.status === 'running' && t !== task).map((t) => t.assigneeId));
        const alt = this.pickAlt(new Set([worker.id, run.managerId, ...busy]), worker.type);
        if (alt) {
          this.log(run, `${worker.name} limiti doldu, "${task.title}" ${alt.name} hesabina devredildi.`);
          worker = alt; task.assigneeId = alt.id; task.assignee = alt.name; task.output += `\n[panel] ${alt.name} hesabina devredildi.\n`;
          res = await go(worker);
          task.usage = sumU(task.usage, res.usage); addUsage(run, worker, res.usage);
        }
      }
      task.output = (task.prepLog || '') + tail(res.output, 150000); // hazirlik kaydi korunur
      task.report = tail(res.final || res.output, 6000);
      task.status = signal.aborted ? 'stopped' : res.code === 0 ? 'done' : (res.limited ? 'limit' : 'failed');
      if (useGit && task.branch) {
        try {
          commitWorktree(cwd, task, `[ai-panel] ${task.assignee}: ${task.title}`, {
            onStrip: (leaked) => {
              say(`\n[panel] Gizli dosyalar daldan cikarildi: ${leaked.join(', ')}\n`);
              this.log(run, `Gizli dosya dala girmişti, geçmişten çıkarıldı (${task.id}): ${leaked.join(', ')}`);
            },
          });
          this.taskFiles(run, task);
        } catch (e) {
          task.commitError = true; task.status = 'failed';
          task.report = `Değişiklikler kaydedilemedi. Çalışma kopyası korundu: ${cwd}`;
          say(`\n[panel] ${task.report}\n${String(e.stderr || e.message).trim()}\n`);
          this.log(run, task.report);
          return;
        }
        await this.verify(run, task, cwd, signal);
        // Commit tamamlandiktan sonra kopyayi kaldir; dal inceleme icin kalir.
        try { git(run.projectDir, ['worktree', 'remove', '--force', cwd]); worktreeCreated = false; }
        catch (e) { this.log(run, `Çalışma kopyası kaldırılamadı: ${e.message.split('\n')[0]}`); }
      }
      if (!(useGit && task.branch)) await this.verify(run, task, cwd, signal);
      this.log(run, `${worker.name} -> "${task.title}" ${task.status}${task.branch ? ` (dal: ${task.branch})` : ''}${task.check ? ` · dogrulama ${task.check.ok ? 'gecti' : 'kaldi'}` : ''}`);
    } finally {
      if (worktreeCreated && cwd !== run.projectDir) {
        this.log(run, `Çalışma kopyası korundu: ${cwd}`);
      }
      task.endedAt = Date.now();
      runSignal.removeEventListener('abort', onRunAbort);
      this.taskCtrl.delete(key);
      S.save(); this.emit('run', run);
    }
  }
}

// Biten, birlesmis, degisikliksiz ya da atilmis gorevlerin worktree ve ai-panel/* dallarini temizler.
// Birlesmemis ve kullanicinin bekleyen isi olan dallara dokunmaz.
function cleanupBranches(store, { projectDir = null, discardBranches = [] } = {}) {
  const removedBranches = [];
  const removedWorktrees = [];
  const keptBranches = [];
  const state = (store && store.state) || { runs: [], projects: [] };
  const runs = state.runs || [];

  // Aktif (calisan/sirada) islerin kopyalarini koru, artik worktree klasorlerini temizle
  const wtRoot = store && store.home ? path.join(store.home, 'worktrees') : null;
  if (wtRoot && fs.existsSync(wtRoot)) {
    for (const entry of fs.readdirSync(wtRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const owner = runs.find((r) => name.startsWith(r.id + '-'));
      if (owner && (['running', 'queued'].includes(owner.status) || (projectDir && owner.projectDir !== projectDir))) continue;
      const full = path.join(wtRoot, name);
      // Bos klasorde kaybedilecek veri yok. Doluysa kayitli dal ve kopyayi dogrula.
      try { fs.rmdirSync(full); removedWorktrees.push(full); continue; } catch {}
      const task = owner?.rounds?.flatMap((r) => r.tasks || []).find((t) => t.branch === 'ai-panel/' + name);
      if (!task || task.commitError) continue;
      try {
        if (git(full, ['symbolic-ref', '--short', 'HEAD']) !== task.branch) continue;
        if (isWorktreeDirty(full, task.copied)) continue;
        git(owner.projectDir, ['worktree', 'remove', '--force', full]);
        removedWorktrees.push(full);
      } catch { /* Kilitli veya okunamayan kopyayi koru. */ }
    }
  }

  // Taranacak proje klasorleri
  const dirs = new Set();
  if (projectDir) dirs.add(projectDir);
  else {
    for (const r of runs) if (r.projectDir) dirs.add(r.projectDir);
    for (const p of state.projects || []) if (p.dir) dirs.add(p.dir);
  }
  const discardSet = new Set((discardBranches || []).filter((b) => typeof b === 'string' && b.startsWith('ai-panel/')));

  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir) || !isGit(dir)) continue;
    try { git(dir, ['worktree', 'prune']); } catch {}

    let rawList = '';
    try { rawList = git(dir, ['branch', '--list', 'ai-panel/*', '--format=%(refname:short)']); } catch { continue; }
    const branches = rawList.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!branches.length) continue;

    // Herhangi bir worktree'de veya HEAD'de acik olan dallari asla silme
    const checkedOut = new Set();
    try { const head = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']); if (head) checkedOut.add(head); } catch {}
    try {
      const wtOut = git(dir, ['worktree', 'list', '--porcelain']);
      for (const line of wtOut.split('\n')) {
        if (line.startsWith('branch refs/heads/')) checkedOut.add(line.slice('branch refs/heads/'.length).trim());
      }
    } catch {}

    const mergedIntoHead = new Set();
    try {
      const mOut = git(dir, ['branch', '--merged', 'HEAD', '--list', 'ai-panel/*', '--format=%(refname:short)']);
      for (const b of mOut.split('\n')) if (b.trim()) mergedIntoHead.add(b.trim());
    } catch {}

    // Bu projedeki kayitli gorevleri dal adina gore esle
    const taskByBranch = new Map();
    for (const r of runs) {
      if (r.projectDir !== dir) continue;
      for (const R of r.rounds || []) {
        for (const t of R.tasks || []) {
          if (t.branch) taskByBranch.set(t.branch, { run: r, task: t });
        }
      }
    }

    for (const branch of branches) {
      if (checkedOut.has(branch)) { keptBranches.push(branch); continue; }
      const ref = taskByBranch.get(branch);
      if (ref && ['running', 'queued'].includes(ref.run.status)) { keptBranches.push(branch); continue; }
      // Kullanici birlestirmeyi geri aldiysa tekrar alabilsin diye dali koru
      if (ref && ref.task.unmergedAt && !ref.task.merged && !discardSet.has(branch)) { keptBranches.push(branch); continue; }

      const isMerged = mergedIntoHead.has(branch);
      const isDiscarded = discardSet.has(branch);
      let isEmpty = false;
      if (!isMerged && !isDiscarded && ref && ref.task.base) {
        try { isEmpty = git(dir, ['rev-parse', branch]) === ref.task.base; } catch {}
      }

      if (isMerged || isDiscarded || isEmpty) {
        try {
          git(dir, ['branch', isMerged ? '-d' : '-D', branch]);
          removedBranches.push(branch);
        } catch {
          keptBranches.push(branch);
        }
      } else {
        keptBranches.push(branch);
      }
    }
  }
  return { removedBranches, removedWorktrees, keptBranches };
}

module.exports = { CTX, formatHistory, buildHistory, lastRealManager, carrySummary, isStatusText, STATUS_TEXTS, addUsage, Orchestrator, parsePlan, managerPrompt, workerPrompt, finishPrompt, reportsText, compactFinishReports, headTail, clipDiffstat, tail, isLimited, isGit, cleanupBranches, parseNumstat, adoptLegacyMerge, adoptLegacyMerges, commitWorktree, isWorktreeDirty };
