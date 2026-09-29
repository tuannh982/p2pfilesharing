const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

function scale(value: number, digits: number): string {
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < UNITS.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(index === 0 ? 0 : digits)} ${UNITS[index]}`;
}

export function formatBytes(bytes: bigint): string {
  return scale(Number(bytes), 1);
}

export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '-';
  return `${scale(bytesPerSecond, 1)}/s`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}
