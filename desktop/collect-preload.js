// 세션이 없으면 EIS 화면은 알림을 띄운 뒤 스스로 창을 닫는다. 배경에서 도는 수집 창이
// 그렇게 사라지면 사용자가 로그인할 자리도 없어진다 (2026-09-04 실측 — 화면을 부른 그
// 순간 창이 파괴됐다). 창을 닫으려 했다는 사실 자체가 곧 "로그인이 필요하다"는 신호이므로
// 여기서 닫기를 막고, 그 사실만 알린다.
const { ipcRenderer } = require('electron');
window.close = function () { ipcRenderer.send('eisw:page-wants-close'); };
window.alert = function () { };
window.confirm = function () { return true; };
window.prompt = function () { return null; };
