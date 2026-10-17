'use strict';

const STORAGE_KEY = 'oneroom-compare:v1';
const CHECKLIST_URL = 'data/checklist.json';
const FETCH_TIMEOUT_MS = 10000;
const MAX_LISTINGS = 30;
const ANSWERS = ['good', 'okay', 'bad'];
const MAX_MINUTES = 180;
// 번지(12-3), 호수(301호), 도로명 번호(이문로 107)처럼 상세 주소로 보이는 입력
const DETAIL_ADDRESS = /\d+\s*-\s*\d+|\d+\s*(번지|호)|(로|길)\s*\d+/;

const VERDICTS = {
  pass: { label: '통과', rank: 0 },
  hold: { label: '보류', rank: 1 },
  fail: { label: '탈락', rank: 2 },
};

// 금액은 모두 만원 단위
const AMOUNT_FIELDS = {
  deposit: { label: '보증금', obj: '보증금을', top: '보증금은', ex: 500, required: true, max: 100000 },
  rent: { label: '월세', obj: '월세를', top: '월세는', ex: 45, required: true, max: 1000 },
  fee: { label: '관리비', obj: '관리비를', top: '관리비는', ex: 7, required: false, max: 200 },
};

const state = {
  checklist: null,
  listings: [],
  storageOK: true,
  sort: 'score',
};

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatMan(n) {
  if (n >= 10000) {
    const eok = Math.floor(n / 10000);
    const rest = n % 10000;
    return rest ? `${eok}억 ${rest.toLocaleString('ko-KR')}만원` : `${eok}억원`;
  }
  return `${n.toLocaleString('ko-KR')}만원`;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- 저장소 ---------- */

function storageAvailable() {
  try {
    const k = '__oneroom_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

function isValidAmount(v, max) {
  return Number.isInteger(v) && v >= 0 && v <= max;
}

// 저장된 데이터에서 읽은 매물 하나를 검사한다. 맞지 않으면 throw.
function sanitizeListing(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('매물 항목이 객체가 아님');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 30) throw new Error('매물 이름이 비었거나 너무 김');
  const out = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name,
    answers: {},
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
  for (const [key, f] of Object.entries(AMOUNT_FIELDS)) {
    const v = raw[key] ?? 0;
    if (!isValidAmount(v, f.max)) throw new Error(`${f.label} 값이 올바르지 않음`);
    out[key] = v;
  }
  out.place = typeof raw.place === 'string' ? raw.place.trim().slice(0, 20) : '';
  for (const key of ['school', 'station']) {
    const v = raw[key];
    out[key] = Number.isInteger(v) && v >= 0 && v <= MAX_MINUTES ? v : null;
  }
  if (raw.answers && typeof raw.answers === 'object') {
    for (const [itemId, v] of Object.entries(raw.answers)) {
      if (ANSWERS.includes(v)) out.answers[itemId] = v;
    }
  }
  return out;
}

function parseListings(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.listings)) {
    throw new Error('listings 목록이 없음');
  }
  if (data.listings.length > MAX_LISTINGS) throw new Error(`매물이 ${MAX_LISTINGS}개를 넘음`);
  return data.listings.map(sanitizeListing);
}

function readSaved() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { ok: true, listings: [] };
  }
  if (raw == null) return { ok: true, listings: [] };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, raw, reason: 'JSON 형식이 깨짐' };
  }
  try {
    return { ok: true, listings: parseListings(data) };
  } catch (e) {
    return { ok: false, raw, reason: e.message };
  }
}

function save() {
  if (!state.storageOK) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, listings: state.listings }));
    return true;
  } catch {
    showStorageWarning('저장 공간이 부족하거나 브라우저가 저장을 막아서 방금 바꾼 내용을 저장하지 못했어요. 브라우저 설정에서 이 사이트의 저장을 허용해 주세요.');
    return false;
  }
}

function showStorageWarning(msg) {
  const el = $('#storage-warning');
  el.textContent = msg;
  el.hidden = false;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 체크리스트 불러오기 ---------- */

function validateChecklist(data) {
  if (!data || !Array.isArray(data.tiers)) throw new Error('단계가 없음');
  if (!data.scale || !ANSWERS.every((k) => data.scale[k] && typeof data.scale[k].points === 'number')) {
    throw new Error('점수 기준이 없음');
  }
  if (!Array.isArray(data.grades) || !data.grades.some((g) => g.min === 0)) throw new Error('등급 기준이 없음');
  const ids = data.tiers.map((t) => t.id);
  if (!['essential', 'important', 'nice'].every((id) => ids.includes(id))) throw new Error('단계 구성이 맞지 않음');
  for (const t of data.tiers) {
    if (!t.name || !Array.isArray(t.items) || !t.items.length) throw new Error('단계 형식 오류');
    for (const it of t.items) {
      if (!it.id || !it.text) throw new Error('항목 형식 오류');
      if (t.points > 0 && !(it.weight > 0)) throw new Error('가중치 없음');
    }
  }
  return data;
}

async function fetchChecklist() {
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo');
  // 상태 확인용: ?demo=slow 는 로딩 화면을 3초 보여 주고, ?demo=error 는 불러오기 실패를 흉내 낸다.
  if (demo === 'slow') await new Promise((r) => setTimeout(r, 3000));
  const url = demo === 'error' ? 'data/__missing__.json' : CHECKLIST_URL;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
  } catch (e) {
    const err = new Error(e.name === 'AbortError'
      ? `서버가 ${FETCH_TIMEOUT_MS / 1000}초 안에 응답하지 않았어요.`
      : '인터넷 연결이 끊겼거나 서버에 접속할 수 없어요.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`체크리스트 파일을 찾지 못했어요(HTTP ${res.status}).`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('체크리스트 파일 형식이 깨져 있어요.');
  }
  try {
    return validateChecklist(data);
  } catch {
    throw new Error('체크리스트 파일의 구성이 올바르지 않아요.');
  }
}

/* ---------- 점수 계산 ---------- */

function allItems() {
  return state.checklist.tiers.flatMap((t) => t.items);
}

function isGate(tier) {
  return tier.points === 0;
}

// 필수 단계는 판정(통과·보류·탈락)만, 나머지 단계는 배점(80·20)에 맞춰 점수를 낸다.
function scoreOf(listing) {
  const { scale, tiers, grades } = state.checklist;
  let answered = 0;
  let total = 0;
  let score = 0;
  const failed = [];
  const unknown = [];
  const parts = {};
  for (const tier of tiers) {
    let earned = 0;
    let max = 0;
    let done = 0;
    for (const item of tier.items) {
      total += 1;
      const v = listing.answers[item.id];
      if (isGate(tier)) {
        if (v === 'good' || v === 'bad') done += 1;
        if (v === 'bad') failed.push(item.text);
        else if (v !== 'good') unknown.push(item.text);
        continue;
      }
      if (v) done += 1;
      max += item.weight * scale.good.points;
      if (v) earned += item.weight * scale[v].points;
    }
    const points = isGate(tier) ? 0 : Math.round((earned / max) * tier.points);
    parts[tier.id] = { points, max: tier.points, done, count: tier.items.length };
    answered += done;
    score += points;
  }
  const verdict = failed.length ? 'fail' : unknown.length ? 'hold' : 'pass';
  const grade = grades.find((g) => score >= g.min).label;
  return { score, grade, verdict, failed, unknown, parts, answered, total };
}

/* ---------- 입력 검사 ---------- */

function parseAmount(raw, f) {
  const s = raw.trim().replace(/[,\s]/g, '').replace(/만원?$/, '');
  if (s === '') {
    return f.required ? { error: `${f.obj} 입력하세요. 없으면 0을 입력하세요.` } : { value: 0 };
  }
  if (!/^\d+$/.test(s)) {
    return { error: `${f.top} 만원 단위 숫자만 입력하세요(예: ${f.ex}). 음수·소수점·문자는 쓸 수 없어요.` };
  }
  const n = Number(s);
  if (n > f.max) {
    return { error: `${f.top} 최대 ${formatMan(f.max)}까지 입력할 수 있어요. 원 단위로 적었다면 만원 단위로 바꿔 주세요.` };
  }
  return { value: n };
}

function validateForm(form, excludeId) {
  const errors = {};
  const values = {};
  const name = form.elements.name.value.trim();
  if (!name) {
    errors.name = '매물 이름을 입력하세요. 다른 매물과 구별할 별칭이면 돼요(예: 이문동 3층 남향).';
  } else if (name.length > 30) {
    errors.name = '매물 이름은 30자 이하로 줄여 주세요.';
  } else if (state.listings.some((l) => l.id !== excludeId && l.name === name)) {
    errors.name = '같은 이름의 매물이 이미 있어요. 층수나 방향을 붙여 다르게 지어 주세요.';
  }
  values.name = name;
  for (const [key, f] of Object.entries(AMOUNT_FIELDS)) {
    const r = parseAmount(form.elements[key].value, f);
    if (r.error) errors[key] = r.error;
    else values[key] = r.value;
  }
  return { values, errors };
}

function parseMinutes(raw, top, ex) {
  const s = raw.trim().replace(/분$/, '');
  if (s === '') return { value: null };
  if (!/^\d+$/.test(s)) return { error: `${top} 분 단위 숫자만 입력하세요(예: ${ex}). 모르면 비워 두세요.` };
  const n = Number(s);
  if (n > MAX_MINUTES) return { error: `${top} ${MAX_MINUTES}분 이하로 입력하세요. 걸어서 가기 어려운 거리면 비워 두세요.` };
  return { value: n };
}

function validateRef(form) {
  const errors = {};
  const values = {};
  const place = form.elements.place.value.trim();
  if (place.length > 20) errors.place = '동네는 20자 이하로 적어 주세요.';
  else if (DETAIL_ADDRESS.test(place)) errors.place = '번지·호수·도로명 번호 같은 상세 주소는 적지 않아요. 동 이름까지만 적어 주세요(예: 이문동).';
  values.place = place;
  const school = parseMinutes(form.elements.school.value, '학교까지 도보 시간은', 7);
  const station = parseMinutes(form.elements.station.value, '역까지 도보 시간은', 5);
  if (school.error) errors.school = school.error;
  else values.school = school.value;
  if (station.error) errors.station = station.error;
  else values.station = station.value;
  return { values, errors };
}

function flashNotice(box, ok, okMsg) {
  box.className = ok ? 'notice notice-info' : 'notice notice-error';
  box.textContent = ok ? okMsg : '바뀐 정보를 저장하지 못했어요. 위 경고를 확인해 주세요.';
  box.hidden = false;
  setTimeout(() => {
    if (box.classList.contains('notice-info')) box.hidden = true;
  }, 3000);
}

function showFormErrors(form, prefix, errors) {
  const box = document.getElementById(`${form.id}-error`);
  box.className = 'notice notice-error';
  const keys = Object.keys(errors);
  const fields = [...form.elements].filter((el) => el.tagName === 'INPUT' && el.name).map((el) => el.name);
  for (const key of fields) {
    const input = form.elements[key];
    const errEl = document.getElementById(`${prefix}-${key}-err`);
    if (errors[key]) {
      input.setAttribute('aria-invalid', 'true');
      errEl.textContent = errors[key];
    } else {
      input.removeAttribute('aria-invalid');
      errEl.textContent = '';
    }
  }
  if (keys.length) {
    box.textContent = `입력을 확인해 주세요: ${keys.length}개 항목에 문제가 있어요. 각 칸 아래 안내를 보고 고친 뒤 다시 눌러 주세요.`;
    box.hidden = false;
    form.elements[keys[0]].focus();
  } else {
    box.hidden = true;
    box.textContent = '';
  }
}

/* ---------- 목록·비교 화면 ---------- */

function sortedListings() {
  const withScore = state.listings.map((l) => ({ l, s: scoreOf(l) }));
  const monthly = (x) => x.l.rent + x.l.fee;
  const minutes = (v) => (v == null ? Infinity : v);
  const sorters = {
    score: (a, b) => VERDICTS[a.s.verdict].rank - VERDICTS[b.s.verdict].rank || b.s.score - a.s.score || monthly(a) - monthly(b),
    monthly: (a, b) => monthly(a) - monthly(b) || b.s.score - a.s.score,
    deposit: (a, b) => a.l.deposit - b.l.deposit || b.s.score - a.s.score,
    school: (a, b) => minutes(a.l.school) - minutes(b.l.school) || b.s.score - a.s.score,
    recent: (a, b) => b.l.createdAt - a.l.createdAt,
  };
  return withScore.sort(sorters[state.sort] || sorters.score);
}

function verdictNote(s) {
  if (s.verdict === 'fail') return `문제 ${s.failed.length}개`;
  if (s.verdict === 'hold') return `필수 미확인 ${s.unknown.length}개`;
  return '필수 모두 확인';
}

function refText(l) {
  const parts = [];
  if (l.place) parts.push(esc(l.place));
  if (l.school != null) parts.push(`학교까지 도보 ${l.school}분`);
  if (l.station != null) parts.push(`역까지 도보 ${l.station}분`);
  return parts.length ? parts.join(' · ') : '입력 안 함 · 매물을 열어 맨 아래에서 입력';
}

function renderCompare() {
  const body = $('#compare-body');
  if (!state.listings.length) {
    body.innerHTML = `
      <div class="empty">
        <strong>아직 비교할 매물이 없어요.</strong>
        위 ‘매물 추가’에서 보고 온 방의 이름과 보증금·월세를 입력하면 체크리스트가 만들어져요.
      </div>`;
    return;
  }
  const rows = sortedListings();
  const passed = rows.filter((r) => r.s.verdict === 'pass' && r.s.answered > 0);
  const bestScore = passed.length ? Math.max(...passed.map((r) => r.s.score)) : -1;
  const cards = rows.map(({ l, s }) => {
    const best = s.verdict === 'pass' && s.score === bestScore;
    const reasons = s.verdict === 'fail' ? s.failed : s.verdict === 'hold' ? s.unknown : [];
    const p = s.parts;
    return `
      <li class="listing-card verdict-${s.verdict} ${best ? 'best' : ''}">
        <div class="lc-head">
          <h3 class="lc-name"><a href="#/listing/${encodeURIComponent(l.id)}" data-id="${esc(l.id)}">${esc(l.name)}</a></h3>
          <span class="grade" aria-label="${s.grade}등급">${s.grade}</span>
        </div>
        <div class="lc-tags">
          ${best ? '<span class="badge-best">추천</span>' : ''}
          <span class="verdict v-${s.verdict}">${VERDICTS[s.verdict].label}</span>
          <span class="note" ${reasons.length ? `title="${esc(reasons.join(', '))}"` : ''}>${verdictNote(s)}</span>
        </div>
        <div>
          <div class="lc-score"><strong>${s.score}</strong><span>/ 100점 · 확인 ${s.answered}/${s.total}</span></div>
          <div class="bar" aria-hidden="true"><span style="width:${s.score}%"></span></div>
        </div>
        <dl class="stat-grid">
          <div class="stat"><dt>중요</dt><dd>${p.important.points}<small> / ${p.important.max}</small></dd></div>
          <div class="stat"><dt>있으면 좋음</dt><dd>${p.nice.points}<small> / ${p.nice.max}</small></dd></div>
          <div class="stat"><dt>보증금</dt><dd>${formatMan(l.deposit)}</dd></div>
          <div class="stat"><dt>월 고정비</dt><dd>${formatMan(l.rent + l.fee)}${l.fee ? `<small> (${l.rent}+${l.fee})</small>` : ''}</dd></div>
        </dl>
        <p class="ref-box"><b>위치 참고</b>${refText(l)}</p>
      </li>`;
  }).join('');

  body.innerHTML = `
    <ul class="listing-grid" role="list" aria-label="매물 ${rows.length}개, ${esc($('#sort-select').selectedOptions[0].textContent)}">
      ${cards}
    </ul>
    <p class="help" style="margin-top:16px">등급: S 90점 이상, A 75점 이상, B 60점 이상, C 60점 미만. ‘추천’은 필수 판정을 통과한 매물 중 점수가 가장 높은 곳이에요.</p>`;
}

/* ---------- 상세(체크리스트) 화면 ---------- */

function findListing(id) {
  return state.listings.find((l) => l.id === id);
}

function updateDetailScore(listing) {
  const s = scoreOf(listing);
  const saved = state.storageOK ? '저장됨' : '저장 안 됨';
  const pill = $('#detail-score');
  pill.className = `score-pill pill-${s.verdict}`;
  // 좁은 화면에서는 판정·점수·등급만 보이고 나머지는 숨긴다(화면 읽기 프로그램은 전부 읽음).
  pill.innerHTML = `<b>${VERDICTS[s.verdict].label}</b> ${s.score}점 · ${s.grade}<span class="sm-hide"> · 확인 ${s.answered}/${s.total} · ${saved}</span>`;

  // PC 옆 패널의 점수 요약
  const p = s.parts;
  const reasons = s.verdict === 'fail' ? s.failed : s.verdict === 'hold' ? s.unknown : [];
  $('#side-score').innerHTML = `
    <div class="lc-head">
      <span class="verdict v-${s.verdict}">${VERDICTS[s.verdict].label}</span>
      <span class="grade" aria-label="${s.grade}등급">${s.grade}</span>
    </div>
    <div>
      <div class="lc-score"><strong>${s.score}</strong><span>/ 100점</span></div>
      <div class="bar" aria-hidden="true"><span style="width:${s.score}%"></span></div>
    </div>
    <dl class="stat-grid">
      <div class="stat"><dt>중요</dt><dd>${p.important.points}<small> / ${p.important.max}</small></dd></div>
      <div class="stat"><dt>있으면 좋음</dt><dd>${p.nice.points}<small> / ${p.nice.max}</small></dd></div>
      <div class="stat"><dt>필수 확인</dt><dd>${p.essential.done}<small> / ${p.essential.count}</small></dd></div>
      <div class="stat"><dt>전체 확인</dt><dd>${s.answered}<small> / ${s.total}</small></dd></div>
    </dl>
    ${reasons.length ? `<p class="note">${s.verdict === 'fail' ? '문제' : '미확인'}: ${esc(reasons.join(', '))}</p>` : ''}`;
  for (const tier of state.checklist.tiers) {
    const el = document.getElementById(`tier-score-${tier.id}`);
    if (!el) continue;
    const p = s.parts[tier.id];
    el.textContent = isGate(tier)
      ? `${VERDICTS[s.verdict].label} · 확인 ${p.done}/${p.count}`
      : `${p.points}/${p.max}점 · 확인 ${p.done}/${p.count}`;
  }
}

function updateInfoSummary(listing) {
  $('#info-summary').textContent = `보증금 ${formatMan(listing.deposit)} · 월 ${formatMan(listing.rent + listing.fee)}`;
}

function renderDetail(listing) {
  $('#detail-title').textContent = listing.name;
  const form = $('#edit-form');
  form.elements.name.value = listing.name;
  form.elements.deposit.value = listing.deposit;
  form.elements.rent.value = listing.rent;
  form.elements.fee.value = listing.fee;
  showFormErrors(form, 'e', {});
  updateInfoSummary(listing);
  // 휴대전화에서는 체크리스트가 먼저 보이도록 기본 정보를 접어 둔다.
  $('#info-card').open = window.matchMedia('(min-width: 1024px)').matches;

  const ref = $('#ref-form');
  ref.elements.place.value = listing.place;
  ref.elements.school.value = listing.school ?? '';
  ref.elements.station.value = listing.station ?? '';
  showFormErrors(ref, 'r', {});

  const { scale, gateLabels } = state.checklist;
  const scoredOptions = [
    { v: 'good', label: scale.good.label, cls: 'c-good' },
    { v: 'okay', label: scale.okay.label, cls: 'c-okay' },
    { v: 'bad', label: scale.bad.label, cls: 'c-bad' },
    { v: '', label: '미확인', cls: 'c-none' },
  ];
  const gateOptions = [
    { v: 'good', label: gateLabels.good, cls: 'c-good' },
    { v: 'bad', label: gateLabels.bad, cls: 'c-bad' },
    { v: '', label: '미확인', cls: 'c-none' },
  ];
  $('#checklist-body').innerHTML = state.checklist.tiers.map((tier) => {
    const options = isGate(tier) ? gateOptions : scoredOptions;
    return `
    <div class="category tier-${esc(tier.id)}">
      <div class="category-head">
        <h4>${esc(tier.name)}</h4>
        <span id="tier-score-${esc(tier.id)}"></span>
      </div>
      <p class="tier-desc">${esc(tier.desc || '')}</p>
      ${tier.items.map((it) => {
        const saved = listing.answers[it.id] || '';
        const cur = options.some((o) => o.v === saved) ? saved : '';
        const hintId = `hint-${esc(it.id)}`;
        return `
          <fieldset class="item" aria-describedby="${hintId}">
            <legend>${esc(it.text)} ${it.area ? `<span class="area-tag">${esc(it.area)}</span>` : ''}</legend>
            <p class="hint" id="${hintId}">${esc(it.hint || '')}</p>
            <div class="choices">
              ${options.map((o) => `
                <label class="choice">
                  <input type="radio" name="q-${esc(it.id)}" value="${o.v}" data-item="${esc(it.id)}" ${cur === o.v ? 'checked' : ''}>
                  <span class="${o.cls}">${esc(o.label)}</span>
                </label>`).join('')}
            </div>
          </fieldset>`;
      }).join('')}
    </div>`;
  }).join('');
  updateDetailScore(listing);
}

/* ---------- 화면 전환 ---------- */

let currentId = null;

function route() {
  if (!state.checklist) return;
  const m = location.hash.match(/^#\/listing\/(.+)$/);
  const prevId = currentId;
  if (m) {
    const id = decodeURIComponent(m[1]);
    const listing = findListing(id);
    if (listing) {
      currentId = id;
      document.body.dataset.view = 'detail';
      $('#list-view').hidden = true;
      $('#detail-view').hidden = false;
      renderDetail(listing);
      document.title = `${listing.name} · 원룸 체크 비교`;
      window.scrollTo(0, 0);
      $('#detail-title').focus();
      return;
    }
    setAppStatus(`<div class="notice notice-warn"><p>찾는 매물이 없어요. 삭제되었거나 다른 브라우저에서 만든 링크일 수 있어요. 아래 목록에서 다시 골라 주세요.</p></div>`);
  }
  currentId = null;
  document.body.dataset.view = 'list';
  $('#detail-view').hidden = true;
  $('#list-view').hidden = false;
  // 매물이 있으면 비교 카드가 먼저 보이도록 추가 폼을 접어 둔다.
  $('#add-card').open = state.listings.length === 0;
  document.title = '원룸 체크 비교';
  renderCompare();
  if (prevId) {
    const link = document.querySelector(`#compare-body a[data-id="${CSS.escape(prevId)}"]`);
    if (link) link.focus();
  }
}

function setAppStatus(html) {
  $('#app-status').innerHTML = html;
}

/* ---------- 이벤트 ---------- */

function bindEvents() {
  window.addEventListener('hashchange', () => {
    setAppStatus('');
    route();
  });

  $('#home-link').addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '#/';
  });

  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (state.listings.length >= MAX_LISTINGS) {
      showFormErrors(form, 'f', {});
      const box = $('#add-form-error');
      box.textContent = `매물은 최대 ${MAX_LISTINGS}개까지 저장할 수 있어요. 후보에서 빠진 매물을 삭제한 뒤 추가해 주세요.`;
      box.hidden = false;
      return;
    }
    const { values, errors } = validateForm(form, null);
    showFormErrors(form, 'f', errors);
    if (Object.keys(errors).length) return;
    const now = Date.now();
    const listing = { id: newId(), ...values, place: '', school: null, station: null, answers: {}, createdAt: now, updatedAt: now };
    state.listings.push(listing);
    save();
    form.reset();
    location.hash = `#/listing/${encodeURIComponent(listing.id)}`;
  });

  $('#sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderCompare();
  });

  $('#back-btn').addEventListener('click', () => {
    location.hash = '#/';
  });

  $('#edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const listing = findListing(currentId);
    if (!listing) return;
    const form = e.currentTarget;
    const { values, errors } = validateForm(form, listing.id);
    showFormErrors(form, 'e', errors);
    if (Object.keys(errors).length) return;
    Object.assign(listing, values, { updatedAt: Date.now() });
    const ok = save();
    $('#detail-title').textContent = listing.name;
    document.title = `${listing.name} · 원룸 체크 비교`;
    flashNotice($('#edit-form-error'), ok, '기본 정보를 저장했어요.');
    updateInfoSummary(listing);
    updateDetailScore(listing);
  });

  $('#ref-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const listing = findListing(currentId);
    if (!listing) return;
    const form = e.currentTarget;
    const { values, errors } = validateRef(form);
    showFormErrors(form, 'r', errors);
    if (Object.keys(errors).length) return;
    Object.assign(listing, values, { updatedAt: Date.now() });
    flashNotice($('#ref-form-error'), save(), '위치 참고 정보를 저장했어요. 점수에는 반영되지 않아요.');
  });

  $('#delete-btn').addEventListener('click', () => {
    const listing = findListing(currentId);
    if (!listing) return;
    if (!confirm(`‘${listing.name}’ 매물을 삭제할까요? 체크한 내용도 함께 지워지고 되돌릴 수 없어요.`)) return;
    state.listings = state.listings.filter((l) => l.id !== listing.id);
    save();
    currentId = null;
    location.hash = '#/';
    setTimeout(() => setAppStatus(`<div class="notice notice-info"><p>‘${esc(listing.name)}’ 매물을 삭제했어요.</p></div>`), 0);
  });

  $('#checklist-body').addEventListener('change', (e) => {
    const input = e.target;
    if (input.type !== 'radio') return;
    const listing = findListing(currentId);
    if (!listing) return;
    const itemId = input.dataset.item;
    if (input.value) listing.answers[itemId] = input.value;
    else delete listing.answers[itemId];
    listing.updatedAt = Date.now();
    save();
    updateDetailScore(listing);
  });
}

/* ---------- 시작 ---------- */

function showCorruptData(saved) {
  setAppStatus(`
    <div class="notice notice-error" role="alert">
      <p><strong>저장된 기록을 읽을 수 없어요.</strong> 저장 데이터가 손상되었거나 다른 형식이에요(${esc(saved.reason)}).</p>
      <p>원본을 파일로 내려받아 보관한 뒤, 기록을 비우고 새로 시작할 수 있어요.</p>
      <div class="btn-row">
        <button type="button" class="btn" id="raw-download">원본 내려받기</button>
        <button type="button" class="btn btn-danger" id="raw-reset">기록 비우고 새로 시작</button>
      </div>
    </div>`);
  $('#raw-download').addEventListener('click', () => downloadText(`oneroom-damaged-${today()}.txt`, saved.raw));
  $('#raw-reset').addEventListener('click', () => {
    if (!confirm('저장된 기록을 모두 비울까요? 되돌릴 수 없어요.')) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* 저장소를 못 쓰면 비울 것도 없다 */ }
    init();
  });
}

async function init() {
  $('#list-view').hidden = true;
  $('#detail-view').hidden = true;
  $('#main').setAttribute('aria-busy', 'true');
  setAppStatus('<div class="loading"><span class="spinner" aria-hidden="true"></span>체크리스트를 불러오는 중…</div>');

  state.storageOK = storageAvailable();
  if (!state.storageOK) {
    showStorageWarning('이 브라우저에서는 저장 기능을 쓸 수 없어요(사생활 보호 모드이거나 저장이 차단됨). 입력은 되지만 창을 닫으면 사라져요. 일반 창에서 열거나 브라우저 설정에서 사이트 데이터 저장을 허용해 주세요.');
  }

  try {
    state.checklist = await fetchChecklist();
  } catch (e) {
    $('#main').removeAttribute('aria-busy');
    setAppStatus(`
      <div class="notice notice-error" role="alert">
        <p><strong>체크리스트를 불러오지 못했어요.</strong> ${esc(e.message)}</p>
        <p>인터넷 연결을 확인한 뒤 다시 시도해 주세요. 계속 안 되면 잠시 후 새로고침해 주세요. 저장해 둔 매물 기록은 지워지지 않았어요.</p>
        <button type="button" class="btn btn-primary" id="retry-btn">다시 시도</button>
      </div>`);
    $('#data-info').textContent = '체크리스트 정보를 불러오지 못했어요.';
    $('#retry-btn').addEventListener('click', () => {
      // 데모 실패 모드에서는 다시 시도 시 정상 경로로 돌아간다.
      if (new URLSearchParams(location.search).get('demo') === 'error') {
        history.replaceState(null, '', location.pathname + location.hash);
      }
      init();
    });
    $('#retry-btn').focus();
    return;
  }

  $('#main').removeAttribute('aria-busy');
  const c = state.checklist;
  const counts = c.tiers.map((t) => `${t.name.replace(/^\d단계 /, '')} ${t.items.length}`).join(' · ');
  $('#data-info').textContent = `체크리스트 v${c.version} · 항목 ${allItems().length}개(${counts}) · 갱신일 ${c.updated} · 항목 출처는 README 참고`;

  const saved = readSaved();
  if (!saved.ok) {
    showCorruptData(saved);
    return;
  }
  state.listings = saved.listings;
  setAppStatus('');
  route();
}

bindEvents();
init();
