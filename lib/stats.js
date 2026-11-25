// Istatistik: isler (runs), gorevler (tasks) ve hesap kullanim kayitlarindan ozet uretir.
// Hicbir sey degistirmez; sadece okur.

const DAY = 24 * 3600000;
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const FINISHED = new Set(['done', 'error', 'stopped', 'failed', 'limit']);
const ok = (st) => st === 'done';

function computeStats(S, { days = 7, projectId = '' } = {}) {
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  // Aralik: bugun dahil son N gun; 0 = tumu
  let from = days > 0 ? midnight.getTime() - (days - 1) * DAY : 0;
  const runs = S.runs.filter((r) => (!projectId || r.projectId === projectId) && (r.createdAt || 0) >= from);
  if (!days) from = runs.length ? new Date(new Date(Math.min(...runs.map((r) => r.createdAt))).setHours(0, 0, 0, 0)).getTime() : midnight.getTime();

  // ---- Gunluk seri (en fazla 90 gun) ----
  const nDays = Math.min(90, Math.round((midnight.getTime() - from) / DAY) + 1);
  const start = midnight.getTime() - (nDays - 1) * DAY;
  const daily = Array.from({ length: nDays }, (_, i) => ({ d: dayKey(start + i * DAY), done: 0, fail: 0, open: 0 }));
  const idx = new Map(daily.map((x, i) => [x.d, i]));
  for (const r of runs) {
    const i = idx.get(dayKey(r.createdAt)); if (i == null) continue;
    if (ok(r.status)) daily[i].done++; else if (FINISHED.has(r.status)) daily[i].fail++; else daily[i].open++;
  }

  // ---- Ozet sayilar ----
  const finished = runs.filter((r) => FINISHED.has(r.status));
  const durs = finished.filter((r) => r.startedAt && r.finishedAt).map((r) => r.finishedAt - r.startedAt);
  const tasks = runs.flatMap((r) => (r.rounds || []).flatMap((R) => (R.tasks || []).map((t) => ({ ...t, run: r }))));
  const races = runs.filter((r) => r.mode === 'race' && r.bestBranch);
  const totals = {
    runs: runs.length,
    finished: finished.length,
    success: finished.length ? Math.round((finished.filter((r) => ok(r.status)).length / finished.length) * 100) : null,
    avgMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    tasks: tasks.length,
    merged: tasks.filter((t) => t.merged).length, // otomatik bitis adimi da gorevi "merged" isaretler
    races: races.length,
    questions: finished.filter((r) => ok(r.status) && !(r.rounds || []).some((R) => (R.tasks || []).length)).length,
  };

  // ---- Hesap bazinda (tek geciste grupla) ----
  const week = now - 7 * DAY;
  const tasksByAcct = new Map();
  for (const t of tasks) {
    let list = tasksByAcct.get(t.assigneeId);
    if (!list) tasksByAcct.set(t.assigneeId, (list = []));
    list.push(t);
  }
  const managedByAcct = new Map();
  for (const r of runs) managedByAcct.set(r.managerId, (managedByAcct.get(r.managerId) || 0) + 1);
  const raceStatsByAcct = new Map();
  for (const r of races) {
    const seen = new Set();
    const won = new Set();
    for (const t of r.rounds[0]?.tasks || []) {
      seen.add(t.assigneeId);
      if (t.branch === r.bestBranch) won.add(t.assigneeId);
    }
    for (const id of seen) {
      let rs = raceStatsByAcct.get(id);
      if (!rs) raceStatsByAcct.set(id, (rs = { runs: 0, wins: 0 }));
      rs.runs++;
      if (won.has(id)) rs.wins++;
    }
  }
  const accounts = S.accounts.map((a) => {
    const mine = tasksByAcct.get(a.id) || [];
    let finCount = 0, doneCount = 0, mergedCount = 0, durSum = 0, durCount = 0;
    for (const t of mine) {
      if (t.merged) mergedCount++;
      if (FINISHED.has(t.status)) {
        finCount++;
        if (ok(t.status)) doneCount++;
        if (t.startedAt && t.endedAt) { durSum += t.endedAt - t.startedAt; durCount++; }
      }
    }
    const rs = raceStatsByAcct.get(a.id) || { runs: 0, wins: 0 };
    let weekMs = 0, weekCalls = 0, weekLimitHits = 0;
    for (const u of a.usage || []) {
      if (u.end > week) {
        weekCalls++;
        weekMs += u.end - u.start;
        if (u.limited) weekLimitHits++;
      }
    }
    return {
      id: a.id, name: a.name, type: a.type,
      tasks: mine.length, done: doneCount, finished: finCount,
      success: finCount ? Math.round((doneCount / finCount) * 100) : null,
      avgMs: durCount ? Math.round(durSum / durCount) : null,
      managed: managedByAcct.get(a.id) || 0,
      merged: mergedCount,
      raceRuns: rs.runs, raceWins: rs.wins,
      weekMin: Math.round(weekMs / 60000),
      weekCalls, weekLimitHits,
      limitWeek: a.limits?.week?.pct ?? null, limit5h: a.limits?.fiveHour?.pct ?? null,
    };
  }).sort((x, y) => y.tasks - x.tasks || y.managed - x.managed || y.weekMin - x.weekMin);

  // ---- One cikanlar (yeterli veri varsa) ----
  const highlights = [];
  const enough = accounts.filter((a) => a.finished >= 3);
  if (enough.length >= 2) {
    const rel = [...enough].sort((x, y) => y.success - x.success || y.finished - x.finished)[0];
    highlights.push({ k: 'reliable', id: rel.id, text: `En güvenilir: ${rel.name} (%${rel.success} başarı, ${rel.finished} görev)`, a: { name: rel.name, pct: rel.success, n: rel.finished } });
    const fast = enough.filter((a) => a.avgMs).sort((x, y) => x.avgMs - y.avgMs)[0];
    if (fast) highlights.push({ k: 'fast', id: fast.id, ms: fast.avgMs, text: `En hızlı: ${fast.name}`, a: { name: fast.name } });
  }
  const champ = accounts.filter((a) => a.raceWins > 0).sort((x, y) => y.raceWins - x.raceWins)[0];
  if (champ) highlights.push({ k: 'champ', id: champ.id, text: `Yarış şampiyonu: ${champ.name} (${champ.raceWins}/${champ.raceRuns} galibiyet)`, a: { name: champ.name, wins: champ.raceWins, runs: champ.raceRuns } });
  const busiest = accounts.filter((a) => a.weekMin > 0).sort((x, y) => y.weekMin - x.weekMin)[0];
  if (busiest) highlights.push({ k: 'busy', id: busiest.id, text: `Bu hafta en çok çalışan: ${busiest.name} (${busiest.weekMin} dk)`, a: { name: busiest.name, min: busiest.weekMin } });
  const hot = accounts.filter((a) => a.limitWeek != null && a.limitWeek >= 80).sort((x, y) => y.limitWeek - x.limitWeek)[0];
  if (hot) highlights.push({ k: 'warn', id: hot.id, text: `Dikkat: ${hot.name} haftalık limitin %${Math.round(hot.limitWeek)}'ini kullandı`, a: { name: hot.name, pct: Math.round(hot.limitWeek) } });

  // ---- Proje bazinda (tek geciste grupla) ----
  const runsByProj = new Map();
  for (const r of S.runs) {
    if ((r.createdAt || 0) < from) continue;
    let ps = runsByProj.get(r.projectId);
    if (!ps) runsByProj.set(r.projectId, (ps = { runs: 0, fin: 0, done: 0, last: null }));
    ps.runs++;
    if (FINISHED.has(r.status)) { ps.fin++; if (ok(r.status)) ps.done++; }
    if (r.createdAt && (!ps.last || r.createdAt > ps.last)) ps.last = r.createdAt;
  }
  const projects = S.projects.map((p) => {
    const ps = runsByProj.get(p.id);
    if (!ps) return null;
    return { id: p.id, name: p.name, runs: ps.runs, success: ps.fin ? Math.round((ps.done / ps.fin) * 100) : null, last: ps.last };
  }).filter(Boolean).sort((x, y) => y.runs - x.runs);

  return { days, projectId, from, totals, daily, accounts, highlights, projects };
}

module.exports = { computeStats };
