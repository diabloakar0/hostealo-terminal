import { useId } from "react";

interface SparklineProps {
  values: number[];
  /** Fixed upper bound (e.g. 100 for percentages). Defaults to the largest value. */
  max?: number;
  width?: number;
  height?: number;
  className?: string;
  /** Number of samples the x axis spans, so the line grows from the right as data arrives. */
  capacity?: number;
}

export function Sparkline({ values, max, width = 64, height = 16, className, capacity = 60 }: SparklineProps) {
  const gradientId = useId();
  if (values.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;

  const top = Math.max(max ?? Math.max(...values), 1e-9);
  const step = width / (capacity - 1);
  const offset = (capacity - values.length) * step;
  const points = values.map((v, i) => {
    const x = offset + i * step;
    const y = height - 1 - (Math.min(v, top) / top) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${points.join(" L")}`;
  const area = `${line} L${width},${height} L${offset.toFixed(1)},${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}
