export type ScreenPoint = {
  x: number;
  y: number;
};

export type TimedClick = ScreenPoint & {
  timestamp: number;
};

export type ClickSequenceResult = {
  clicks: TimedClick[];
  tripleClick: boolean;
};

export function recordSamePlaceClick(
  previous: TimedClick[],
  click: TimedClick,
  options: { maxGapMs?: number; radiusPx?: number } = {}
): ClickSequenceResult {
  const maxGapMs = options.maxGapMs ?? 620;
  const radiusPx = options.radiusPx ?? 42;
  const last = previous.at(-1);
  const anchor = previous[0];
  const followsSequence = Boolean(
    last &&
      anchor &&
      click.timestamp >= last.timestamp &&
      click.timestamp - last.timestamp <= maxGapMs &&
      Math.hypot(click.x - anchor.x, click.y - anchor.y) <= radiusPx
  );
  const clicks = followsSequence ? [...previous, click] : [click];
  if (clicks.length < 3) return { clicks, tripleClick: false };
  return { clicks: [], tripleClick: true };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function easeInOut(progress: number): number {
  const normalized = clamp(progress, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}
