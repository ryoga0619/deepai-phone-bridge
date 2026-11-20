// QR コードの描画ヘルパー（生成は qr-impl.mjs の実装を使用）
import { QrCode } from "./qr-impl.mjs";

/** QR をテキスト（端末表示用）にする */
export function qrToText(text, { margin = 2 } = {}) {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const size = qr.size;
  const lines = [];
  for (let y = -margin; y < size + margin; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = y >= 0 && y < size && qr.getModule(x, y);
      const bottom = y + 1 >= 0 && y + 1 < size && qr.getModule(x, y + 1);
      if (top && bottom) line += "██";
      else if (top) line += "▀▀";
      else if (bottom) line += "▄▄";
      else line += "  ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** QR を SVG にする（スマホ側は二维码スキャン、または URL 表示） */
export function qrToSvg(text, { margin = 4, size = 240 } = {}) {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const n = qr.size;
  const total = n + margin * 2;
  const scale = size / total;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.getModule(x, y)) path += `M${x + margin},${y + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
