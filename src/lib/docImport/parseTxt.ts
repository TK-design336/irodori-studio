import type { DocSection, ParsedDoc } from "./index";

async function decodeFile(file: File): Promise<{ text: string; encoding: string }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // BOM チェック
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(buffer), encoding: "UTF-8 (BOM)" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buffer), encoding: "UTF-16 LE" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buffer), encoding: "UTF-16 BE" };
  }

  // UTF-8 を試みる
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(buffer);
    return { text, encoding: "UTF-8" };
  } catch {
    // UTF-8 失敗 → encoding-japanese で Shift-JIS などを判別
    const Encoding = (await import("encoding-japanese")).default;
    const detected = Encoding.detect(bytes);
    const converted = Encoding.convert(bytes, { to: "UNICODE", from: detected || "SJIS", type: "string" });
    return { text: converted as string, encoding: detected || "SJIS" };
  }
}

export async function parseTxt(file: File): Promise<ParsedDoc> {
  const warnings: string[] = [];
  const { text, encoding } = await decodeFile(file);

  if (encoding !== "UTF-8" && encoding !== "UTF-8 (BOM)") {
    warnings.push(`文字コード ${encoding} として読み込みました`);
  }

  // 空行区切りで段落を分割
  const rawParagraphs = text.split(/\r?\n(?:\r?\n)+/);
  const sections: DocSection[] = [];

  for (const para of rawParagraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const lines = trimmed.split(/\r?\n/);
    sections.push({
      heading: null,
      level: 0,
      text: trimmed,
      lineCount: lines.length,
      charCount: trimmed.replace(/\s/g, "").length,
    });
  }

  // 段落が 1 つしかない場合は行ごとに分割（行数が多い場合）
  if (sections.length === 1 && sections[0].lineCount > 20) {
    const lines = sections[0].text.split(/\r?\n/);
    const chunked: DocSection[] = [];
    const chunkSize = 50;
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunk = lines.slice(i, i + chunkSize).join("\n");
      chunked.push({
        heading: `行 ${i + 1}〜${Math.min(i + chunkSize, lines.length)}`,
        level: 1,
        text: chunk,
        lineCount: Math.min(chunkSize, lines.length - i),
        charCount: chunk.replace(/\s/g, "").length,
      });
    }
    return { fileName: file.name, format: "txt", sections: chunked, warnings };
  }

  if (sections.length === 0) {
    warnings.push("テキストが空です");
  }

  return { fileName: file.name, format: "txt", sections, warnings };
}
