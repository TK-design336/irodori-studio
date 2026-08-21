export type AnnotationKind = "english" | "heteronym" | "numeric";

export type AnnotationCandidate = {
  reading: string;
  label?: string;
};

export type DetectedAnnotation = {
  kind: AnnotationKind;
  start: number;
  end: number;
  surface: string;
  candidates: AnnotationCandidate[];
};

export type AppliedReading = {
  id: string;
  kind: AnnotationKind;
  start: number;
  end: number;
  surface: string;
  reading: string;
};

export function newReadingId(): string {
  return crypto.randomUUID();
}

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function sliceAt(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join("");
}

/** Drop readings whose span no longer matches surface in text. */
export function validateReadings(text: string, readings: AppliedReading[]): AppliedReading[] {
  return readings.filter((r) => {
    if (r.start < 0 || r.end > [...text].length || r.start >= r.end) return false;
    return sliceAt(text, r.start, r.end) === r.surface;
  });
}

/** Unicode code-point span replacement (matches Python start/end). */
export function buildSynthText(text: string, readings: AppliedReading[]): string {
  if (readings.length === 0) return text;
  const chars = [...text];
  const sorted = [...readings]
    .filter((r) => r.reading.trim().length > 0)
    .sort((a, b) => b.start - a.start);
  for (const r of sorted) {
    const repl = [...r.reading];
    chars.splice(r.start, r.end - r.start, ...repl);
  }
  return chars.join("");
}

export function synthTextForLine(
  text: string,
  applied: AppliedReading[] | undefined,
): string {
  return buildSynthText(text, validateReadings(text, applied ?? []));
}

export function isNovelCandidate(
  annotation: DetectedAnnotation,
  reading: string,
): boolean {
  const t = reading.trim();
  if (!t) return false;
  return !annotation.candidates.some((c) => c.reading === t);
}

/** Pending warnings: not overlapping a reading already chosen for this line. */
export function filterPendingAnnotations(
  detected: DetectedAnnotation[],
  applied: AppliedReading[],
): DetectedAnnotation[] {
  return detected.filter(
    (a) => !applied.some((r) => spansOverlap(r.start, r.end, a.start, a.end)),
  );
}

export const ANNOTATION_KIND_LABEL: Record<AnnotationKind, string> = {
  english: "英単語",
  heteronym: "同形異音",
  numeric: "数字・単位",
};
