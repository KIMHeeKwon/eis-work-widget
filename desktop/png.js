// 16x16 트레이 아이콘을 그때그때 그리기 위한 최소 PNG 인코더.
//
// 트레이 아이콘은 main 프로세스가 만들어야 하는데 거기에는 canvas가 없다. 외부 이미지
// 라이브러리를 하나 더 들이는 것보다, 필요한 만큼만 직접 쓰는 편이 가볍다.
// RGBA 무필터 PNG만 만든다 — 아이콘 한 장에 그 이상은 필요 없다.

const zlib = require('zlib');

const CRC = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// rgba: 길이 w*h*4인 Uint8Array
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                                  // 필터 타입 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type 6 = RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 달성률을 아래에서 위로 채우는 막대 아이콘. 숫자를 16px에 그리면 읽히지 않아서
// 채움 높이로 대신한다. 값이 없을 때(pct === null)는 테두리만 그린다.
function trayIcon(pct) {
  const S = 16;
  const px = new Uint8Array(S * S * 4);
  const put = function (x, y, r, g, b, a) {
    const i = (y * S + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const A = [0x59, 0x80, 0xa6];        // 강조색 #5980a6
  const D = [0x1d, 0x1f, 0x20];        // 텍스트색 #1d1f20

  for (let y = 1; y < S - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const edge = x === 1 || x === S - 2 || y === 1 || y === S - 2;
      if (edge) put(x, y, D[0], D[1], D[2], 150);
    }
  }
  if (pct !== null) {
    const fill = Math.max(0, Math.min(1, pct));
    const top = Math.round((S - 4) - fill * (S - 4)) + 2;
    for (let y = top; y <= S - 3; y++)
      for (let x = 3; x <= S - 4; x++) put(x, y, A[0], A[1], A[2], 255);
  }
  return 'data:image/png;base64,' + encodePNG(S, S, px).toString('base64');
}

module.exports = { encodePNG, trayIcon };
