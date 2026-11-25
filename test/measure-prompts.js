#!/usr/bin/env node
// Sabit ornek is icin yonetici, isci ve bitis istemlerinin karakter ve yaklasik token (karakter/4) uzunlugunu olcer.
// Kullanim: node test/measure-prompts.js [--json]
const { managerPrompt, workerPrompt, finishPrompt, reportsText } = require('../lib/orchestrator');

const long = (seed, n) => {
  let s = '';
  let i = 0;
  while (s.length < n) s += `${seed} #${i++}: degisen dosyalar, test adimlari, hata ayiklama notlari ve olcum sonuclari. `;
  return s.slice(0, n);
};

function sample() {
  // 2 kullanici mesaji + 1 onceki yonetici cevabi (gecmis)
  const history = [
    { role: 'user', text: long('Ilk kullanici istegi: proje mimarisini incele ve eksikleri listele', 1400) },
    { role: 'manager', text: long('Onceki yonetici cevabi: eksikler incelendi, 4 alan belirlendi', 1600), summary: 'Eksikler incelendi, 4 alan belirlendi.' },
    { role: 'user', text: long('Ikinci kullanici mesaji: simdi bu 4 alani ekibe bol ve uygula', 900) },
  ];
  const goal = long('Son kullanici istegi: 4 alanda iyilestirmeleri uygula, test ekle ve dogrula', 1200);
  const notes = 'Genel kurallar (her projede gecerli):\nBağımlılık ekleme. Her değişiklikten sonra npm test çalıştır. Git push/PR yapma.\n\nProje notu: Node 18+, derleme adımı yok, test komutu: npm test.';
  const workers = [
    { id: 'w1', name: 'Claude 1', type: 'claude', model: 'claude-sonnet-4-5', limits: { fiveHour: { pct: 22 }, week: { pct: 35 } } },
    { id: 'w2', name: 'Codex 1', type: 'codex', model: 'gpt-5-codex', limits: { fiveHour: { pct: 48 }, week: { pct: 60 } } },
    { id: 'w3', name: 'Antigravity 1', type: 'antigravity' },
    { id: 'w4', name: 'Gemini 1', type: 'gemini', model: 'gemini-2.5-pro' },
  ];
  const tasks = workers.map((w, i) => ({
    id: `1-${i + 1}`,
    assignee: w.name,
    assigneeId: w.id,
    title: `Alan ${i + 1} iyilestirmesi`,
    status: 'done',
    branch: `ai-panel/sample-1-${i + 1}`,
    base: 'a1b2c3d4e5f67890',
    diffstat: ` lib/mod${i + 1}.js | 42 ++++++++++++++---\n test/run-mock.js | 18 +++++++\n 2 files changed, 54 insertions(+), 6 deletions(-)`,
    check: i === 2
      ? { cmd: 'npm test', ok: false, code: 1, out: long('FAIL test case timeout / assertion error stack trace', 1800) }
      : { cmd: 'npm test', ok: true, code: 0, out: 'Tum testler gecti' },
    instructions: long(`Alan ${i + 1} icin gorev talimati`, 600),
    report: long(`Isci ${i + 1} ayrintili raporu`, 3000),
  }));
  const run = {
    projectName: 'AI Panel',
    projectDir: '/tmp/ornek-proje',
    notes,
    history,
    goal,
    mode: 'split',
    maxRounds: 3,
    result: 'Tur 1 tamamlandi, 3 dalin testi gecti, 1 dalda duzeltme yapildi.',
    reply: 'Tum alanlar tamamlandi.',
    finish: { mode: 'custom', text: 'Testleri gecen dallari kontrol et, kisa ozet yaz.' },
    rounds: [{ n: 1, tasks }],
  };
  return { run, workers, tasks };
}

function measure() {
  const { run, workers, tasks } = sample();
  const reps = reportsText(tasks);
  const branches = tasks.map((t) => `- ${t.branch} (${t.assignee}: ${t.title})`).join('\n');
  const m1 = managerPrompt(run, workers, 1, null);
  const m2 = managerPrompt(run, workers, 2, reps);
  const w = workerPrompt(run, tasks[0]);
  const f = finishPrompt(run, reps, tasks[0], branches);
  const row = (name, text) => ({ name, chars: text.length, tokens: Math.round(text.length / 4) });
  const rows = [
    row('yonetici istemi (tur 1)', m1),
    row('yonetici istemi (tur 2)', m2),
    row('isci istemi', w),
    row('bitis istemi', f),
  ];
  const totalChars = rows.reduce((a, r) => a + r.chars, 0);
  rows.push({ name: 'TOPLAM (4 istem)', chars: totalChars, tokens: Math.round(totalChars / 4) });
  return rows;
}

if (require.main === module) {
  const rows = measure();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log('Istem                          karakter   ~token');
    console.log('------------------------------------------------');
    for (const r of rows) {
      console.log(r.name.padEnd(31) + String(r.chars).padStart(8) + String(r.tokens).padStart(9));
    }
  }
}

module.exports = { measure, sample };
