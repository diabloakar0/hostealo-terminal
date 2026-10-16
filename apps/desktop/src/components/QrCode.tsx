import { useMemo } from "react";
import { encode } from "uqr";

/** A QR code, always dark on white (what phone cameras read best), whatever the theme. */
export function QrCode({ text, className }: { text: string; className?: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, size: qr.size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} shapeRendering="crispEdges" role="img">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#0b1220" />
    </svg>
  );
}
