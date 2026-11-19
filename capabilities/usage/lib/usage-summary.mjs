const COUNTER = /\d[\d,.]*[kmbt]?\s*(?:req(?:uest)?s?|tok(?:en)?s?)/i;
const WINDOW_WITH_COUNTERS = new RegExp(`^((?:today|\\d+d)\\s+\\S.*?)(?:\\s+${COUNTER.source})+$`, "i");

// Gateway routes already put their main reading first. Spend windows can
// include request and token counts in that same segment; keep those in details.
export function usageSummary(text) {
  const first = text.split(" | ", 1)[0].trim();
  return WINDOW_WITH_COUNTERS.exec(first)?.[1] ?? first;
}
