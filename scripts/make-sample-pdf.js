// 由 samples/sample-contract.txt 生成 samples/sample-contract.pdf（中文字体取系统 Noto CJK，可用 CJK_FONT 覆盖）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.CJK_FONT,
  path.join(root, '.cache/NotoSansSC.ttf'),
  '/system/fonts/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/PingFang.ttc',
].filter(Boolean);
const fontPath = candidates.find((p) => fs.existsSync(p));
if (!fontPath) { console.error('未找到中文字体：请下载 NotoSansSC 到 .cache/NotoSansSC.ttf 或设置 CJK_FONT（需 TrueType 轮廓）'); process.exit(1); }

const text = fs.readFileSync(path.join(root, 'samples/sample-contract.txt'), 'utf8');
const out = path.join(root, 'samples/sample-contract.pdf');
const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 64, right: 64 } });
doc.pipe(fs.createWriteStream(out));
if (fontPath.endsWith('.ttc')) doc.registerFont('cjk', fontPath, 'NotoSansCJKSC-Regular');
else doc.registerFont('cjk', fontPath);
doc.font('cjk');

const lines = text.split('\n');
lines.forEach((line, i) => {
  if (i === 0) { doc.fontSize(18).text(line, { align: 'center' }); doc.moveDown(0.6); return; }
  const isArticle = /^第[一二三四五六七八九十]+条/.test(line);
  doc.fontSize(isArticle ? 11.5 : 10.5);
  if (isArticle) doc.moveDown(0.3);
  doc.text(line || ' ', { lineGap: 3 });
});
doc.end();
console.log('已生成', out, '字体:', fontPath);
