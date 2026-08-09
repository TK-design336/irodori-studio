export type TimedCue = {
  startSec: number;
  endSec: number;
  text: string;
  speakerName?: string;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** HH:MM:SS,mmm */
export function formatSrtTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(whole)},${pad3(ms)}`;
}

/** HH:MM:SS.mmm */
export function formatVttTime(sec: number): string {
  return formatSrtTime(sec).replace(",", ".");
}

export function buildSrt(cues: TimedCue[]): string {
  return (
    cues
      .map((c, i) => {
        const body = c.speakerName
          ? `${c.speakerName}: ${c.text}`
          : c.text;
        return `${i + 1}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${body}\n`;
      })
      .join("\n") + "\n"
  );
}

export function buildVtt(cues: TimedCue[]): string {
  const body = cues
    .map((c) => {
      const text = c.speakerName
        ? `<v ${c.speakerName}>${c.text}`
        : c.text;
      return `${formatVttTime(c.startSec)} --> ${formatVttTime(c.endSec)}\n${text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}\n`;
}

/** Audacity / Reaper-friendly tab labels: start\tend\tname */
export function buildLabelTrack(cues: TimedCue[]): string {
  return (
    cues
      .map((c) => {
        const name = c.speakerName
          ? `${c.speakerName}: ${c.text}`
          : c.text;
        const safe = name.replace(/[\t\r\n]+/g, " ");
        return `${c.startSec.toFixed(6)}\t${c.endSec.toFixed(6)}\t${safe}`;
      })
      .join("\n") + "\n"
  );
}

export function cuesFromDurations(
  items: { durationSec: number; text: string; speakerName?: string }[],
  silenceSecs: number,
): TimedCue[] {
  const cues: TimedCue[] = [];
  let t = 0;
  for (let i = 0; i < items.length; i++) {
    const d = Math.max(0, items[i].durationSec);
    cues.push({
      startSec: t,
      endSec: t + d,
      text: items[i].text,
      speakerName: items[i].speakerName,
    });
    t += d;
    if (i + 1 < items.length) t += Math.max(0, silenceSecs);
  }
  return cues;
}
