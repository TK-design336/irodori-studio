import type { DocSection, DocImportOptions, ParsedDoc } from "./index";

function stripMarkdown(text: string, includeTables: boolean): string {
  let out = text;

  // コードブロック除去
  out = out.replace(/```[\s\S]*?```/g, "");
  out = out.replace(/~~~[\s\S]*?~~~/g, "");

  // インラインコード除去
  out = out.replace(/`[^`]*`/g, "");

  // テーブル除去（オプションで制御）
  if (!includeTables) {
    out = out.replace(/^\|.*\|.*$/gm, "");
    out = out.replace(/^\|?[\s-:|]+\|[\s-:|]*\|?$/gm, "");
  }

  // HTML コメント除去
  out = out.replace(/<!--[\s\S]*?-->/g, "");

  // 画像記法除去（alt テキストも除去）
  out = out.replace(/!\[.*?\]\(.*?\)/g, "");

  // リンク記法 → テキストのみ残す
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 脚注参照除去
  out = out.replace(/\[\^[^\]]+\]/g, "");

  // 脚注定義除去
  out = out.replace(/^\[\^[^\]]+\]:.*$/gm, "");

  // URL 除去
  out = out.replace(/https?:\/\/[^\s)>]+/g, "");

  // 太字・斜体・取り消し線
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, "$1");
  out = out.replace(/___(.+?)___/g, "$1");
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  out = out.replace(/__(.+?)__/g, "$1");
  out = out.replace(/\*(.+?)\*/g, "$1");
  out = out.replace(/_(.+?)_/g, "$1");
  out = out.replace(/~~(.+?)~~/g, "$1");

  // 見出し記号除去
  out = out.replace(/^#{1,6}\s+/gm, "");

  // 水平線除去
  out = out.replace(/^[-*_]{3,}\s*$/gm, "");

  // 引用記号除去
  out = out.replace(/^>\s?/gm, "");

  // リストマーカー除去
  out = out.replace(/^[ \t]*[-*+]\s+/gm, "");
  out = out.replace(/^[ \t]*\d+\.\s+/gm, "");

  // 複数の空行を 1 つにまとめる
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

export async function parseMd(file: File, options: DocImportOptions = {}): Promise<ParsedDoc> {
  const warnings: string[] = [];
  const buffer = await file.arrayBuffer();
  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    const Encoding = (await import("encoding-japanese")).default;
    const bytes = new Uint8Array(buffer);
    const detected = Encoding.detect(bytes);
    text = Encoding.convert(bytes, { to: "UNICODE", from: detected || "SJIS", type: "string" }) as string;
    warnings.push(`文字コード ${detected || "SJIS"} として読み込みました`);
  }

  const includeTables = options.includeTables ?? false;
  const lines = text.split(/\r?\n/);
  const sections: DocSection[] = [];

  let currentHeading: string | null = null;
  let currentLevel = 0;
  let currentLines: string[] = [];

  const flushSection = () => {
    const raw = currentLines.join("\n");
    const stripped = stripMarkdown(raw, includeTables);
    if (!stripped.trim()) return;
    const textLines = stripped.split(/\n/).filter((l) => l.trim());
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      text: stripped,
      lineCount: textLines.length,
      charCount: stripped.replace(/\s/g, "").length,
    });
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushSection();
      currentLevel = headingMatch[1].length;
      currentHeading = headingMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flushSection();

  if (sections.length === 0) {
    // 見出しがない場合は全体を 1 セクションとして扱う
    const stripped = stripMarkdown(text, includeTables);
    if (stripped.trim()) {
      const textLines = stripped.split(/\n/).filter((l) => l.trim());
      sections.push({
        heading: null,
        level: 0,
        text: stripped,
        lineCount: textLines.length,
        charCount: stripped.replace(/\s/g, "").length,
      });
    } else {
      warnings.push("テキストが空です");
    }
  }

  return { fileName: file.name, format: "md", sections, warnings };
}
