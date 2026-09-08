// 이 파일은 build.js가 eis-work-widget.user.js에서 생성한다. 직접 고치지 말 것.
//
// 동작 원리
//   1) EIS 어느 화면에 있든 스크립트는 살아 있다. 주소를 박아 넣지 않는다.
//   2) 근무시간현황 화면이 뜨면 알아서 값을 읽고 위젯을 채운다.
//   3) 다른 화면에서는 마지막으로 읽은 값을 흐리게 띄우고 "n분 전 값"을 붙인다.
//   4) 위젯이 대신 하는 조작은 오늘 날짜 행 클릭 한 번뿐이고, 그마저도
//      일별 상세가 이미 오늘을 가리키고 있으면 하지 않는다.
//
// 읽는 값 (전부 화면에 표시되어 있는 것)
//   output10  기준근무시간(분)   output9  실근무시간(분, 출근예정 포함 전체)
//   정산기간 그리드 행 · 일별 상세 그리드 행 · 검색조건의 기간/회차

(function () {
  'use strict';

  var KEY = 'etri.eis.workWidget';
  var SEL = {
    baseMin:  '[id$="switch1.case1.form.output10:input"]',
    totalMin: '[id$="switch1.case1.form.output9:input"]',
    from:     '[id$="div_Search.form.input3.calendaredit:input"]',
    to:       '[id$="div_Search.form.input4.calendaredit:input"]',
    round:    '[id$="div_Search.form.combo2.comboedit:input"]',
    grid:     '[id$="switch1.case1.form.datagrid2:container"]',
    gridBody: '[id$="switch1.case1.form.datagrid2.body:container"]',
    dayGrid:  '[id$="switch1.case1.form.datagrid1:container"]'
  };

  // ──────────────────────────────────────────────── 값 다루기

  function toMin(s) {                       // "9:17" → 557
    var m = /^(-?)(\d+):(\d{2})$/.exec((s || '').trim());
    if (!m) return null;
    var v = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    return m[1] === '-' ? -v : v;
  }

  function hm(min) {                        // 2604 → "43:24"
    if (min === null || min === undefined || isNaN(min)) return '–';
    var sign = min < 0 ? '-' : '';
    var v = Math.abs(Math.round(min));
    return sign + Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
  }

  // 잔여가 양수면 아직 채워야 할 시간이고(파랑), 음수면 기준을 넘긴 시간이다(빨강).
  // 2026-09-08 사용자 요청 — 모자람과 초과를 색과 낱말로 함께 알린다
  function rem(min, size) {
    var over = min < 0;
    return '<span class="v num" style="font-size:' + size + 'px;color:' +
      (over ? '#b04a3c' : '#5980a6') + '">' + hm(min) +
      '<span style="font-weight:500;font-size:10px;color:rgba(29,31,32,.45);margin-left:4px">' +
      (over ? '초과' : '남음') + '</span></span>';
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function val(sel) {
    var e = document.querySelector(sel);
    return e ? (e.value || '').trim() : null;
  }

  // ──────────────────────────────────────────────── 그리드 읽기
  //
  // Nexacro 그리드는 셀을 절대 좌표에 놓는다. 그래서 표 구조가 DOM 계층에
  // 없다. leaf 셀을 전부 모아 y로 묶어 행을, x로 갈라 열을 되살린다.
  // 열 이름은 머리글 셀의 x를 기준점으로 삼아 가장 가까운 것에 붙인다.

  function leafCells(root) {
    return [].slice.call(root.querySelectorAll('.nexacontentsbox'))
      .filter(function (e) { return !e.querySelector('.nexacontentsbox'); })
      .map(function (e) {
        var r = e.getBoundingClientRect();
        return { el: e, t: (e.innerText || '').trim(), x: r.left, y: r.top, w: r.width };
      })
      .filter(function (c) { return c.t && c.w > 0; });
  }

  function groupRows(cells) {
    var rows = {};
    cells.forEach(function (c) {
      var k = Math.round(c.y / 6) * 6;
      (rows[k] = rows[k] || []).push(c);
    });
    return Object.keys(rows).map(Number).sort(function (a, b) { return a - b; })
      .map(function (k) {
        return rows[k].sort(function (a, b) { return a.x - b.x; });
      });
  }

  // 머리글 셀에서 열 이름 → x 지도를 만든다.
  function columnMap(root, names) {
    var map = {};
    leafCells(root).forEach(function (c) {
      if (names.indexOf(c.t) >= 0 && map[c.t] === undefined) map[c.t] = c.x;
    });
    return map;
  }

  function nameOf(map, x) {
    var best = null, gap = 1e9;
    Object.keys(map).forEach(function (n) {
      var d = Math.abs(map[n] - x);
      if (d < gap) { gap = d; best = n; }
    });
    return gap <= 30 ? best : null;
  }

  // 정산기간 그리드 → [{date, 합계, 휴일, cell}]
  function readPeriodGrid() {
    var grid = document.querySelector(SEL.grid);
    var body = document.querySelector(SEL.gridBody);
    if (!grid || !body) return null;

    var map = columnMap(grid, ['최소', '선택', '연장', '야간', '휴일', '합계']);
    if (map['합계'] === undefined) return null;

    return groupRows(leafCells(body)).map(function (cs) {
      var dateCell = null, cols = {};
      cs.forEach(function (c) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(c.t)) { dateCell = c; return; }
        var n = nameOf(map, c.x);
        if (n) cols[n] = toMin(c.t);
      });
      if (!dateCell) return null;
      return { date: dateCell.t, cell: dateCell.el, sum: cols['합계'], holiday: cols['휴일'] || 0 };
    }).filter(Boolean);
  }

  // 일별 상세 그리드 → {date, start, end}
  function readDayGrid() {
    var grid = document.querySelector(SEL.dayGrid);
    if (!grid) return null;
    var map = columnMap(grid, ['시작시간', '종료시간']);
    if (map['시작시간'] === undefined) return null;

    var picked = [];
    groupRows(leafCells(grid)).forEach(function (cs) {
      var d = null, st = null, en = null;
      cs.forEach(function (c) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(c.t)) d = c.t;
        else if (/^\d{1,2}:\d{2}$/.test(c.t)) {
          var n = nameOf(map, c.x);
          if (n === '시작시간') st = c.t;
          if (n === '종료시간') en = c.t;
        }
      });
      if (d && (st || en)) picked.push({ date: d, start: st, end: en });
    });
    if (!picked.length) return null;
    return { date: picked[0].date, start: picked[0].start, end: picked[picked.length - 1].end };
  }

  function clickCell(el) {
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, view: window, button: 0,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    ['mousedown', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, o));
    });
  }

  // ──────────────────────────────────────────────── 집계
  //
  // 실근무시간(output9)은 출근예정까지 더한 전체 합계다. 미래 날짜 행을 빼야
  // 지금까지 실제로 일한 시간이 나온다. 목록이 날짜 내림차순이라 미래 행은
  // 언제나 맨 위에 있고, 따라서 가상 스크롤과 무관하게 전부 화면에 그려져 있다.

  function compute(rows) {
    var base = parseInt(val(SEL.baseMin), 10);
    var total = parseInt(val(SEL.totalMin), 10);
    if (isNaN(base) || isNaN(total)) return null;

    var td = today();
    var future = rows.filter(function (r) { return r.date > td; });
    var planAll = future.reduce(function (a, r) { return a + (r.sum || 0); }, 0);
    var planHoliday = future.reduce(function (a, r) { return a + (r.holiday || 0); }, 0);
    var planWork = planAll - planHoliday;
    var actual = total - planAll;

    // 미래 행이 그려진 마지막 행까지 이어지면, 더 아래에 안 그려진 계획이
    // 남아 있을 수 있다. 그때는 값을 못 믿으므로 알린다.
    var last = rows[rows.length - 1];
    var truncated = !!(last && last.date > td);

    return {
      from: val(SEL.from), to: val(SEL.to), round: val(SEL.round),
      base: base, actual: actual, planWork: planWork, planHoliday: planHoliday,
      sumNoHoliday: actual + planWork,
      remainNow: base - actual,
      remainPlan: base - actual - planWork,
      remainAll: base - actual - planWork - planHoliday,
      pctNow: base ? actual / base : 0,
      pctPlan: base ? (actual + planWork) / base : 0,
      // 휴일근무 예정까지 더한 달성률. 위젯의 큰 숫자와 트레이가 함께 읽는다
      // (2026-09-08 사용자 결정 — 잔여와 달성률의 기준을 휴일 포함으로 통일했다)
      pctAll: base ? (actual + planWork + planHoliday) / base : 0,
      truncated: truncated,
      day: null,
      at: Date.now()
    };
  }

  // ──────────────────────────────────────────────── 화면
  //
  // Industry 디자인 시스템 라이트 테마. 색·치수는 핸드오프 문서의 확정값이다.

  // 앞의 두 줄은 Nexacro가 전역으로 div에 걸어 둔 position:absolute·overflow:hidden을 되돌린다.
  // 그대로 두면 자식이 흐름에서 빠져나가 위젯이 높이 2px로 접힌다 (2026-09-04 실측).
  var CSS = [
    '#eisw *{position:static;overflow:visible;box-sizing:border-box;margin:0;border:0;',
    '  background:none;float:none;font-family:inherit;text-align:left;white-space:normal}',
    '#eisw svg{display:block;width:148px;height:84px}',
    '#eisw{position:fixed;z-index:2147483000;top:16px;right:24px;width:592px;',
    '  background:#f5f5f8;border:1px solid rgba(29,31,32,.18);',
    '  box-shadow:0 12px 32px rgba(43,43,45,.20);color:#1d1f20;',
    '  font-family:"Barlow","Noto Sans KR","Segoe UI",system-ui,sans-serif;',
    '  display:grid;grid-template-columns:186px 178px 1fr;user-select:none}',
    '#eisw.stale{border-style:dashed;opacity:.72}',
    '#eisw>div{padding:12px 14px}',
    '#eisw>div+div{border-left:1px solid rgba(29,31,32,.14)}',
    '#eisw .hdl{cursor:grab}#eisw .hdl:active{cursor:grabbing}',
    '#eisw .cn{position:absolute;width:11px;height:11px;pointer-events:none;',
    '  background:linear-gradient(#7a7a7d,#7a7a7d) center/1px 100% no-repeat,',
    '             linear-gradient(#7a7a7d,#7a7a7d) center/100% 1px no-repeat}',
    '#eisw .tl{top:-6px;left:-6px}#eisw .tr{top:-6px;right:-6px}',
    '#eisw .bl{bottom:-6px;left:-6px}#eisw .br{bottom:-6px;right:-6px}',
    '#eisw .lbl{font-family:"Barlow Condensed","Segoe UI",sans-serif;font-weight:600;',
    '  font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:rgba(29,31,32,.55)}',
    '#eisw .num{font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.03em;line-height:1}',
    '#eisw .row{display:grid;grid-template-columns:1fr auto;align-items:baseline;margin-bottom:3px}',
    '#eisw .k{font-size:10.5px;color:rgba(29,31,32,.70)}',
    '#eisw .v{font-weight:600;font-size:13px;font-variant-numeric:tabular-nums}',
    '#eisw .bar{height:5px;background:rgba(29,31,32,.12);position:relative;margin-top:5px}',
    '#eisw .bar>span,#eisw .bar>em{position:absolute;top:0;bottom:0}',
    '#eisw .bar>span{left:0;background:#5980a6}',
    '#eisw .bar>em{background:#749dc4;opacity:.6}',
    '#eisw .ko{font-size:10px;color:rgba(29,31,32,.55);line-height:1.45}',
    '#eisw .paren{font-weight:500;font-size:10.5px;color:rgba(29,31,32,.50)}',
    '#eisw .gw{position:relative;width:148px;height:84px;margin:4px auto 0}',
    '#eisw .gn{position:absolute;left:0;right:0;bottom:2px;text-align:center}',
    '#eisw .gn b{font-size:34px}',
    '#eisw .gn s{text-decoration:none;font-weight:500;font-size:13px;color:rgba(29,31,32,.50);margin-left:2px}',
    '#eisw .top{display:flex;justify-content:space-between;align-items:center;',
    '  padding:0 12px 6px 0;border-bottom:1px solid rgba(29,31,32,.10)}',
    '#eisw .x{position:absolute;top:6px;right:8px;cursor:pointer;font-size:13px;',
    '  line-height:1;color:rgba(29,31,32,.35);z-index:1}',
    '#eisw .x:hover{color:#1d1f20}',
    '#eisw .r{position:absolute;top:6px;right:26px;cursor:pointer;font-size:13px;',
    '  line-height:1;color:rgba(29,31,32,.35);z-index:1}',
    '#eisw .r:hover{color:#1d1f20}',
    '#eisw .r.busy{color:rgba(29,31,32,.18);cursor:default}',
    '#eisw .warn{color:#a68059}'
  ].join('\n');

  var ARC = 194.7;   // 반원 계기 경로 길이. 경로를 바꾸면 다시 재야 한다.

  function gauge(pctNow, pctPlan) {
    var d = 'M12 78 A62 62 0 0 1 136 78';
    var cap = function (p) { return Math.max(0, Math.min(1, p)) * ARC; };
    return '<svg width="148" height="84" viewBox="0 0 148 90">' +
      '<path d="' + d + '" fill="none" stroke="rgba(29,31,32,.12)" stroke-width="9"/>' +
      '<path d="' + d + '" fill="none" stroke="#749dc4" stroke-width="9" opacity=".5" ' +
        'stroke-dasharray="' + cap(pctPlan).toFixed(1) + ' ' + ARC + '"/>' +
      '<path d="' + d + '" fill="none" stroke="#5980a6" stroke-width="9" ' +
        'stroke-dasharray="' + cap(pctNow).toFixed(1) + ' ' + ARC + '"/></svg>';
  }

  function render(d, stale) {
    var el = document.getElementById('eisw');
    if (!el) {
      var st = document.createElement('style');
      st.textContent = CSS;
      document.head.appendChild(st);
      el = document.createElement('div');
      el.id = 'eisw';
      document.body.appendChild(el);
      restorePos(el);
      makeDraggable(el);
    }
    el.classList.toggle('stale', !!stale);

    var pct = Math.round(d.pctNow * 100);
    var barNow = Math.max(0, Math.min(100, d.pctNow * 100));
    // 앱을 고치기 전에 저장된 캐시에는 pctAll이 없다. 그때는 여기서 직접 구한다
    var pctAll = d.pctAll != null ? d.pctAll
      : (d.base ? (d.actual + d.planWork + d.planHoliday) / d.base : 0);
    var pctP = Math.round(pctAll * 100);
    var barAll = Math.max(0, Math.min(100 - barNow, (pctAll - d.pctNow) * 100));
    var dd = d.day || {};

    var foot = stale
      ? '<span class="ko warn">' + Math.round((Date.now() - d.at) / 60000) + '분 전 값</span>'
      : (d.truncated
          ? '<span class="ko warn">출근예정이 더 있을 수 있음</span>'
          // 평소에는 아무것도 두지 않는다. 이 자리가 새로고침 단추 바로 아래라서
          // 배지가 단추와 겹쳐 보였다 (2026-09-07 사용자 지적)
          : '');

    el.innerHTML =
      '<i class="cn tl"></i><i class="cn tr"></i><i class="cn bl"></i><i class="cn br"></i>' +
      '<span class="r" title="새로고침">&#10227;</span>' +
      '<span class="x" title="닫기">&#10005;</span>' +

      '<div class="hdl">' +
        '<div class="lbl">달성률 · 출장·휴일 포함</div>' +
        '<div class="gw">' + gauge(d.pctNow, d.pctPlan) +
          '<div class="gn"><b class="num">' + pctP + '</b><s>%</s></div></div>' +
        '<div class="ko" style="margin-top:7px">현재까지 ' +
          '<b style="color:#5980a6">' + pct + '%</b></div>' +
      '</div>' +

      '<div>' +
        '<div class="lbl">잔여 시간</div>' +
        '<div style="margin-top:6px">' +
          '<div class="row"><span class="k">남은시간<br>' +
            '<span class="paren">출장·휴일 포함</span></span>' + rem(d.remainAll, 26) + '</div>' +
          '<div class="bar"><span style="width:' + barNow + '%"></span>' +
            '<em style="left:' + barNow + '%;width:' + barAll + '%"></em></div>' +
        '</div>' +
        '<div style="margin-top:11px">' +
          '<div class="row"><span class="k">현재까지</span>' + rem(d.remainNow, 19) + '</div>' +
          '<div class="bar"><span style="width:' + barNow + '%"></span></div>' +
        '</div>' +
        (d.planHoliday
          ? '<div class="ko" style="margin-top:9px">이 중 휴일근무 <b style="color:#1d1f20">' +
            hm(d.planHoliday) + '</b></div>'
          : '<div class="ko" style="margin-top:9px;color:rgba(29,31,32,.40)">휴일근무 예정 없음</div>') +
      '</div>' +

      '<div>' +
        '<div class="top"><span class="lbl">오늘 · ' + today().slice(5) + '</span>' + foot + '</div>' +
        '<div class="row" style="margin-top:7px"><span class="k">출근 / 퇴근</span>' +
          // 오늘 행의 종료시간 칸은 실제로 퇴근을 누르기 전에도 값을 갖고 있어서, 그대로
          // 보여 주면 퇴근한 것처럼 읽힌다. 그래서 오늘은 퇴근 자리를 비워 둔다
          // (2026-09-04 사용자 결정 — 퇴근을 누르면 그 칸이 실제 시각으로 바뀌는 것은 확인했다)
          '<span class="v">' + (dd.start || '–') +
          ' <span style="color:rgba(29,31,32,.40)">/</span> –</span></div>' +
        '<div class="row"><span class="k">근무 · 현재까지</span>' +
          '<span class="v">' + hm(d.actual) + '</span></div>' +
        '<div class="row"><span class="k">출근예정</span><span class="v">' + hm(d.planWork) +
          (d.planHoliday ? ' <span class="paren">(+휴일 ' + hm(d.planHoliday) + ')</span>' : '') +
          '</span></div>' +
        '<div class="row"><span class="k">기준 근무</span>' +
          '<span class="v" style="color:rgba(29,31,32,.70)">' + hm(d.base) + '</span></div>' +
        '<div class="ko" style="margin-top:9px;color:rgba(29,31,32,.40)">정산기간 ' +
          (d.from || '').slice(5) + ' ~ ' + (d.to || '').slice(5) +
          (d.round ? ' · ' + d.round : '') + '</div>' +
      '</div>';

    el.querySelector('.x').onclick = function () { el.remove(); };
    el.querySelector('.r').onclick = function () { tick(); };
  }

  // ──────────────────────────────────────────────── 위치 기억 · 끌어 옮기기

  function restorePos(el) {
    try {
      var p = JSON.parse(localStorage.getItem(KEY + '.pos') || 'null');
      if (p) { el.style.top = p.t + 'px'; el.style.left = p.l + 'px'; el.style.right = 'auto'; }
    } catch (e) { /* 저장이 막혀 있어도 위젯은 뜬다 */ }
  }

  function makeDraggable(el) {
    var sx = 0, sy = 0, ox = 0, oy = 0, on = false;
    el.addEventListener('mousedown', function (e) {
      if (!e.target.closest('.hdl')) return;
      var r = el.getBoundingClientRect();
      on = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!on) return;
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top = (oy + e.clientY - sy) + 'px';
      el.style.right = 'auto';
    });
    window.addEventListener('mouseup', function () {
      if (!on) return;
      on = false;
      var r = el.getBoundingClientRect();
      try { localStorage.setItem(KEY + '.pos', JSON.stringify({ t: Math.round(r.top), l: Math.round(r.left) })); }
      catch (e) { /* 무시 */ }
    });
  }

  // ──────────────────────────────────────────────── 흐름

  function cache(d) {
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* 무시 */ }
  }

  function cached() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  function onScreen() {
    return !!(document.querySelector(SEL.totalMin) && document.querySelector(SEL.gridBody));
  }

  var clicked = false;

  function collect() {
    var rows = readPeriodGrid();
    if (!rows || !rows.length) return null;
    var d = compute(rows);
    if (!d) return null;

    // 오늘 행 클릭은 일별 상세가 오늘을 가리키고 있지 않을 때만 한 번.
    var day = readDayGrid();
    if ((!day || day.date !== today()) && !clicked) {
      var mine = rows.filter(function (r) { return r.date === today(); })[0];
      if (mine) { clicked = true; clickCell(mine.cell); return null; }   // 갱신을 기다린다
    }
    if (day && day.date === today()) d.day = day;
    return d;
  }

  var lastSig = '';

  function tick() {
    if (onScreen()) {
      var d = collect();
      if (d) {
        var sig = JSON.stringify(d).replace(/"at":\d+/, '');
        if (sig !== lastSig) { lastSig = sig; cache(d); render(d, false); }
      }
    } else {
      clicked = false;
      if (!document.getElementById('eisw')) {
        var c = cached();
        if (c) render(c, true);
      }
    }
  }

  // 데스크톱 앱의 표시 창은 EIS 화면이 아니라서 스스로 값을 읽지 못한다. 밖에서 값을
  // 넘겨받아 같은 모습으로 그릴 수 있도록 렌더 함수만 열어 둔다. 브라우저에서는 쓰이지 않는다.
  window.__eiswRender = render;

  if (window.__eiswTimer) clearInterval(window.__eiswTimer);   // 북마클릿을 두 번 눌러도 타이머가 겹치지 않는다
  window.__eiswTimer = setInterval(tick, 1500);
  tick();
})();
