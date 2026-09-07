// 표시 창은 EIS 화면이 아니므로 스스로 값을 읽지 못한다. main이 보내 주는 값만 받는다.
const { ipcRenderer } = require('electron');
window.__eiswIpc = {
  onData: function (fn) { ipcRenderer.on('eisw:data', function (e, d) { fn(d); }); },
  hide: function () { ipcRenderer.send('eisw:hide'); },
  refresh: function () { ipcRenderer.send('eisw:refresh'); }
};
