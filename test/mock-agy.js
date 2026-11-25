#!/usr/bin/env node
// Sahte ajan (testler icin): gercek Claude/Codex/Antigravity/Gemini yerine gecer.
// - Yonetici istemine plan, hakem istemine karar, isci istemine dosya degisikligi ile cevap verir.
// - Claude gibi cagrilirsa stream-json, Antigravity gibi cagrilirsa agy stream-json,
//   Codex app-server gibi cagrilirsa JSON-RPC konusur.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const who = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || process.env.HOME;
const limitHit = fs.existsSync(path.join(who, 'LIMIT'));
const isAgy = path.basename(process.argv[1]).startsWith('mock-agy');

if (args.includes('--version')) { console.log('mock-agent 1.0.0'); process.exit(0); } // kurulum kontrolu
// Giris durumu (hak harcamadan): hesap klasorunde LOGGEDOUT dosyasi varsa girissiz
const loggedIn = !fs.existsSync(path.join(who, 'LOGGEDOUT'));
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' })); process.exit(loggedIn ? 0 : 1); }
if (args[0] === 'login' && args[1] === 'status') { console.log(loggedIn ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(loggedIn ? 0 : 1); }

if (args[0] === 'app-server') { // Codex: limiti hak harcamadan okuma
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id === 1) console.log(JSON.stringify({ id: 1, result: { userAgent: 'mock' } }));
      if (m.id === 2 && m.method === 'model/list') {
        console.log(JSON.stringify({ id: 2, result: { data: [{ id: 'mock-a', model: 'mock-a', displayName: 'Mock A', hidden: false, isDefault: true }, { id: 'mock-gizli', model: 'mock-gizli', hidden: true }] } }));
        process.exit(0);
      }
      if (m.id === 2) {
        console.log(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 400000 } } } }));
        process.exit(0);
      }
    }
  });
  return;
}

const stream = args.includes('stream-json');
const prompt = args.find((a) => a.length > 40) || '';
const J = (o) => console.log(JSON.stringify(o));
function emit(text) {
  if (!stream) return console.log(text);
  if (isAgy) {
    J({ event: 'init', conversation_id: 'c1', init: { cwd: process.cwd() } });
    J({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_info: { name: 'run_command', parameters: { command: 'cargo test' } } } });
    J({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: text } });
    J({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE' } });
    J({ event: 'result', conversation_id: 'c1', status: limitHit ? 'ERROR' : 'SUCCESS', response: limitHit ? '' : text, error: limitHit ? 'RESOURCE_EXHAUSTED: individual quota reached' : undefined, num_turns: 2, duration_seconds: 3.2, usage: { input_tokens: 80, output_tokens: 20 } });
    return;
  }
  J({ type: 'system', subtype: 'init' });
  J({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test --silent' } }] } });
  J({ type: 'rate_limit_event', rate_limit_info: { status: limitHit ? 'rejected' : 'allowed', unifiedWindows: { five_hour: { utilization: limitHit ? 1 : 0.24, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 }, seven_day: { utilization: 0.41, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 } } } });
  J({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  J({ type: 'result', subtype: limitHit ? 'error' : 'success', is_error: limitHit, result: text, num_turns: 3, duration_ms: 4200, usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } });
}

const branches = [...prompt.matchAll(/dal: (ai-panel\/[\w-]+)/g)].map((m) => m[1]);
const plan = (o) => emit('Tamam.\n<<<PLAN\n' + JSON.stringify(o) + '\nPLAN>>>');

async function main() {
  if (limitHit) { emit('Claude AI usage limit reached'); if (!stream) console.error('Error: usage limit reached'); process.exit(1); }
  const waitM = prompt.match(/BEKLE_PID:([^\s]+)/);
  if (waitM && /SENIN GOREVIN: Parca 1\b/.test(prompt)) {
    const { spawn } = require('child_process');
    const sub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(waitM[1], `${process.pid}:${sub.pid}`);
    await new Promise((r) => setTimeout(r, 30000));
  }
  if (/SENIN GOREVIN:[\s\S]*YAVAS/.test(prompt)) await new Promise((r) => setTimeout(r, 4000)); // sadece "YAVAS" gorevi yavas
  if (prompt.includes('BITIS ADIMI')) return emit('Bitis adimi tamam: testler gecti, PR acildi (sahte).');
  const enhSlow = prompt.includes('<<<METIN') && prompt.match(/ENH_SLOW_PID:([^\s]+)/);
  if (enhSlow) { fs.writeFileSync(enhSlow[1], String(process.pid)); await new Promise((r) => setTimeout(r, 30000)); } // iptal testi icin yavas iyilestirme
  if (prompt.includes('<<<METIN') && prompt.includes('ENH_FAIL')) return emit('Anlayamadim, metin yok.');
  if (prompt.includes('<<<METIN') && /KULLANICININ ISTEGI:\nAYNI_TEST/.test(prompt)) return emit('<<<AYNI>>>');
  if (prompt.includes('<<<METIN')) { const want = (prompt.match(/KULLANICININ ISTEGI:\n([^\n]+)/) || [])[1] || ''; return emit('Iste:\n<<<METIN\nHedef: ' + want + ' [hangi sayfa?]\n- adim 1\nBitti sayilmasi icin: testler gecer' + ((prompt.match(/Son yonetici cevabi:\n([^\n]+)/) || [])[1] ? '\nBaglam: ' + prompt.match(/Son yonetici cevabi:\n([^\n]+)/)[1].slice(0, 40) : '') + '\nMETIN>>>'); }
  if (prompt.includes('HAKEMsin')) {
    return plan({ done: true, best: branches[0] || '', summary: 'Hakem karari verildi', reply: `## Kazanan\n\`${branches[0]}\`\n\n| Dal | Sonuc |\n|---|---|\n${branches.map((b, i) => `| ${b} | ${i === 0 ? '**en hizli**' : 'yavas'} |`).join('\n')}` });
  }
  if (prompt.includes('YONETICI') && /SON MESAJI:\nsoru/.test(prompt)) return plan({ done: true, reply: 'Merhaba, bu sadece bir soruydu, ekibe is vermedim.', tasks: [] });
  if (prompt.includes('YONETICI') && prompt.includes('ONCEKI TURUN')) return plan({ done: true, best: branches[0] || '', summary: 'Hepsi tamam', reply: 'Is bitti, **en iyi** sonuc ilk dalda.', next: ['Testleri de yaz', 'Performansini olc'], tasks: [] });
  if (prompt.includes('YONETICI')) {
    const ids = [...prompt.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
    const slow = /YAVAS/.test(prompt); const leak = /SIZDIR/.test(prompt);
    return plan({ done: false, summary: 'Isi ' + ids.length + ' parcaya boldum', tasks: ids.map((id, i) => ({ assignee: id, title: 'Parca ' + (i + 1), instructions: (slow && i === 0 ? 'YAVAS ' : '') + (leak && i === 0 ? 'SIZDIR ' : '') + 'dosya yaz ' + i })) });
  }
  if (/TAMAM|OK yaz/.test(prompt)) return emit('TAMAM');
  // Isci: dosya degistir
  // "SIZDIR" gorevi: ajan .env dosyasini zorla commit'ler (gizli dosya sizdirma denemesi)
  if (/SENIN GOREVIN:[\s\S]*SIZDIR/.test(prompt)) { try { require('child_process').execSync("git add -f .env && git -c user.name=a -c user.email=a@a commit -q -m sizdir", { stdio: 'ignore' }); } catch {} }
  if (prompt.includes('YENI TALIMAT')) fs.writeFileSync('devam.txt', 'devam edildi\n');
  else fs.writeFileSync('out-' + Math.random().toString(36).slice(2, 7) + '.txt', 'is yapildi\n');
  emit('## Rapor\n- dosya yazdim\n- hiz **1.8x**');
}
main();
