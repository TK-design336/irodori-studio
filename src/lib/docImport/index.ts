export type DocSection = {
  heading: string | null;
  level: number;
  text: string;
  lineCount: number;
  charCount: number;
};

export type ParsedDoc = {
  fileName: string;
  format: "txt" | "md" | "docx" | "pdf";
  sections: DocSection[];
  warnings: string[];
};

export type DocImportOptions = {
  includeTables?: boolean;
  includeCaptions?: boolean;
  skipReferences?: boolean;
};

export async function parseDocFile(
  file: File,
  options: DocImportOptions = {},
): Promise<ParsedDoc> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt")) {
    const { parseTxt } = await import("./parseTxt");
    return parseTxt(file);
  }
  if (name.endsWith(".md") || name.endsWith(".markdown")) {
    const { parseMd } = await import("./parseMd");
    return parseMd(file, options);
  }
  if (name.endsWith(".docx")) {
    const { parseDocx } = await import("./parseDocx");
    return parseDocx(file);
  }
  if (name.endsWith(".pdf")) {
    const { parsePdf } = await import("./parsePdf");
    return parsePdf(file, options);
  }
  throw new Error(`未対応のファイル形式です: ${file.name}`);
}

export const SUPPORTED_EXTENSIONS = [".txt", ".md", ".markdown", ".docx", ".pdf"];

export function isSupportedDocName(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isSupportedDocFile(file: File): boolean {
  return isSupportedDocName(file.name);
}

export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const fromFiles = Array.from(dt.files ?? []);
  if (fromFiles.length > 0) return fromFiles;
  const fromItems: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) fromItems.push(f);
    }
  }
  return fromItems;
}

/** dragover/enter で drop を許可する。OS ドロップでは items が空のことがある。 */
export function acceptFileDrag(e: {
  preventDefault: () => void;
  stopPropagation: () => void;
  dataTransfer: DataTransfer | null;
}): void {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

export function sectionText(sections: DocSection[], selectedIds: Set<number>): string {
  return sections
    .filter((_, i) => selectedIds.has(i))
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");
}
