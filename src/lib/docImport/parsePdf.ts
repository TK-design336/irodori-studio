// pdfjs-dist の worker を Vite が URL として解決する
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { DocSection, DocImportOptions, ParsedDoc } from "./index";

async function getPdfJs() {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfjs;
}

type PdfTextItem = {
  str: string;
  transform: number[];
  height: number;
  width: number;
  fontName: string;
};

type PageTokens = {
  items: PdfTextItem[];
  viewport: { width: number; height: number };
};

// ─── 後処理ユーティリティ ────────────────────────────────────

/** Y 座標（ページ上端基準に変換） */
function itemY(item: PdfTextItem, pageHeight: number): number {
  return pageHeight - item.transform[5];
}

/** X 座標 */
function itemX(item: PdfTextItem): number {
  return item.transform[4];
}

/** 全ページで同じ Y 座標帯に繰り返し出現する行（ヘッダ・フッタ候補）を除去 */
function removeHeaderFooter(pages: PageTokens[]): PageTokens[] {
  if (pages.length < 3) return pages;

  // 各ページの Y 座標集合（丸め 5pt）
  const yCountMap = new Map<number, number>();
  for (const page of pages) {
    const yset = new Set<number>();
    for (const item of page.items) {
      const y = Math.round(itemY(item, page.viewport.height) / 5) * 5;
      yset.add(y);
    }
    for (const y of yset) {
      yCountMap.set(y, (yCountMap.get(y) ?? 0) + 1);
    }
  }

  const threshold = Math.floor(pages.length * 0.6);
  const commonY = new Set(
    [...yCountMap.entries()]
      .filter(([, cnt]) => cnt >= threshold)
      .map(([y]) => y),
  );

  return pages.map((page) => ({
    ...page,
    items: page.items.filter((item) => {
      const y = Math.round(itemY(item, page.viewport.height) / 5) * 5;
      return !commonY.has(y);
    }),
  }));
}

/** 2段組検出: ページ幅の中央で分割し、左カラム → 右カラムの順に並べ替え */
function reorderColumns(page: PageTokens): PdfTextItem[] {
  const midX = page.viewport.width / 2;
  const leftItems = page.items.filter((it) => itemX(it) < midX);
  const rightItems = page.items.filter((it) => itemX(it) >= midX);

  // Y 座標で並べ替え
  const sortByY = (a: PdfTextItem, b: PdfTextItem) =>
    itemY(a, page.viewport.height) - itemY(b, page.viewport.height);

  // 2段組かどうかの簡易判定: 左右両側にテキストがある行が多い
  const leftYs = new Set(leftItems.map((it) => Math.round(itemY(it, page.viewport.height))));
  const rightYs = new Set(rightItems.map((it) => Math.round(itemY(it, page.viewport.height))));
  let overlap = 0;
  for (const y of leftYs) {
    for (const ry of rightYs) {
      if (Math.abs(y - ry) <= 3) { overlap++; break; }
    }
  }
  const isTwoColumn =
    leftItems.length > 5 &&
    rightItems.length > 5 &&
    overlap / Math.max(leftYs.size, 1) > 0.3;

  if (isTwoColumn) {
    return [...leftItems.sort(sortByY), ...rightItems.sort(sortByY)];
  }
  return [...page.items].sort(sortByY);
}

/** テキストアイテムを段落にまとめる */
function buildParagraphs(
  sortedItems: PdfTextItem[],
  pageHeight: number,
): string[] {
  if (sortedItems.length === 0) return [];

  const lines: Array<{ y: number; text: string; height: number }> = [];
  let currentLine: { y: number; items: PdfTextItem[] } | null = null;

  for (const item of sortedItems) {
    if (!item.str.trim() && item.width === 0) continue;
    const y = Math.round(itemY(item, pageHeight));
    if (!currentLine || Math.abs(y - currentLine.y) > (item.height || 10) * 0.5) {
      if (currentLine) {
        const text = currentLine.items.map((i) => i.str).join("").trim();
        if (text) {
          lines.push({
            y: currentLine.y,
            text,
            height: currentLine.items[0]?.height ?? 10,
          });
        }
      }
      currentLine = { y, items: [item] };
    } else {
      currentLine.items.push(item);
    }
  }
  if (currentLine) {
    const text = currentLine.items.map((i) => i.str).join("").trim();
    if (text) {
      lines.push({ y: currentLine.y, text, height: currentLine.items[0]?.height ?? 10 });
    }
  }

  // 行末ハイフン連結
  const joined: typeof lines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.text.endsWith("-") && i + 1 < lines.length) {
      joined.push({
        ...line,
        text: line.text.slice(0, -1) + lines[i + 1].text,
      });
      i++;
    } else {
      joined.push(line);
    }
  }

  // 段落境界の検出（行間が広い or 行先頭が字下げされている）
  const paragraphs: string[] = [];
  let paraBuf: string[] = [];

  for (let i = 0; i < joined.length; i++) {
    const line = joined[i];
    const prevLine = i > 0 ? joined[i - 1] : null;

    const lineGap = prevLine ? Math.abs(line.y - prevLine.y) : 0;
    const isNewPara =
      prevLine &&
      (lineGap > (line.height || 10) * 1.8);

    if (isNewPara && paraBuf.length > 0) {
      paragraphs.push(paraBuf.join(""));
      paraBuf = [];
    }
    paraBuf.push(line.text);
  }
  if (paraBuf.length > 0) paragraphs.push(paraBuf.join(""));

  return paragraphs.filter(Boolean);
}

/** 脚注番号を除去 */
function removeFootnoteNumbers(text: string): string {
  // 上付き数字 ¹²³ など
  return text
    .replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]+/g, "")
    .replace(/\[[\d,\s]+\]/g, "");
}

/** 参考文献セクション以降を除去 */
function splitAtReferences(paragraphs: string[]): { main: string[]; ref: string[] } {
  const refPattern = /^(参考文献|References?|Bibliography|文献|引用文献)/i;
  const idx = paragraphs.findIndex((p) => refPattern.test(p.trim()));
  if (idx === -1) return { main: paragraphs, ref: [] };
  return { main: paragraphs.slice(0, idx), ref: paragraphs.slice(idx) };
}

/** 図表キャプション候補の検出 */
function isCaptionLike(text: string): boolean {
  return /^(図|表|Figure|Table|Fig\.)\s*\d+/i.test(text.trim());
}

// ─── メインエクスポート ────────────────────────────────────

export async function parsePdf(
  file: File,
  options: DocImportOptions = {},
): Promise<ParsedDoc> {
  const warnings: string[] = [];
  const skipReferences = options.skipReferences ?? true;
  const includeCaptions = options.includeCaptions ?? false;

  const pdfjs = await getPdfJs();
  const buffer = await file.arrayBuffer();

  let pdfDoc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    pdfDoc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  } catch (e) {
    throw new Error(`PDF の読み込みに失敗しました: ${e instanceof Error ? e.message : e}`);
  }

  const numPages = pdfDoc.numPages;
  const allPageTokens: PageTokens[] = [];
  let hasTextLayer = false;

  for (let p = 1; p <= numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const items = content.items
      .filter((it): it is typeof it & PdfTextItem => "str" in it && typeof (it as { str?: unknown }).str === "string")
      .map((it) => it as unknown as PdfTextItem)
      .filter((it) => it.str.trim() !== "");

    if (items.length > 0) hasTextLayer = true;

    allPageTokens.push({
      items,
      viewport: { width: viewport.width, height: viewport.height },
    });
  }

  if (!hasTextLayer) {
    warnings.push(
      "このPDFはテキスト層を持ちません（スキャン PDF の可能性があります）。" +
      "OCR処理は未対応のため、インポートできませんでした。",
    );
    return { fileName: file.name, format: "pdf", sections: [], warnings };
  }

  // ヘッダ・フッタ除去
  const cleanedPages = removeHeaderFooter(allPageTokens);

  // 段落収集
  const allParagraphs: string[] = [];
  for (const page of cleanedPages) {
    const sorted = reorderColumns(page);
    const paras = buildParagraphs(sorted, page.viewport.height);
    allParagraphs.push(...paras);
  }

  // 脚注番号除去・キャプション処理
  const processed = allParagraphs
    .map(removeFootnoteNumbers)
    .filter((p) => {
      if (isCaptionLike(p) && !includeCaptions) return false;
      return true;
    })
    .filter((p) => p.trim().length > 0);

  // 参考文献セクション
  const { main, ref } = splitAtReferences(processed);
  const usedParas = skipReferences ? main : [...main, ...ref];

  if (ref.length > 0 && skipReferences) {
    warnings.push("参考文献セクションをスキップしました（プレビューで変更可能）");
  }

  // 見出し候補を検出してセクション化（フォントが大きい or 短い行）
  const sections: DocSection[] = [];
  let currentHeading: string | null = null;
  let currentLevel = 0;
  const currentParas: string[] = [];

  const flushSection = () => {
    const text = currentParas.join("\n\n").trim();
    if (!text) return;
    const lineCount = text.split(/\n/).filter((l) => l.trim()).length;
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      text,
      lineCount,
      charCount: text.replace(/\s/g, "").length,
    });
  };

  // 簡易見出し判定: 短い（< 40字）かつ末尾が句点でない段落
  const headingPattern = /^(\d+[\.\s]|第\d+[章節]|Chapter\s+\d+|Section\s+\d+)/i;
  for (const para of usedParas) {
    const trimmed = para.trim();
    const isHeadingLike =
      trimmed.length < 60 &&
      !trimmed.endsWith("。") &&
      !trimmed.endsWith(".") &&
      headingPattern.test(trimmed);

    if (isHeadingLike) {
      flushSection();
      currentParas.length = 0;
      currentHeading = trimmed;
      currentLevel = 1;
    } else {
      currentParas.push(para);
    }
  }
  flushSection();

  if (sections.length === 0 && usedParas.length > 0) {
    const text = usedParas.join("\n\n");
    sections.push({
      heading: null,
      level: 0,
      text,
      lineCount: text.split(/\n/).filter((l) => l.trim()).length,
      charCount: text.replace(/\s/g, "").length,
    });
  }

  if (sections.length === 0) {
    warnings.push("テキストが空です");
  }

  return { fileName: file.name, format: "pdf", sections, warnings };
}
