// Akilli ozellikler: proje tarayici, prompt iyilestirici, zamanlanmis gorevler.
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------- Proje tarayici ----------------
// Klasore bakip dili/cerceveyi ve test, derleme, lint, calistirma komutlarini tahmin eder. Hicbir sey calistirmaz.
function scanProject(dir) {
  if (!dir) return { stack: [], cmds: {}, notes: '', setup: '', copy: '' };
  let rawEntries;
  try { rawEntries = fs.readdirSync(dir); } catch { return { stack: [], cmds: {}, notes: '', setup: '', copy: '' }; }
  const entries = new Set(rawEntries);
  const fileCache = new Map();
  // Ust duzey dosyalar icin tek readdirSync sonucunu kullan (tekrarli existsSync cagrilarini kaldirir)
  const has = (f) => {
    if (!f.includes('/')) return entries.has(f);
    const top = f.split('/')[0];
    return entries.has(top) && fs.existsSync(path.join(dir, f));
  };
  const read = (f) => {
    if (fileCache.has(f)) return fileCache.get(f);
    const val = has(f) ? (() => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } })() : '';
    fileCache.set(f, val);
    return val;
  };
  const stack = []; const cmds = {}; const extra = []; let setup = '';
  const set = (k, v) => { if (v && !cmds[k]) cmds[k] = v; };

  if (has('package.json')) {
    let pj = {}; try { pj = JSON.parse(read('package.json')); } catch {}
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : (has('bun.lockb') || has('bun.lock')) ? 'bun' : 'npm';
    const deps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
    const fws = [['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@angular/core', 'Angular'], ['svelte', 'Svelte'], ['vue', 'Vue'], ['react', 'React'], ['electron', 'Electron'], ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify']]
      .filter(([d]) => deps[d]).map(([, n]) => n).slice(0, 2);
    const ts = deps.typescript || has('tsconfig.json');
    stack.push(['Node.js', ...fws, ts ? 'TypeScript' : ''].filter(Boolean).join(' · ') + ` (${pm})`);
    setup = pm === 'npm' ? (has('package-lock.json') ? 'npm ci' : 'npm install') : `${pm} install`;
    const sc = pj.scripts || {};
    const run = (k) => (pm === 'npm' ? (['test', 'start'].includes(k) ? `npm ${k}` : `npm run ${k}`) : `${pm} ${k}`);
    if (sc.test && !/no test specified/.test(sc.test)) set('test', run('test'));
    if (sc.build) set('build', run('build'));
    if (sc.lint) set('lint', run('lint'));
    if (sc.typecheck) extra.push(`Tip kontrolü: ${run('typecheck')}`);
    set('run', sc.dev ? run('dev') : sc.start ? run('start') : '');
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    const py = read('pyproject.toml');
    const req = read('requirements.txt');
    const pyAll = py + req;
    const hasUv = has('uv.lock'), hasPoetry = has('poetry.lock');
    const runner = hasUv ? 'uv run ' : hasPoetry ? 'poetry run ' : '';
    const fw = /django/i.test(pyAll) ? ' · Django' : /fastapi/i.test(pyAll) ? ' · FastAPI' : /flask/i.test(pyAll) ? ' · Flask' : '';
    stack.push(`Python${fw}${runner ? ` (${runner.trim().split(' ')[0]})` : ''}`);
    if (!setup) setup = hasUv ? 'uv sync' : hasPoetry ? 'poetry install' : '';
    if (/pytest/.test(pyAll + read('requirements-dev.txt')) || has('tests') || has('pytest.ini')) set('test', `${runner}pytest`);
    if (/ruff/.test(py)) set('lint', `${runner}ruff check .`);
  }
  if (has('Cargo.toml')) { stack.push('Rust'); set('test', 'cargo test'); set('build', 'cargo build'); set('lint', 'cargo clippy'); set('run', 'cargo run'); }
  if (has('go.mod')) { stack.push('Go'); set('test', 'go test ./...'); set('build', 'go build ./...'); set('lint', 'go vet ./...'); }
  if (has('Package.swift')) { stack.push('Swift'); set('test', 'swift test'); set('build', 'swift build'); }
  if (rawEntries.some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'))) stack.push('Xcode projesi');
  if (has('Gemfile')) {
    if (!setup) setup = 'bundle install';
    stack.push(/rails/.test(read('Gemfile')) ? 'Ruby · Rails' : 'Ruby');
    set('test', has('spec') ? 'bundle exec rspec' : 'bundle exec rake test');
  }
  if (has('pom.xml')) { stack.push('Java (Maven)'); set('test', 'mvn test'); set('build', 'mvn package'); }
  if (has('build.gradle') || has('build.gradle.kts')) { stack.push('JVM (Gradle)'); const g = has('gradlew') ? './gradlew' : 'gradle'; set('test', `${g} test`); set('build', `${g} build`); }
  if (has('composer.json')) { stack.push('PHP'); set('test', has('vendor/bin/phpunit') ? 'vendor/bin/phpunit' : 'composer test'); }
  if (has('Makefile') && /^test:/m.test(read('Makefile'))) set('test', 'make test');
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml')) extra.push('Docker kullanılıyor.');
  if (has('.github/workflows')) extra.push('CI: GitHub Actions (.github/workflows).');

  const L = { test: 'Test', build: 'Derleme', lint: 'Lint', run: 'Çalıştırma' };
  const lines = [];
  if (stack.length) lines.push(`Proje: ${stack.join(', ')}`);
  for (const k of Object.keys(L)) if (cmds[k]) lines.push(`${L[k]}: ${cmds[k]}`);
  lines.push(...extra);
  if (cmds.test) lines.push('Değişiklikten sonra test komutunu çalıştır ve sonucunu raporla.');
  // git'te olmayan ama calismak icin gereken dosyalar (calisma kopyasina tasinir)
  const copy = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.test'].filter((f) => has(f));
  return { stack, cmds, notes: lines.join('\n'), setup, copy: copy.join(', ') };
}

// ---------------- Prompt iyilestirici ----------------
// ctx: { project, notes (kullanicinin proje notu), scan ({ stack, cmds }), mode ('split' | 'race'),
//        context: { manager: son yonetici cevabi, users: [son kullanici mesajlari] } }
function enhancePrompt(text, ctx = {}) {
  const sc = ctx.scan || {};
  const info = [ctx.project && `Proje: ${ctx.project}`, sc.stack && sc.stack.length && `Yapi: ${sc.stack.join(', ')}`, sc.cmds && sc.cmds.test && `Test komutu: ${sc.cmds.test}`].filter(Boolean).join(' · ');
  const modeRule = ctx.mode === 'race'
    ? 'Mod Yaris: herkesin ayni gorevi ayri cozecegi TEK gorev yaz; hakemin karsilastirma olcutlerini ekle.'
    : 'Mod Bol: kapsam birden cok parcaysa bagimsiz parcalar halinde yaz.';
  const cx = ctx.context || {};
  const users = (cx.users || []).filter(Boolean);
  const hasCtx = !!(cx.manager || users.length);
  const ctxBlock = hasCtx ? `\nONCEKI KONUSMA (sadece referanslari cozmek icin):\n${users.map((u) => `Kullanici: ${u}`).join('\n')}${cx.manager ? `\nSon yonetici cevabi:\n${cx.manager}` : ''}\n` : '';
  return `Bir kullanici, ekibine is dagitan YONETICI yapay zekaya asagidaki istegi gonderecek. Istegi gerekiyorsa yoneticinin dogru anlayacagi sekilde yeniden yaz.

Kurallar:
- Kullanicinin dilini ve niyetini koru. Uydurma ayrinti, dosya adi ya da teknoloji EKLEME.
- Sabit bir kalip kullanma. Istek zaten kisa ve net ise EN AZ degisiklik yap. Sadece belirsiz ve cok parcali istekte kisa bir yapi (hedef + birkac madde) kur; "Bitti sayilmasi icin" satirini ancak olculebilir bir olcut gercekten eksikse ekle.
- ${hasCtx ? '"bulunan hatalar", "onu", "sunu", "yukaridakiler" gibi atiflari ONCEKI KONUSMA\'daki somut maddelere cevir (ornek: "inceleme bulgulari 1-8"); konusmadan emin olamadigini uydurma.' : 'Onceki konusma yok; atiflari uydurma.'}
- Proje notu yoneticiye zaten ayrica gidiyor: onda olan kurallari ve genel kliseleri (bagimlilik ekleme, "AGENTS.md kurallarina uy", "npm test calistir", push yapma) metne YAZMA.
- ${modeRule}
- Metinde zaten [soru? varsayilan: ...] parantezi ya da "Bitti sayilmasi icin" varsa metin daha once iyilestirilmis demektir: yeni soru ekleme, yapiyi koru, sadece eksik ya da celiskili yeri duzelt.
- Soru: EN FAZLA 2; yalnizca cevabi isi degistiriyorsa, metnin icinde [soru? varsayilan: makul secim] bicimiyle sor. Gerek yoksa koyma.
- Metin kisa bir soruysa (or. "Hangi test kaldi?") soru olarak koru; plan, kapsam ya da madde ekleme.
- En fazla yaklasik 8 satir. Kod yazma, dosya okuma ya da degistirme; sadece metni yeniden yaz.
- Degisiklik gerekmiyorsa yeni metin yerine yalnizca <<<AYNI>>> yaz.
${info ? `\n${info}` : ''}${ctx.notes ? `\nProje notu (yoneticiye ayrica gidiyor, metne kopyalama):\n${String(ctx.notes).slice(0, 800)}` : ''}
${ctxBlock}
KULLANICININ ISTEGI:
${text}

Cevabinda SADECE yeni metni su isaretlerin arasina yaz:
<<<METIN
...yeni metin...
METIN>>>
(ya da degisiklik gerekmiyorsa sadece <<<AYNI>>>)`;
}
// Doner: metin | '' (cikarilamadi) | SAME (model degisiklik gerekmedi dedi)
const SAME = '<<<AYNI>>>';
function extractEnhanced(out) {
  const o = String(out || '');
  const m = o.match(/<<<METIN\s*\n?([\s\S]*?)\n?\s*METIN>>>/g);
  if (!m) return /<<<AYNI>>>/.test(o) && !/<<<METIN/.test(o) ? SAME : '';
  const last = m[m.length - 1].replace(/^<<<METIN\s*\n?/, '').replace(/\n?\s*METIN>>>$/, '').trim();
  if (last.includes('...yeni metin...')) return /<<<AYNI>>>/.test(o.slice(o.lastIndexOf('METIN>>>'))) ? SAME : '';
  // Bazi modeller metni kod blogu icine koyar; cit satirlarini at
  return last.replace(/^```[\w-]*\n([\s\S]*?)\n```$/, '$1').trim();
}

// ---------------- Zamanlanmis gorevler ----------------
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const SCHED_WINDOW_MS = 3 * 3600000;
// Zamani gelmis bir plan varsa ait oldugu gunun anahtarini doner, yoksa null.
// Gece yarisi gecislerini (or. 23:30 / 23:59 gorevinin 00:00 sonrasinda telafisi) dogru gunle esler.
function dueKey(s, now = new Date()) {
  if (!s || !s.enabled) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.time || ''); if (!m) return null;
  const hh = +m[1], mm = +m[2];
  if (hh > 23 || mm > 59) return null;
  const hasDays = Array.isArray(s.days) && s.days.length > 0;
  for (const offset of [0, -1]) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hh, mm, 0, 0);
    const diff = now.getTime() - at.getTime();
    if (diff < 0 || diff >= SCHED_WINDOW_MS) continue;
    if (hasDays && !s.days.includes(at.getDay())) continue;
    const key = dayKey(at);
    if (s.lastKey === key) continue;
    return key;
  }
  return null;
}
// Zamani gelmis mi? Mac uykudaysa uyaninca 3 saate kadar telafi eder; gunde bir kez calisir.
function isDue(s, now = new Date()) {
  return dueKey(s, now) !== null;
}

module.exports = { scanProject, enhancePrompt, extractEnhanced, SAME, isDue, dueKey, dayKey };
