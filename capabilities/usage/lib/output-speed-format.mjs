export function formatOutputSpeed(tokens, durationMs) {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(durationMs) || durationMs <= 0) return "";
  const speed = tokens * 1000 / durationMs;
  return Number.isFinite(speed) ? `${speed.toFixed(1)} tok/s` : "";
}
