import type { DocSection, ParsedDoc } from "./index";

export async function parseDocx(file: File): Promise<ParsedDoc> {
  const mammoth = await import("mammoth");
  const buffer = await file.arrayBuffer();
  const warnings: string[] = [];

  // HTML 変換で見出し構造を取得
  const htmlResult = await mammoth.convertToHtml(
    { arrayBuffer: buffer },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1",
        "p[style-name='Heading 2'] => h2",
        "p[style-name='Heading 3'] => h3",
        "p[style-name='Heading 4'] => h4",
        "p[style-name='Heading 5'] => h5",
        "p[style-name='Heading 6'] => h6",
        "p[style-name='見出し 1'] => h1",
        "p[style-name='見出し 2'] => h2",
        "p[style-name='見出し 3'] => h3",
        "p[style-name='見出し 4'] => h4",
        "p[style-name='見出し 5'] => h5",
        "p[style-name='見出し 6'] => h6",
      ],
    },
  );

  for (const msg of htmlResult.messages) {
    if (msg.type === "warning") {
      warnings.push(msg.message);
    }
  }

  const html = htmlResult.value;
  const sections: DocSection[] = [];

  // HTML を疑似的にパース（DOMParser が使える環境前提）
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const body = doc.body;

  let currentHeading: string | null = null;
  let currentLevel = 0;
  const currentParas: string[] = [];

  const flushSection = () => {
    const text = currentParas.join("\n").trim();
    if (!text) return;
    const textLines = text.split(/\n/).filter((l) => l.trim());
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      text,
      lineCount: textLines.length,
      charCount: text.replace(/\s/g, "").length,
    });
  };

  for (const el of Array.from(body.children)) {
    const tag = el.tagName.toLowerCase();
    const headingMatch = /^h([1-6])$/.exec(tag);
    if (headingMatch) {
      flushSection();
      currentParas.length = 0;
      currentLevel = Number(headingMatch[1]);
      currentHeading = el.textContent?.trim() ?? null;
    } else {
      const text = el.textContent?.trim() ?? "";
      if (text) currentParas.push(text);
    }
  }
  flushSection();

  if (sections.length === 0) {
    // 見出しなし → テキスト全体を 1 セクションとして扱う
    const rawResult = await mammoth.extractRawText({ arrayBuffer: buffer });
    const text = rawResult.value.trim();
    if (text) {
      const textLines = text.split(/\n/).filter((l) => l.trim());
      sections.push({
        heading: null,
        level: 0,
        text,
        lineCount: textLines.length,
        charCount: text.replace(/\s/g, "").length,
      });
    } else {
      warnings.push("テキストが空です");
    }
  }

  return { fileName: file.name, format: "docx", sections, warnings };
}
