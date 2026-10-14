// PDF → 纯文本。pdfjs legacy build 无原生依赖，可在 Android/Termux 运行。
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AppError } from './errors.js';

const PAGE_NO = [/^\s*[-—–]?\s*\d{1,3}\s*[-—–]?\s*$/, /^\s*第\s*\d+\s*页(\s*[\/／共]\s*\d+\s*页?)?\s*$/, /^\s*\d+\s*\/\s*\d+\s*$/];
const NEW_BLOCK = /^(第[一二三四五六七八九十百零〇\d]+条|\d{1,2}(\.\d{1,2})*[\.、\s]|[（(][一二三四五六七八九十\d]+[）)]|[一二三四五六七八九十]+、|甲方|乙方|丙方|地址|法定代表人|授权代表|日期|合同编号|附件)/;
const END_PUNCT = /[。；;：:！!？?）)」”"]$/;

export async function pdfToText(buffer) {
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new AppError('PDF_ENCRYPTED', '该 PDF 已加密，请先解除密码保护后再上传');
    throw new AppError('PDF_PARSE_FAILED', 'PDF 文件无法解析，可能已损坏，请换一份文件试试');
  }
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let cur = '';
    for (const it of content.items) {
      if (typeof it.str !== 'string') continue;
      cur += it.str;
      if (it.hasEOL) { lines.push(cur); cur = ''; }
    }
    if (cur) lines.push(cur);
  }
  await doc.destroy();
  return reflow(lines);
}

// 合并 PDF 排版造成的句中折行：仅当本行“接近满行”且不以句末标点结尾、下一行不是新块起始时才合并
export function reflow(rawLines) {
  const lines = rawLines.map((l) => l.replace(/\s+$/g, '')).filter((l) => !PAGE_NO.some((re) => re.test(l)));
  const lens = lines.map((l) => l.length).filter((n) => n > 0).sort((a, b) => a - b);
  const full = lens.length ? lens[Math.floor(lens.length * 0.9)] : 0;
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const trimmed = line.trim();
    if (prev !== undefined && prev.trim() && trimmed && full > 10 &&
        prev.length >= full * 0.8 && !END_PUNCT.test(prev.trim()) && !NEW_BLOCK.test(trimmed)) {
      out[out.length - 1] = prev + trimmed;
    } else {
      out.push(line);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
