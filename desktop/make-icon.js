// 실행파일에 붙일 아이콘(icon.ico)을 그린다.
//   실행: node make-icon.js
//
// 트레이 아이콘과 같은 얼굴을 쓰되 크기만 키운다. 그림 파일을 저장소에 들고 다니는 대신
// 필요할 때 다시 그리는 편이, 색을 바꿀 때 한 곳만 고치면 되어 낫다.
// ICO는 비스타 이후로 PNG를 그대로 품을 수 있어서 png.js를 그대로 쓴다.

const fs = require('fs');
const path = require('path');
const { encodePNG } = require('./png.js');

const BG = [0xf5, 0xf5, 0xf8];      // 위젯 바탕색
const LINE = [0x1d, 0x1f, 0x20];    // 테두리
const A = [0x59, 0x80, 0xa6];       // 강조색
const FILL = 0.62;                  // 막대가 차 있는 정도. 값이 아니라 얼굴이다

function draw(S) {
  const px = new Uint8Array(S * S * 4);
  const put = function (x, y, c, a) {
    const i = (y * S + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a;
  };
  const b = Math.max(1, Math.round(S / 16));        // 테두리 굵기
  const pad = Math.max(2, Math.round(S * 0.22));    // 막대와 테두리 사이

  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const edge = x < b || y < b || x >= S - b || y >= S - b;
      put(x, y, edge ? LINE : BG, edge ? 190 : 255);
    }

  const top = Math.round(S - pad - (S - pad * 2) * FILL);
  for (let y = top; y < S - pad; y++)
    for (let x = pad; x < S - pad; x++) put(x, y, A, 255);

  return encodePNG(S, S, px);
}

// ICO 묶기. 머리말 6바이트 + 크기마다 16바이트 항목 + PNG 본문들
const SIZES = [16, 32, 64, 128, 256];
const imgs = SIZES.map(draw);
const head = Buffer.alloc(6);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(SIZES.length, 4);

let off = 6 + 16 * SIZES.length;
const dir = SIZES.map(function (s, i) {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;   // 256은 0으로 적는 것이 규격이다
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4);      // 색 평면
  e.writeUInt16LE(32, 6);     // 픽셀당 비트
  e.writeUInt32LE(imgs[i].length, 8);
  e.writeUInt32LE(off, 12);
  off += imgs[i].length;
  return e;
});

const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, Buffer.concat([head].concat(dir, imgs)));
console.log('icon.ico ' + fs.statSync(out).size + ' bytes · ' + SIZES.join('/') + 'px');
