// 유저스크립트 하나에서 크롬 확장과 북마클릿을 뽑아낸다.  실행: node build.js
//
// 여러 벌을 손으로 관리하면 반드시 어긋나므로, 위젯을 고칠 때는 .user.js만 고치고
// 이 스크립트를 다시 돌린다.
//
// 개행은 지우지 않고 그대로 인코딩한다. 줄을 이어 붙이면 세미콜론이 없는 자리에서
// 자동 세미콜론 삽입이 엉뚱하게 동작할 수 있는데, 그 위험을 감수할 이유가 없다.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'eis-work-widget.user.js');
const OUT = path.join(__dirname, 'eis-work-widget.bookmarklet.txt');
const EXT = path.join(__dirname, 'extension', 'widget.js');
const DESK = path.join(__dirname, 'desktop', 'widget-core.js');

let src = fs.readFileSync(SRC, 'utf8');

// 1) 유저스크립트 머리말은 Tampermonkey만 읽는다. 확장과 북마클릿에는 필요 없다.
const end = src.indexOf('// ==/UserScript==');
if (end < 0) throw new Error('유저스크립트 머리말을 찾지 못했다');
src = src.slice(end + '// ==/UserScript=='.length);

// 1-1) 크롬 확장의 content script는 주소창을 거치지 않으므로 원본을 그대로 쓴다.
//      주석도 남겨 두는 편이 나중에 읽기 좋다.
const ext = '// 이 파일은 build.js가 eis-work-widget.user.js에서 생성한다. 직접 고치지 말 것.' + src;
new Function(ext);
fs.writeFileSync(EXT, ext, 'utf8');
fs.writeFileSync(DESK, ext, 'utf8');   // 데스크톱 앱도 같은 코드를 쓴다 (수집 창 주입 + 표시 창 렌더)

// 2) 줄 전체가 주석인 줄만 지운다. 줄 끝 주석은 문자열 안의 "//"와 구별하기
//    어려우므로 그냥 둔다 — 개행을 살려 두었으니 남아 있어도 안전하다.
const code = src
  .split('\n')
  .filter(function (l) { return !/^\s*\/\//.test(l); })
  .map(function (l) { return l.trim(); })
  .filter(function (l) { return l.length; })
  .join('\n');

// 3) 브라우저에 넣기 전에 문법을 확인한다. 여기서 걸리면 북마클릿도 안 돈다.
new Function(code);

const bookmarklet = 'javascript:' + encodeURIComponent(code);

// 4) 왕복 확인. 주소창을 거치며 글자가 깨지면 한글 라벨부터 조용히 망가진다.
const back = decodeURIComponent(bookmarklet.slice('javascript:'.length));
if (back !== code) throw new Error('인코딩 왕복이 일치하지 않는다');

// 5) 지워지면 안 되는 조각들이 살아 있는지 본다. 주석 제거가 코드를 먹었는지 잡는다.
['output9:input', 'position:static;overflow:visible', 'M12 78 A62 62 0 0 1 136 78',
 '달성률 · 출장·휴일 포함', '남은시간'].forEach(function (frag) {
  if (code.indexOf(frag) < 0) throw new Error('조각이 사라졌다: ' + frag);
  if (ext.indexOf(frag) < 0) throw new Error('확장에서 조각이 사라졌다: ' + frag);
});

fs.writeFileSync(OUT, bookmarklet, 'utf8');

console.log('원본     ' + fs.readFileSync(SRC).length.toLocaleString() + ' bytes');
console.log('확장     ' + Buffer.byteLength(ext).toLocaleString() + ' bytes  (문법 검사 통과) → extension/widget.js');
console.log('코드     ' + Buffer.byteLength(code).toLocaleString() + ' bytes  (문법 검사 통과)');
console.log('북마클릿 ' + bookmarklet.length.toLocaleString() + ' chars → ' + path.basename(OUT));
