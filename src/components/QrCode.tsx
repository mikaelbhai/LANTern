import React from 'react';
import { encodeQr, qrToSvgPath } from '../lib/qr';

export function QrCode({
  value,
  size = 168,
  className,
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const qr = React.useMemo(() => {
    try {
      return encodeQr(value);
    } catch {
      return null;
    }
  }, [value]);

  if (!qr) {
    return (
      <div
        className="grid place-items-center rounded-card border border-edge bg-raised text-2xs text-muted"
        style={{ width: size, height: size }}
      >
        Payload too large
      </div>
    );
  }

  const quiet = 2;
  const dim = qr.size + quiet * 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      className={className}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing QR code"
    >
      <rect width={dim} height={dim} fill="#E6EAF3" rx="1" />
      <g transform={`translate(${quiet} ${quiet})`}>
        <path d={qrToSvgPath(qr)} fill="#0C0F14" />
      </g>
    </svg>
  );
}
