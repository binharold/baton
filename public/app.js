'use strict';
// ================= Yardimcilar =================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOKEN = document.querySelector('meta[name="aip-token"]')?.content || '';
const api = async (method, url, data, signal) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-AI-Panel': '1', 'X-AI-Token': TOKEN }, body: data ? JSON.stringify(data) : undefined, signal });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(I18N.srv(j.error) || r.statusText);
  return j;
};
const ls = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem('aip.' + k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('aip.' + k, JSON.stringify(v)); } catch {} },
};
// Dil: i18n.js (I18N). L() ceviri yardimcisidir; yerel degiskenlerle (t, e...) cakismasin diye ayri adli.
const L = (k, v) => I18N.t(k, v);
const loc = () => I18N.locale();
const lower = (s) => String(s || '').toLocaleLowerCase(loc());
// Degismeyen DOM alanlarini yeniden yazmamak icin onbellek
const lastHTML = new WeakMap();
const setHTML = (el, html) => { if (!el || lastHTML.get(el) === html) return false; lastHTML.set(el, html); el.innerHTML = html; return true; };
const setText = (el, txt) => { const s = String(txt ?? ''); if (el && el.textContent !== s) el.textContent = s; };
// Sabit arayuz ogelerini tek seferde onbellekle (tekrarli DOM sorgularini azaltir)
const EL = {
  input: $('#input'), send: $('#send'), scroll: $('#scroll'), msgs: $('#msgs'), live: $('#live'),
  projects: $('#projects'), mgrCard: $('#mgrCard'), accounts: $('#accounts'), teamCount: $('#teamCount'),
  banner: $('#banner'), projTitle: $('#projTitle'), folderBtn: $('#folderBtn'),
  attn: $('#attn'), compTo: $('#compTo'), hintLine: $('#hintLine'), menu: $('#menu'),
  inbox: $('#inbox'), inboxBtn: $('#inboxBtn'), inboxCount: $('#inboxCount'), ibSub: $('#ibSub'), ibList: $('#ibList'),
  schedCount: $('#schedCount'), vzTip: $('#vzTip'), toasts: $('#toasts'),
  setSheet: $('#setSheet'), schedSheet: $('#schedSheet'), statSheet: $('#statSheet'),
  palSheet: $('#palSheet'), libSheet: $('#libSheet'), dlgSheet: $('#dlgSheet'),
  modeBtns: $$('#modeSeg button'), permBtns: $$('#permSeg button'), themeBtns: $$('#themeSeg button'),
  statRangeBtns: $$('#statRange button'), schedModeBtns: $$('#schedMode button'),
};

const TYPE = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini CLI' };
const TYPE_SUB = { claude: 'Claude Code', codex: 'ChatGPT', antigravity: 'agy', gemini: 'Google' };
const typeHint = (k) => L('typeHint.' + k);
const USAGE_CMD = { claude: '/usage', codex: '/status', antigravity: '/usage', gemini: '/stats' };
const STATUS_KEYS = new Set(['queued', 'running', 'waiting', 'done', 'error', 'stopped', 'pending', 'failed', 'limit']);
const stl = (x) => (STATUS_KEYS.has(x) ? L('status.' + x) : x);
// Hazir promptlar public/prompts.js dosyasinda (PROMPTS, PROMPT_CATS, RULE_PRESETS)
const I = {
  chev: '<svg class="i chev" viewBox="0 0 16 16"><path d="M6 3.5L10.5 8 6 12.5"/></svg>',
  dots: '<svg class="i" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="12.5" cy="8" r=".7"/></svg>',
  folder: '<svg class="i" viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z"/></svg>',
  check: '<svg class="i" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  branch: '<svg class="i" viewBox="0 0 16 16" style="width:12px;height:12px"><circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5v6M11 7c0 2.5-3 2.5-6 4"/></svg>',
};

// ================= Durum =================
let S = { accounts: [], projects: [], runs: [], settings: {}, templates: [], types: {} };
let DOC = null;
const GIT = {}; const gitAt = {};
let curPid = ls.get('pid', null);
let mode = ls.get('mode', 'split');
const openRuns = new Set(ls.get('openRuns', []));
const fileCache = new Map(), fileReq = new Set(), pvCache = new Map(); // gorev basina degisen dosyalar / cakisma onizlemesi
const closedRuns = new Set(); const openTasks = new Set(); const openDetails = new Set();
const ACT = {}; // hesap -> son yaptigi is (canli)

// Token sayilari: kisa bicim (12,4 B / 3,2 M), ayrinti ipucunda
const fmtTok = (n) => {
  n = Math.round(Number(n) || 0);
  const f = (v) => v.toLocaleString(loc(), { maximumFractionDigits: v < 10 ? 2 : 1 });
  return n >= 1e6 ? f(n / 1e6) + ' ' + L('tok.m') : n >= 1e3 ? f(n / 1e3) + ' ' + L('tok.k') : String(n);
};
const tokTip = (u) => u ? [L('tok.in', { n: (u.in || 0).toLocaleString(loc()) }), L('tok.out', { n: (u.out || 0).toLocaleString(loc()) }), L('tok.cache', { n: ((u.cacheRead || 0) + (u.cacheWrite || 0)).toLocaleString(loc()) }), u.estimated ? L('tok.est') : ''].filter(Boolean).join(' · ') : '';
const tokChip = (u, cls = '') => u && u.total > 0 ? `<span class="tok ${cls}" title="${esc(tokTip(u))}">${u.estimated ? '≈' : ''}${esc(fmtTok(u.total))} ${L('tok.unit')}</span>` : '';
// Bir projedeki tum calismalarin toplami (sohbet toplami)
function projUsage(pid) {
  const t = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, total: 0, estimated: false };
  for (const r of S.runs) if (r.projectId === pid && r.usage) { for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'total']) t[k] += r.usage[k] || 0; if (r.usage.estimated) t.estimated = true; }
  return t;
}
function usageBreakdown(r) {
  const u = r.usage; if (!u || !u.total) return '';
  const mgr = r.rounds.reduce((a, R) => { const m = R.managerUsage; if (m) { a.total += m.total || 0; a.estimated = a.estimated || !!m.estimated; } return a; }, { total: 0, estimated: false });
  const row = (name, total, calls, est) => `<div class="tk-row"><span>${esc(name)}</span><b>${est ? '≈' : ''}${esc(fmtTok(total))}</b><span class="tk-n">${calls != null ? esc(L('tok.calls', { n: calls })) : ''}</span></div>`;
  const rows = Object.values(u.byAgent || {}).sort((a, b) => b.total - a.total).map((b) => row(b.name, b.total, b.calls, u.estimated)).join('');
  const key = 'tok:' + r.id;
  return detailsKey(key, `${esc(L('tok.title'))} · ${tokChip(u)}`, `<div class="tk">${mgr.total ? row(L('tok.mgr'), mgr.total, null, mgr.estimated) : ''}${rows}</div>`);
}
const fmtTime = (t) => new Date(t).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
const fmtLeft = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? L('u.hm', { h: Math.floor(m / 60), m: m % 60 }) : L('u.min', { n: m }); };
const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); if (s < 60) return L('u.sec', { n: s }); const m = Math.floor(s / 60); if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`; return L('u.hm', { h: Math.floor(m / 60), m: m % 60 }); };
// O(1) erisim icin durum indeksleri (S her guncellendiginde yenilenir)
let acctMap = new Map(), projMap = new Map(), runMap = new Map(), iniMap = new Map(), cachedTeam = [];
let sinceEls = [];
function rebuildIndexes() {
  acctMap = new Map(S.accounts.map((a) => [a.id, a]));
  projMap = new Map(S.projects.map((p) => [p.id, p]));
  runMap = new Map(S.runs.map((r) => [r.id, r]));
  const s = S.settings || {};
  const sel = s.workerIds ? new Set(s.workerIds) : null;
  cachedTeam = S.accounts.filter((a) => a.id !== s.managerId && (!sel || sel.has(a.id)));
  const seen = new Map(); iniMap = new Map();
  for (const a of S.accounts) {
    const b = baseIni(a.name);
    if (!seen.has(b)) { seen.set(b, a.name); iniMap.set(a.name, b); }
    else { const n = String(a.name || '?').trim(); iniMap.set(a.name, n[0].toUpperCase() + (n[1] || '').toLowerCase()); }
  }
}
const acct = (id) => acctMap.get(id);
const project = () => projMap.get(curPid);
const runById = (id) => runMap.get(id);
const teamOf = () => cachedTeam;
// Hazir promptlar secili dile cevrilmis halde (dil basina onbellek)
let lpLang = '', lpList = [];
const localPrompts = () => { const g = I18N.getLang(); if (lpLang !== g) { lpLang = g; lpList = PROMPTS.map((p) => localizePrompt(p, g)); } return lpList; };
const allTemplates = () => [...S.templates.map((t) => ({ ...t, cat: 'mine', mine: true, desc: t.text.split('\n')[0].slice(0, 70) })), ...localPrompts()];
const catOf = (id) => { const c = PROMPT_CATS.find((x) => x.id === id) || { id: 'mine', color: '#5e5ce6', icon: '<path d="M4 2.5h8v11l-4-2.6-4 2.6z"/>' }; return { ...c, name: L('cat.' + c.id) }; };
const catIcon = (c) => `<span class="cat-ic" style="--c:${c.color}"><svg viewBox="0 0 16 16">${c.icon}</svg></span>`;
const shortPath = (d) => { const s = String(d || '').replace(/^\/(Users|home)\/[^/]+/, '~'); const parts = s.split('/'); return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join('/')}` : s; };
const baseIni = (name) => { const n = String(name || '?').trim(); const d = (n.match(/\d+$/) || [''])[0]; return (n[0] || '?').toUpperCase() + (d || (n.split(/\s+/)[1]?.[0] || '').toUpperCase()); };
// Ayni kisaltma iki hesapta varsa (Claude 1 / Codex 1) ikinciye ilk iki harf: "Co"
const initials = (name) => {
  if (iniMap.has(name)) return iniMap.get(name);
  const b = baseIni(name);
  const first = S.accounts.find((a) => baseIni(a.name) === b);
  if (!first || first.name === name) return b;
  const n = String(name || '?').trim();
  return n[0].toUpperCase() + (n[1] || '').toLowerCase();
};
// Giris gerekli mi? Once hak harcamadan yapilan kontrol (auth), yoksa son testin sonucu
const needsLogin = (a) => !!a && (a.auth ? a.auth.ok === false : !!(a.lastTest && !a.lastTest.ok && !a.lastTest.limited));
const testFailed = (a) => !!a && a.auth?.ok === true && !!(a.lastTest && !a.lastTest.ok && !a.lastTest.limited);
const stateOf = (a) => (a?.stats?.limited ? 'limit' : needsLogin(a) ? 'out' : a?.stats?.busy ? 'busy' : 'ok');
const avatar = (a, dot = false) => (a ? `<span class="av ${a.type}" title="${esc(a.name)}">${esc(initials(a.name))}${dot ? `<i class="dot ${stateOf(a)}"></i>` : ''}</span>` : '');

// ================= Markdown (guvenli, bagimsiz) =================
const mdCache = new Map();
function md(src) {
  const key = I18N.getLang() + '\u0002' + String(src || '');
  if (mdCache.has(key)) return mdCache.get(key);
  const codes = [];
  let s = key.slice(3).replace(/\r/g, '');
  s = s.replace(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => { codes.push({ lang, code: code.replace(/\n$/, '') }); return `\n\u0000${codes.length - 1}\u0000\n`; });
  const lines = esc(s).split('\n');
  const inline = (t) => {
    const keep = [];
    const k = (h) => { keep.push(h); return `\u0001${keep.length - 1}\u0001`; };
    t = t.replace(/`([^`]+)`/g, (_, c) => k(`<code>${c}</code>`));
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, u) => k(`<a href="${u}" target="_blank" rel="noopener">${txt}</a>`));
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => pre + k(`<a href="${u}" target="_blank" rel="noopener">${u}</a>`));
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1<em>$2</em>');
    return t.replace(/\u0001(\d+)\u0001/g, (_, n) => keep[n]);
  };
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isBlockStart = (l) => /^#{1,4}\s/.test(l) || /^\s*(-{3,}|\*{3,})\s*$/.test(l) || /^&gt;/.test(l) || isList(l) || isTableRow(l) || /^\u0000\d+\u0000$/.test(l.trim());
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\u0000\d+\u0000$/.test(l.trim())) { out.push(l.trim()); i++; continue; }
    if (/^#{1,4}\s/.test(l)) { const n = Math.min(3, l.match(/^#+/)[0].length); out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ''))}</h${n}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^&gt;/.test(l)) { const b = []; while (i < lines.length && /^&gt;/.test(lines[i])) b.push(lines[i++].replace(/^&gt;\s?/, '')); out.push(`<blockquote>${inline(b.join('<br>'))}</blockquote>`); continue; }
    if (isTableRow(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = row(l); i += 2; const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (isList(l)) {
      const ordered = /^\s*\d/.test(l); const items = [];
      while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (isList(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')); else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const b = [];
    while (i < lines.length && lines[i].trim() && !(b.length && isBlockStart(lines[i]))) b.push(lines[i++]);
    out.push(`<p>${inline(b.join('<br>'))}</p>`);
  }
  const html = out.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => {
    const c = codes[n];
    return `<div class="codeblock"><div class="ch"><span>${esc(c.lang || L('md.code'))}</span><button data-copy>${L('copy')}</button></div><pre>${esc(c.code)}</pre></div>`;
  });
  if (mdCache.size >= 200) mdCache.delete(mdCache.keys().next().value);
  mdCache.set(key, html);
  return html;
}

// ================= Bildirim, odak tuzagi ve diyaloglar =================
function toast(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind; el.textContent = text;
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  EL.toasts.append(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, kind === 'bad' ? 6500 : 3200);
}
const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const attempt = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, 'bad'); return null; } };

// Ortak odak tuzagi: Tab/Shift+Tab pencere icinde doner, Esc en ustteki pencereyi kapatir, kapaninca odak acan ogeye doner
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const trapStack = [];
function syncBgInert() {
  const modal = trapStack.some((t) => t.el.classList.contains('sheet-bg') || t.el.id === 'tour');
  for (const s of ['aside', 'main']) { const n = $(s); if (n) n.inert = modal; }
}
function getFocusables(root) {
  return $$(FOCUSABLE, root).filter((x) => x.offsetParent !== null && getComputedStyle(x).visibility !== 'hidden');
}
function dialogRoot(el) { return el.matches('[role="dialog"]') ? el : ($('[role="dialog"]', el) || el); }
function activateTrap(el, { onClose, initialFocus } = {}) {
  if (!el || trapStack.some((t) => t.el === el)) return;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const entry = { el, opener, onClose };
  trapStack.push(entry);
  syncBgInert();
  const root = dialogRoot(el);
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  requestAnimationFrame(() => {
    if (!trapStack.includes(entry)) return;
    const target = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
    if (target && target.offsetParent !== null && !target.disabled) target.focus();
    else (getFocusables(root)[0] || root).focus();
  });
}
function releaseTrap(el, restore = true) {
  const idx = trapStack.findIndex((t) => t.el === el);
  if (idx < 0) return;
  const [entry] = trapStack.splice(idx, 1);
  syncBgInert();
  if (!restore) return;
  if (entry.opener && entry.opener.isConnected && entry.opener.offsetParent !== null) {
    entry.opener.focus();
  } else if (trapStack.length) {
    const under = dialogRoot(trapStack[trapStack.length - 1].el);
    (getFocusables(under)[0] || under).focus();
  }
}
// Capture fazinda Tab ve Esc yonetimi: en ustteki acik pencereyi yakalar
document.addEventListener('keydown', (e) => {
  if (!trapStack.length) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (EL.menu.classList.contains('show')) return hideMenu();
    const top = trapStack[trapStack.length - 1];
    if (top.onClose) top.onClose(); else releaseTrap(top.el, true);
    return;
  }
  if (e.key !== 'Tab') return;
  const top = trapStack[trapStack.length - 1];
  const root = dialogRoot(top.el);
  const list = getFocusables(root);
  if (!list.length) { e.preventDefault(); root.focus(); return; }
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first || !root.contains(document.activeElement)) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last || !root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }
}, true);

let dlgCancel = null;
// Onay, metin girisi ya da secim isteyen genel diyalog. Vazgecilirse null doner.
// XSS ve cift kacisi onlemek icin baslik ve metin daima textContent (veya guvenli DOM dugumu) ile yazilir.
function dialog({ title, text = '', input = false, area = false, value = '', placeholder = '', ok = L('dlg.ok'), cancel = L('dlg.cancel'), danger = false, pick = null }) {
  return new Promise((resolve) => {
    const wantText = input || area;
    const dlgText = $('#dlgText');
    $('#dlgTitle').textContent = title;
    if (text instanceof Node) { dlgText.replaceChildren(text); dlgText.style.display = ''; }
    else { dlgText.textContent = text; dlgText.style.display = text ? '' : 'none'; }
    $('#dlgField').style.display = wantText ? '' : 'none';
    $('#dlgInput').style.display = wantText && !area ? '' : 'none';
    $('#dlgArea').style.display = area ? '' : 'none';
    const field = area ? $('#dlgArea') : $('#dlgInput');
    field.value = value; field.placeholder = placeholder;
    $('#dlgPickWrap').style.display = pick ? '' : 'none';
    if (pick) {
      $('#dlgPickLabel').textContent = pick.label;
      $('#dlgPick').innerHTML = pick.options.map((o) => `<option value="${esc(o.value)}" ${o.value === pick.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    }
    $('#dlgOk').textContent = ok; $('#dlgOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    $('#dlgCancel').textContent = cancel; $('#dlgCancel').style.display = cancel ? '' : 'none';
    const finish = (v) => { EL.dlgSheet.classList.remove('show'); off(); dlgCancel = null; releaseTrap(EL.dlgSheet, true); resolve(v); };
    const onOk = () => {
      if (wantText && !field.value.trim() && !pick) return field.focus();
      finish(wantText ? (pick ? { text: field.value, pick: $('#dlgPick').value } : field.value) : (pick ? { pick: $('#dlgPick').value } : true));
    };
    const onCancel = () => finish(null);
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
      if (area && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault(); onOk();
    };
    const onBg = (e) => { if (e.target === EL.dlgSheet) onCancel(); };
    const off = () => { $('#dlgOk').removeEventListener('click', onOk); $('#dlgCancel').removeEventListener('click', onCancel); EL.dlgSheet.removeEventListener('keydown', onKey); EL.dlgSheet.removeEventListener('click', onBg); };
    $('#dlgOk').addEventListener('click', onOk); $('#dlgCancel').addEventListener('click', onCancel);
    EL.dlgSheet.addEventListener('keydown', onKey); EL.dlgSheet.addEventListener('click', onBg);
    dlgCancel = onCancel;
    EL.dlgSheet.classList.add('show');
    activateTrap(EL.dlgSheet, { onClose: onCancel, initialFocus: () => (wantText ? field : $('#dlgOk')) });
  });
}
const confirmDlg = (title, text, ok = L('dlg.ok'), danger = false) => dialog({ title, text, ok, danger });

function openSheet(sel, opts = {}) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  el.classList.add('show');
  activateTrap(el, { onClose: () => closeSheet(el), ...opts });
}
function closeSheet(sel, restore = true) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  if (el === EL.dlgSheet && dlgCancel) return dlgCancel();
  if (el === EL.statSheet) hideTip();
  if (!el.classList.contains('show')) return;
  el.classList.remove('show');
  releaseTrap(el, restore);
}
function closeSheets() {
  while (trapStack.length) {
    const top = trapStack[trapStack.length - 1];
    if (top.onClose) top.onClose(); else releaseTrap(top.el, true);
  }
}
$$('.sheet-bg').forEach((bg) => {
  if (bg.id === 'dlgSheet') return; // kendi kapatma mantigi var
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) closeSheet(bg); });
});

// ================= Yukleme =================
// Optimizasyon: durum degismediyse (ornegin 30 sn'lik "tick") butun ekran yeniden cizilmez; sadece
// zamana bagli kisimlar (limit geri sayimi, bekleyenler) guncellenir.
let lastStateText = '', lastStateEtag = '';
async function load(force) {
  const headers = { 'X-AI-Panel': '1' };
  if (!force && lastStateEtag) headers['If-None-Match'] = lastStateEtag;
  const r = await fetch('/api/state', { headers });
  if (r.status === 304) { renderSide(); renderInbox(); return; }
  if (!r.ok) throw new Error(r.statusText);
  lastStateEtag = r.headers.get('ETag') || '';
  const txt = await r.text();
  if (!force && txt === lastStateText) { renderSide(); renderInbox(); return; }
  lastStateText = txt; S = JSON.parse(txt); rebuildIndexes(); checkBoot();
  if (!projMap.has(curPid)) curPid = projMap.has(S.settings.lastProjectId) ? S.settings.lastProjectId : S.projects[0]?.id;
  ls.set('pid', curPid);
  render();
  refreshGit();
}
function render() {
  renderSide(); renderToolbar(); renderAttention(); renderChat(); renderComposer(); renderSchedBadge(); renderInbox();
  if (EL.setSheet.classList.contains('show')) renderSettings();
  if (EL.schedSheet.classList.contains('show')) renderSched();
  if (EL.statSheet.classList.contains('show') && Date.now() - statAt > 15000) loadStats();
}
async function refreshGit(force) {
  const p = project(); if (!p || !p.dir || p.cloud) return;
  if (!force && (document.hidden || (gitAt[p.dir] && Date.now() - gitAt[p.dir] < 8000))) return;
  gitAt[p.dir] = Date.now();
  try {
    const next = await api('GET', '/api/git-info?dir=' + encodeURIComponent(p.dir));
    const prev = GIT[p.dir];
    if (prev && prev.exists === next.exists && prev.isGit === next.isGit && prev.branch === next.branch && prev.dirty === next.dirty) return;
    GIT[p.dir] = next;
    renderToolbar(); renderAttention();
    if (!project()?.messages.length) renderChat();
  } catch {}
}

// ================= Kenar cubugu =================
function subLine(a) {
  const st = a.stats || {};
  if (st.limited) return `<div class="sub bad" title="${esc(L('sub.opensAt', { time: fmtTime(st.limitUntil) }) + (st.limitExact ? '' : L('sub.est')))}">${esc(L('sub.limited', { left: fmtLeft(st.limitUntil - Date.now()) }))}</div>`;
  if (needsLogin(a)) return `<div class="sub bad">${L('sub.needLogin')} · <button class="linkbtn" data-acctact="login" data-id="${esc(a.id)}">${L('m.login')}</button></div>`;
  if (testFailed(a)) return `<div class="sub bad" title="${esc(a.lastTest.out || '')}">${L('sub.testFailed')} · <button class="linkbtn" data-acctact="test" data-id="${esc(a.id)}">${L('m.retry')}</button></div>`;
  if (st.busy) return `<div class="sub act" data-activity="${esc(a.id)}">${esc(ACT[a.id]?.text || L('sub.working'))}</div>`;
  const real = st.limits && (st.limits.fiveHour || st.limits.week);
  const base = real ? L('sub.ready') : st.runs5h ? L('sub.last5h', { n: st.runs5h, m: st.mins5h }) : L('sub.ready');
  return `<div class="sub" title="${esc(L('sub.today', { n: st.runsToday || 0, m: st.minsToday || 0 }) + (a.model ? ' · ' + L('sub.model', { m: a.model }) : ''))}">${esc(base)}${a.model ? ` · ${esc(a.model)}` : ''}${a.effort ? ` · ${esc(L('effort.' + a.effort))}` : ''}</div>`;
}
function limBars(a) {
  const st = a.stats || {}; const l = st.limits;
  if (st.limited) {
    const tot = st.limitUntil - (st.lastLimitAt || Date.now()); const left = st.limitUntil - Date.now();
    return `<div class="meter"><i style="width:${Math.max(4, 100 - (left / Math.max(tot, 1)) * 100)}%"></i></div>`;
  }
  if (!l || !(l.fiveHour || l.week)) return '';
  const row = (lab, w) => {
    if (!w || w.pct == null) return '';
    const p = Math.min(100, w.pct); const cls = p >= 90 ? 'hot' : p >= 70 ? 'warn' : '';
    return `<div class="lim" title="${esc(L(lab === 'w5' ? 'lim.h5' : 'lim.hw') + (w.resetsAt ? L('lim.resets', { t: new Date(w.resetsAt).toLocaleString(loc(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }) : ''))}"><span>${L(lab === 'w5' ? 'lim.l5' : 'lim.l7')}</span><span class="bar"><i class="${cls}" style="width:${Math.max(2, p)}%"></i></span><b>%${Math.round(p)}</b></div>`;
  };
  return row('w5', l.fiveHour) + row('w7', l.week);
}
function renderBanner() {
  const app = S.app || {};
  let upd = '';
  if (app.restartPending) upd = `<div class="banner">${L('app.pending')} <button class="linkbtn" data-app="cancel">${L('app.cancel')}</button></div>`;
  else if (app.updateAvailable) upd = `<div class="banner">${L('app.updateReady')} <button class="linkbtn" data-app="restart">${L('app.restartShort')}</button></div>`;
  if (!DOC) { setHTML(EL.banner, upd); return; }
  const need = [...new Set(S.accounts.map((a) => a.type))].filter((t) => DOC[t] && !DOC[t].ok);
  if (DOC.git && !DOC.git.ok) need.push('git');
  setHTML(EL.banner, upd + (need.length ? `<div class="banner">${L('banner.missing.h')} ${need.map((t) => `${t === 'git' ? 'git' : TYPE[t]} → <code>${esc(DOC[t].install)}</code>`).join('<br>')}</div>` : ''));
}
// ---- Paneli yeniden baslat ----
let bootId = null;
async function restartPanel(cancel) {
  const r = await attempt(() => api('POST', '/api/restart', cancel ? { cancel: true } : {}));
  if (r?.restarting) toast(L('app.restarting'));
  if (r) load(true).catch(() => {});
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-app]'); if (!b) return;
  restartPanel(b.dataset.app === 'cancel');
});
// Sunucu yeniden acilinca (bootId degisti) sayfa yenilenir; baglanti kopmussa durum yoklanir
let bootPoll = null;
function checkBoot() {
  const id = S.app?.bootId; if (!id) return;
  if (bootId && bootId !== id) { location.reload(); return; }
  bootId = id;
}
function pollBoot() {
  if (bootPoll) return;
  bootPoll = setInterval(() => { if (connected) { clearInterval(bootPoll); bootPoll = null; return; } load(true).catch(() => {}); }, 2000);
}
function projTokSide(pid) { const u = projUsage(pid); return u.total > 0 ? `<span class="tok side" title="${esc(L('tok.projTip') + ' · ' + tokTip(u))}">${u.estimated ? '≈' : ''}${esc(fmtTok(u.total))}</span>` : ''; }
function renderSide() {
  renderBanner();
  const runningPids = new Set();
  for (const r of S.runs) if (r.status === 'running') runningPids.add(r.projectId);
  setHTML(EL.projects, S.projects.map((p) => {
    const running = runningPids.has(p.id);
    const queued = !running && p.messages.some((m) => m.queued);
    return `<button class="proj ${p.id === curPid ? 'on' : ''}" data-proj="${p.id}" ${p.id === curPid ? 'aria-current="page"' : ''}>${I.folder}<span class="nm">${esc(p.name)}</span>${projTokSide(p.id)}${running ? `<span class="live" title="${L('proj.running')}"></span>` : queued ? `<span class="live q" title="${L('proj.queued')}"></span>` : ''}</button>`;
  }).join(''));
  const m = acct(S.settings.managerId);
  setHTML(EL.mgrCard, m
    ? `<div class="mgr-card">${avatar(m, true)}<div class="who-info"><div class="nm">${esc(m.name)}</div>${subLine(m)}${limBars(m)}</div><button class="more" data-more="${m.id}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(L('acct.opts', { name: m.name }))}">${I.dots}</button></div>`
    : `<div class="mgr-card"><div class="who-info"><div class="sub">${L('mgr.none')}</div></div></div>`);
  const rest = S.accounts.filter((a) => a.id !== S.settings.managerId);
  const team = new Set(teamOf().map((a) => a.id));
  setText(EL.teamCount, rest.length ? `${team.size}/${rest.length}` : '');
  setHTML(EL.accounts, rest.map((a) => `<div class="acct ${team.has(a.id) ? '' : 'off'}" title="${team.has(a.id) ? '' : esc(L('team.out'))}">
      ${avatar(a, true)}<div class="who-info"><div class="nm">${esc(a.name)}</div>${subLine(a)}${limBars(a)}</div>
      <button class="more" data-more="${a.id}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(L('acct.opts', { name: a.name }))}">${I.dots}</button></div>`).join('')
    || `<div class="sub" style="padding:6px 8px">${L('team.addHint')}</div>`);
}

// ================= Menu =================
let menuAnchor = null;
function showMenu(anchor, html, onPick) {
  const m = $('#menu');
  m.innerHTML = html;
  $$('button', m).forEach((b) => b.setAttribute('role', 'menuitem'));
  m.classList.add('show');
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  const below = r.bottom + 4, above = r.top - m.offsetHeight - 4;
  m.style.top = (below + m.offsetHeight > innerHeight - 8 && above > 8 ? above : Math.min(below, innerHeight - m.offsetHeight - 8)) + 'px';
  menuAnchor = anchor;
  anchor.classList.add('open');
  anchor.setAttribute('aria-expanded', 'true');
  m.onclick = (e) => { const b = e.target.closest('[data-act]'); if (!b) return; hideMenu(false); onPick(b.dataset.act, b.dataset); };
  m.onkeydown = (e) => {
    const items = $$('button[role="menuitem"]', m); if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  };
  setTimeout(() => m.querySelector('button')?.focus(), 20);
}
function hideMenu(restore = false) {
  const m = $('#menu'); if (!m.classList.contains('show')) return;
  m.classList.remove('show');
  $$('.more.open, #tplBtn.open, #projMenuBtn.open, #qBtn.open').forEach((b) => { b.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); });
  const a = menuAnchor; menuAnchor = null;
  if (restore && a && a.isConnected) a.focus();
}

function accountMenu(btn, id) {
  const a = acct(id); const inTeam = teamOf().some((x) => x.id === id);
  showMenu(btn, `
    <button data-act="login">${L('m.login')}</button>
    ${['claude', 'codex'].includes(a.type) ? `<button data-act="authcheck">${L('m.authcheck')} <span class="kbd">${L('m.free')}</span></button>` : ''}
    <button data-act="test">${L('m.test')} <span class="kbd">${L('m.small')}</span></button>
    ${a.type === 'codex' || a.type === 'claude' ? `<button data-act="refresh">${L('m.refresh')}${a.type === 'claude' ? ` <span class="kbd">${L('m.small')}</span>` : ''}</button>` : ''}
    <button data-act="usage">${L('m.usage')} <span class="kbd">${USAGE_CMD[a.type]}</span></button>
    ${a.stats?.limited ? `<button data-act="clear">${L('m.clear')}</button>` : ''}
    <hr>
    ${a.id !== S.settings.managerId ? `<button data-act="mgr">${L('m.mgr')}</button><button data-act="team">${inTeam ? L('m.teamOut') : L('m.teamIn')}</button>` : ''}
    <button data-act="model">${L('m.model')}${a.model ? ` <span class="kbd">${esc(a.model)}</span>` : ''}</button>
    ${S.efforts?.[a.type] ? `<button data-act="effort">${L('m.effort')} <span class="kbd">${esc(a.effort ? L('effort.' + a.effort) : L('effort.auto'))}</span></button>` : ''}
    <button data-act="rename">${L('m.rename')}</button>
    <hr><button data-act="del" class="danger">${L('del')}</button>`, (act) => attempt(() => accountAction(a, act)));
}
async function accountAction(a, act) {
  if (act === 'login' || act === 'usage') {
    const r = await api('POST', `/api/accounts/${a.id}/${act}`);
    $('#tTitle').textContent = L(act === 'login' ? 'acct.loginTitle' : 'acct.usageTitle', { name: a.name });
    const what = act === 'login' ? (a.type === 'claude' ? L('term.loginClaude.h') : esc(L('term.login'))) : L('term.usage.h', { cmd: esc(USAGE_CMD[a.type]) });
    const auto = act === 'login' && ['claude', 'codex'].includes(a.type) ? esc(L('term.auto')) : '';
    $('#tText').innerHTML = L(r.opened ? 'term.opened.h' : 'term.notOpened.h', { what, auto });
    $('#tCmd').textContent = r.cmd; openSheet('#termSheet');
  }
  if (act === 'test') {
    toast(L('acct.testing', { name: a.name }), 'info');
    const r = await api('POST', `/api/accounts/${a.id}/test`);
    r.ok ? toast(L('acct.works', { name: a.name })) : toast(`${a.name}: ${L(r.limited ? 'acct.limitedShort' : 'acct.testFail')}`, 'bad');
  }
  if (act === 'authcheck') { const r = await api('POST', `/api/accounts/${a.id}/authcheck`); r.ok === true ? toast(`${a.name}: ${L('acct.loggedIn')}`) : r.ok === false ? toast(`${a.name}: ${L('acct.loggedOut')}`, 'bad') : toast(L('acct.noCheck'), 'info'); }
  if (act === 'refresh') { const r = await api('POST', `/api/accounts/${a.id}/refresh`); r.ok ? toast(`${a.name}: ${L('acct.limUpdated')}`) : toast(`${a.name}: ${L('acct.limFail')}`, 'bad'); }
  if (act === 'clear') await api('POST', `/api/accounts/${a.id}/clearlimit`);
  if (act === 'mgr') { await api('POST', '/api/settings', { managerId: a.id }); toast(L('acct.nowMgr', { name: a.name })); }
  if (act === 'team') {
    const ids = new Set(teamOf().map((x) => x.id));
    ids.has(a.id) ? ids.delete(a.id) : ids.add(a.id);
    await api('POST', '/api/settings', { workerIds: [...ids] });
  }
  if (act === 'model') await pickModel(a);
  if (act === 'effort') await pickEffort(a);
  if (act === 'rename') { const v = await dialog({ title: L('m.rename'), input: true, value: a.name, ok: L('save') }); if (v) await api('POST', `/api/accounts/${a.id}/update`, { name: v }); }
  if (act === 'del' && await confirmDlg(L('acct.delTitle', { name: a.name }), L('acct.delText'), L('del'), true)) await api('DELETE', `/api/accounts/${a.id}`);
}

// Hesabin gercek model listesini getirip secim sunar; listede yoksa elle yazilabilir
// Dusunme seviyesi (Claude: --effort, Codex: model_reasoning_effort). Yuksek seviye daha dikkatli ama daha yavas ve daha cok limit harcar.
async function pickEffort(a) {
  const levels = S.efforts?.[a.type] || [];
  const options = [{ value: '', label: L('effort.auto') }, ...levels.map((e) => ({ value: e, label: L('effort.' + e) }))];
  const res = await dialog({ title: L('effort.title', { name: a.name }), text: L('effort.text'), pick: { label: L('m.effort'), options, value: a.effort || '' }, ok: L('save') });
  if (!res) return;
  await api('POST', `/api/accounts/${a.id}/update`, { effort: res.pick });
  toast(L('effort.set', { name: a.name, e: res.pick ? L('effort.' + res.pick) : L('effort.auto') }));
}
async function pickModel(a) {
  const tid = setTimeout(() => toast(L('model.reading'), 'info'), 400);
  const r = await api('GET', `/api/accounts/${a.id}/models`).catch(() => ({ models: [] }));
  clearTimeout(tid);
  const list = r.models || [];
  const CUSTOM = '__custom__';
  const options = [{ value: '', label: L('model.default') }, ...list.map((m) => ({ value: m.id, label: m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id }))];
  if (a.model && !list.some((m) => m.id === a.model)) options.push({ value: a.model, label: L('model.manual', { id: a.model }) });
  options.push({ value: CUSTOM, label: L('model.other') });
  const res = await dialog({ title: L('model.title', { name: a.name }), text: list.length ? L('model.found', { n: list.length }) : L('model.notFound'), pick: { label: L('model.lbl'), options, value: a.model || '' }, ok: L('save') });
  if (!res) return;
  let model = res.pick;
  if (model === CUSTOM) { model = await dialog({ title: L('model.nameTitle', { name: a.name }), input: true, value: a.model || '', placeholder: L('model.ph'), ok: L('save') }); if (model === null) return; }
  await api('POST', `/api/accounts/${a.id}/update`, { model });
  toast(L(model ? 'model.set' : 'model.setDefault', { name: a.name, model }));
}

// ================= Arac cubugu ve dikkat seridi =================
function renderToolbar() {
  const p = project(); if (!p) return;
  setText(EL.projTitle, p.name);
  setHTML($('#projTok'), tokChip(projUsage(p.id)));
  const gi = p.dir && !p.cloud ? GIT[p.dir] : null;
  let html, warn = false;
  if (p.cloud) { html = `${I.folder}<span class="path">${L('tb.cloud')}</span>`; }
  else if (!p.dir) { html = `${I.folder}<span>${L('tb.noFolder')}</span>`; warn = true; }
  else if (gi && !gi.exists) { html = `${I.folder}<span>${L('tb.folderMissing')}</span>`; warn = true; }
  else {
    html = `${I.folder}<span class="path">${esc(shortPath(p.dir))}</span>`;
    if (gi && gi.isGit) html += `<span class="br">${I.branch} ${esc(gi.branch)}</span>${gi.dirty ? `<i class="dirty" title="${esc(L('git.dirty', { n: gi.dirty }))}"></i>` : ''}`;
    else if (gi && !gi.isGit) html += `<span>${L('git.none')}</span>`;
  }
  EL.folderBtn.className = 'folder' + (warn ? ' warn' : '');
  setHTML(EL.folderBtn, html);
  EL.folderBtn.title = p.cloud ? L('tb.cloudTip') : p.dir ? p.dir : L('tb.folderPick');
}
function renderAttention() {
  const items = [];
  const p = project(); const gi = p && p.dir ? GIT[p.dir] : null;
  if (S.accounts.length) {
    for (const a of S.accounts) if (needsLogin(a) && !a.stats?.limited) items.push(`<span class="chip bad">${esc(L('att.needLogin', { name: a.name }))} <button data-acctact="login" data-id="${a.id}">${L('m.login')}</button></span>`);
    if (DOC) for (const t of new Set(S.accounts.map((a) => a.type))) if (DOC[t] && !DOC[t].ok) items.push(`<span class="chip bad">${esc(L('att.notInstalled', { type: TYPE[t] }))} <button data-install="${t}">${L('att.how')}</button></span>`);
    if (p && !p.dir && !p.cloud) items.push(`<span class="chip">${L('att.noDir')} <button data-do="pick">${L('att.pick')}</button></span>`);
    else if (gi && gi.exists === false) items.push(`<span class="chip bad">${L('att.dirMissing')} <button data-do="pick">${L('att.change')}</button></span>`);
    else if (gi && gi.exists && !gi.isGit) items.push(`<span class="chip info">${L('att.notGit')}</span>`);
    const team = teamOf();
    if (team.length && team.every((a) => a.stats?.limited)) items.push(`<span class="chip bad">${esc(L('att.allLimited', { time: fmtTime(Math.min(...team.map((a) => a.stats.limitUntil))) }))}</span>`);
    else if (S.accounts.length > 1 && !team.length) items.push(`<span class="chip">${L('att.noTeam')} <button data-do="settings">${L('att.pickTeam')}</button></span>`);
  }
  setHTML(EL.attn, items.join(''));
}

// ================= Sohbet =================
function runState(r) { return r.status === 'running' && r.waitingUntil ? 'waiting' : r.status; }
function detailsKey(key, summary, inner, defOpen = false) {
  const open = openDetails.has(key) || (defOpen && !openDetails.has('!' + key));
  return `<details class="raw" data-key="${esc(key)}" ${open ? 'open' : ''}><summary aria-expanded="${open}">${summary}</summary>${inner}</details>`;
}
// Degisen dosya ozeti: sunucu onbellegi (t.stat) ya da bir kez istenen sonuc
function ensureStat(r, t, key) {
  if (t.stat || fileCache.has(key) || fileReq.has(key)) return;
  fileReq.add(key);
  api('GET', `/api/runs/${r.id}/tasks/${t.id}/files`).then((j) => { fileCache.set(key, j); render(); }).catch(() => { fileCache.set(key, { n: 0, add: 0, del: 0, files: [] }); });
}
function statSummary(st) { return st.n ? L(st.n === 1 ? 'fstat.one' : 'fstat.sum', { n: st.n, a: st.add, d: st.del }) : ''; }
function statList(st) {
  const rows = st.files.map((f) => `<div class="frow"><span class="fp" title="${esc(f.path)}">${esc(f.path)}</span><span class="fn">${f.bin ? L('fstat.bin') : `<i class="a">+${f.add}</i> <i class="d">−${f.del}</i>`}</span></div>`).join('');
  return `<div class="flist">${rows}${st.n > st.files.length ? `<div class="frow">${L('fstat.more', { n: st.n - st.files.length })}</div>` : ''}</div>`;
}
function previewLine(t, r, key) {
  const pv = pvCache.get(key);
  if (pv === 'busy') return `<span class="pv" role="status" aria-live="polite">${L('pv.checking')}</span>`;
  if (!pv) return `<button type="button" data-preview="${esc(t.id)}" data-run="${r.id}">${L('pv.check')}</button>`;
  if (!pv.ok) return `<span class="pv" role="status" aria-live="polite">${L('pv.fail')}</span>`;
  return pv.clean
    ? `<span class="pv ok" role="status" aria-live="polite">${L('pv.clean')}</span>`
    : `<span class="pv bad" role="status" aria-live="polite" title="${esc(pv.files.join(', '))}">${esc(L('pv.conf', { f: pv.files.join(', ') }))}</span>`;
}
function taskRow(t, r) {
  const a = acct(t.assigneeId) || { type: '', name: t.assignee };
  const key = `${r.id}:${t.id}`;
  const running = t.status === 'running';
  const isBest = r.bestBranch && t.branch === r.bestBranch;
  const time = running ? `<span data-since="${t.startedAt || Date.now()}"></span>` : t.endedAt && t.startedAt ? fmtDur(t.endedAt - t.startedAt) : '';
  const hasChanges = t.branch && t.diffstat && !t.diffstat.startsWith('(');
  const canAct = r.status !== 'running' && !running;
  const isOpen = openTasks.has(key);
  const stat = hasChanges && canAct ? (t.stat || fileCache.get(key)) : null;
  if (hasChanges && canAct) ensureStat(r, t, key);
  const checkFailed = t.check && !t.check.ok;
  return `<div class="task ${isOpen ? 'open' : ''}">
    <div class="task-row" data-ttoggle="${esc(key)}" tabindex="0" role="button" aria-expanded="${isOpen}">
      ${avatar(a)}
      <div class="tt"><b>${esc(t.title)}</b><span>${esc(t.assignee)}${time ? ' · ' + time : ''}${t.branch ? ` · <button type="button" class="br-copy" data-copy-branch="${esc(t.branch)}" title="${esc(L('copy.branchTitle', { b: t.branch }))}" aria-label="${esc(L('copy.branchAria', { b: t.branch }))}">${esc(t.branch.replace('ai-panel/', ''))}</button>` : ''}</span></div>
      ${stat && stat.n ? `<span class="fsum" title="${esc(statSummary(stat))}">${esc(statSummary(stat))}</span>` : ''}
      ${tokChip(t.usage)}
      ${isBest ? `<span class="pill best">${L('pill.best')}</span>` : ''}
      ${t.check ? `<span class="pill ${t.check.ok ? 'done' : 'failed'}" title="${esc(t.check.cmd)} · ${fmtDur(t.check.ms || 0)}">${L(t.check.ok ? 'chk.pass' : 'chk.fail')}</span>` : ''}
      <span class="pill ${t.status}">${running ? '<i class="spin"></i>' : ''}${running && t.phase === 'setup' ? L('task.setup') : running && t.phase === 'check' ? L('task.check') : stl(t.status)}</span>
      ${running ? `<button class="stop" data-tstop="${esc(t.id)}" data-run="${r.id}" title="${esc(L('task.stopTitle'))}">${L('task.stop')}</button>` : ''}
    </div>
    <div class="task-detail">
      <div class="kv">${esc(t.instructions)}</div>
      ${t.report && !running ? `<div class="report"><div class="rep-h"><button type="button" class="copy-btn" data-copy-report="${esc(t.id)}" data-run="${r.id}" aria-label="${esc(L('copy.report'))}">${L('copy')}</button></div><div class="md">${md(t.report)}</div></div>` : ''}
      ${stat && stat.n ? detailsKey(`files:${key}`, esc(L('fstat.list')) + ' · ' + esc(statSummary(stat)), statList(stat)) : t.diffstat ? `<pre>${esc(t.diffstat)}</pre>` : ''}
      ${t.commitError && t.cwd ? `<div class="kv">${esc(L('task.keptCopy', { p: t.cwd }))}</div>` : ''}
      ${t.merged && t.forced ? `<div class="forced-note" role="status">${esc(L('force.note', { r: t.forced.reason }))}</div>` : ''}
      ${t.check && !t.check.ok ? detailsKey(`chk:${key}`, esc(L('task.chkOut', { cmd: t.check.cmd })), `<pre>${esc(t.check.out || '')}</pre>`, true) : ''}
      ${running ? `<pre data-out="${esc(t.id)}" data-runout="${r.id}">${esc((t.output || '').slice(-8000)) || L('task.starting')}</pre>`
        : detailsKey(`raw:${key}`, L('task.raw'), `<pre data-out="${esc(t.id)}" data-runout="${r.id}">${esc((t.output || '').slice(-8000)) || L('task.noOut')}</pre>`)}
      ${canAct ? `<div class="tact">
        ${hasChanges ? `<button data-diff="${esc(t.id)}" data-run="${r.id}">${L('task.diff')}</button>` : ''}
        ${hasChanges ? (!t.merged && checkFailed ? `<button type="button" class="warn" data-force="${esc(t.id)}" data-run="${r.id}" title="${esc(L('task.forceTitle'))}">${L('task.force')}</button>` : '') + (t.merged ? `<span class="merged">${L('task.merged')}</span>${t.mergeCommit && !t.undoUnavailable ? `<button data-unmerge="${esc(t.id)}" data-run="${r.id}" title="${esc(L('task.unmergeTitle'))}">${L('task.unmerge')}</button>` : ''}` : (checkFailed ? '' : `<button class="go" data-merge="${esc(t.id)}" data-run="${r.id}">${L('task.merge')}</button>`)) : ''}
        ${hasChanges && !t.merged ? previewLine(t, r, key) : ''}
        <button data-cont="${esc(t.id)}" data-run="${r.id}">${L('task.cont')}</button>
      </div>` : ''}
    </div>
  </div>`;
}
function runCard(r) {
  const tasks = r.rounds.flatMap((R) => R.tasks || []);
  const done = tasks.filter((t) => t.status === 'done').length;
  const people = [...new Set(tasks.map((t) => t.assigneeId))].map(acct).filter(Boolean);
  const running = r.status === 'running'; const st = runState(r);
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const lastR = r.rounds.at(-1);
  let l1;
  if (st === 'waiting') l1 = L('run.waiting', { time: fmtTime(r.waitingUntil) });
  else if (r.submit && r.submit.status === 'running') l1 = L('run.submit');
  else if (!tasks.length) l1 = L(running ? 'run.planning' : 'run.noTasks');
  else if (running && lastR && !(lastR.tasks || []).length) l1 = L(r.mode === 'race' ? 'run.judging' : 'run.reviewing');
  else if (running) l1 = L('run.working', { done, n: tasks.length });
  else l1 = L('run.summary', { n: tasks.length, r: r.rounds.filter((R) => (R.tasks || []).length).length });
  const tag = r.mode === 'race' ? `<span class="mode-tag">${L('tag.race')}</span>` : r.mode === 'continue' ? `<span class="mode-tag">${L('tag.cont')}</span>` : '';
  const summary = [...r.rounds].reverse().find((R) => R.plan?.summary)?.plan.summary;
  const progCls = st === 'waiting' ? 'wait' : !tasks.length && running ? 'indet' : r.status === 'done' ? 'done' : ['error', 'stopped'].includes(r.status) ? 'err' : '';
  const timer = running ? `<span class="timer" data-since="${r.startedAt || r.createdAt}"></span>` : r.finishedAt && r.startedAt ? `<span class="timer">${fmtDur(r.finishedAt - r.startedAt)}</span>` : '';
  const open = closedRuns.has(r.id) ? false : (openRuns.has(r.id) || (running && tasks.length > 0));
  return `<div class="run ${open ? 'open' : ''}" data-run="${r.id}">
    <div class="run-head" data-toggle="${r.id}" tabindex="0" role="button" aria-expanded="${open}">
      ${I.chev}
      <div class="info">
        <div class="l1">${esc(l1)} ${tag} <span class="pill ${st}">${running && st !== 'waiting' ? '<i class="spin"></i>' : ''}${stl(st)}</span> ${timer} ${tokChip(r.usage)}</div>
        ${summary ? `<div class="l2">${esc(summary)}</div>` : ''}
        <div class="prog ${progCls}"><i style="width:${!tasks.length && !running ? 100 : pct}%"></i></div>
      </div>
      <div class="stack">${people.slice(0, 5).map((a) => avatar(a)).join('')}</div>
      ${running ? `<button class="stop" data-stop="${r.id}">${L('task.stop')}</button>` : ''}
    </div>
    <div class="run-body">
      ${r.rounds.filter((R) => (R.tasks || []).length).map((R) => `
        <div class="rsec">${L('run.round', { n: R.n })}${R.plan?.summary ? ` <em>· ${esc(R.plan.summary)}</em>` : ''}</div>
        ${R.tasks.map((t) => taskRow(t, r)).join('')}`).join('')}
      ${r.submit ? `<div class="rsec">${L('run.finish')} <span class="pill ${r.submit.status}">${stl(r.submit.status)}</span></div><div style="padding:0 16px"><pre data-out="submit" data-runout="${r.id}">${esc((r.submit.output || '').slice(-6000))}</pre></div>` : ''}
      ${usageBreakdown(r)}
      <details class="more-log" data-key="log:${r.id}" ${openDetails.has('log:' + r.id) ? 'open' : ''}><summary>${L('run.log')}</summary>
        ${r.rounds.map((R) => (R.managerOutput ? `<pre>${esc(R.managerOutput.slice(-5000))}</pre>` : '')).join('')}
        <pre>${esc((r.log || []).join('\n'))}</pre>
      </details>
    </div>
  </div>`;
}
function hero() {
  const p = project(); const m = acct(S.settings.managerId); const team = teamOf();
  const gi = p?.dir ? GIT[p.dir] : null;
  const pendingLogin = S.accounts.filter((a) => needsLogin(a) || !(a.auth?.ok || a.lastTest?.ok));
  const steps = [
    { done: S.accounts.length > 0, t: L('hero.s1.t'), s: L('hero.s1.s'), act: 'add' },
    { done: !pendingLogin.length && S.accounts.length > 0, t: L('hero.s2.t'), s: pendingLogin.length ? L('hero.s2.pending', { names: pendingLogin.slice(0, 3).map((a) => a.name).join(', ') + (pendingLogin.length > 3 ? '…' : '') }) : L('hero.s2.menu'), act: 'login' },
    { done: !!((p?.dir || p?.cloud) && (!gi || gi.exists)), t: L('hero.s3.t'), s: L('hero.s3.s'), act: 'pick' },
    { done: team.length > 0, t: L('hero.s4.t'), s: L('hero.s4.s'), act: 'settings' },
  ];
  const left = steps.filter((x) => !x.done);
  const checklist = left.length ? `<div class="checklist"><div class="ck-head"><span>${L('hero.setup')}</span><span class="ck-prog"><i style="width:${Math.round(((steps.length - left.length) / steps.length) * 100)}%"></i></span><span>${steps.length - left.length}/${steps.length}</span></div>${(S.accounts.length ? left : steps).map((x) => `<button class="${x.done ? 'done' : ''}" data-step="${x.act}"><span class="ck">${x.done ? I.check : ''}</span><span><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span>${I.chev}</button>`).join('')}</div>` : '';
  if (!m) {
    return `<div class="hero">
      <h2>${L('hero.title')}</h2><p>${L('hero.intro')}</p>${checklist}</div>`;
  }
  // Canli gosterge: hazir ajan, bugunku is, en yuksek haftalik limit, prompt sayisi
  function heroStats() {
    const ready = S.accounts.filter((a) => !needsLogin(a) && !a.stats?.limited).length;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = S.runs.filter((r) => (r.createdAt || 0) >= midnight.getTime()).length;
    const weeks = S.accounts.map((a) => a.stats?.limits?.week?.pct).filter((x) => x != null);
    const tiles = [[`${ready}/${S.accounts.length}`, L('hero.st.ready')], [String(today), L('hero.st.today')], [weeks.length ? `%${Math.round(Math.max(...weeks))}` : '—', L('hero.st.week')], [String(PROMPTS.length), L('hero.st.prompts')]];
    return `<div class="hero-stats">${tiles.map(([v, l]) => `<div class="hs"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>`;
  }
  const n = Math.min(team.length, 6);
  return `<div class="hero">
    <div class="greet">${greeting()}</div>
    <h2>${esc(p?.name || '')}</h2>
    <p>${n ? esc(L('hero.p.ready', { mgr: m.name, n: team.length })) : L('hero.p.noTeam')}</p>
    ${heroStats()}
    ${checklist}${`<div class="sugg">
      ${localPrompts().filter((t) => t.featured).slice(0, 5).map((t) => `<button data-fill="${esc(t.id)}">${catIcon(catOf(t.cat))}<span class="sg-t"><b>${esc(t.title)}${t.mode === 'race' ? ` <span class="mode-tag">${L('tag.race')}</span>` : ''}</b><span>${esc(t.desc)}</span></span></button>`).join('')}
      <button data-lib="1" class="sg-all"><span class="sg-t"><b>${L('hero.allPrompts')}</b><span>${L('hero.allPromptsSub', { n: PROMPTS.length })}</span></span></button>
    </div>`}
  </div>`;
}
// Sohbet uzayinca "yeni sohbete gec" onerisi: yonetici gecmisine girecek metnin tahmini uzunlugu (server buildHistory ile ayni mantik)
const HIST_TIP_CHARS = 12000;
const HIST_STATUS = ['Durduruldu.', 'Bitti.', 'Bir hata oldu, ayr\u0131nt\u0131lara bak.'];
function histChars(p) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim(); let prev = null, out = [];
  for (const m of p.messages || []) {
    if (m.role !== 'user' && m.role !== 'manager') continue;
    if (m.role === 'manager' && HIST_STATUS.includes(String(m.text || '').trim())) continue;
    if (m.role === 'user' && prev && prev.role === 'user' && norm(prev.text) === norm(m.text)) continue;
    out.push(m); prev = m;
  }
  return out.slice(-10).reduce((n, m) => n + String(m.text || '').length, 0);
}
function histTip(p) {
  if (ls.get('histTip', {})[p.id] || histChars(p) < HIST_TIP_CHARS) return '';
  return `<div class="hist-tip" role="status"><span>${L('hist.tip')}</span><button type="button" class="reuse" data-hist-new="${esc(p.id)}">${L('hist.go')}</button><button type="button" class="hist-x" data-hist-x="${esc(p.id)}" aria-label="${esc(L('hist.close'))}" title="${esc(L('hist.close'))}">×</button></div>`;
}

function renderChat() {
  const p = project(); if (!p) return;
  const sc = EL.scroll, el = EL.msgs;
  const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 80;
  if (!p.messages.length) {
    if (setHTML(el, hero())) { sinceEls = []; sc.scrollTop = 0; }
    return;
  }
  let lastMgrMsg = null;
  for (let i = p.messages.length - 1; i >= 0; i--) if (p.messages[i].role === 'manager') { lastMgrMsg = p.messages[i]; break; }
  // Panel yeniden baslayinca kuyruk kendiliginden baslamaz: ilk bekleyen mesajda "Kuyrugu surdur" gorunur
  const paused = !S.runs.some((r) => r.projectId === p.id && ['running', 'queued'].includes(r.status));
  const firstQueued = paused ? p.messages.find((m) => m.queued) : null;
  const html = histTip(p) + p.messages.map((msg) => {
    if (msg.role === 'user') {
      const run = msg.runId && runById(msg.runId);
      const showRun = run && (run.status === 'running' || run.rounds.some((R) => (R.tasks || []).length) || run.status === 'error');
      const ref = msg.kind === 'continue' ? `<span class="ref">${esc(L('msg.cont', { ref: msg.ref || '' }))}</span>` : '';
      return `<div class="m-user">${ref}<div class="b">${esc(msg.text)}</div><span class="meta">${msg.scheduled ? `<span class="sched-tag">${L('msg.sched')}</span> ` : ''}${msg.mode === 'race' ? `<span class="mode-tag">${L('tag.race')}</span> ` : ''}${fmtTime(msg.at)}${msg.queued ? L('msg.queued') : ''}${msg === firstQueued ? ` <button class="reuse" data-resume-q="${esc(p.id)}" title="${esc(L('msg.resumeTitle'))}">${L('msg.resume')}</button>` : ''}${msg.dropped ? L('msg.dropped') : ''}<button class="reuse" data-reuse="${esc(msg.id)}" title="${esc(L('msg.reuseTitle'))}">${L('msg.reuse')}</button></span></div>
        ${showRun ? runCard(run) : ''}`;
    }
    if (msg.role === 'manager') {
      const run = runById(msg.runId);
      const a = (run && acct(run.managerId)) || acct(S.settings.managerId);
      // Sadece son yonetici mesajinda "sonraki adim" onerileri
      const next = msg === lastMgrMsg && Array.isArray(msg.next) && msg.next.length
        ? `<div class="next-chips"><span>${L('msg.next')}</span>${msg.next.map((n, i) => `<button data-next="${i}" data-msg="${esc(msg.id)}">${esc(n)}</button>`).join('')}</div>` : '';
      return `<div class="m-mgr">${a ? avatar(a) : ''}<div class="body"><div class="hd">${esc(a?.name || L('msg.mgr'))}<span class="meta">${fmtTime(msg.at)}</span><button type="button" class="copy-btn" data-copy-msg="${esc(msg.id)}" aria-label="${esc(L('copy.reply'))}">${L('copy')}</button></div><div class="md">${md(I18N.srv(msg.text))}</div>${next}</div></div>`;
    }
    return `<div class="m-sys">${esc(I18N.srv(msg.text))}</div>`;
  }).join('');
  if (setHTML(el, html)) {
    sinceEls = $$('[data-since]', el);
    if (atBottom) sc.scrollTop = sc.scrollHeight;
  }
}

// ================= Yazma alani =================
function renderComposer() {
  EL.modeBtns.forEach((b) => { b.classList.toggle('on', b.dataset.mode === mode); b.setAttribute('aria-checked', b.dataset.mode === mode); });
  const m = acct(S.settings.managerId); const team = teamOf();
  EL.input.placeholder = L(mode === 'race' ? 'comp.phRace' : 'comp.phSplit');
  setHTML(EL.compTo, !m ? L('comp.noAcct') : mode === 'race'
    ? `${team.slice(0, 4).map((a) => avatar(a)).join('')}<span>${esc(L('comp.toRace', { n: team.length, mgr: m.name }))}</span>`
    : `${avatar(m)}<span>${esc(L('comp.toSplit', { mgr: m.name }))}</span>`);
  const p = project();
  const busy = p && S.runs.some((r) => r.projectId === p.id && r.status === 'running');
  setText(EL.hintLine, L(busy ? 'comp.busy' : 'comp.hint'));
}
const autosize = () => { const t = EL.input; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 220) + 'px'; EL.send.disabled = !t.value.trim(); renderBlanks(); };
// Cevap bekleyen [..] yerleri: sayaci goster, siradakini sec
function renderBlanks() {
  const n = findBlanks(EL.input.value).length, b = $('#qBtn');
  b.style.display = n ? '' : 'none';
  if (n) b.querySelector('span').textContent = L('enh.q', { n });
}
function nextBlank(from = EL.input.selectionEnd) {
  const bl = findBlanks(EL.input.value); if (!bl.length) return false;
  const x = bl.find((r) => r.start >= from) || bl[0];
  EL.input.focus(); EL.input.setSelectionRange(x.start, x.end);
  return true;
}
const fill = (t) => { EL.input.value = t; autosize(); EL.input.focus(); };
// Hazir promptu yazma alanina koyar; modunu ayarlar ve ilk [..] alanini secer
function usePrompt(p) {
  if (!p) return;
  setMode(p.mode === 'race' ? 'race' : 'split');
  fill(p.text);
  const el = $('#input');
  if (!nextBlank(0)) el.setSelectionRange(el.value.length, el.value.length);
  el.scrollTop = 0;
}
function setMode(m) { mode = m; ls.set('mode', m); renderComposer(); }
let blankWarned = false;
async function send() {
  const text = $('#input').value.trim(); if (!text) return;
  if (mode === 'race' && teamOf().length < 2) return toast(L('comp.raceNeed'), 'bad');
  // Cevapsiz [..] varsa bir kez uyar; ikinci basista varsayilanlarla gonder
  const nb = findBlanks(text).length;
  if (nb && !blankWarned) { blankWarned = true; nextBlank(0); return toast(L('enh.warn', { n: nb }), 'info'); }
  blankWarned = false; setEnhChip(null);
  $('#input').value = ''; autosize(); saveDraft();
  const r = await attempt(() => api('POST', '/api/chat', { projectId: curPid, text, mode }));
  if (!r) { $('#input').value = text; autosize(); saveDraft(); return; }
  setTimeout(() => ($('#scroll').scrollTop = $('#scroll').scrollHeight), 350);
}
// ================= Prompt kutuphanesi =================
let libCat = 'all';
function openLib() { $('#libQ').value = ''; renderLib(); openSheet(EL.libSheet, { initialFocus: () => $('#libQ') }); }
function renderLib() {
  const q = lower($('#libQ').value.trim());
  const all = allTemplates();
  const match = (t) => !q || lower(`${t.title} ${t.desc || ''} ${t.text} ${catOf(t.cat).name}`).includes(q);
  const cats = [{ id: 'all', name: L('lib.all'), color: 'var(--text2)', icon: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>' },
    ...(S.templates.length ? [catOf('mine')] : []), ...PROMPT_CATS.map((c) => catOf(c.id))];
  if (!cats.some((c) => c.id === libCat)) libCat = 'all';
  $('#libCats').innerHTML = cats.map((c) => { const n = all.filter((t) => (c.id === 'all' || t.cat === c.id) && match(t)).length;
    return `<button class="${c.id === libCat ? 'on' : ''}" data-cat="${c.id}">${catIcon(c)}<span>${esc(c.name)}</span><small>${n}</small></button>`; }).join('');
  const list = all.filter((t) => (libCat === 'all' || t.cat === libCat) && match(t));
  $('#libGrid').innerHTML = list.length ? list.map((t) => { const c = catOf(t.cat);
    return `<div class="lib-card" data-use="${esc(t.id)}" tabindex="0" role="button">
      <div class="lc-top">${catIcon(c)}<b>${esc(t.title)}</b>${t.mode === 'race' ? `<span class="mode-tag">${L('tag.race')}</span>` : ''}${t.mine ? `<button class="lc-del" data-tdel="${esc(t.id)}" title="${L('del')}" aria-label="${L('del')}"><svg class="i" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>` : ''}</div>
      <div class="lc-desc">${esc(t.desc || '')}</div>
      <div class="lc-text">${esc(t.text).replace(/\[([^\]\n]+)\]/g, '<mark>[$1]</mark>')}</div></div>`; }).join('')
    : `<div class="lib-empty">${L('lib.empty')}</div>`;
  const typed = $('#input').value.trim();
  $('#libSave').disabled = !typed;
  $('#libFootHint').textContent = L(typed ? 'lib.footTyped' : 'lib.footEmpty');
}
$('#libQ').addEventListener('input', renderLib);
$('#libQ').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { const f = $('#libGrid [data-use]'); if (f) { e.preventDefault(); f.click(); } } });
$('#libCats').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b) { libCat = b.dataset.cat; renderLib(); } };
$('#libGrid').addEventListener('click', (e) => {
  const del = e.target.closest('[data-tdel]');
  if (del) { e.stopPropagation(); const t = S.templates.find((x) => x.id === del.dataset.tdel); if (t) attempt(async () => { if (await confirmDlg(L('lib.delConfirm', { title: t.title }), '', L('del'), true)) { await api('DELETE', `/api/templates/${t.id}`); await load(); renderLib(); openSheet(EL.libSheet); } }); return; }
  const card = e.target.closest('[data-use]'); if (!card) return;
  closeSheet(EL.libSheet, false); usePrompt(allTemplates().find((x) => x.id === card.dataset.use));
});
$('#libGrid').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-use]')) { e.preventDefault(); e.target.click(); } });
$('#libSave').onclick = () => attempt(async () => {
  const typed = $('#input').value.trim(); if (!typed) return;
  const title = await dialog({ title: L('lib.saveTitle'), text: L('lib.saveText'), input: true, value: typed.split('\n')[0].slice(0, 40), ok: L('save') });
  if (title) { await api('POST', '/api/templates', { title, text: typed }); toast(L('lib.saved')); await load(); libCat = 'mine'; renderLib(); openSheet('#libSheet'); }
});

// ================= Projeler =================
function switchProject(pid) {
  if (!S.projects.some((p) => p.id === pid)) return;
  saveDraft(); // eski projenin taslagi saklanir
  curPid = pid; ls.set('pid', pid);
  api('POST', '/api/settings', { lastProjectId: pid }).catch(() => {});
  render(); refreshGit(true); loadDraft(); setEnhChip(null);
  setTimeout(() => { const sc = $('#scroll'); sc.scrollTop = project()?.messages.length ? sc.scrollHeight : 0; }, 30);
}
async function newProject() {
  const name = await dialog({ title: L('pr.newTitle'), text: L('pr.newText'), input: true, placeholder: L('pr.namePh'), ok: L('pr.create') });
  if (!name) return;
  const p = await attempt(() => api('POST', '/api/projects', { name }));
  if (!p) return;
  await load(); switchProject(p.id);
  if (S.platform === 'darwin') pickFolder(); else openProjSheet();
}
async function pickFolder() {
  const p = project(); if (!p) return;
  if (S.platform !== 'darwin') { openProjSheet({ initialFocus: () => $('#pDir') }); return; }
  const r = await attempt(() => api('POST', '/api/pick-folder'));
  if (!r || r.cancelled || !r.dir) { if (r && !p.dir && !p.cloud) toast(L('pr.cloudNoPick'), 'info'); return; }
  const patch = { dir: r.dir };
  if (['Genel', 'Yeni proje'].includes(p.name)) patch.name = r.dir.split('/').filter(Boolean).pop();
  // Proje notu bossa klasoru tani ve notu otomatik doldur
  const scan = !p.notes ? await api('GET', '/api/project-scan?dir=' + encodeURIComponent(r.dir)).catch(() => null) : null;
  if (scan && scan.notes) patch.notes = scan.notes;
  await attempt(() => api('POST', `/api/projects/${p.id}`, patch));
  gitAt[r.dir] = 0;
  toast(scan && scan.stack.length ? L('pr.pickedStack', { stack: scan.stack.join(', ') }) + (scan.cmds.test ? L('pr.testCmd', { cmd: scan.cmds.test }) : '') : L('pr.picked'));
}
let finMode = 'none';
function openProjSheet(opts = {}) {
  const p = project(); if (!p) return;
  $('#pName').value = p.name; $('#pDir').value = p.dir || ''; $('#pCloud').checked = !!p.cloud; $('#pNotes').value = p.notes || '';
  $('#pSetup').value = p.setup || ''; $('#pCopy').value = p.copyFiles || ''; $('#pCheck').value = p.check || ''; $('#pAutoCheck').checked = !!p.autoCheck;
  finMode = p.finish?.mode || 'none'; $('#finText').value = p.finish?.text || '';
  renderFin(); dirInfo();
  $('#pPick').style.display = S.platform === 'darwin' ? '' : 'none';
  openSheet('#projSheet', opts);
}
function renderFin() {
  $$('#finSeg button').forEach((b) => { const on = b.dataset.v === finMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $('#finHint').textContent = L('fin.' + finMode);
  $('#finText').style.display = finMode === 'custom' ? '' : 'none';
}
async function dirInfo() {
  const d = $('#pDir').value.trim();
  const cl = $('#pCloud').checked;
  $('#pDir').disabled = cl; $('#pPick').disabled = cl;
  if (cl) { $('#pDirInfo').textContent = L('pr.cloudHint'); $('#pScan').innerHTML = ''; $('#wkFill').style.display = 'none'; return; }
  if (!d) { $('#pDirInfo').textContent = L('pr.dirHint'); return; }
  const g = await api('GET', '/api/git-info?dir=' + encodeURIComponent(d)).catch(() => null);
  if (!g) return;
  $('#pDirInfo').textContent = !g.exists ? L('pr.dirNone') : g.isGit ? L('pr.dirGit', { b: g.branch }) + (g.dirty ? L('pr.dirDirty', { n: g.dirty }) : '') : L('pr.dirNotGit');
  // Proje tarayici: dil ve komutlari goster, tek tikla nota ekle
  const sc = g.exists ? await api('GET', '/api/project-scan?dir=' + encodeURIComponent(d)).catch(() => null) : null;
  $('#pScan').innerHTML = sc && sc.notes
    ? `<div class="scan-h"><b>${L('pr.detected')}</b><button class="linkbtn" id="scanAdd">${L($('#pNotes').value.trim() ? 'pr.addNote' : 'pr.fillNote')}</button></div><pre>${esc(sc.notes)}</pre>` : '';
  const btn = $('#scanAdd');
  if (btn) btn.onclick = () => { const n = $('#pNotes'); if (!n.value.includes(sc.notes)) n.value = (n.value.trim() ? n.value.trimEnd() + '\n\n' : '') + sc.notes; btn.textContent = L('pr.added'); };
  lastScan = sc;
  $('#wkFill').style.display = sc && (sc.setup || sc.copy || sc.cmds?.test) ? '' : 'none';
}
let lastScan = null;
$('#wkFill').onclick = () => {
  const sc = lastScan; if (!sc) return;
  if (sc.setup && !$('#pSetup').value.trim()) $('#pSetup').value = sc.setup;
  if (sc.copy && !$('#pCopy').value.trim()) $('#pCopy').value = sc.copy;
  if (sc.cmds?.test && !$('#pCheck').value.trim()) { $('#pCheck').value = sc.cmds.test; $('#pAutoCheck').checked = true; }
  toast(L('pr.filled'), 'info');
};
$('#finSeg').onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { finMode = v; renderFin(); } };
$('#pDir').addEventListener('change', dirInfo);
$('#pCloud').addEventListener('change', dirInfo);
$('#pPick').onclick = async () => { const r = await attempt(() => api('POST', '/api/pick-folder')); if (r && r.dir) { $('#pDir').value = r.dir; if (['Genel', 'Yeni proje', ''].includes($('#pName').value.trim())) $('#pName').value = r.dir.split('/').filter(Boolean).pop(); dirInfo(); } };
$('#pSave').onclick = () => attempt(async () => {
  const p = project();
  if (finMode === 'custom' && !$('#finText').value.trim()) { $('#finText').focus(); return toast(L('pr.needFin'), 'bad'); }
  if ($('#pAutoCheck').checked && !$('#pCheck').value.trim()) { $('#pCheck').focus(); return toast(L('pr.needCheck'), 'bad'); }
  await api('POST', `/api/projects/${p.id}`, { name: $('#pName').value, dir: $('#pDir').value, cloud: $('#pCloud').checked, notes: $('#pNotes').value, finish: { mode: finMode, text: $('#finText').value },
    setup: $('#pSetup').value, copyFiles: $('#pCopy').value, check: $('#pCheck').value, autoCheck: $('#pAutoCheck').checked });
  closeSheet('#projSheet'); gitAt[$('#pDir').value.trim()] = 0; toast(L('pr.saved'));
});
function projectMenu(btn) {
  const p = project();
  showMenu(btn, `
    <button data-act="settings">${L('pm.settings')}</button>
    <button data-act="pick">${L('pm.pick')}</button>
    <button data-act="sched">${L('pm.sched')}</button>
    <hr><button data-act="new">${L('pm.new')}</button>
    <hr><button data-act="clear">${L('pm.clear')}</button>
    ${S.projects.length > 1 ? `<button data-act="del" class="danger">${L('pm.del')}</button>` : ''}`, (act) => attempt(async () => {
    if (act === 'settings') openProjSheet();
    if (act === 'pick') pickFolder();
    if (act === 'sched') openSched();
    if (act === 'new') newProject();
    if (act === 'clear' && await confirmDlg(L('pm.clearTitle'), L('pm.clearText'), L('pm.clearOk'), true)) await api('POST', `/api/projects/${p.id}/clear`);
    if (act === 'del' && await confirmDlg(L('pm.delTitle', { name: p.name }), L('pm.delText'), L('del'), true)) { await api('DELETE', `/api/projects/${p.id}`); curPid = null; }
  }));
}

// ================= Gorevler: fark, birlestirme, durdurma, devam =================
let diffCtx = null;
async function showDiff(runId, taskId) {
  const r = await api('GET', `/api/runs/${runId}/tasks/${taskId}/diff`);
  diffCtx = { runId, taskId };
  $('#dSub').innerHTML = L('diff.branch.h', { b: esc(r.branch) });
  $('#dBody').innerHTML = r.diff.split('\n').map((l) => `<div class="${l.startsWith('diff --git') ? 'f' : l.startsWith('@@') ? 'h' : l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'd' : ''}">${esc(l) || ' '}</div>`).join('') || `<div>${L('diff.none')}</div>`;
  const t = S.runs.find((x) => x.id === runId)?.rounds.flatMap((R) => R.tasks || []).find((x) => x.id === taskId);
  $('#dMerge').style.display = t?.merged ? 'none' : '';
  openSheet('#diffSheet');
}
async function mergeTask(runId, taskId) {
  const t = runById(runId)?.rounds.flatMap((R) => R.tasks || []).find((x) => x.id === taskId);
  if (t?.check && !t.check.ok) return forceMerge(runId, taskId);
  if (!await confirmDlg(L('diff.mergeTitle'), L('diff.mergeText'), L('task.merge'))) return;
  await api('POST', `/api/runs/${runId}/tasks/${taskId}/merge`);
  pvCache.clear();
  closeSheet('#diffSheet'); toast(L('diff.merged'));
}
// Testi kalan dal: gerekceli onayla alinir (sunucu gerekceyi kaydeder)
async function forceMerge(runId, taskId) {
  const reason = await dialog({ title: L('force.title'), text: L('force.text'), area: true, placeholder: L('force.ph'), ok: L('force.ok'), danger: true });
  if (reason === null) return;
  if (String(reason).trim().length < 8) throw new Error(L('force.short'));
  await api('POST', `/api/runs/${runId}/tasks/${taskId}/merge`, { force: true, reason });
  pvCache.clear();
  closeSheet('#diffSheet'); toast(L('diff.merged'));
}
async function previewTask(runId, taskId) {
  const key = `${runId}:${taskId}`;
  pvCache.set(key, 'busy'); render();
  try { pvCache.set(key, await api('POST', `/api/runs/${runId}/tasks/${taskId}/preview`)); } catch { pvCache.set(key, { ok: false }); }
  render();
}
async function continueTask(runId, taskId) {
  const t = runById(runId)?.rounds.flatMap((R) => R.tasks || []).find((x) => x.id === taskId);
  if (!t) return;
  const desc = document.createDocumentFragment();
  const b = document.createElement('b'); b.textContent = t.title;
  const kbd = document.createElement('span'); kbd.className = 'kbd'; kbd.textContent = '⌘ Enter';
  desc.append(L('cont.pre'), b, L('cont.post', { branch: t.branch ? L('cont.branch') : '' }), kbd);
  const r = await dialog({
    title: L('cont.title'), area: true, ok: L('cont.start'), placeholder: L('cont.ph'),
    text: desc,
    pick: { label: L('cont.who'), options: S.accounts.map((a) => ({ value: a.id, label: a.name + (a.id === t.assigneeId ? L('cont.same') : '') })), value: t.assigneeId },
  });
  if (!r || !r.text.trim()) return;
  await api('POST', `/api/runs/${runId}/tasks/${taskId}/continue`, { text: r.text, accountId: r.pick });
  toast(L('cont.started'));
  setTimeout(() => (EL.scroll.scrollTop = EL.scroll.scrollHeight), 400);
}

// ================= Ayarlar =================
function openSettings() { renderSettings(); openSheet(EL.setSheet); }
function renderSettings() {
  const s = S.settings;
  const team = new Set(teamOf().map((a) => a.id));
  setHTML($('#workers'), S.accounts.filter((a) => a.id !== s.managerId).map((a) =>
    `<label>${avatar(a)}<span class="grow">${esc(a.name)} <span class="sub" style="display:inline">· ${TYPE_SUB[a.type] || ''}</span></span><input type="checkbox" class="switch" value="${a.id}" ${team.has(a.id) ? 'checked' : ''}></label>`).join('') || `<div class="hint" style="padding:6px">${L('set.noAcct')}</div>`);
  EL.permBtns.forEach((b) => { const on = b.dataset.v === (s.perm || 'full'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  setText($('#permHint'), L((s.perm || 'full') === 'full' ? 'set.permFullHint' : 'set.permSafeHint'));
  if (document.activeElement !== $('#maxRounds')) $('#maxRounds').value = s.maxRounds || 2;
  if (document.activeElement !== $('#timeoutMin')) $('#timeoutMin').value = s.timeoutMin || 60;
  const ap = S.app || {};
  setText($('#restartHint'), ap.restartPending ? L('app.pending') : L('set.restartHint'));
  $('#restartBtn').textContent = ap.restartPending ? L('app.cancel') : L('app.restart');
  $('#waitForLimits').checked = s.waitForLimits !== false;
  $('#notify').checked = s.notify !== false;
  $('#notifySound').checked = s.notifySound === true;
  $('#managerWorks').checked = s.managerWorks === true;
  if (document.activeElement !== $('#mgrRules')) $('#mgrRules').value = s.managerRules || '';
  const cur = $('#mgrRules').value;
  setHTML($('#ruleChips'), RULE_PRESETS.map((r, i) => `<button class="${ruleTexts(r).some((x) => cur.includes(x)) ? 'on' : ''}" data-rule="${i}">${ruleTexts(r).some((x) => cur.includes(x)) ? '✓ ' : '+ '}${esc(L('rule.' + r.id + '.t'))}</button>`).join(''));
}
// Hazir kural metni secili dilde; eklenmis kural diger dilde yazilmissa da "eklendi" sayilir
const ruleText = (r) => L('rule.' + r.id + '.r');
const ruleTexts = (r) => I18N.LANGS.map((g) => I18N.DICT[g]['rule.' + r.id + '.r']);
const saveSetting = (patch) => attempt(() => api('POST', '/api/settings', patch));
$('#maxRounds').onchange = () => saveSetting({ maxRounds: Number($('#maxRounds').value) });
$('#timeoutMin').onchange = () => saveSetting({ timeoutMin: Number($('#timeoutMin').value) });
$('#restartBtn').onclick = () => restartPanel(!!S.app?.restartPending);
$('#waitForLimits').onchange = () => saveSetting({ waitForLimits: $('#waitForLimits').checked });
$('#notify').onchange = () => saveSetting({ notify: $('#notify').checked });
$('#notifySound').onchange = () => saveSetting({ notifySound: $('#notifySound').checked });
$('#managerWorks').onchange = () => saveSetting({ managerWorks: $('#managerWorks').checked });
// Gorunurluk: sunucu panel onteyken bildirim gondermesin diye durum bildirilir
let lastVis = null;
const reportVisible = (force) => {
  const v = document.visibilityState === 'visible';
  if (!force && v === lastVis) return;
  lastVis = v;
  api('POST', '/api/visibility', { visible: v }).catch(() => {});
};
document.addEventListener('visibilitychange', () => reportVisible());
window.addEventListener('focus', () => reportVisible(true));
window.addEventListener('pagehide', () => { try { fetch('/api/visibility', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-AI-Panel': '1', 'X-AI-Token': TOKEN }, body: '{"visible":false}' }); } catch {} });
setInterval(() => { if (document.visibilityState === 'visible') reportVisible(true); }, 15000);
reportVisible(true);
$('#mgrRules').onchange = () => saveSetting({ managerRules: $('#mgrRules').value.slice(0, 6000) });
$('#ruleChips').onclick = (e) => {
  const b = e.target.closest('[data-rule]'); if (!b) return;
  const preset = RULE_PRESETS[+b.dataset.rule], r = ruleText(preset), all = ruleTexts(preset); let v = $('#mgrRules').value;
  v = all.some((x) => v.includes(x)) ? v.split('\n').filter((l) => !all.includes(l.replace(/^-\s*/, '').trim())).join('\n') : (v.trim() ? v.trimEnd() + '\n' : '') + '- ' + r;
  $('#mgrRules').value = v; saveSetting({ managerRules: v });
};
$('#workers').onchange = () => saveSetting({ workerIds: $$('#workers input:checked').map((x) => x.value) });
function setTheme(t) { const root = document.documentElement; if (t === 'classic') root.removeAttribute('data-theme'); else root.dataset.theme = t; ls.set('theme', t); renderThemeSeg(); }
const renderThemeSeg = () => { const cur = document.documentElement.dataset.theme || 'classic'; EL.themeBtns.forEach((b) => { const on = b.dataset.v === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); };
$('#themeSeg').onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v) setTheme(v); };
renderThemeSeg();
$('#permSeg').onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v) saveSetting({ perm: v }); };

// ================= Dil (tr / en) =================
// Tema dugmelerinin etiketi: HTML'e dokunmadan, data-v ile eslesen theme.<id> anahtarindan gelir
function applyThemeLabels() {
  $$('#themeSeg button[data-v]').forEach((b) => {
    const k = 'theme.' + b.dataset.v;
    if (!(k in I18N.DICT.tr)) return;
    const node = [...b.childNodes].reverse().find((n) => n.nodeType === 3 && n.textContent.trim());
    if (node) node.textContent = L(k); else b.append(L(k));
  });
}
function renderLangSeg() {
  $$('#langSeg button').forEach((b) => { const on = b.dataset.v === I18N.getLang(); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
}
// Dil degisince sayfayi yenilemeden her seyi yeniden yaz
function applyLang() {
  I18N.applyStatic();
  applyThemeLabels(); renderLangSeg(); hideMenu();
  setText(EL.live, L(connected ? 'conn.on' : 'conn.off'));
  setEnhBtn(); renderEnhChip();
  rebuildIndexes(); render();
  const shown = (el) => el.classList.contains('show');
  if (shown(EL.libSheet)) renderLib();
  if (shown($('#addSheet'))) renderTypes();
  if (shown($('#projSheet'))) { renderFin(); dirInfo(); }
  if (shown(EL.schedSheet)) { setHTML($('#schedPresets'), SCHED_PRESETS.map((x, i) => `<button data-spre="${i}">+ ${esc(L('sp.' + x.n + '.t'))}</button>`).join('')); renderSched(); }
  if (shown(EL.statSheet)) loadStats();
  if (shown(EL.palSheet)) renderPalette();
  if (tourI >= 0) showTourStep();
}
function changeLang(l) { if (I18N.setLang(l)) { ls.set('lang', l); applyLang(); } }
$('#langSeg').onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v) changeLang(v); };

// ================= Hesap ekleme =================
let newType = 'claude';
function renderTypes() {
  $('#typePick').innerHTML = Object.keys(TYPE).map((k) => `<button data-t="${k}" class="${k === newType ? 'on' : ''}" aria-pressed="${k === newType}"><span class="av ${k}">${{ claude: 'Cl', codex: 'Cx', antigravity: 'Ag', gemini: 'Ge' }[k]}</span>${TYPE[k]}<small>${TYPE_SUB[k]}</small></button>`).join('');
  $('#typeHint').textContent = typeHint(newType);
  $('#typeWarn').innerHTML = DOC && DOC[newType] && !DOC[newType].ok ? `<div class="warnbox">${L('add.notInstalled.h', { cmd: esc(DOC[newType].install) })}</div>` : '';
  $('#newName').placeholder = `${newType === 'gemini' ? 'Gemini' : TYPE[newType]} ${S.accounts.filter((a) => a.type === newType).length + 1}`;
  const shared = S.accounts.find((a) => a.type === newType && a.useDefault);
  $('#newDefault').disabled = !!shared; if (shared) $('#newDefault').checked = false;
  $('#newDefaultHint').innerHTML = shared
    ? L('add.shared.h', { name: esc(shared.name) })
    : esc(L('add.default'));
}
$('#typePick').onclick = (e) => { const t = e.target.closest('button')?.dataset.t; if (t) { newType = t; renderTypes(); } };
function openAdd() { $('#acctErr').textContent = ''; renderTypes(); openSheet('#addSheet', { initialFocus: () => $('#newName') }); }
$('#addOpen').onclick = openAdd;
$('#addBtn').onclick = async () => {
  try {
    const a = await api('POST', '/api/accounts', { type: newType, name: $('#newName').value || $('#newName').placeholder, useDefault: $('#newDefault').checked });
    $('#newName').value = ''; $('#newDefault').checked = false; closeSheet('#addSheet');
    toast(L('acct.added', { name: a.name }));
    accountAction(a, 'login').catch(() => {});
  } catch (err) { $('#acctErr').textContent = err.message; }
};
$('#newName').onkeydown = (e) => { if (e.key === 'Enter') $('#addBtn').click(); };

// ================= Komut paleti =================
function commands() {
  const list = [];
  const add = (t, g, run, k = '') => list.push({ t, g, run, k });
  // Temel komutlar ustte: 30+ hazir prompt tarafindan kesilmeden hemen gorunsun
  add(L('set.title'), L('g.general'), openSettings, '⌘,');
  add(L('stat.title'), L('g.general'), openStats);
  add(L('help.title'), L('g.guide'), () => openSheet('#helpSheet'));
  add(L('ib.title'), L('g.general'), openInbox);
  add(L('lib.title'), L('g.prompt'), openLib, '/');
  add(L('pm.sched'), L('g.project'), openSched);
  add(L('cmd.enh'), L('g.smart'), enhance);
  add(L(mode === 'race' ? 'cmd.toSplit' : 'cmd.toRace'), L('g.mode'), () => setMode(mode === 'race' ? 'split' : 'race'));
  add(L('pm.new'), L('g.project'), newProject);
  add(L('cmd.lang'), L('g.general'), () => changeLang(I18N.getLang() === 'tr' ? 'en' : 'tr'));
  S.projects.forEach((x) => x.id !== curPid && add(x.name, L('g.switch'), () => switchProject(x.id)));
  add(L('pm.settings'), L('g.project'), openProjSheet);
  add(L('cmd.pick'), L('g.project'), pickFolder);
  add(L('acct.add'), L('g.account'), openAdd);
  S.accounts.forEach((a) => { if (a.id !== S.settings.managerId) add(L('cmd.mgr', { name: a.name }), L('g.manager'), () => attempt(() => accountAction(a, 'mgr'))); });
  S.accounts.filter((a) => a.type === 'codex' || a.type === 'claude').forEach((a) => add(L('cmd.refresh', { name: a.name }), L('g.limit'), () => attempt(() => accountAction(a, 'refresh'))));
  S.accounts.forEach((a) => add(L('cmd.login', { name: a.name }), L('g.account'), () => attempt(() => accountAction(a, 'login'))));
  add(L('help.tour'), L('g.help'), startTour);
  allTemplates().forEach((t) => add(t.title, t.mine ? L('g.mine') : L('g.promptCat', { cat: catOf(t.cat).name }), () => usePrompt(t)));
  return list;
}
let palList = [], palSel = 0;
function openPalette() {
  $('#palInput').value = ''; palSel = 0; renderPalette();
  openSheet(EL.palSheet, { initialFocus: () => $('#palInput') });
}
function renderPalette() {
  const q = lower($('#palInput').value.trim());
  palList = commands().filter((c) => !q || lower(c.t + ' ' + c.g).includes(q)).slice(0, 40);
  palSel = Math.min(palSel, Math.max(0, palList.length - 1));
  $('#palItems').innerHTML = palList.length ? palList.map((c, i) => `<button class="it ${i === palSel ? 'on' : ''}" id="pal-opt-${i}" data-i="${i}" role="option" aria-selected="${i === palSel}"><span>${esc(c.t)}</span><span class="grp">${esc(c.g)}</span>${c.k ? `<span class="kbd">${c.k}</span>` : ''}</button>`).join('') : `<div class="empty">${L('pal.none')}</div>`;
  const pi = $('#palInput');
  if (palList.length) pi.setAttribute('aria-activedescendant', `pal-opt-${palSel}`); else pi.removeAttribute('aria-activedescendant');
  $('#palItems .on')?.scrollIntoView({ block: 'nearest' });
}
function runPalette(i) { const c = palList[i]; closeSheet(EL.palSheet); if (c) c.run(); }
$('#palInput').addEventListener('input', () => { palSel = 0; renderPalette(); });
$('#palInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palList.length - 1); renderPalette(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPalette(); }
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runPalette(palSel); }
});
$('#palItems').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) runPalette(+b.dataset.i); };

// ================= Olaylar =================
$('#input').addEventListener('input', autosize);
// Yukari kaydirilmisken "en alta in" dugmesi (canli akis sirasinda yeni ciktiya hizli donus)
const toBottom = $('#toBottom');
EL.scroll.addEventListener('scroll', () => { const far = EL.scroll.scrollHeight - EL.scroll.scrollTop - EL.scroll.clientHeight > 240; if (toBottom.classList.contains('show') !== far) toBottom.classList.toggle('show', far); }, { passive: true });
toBottom.onclick = () => { EL.scroll.scrollTo({ top: EL.scroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' }); EL.input.focus({ preventScroll: true }); };
$('#input').addEventListener('keydown', (e) => { if (e.key === '/' && !$('#input').value) { e.preventDefault(); openLib(); return; }
  if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && nextBlank()) { e.preventDefault(); return; } if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$('#send').onclick = send;
$('#modeSeg').onclick = (e) => { const m = e.target.closest('button')?.dataset.mode; if (m) setMode(m); };
$('#modeSeg').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const next = mode === 'race' ? 'split' : 'race';
  setMode(next);
  $(`#modeSeg [data-mode="${next}"]`)?.focus();
});
$('#tplBtn').onclick = (e) => { e.stopPropagation(); openLib(); };
$('#newProject').onclick = newProject;
$('#projTitle').onclick = openProjSheet;
$('#folderBtn').onclick = () => (project()?.dir && S.platform !== 'darwin' ? openProjSheet() : pickFolder());
$('#projMenuBtn').onclick = (e) => { e.stopPropagation(); projectMenu($('#projMenuBtn')); };
$('#setOpen').onclick = openSettings;
$('#paletteBtn').onclick = openPalette;
$('#tCopy').onclick = () => navigator.clipboard?.writeText($('#tCmd').textContent).then(() => toast(L('copied')), () => toast(L('copyFail'), 'bad'));
$('#dMerge').onclick = () => diffCtx && attempt(() => mergeTask(diffCtx.runId, diffCtx.taskId));

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t.closest('#menu') && !t.closest('[data-more]') && !t.closest('#projMenuBtn')) hideMenu();
  if (EL.inbox.classList.contains('show') && !t.closest('#inbox') && !t.closest('#inboxBtn')) hideInbox(false);
  const more = t.closest('[data-more]');
  if (more) { const same = EL.menu.classList.contains('show') && more.classList.contains('open'); hideMenu(); if (!same) accountMenu(more, more.dataset.more); return; }
  const pr = t.closest('[data-proj]'); if (pr) return switchProject(pr.dataset.proj);
  const cp = t.closest('[data-copy]');
  if (cp) { const pre = cp.closest('.codeblock').querySelector('pre'); copyText(pre.textContent, cp); return; }
  const cr = t.closest('[data-copy-report]');
  if (cr) { const tk = runById(cr.dataset.run)?.rounds.flatMap((R) => R.tasks || []).find((x) => x.id === cr.dataset.copyReport); if (tk?.report) copyText(tk.report, cr); return; }
  const cm = t.closest('[data-copy-msg]');
  if (cm) { const m = project()?.messages.find((x) => x.id === cm.dataset.copyMsg); if (m?.text) copyText(I18N.srv(m.text), cm); return; }
  const cb = t.closest('[data-copy-branch]');
  if (cb) { e.stopPropagation(); copyText(cb.dataset.copyBranch, cb); return; }
  const f = t.closest('[data-fill]'); if (f) { usePrompt(allTemplates().find((x) => x.id === f.dataset.fill)); return; }
  if (t.closest('[data-lib]')) { openLib(); return; }
  if (t.closest('[data-race]')) { setMode('race'); fill(''); toast(L('comp.raceToast'), 'info'); return; }
  const hx = t.closest('[data-hist-x]'); if (hx) { const m = ls.get('histTip', {}); m[hx.dataset.histX] = true; ls.set('histTip', m); renderChat(); return; }
  const hn = t.closest('[data-hist-new]');
  if (hn) return attempt(async () => {
    if (!await confirmDlg(L('hist.title'), L('hist.text'), L('hist.ok'), true)) return;
    // Mevcut "Sohbeti temizle" akisi: incelenmemis is dallari silinmez; onceki sohbetin ozeti ilk mesaj olur
    await api('POST', `/api/projects/${hn.dataset.histNew}/clear`, { carry: true });
    const m = ls.get('histTip', {}); delete m[hn.dataset.histNew]; ls.set('histTip', m);
  });
  const rq = t.closest('[data-resume-q]'); if (rq) return attempt(() => api('POST', `/api/projects/${rq.dataset.resumeQ}/resume`));
  const ru = t.closest('[data-reuse]');
  if (ru) { const m = project()?.messages.find((x) => x.id === ru.dataset.reuse); if (m) { setMode(m.mode === 'race' ? 'race' : 'split'); fill(m.text); saveDraft(); } return; }
  const nx = t.closest('[data-next]');
  if (nx) { const m = project()?.messages.find((x) => x.id === nx.dataset.msg); const txt = m?.next?.[+nx.dataset.next]; if (txt) { setMode('split'); fill(txt); saveDraft(); } return; }
  const step = t.closest('[data-step]');
  if (step) {
    const s = step.dataset.step;
    if (s === 'add') openAdd();
    if (s === 'pick') pickFolder();
    if (s === 'settings') openSettings();
    if (s === 'login') { const a = S.accounts.find((x) => needsLogin(x)) || S.accounts.find((x) => !(x.auth?.ok || x.lastTest?.ok)); if (a) attempt(() => accountAction(a, needsLogin(a) || !['claude', 'codex'].includes(a.type) ? 'login' : 'test')); }
    return;
  }
  const doit = t.closest('[data-do]');
  if (doit) { if (doit.dataset.do === 'pick') pickFolder(); if (doit.dataset.do === 'settings') openSettings(); return; }
  const aa = t.closest('[data-acctact]'); if (aa) { const a = acct(aa.dataset.id); if (a) attempt(() => accountAction(a, aa.dataset.acctact)); return; }
  const inst = t.closest('[data-install]');
  if (inst) {
    const tp = inst.dataset.install;
    const frag = document.createDocumentFragment();
    const pre = document.createElement('pre'); pre.textContent = DOC[tp].install;
    frag.append(L('inst.text'), pre);
    dialog({ title: L('inst.title', { type: TYPE[tp] }), text: frag, cancel: '' });
    return;
  }
  const stop = t.closest('[data-stop]'); if (stop) return attempt(() => api('POST', `/api/runs/${stop.dataset.stop}/stop`));
  const ts = t.closest('[data-tstop]'); if (ts) { e.stopPropagation(); return attempt(() => api('POST', `/api/runs/${ts.dataset.run}/tasks/${ts.dataset.tstop}/stop`)); }
  const df = t.closest('[data-diff]'); if (df) return attempt(() => showDiff(df.dataset.run, df.dataset.diff));
  const fm = t.closest('[data-force]'); if (fm) return attempt(() => forceMerge(fm.dataset.run, fm.dataset.force));
  const pvb = t.closest('[data-preview]'); if (pvb) return attempt(() => previewTask(pvb.dataset.run, pvb.dataset.preview));
  const mg = t.closest('[data-merge]'); if (mg) return attempt(() => mergeTask(mg.dataset.run, mg.dataset.merge));
  const um = t.closest('[data-unmerge]');
  if (um) return attempt(async () => {
    if (!await confirmDlg(L('um.title'), L('um.text'), L('um.ok'), true)) return;
    const r = await api('POST', `/api/runs/${um.dataset.run}/tasks/${um.dataset.unmerge}/unmerge`);
    pvCache.clear();
    toast(L(r.how === 'reset' ? 'um.reset' : 'um.revert'));
  });
  const ct = t.closest('[data-cont]'); if (ct) return attempt(() => continueTask(ct.dataset.run, ct.dataset.cont));
  const tg = t.closest('[data-toggle]');
  if (tg && !t.closest('button')) {
    const id = tg.dataset.toggle, card = tg.parentElement, isOpen = card.classList.toggle('open');
    tg.setAttribute('aria-expanded', isOpen);
    if (isOpen) { openRuns.add(id); closedRuns.delete(id); } else { openRuns.delete(id); closedRuns.add(id); }
    lastHTML.delete(EL.msgs);
    ls.set('openRuns', [...openRuns].slice(-50)); return;
  }
  const tt = t.closest('[data-ttoggle]');
  if (tt && !t.closest('button')) {
    const k = tt.dataset.ttoggle, isOpen = tt.parentElement.classList.toggle('open');
    if (isOpen) openTasks.add(k); else openTasks.delete(k);
    tt.setAttribute('aria-expanded', isOpen);
    lastHTML.delete(EL.msgs);
  }
});
// Acik/kapali "details" durumlarini yeniden cizimlerde koru ve aria-expanded guncelle
document.addEventListener('toggle', (e) => {
  const d = e.target; if (!(d instanceof HTMLDetailsElement) || !d.dataset.key) return;
  const sm = d.querySelector('summary'); if (sm) sm.setAttribute('aria-expanded', String(d.open));
  if (d.open) { openDetails.add(d.dataset.key); openDetails.delete('!' + d.dataset.key); } else { openDetails.delete(d.dataset.key); openDetails.add('!' + d.dataset.key); }
  lastHTML.delete(EL.msgs);
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (EL.menu.classList.contains('show')) return hideMenu(true); hideTip(); return; }
  if (tourI >= 0) { if (e.key === 'ArrowRight') $('#tourNext').click(); if (e.key === 'ArrowLeft') $('#tourPrev').click(); return; }
  // Gorev satirlari ve is karti basliklari klavyeyle (Enter / Space) acilip kapanir
  if ((e.key === 'Enter' || e.key === ' ') && !e.isComposing && e.target.matches('[data-ttoggle], [data-toggle]')) {
    e.preventDefault(); e.target.click(); return;
  }
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 'k') { e.preventDefault(); EL.palSheet.classList.contains('show') ? closeSheet(EL.palSheet) : openPalette(); }
  if (e.key === ',') { e.preventDefault(); openSettings(); }
});

// ================= Canli akis =================
let pending = false;
const refresh = () => { if (pending) return; pending = true; setTimeout(async () => { pending = false; try { await load(); } catch {} }, 300); };
const lastLine = (d) => { const lines = String(d).split('\n').map((s) => s.trim()).filter(Boolean); const tool = [...lines].reverse().find((s) => s.startsWith('›')); return (tool || lines.at(-1) || '').slice(0, 90); };
let connected = false;
function connect() {
  const es = new EventSource('/api/events?t=' + encodeURIComponent(TOKEN));
  es.onopen = () => { connected = true; EL.live.classList.add('on'); setText(EL.live, L('conn.on')); refresh(); };
  es.onerror = () => { connected = false; EL.live.classList.remove('on'); setText(EL.live, L('conn.off')); pollBoot(); };
  ['state', 'log', 'tick'].forEach((ev) => es.addEventListener(ev, refresh));
  es.addEventListener('run', () => { pvCache.clear(); refresh(); });
  es.addEventListener('notice', (e) => { try { const n = JSON.parse(e.data); toast(I18N.srv(n.text), n.kind || 'ok'); } catch {} });
  // Optimizasyon: sik gelen cikti parcalari tek karede toplanir (kare basina bir DOM yazimi)
  es.addEventListener('chunk', (e) => { chunkQ.push(JSON.parse(e.data)); if (!chunkRaf) chunkRaf = requestAnimationFrame(flushChunks); });
}
let chunkQ = [], chunkRaf = 0;
function flushChunks() {
  chunkRaf = 0;
  const q = chunkQ; chunkQ = [];
  const acts = new Map(), outs = new Map();
  for (const { runId, taskId, accountId, d } of q) {
    if (accountId) { const line = lastLine(d); if (line) acts.set(accountId, line); }
    const run = runById(runId); if (!run || !taskId) continue;
    if (taskId === 'submit' && run.submit) run.submit.output += d;
    else for (const R of run.rounds) { const t = (R.tasks || []).find((x) => x.id === taskId); if (t) t.output += d; }
    const k = runId + '\u0000' + taskId; const o = outs.get(k);
    if (o) o.d += d; else outs.set(k, { runId, taskId, d });
  }
  for (const [id, line] of acts) {
    ACT[id] = { text: line, at: Date.now() };
    const el = $(`[data-activity="${CSS.escape(id)}"]`, EL.accounts) || $(`[data-activity="${CSS.escape(id)}"]`, EL.mgrCard);
    if (el) el.textContent = line;
  }
  for (const { runId, taskId, d } of outs.values()) {
    const pre = $(`[data-runout="${CSS.escape(runId)}"][data-out="${CSS.escape(taskId)}"]`, EL.msgs);
    if (pre) { const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20; pre.textContent += d; if (stick) pre.scrollTop = pre.scrollHeight; }
  }
}
// Sayaclar: sadece aktif zamanlayici varken ve degisen metinlerde guncelle
setInterval(() => {
  if (!sinceEls.length) return;
  const now = Date.now();
  for (const el of sinceEls) if (el.isConnected) setText(el, fmtDur(now - Number(el.dataset.since)));
}, 1000);
setInterval(() => refreshGit(), 15000);

// ================= Akilli ozellikler =================
// Proje basina taslak: proje degistirince ya da panel kapaninca yazdigin kaybolmaz
const saveDraft = () => { if (curPid) ls.set('draft.' + curPid, $('#input').value); };
const loadDraft = () => { const d = ls.get('draft.' + curPid, ''); if (d !== $('#input').value) { $('#input').value = d; autosize(); } };
let draftTimer = null;
$('#input').addEventListener('input', () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); });

// Prompt iyilestirici: kaba istegi yoneticinin anlayacagi net bir goreve cevirir.
// Istek surerken dugme Iptal olur. Sonuc geldiginde metin degistiyse ezmez, cip ile sorar.
// Uygulaninca 'Geri al' cipi gonderene, proje degisene ya da kapatilana kadar kalir.
let enhCtl = null, enhChip = null; // enhChip: { kind: 'undo', before, after, on: 'after'|'before' } | { kind: 'offer', text, by }
function setEnhBtn() { const busy = !!enhCtl; $('#enhBtn span').textContent = L(busy ? 'enh.cancel' : 'enh.label'); $('#enhBtn').classList.toggle('busy', busy); }
function setEnhChip(c) { enhChip = c; renderEnhChip(); }
function renderEnhChip() {
  const el = $('#enhChip'), c = enhChip; el.hidden = !c; if (!c) return;
  const [msg, a, b] = c.kind === 'offer' ? ['enh.ready', 'enh.apply', 'enh.ignore']
    : c.on === 'after' ? ['enh.applied', 'enh.undo', ''] : ['enh.old', 'enh.redo', ''];
  $('span', el).textContent = L(msg);
  $('[data-enh="a"]', el).textContent = L(a);
  const bb = $('[data-enh="b"]', el); bb.hidden = !b; if (b) bb.textContent = L(b);
}
// Iyilestirilmis metni kutuya koyar; eski metin Geri al icin saklanir
function applyEnhanced(text, by) {
  const before = $('#input').value;
  usePrompt({ text, mode }); saveDraft(); blankWarned = false;
  setEnhChip({ kind: 'undo', before, after: $('#input').value, on: 'after' });
  const nq = findBlanks(text).length;
  toast(nq ? L('enh.doneQ', { by, n: nq }) : L('enh.done', { by }));
}
async function enhance() {
  if (enhCtl) return enhCtl.abort();
  const text = $('#input').value.trim();
  if (!text) { $('#input').focus(); return toast(L('enh.empty'), 'info'); }
  // Ayni metni tekrar iyilestirme: soru varsa menuyu ac, yoksa bildir
  const rep = enhanceRepeat(text, enhChip && enhChip.kind === 'undo' ? (enhChip.on === 'after' ? enhChip.after : '') : '');
  if (rep === 'questions') { toast(L('enh.again'), 'info'); return $('#qBtn').click(); }
  if (rep === 'done') return toast(L('enh.already'), 'info');
  const req = { pid: curPid, text };
  const ctl = enhCtl = new AbortController(); setEnhBtn();
  try {
    const r = await api('POST', '/api/enhance', { projectId: curPid, text, mode }, ctl.signal);
    const out = enhanceOutcome(req, { pid: curPid, text: $('#input').value });
    if (out === 'drop') toast(L('enh.dropped'), 'info');
    else if (r.same) toast(L('enh.same'), 'info');
    else if (out === 'offer') setEnhChip({ kind: 'offer', text: r.text, by: r.by });
    else applyEnhanced(r.text, r.by);
  } catch (e) { if (ctl.signal.aborted) toast(L('enh.canceled'), 'info'); else toast(e.message, 'bad'); }
  finally { if (enhCtl === ctl) enhCtl = null; setEnhBtn(); }
}
$('#enhBtn').onclick = enhance;
$('#enhChip').onclick = (e) => {
  const k = e.target.closest('[data-enh]')?.dataset.enh, c = enhChip; if (!k || !c) return;
  if (k === 'x' || (k === 'b' && c.kind === 'offer')) return setEnhChip(null);
  if (c.kind === 'offer') return applyEnhanced(c.text, c.by);
  // Tek adim ileri/geri; aradaki duzenlemeler birakilan tarafta saklanir
  const cur = $('#input').value;
  if (c.on === 'after') { c.after = cur; fill(c.before); c.on = 'before'; toast(L('enh.reverted'), 'info'); }
  else { c.before = cur; fill(c.after); c.on = 'after'; }
  saveDraft(); renderEnhChip();
};
// Soru sayaci: siradaki soruya git ya da tum varsayilanlari tek tikla kabul et
$('#qBtn').onclick = (e) => {
  const v = EL.input.value;
  if (applyDefaults(v) === v) return nextBlank();
  showMenu(e.currentTarget, `<button data-act="next">${L('enh.qNext')}</button><button data-act="defs">${L('enh.useDefaults')}</button>`, (act) => {
    if (act === 'next') return nextBlank();
    fill(applyDefaults(EL.input.value)); saveDraft(); blankWarned = false; toast(L('enh.defsDone'));
  });
};

// Zamanlanmis gorevler
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const SCHED_PRESETS = [
  { n: 1, time: '02:00', days: [] },
  { n: 2, time: '09:00', days: [1, 2, 3, 4, 5] },
  { n: 3, time: '10:00', days: [1] },
  { n: 4, time: '17:00', days: [5] },
];
let schedDays = [], schedMode = 'split';
const dayText = (d) => (!d || !d.length ? L('day.every') : d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x)) ? L('day.weekdays') : DAYS.filter((n) => d.includes(n)).map((n) => L('day.' + n)).join(', '));
function renderSchedBadge() { const n = (S.schedules || []).filter((s) => s.enabled && s.projectId === curPid).length; setText(EL.schedCount, n || ''); }
function renderSched() {
  const p = project(); const list = (S.schedules || []).filter((s) => s.projectId === curPid);
  setText($('#schedTitle'), L('sched.titleProj', { name: p?.name || '' }));
  setHTML($('#schedList'), list.length ? list.map((s) => `<div class="sched-row ${s.enabled ? '' : 'off'}">
      <div class="sr-time"><b>${esc(s.time)}</b><span>${esc(dayText(s.days))}</span></div>
      <div class="sr-text" title="${esc(s.text)}">${s.mode === 'race' ? `<span class="mode-tag">${L('tag.race')}</span> ` : ''}${esc(s.text)}${s.lastRunAt ? `<small>${esc(L('sched.last', { t: new Date(s.lastRunAt).toLocaleString(loc(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }))}</small>` : ''}</div>
      <button class="linkbtn" data-srun="${s.id}" title="${esc(L('sched.nowTitle'))}">${L('sched.now')}</button>
      <input type="checkbox" class="switch" data-stoggle="${s.id}" ${s.enabled ? 'checked' : ''} aria-label="${esc(L('sched.toggle'))}">
      <button class="lc-del" style="opacity:1" data-sdel="${s.id}" title="${L('del')}" aria-label="${L('del')}"><svg class="i" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </div>`).join('') : `<div class="hint" style="padding:4px 0 10px">${L('sched.empty')}</div>`);
  setHTML($('#schedDays'), DAYS.map((n) => `<button data-day="${n}" class="${schedDays.includes(n) ? 'on' : ''}" aria-pressed="${schedDays.includes(n)}">${L('day.' + n)}</button>`).join(''));
  EL.schedModeBtns.forEach((b) => { const on = b.dataset.v === schedMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
}
function openSched() {
  if (!project()?.dir && !project()?.cloud) return toast(L('sched.needDir'), 'bad');
  setHTML($('#schedPresets'), SCHED_PRESETS.map((x, i) => `<button data-spre="${i}">+ ${esc(L('sp.' + x.n + '.t'))}</button>`).join(''));
  renderSched(); openSheet(EL.schedSheet);
}
$('#schedBtn').onclick = openSched;
$('#schedPresets').onclick = (e) => { const b = e.target.closest('[data-spre]'); if (!b) return; const x = SCHED_PRESETS[+b.dataset.spre]; $('#schedText').value = L('sp.' + x.n + '.x'); $('#schedTime').value = x.time; schedDays = [...x.days]; renderSched(); };
$('#schedDays').onclick = (e) => { const b = e.target.closest('[data-day]'); if (!b) return; const n = +b.dataset.day; schedDays = schedDays.includes(n) ? schedDays.filter((x) => x !== n) : [...schedDays, n]; renderSched(); };
$('#schedMode').onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { schedMode = v; renderSched(); } };
$('#schedTime').addEventListener('input', (e) => { let v = e.target.value.replace(/[^\d]/g, '').slice(0, 4); if (v.length > 2) v = v.slice(0, 2) + ':' + v.slice(2); e.target.value = v; });
$('#schedAdd').onclick = () => attempt(async () => {
  const text = $('#schedText').value.trim(); let time = $('#schedTime').value.trim();
  if (/^\d{1,2}$/.test(time)) time += ':00';
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!text) { $('#schedText').focus(); return toast(L('sched.needText'), 'bad'); }
  if (!m || +m[1] > 23 || +m[2] > 59) { $('#schedTime').focus(); return toast(L('sched.badTime'), 'bad'); }
  await api('POST', '/api/schedules', { projectId: curPid, text, time: `${m[1].padStart(2, '0')}:${m[2]}`, days: schedDays, mode: schedMode });
  toast(L('sched.added', { time: `${m[1].padStart(2, '0')}:${m[2]}`, days: dayText(schedDays) }));
  $('#schedText').value = ''; $('#schedTime').value = ''; schedDays = []; renderSched();
});
$('#schedList').addEventListener('click', (e) => {
  const run = e.target.closest('[data-srun]'); if (run) return attempt(async () => { await api('POST', `/api/schedules/${run.dataset.srun}/run`); toast(L('sched.queued')); closeSheet(EL.schedSheet); });
  const del = e.target.closest('[data-sdel]'); if (del) return attempt(async () => { if (await confirmDlg(L('sched.delTitle'), '', L('del'), true)) await api('DELETE', `/api/schedules/${del.dataset.sdel}`); });
});
$('#schedList').addEventListener('change', (e) => { const t = e.target.closest('[data-stoggle]'); if (t) attempt(() => api('POST', `/api/schedules/${t.dataset.stoggle}`, { enabled: t.checked })); });

// ================= Bekleyenler (dikkat isteyen her sey, tum projelerde) =================
const dismissed = new Set(ls.get('dismissed', []));
function pendingItems() {
  const items = []; const since = Date.now() - 3 * 86400000;
  for (const a of S.accounts) {
    if (needsLogin(a)) items.push({ k: 'login', sev: 'bad', id: 'login:' + a.id, title: L('ib.login', { name: a.name }), sub: L('ib.loginSub'), btn: L('m.login'), go: () => attempt(() => accountAction(a, 'login')) });
    else if (a.stats?.limited) items.push({ k: 'limit', sev: 'warn', id: `limit:${a.id}:${a.stats.limitUntil}`, title: L('ib.limit', { name: a.name }), sub: L('ib.limitSub', { left: fmtLeft(a.stats.limitUntil - Date.now()) }) });
  }
  for (const r of [...S.runs].reverse()) {
    const p = S.projects.find((x) => x.id === r.projectId); if (!p || (r.finishedAt || r.createdAt || 0) < since) continue;
    const tasks = r.rounds.flatMap((R) => R.tasks || []);
    const goal = String(r.goal || '').replace(/\s+/g, ' ').slice(0, 90);
    const show = { btn: L('ib.show'), go: () => showRun(r) };
    if (r.status === 'running' && r.waitingUntil) items.push({ k: 'wait', sev: 'warn', id: 'wait:' + r.id, title: L('ib.wait', { proj: p.name }), sub: L('ib.waitSub', { time: fmtTime(r.waitingUntil) }), ...show });
    if (r.status === 'running') continue;
    const changes = tasks.filter((t) => t.branch && t.diffstat && !t.diffstat.startsWith('(') && !t.merged);
    const failedChecks = tasks.filter((t) => t.check && !t.check.ok).length;
    if (r.status === 'error' || tasks.some((t) => t.status === 'failed')) items.push({ k: 'fail', sev: 'bad', id: 'run:' + r.id, pid: p.id, title: L('ib.failed', { proj: p.name }), sub: goal, ...show });
    else if (r.status === 'done' && changes.length && !tasks.some((t) => t.merged)) items.push({ k: 'review', sev: 'info', id: 'run:' + r.id, pid: p.id, title: L('ib.review', { proj: p.name, n: changes.length }) + (failedChecks ? L('ib.reviewFail', { n: failedChecks }) : ''), sub: goal, ...show });
  }
  return items.filter((x) => !dismissed.has(x.id));
}
function showRun(r) {
  hideInbox(false);
  if (r.projectId !== curPid) switchProject(r.projectId);
  openRuns.add(r.id); closedRuns.delete(r.id); ls.set('openRuns', [...openRuns].slice(-50));
  renderChat();
  setTimeout(() => { const el = $(`.run[data-run="${CSS.escape(r.id)}"]`, EL.msgs); if (el) { el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); } }, 60);
}
// Panoya metin kopyala ve dugmede kisa geri bildirim goster
function copyText(text, btn) {
  if (!text) return;
  const done = () => {
    toast(L('copied'));
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = L('copied');
    clearTimeout(btn._ct);
    btn._ct = setTimeout(() => { if (btn.isConnected) btn.textContent = prev; }, 1600);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => toast(L('copyFail'), 'bad'));
  else toast(L('copyFail'), 'bad');
}
// Sekme basligi: calisan gorev sayisi, yoksa gelen kutusu sayisi, yoksa karar bekleyen is isareti, yoksa sade baslik
function titleFor(state, base = 'AI Panel', inbox = 0) {
  const runs = state?.runs || [];
  const skip = typeof state?.dismissed?.has === 'function' ? state.dismissed : null;
  let runningTasks = 0, runningRuns = 0, hasPending = false;
  for (const r of runs) {
    const tasks = (r.rounds || []).flatMap((R) => R.tasks || []);
    if (r.status === 'running') {
      runningRuns++;
      for (const tk of tasks) if (tk.status === 'running') runningTasks++;
      continue;
    }
    if (r.status === 'done' && !(skip && skip.has('run:' + r.id))) {
      const hasChanges = tasks.some((tk) => tk.branch && tk.diffstat && !tk.diffstat.startsWith('(') && !tk.merged);
      if (hasChanges && !tasks.some((tk) => tk.merged)) hasPending = true;
    }
  }
  const active = runningTasks || runningRuns;
  if (active > 0) return `(● ${active}) ${base}`;
  if (inbox > 0) return `(${inbox}) ${base}`;
  if (hasPending) return `(✓) ${base}`;
  return base;
}
let inboxItems = [];
function renderInbox() {
  inboxItems = pendingItems();
  const n = inboxItems.filter((x) => x.sev !== 'info' || x.k === 'review').length;
  setText(EL.inboxCount, n || '');
  const ttl = titleFor({ runs: S.runs, dismissed }, L('app.title'), n); if (document.title !== ttl) document.title = ttl; // sekme basliginda durum
  EL.inboxBtn.classList.toggle('has', n > 0);
  const pending = new Set(inboxItems.map((x) => x.pid).filter(Boolean));
  $$('[data-proj]', EL.projects).forEach((b) => b.classList.toggle('pend', pending.has(b.dataset.proj) && b.dataset.proj !== curPid));
  const running = S.runs.filter((r) => r.status === 'running').length;
  setText(EL.ibSub, running ? L('ib.running', { n: running }) : '');
  if (!EL.inbox.classList.contains('show')) return;
  setHTML(EL.ibList, inboxItems.length ? inboxItems.map((x, i) => `<div class="ib-it ${x.sev}">
      <i class="ib-dot"></i><div class="ib-t"><b>${esc(x.title)}</b>${x.sub ? `<span>${esc(x.sub)}</span>` : ''}</div>
      ${x.btn ? `<button class="btn" data-ibgo="${i}">${esc(x.btn)}</button>` : ''}
      <button class="ib-x" data-ibx="${i}" title="${esc(L('ib.rm'))}" aria-label="${esc(L('ib.rm'))}"><svg class="i" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>`).join('')
    : `<div class="ib-empty"><b>${L('ib.emptyT')}</b><span>${L('ib.emptyS')}</span></div>`);
}
function openInbox() {
  const box = EL.inbox, b = EL.inboxBtn.getBoundingClientRect();
  box.classList.add('show'); EL.inboxBtn.setAttribute('aria-expanded', 'true'); renderInbox();
  box.style.top = (b.bottom + 6) + 'px';
  box.style.left = Math.max(8, Math.min(innerWidth - box.offsetWidth - 8, b.right - box.offsetWidth)) + 'px';
  activateTrap(box, { onClose: () => hideInbox(true) });
}
function hideInbox(restore = true) {
  if (!EL.inbox.classList.contains('show')) return;
  EL.inbox.classList.remove('show');
  EL.inboxBtn.setAttribute('aria-expanded', 'false');
  releaseTrap(EL.inbox, restore);
}
EL.inboxBtn.onclick = (e) => { e.stopPropagation(); EL.inbox.classList.contains('show') ? hideInbox(true) : openInbox(); };
EL.inbox.addEventListener('click', (e) => {
  e.stopPropagation();
  const g = e.target.closest('[data-ibgo]'); if (g) { inboxItems[+g.dataset.ibgo]?.go(); return; }
  const x = e.target.closest('[data-ibx]'); if (x) { const it = inboxItems[+x.dataset.ibx]; if (it) { dismissed.add(it.id); ls.set('dismissed', [...dismissed].slice(-300)); renderInbox(); } }
});

// ================= Yardim ve ilk acilis turu =================
const TOUR = [
  { sel: '#accounts', side: 'right' },
  { sel: '#mgrCard', side: 'right' },
  { sel: '#folderBtn', side: 'bottom' },
  { sel: '.composer', side: 'top' },
  { sel: '#inboxBtn', side: 'bottom' },
  { sel: '.tb-nav', side: 'bottom' },
]; // metinler: tour.N.t / tour.N.x
let tourI = -1;
function startTour() { closeSheets(); tourI = 0; const el = $('#tour'); el.classList.add('show'); activateTrap(el, { onClose: endTour, initialFocus: () => $('#tourNext') }); showTourStep(); }
function endTour() { const el = $('#tour'); if (!el.classList.contains('show')) return; el.classList.remove('show'); tourI = -1; ls.set('tourDone', true); releaseTrap(el, true); }
function showTourStep() {
  let st = TOUR[tourI], el = st && document.querySelector(st.sel);
  while (st && (!el || !el.offsetParent)) { tourI++; st = TOUR[tourI]; el = st && document.querySelector(st.sel); }
  if (!st) return endTour();
  const r = el.getBoundingClientRect(), pad = 6;
  Object.assign($('#tourHole').style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  $('#tourStep').textContent = `${tourI + 1} / ${TOUR.length}`;
  const n = TOUR.indexOf(st) + 1;
  $('#tourTitle').textContent = L(`tour.${n}.t`); $('#tourText').textContent = L(`tour.${n}.x`);
  $('#tourPrev').style.visibility = tourI ? 'visible' : 'hidden';
  $('#tourNext').textContent = L(tourI === TOUR.length - 1 ? 'tour.finish' : 'tour.next');
  const c = $('#tourCard'), cw = c.offsetWidth, ch = c.offsetHeight;
  let x, y;
  if (st.side === 'right') { x = r.right + 16; y = r.top; }
  else if (st.side === 'top') { x = r.left + r.width / 2 - cw / 2; y = r.top - ch - 16; }
  else { x = r.right - cw; y = r.bottom + 16; }
  c.style.left = Math.max(12, Math.min(innerWidth - cw - 12, x)) + 'px';
  c.style.top = Math.max(12, Math.min(innerHeight - ch - 12, y)) + 'px';
  $('#tourNext').focus();
}
$('#tourNext').onclick = () => { tourI++; tourI >= TOUR.length ? endTour() : showTourStep(); };
$('#tourPrev').onclick = () => { if (tourI > 0) { tourI--; showTourStep(); } };
$('#tourSkip').onclick = endTour;
addEventListener('resize', () => { if (tourI >= 0) showTourStep(); });
$('#helpBtn').onclick = () => openSheet('#helpSheet');
$('#helpTour').onclick = () => { closeSheet('#helpSheet', true); startTour(); };

// ================= Istatistik =================
let statDays = 7, statProj = '', statData = null, statTable = false, statAt = 0;
const fmtMs = (ms) => { if (ms == null) return '—'; const s = Math.round(ms / 1000); if (s < 60) return L('u.sec', { n: s }); const m = Math.floor(s / 60); if (m < 60) return L('u.msec', { m, s: s % 60 }); return L('u.hm', { h: Math.floor(m / 60), m: m % 60 }); };
const fmtAgo = (t) => { if (!t) return '—'; const m = Math.round((Date.now() - t) / 60000); if (m < 1) return L('ago.now'); if (m < 60) return L('ago.m', { n: m }); const h = Math.round(m / 60); if (h < 24) return L('ago.h', { n: h }); return L('ago.d', { n: Math.round(h / 24) }); };
const fmtDay = (d, long) => { const [y, mo, da] = d.split('-').map(Number); return new Date(y, mo - 1, da).toLocaleDateString(loc(), long ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' }); };
const niceStep = (x) => { if (x <= 1) return 1; const p = Math.pow(10, Math.floor(Math.log10(x))); const n = x / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
async function openStats() { openSheet(EL.statSheet); await loadStats(); }
async function loadStats() {
  setHTML($('#statProj'), `<option value="">${L('stat.allProj')}</option>` + S.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === statProj ? 'selected' : ''}>${esc(p.name)}</option>`).join(''));
  EL.statRangeBtns.forEach((b) => b.classList.toggle('on', +b.dataset.v === statDays));
  $('#statBody').classList.add('loading'); // eski cizim soluk kalir, ekran ziplamaz
  try { statData = await api('GET', `/api/stats?days=${statDays}&project=${encodeURIComponent(statProj)}`); statAt = Date.now(); renderStats(); }
  catch (e) { toast(e.message, 'bad'); } finally { $('#statBody').classList.remove('loading'); }
}
function statChart(daily) {
  const max = Math.max(1, ...daily.map((x) => x.done + x.fail + x.open));
  const step = niceStep(max / 4), top = step * 4;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const n = daily.length, every = n <= 10 ? 1 : n <= 31 ? 5 : 10;
  const peak = daily.reduce((b, x, i) => (x.done + x.fail + x.open > daily[b].done + daily[b].fail + daily[b].open ? i : b), 0);
  const anyOpen = daily.some((x) => x.open);
  const cols = daily.map((x, i) => {
    const tot = x.done + x.fail + x.open;
    const seg = (v, c) => (v ? `<i class="${c}" style="flex:${v}"></i>` : '');
    return `<div class="vz-slot"><button class="vz-col" data-i="${i}" aria-label="${esc(L('stat.colAria', { day: fmtDay(x.d, true), d: x.done, f: x.fail, o: x.open ? L('stat.colOpen', { n: x.open }) : '' }))}">
      ${tot ? `<span class="vz-stack" style="height:${(tot / top) * 100}%">${i === peak ? `<b class="vz-val">${tot}</b>` : ''}${seg(x.open, 'o')}${seg(x.fail, 'f')}${seg(x.done, 'd')}</span>` : ''}</button></div>`;
  }).join('');
  const xl = daily.map((x, i) => `<span>${i % every === 0 || i === n - 1 ? esc(fmtDay(x.d)) : ''}</span>`).join('');
  return `<div class="vz">
    <div class="vz-legend"><span><i class="d"></i>${L('stat.legDone')}</span><span><i class="f"></i>${L('stat.legFail')}</span>${anyOpen ? `<span><i class="o"></i>${L('stat.legOpen')}</span>` : ''}</div>
    <div class="vz-area">
      <div class="vz-y">${ticks.slice().reverse().map((t) => `<span>${t}</span>`).join('')}</div>
      <div class="vz-plot">${ticks.map((t) => `<i class="vz-grid" style="bottom:${(t / top) * 100}%"></i>`).join('')}<div class="vz-cols">${cols}</div></div>
    </div>
    <div class="vz-x">${xl}</div>
  </div>`;
}
function statDailyTable(daily) {
  return `<table class="st-table"><thead><tr><th>${L('stat.th.day')}</th><th class="n">${L('stat.legDone')}</th><th class="n">${L('stat.legFail')}</th><th class="n">${L('stat.legOpen')}</th></tr></thead><tbody>${daily.slice().reverse().map((x) => `<tr><td>${esc(fmtDay(x.d, true))}</td><td class="n">${x.done}</td><td class="n">${x.fail}</td><td class="n">${x.open}</td></tr>`).join('')}</tbody></table>`;
}
function renderStats() {
  const d = statData; if (!d) return;
  hideTip(); // yeniden cizimde eski ipucu ekranda kalmasin
  const t = d.totals;
  const kpi = [
    [String(t.runs), L('stat.k.jobs'), L('stat.k.jobsSub', { f: t.finished, q: t.questions })],
    [t.success == null ? '—' : `%${t.success}`, L('stat.k.succ'), L('stat.k.succSub')],
    [fmtMs(t.avgMs), L('stat.k.avg'), L('stat.k.avgSub')],
    [String(t.tasks), L('stat.k.tasks'), L('stat.k.tasksSub', { m: t.merged })],
    [String(t.races), L('stat.k.races'), L('stat.k.racesSub')],
  ];
  const kpiHtml = `<div class="hero-stats st-kpi">${kpi.map(([v, l, s]) => `<div class="hs"><b>${esc(v)}</b><span>${esc(l)}</span><small>${esc(s)}</small></div>`).join('')}</div>`;
  if (!t.runs && !d.accounts.some((a) => a.weekMin)) {
    $('#statBody').innerHTML = kpiHtml + `<div class="st-empty">${L('stat.empty')}</div>`;
    return;
  }
  const hl = d.highlights.map((h) => `<li class="${h.k}">${esc(h.a ? L('hl.' + h.k, { ...h.a, dur: h.k === 'fast' ? fmtDur(h.ms) : '' }) : h.text)}</li>`).join('');
  const maxTasks = Math.max(1, ...d.accounts.map((a) => a.tasks));
  const limCell = (p) => (p == null ? '<span class="mut">—</span>' : `<span class="st-lim"><span class="bar"><i class="${p >= 90 ? 'hot' : p >= 70 ? 'warn' : ''}" style="width:${Math.max(2, Math.min(100, p))}%"></i></span>%${Math.round(p)}</span>`);
  const accRows = d.accounts.map((a) => {
    const acc = acct(a.id) || a;
    return `<tr><td><span class="st-who">${avatar(acc)}<span><b>${esc(a.name)}</b><small>${esc(TYPE[a.type] || a.type)}${a.id === S.settings.managerId ? L('stat.isMgr') : ''}</small></span></span></td>
      <td class="n"><span class="st-bar"><i style="width:${(a.tasks / maxTasks) * 100}%"></i></span>${a.tasks}</td>
      <td class="n">${a.success == null ? '<span class="mut">—</span>' : `%${a.success}`}</td>
      <td class="n">${fmtMs(a.avgMs)}</td>
      <td class="n">${a.managed || '<span class="mut">0</span>'}</td>
      <td class="n">${a.raceRuns ? `${a.raceWins}/${a.raceRuns}` : '<span class="mut">—</span>'}</td>
      <td class="n">${L('stat.min', { n: a.weekMin })}<small>${L('stat.calls', { n: a.weekCalls })}${a.weekLimitHits ? L('stat.limHits', { n: a.weekLimitHits }) : ''}</small></td>
      <td class="n">${limCell(a.limitWeek)}</td></tr>`;
  }).join('');
  const projRows = d.projects.map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${p.runs}</td><td class="n">${p.success == null ? '—' : `%${p.success}`}</td><td class="n">${esc(fmtAgo(p.last))}</td></tr>`).join('');
  $('#statBody').innerHTML = `${kpiHtml}
    ${hl ? `<ul class="st-hl">${hl}</ul>` : ''}
    <section class="st-sec"><div class="st-h"><h4>${L('stat.daily')}</h4><button class="linkbtn" id="statTableBtn">${L(statTable ? 'stat.asChart' : 'stat.asTable')}</button></div>
      ${statTable ? statDailyTable(d.daily) : statChart(d.daily)}</section>
    <section class="st-sec"><div class="st-h"><h4>${L('stat.accts')}</h4><span class="hint" style="margin:0">${L('stat.acctsHint')}</span></div>
      <div class="st-scroll"><table class="st-table"><thead><tr><th>${L('stat.th.acct')}</th><th class="n">${L('stat.th.tasks')}</th><th class="n">${L('stat.th.succ')}</th><th class="n">${L('stat.th.avg')}</th><th class="n">${L('stat.th.mgd')}</th><th class="n">${L('stat.th.race')}</th><th class="n">${L('stat.th.week')}</th><th class="n">${L('stat.th.wlim')}</th></tr></thead><tbody>${accRows}</tbody></table></div></section>
    ${projRows && !statProj ? `<section class="st-sec"><div class="st-h"><h4>${L('stat.projs')}</h4></div><table class="st-table"><thead><tr><th>${L('stat.th.proj')}</th><th class="n">${L('stat.th.jobs')}</th><th class="n">${L('stat.th.succ')}</th><th class="n">${L('stat.th.last')}</th></tr></thead><tbody>${projRows}</tbody></table></section>` : ''}`;
  const tb = $('#statTableBtn'); if (tb) tb.onclick = () => { statTable = !statTable; renderStats(); };
}
// Gunluk grafik: her sutun kendi ipucunu tasir (fare ve klavye)
function showTip(col) {
  const x = statData?.daily?.[+col.dataset.i]; if (!x) return;
  const tip = $('#vzTip'); tip.textContent = '';
  const h = document.createElement('div'); h.className = 'tt-h'; h.textContent = fmtDay(x.d, true); tip.append(h);
  [['d', x.done, L('stat.tipDone')], ['f', x.fail, L('stat.tipFail')], ...(x.open ? [['o', x.open, L('stat.tipOpen')]] : [])].forEach(([c, v, l]) => {
    const r = document.createElement('div'); r.className = 'tt-r';
    const k = document.createElement('i'); k.className = c; const b = document.createElement('b'); b.textContent = v; const s = document.createElement('span'); s.textContent = l;
    r.append(k, b, s); tip.append(r);
  });
  const rc = col.getBoundingClientRect(); tip.classList.add('show');
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(innerWidth - tw - 8, rc.left + rc.width / 2 - tw / 2)) + 'px';
  tip.style.top = Math.max(8, rc.top - th - 8) + 'px';
}
function hideTip() { EL.vzTip.classList.remove('show'); }
$('#statBody').addEventListener('pointerover', (e) => { const c = e.target.closest('.vz-col'); if (c) showTip(c); });
$('#statBody').addEventListener('pointerout', (e) => { if (e.target.closest('.vz-col') && !e.relatedTarget?.closest?.('.vz-col')) hideTip(); });
$('#statBody').addEventListener('focusin', (e) => { const c = e.target.closest('.vz-col'); if (c) showTip(c); });
$('#statBody').addEventListener('focusout', hideTip);
$('#statBody').addEventListener('scroll', hideTip, true);
$('#statRange').onclick = (e) => { const v = e.target.closest('button')?.dataset.v; if (v != null) { statDays = +v; loadStats(); } };
$('#statProj').onchange = () => { statProj = $('#statProj').value; loadStats(); };
$('#statBtn').onclick = openStats;

I18N.applyStatic(); applyThemeLabels(); renderLangSeg();
api('GET', '/api/doctor').then((d) => { DOC = d; renderSide(); renderAttention(); }).catch(() => {});
autosize();
function greeting() {
  const h = new Date().getHours();
  const g = L(h < 5 ? 'greet.night' : h < 12 ? 'greet.morning' : h < 18 ? 'greet.day' : h < 23 ? 'greet.eve' : 'greet.night');
  const ready = S.accounts.filter((a) => !needsLogin(a) && !a.stats?.limited).length;
  return `${g} · ${ready ? L('greet.ready', { n: ready }) : L('greet.notReady')}`;
}
load(true).then(() => {
  loadDraft(); connect();
  if (!ls.get('tourDone', false)) setTimeout(startTour, 700); // ilk acilista kisa tanitim
}).catch((e) => toast(L('loadFail', { msg: e.message }), 'bad'));
