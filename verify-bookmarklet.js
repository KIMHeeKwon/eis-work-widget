// 빌드된 북마클릿을 최소 DOM 스텁 위에서 실제로 실행해 본다.
//   실행: node verify-bookmarklet.js   (build-bookmarklet.js 뒤에)
//
// build-bookmarklet.js는 문법과 인코딩만 본다. 여기서는 한 걸음 더 나아가
//   1) IIFE가 예외 없이 끝까지 도는지
//   2) EIS 화면이 아니고 캐시도 없을 때 조용히 아무것도 하지 않는지
//   3) 캐시가 있을 때 "n분 전 값" 화면을 값까지 맞게 그리는지
// 를 본다.  3)은 실제 EIS 화면에서는 재현하기 번거로운 경로다.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bm = fs.readFileSync(path.join(__dirname, 'eis-work-widget.bookmarklet.txt'), 'utf8').trim();
const code = decodeURIComponent(bm.slice('javascript:'.length));

// 빌드가 줄 전체 주석을 지우므로, 템플릿 리터럴이 생기면 문자열 안을 먹을 수 있다.
if (code.indexOf('`') >= 0) throw new Error('템플릿 리터럴이 있다 — 주석 제거가 안전하지 않다');

// 위젯이 만지는 것만 흉내 낸다. 없는 속성은 undefined로 두어 조용히 넘어가게 한다.
const el = () => new Proxy({}, {
  get: function (t, k) {
    if (k === 'style' || k === 'classList' || k === 'dataset') return el();
    if (k === 'getBoundingClientRect') return () => ({ top: 16, left: 24, width: 592, height: 162, right: 616, bottom: 178 });
    if (k === 'querySelectorAll') return () => [];
    if (k === 'querySelector' || k === 'closest') return () => el();
    if (typeof k === 'string' && /^(appendChild|addEventListener|removeEventListener|toggle|add|remove|setAttribute|dispatchEvent|focus|preventDefault|stopPropagation|contains)$/.test(k)) return () => {};
    if (k === 'innerText' || k === 'textContent' || k === 'innerHTML' || k === 'id') return '';
    if (k === Symbol.toPrimitive) return () => '[el]';
    return undefined;
  },
  set: function () { return true; }
});

const store = {};
let timerFn = null;
let html = null;

const sandbox = {
  document: {
    querySelector: () => null,          // EIS 화면이 아니다
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => new Proxy({}, {
      get: (t, k) => el()[k],
      set: (t, k, v) => { if (k === 'innerHTML') html = v; return true; }
    }),
    head: el(), body: el(), addEventListener: () => {}
  },
  localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  setInterval: f => { timerFn = f; return 1; },
  clearInterval: () => {},
  setTimeout: () => 2,
  MouseEvent: function () {},
  console: console
};
sandbox.window = sandbox;
sandbox.addEventListener = () => {};
vm.createContext(sandbox);

vm.runInContext(code, sandbox, { timeout: 3000 });
if (typeof timerFn !== 'function') throw new Error('타이머가 등록되지 않았다 — IIFE가 끝까지 돌지 않았다');

timerFn(); timerFn();
if (html) throw new Error('화면도 캐시도 없는데 무언가를 그렸다');
console.log('IIFE 실행 OK · 타이머 등록 OK · 화면 없음 + 캐시 없음 경로 무동작 OK');

// 2026-09-04 EIS 실측값 (정산기간 2026-08-30~09-12, 18회차)
store['etri.eis.workWidget'] = JSON.stringify({
  from: '2026-08-30', to: '2026-09-12', round: '18회차',
  base: 4800, actual: 2196, planWork: 1440, planHoliday: 480, sumNoHoliday: 3636,
  remainNow: 2604, remainPlan: 1164, remainAll: 684, pctNow: 0.4575, pctPlan: 0.7575,
  pctAll: 0.8575,
  truncated: false, day: { date: '2026-09-04', start: '08:13', end: '08:17' },
  at: Date.now() - 12 * 60000
});

timerFn();
if (!html) throw new Error('캐시가 있는데도 "n분 전 값" 화면을 그리지 않았다');
console.log('stale 렌더 OK · ' + html.length + ' chars');

var bad = 0;
// 잔여 시간 칸은 위가 '남은시간'(휴일까지 반영한 remainAll), 아래가 '현재까지'다
// (2026-09-08 사용자 결정). 휴일을 뺀 remainPlan(19:24)은 이제 화면에 나오지 않는다
['43:24', '11:24', '08:13', '12분 전 값', '남은시간', '남음',
 '달성률 · 출장·휴일 포함', '>86<', '>46%<'].forEach(function (f) {
  var ok = html.indexOf(f) >= 0;
  if (!ok) bad++;
  console.log((ok ? '  OK   ' : '  실패 ') + f);
});

// 오늘 행의 종료시간 칸은 퇴근 시각이 아니라 조회 시점을 담고 있어서 화면에 내보내지
// 않기로 했다 (2026-09-07 실측 — 6분이 흐르는 동안 그 칸도 6분 뒤로 밀렸다).
// 그 결정이 되살아나지 않도록 여기서 지킨다
['08:17', 'EIS'].forEach(function (f) {
  var ok = html.indexOf(f) < 0;
  if (!ok) bad++;
  console.log((ok ? '  OK   ' : '  실패 ') + f + ' 없음');
});
if (bad) throw new Error(bad + '개 항목이 기대와 다르다');
