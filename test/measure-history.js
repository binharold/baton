#!/usr/bin/env node
// Sohbet gecmisi (SOHBET GECMISI / GECMIS bolumu) icin yonetici isteminin karakter ve yaklasik token (karakter/4) olcumu.
// Gercek CLI cagirmaz; sabit ornek sohbetle server.js'in gecmis kurma adimini ve managerPrompt'u calistirir.
// Kullanim: node test/measure-history.js [--json]
const orch = require('../lib/orchestrator');

const long = (seed, n) => {
  let s = '';
  let i = 0;
  while (s.length < n) s += `${seed} #${i++}: ayrintili adimlar, dosya adlari, hata notlari ve olcum sonuclari. `;
  return s.slice(0, n);
};

// Ornek sohbet: ayni uzun mesaj 3 kez, 2 "Durduruldu.", uzun yonetici raporlari
function sampleChat() {
  const A = long('Kullanici istegi A: tum modulleri incele, eksikleri duzelt', 1500) + '\nBagimlilik ekleme.\nGit push yapma.';
  const msgs = [
    { id: 'm1', role: 'user', text: A },
    { id: 'm2', role: 'manager', text: 'Durduruldu.', status: 'stopped' },
    { id: 'm3', role: 'user', text: A },
    { id: 'm4', role: 'manager', text: 'Durduruldu.', status: 'stopped' },
    { id: 'm5', role: 'user', text: A.replace(/ /g, '  ') },
    { id: 'm6', role: 'manager', text: long('Yonetici raporu 1: moduller incelendi', 3000), status: 'done' },
    { id: 'm7', role: 'user', text: long('Ikinci istek: testleri genislet', 400) },
    { id: 'm8', role: 'manager', text: long('Yonetici raporu 2: testler eklendi', 3000), status: 'done' },
    { id: 'm9', role: 'user', text: long('Ucuncu istek: belgeleri guncelle', 600) },
    { id: 'm10', role: 'manager', text: long('Yonetici raporu 3: belgeler guncellendi', 2500), status: 'done' },
  ];
  const cur = { id: 'cur', role: 'user', text: long('Son istek: son duzeltmeleri yap ve dogrula', 300) };
  return { msgs, cur };
}

// Eski kurulum (server.js): son 10 user/manager mesaji, hicbir ayiklama yok
const oldBuild = (msgs, cur) => msgs.filter((m) => m.id !== cur.id && (m.role === 'user' || m.role === 'manager')).slice(-10).map((m) => ({ role: m.role, text: m.text }));

function measure() {
  const { msgs, cur } = sampleChat();
  const build = orch.buildHistory ? (m, c) => orch.buildHistory(m, c) : oldBuild;
  const history = build([...msgs, cur], cur);
  const run = { projectName: 'Ornek', projectDir: '/tmp/ornek', notes: '', history, goal: cur.text, mode: 'split', maxRounds: 2 };
  const workers = [{ id: 'w1', name: 'Claude 1', type: 'claude' }];
  const prompt = orch.managerPrompt(run, workers, 1, null);
  const hist = orch.formatHistory(history);
  const row = (name, text) => ({ name, chars: text.length, tokens: Math.round(text.length / 4) });
  return [row('yonetici istemi (toplam)', prompt), row('yalniz gecmis bolumu', hist)];
}

if (require.main === module) {
  const rows = measure();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('Bolum                          karakter   ~token');
    for (const r of rows) console.log(r.name.padEnd(31) + String(r.chars).padStart(8) + String(r.tokens).padStart(9));
  }
}
module.exports = { measure, sampleChat, oldBuild };
