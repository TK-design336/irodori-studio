import { useCallback, useId, useMemo, useRef } from "react";
import { BoundedSelect, type SelectOption } from "./BoundedSelect";

export type BlendWeights = { a: number; b: number; c: number };

type Pt = { x: number; y: number };

type Props = {
  options: SelectOption[];
  embedA: string;
  embedB: string;
  embedC: string;
  onEmbedA: (v: string) => void;
  onEmbedB: (v: string) => void;
  onEmbedC: (v: string) => void;
  weights: BlendWeights;
  onWeightsChange: (w: BlendWeights) => void;
  nameA: string;
  nameB: string;
  nameC: string;
};

const VB_W = 440;
const VB_H = 360;
const MARGIN_TOP = 24;
const MARGIN_BOTTOM = 48;
const HEIGHT = VB_H - MARGIN_TOP - MARGIN_BOTTOM;
const SIDE = (HEIGHT * 2) / Math.sqrt(3);
const T: Pt = { x: VB_W / 2, y: MARGIN_TOP };
const BL: Pt = { x: VB_W / 2 - SIDE / 2, y: MARGIN_TOP + HEIGHT };
const BR: Pt = { x: VB_W / 2 + SIDE / 2, y: MARGIN_TOP + HEIGHT };

const GRID = 10;
const TICK_OUT = 8;
const ARROW_OUT = 26;
const LABEL_OUT = 20;

function sub(p: Pt, q: Pt): Pt {
  return { x: p.x - q.x, y: p.y - q.y };
}
function add(p: Pt, q: Pt): Pt {
  return { x: p.x + q.x, y: p.y + q.y };
}
function scale(p: Pt, s: number): Pt {
  return { x: p.x * s, y: p.y * s };
}
function lerp(p: Pt, q: Pt, t: number): Pt {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}
function len(p: Pt): number {
  return Math.hypot(p.x, p.y);
}
function norm(p: Pt): Pt {
  const l = len(p) || 1;
  return { x: p.x / l, y: p.y / l };
}

function outwardNormal(from: Pt, to: Pt, inward: Pt): Pt {
  const d = norm(sub(to, from));
  let n = { x: -d.y, y: d.x };
  const mid = lerp(from, to, 0.5);
  const toIn = sub(inward, mid);
  if (n.x * toIn.x + n.y * toIn.y > 0) n = { x: -n.x, y: -n.y };
  return n;
}

function mix(w: BlendWeights): Pt {
  return {
    x: w.a * BL.x + w.b * BR.x + w.c * T.x,
    y: w.a * BL.y + w.b * BR.y + w.c * T.y,
  };
}

function barycentric(p: Pt): BlendWeights {
  const det =
    (BR.y - T.y) * (BL.x - T.x) + (T.x - BR.x) * (BL.y - T.y);
  const a =
    ((BR.y - T.y) * (p.x - T.x) + (T.x - BR.x) * (p.y - T.y)) / det;
  const b =
    ((T.y - BL.y) * (p.x - T.x) + (BL.x - T.x) * (p.y - T.y)) / det;
  return { a, b, c: 1 - a - b };
}

export function clampBlendWeights(w: BlendWeights, hasC: boolean): BlendWeights {
  let a = Math.max(0, w.a);
  let b = Math.max(0, w.b);
  let c = hasC ? Math.max(0, w.c) : 0;
  const s = a + b + c;
  if (s <= 1e-12) return hasC ? { a: 1 / 3, b: 1 / 3, c: 1 / 3 } : { a: 0.5, b: 0.5, c: 0 };
  return { a: a / s, b: b / s, c: c / s };
}

export function formatBlendPercents(
  w: BlendWeights,
  hasC: boolean,
): { a: number; b: number; c: number } {
  if (!hasC) {
    const s = w.a + w.b;
    if (s <= 1e-12) return { a: 50, b: 50, c: 0 };
    const a = Math.round((w.a / s) * 100);
    return { a, b: 100 - a, c: 0 };
  }
  const raw = [w.a * 100, w.b * 100, w.c * 100];
  const floors = raw.map(Math.floor);
  let rem = 100 - floors.reduce((s, n) => s + n, 0);
  const order = floors
    .map((_, i) => i)
    .sort((i, j) => (rem >= 0 ? raw[j] - floors[j] - (raw[i] - floors[i]) : raw[i] - floors[i] - (raw[j] - floors[j])));
  for (const i of order) {
    if (rem === 0) break;
    if (rem > 0) {
      floors[i] += 1;
      rem -= 1;
    } else if (floors[i] > 0) {
      floors[i] -= 1;
      rem += 1;
    }
  }
  return { a: floors[0], b: floors[1], c: floors[2] };
}

function Arrow({ from, to, color }: { from: Pt; to: Pt; color: string }) {
  const d = sub(to, from);
  const l = len(d);
  if (l < 2) return null;
  const u = { x: d.x / l, y: d.y / l };
  const n = { x: -u.y, y: u.x };
  const head = 11;
  const wing = 4.8;
  const tip = to;
  const left = {
    x: to.x - u.x * head + n.x * wing,
    y: to.y - u.y * head + n.y * wing,
  };
  const right = {
    x: to.x - u.x * head - n.x * wing,
    y: to.y - u.y * head - n.y * wing,
  };
  const end = { x: to.x - u.x * 5, y: to.y - u.y * 5 };
  return (
    <g>
      <line
        x1={from.x}
        y1={from.y}
        x2={end.x}
        y2={end.y}
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <polygon
        points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
        fill={color}
      />
    </g>
  );
}

function axisDecor(
  start0: Pt,
  end100: Pt,
  inward: Pt,
): { ticks: { p: Pt; outer: Pt; t: number }[]; arrowFrom: Pt; arrowTo: Pt; n: Pt } {
  const n = outwardNormal(start0, end100, inward);
  const ticks = [];
  for (let i = 0; i <= GRID; i++) {
    const t = i / GRID;
    const p = lerp(start0, end100, t);
    ticks.push({ p, outer: add(p, scale(n, TICK_OUT)), t });
  }
  const a0 = add(lerp(start0, end100, 0.06), scale(n, ARROW_OUT));
  const a1 = add(lerp(start0, end100, 0.94), scale(n, ARROW_OUT));
  return { ticks, arrowFrom: a0, arrowTo: a1, n };
}

const AXIS_A = axisDecor(BR, BL, T); // bottom, increase toward A (left)
const AXIS_B = axisDecor(T, BR, BL); // right, increase toward B (down)
const AXIS_C = axisDecor(BL, T, BR); // left, increase toward C (up)

function gridLines(): { a: string[]; b: string[]; c: string[] } {
  const a: string[] = [];
  const b: string[] = [];
  const c: string[] = [];
  for (let i = 1; i < GRID; i++) {
    const t = i / GRID;
    const c0 = mix({ a: 1 - t, b: 0, c: t });
    const c1 = mix({ a: 0, b: 1 - t, c: t });
    c.push(`${c0.x},${c0.y} ${c1.x},${c1.y}`);
    const a0 = mix({ a: t, b: 1 - t, c: 0 });
    const a1 = mix({ a: t, b: 0, c: 1 - t });
    a.push(`${a0.x},${a0.y} ${a1.x},${a1.y}`);
    const b0 = mix({ a: 1 - t, b: t, c: 0 });
    const b1 = mix({ a: 0, b: t, c: 1 - t });
    b.push(`${b0.x},${b0.y} ${b1.x},${b1.y}`);
  }
  return { a, b, c };
}

const GRID_LINES = gridLines();

function tickAngle(from: Pt, to: Pt): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

export function BlendTernaryPlot({
  options,
  embedA,
  embedB,
  embedC,
  onEmbedA,
  onEmbedB,
  onEmbedC,
  weights,
  onWeightsChange,
  nameA,
  nameB,
  nameC,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const clipId = useId().replace(/:/g, "");
  const hasC = Boolean(embedC);
  const pct = formatBlendPercents(weights, hasC);
  const point = mix(clampBlendWeights(weights, hasC));
  const cOptions = useMemo(
    () => [{ value: "", label: "なし（2話者）" }, ...options.filter((o) => o.value !== "")],
    [options],
  );

  const applyClient = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const p = pt.matrixTransform(ctm.inverse());
      onWeightsChange(clampBlendWeights(barycentric(p), hasC));
    },
    [hasC, onWeightsChange],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    applyClient(e.clientX, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    applyClient(e.clientX, e.clientY);
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const nudge = (dx: number, dy: number) => {
    let { a, b, c } = clampBlendWeights(weights, hasC);
    if (dx !== 0) {
      const rest = 1 - c;
      a = Math.min(rest, Math.max(0, a + dx));
      b = rest - a;
    }
    if (dy !== 0 && hasC) {
      c = Math.min(1, Math.max(0, c + dy));
      const rest = 1 - c;
      const prev = a + b;
      if (prev <= 1e-12) {
        a = rest / 2;
        b = rest / 2;
      } else {
        a = (a / prev) * rest;
        b = (b / prev) * rest;
      }
    }
    onWeightsChange(clampBlendWeights({ a, b, c }, hasC));
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? 0.01 : 0.03;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      nudge(step, 0);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nudge(-step, 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nudge(0, step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nudge(0, -step);
    } else if (e.key === "Home") {
      e.preventDefault();
      onWeightsChange(hasC ? { a: 1 / 3, b: 1 / 3, c: 1 / 3 } : { a: 0.5, b: 0.5, c: 0 });
    }
  };

  const guides = hasC
    ? [
        { pts: [mix({ a: 1 - weights.c, b: 0, c: weights.c }), mix({ a: 0, b: 1 - weights.c, c: weights.c })], ch: "c" },
        { pts: [mix({ a: weights.a, b: 1 - weights.a, c: 0 }), mix({ a: weights.a, b: 0, c: 1 - weights.a })], ch: "a" },
        { pts: [mix({ a: 1 - weights.b, b: weights.b, c: 0 }), mix({ a: 0, b: weights.b, c: 1 - weights.b })], ch: "b" },
      ]
    : [
        { pts: [mix({ a: weights.a, b: 1 - weights.a, c: 0 }), mix({ a: weights.a, b: 0, c: 1 - weights.a })], ch: "a" },
        { pts: [mix({ a: 1 - weights.b, b: weights.b, c: 0 }), mix({ a: 0, b: weights.b, c: 1 - weights.b })], ch: "b" },
      ];

  const labelA = mix({ a: 0.84, b: 0.08, c: 0.08 });
  const labelB = mix({ a: 0.08, b: 0.84, c: 0.08 });
  const labelC = mix({ a: 0.08, b: 0.08, c: 0.84 });

  const renderTicks = (
    axis: typeof AXIS_A,
    from: Pt,
    to: Pt,
    color: string,
    rotate: boolean,
  ) => {
    const ang = tickAngle(from, to);
    return axis.ticks.map((tk, i) => {
      const major = i % 2 === 0;
      const labelAt = add(tk.p, scale(axis.n, LABEL_OUT));
      return (
        <g key={i}>
          <line
            x1={tk.p.x}
            y1={tk.p.y}
            x2={tk.outer.x}
            y2={tk.outer.y}
            stroke={color}
            strokeWidth={major ? 1.4 : 0.8}
            opacity={major ? 0.85 : 0.45}
          />
          {major && (
            <text
              x={labelAt.x}
              y={labelAt.y}
              fill="currentColor"
              fontSize={8.5}
              textAnchor="middle"
              dominantBaseline="middle"
              transform={rotate ? `rotate(${ang} ${labelAt.x} ${labelAt.y})` : undefined}
              className="blend-ternary-tick"
            >
              {Math.round(tk.t * 100)}
            </text>
          )}
        </g>
      );
    });
  };

  return (
    <div className="blend-ternary">
      <p className="hint blend-ternary-hint">
        点をドラッグして比率を調整します。各辺の矢印はその話者が増える方向です。
        {hasC ? "" : " 話者 C を選ぶと三角形の内部も使えます。"}
      </p>
      <div className="blend-ternary-plot">
        <div className="blend-ternary-axis blend-ternary-axis-c">
          <div className="blend-axis-head">
            <span className="blend-axis-title">話者 C</span>
            <span className="blend-axis-pct" data-ch="c">
              {hasC ? `${pct.c}%` : "—"}
            </span>
          </div>
          <BoundedSelect
            value={embedC}
            options={cOptions}
            onChange={onEmbedC}
            placeholder="なし（2話者）"
            className="blend-ternary-select"
            aria-label="話者 C"
          />
          <span className="blend-axis-name" title={nameC}>
            {hasC ? nameC : "未選択"}
          </span>
        </div>

        <div className="blend-ternary-svg-wrap">
          <svg
            ref={svgRef}
            className="blend-ternary-svg"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            role="application"
            tabIndex={0}
            aria-label="3話者ブレンド比率"
            aria-valuetext={`${nameA} ${pct.a}パーセント、${nameB} ${pct.b}パーセント、${nameC} ${pct.c}パーセント`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            onDoubleClick={() =>
              onWeightsChange(hasC ? { a: 1 / 3, b: 1 / 3, c: 1 / 3 } : { a: 0.5, b: 0.5, c: 0 })
            }
          >
            <defs>
              <clipPath id={clipId}>
                <polygon points={`${T.x},${T.y} ${BR.x},${BR.y} ${BL.x},${BL.y}`} />
              </clipPath>
            </defs>

            <polygon
              points={`${T.x},${T.y} ${BR.x},${BR.y} ${BL.x},${BL.y}`}
              className="blend-ternary-fill"
            />

            <g clipPath={`url(#${clipId})`} className="blend-ternary-grid">
              {GRID_LINES.c.map((pts, i) => (
                <polyline key={`c${i}`} points={pts} data-ch="c" />
              ))}
              {GRID_LINES.a.map((pts, i) => (
                <polyline key={`a${i}`} points={pts} data-ch="a" />
              ))}
              {GRID_LINES.b.map((pts, i) => (
                <polyline key={`b${i}`} points={pts} data-ch="b" />
              ))}
            </g>

            <g clipPath={`url(#${clipId})`} className="blend-ternary-guides">
              {guides.map((g) => (
                <line
                  key={g.ch}
                  x1={g.pts[0].x}
                  y1={g.pts[0].y}
                  x2={g.pts[1].x}
                  y2={g.pts[1].y}
                  data-ch={g.ch}
                />
              ))}
            </g>

            <polygon
              points={`${T.x},${T.y} ${BR.x},${BR.y} ${BL.x},${BL.y}`}
              className="blend-ternary-edge"
            />

            <g className="blend-ternary-axes">
              {renderTicks(AXIS_A, BR, BL, "var(--blend-a)", false)}
              {renderTicks(AXIS_B, T, BR, "var(--blend-b)", true)}
              <Arrow from={AXIS_A.arrowFrom} to={AXIS_A.arrowTo} color="var(--blend-a)" />
              <Arrow from={AXIS_B.arrowFrom} to={AXIS_B.arrowTo} color="var(--blend-b)" />
              <g opacity={hasC ? 1 : 0.35}>
                {renderTicks(AXIS_C, BL, T, "var(--blend-c)", true)}
                <Arrow from={AXIS_C.arrowFrom} to={AXIS_C.arrowTo} color="var(--blend-c)" />
              </g>
            </g>

            <circle cx={BL.x} cy={BL.y} r={3.2} fill="var(--blend-a)" />
            <circle cx={BR.x} cy={BR.y} r={3.2} fill="var(--blend-b)" />
            <circle
              cx={T.x}
              cy={T.y}
              r={3.2}
              fill="var(--blend-c)"
              opacity={hasC ? 1 : 0.35}
            />

            <text
              x={labelA.x}
              y={labelA.y}
              className="blend-vertex-pct"
              data-ch="a"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {pct.a}%
            </text>
            <text
              x={labelB.x}
              y={labelB.y}
              className="blend-vertex-pct"
              data-ch="b"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {pct.b}%
            </text>
            {hasC && (
              <text
                x={labelC.x}
                y={labelC.y}
                className="blend-vertex-pct"
                data-ch="c"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {pct.c}%
              </text>
            )}

            <circle
              className="blend-plot-hit"
              cx={point.x}
              cy={point.y}
              r={16}
            />
            <circle
              className="blend-plot-point"
              cx={point.x}
              cy={point.y}
              r={7.5}
            />
          </svg>
        </div>

        <div className="blend-ternary-axis blend-ternary-axis-b">
          <div className="blend-axis-head">
            <span className="blend-axis-title">話者 B</span>
            <span className="blend-axis-pct" data-ch="b">
              {pct.b}%
            </span>
          </div>
          <BoundedSelect
            value={embedB}
            options={options}
            onChange={onEmbedB}
            placeholder="選択…"
            className="blend-ternary-select"
            aria-label="話者 B"
          />
          <span className="blend-axis-name" title={nameB}>
            {nameB}
          </span>
        </div>

        <div className="blend-ternary-axis blend-ternary-axis-a">
          <div className="blend-axis-head">
            <span className="blend-axis-title">話者 A</span>
            <span className="blend-axis-pct" data-ch="a">
              {pct.a}%
            </span>
          </div>
          <BoundedSelect
            value={embedA}
            options={options}
            onChange={onEmbedA}
            placeholder="選択…"
            className="blend-ternary-select"
            aria-label="話者 A"
          />
          <span className="blend-axis-name" title={nameA}>
            {nameA}
          </span>
        </div>
      </div>

      <div className="blend-ratio-cards" aria-live="polite">
        <div className="blend-ratio-card" data-ch="a">
          <span className="blend-ratio-label">話者 A · {nameA}</span>
          <strong className="blend-ratio-value">{pct.a}%</strong>
          <div className="blend-ratio-bar">
            <i style={{ width: `${pct.a}%` }} />
          </div>
        </div>
        <div className="blend-ratio-card" data-ch="b">
          <span className="blend-ratio-label">話者 B · {nameB}</span>
          <strong className="blend-ratio-value">{pct.b}%</strong>
          <div className="blend-ratio-bar">
            <i style={{ width: `${pct.b}%` }} />
          </div>
        </div>
        <div className={`blend-ratio-card${hasC ? "" : " muted"}`} data-ch="c">
          <span className="blend-ratio-label">話者 C · {hasC ? nameC : "未選択"}</span>
          <strong className="blend-ratio-value">{hasC ? `${pct.c}%` : "—"}</strong>
          <div className="blend-ratio-bar">
            <i style={{ width: `${hasC ? pct.c : 0}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
