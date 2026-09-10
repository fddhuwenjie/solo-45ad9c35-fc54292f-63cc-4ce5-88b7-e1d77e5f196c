/* 无障碍影视解说编排 —— 前端逻辑（原生 JS） */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  project: null,
  subtitles: [],
  cards: [],
  history: [],
  versions: [],
  selectedId: null,
  pps: 40,            // 每秒像素
  duration: 0,
  gaps: [],
  play: { playing: false, mediaT: 0, wallT: 0, speed: 1 },
  subLanes: [],
  cardLanes: [],
};

/* ---------------- API ---------------- */
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 204) return {};
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || ('请求失败 (' + resp.status + ')'));
  return data;
}

/* ---------------- 工具 ---------------- */
function fmtTime(t, withMs = true) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const base = (h > 0 ? String(h).padStart(2, '0') + ':' : '') +
               String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return withMs ? base + '.' + String(ms).padStart(3, '0') : base;
}

/* 支持 "秒" / "分:秒" / "时:分:秒,毫秒" */
function parseTime(str) {
  str = str.trim().replace(',', '.');
  if (str === '') return NaN;
  if (/^[-+]?\d*\.?\d+$/.test(str)) return parseFloat(str);
  const parts = str.split(':');
  if (parts.length < 2 || parts.length > 3) return NaN;
  let mult = parts.length === 3 ? 3600 : 60;
  let t = 0;
  for (const p of parts) {
    if (!/^\d*\.?\d+$/.test(p)) return NaN;
    t += parseFloat(p) * mult;
    mult /= 60;
  }
  return t;
}

const CJK_RE = /[一-鿿㐀-䶿぀-ヿ]/g;
const WORD_RE = /[A-Za-z0-9’']+/g;
function countUnits(text) {
  const cjk = (text.match(CJK_RE) || []).length;
  const words = (text.replace(CJK_RE, ' ').match(WORD_RE) || []).length;
  return { cjk, words, total: cjk + words };
}
function estSeconds(text) {
  if (!state.project) return 0;
  return countUnits(text).total * 60 / state.project.speech_rate;
}
function fmtDur(t) {
  return t.toFixed(1) + 's';
}

function toast(msg, bad) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ---------------- 派生数据 ---------------- */
function mergeIntervals(list) {
  const iv = list.map(x => [x.start, x.end]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) {
    if (out.length && s <= out[out.length - 1][1] + 1e-6) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    } else out.push([s, e]);
  }
  return out;
}

function computeGaps() {
  const minGap = state.project ? state.project.min_gap : 1;
  const merged = mergeIntervals(state.subtitles);
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s - cursor >= minGap - 1e-9) gaps.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  state.gaps = gaps;
  state.mergedSpeech = merged;
  const maxEnd = Math.max(
    cursor,
    ...state.cards.map(c => c.end),
    ...state.subtitles.map(s => s.end), 0);
  state.duration = maxEnd + 3;
}

/* 自由区间（对白之外，含片头片尾） */
function freeRegions() {
  const out = [];
  let cursor = 0;
  for (const [s, e] of state.mergedSpeech) {
    if (s > cursor) out.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  out.push([cursor, Math.max(cursor + 1, state.duration)]);
  return out;
}

/* 包含某时刻的可插入窗口 */
function windowAt(t) {
  for (const [s, e] of freeRegions()) {
    if (t >= s - 1e-6 && t <= e + 1e-6) return { start: s, end: e };
  }
  // 落在对白中：找之后最近的空档
  for (const [s, e] of freeRegions()) {
    if (s >= t - 1e-6) return { start: s, end: e };
  }
  return null;
}

function assignLanes(items) {
  const lanes = [];
  const placed = items.map(() => null);
  items.map((it, i) => ({ it, i }))
       .sort((a, b) => a.it.start - b.it.start)
       .forEach(({ it, i }) => {
         let lane = lanes.findIndex(end => end + 0.03 <= it.start);
         if (lane === -1) { lane = lanes.length; lanes.push(it.end); }
         else lanes[lane] = it.end;
         placed[i] = lane;
       });
  return { map: placed, count: lanes.length };
}

/* 冲突分析 */
function analyzeCard(card) {
  const issues = [];
  let severity = 'ok';
  let shortenSec = 0;

  // 1) 与对白重叠
  const subHits = state.subtitles.filter(s => card.start < s.end - 0.005 && card.end > s.start + 0.005);
  if (subHits.length) {
    severity = 'bad';
    const text = subHits.slice(0, 2).map(s => '「' + (s.text || '').slice(0, 14) + '」').join('、');
    issues.push({ type: 'sub', text: '与对白重叠：' + text + (subHits.length > 2 ? ' 等' : '') });
  }

  // 2) 与其他解说重叠
  const cardHits = state.cards.filter(
    o => o.id !== card.id && card.start < o.end - 0.005 && card.end > o.start + 0.005);
  if (cardHits.length) {
    severity = 'bad';
    issues.push({ type: 'card', text: '与另外 ' + cardHits.length + ' 段解说重叠' });
  }

  // 3) 超出静默窗口
  const win = windowAt(card.start);
  const duration = card.end - card.start;
  let margin = null;
  if (win) {
    const overLeft = Math.max(0, win.start - card.start);
    const overRight = Math.max(0, card.end - win.end);
    const winLen = win.end - win.start;
    if (overLeft > 0.01 || overRight > 0.01) {
      severity = 'bad';
      shortenSec = Math.max(shortenSec, overLeft + overRight, duration - winLen);
      const parts = [];
      if (overLeft > 0.01) parts.push('进入左侧对白 ' + overLeft.toFixed(2) + 's');
      if (overRight > 0.01) parts.push('超出窗口右端 ' + overRight.toFixed(2) + 's');
      issues.push({ type: 'overflow', text: parts.join('；') + `（窗口 ${winLen.toFixed(1)}s）` });
    } else {
      margin = winLen - duration;
      const est = estSeconds(card.text);
      if (est > winLen + 0.02 && card.duration_mode === 'auto') {
        severity = 'bad';
        shortenSec = est - winLen;
        issues.push({ type: 'overflow',
          text: `预估朗读 ${est.toFixed(1)}s 超过窗口容量 ${winLen.toFixed(1)}s` });
        margin = null;
      } else if (margin < 0.15) {
        if (severity !== 'bad') severity = 'warn';
        issues.push({ type: 'tight', text: '时间余量不足 0.15s，建议略作缩短或前移' });
      }
    }
  }

  // 4) 朗读时长与区间不匹配提示
  const est = estSeconds(card.text);
  if (card.text.trim() && severity !== 'bad') {
    if (est > duration + 0.15) {
      severity = 'warn';
      issues.push({ type: 'toolong', text:
        `按语速需 ${est.toFixed(1)}s，当前区间 ${duration.toFixed(1)}s，可能念不完` });
    } else if (est < duration - 1.5) {
      issues.push({ type: 'tooshort', text:
        `区间比朗读预估长 ${(duration - est).toFixed(1)}s，可能出现冷场` });
    }
  }

  return {
    severity, issues, win, duration, est, margin,
    shortenUnits: Math.max(1, Math.ceil(shortenSec * state.project.speech_rate / 60)),
  };
}

/* 截断文本以适应窗口秒数 */
function trimTextToFit(text, fitSec) {
  const maxUnits = Math.max(0, Math.floor((fitSec - 0.05) * state.project.speech_rate / 60));
  const tokens = [];
  const re = /[一-鿿㐀-䶿぀-ヿ]|[A-Za-z0-9’']+|\s+|[^一-鿿㐀-䶿぀-ヿA-Za-z0-9’'\s]/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[0]);
  let units = countUnits(text).total;
  while (units > maxUnits && tokens.length) {
    const tok = tokens.pop();
    if (/[一-鿿㐀-䶿぀-ヿ]/.test(tok) || /[A-Za-z0-9’']+/.test(tok)) units -= 1;
  }
  return tokens.join('').trimEnd();
}

/* ---------------- 渲染：时间轴 ---------------- */
const TRACK_BASE_H = { sub: 64, gap: 40, card: 84 };

function renderTimeline() {
  computeGaps();

  // 泳道
  const subLanes = assignLanes(state.subtitles);
  const cardLanes = assignLanes(state.cards);
  state.subLanes = subLanes.map;
  state.cardLanes = cardLanes.map;

  const subRow = $('#subTrack').parentNode;
  const cardRow = $('#cardTrack').parentNode;
  subRow.style.height = Math.max(TRACK_BASE_H.sub, subLanes.count * 27 + 16) + 'px';
  cardRow.style.height = Math.max(TRACK_BASE_H.card, cardLanes.count * 30 + 18) + 'px';

  const widthPx = Math.max(400, Math.ceil(state.duration * state.pps) + 40);
  $('#ruler').style.width = widthPx + 'px';
  $$('.track').forEach(t => t.style.width = widthPx + 'px');

  renderRuler(widthPx);
  renderSubs();
  renderGaps();
  renderCards();
  $('#timelineEmpty').classList.toggle('hidden', state.subtitles.length > 0);
  updatePlayheadVisual();
  renderStats();
}

function renderRuler(widthPx) {
  const ruler = $('#ruler');
  ruler.innerHTML = '';
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const step = steps.find(s => s * state.pps >= 90) || 3600;
  for (let t = 0; t <= state.duration + 1; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tick' + (t % (step * 5) === 0 ? ' major' : '');
    tick.style.left = (t * state.pps) + 'px';
    const span = document.createElement('span');
    span.textContent = fmtTime(t, false);
    tick.appendChild(span);
    ruler.appendChild(tick);
  }
}

function renderSubs() {
  const track = $('#subTrack');
  track.innerHTML = '';
  state.subtitles.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'seg';
    el.dataset.id = s.id;
    el.style.left = (s.start * state.pps) + 'px';
    el.style.width = Math.max(3, (s.end - s.start) * state.pps - 2) + 'px';
    el.style.top = (state.subLanes[i] * 27 + 7) + 'px';
    el.style.bottom = 'auto';
    el.title = `${fmtTime(s.start)} → ${fmtTime(s.end)}\n${s.text}`;
    el.textContent = s.text;
    track.appendChild(el);
  });
}

function renderGaps() {
  const track = $('#gapTrack');
  track.innerHTML = '';
  state.gaps.forEach((g, i) => {
    const len = g.end - g.start;
    if (len * state.pps < 8) return; // 太窄不画
    const el = document.createElement('div');
    el.className = 'gap-seg';
    el.dataset.idx = i;
    el.style.left = (g.start * state.pps) + 'px';
    el.style.width = (len * state.pps) + 'px';
    el.title = `可插入空档 ${fmtTime(g.start)} → ${fmtTime(g.end)}（${len.toFixed(1)}s），点击新增解说`;
    const label = len * state.pps >= 64
      ? `<span class="gap-plus">＋</span>${len.toFixed(1)}s`
      : '<span class="gap-plus">＋</span>';
    el.innerHTML = label;
    el.addEventListener('click', () => createCardInGap(i));
    track.appendChild(el);
  });
}

/* ---------------- 渲染：列表 / 编辑器 / 统计 ---------------- */
function renderCardList() {
  const ul = $('#cardList');
  ul.innerHTML = '';
  state.cards.forEach((c, i) => {
    const a = analyzeCard(c);
    const li = document.createElement('li');
    li.dataset.id = c.id;
    if (c.id === state.selectedId) li.classList.add('selected');
    let badge = '';
    if (a.issues.some(x => x.type === 'sub' || x.type === 'card' || x.type === 'overflow'))
      badge = '<span class="badge over">冲突</span>';
    else if (a.severity === 'warn')
      badge = '<span class="badge overlap">注意</span>';
    else if (c.text.trim())
      badge = '<span class="badge ok">正常</span>';
    li.innerHTML =
      `<div class="cli-top"><span class="cli-time">${fmtTime(c.start, false)} – ${fmtTime(c.end, false)}</span>
         <span>${(c.end - c.start).toFixed(1)}s${c.locked ? ' 🔒' : ''}${badge}</span></div>
       <div class="cli-text ${c.text.trim() ? '' : 'empty'}"></div>`;
    li.querySelector('.cli-text').textContent = c.text.trim() || '（空解说，点击编辑）';
    li.addEventListener('click', () => selectCard(c.id));
    ul.appendChild(li);
  });
}

function renderStats() {
  let bad = 0, warn = 0, totalNar = 0;
  for (const c of state.cards) {
    const a = analyzeCard(c);
    if (a.severity === 'bad') bad++;
    else if (a.severity === 'warn') warn++;
    totalNar += c.end - c.start;
  }
  $('#globalStats').innerHTML =
    `<span>对白 <b>${state.subtitles.length}</b></span>
     <span>空档 <b>${state.gaps.length}</b></span>
     <span>解说 <b>${state.cards.length}</b></span>
     <span>解说总时长 <b>${totalNar.toFixed(1)}s</b></span>
     <span class="${bad ? 's-bad' : warn ? 's-warn' : 's-ok'}">冲突/注意 <b>${bad}/${warn}</b></span>`;
}

let editorSaveTimer = null;
function renderEditor() {
  const c = state.cards.find(x => x.id === state.selectedId);
  $('#editorEmpty').classList.toggle('hidden', !!c);
  $('#editorBody').classList.toggle('hidden', !c);
  if (!c) return;
  $('#editorTitle').textContent = '解说卡片 · ' + fmtTime(c.start);
  $('#lockBtn').textContent = c.locked ? '🔒 已锁定' : '🔓 未锁定';
  const ta = $('#cardText');
  if (ta.value !== c.text) ta.value = c.text;
  ta.disabled = c.locked;
  $('#startInput').value = fmtTime(c.start);
  $('#endInput').value = fmtTime(c.end);
  $('#durInput').value = (c.end - c.start).toFixed(2);
  $$('input[name="durMode"]').forEach(r => r.checked = r.value === c.duration_mode);
  $$('input[name="durMode"],#startInput,#endInput,#durInput').forEach(el => el.disabled = c.locked);
  $('#autoFitBtn').disabled = c.locked;
  $('#deleteCardBtn').classList.toggle('disabled', false);

  const u = countUnits(c.text);
  const est = estSeconds(c.text);
  $('#estimateInfo').textContent =
    `汉字 ${u.cjk} · 英文词 ${u.words} · 按 ${state.project.speech_rate} 单位/分估算朗读 ${est.toFixed(1)}s · 区间 ${(c.end - c.start).toFixed(1)}s`;
  renderConflictBox(c);
}

function renderConflictBox(c) {
  const box = $('#conflictBox');
  const a = analyzeCard(c);
  box.classList.remove('ok', 'bad', 'warn');
  if (!a.issues.length) {
    box.classList.add('ok');
    const marginTxt = a.margin !== null && isFinite(a.margin)
      ? `窗口剩余余量 <b>${Math.max(0, a.margin).toFixed(2)}s</b>` : '';
    box.innerHTML = `✅ 无冲突。${marginTxt}`;
    return;
  }
  box.classList.add(a.severity);
  const head = a.severity === 'bad' ? '⚠ 存在冲突' : '提示';
  let html = `<b>${head}</b><ul>` + a.issues.map(i => `<li>${i.text}</li>`).join('') + '</ul>';
  if (a.shortenUnits > 0 && a.issues.some(i => i.type === 'overflow')) {
    const winLen = a.win ? (a.win.end - a.win.start) : 0;
    html += `建议缩短约 <b>${a.shortenUnits}</b> 个朗读单位（汉字或英文词），或移到更宽的空档。`;
    if (!c.locked && c.text.trim()) {
      html += ` <button class="btn sm trim-btn" data-fit="${winLen.toFixed(3)}">一键缩短文本</button>`;
    }
  }
  box.innerHTML = html;
  const trimBtn = box.querySelector('.trim-btn');
  if (trimBtn) trimBtn.addEventListener('click', async () => {
    const fit = parseFloat(trimBtn.dataset.fit);
    const newText = trimTextToFit(c.text, fit);
    if (newText === c.text) return toast('文本已经无法再缩短', true);
    await persistCard(c.id, { text: newText, _label: '缩短解说文本' });
    // 自动模式下重新贴合窗口
    const updated = state.cards.find(x => x.id === c.id);
    if (updated) {
      const est = estSeconds(newText);
      await persistCard(c.id, { end: +(updated.start + Math.min(est, fit)).toFixed(3) });
    }
    toast('已缩短文本并重新估算时长');
  });
}

function renderAll() {
  renderTimeline();
  renderCardList();
  renderEditor();
  renderUndoState();
}

function renderUndoState() {
  $('#undoBtn').disabled = state.history.length === 0;
  $('#versionsBtn').disabled = false;
  $('#exportNarrBtn').disabled = state.cards.length === 0;
  $('#exportMergedBtn').disabled = state.subtitles.length === 0;
}

/* ---------------- 播放 ---------------- */
function tickPlay() {
  if (!state.play.playing) return;
  const now = performance.now();
  let t = state.play.mediaT + (now - state.play.wallT) / 1000 * state.play.speed;
  if (t >= state.duration) { t = state.duration; pausePlay(); }
  state.play.mediaT = t;
  state.play.wallT = now;
  updatePlayheadVisual();
  requestAnimationFrame(tickPlay);
}
function updatePlayheadVisual() {
  const t = state.play.mediaT;
  $('#playhead').style.left = (t * state.pps) + 'px';
  $('#timeReadout').textContent = fmtTime(t, false) + ' / ' + fmtTime(state.duration, false);
  // 当前高亮
  const subId = (state.subtitles.find(s => t >= s.start && t < s.end) || {}).id;
  $$('#subTrack .seg').forEach(el => el.classList.toggle('active', +el.dataset.id === subId));
  const cardId = (state.cards.find(c => t >= c.start && t < c.end) || {}).id;
  $$('#cardTrack .card').forEach(el => el.classList.toggle('active', +el.dataset.id === cardId));
}
function play() {
  if (state.play.mediaT >= state.duration - 0.05) state.play.mediaT = 0;
  state.play.playing = true;
  state.play.wallT = performance.now();
  $('#playBtn').textContent = '⏸';
  requestAnimationFrame(tickPlay);
}
function pausePlay() {
  state.play.playing = false;
  $('#playBtn').textContent = '▶';
}
function seek(t) {
  state.play.mediaT = Math.max(0, Math.min(state.duration, t));
  state.play.wallT = performance.now();
  updatePlayheadVisual();
}

/* ---------------- 卡片操作 ---------------- */
async function loadState(newState) {
  state.project = newState.project;
  state.subtitles = newState.subtitles;
  state.cards = newState.cards;
  state.history = newState.history;
  state.versions = newState.versions;
  if (!state.cards.some(c => c.id === state.selectedId)) state.selectedId = null;
  $('#minGapInput').value = state.project.min_gap;
  $('#speechRateInput').value = state.project.speech_rate;
  renderAll();
}

async function selectCard(id) {
  state.selectedId = id;
  pausePlay();
  const c = state.cards.find(x => x.id === id);
  if (c) seek(c.start);
  renderCardList();
  renderCards();
  renderEditor();
}

function cardConflictClass(card) {
  const a = analyzeCard(card);
  if (a.severity !== 'bad') return '';
  return a.issues.some(x => x.type === 'sub' || x.type === 'card')
    ? 'conflict-overlap' : 'conflict-overflow';
}

function renderCards() {
  const track = $('#cardTrack');
  const cardLanes = assignLanes(state.cards);
  state.cardLanes = cardLanes.map;
  const cardRow = $('#cardTrack').parentNode;
  cardRow.style.height = Math.max(TRACK_BASE_H.card, cardLanes.count * 30 + 18) + 'px';
  track.innerHTML = '';
  state.cards.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = c.id;
    if (c.locked) el.classList.add('locked');
    if (c.id === state.selectedId) el.classList.add('selected');
    const cc = cardConflictClass(c);
    if (cc) el.classList.add(cc);
    el.style.left = (c.start * state.pps) + 'px';
    el.style.width = Math.max(4, (c.end - c.start) * state.pps) + 'px';
    el.style.top = (state.cardLanes[i] * 30 + 6) + 'px';
    el.style.bottom = 'auto';
    const dur = c.end - c.start;
    el.innerHTML =
      `<div class="card-label"><span>#${i + 1}</span><span>${dur.toFixed(1)}s${c.duration_mode === 'manual' ? ' ✋' : ''}</span></div>
       <div class="card-text"></div>
       <div class="handle l"></div><div class="handle r"></div>`;
    el.querySelector('.card-text').textContent = c.text || '（空解说）';
    el.title = c.text;
    track.appendChild(el);
  });
}

async function createCardInGap(gapIdx) {
  const g = state.gaps[gapIdx];
  if (!g) return;
  const len = g.end - g.start;
  const start = +g.start.toFixed(3);
  const end = +(g.start + Math.min(len, 3)).toFixed(3);
  try {
    const card = await api('POST', `/api/projects/${state.project.id}/cards`,
      { start, end, text: '', duration_mode: 'auto' });
    await refreshState();
    selectCard(card.id);
  } catch (e) { toast(e.message, true); }
}

async function addCardManual() {
  const t = state.play.mediaT || 0;
  const win = windowAt(t) || { start: 0, end: t + 3 };
  const start = +win.start.toFixed(3);
  const end = +Math.min(win.end, start + 3).toFixed(3);
  try {
    const card = await api('POST', `/api/projects/${state.project.id}/cards`,
      { start, end, text: '', duration_mode: 'auto' });
    await refreshState();
    selectCard(card.id);
  } catch (e) { toast(e.message, true); }
}

async function persistCard(id, patch) {
  try {
    const updated = await api('PATCH', `/api/projects/${state.project.id}/cards/${id}`, patch);
    const i = state.cards.findIndex(c => c.id === id);
    if (i >= 0) state.cards[i] = updated;
    renderTimeline();
    renderCardList();
    if (state.selectedId === id) renderEditor();
    return updated;
  } catch (e) {
    toast(e.message, true);
    await refreshState();
    return null;
  }
}

async function refreshState() {
  const st = await api('GET', `/api/projects/${state.project.id}`);
  await loadState(st);
}

/* ---------------- 拖拽 / 缩放 ---------------- */
function setupDrag() {
  const track = $('#cardTrack');
  let drag = null;

  track.addEventListener('pointerdown', (ev) => {
    const handle = ev.target.closest('.handle');
    const cardEl = ev.target.closest('.card');
    if (!cardEl) return;
    const id = +cardEl.dataset.id;
    const card = state.cards.find(c => c.id === id);
    if (!card || card.locked) {
      if (card) selectCard(id);
      return;
    }
    ev.preventDefault();
    selectCard(id);
    drag = {
      id,
      mode: handle ? (handle.classList.contains('l') ? 'resize-l' : 'resize-r') : 'move',
      x0: ev.clientX,
      start: card.start, end: card.end,
      moved: false,
    };
    cardEl.setPointerCapture?.(ev.pointerId);
  });

  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const card = state.cards.find(c => c.id === drag.id);
    if (!card) return;
    const dt = (ev.clientX - drag.x0) / state.pps;
    const snap = ev.shiftKey ? 0.01 : 0.1;
    const q = (v) => Math.max(0, Math.round(v / snap) * snap);
    let ns = drag.start, ne = drag.end;
    if (drag.mode === 'move') {
      ns = q(drag.start + dt);
      ne = ns + (drag.end - drag.start);
      if (ne > state.duration + 60) { ne = state.duration + 60; ns = ne - (drag.end - drag.start); }
    } else if (drag.mode === 'resize-l') {
      ns = Math.min(q(drag.start + dt), drag.end - 0.05);
    } else {
      ne = Math.max(q(drag.end + dt), drag.start + 0.05);
    }
    card.start = +ns.toFixed(3);
    card.end = +ne.toFixed(3);
    drag.moved = true;
    // 仅更新该卡片 DOM，避免拖拽中重建
    const el = track.querySelector(`.card[data-id="${card.id}"]`);
    if (el) {
      el.style.left = (card.start * state.pps) + 'px';
      el.style.width = Math.max(4, (card.end - card.start) * state.pps) + 'px';
      el.classList.remove('conflict-overflow', 'conflict-overlap');
      const cc = cardConflictClass(card);
      if (cc) el.classList.add(cc);
      el.querySelector('.card-label span:last-child').textContent =
        (card.end - card.start).toFixed(1) + 's' + (card.duration_mode === 'manual' ? ' ✋' : '');
    }
    // 编辑器时间字段实时跟随
    if (state.selectedId === card.id) {
      $('#startInput').value = fmtTime(card.start);
      $('#endInput').value = fmtTime(card.end);
      $('#durInput').value = (card.end - card.start).toFixed(2);
      renderConflictBox(card);
    }
  });

  window.addEventListener('pointerup', async () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) return;
    const card = state.cards.find(c => c.id === d.id);
    if (!card) return;
    const patch = { start: card.start, end: card.end, _label: '拖拽调整解说' };
    // 直接拖边缘改变了时长 → 转为手动时长，避免被语速估算覆盖
    if (d.mode !== 'move' && card.duration_mode === 'auto') patch.duration_mode = 'manual';
    await persistCard(d.id, patch);
  });
}

/* 点击空白轨道 / 标尺：移动播放头 */
function setupSeek() {
  const wrap = $('#timelineWrap');
  const timeFromEvent = (ev, el) => {
    const rect = el.getBoundingClientRect();
    const x = ev.clientX - rect.left + wrap.scrollLeft - 72;
    return Math.max(0, x / state.pps);
  };
  $('#ruler').addEventListener('click', (ev) => {
    const rect = $('#ruler').getBoundingClientRect();
    seek(Math.max(0, (ev.clientX - rect.left + wrap.scrollLeft) / state.pps));
  });
  $('#subTrack').addEventListener('click', (ev) => {
    if (ev.target.closest('.seg')) return;
    seek(timeFromEvent(ev, $('#subTrack')));
  });
  $('#cardTrack').addEventListener('click', (ev) => {
    if (ev.target.closest('.card')) return;
    seek(timeFromEvent(ev, $('#cardTrack')));
  });
  wrap.addEventListener('wheel', (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const t = state.play.mediaT;
      const opts = [20, 40, 80, 120, 200];
      let i = opts.indexOf(state.pps);
      i = Math.max(0, Math.min(opts.length - 1, i + (ev.deltaY < 0 ? 1 : -1)));
      state.pps = opts[i];
      $('#zoomSelect').value = String(state.pps);
      renderTimeline();
      seek(t);
    }
  }, { passive: false });
}

/* ---------------- 编辑器事件 ---------------- */
function setupEditor() {
  const ta = $('#cardText');
  ta.addEventListener('input', () => {
    const c = state.cards.find(x => x.id === state.selectedId);
    if (!c || c.locked) return;
    c.text = ta.value;
    const est = estSeconds(ta.value);
    $('#estimateInfo').textContent =
      (() => { const u = countUnits(ta.value); return
        `汉字 ${u.cjk} · 英文词 ${u.words} · 按 ${state.project.speech_rate} 单位/分估算朗读 ${est.toFixed(1)}s · 区间 ${(c.end - c.start).toFixed(1)}s`; })();
    renderConflictBox(c);
    clearTimeout(editorSaveTimer);
    editorSaveTimer = setTimeout(async () => {
      const cur = state.cards.find(x => x.id === state.selectedId);
      if (!cur) return;
      const saved = await persistCard(cur.id, { text: ta.value, _label: '编辑解说文本' });
      // 自动模式：区间跟随朗读时长
      if (saved && saved.duration_mode === 'auto' && state.selectedId === cur.id) {
        const card = state.cards.find(x => x.id === cur.id);
        const targetEnd = +(card.start + estSeconds(card.text)).toFixed(3);
        if (Math.abs(targetEnd - card.end) > 0.05) {
          await persistCard(card.id, { end: targetEnd, _label: '编辑解说文本' });
        }
      }
    }, 600);
  });

  const commitTime = async (which) => {
    const c = state.cards.find(x => x.id === state.selectedId);
    if (!c || c.locked) return;
    const s = parseTime($('#startInput').value);
    const e = parseTime($('#endInput').value);
    const d = parseTime($('#durInput').value);
    if ([s, e].some(v => !isFinite(v))) { toast('时间格式应为 秒 / 分:秒 / 时:分:秒.毫秒', true); renderEditor(); return; }
    if (which === 'dur' && isFinite(d) && d > 0) {
      await persistCard(c.id, { start: s, end: +(s + d).toFixed(3), duration_mode: 'manual', _label: '精确调整时间' });
    } else {
      if (e <= s) { toast('结束时间必须晚于开始时间', true); renderEditor(); return; }
      // 用户精确指定区间 → 切到手动时长，避免被语速估算覆盖
      await persistCard(c.id, { start: +s.toFixed(3), end: +e.toFixed(3), duration_mode: 'manual', _label: '精确调整时间' });
    }
    seek((state.cards.find(x => x.id === c.id) || c).start);
  };
  [['#startInput', 'start'], ['#endInput', 'end'], ['#durInput', 'dur']].forEach(([sel, w]) => {
    $(sel).addEventListener('blur', () => commitTime(w));
    $(sel).addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.target.blur(); });
  });

  $$('input[name="durMode"]').forEach(r => r.addEventListener('change', async () => {
    const c = state.cards.find(x => x.id === state.selectedId);
    if (!c) return;
    const mode = $$('input[name="durMode"]').find(x => x.checked).value;
    if (mode === 'auto') {
      const est = estSeconds(c.text);
      await persistCard(c.id, { duration_mode: 'auto', end: +(c.start + est).toFixed(3), _label: '切换时长模式' });
    } else {
      await persistCard(c.id, { duration_mode: 'manual', _label: '切换时长模式' });
    }
  }));

  $('#lockBtn').addEventListener('click', async () => {
    const c = state.cards.find(x => x.id === state.selectedId);
    if (!c) return;
    await persistCard(c.id, { locked: !c.locked, _label: c.locked ? '解锁解说' : '锁定解说' });
  });

  $('#deleteCardBtn').addEventListener('click', async () => {
    const c = state.cards.find(x => x.id === state.selectedId);
    if (!c) return;
    if (!confirm('确定删除这张解说卡片？')) return;
    try {
      await api('DELETE', `/api/projects/${state.project.id}/cards/${c.id}`);
      state.selectedId = null;
      await refreshState();
    } catch (e) { toast(e.message, true); }
  });

  $('#autoFitBtn').addEventListener('click', async () => {
    const c = state.cards.find(x => x.id === state.selectedId);
    if (!c || c.locked) return;
    const est = estSeconds(c.text);
    if (!c.text.trim()) return toast('请先填写解说文本', true);
    await persistCard(c.id, { duration_mode: 'auto', end: +(c.start + est).toFixed(3), _label: '贴合语速' });
  });
}

/* ---------------- 顶栏 / 项目 ---------------- */
async function refreshProjectList(selectId) {
  const projects = await api('GET', '/api/projects');
  const sel = $('#projectSelect');
  sel.innerHTML = '';
  if (!projects.length) {
    sel.innerHTML = '<option value="">（无项目）</option>';
    showWelcome(true);
    return;
  }
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.name}（对白 ${p.sub_count} · 解说 ${p.card_count}）`;
    sel.appendChild(o);
  }
  const id = selectId || (state.project ? state.project.id : projects[0].id);
  sel.value = String(id);
  await openProject(id);
}

async function openProject(id) {
  try {
    const st = await api('GET', `/api/projects/${id}`);
    await loadState(st);
    seek(0);
    showWelcome(false);
  } catch (e) { toast(e.message, true); }
}

function showWelcome(on) {
  $('#welcome').classList.toggle('hidden', !on);
  $('#workspace').classList.toggle('hidden', on);
}

async function createProject(name) {
  const p = await api('POST', '/api/projects', { name: name || '' });
  await refreshProjectList(p.id);
}

function setupTopbar() {
  $('#projectSelect').addEventListener('change', () => {
    if ($('#projectSelect').value) openProject(+$('#projectSelect').value);
  });
  $('#newProjectBtn').addEventListener('click', async () => {
    const name = prompt('新项目名称：', '未命名项目');
    if (name === null) return;
    await createProject(name.trim());
  });
  $('#renameProjectBtn').addEventListener('click', async () => {
    if (!state.project) return;
    const name = prompt('项目名称：', state.project.name);
    if (name === null || !name.trim()) return;
    await api('PATCH', `/api/projects/${state.project.id}`, { name: name.trim() });
    await refreshProjectList(state.project.id);
  });
  $('#deleteProjectBtn').addEventListener('click', async () => {
    if (!state.project) return;
    if (!confirm(`确定删除项目「${state.project.name}」及其所有字幕、解说、版本？此操作不可恢复。`)) return;
    await api('DELETE', `/api/projects/${state.project.id}`);
    state.project = null;
    await refreshProjectList();
  });

  $('#undoBtn').addEventListener('click', async () => {
    if (!state.history.length) return;
    try {
      const st = await api('POST', `/api/projects/${state.project.id}/undo`,
        { history_id: state.history[0].id });
      await loadState(st);
      toast('已撤销上一步');
    } catch (e) { toast(e.message, true); }
  });

  $('#addCardBtn').addEventListener('click', addCardManual);

  $('#exportNarrBtn').addEventListener('click', () => {
    if (state.project) location.href = `/api/projects/${state.project.id}/export?mode=narration`;
  });
  $('#exportMergedBtn').addEventListener('click', () => {
    if (state.project) location.href = `/api/projects/${state.project.id}/export?mode=merged`;
  });

  $('#playBtn').addEventListener('click', () => state.play.playing ? pausePlay() : play());
  $('#toStartBtn').addEventListener('click', () => { pausePlay(); seek(0); });
  $('#rateSelect').addEventListener('change', () => { state.play.speed = parseFloat($('#rateSelect').value); });
  $('#zoomSelect').addEventListener('change', () => {
    const t = state.play.mediaT;
    state.pps = +$('#zoomSelect').value;
    renderTimeline();
    seek(t);
  });

  let settingsTimer = null;
  const saveSettings = () => {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
      try {
        const st = await api('PATCH', `/api/projects/${state.project.id}/settings`, {
          min_gap: parseFloat($('#minGapInput').value) || 0,
          speech_rate: parseFloat($('#speechRateInput').value) || 240,
        });
        await loadState(st);
      } catch (e) { toast(e.message, true); }
    }, 400);
  };
  $('#minGapInput').addEventListener('change', saveSettings);
  $('#speechRateInput').addEventListener('change', saveSettings);

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT') return;
    if (ev.code === 'Space') { ev.preventDefault(); state.play.playing ? pausePlay() : play(); }
  });
}

/* ---------------- 导入 / 示例 ---------------- */
function setupImport() {
  const mask = $('#importMask');
  $('#importBtn').addEventListener('click', () => {
    if (!state.project) return;
    $('#srtFile').value = '';
    $('#srtPaste').value = '';
    $('#appendMode').checked = false;
    $('#importError').textContent = '';
    mask.classList.remove('hidden');
  });
  mask.addEventListener('click', (ev) => { if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.classList.add('hidden'); });
  $('#srtFile').addEventListener('change', () => {
    const f = $('#srtFile').files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { $('#srtPaste').value = reader.result; };
    reader.readAsText(f, 'utf-8');
  });
  $('#doImportBtn').addEventListener('click', async () => {
    const content = $('#srtPaste').value;
    if (!content.trim()) { $('#importError').textContent = '请选择文件或粘贴 SRT 内容'; return; }
    try {
      const res = await api('POST', `/api/projects/${state.project.id}/subtitles/import`, {
        content, mode: $('#appendMode').checked ? 'append' : 'replace',
      });
      mask.classList.add('hidden');
      await loadState(res.state);
      seek(0);
      toast(`成功导入 ${res.imported} 条字幕`);
    } catch (e) { $('#importError').textContent = e.message; }
  });

  $('#sampleBtn').addEventListener('click', () => loadSample(false));
  $('#welcomeSample').addEventListener('click', () => loadSample(true));
  $('#welcomeNew').addEventListener('click', async () => { await createProject('未命名项目'); });
}

async function loadSample(createFirst) {
  const { content } = await api('GET', '/api/sample-srt');
  if (createFirst || !state.project) {
    const p = await api('POST', '/api/projects', { name: '示例片段' });
    await refreshProjectList(p.id);
  }
  $('#srtFile').value = '';
  $('#srtPaste').value = content;
  $('#appendMode').checked = false;
  $('#importError').textContent = '';
  $('#importMask').classList.remove('hidden');
}

/* ---------------- 版本 ---------------- */
function setupVersions() {
  const mask = $('#versionsMask');
  $('#versionsBtn').addEventListener('click', async () => {
    await renderVersionList();
    mask.classList.remove('hidden');
  });
  mask.addEventListener('click', (ev) => { if (ev.target === mask || ev.target.hasAttribute('data-close')) mask.classList.add('hidden'); });
  $('#saveVersionBtn').addEventListener('click', async () => {
    const name = $('#versionName').value.trim();
    await api('POST', `/api/projects/${state.project.id}/versions`, { name });
    $('#versionName').value = '';
    await refreshState();
    await renderVersionList();
    toast('版本已保存');
  });

  async function renderVersionList() {
    const { versions } = await api('GET', `/api/projects/${state.project.id}`);
    state.versions = versions;
    const ul = $('#versionList');
    ul.innerHTML = '';
    if (!versions.length) ul.innerHTML = '<li class="cli-text empty">还没有保存过版本。</li>';
    versions.forEach(v => {
      const li = document.createElement('li');
      const d = new Date(v.created_at);
      li.innerHTML =
        `<div><div class="v-name"></div><div class="v-time">${d.toLocaleString()}</div></div>
         <div class="v-actions">
           <button class="btn sm restore">恢复</button>
           <button class="btn sm danger del">删除</button>
         </div>`;
      li.querySelector('.v-name').textContent = v.name;
      li.querySelector('.restore').addEventListener('click', async () => {
        if (!confirm(`恢复版本「${v.name}」？当前状态会先自动存入撤销历史。`)) return;
        const st = await api('POST', `/api/projects/${state.project.id}/versions/${v.id}/restore`, {});
        mask.classList.add('hidden');
        await loadState(st);
        toast('已恢复版本「' + v.name + '」');
      });
      li.querySelector('.del').addEventListener('click', async () => {
        if (!confirm('删除版本「' + v.name + '」？')) return;
        await api('DELETE', `/api/projects/${state.project.id}/versions/${v.id}`);
        renderVersionList();
      });
      ul.appendChild(li);
    });
  }
}

/* ---------------- 启动 ---------------- */
async function main() {
  setupTopbar();
  setupImport();
  setupVersions();
  setupDrag();
  setupSeek();
  setupEditor();
  await refreshProjectList();
}
main();
