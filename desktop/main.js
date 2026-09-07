// EIS 근무시간 데스크톱 위젯.
//
// 브라우저를 켜 두지 않아도 되도록, 앱이 자기 브라우저 창으로 EIS를 열어 값을 읽는다.
// 읽는 방식은 크롬 확장과 똑같다 — 화면에 그려진 숫자만 본다. 파싱·계산·표시 코드는
// widget-core.js 하나이며, 그 파일은 build.js가 eis-work-widget.user.js에서 생성한다.

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { trayIcon } = require('./png.js');

// Electron은 main에서 예외가 나면 오류 대화상자를 띄우고, 타이머가 매번 같은 예외를
// 내면 그 창이 끝없이 쌓인다 (2026-09-04 실측). 로그로만 남기고 앱은 계속 돈다.
process.on('uncaughtException', function (e) { console.error('[uncaught]', e && e.message); });

// 콘솔은 파일로 넘길 때 버퍼에 갇혀 뒷부분이 보이지 않는다. 진단이 끝날 때까지
// 같은 줄을 로그 파일에도 그대로 남긴다
const LOG = path.join(__dirname, 'run.log');
try { fs.writeFileSync(LOG, ''); } catch (e) { }
const rawLog = console.log;
console.log = function () {
  const line = Array.prototype.slice.call(arguments).join(' ');
  rawLog(line);
  try { fs.appendFileSync(LOG, new Date().toLocaleTimeString('ko-KR') + ' ' + line + String.fromCharCode(10)); } catch (e) { }
};

// 목표 화면 주소를 곧바로 부르면 EIS가 세션 없음으로 응답하고 화면을 그리지 않는다.
// 포털의 근무시간 메뉴도 도착지가 아니라 이 입구를 부르며, 그때 EIS 쪽 SSO 사슬
// (RequestConnect → sso3 → Response → ssologin → login.do)이 돌아가 세션이 만들어지고
// 마지막에 indexQ.jsp 화면으로 도착한다 (2026-09-04 실측 — 사용자가 직접 이동한 경로를 기록)
const EIS_URL = 'https://eis2.etri.re.kr/eise/ssologin.jsp' +
                '?ssoType=quick&sysCls=portal&loginCls=sso&target=mis.gen::gen_4275.xfdl';
const CORE = fs.readFileSync(path.join(__dirname, 'widget-core.js'), 'utf8');
const REFRESH_MS = 5 * 60 * 1000;   // 화면 안이 아니므로 1.5초는 과하다
const LOAD_WAIT_MS = 25 * 1000;     // 이 안에 값이 안 나오면 로그인이 필요한 것으로 본다

let collectWin = null;   // EIS를 실제로 여는 창. 평소에는 숨어 있다
let widgetWin = null;    // 화면에 떠 있는 판
let tray = null;
let last = null;         // 마지막으로 읽은 값
let timer = null;

// ── 설정 (창 위치와 표시 여부만 기억한다) ────────────────────────────────
const CFG = path.join(app.getPath('userData'), 'settings.json');
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch (e) { return { showWidget: true, pos: null, loggedIn: false }; }
}
function saveCfg(c) {
  try { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); } catch (e) { }
}
let cfg = null;

// ── 수집 ────────────────────────────────────────────────────────────────
// 이 서버들은 빗금 없는 주소를 http로 되돌려 보내는데 http 포트는 닫혀 있어 흰 화면만
// 남는다 (2026-09-04 실측 — eis2와 etriware 양쪽에서). 스킴만 https로 되돌린다.
// 주소는 그대로이며 우회하는 것이 아니라 서버가 잘못 안내한 스킴을 고치는 것이다
function fixDowngrade() {
  session.fromPartition('persist:eis').webRequest.onBeforeRequest(
    { urls: ['http://*.etri.re.kr/*'] },
    function (details, cb) { cb({ redirectURL: details.url.replace(/^http:/, 'https:') }); }
  );
}

function createCollector() {
  collectWin = new BrowserWindow({
    show: false, width: 1400, height: 900, title: 'EIS 로그인',
    webPreferences: {
      partition: 'persist:eis',   // 세션을 디스크에 남겨 매번 로그인하지 않는다
      // EIS는 세션이 없으면 "세션이 만료 되었습니다" 대화상자를 띄우는데, 그 창이 뜬 동안
      // 페이지 실행이 멈춰 값을 읽을 수도 없다 (2026-09-04 실측). 알림이 떴다는 사실
      // 자체가 곧 "로그인이 필요하다"는 신호이므로 여기서는 대화상자를 아예 끈다
      disableDialogs: true,
      preload: path.join(__dirname, 'collect-preload.js'),
      contextIsolation: false     // preload가 페이지의 window.close를 덮어쓰려면 같은 world여야 한다
    }
  });
  collectWin.on('closed', function () { console.log('[closed] 수집 창이 파괴됐다'); });
  collectWin.webContents.on('render-process-gone', function (e, d) {
    console.log('[gone] 렌더러 종료:', JSON.stringify(d));
  });
  collectWin.on('close', function (e) {
    console.log('[close] 닫기 요청 — isQuitting=' + !!app.isQuitting);
    // 사용자가 로그인 창을 닫아도 앱은 트레이에 남는다. 닫는 것이 곧 "로그인을 마쳤다"는
    // 신호이므로 그때 다시 읽는다 — 로그인 뒤 EIS가 어느 화면으로 가 있든 상관없어진다
    if (app.isQuitting) return;
    console.log('[close] 수집 창이 닫히려 한다 — 주소:', collectWin.webContents.getURL().slice(0, 70));
    e.preventDefault();
    collectWin.hide();
    stopLoginWatch();
    setTimeout(refresh, 0);
  });
  // EIS 화면은 새 창으로 열리는 구조일 수 있는데, 새 창을 그냥 막으면 우리 창에는 흰
  // 화면만 남는다. 새 창을 만드는 대신 지금 창을 그 주소로 옮긴다
  collectWin.webContents.setWindowOpenHandler(function (d) {
    console.log('[popup] 새 창 요청 —', String(d.url).slice(0, 90));
    if (d.url && d.url.indexOf('http') === 0) collectWin.loadURL(d.url);
    return { action: 'deny' };
  });
  collectWin.webContents.on('did-navigate', function (e, url) { console.log('[nav]', url); });
  collectWin.webContents.on('did-finish-load', function () {
    console.log('[load]', collectWin.webContents.getURL());
    collectWin.webContents.executeJavaScript(CORE).catch(function () { });
  });
}

function alive() { return collectWin && !collectWin.isDestroyed(); }

let reading = false;
function readValue() {
  if (!alive()) return Promise.resolve(null);   // 종료 중에 타이머가 죽은 창을 읽으면 앱이 오류 창을 띄운다
  if (reading) return Promise.resolve(null);    // 페이지가 멈추면 앞선 요청이 대답하지 않고 쌓인다
  reading = true;
  return collectWin.webContents
    .executeJavaScript("localStorage.getItem('etri.eis.workWidget')")
    .then(function (s) { reading = false; return s ? JSON.parse(s) : null; })
    .catch(function () { reading = false; return null; });
}

// 로드 → 값이 나올 때까지 1초 간격으로 확인 → 안 나오면 로그인 창을 띄운다
let polling = false;
function refresh() {
  // 사용자가 로그인 중인데 새로 읽겠다고 페이지를 다시 부르면 입력하던 것이 날아간다
  if (!alive() || polling || collectWin.isVisible()) return;
  polling = true;
  const started = Date.now();
  collectWin.loadURL(EIS_URL);
  const poll = setInterval(function () {
    if (!alive()) { clearInterval(poll); polling = false; return; }
    // 시간 초과 판정은 응답을 기다리지 않고 먼저 한다. 세션이 없으면 페이지가 알림 창에
    // 붙들려 executeJavaScript가 영영 대답하지 않는 경우가 있다 (2026-09-04 실측)
    if (Date.now() - started > LOAD_WAIT_MS) {
      clearInterval(poll); polling = false;
      needLogin('값이 나오지 않았다');
      return;
    }
    readValue().then(function (d) {
      if (d && d.at && (!last || d.at > last.at) && alive()) {
        clearInterval(poll); polling = false;
        console.log('[ok] 값 획득', new Date(d.at).toLocaleTimeString('ko-KR'));
        apply(d);
        if (!cfg.loggedIn) { cfg.loggedIn = true; saveCfg(cfg); }   // 다음부터는 조용히 뜬다
        if (collectWin.isVisible()) collectWin.hide();   // 로그인을 마쳤으면 다시 숨는다
      }
    });
  }, 1000);
}

let loginWatch = null;
let portalNoticed = false;
function stopLoginWatch() { clearInterval(loginWatch); loginWatch = null; }

// 세션이 없으면 EIS는 화면 대신 "세션이 만료 되었습니다" 스크립트만 돌려주는데, 그 안의
// 되돌아가기 코드가 opener 없는 창에서 오류로 멈춘다. 그래서 우리가 대신 보낸다.
// 끝의 빗금이 있어야 한다 — 빗금 없는 주소는 서버가 http로 되돌려 보내고 그 포트는 닫혀
// 있다. 빗금이 있으면 그룹웨어(etriware.etri.re.kr/etriibp) 로그인으로 이어진다 (2026-09-04 실측)
const LOGIN_URL = 'https://etriware.etri.re.kr/etriibp/';   // EIS가 세션 없을 때 안내하는 그룹웨어 로그인

// 포털 첫 화면에 닿았을 때만 로그인이 끝난 것으로 본다. SSO 인증은 주소를 네 번 갈아타며
// 진행되는데, 그 사슬 한가운데에서 화면을 갈아 끼우면 인증이 끊긴다 (2026-09-04 실측 —
// sso3 Request.jsp를 로그인 완료로 오판했고 EIS가 세션 없음으로 응답했다)
function loginDone(url) {
  return /\/ptl\/(ptl_)?main\.jsp/.test(url);
}

function needLogin(why) {
  if (!alive() || collectWin.isVisible()) return;
  // 로그인할 수 있는 화면으로 보내고, 로그인을 마친 뒤 창을 닫으면 목표 화면을 다시 읽는다
  console.log('[login]', why, '— 현재 주소:', collectWin.webContents.getURL());
  collectWin.loadURL(LOGIN_URL);
  // 화면 밖으로 나가지 않게 주 모니터의 작업 영역 안에 맞춘다 (center는 여러 모니터에서
  // 창을 아래로 흘려보냈다 — 2026-09-04 실측)
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(1400, wa.width - 40), h = Math.min(900, wa.height - 40);
  collectWin.setBounds({
    x: wa.x + Math.round((wa.width - w) / 2),
    y: wa.y + Math.round((wa.height - h) / 2),
    width: w, height: h
  });
  collectWin.show();
  collectWin.focus();
  if (tray) tray.setToolTip('EIS 근무시간 — 로그인이 필요합니다');
  console.log('[login] 창 표시 여부', collectWin.isVisible(), JSON.stringify(collectWin.getBounds()));
  loginWatch = setInterval(function () {
    if (!alive()) { stopLoginWatch(); return; }
    const url = collectWin.webContents.getURL();
    // 로그인을 마쳐도 화면은 그룹웨어 포털에 머문다. 값은 EIS 쪽 저장소에 들어가므로
    // 그 화면으로 되돌려 보내지 않으면 영영 읽히지 않는다 (2026-09-04 실측 — 포털
    // main.jsp에 머문 채 '아직 값 없음'만 반복했다)
    // 자동으로 EIS 주소를 부르면 세션 없음으로 튕긴다 (2026-09-04 실측). EIS 세션은
    // 포털에서 메뉴를 눌러 넘어가는 절차가 만든다. 그래서 기다리며 이동 경로만 기록한다
    if (loginDone(url) && !portalNoticed) {
      portalNoticed = true;
      console.log('[login] 포털에 도착했다 — 근무시간 화면까지 직접 이동해 주세요');
      if (tray) tray.setToolTip('EIS 근무시간 — 포털에서 근무시간 화면을 열어 주세요');
    }
    readValue().then(function (d) {
      if (d && d.at && (!last || d.at > last.at) && alive()) {
        console.log('[ok] 로그인 뒤 값 획득');
        stopLoginWatch();
        portalNoticed = false;
        apply(d);
        if (!cfg.loggedIn) { cfg.loggedIn = true; saveCfg(cfg); }   // 다음부터는 조용히 뜬다
        collectWin.hide();
      } else if (alive()) {
        console.log('[wait] 아직 값 없음 — 보임:', collectWin.isVisible(), url.slice(0, 60));
      }
    });
  }, 3000);
}

function apply(d) {
  last = d;
  console.log('[data]', JSON.stringify(d));   // 값이 이상할 때 원본을 대조하기 위한 기록
  if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('eisw:data', d);
  updateTray();
}

// ── 표시 창 ─────────────────────────────────────────────────────────────
function createWidget() {
  const p = cfg.pos || defaultPos();
  widgetWin = new BrowserWindow({
    x: p.x, y: p.y, width: 620, height: 190,
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'widget-preload.js'), contextIsolation: false }
  });
  widgetWin.setAlwaysOnTop(true, 'screen-saver');   // 전체화면 앱 위에도 남는다
  widgetWin.loadFile(path.join(__dirname, 'widget.html'));
  widgetWin.once('ready-to-show', function () {
    if (cfg.showWidget) widgetWin.show();
    if (last) widgetWin.webContents.send('eisw:data', last);
  });
  widgetWin.on('moved', function () {
    const b = widgetWin.getBounds();
    cfg.pos = { x: b.x, y: b.y };
    saveCfg(cfg);
  });
}

function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - 640, y: wa.y + 20 };
}

function toggleWidget(on) {
  cfg.showWidget = on;
  saveCfg(cfg);
  if (!widgetWin || widgetWin.isDestroyed()) { createWidget(); return; }
  if (on) { widgetWin.show(); if (last) widgetWin.webContents.send('eisw:data', last); }
  else widgetWin.hide();
}

// ── 트레이 ──────────────────────────────────────────────────────────────
function hm(min) {
  if (min === null || min === undefined || isNaN(min)) return '–';
  const s = min < 0 ? '-' : '';
  const v = Math.abs(Math.round(min));
  return s + Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
}

function updateTray() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromDataURL(trayIcon(last ? last.pctNow : null)));
  tray.setToolTip(last
    ? ['EIS 근무시간',
       '잔여 · 현재까지      ' + hm(last.remainNow),
       '잔여 · 출근예정 포함 ' + hm(last.remainPlan),
       '달성률 ' + Math.round(last.pctNow * 100) + '%' +
         ' (출근예정 포함 ' + Math.round(last.pctPlan * 100) + '%)',
       new Date(last.at).toLocaleTimeString('ko-KR') + ' 기준'].join('\n')
    : 'EIS 근무시간 — 아직 값을 읽지 못했습니다');
  buildMenu();
}

function buildMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: last ? '잔여 ' + hm(last.remainNow) + '  (출근예정 포함 ' + hm(last.remainPlan) + ')'
                  : '값을 읽는 중…', enabled: false },
    { type: 'separator' },
    { label: '위젯 창 보이기', type: 'checkbox', checked: cfg.showWidget,
      click: function (mi) { toggleWidget(mi.checked); } },
    { label: '지금 새로 읽기', click: function () { refresh(); } },
    { type: 'separator' },
    { label: 'EIS 화면 열기', click: function () { collectWin.show(); collectWin.focus(); } },
    { label: '종료', click: function () { app.isQuitting = true; app.quit(); } }
  ]));
}

// ── 기동 ────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(function () {
    cfg = loadCfg();
    fixDowngrade();
    tray = new Tray(nativeImage.createFromDataURL(trayIcon(null)));
    tray.on('click', function () { toggleWidget(!cfg.showWidget); });
    createCollector();
    createWidget();
    updateTray();
    // 처음 쓰는 사람에게는 읽을 세션이 없다. 25초를 기다렸다 로그인 창을 띄우는 대신
    // 곧바로 띄운다
    if (cfg.loggedIn) refresh(); else needLogin('첫 실행이라 로그인한 적이 없다');
    timer = setInterval(refresh, REFRESH_MS);
  });

  ipcMain.on('eisw:hide', function () { toggleWidget(false); });
  ipcMain.on('eisw:refresh', function () { console.log('[refresh] 위젯에서 요청'); refresh(); });
  ipcMain.on('eisw:page-wants-close', function () {
    console.log('[page-close] 화면이 스스로 닫으려 했다 — 로그인이 필요하다는 뜻이다');
  });

  app.on('window-all-closed', function () { });   // 창을 다 닫아도 트레이로 남는다
  app.on('before-quit', function () {
    app.isQuitting = true;
    clearInterval(timer);
    stopLoginWatch();
    polling = true;      // 남은 poll이 한 바퀴 더 돌아도 죽은 창을 건드리지 않는다
  });
}
