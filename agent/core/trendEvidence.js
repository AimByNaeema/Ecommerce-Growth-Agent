'use strict';

// EVIDENCE-BASED TREND CLASSIFICATION - from dated observations, never from a label.
//
// WHY THIS EXISTS. Research used to report a trend as whatever the AI wrote ("seasonal", "growing"). A
// label is an opinion about a page, not a trend. A trend is a claim about values OVER TIME, so it is
// decided here from time-stamped numeric observations, deterministically, and only when there are enough
// of them. When there are not, the answer is 'unknown' with evidence_status INSUFFICIENT - never a guess.
//
// WHERE OBSERVATIONS COME FROM. Only from real, dated values: figures a cited page itself states for a
// date (grade OBSERVED - e.g. a year-by-year table on a source the search tool returned), figures this
// system measured (MEASURED), or the same metric recorded by earlier research runs over time (persisted
// through agent/core/runHistoryStore.js). No search-volume or trend API is connected to this project, so
// no observation is ever synthesised to stand in for one. An inferred, estimated or undated value is
// ignored for trend purposes.
//
// THE CLASSIFICATIONS (checked in this order, first match wins):
//   unknown (INSUFFICIENT)  fewer than MIN_POINTS usable observations, or they span under MIN_SPAN_DAYS
//   seasonal                two or more yearly cycles whose peaks fall in the same month (+/-1), each peak
//                           well above that year's typical level
//   fad                     a short spike: a peak at least SPIKE_RATIO x the baseline before it, elevated
//                           for no more than SPIKE_MAX_DAYS and a minority of the window, then decayed back
//                           near the baseline
//   emerging                sustained, persistent growth from (near) nothing
//   growing                 sustained, persistent growth that has not decayed at the end
//   declining               sustained, persistent decline
//   stable                  little change end to end and low variation
//   unknown (SUFFICIENT)    enough data, but no clear pattern (volatile) - reported as such, not forced

const MIN_POINTS = 4;
const MIN_SPAN_DAYS = 28;
const SPIKE_RATIO = 2;
const SPIKE_ELEVATED_RATIO = 1.5;
const SPIKE_DECAY_RATIO = 1.25;
const SPIKE_MAX_DAYS = 90;
const SPIKE_MAX_SHARE = 0.35;
const GROWTH_RATIO = 1.2;
const DECLINE_RATIO = 0.8;
const PERSISTENCE_SHARE = 0.6;
const STABLE_CHANGE = 0.2;
const STABLE_VARIATION = 0.25;
const SEASONAL_PEAK_RATIO = 1.5;
const SEASONAL_MIN_MONTHS_PER_YEAR = 6;

const TREND_EVIDENCE_CLASSIFICATIONS = ['growing', 'emerging', 'stable', 'declining', 'seasonal', 'fad', 'unknown'];
const USABLE_GRADES = new Set(['MEASURED', 'OBSERVED']);
const DAY_MS = 24 * 60 * 60 * 1000;

function parseObservationDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  // A month ("2025-10") is read as its first day.
  const normalized = /^\d{4}-\d{2}$/.test(text) ? `${text}-01` : text;
  if (!/^\d{4}-\d{2}-\d{2}/.test(normalized)) return null;
  const ms = Date.parse(normalized.length === 10 ? `${normalized}T00:00:00Z` : normalized);
  return Number.isFinite(ms) ? ms : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// The observations trend reasoning may use: dated, numeric, non-negative, MEASURED or OBSERVED, and on the
// single metric+unit that has the most of them (values on different scales are never compared).
function usableObservations(observations) {
  const candidates = [];
  for (const entry of Array.isArray(observations) ? observations : []) {
    if (!entry || typeof entry !== 'object') continue;
    const grade = typeof entry.grade === 'string' ? entry.grade.toUpperCase() : '';
    const at = parseObservationDate(entry.observed_at || entry.date);
    const value = entry.value === null || entry.value === '' ? NaN : Number(entry.value);
    if (!USABLE_GRADES.has(grade) || at === null || !Number.isFinite(value) || value < 0) continue;
    candidates.push({ at, value, metric: entry.metric || 'value', unit: entry.unit || null, source: entry.source || entry.source_url || null, provider: entry.provider || null, grade });
  }
  const groups = new Map();
  for (const entry of candidates) {
    const key = `${entry.metric}|${entry.unit || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  let chosen = [];
  for (const group of groups.values()) if (group.length > chosen.length) chosen = group;
  // One value per timestamp: the last one given wins, so a repeated observation never counts twice.
  const byTime = new Map();
  for (const entry of chosen) byTime.set(entry.at, entry);
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

function detectSeasonal(points) {
  const years = new Map();
  for (const point of points) {
    const date = new Date(point.at);
    const year = date.getUTCFullYear();
    if (!years.has(year)) years.set(year, []);
    years.get(year).push({ month: date.getUTCMonth(), value: point.value });
  }
  const cycles = [];
  for (const [year, entries] of years) {
    if (new Set(entries.map((entry) => entry.month)).size < SEASONAL_MIN_MONTHS_PER_YEAR) continue;
    const peak = entries.reduce((best, entry) => (entry.value > best.value ? entry : best), entries[0]);
    const typical = median(entries.map((entry) => entry.value));
    if (typical > 0 && peak.value >= SEASONAL_PEAK_RATIO * typical) cycles.push({ year, peak_month: peak.month });
    else cycles.push({ year, peak_month: null });
  }
  const peaked = cycles.filter((cycle) => cycle.peak_month !== null);
  if (cycles.length < 2 || peaked.length !== cycles.length) return null;
  const months = peaked.map((cycle) => cycle.peak_month);
  const aligned = months.every((month) => {
    const diff = Math.abs(month - months[0]);
    return Math.min(diff, 12 - diff) <= 1;
  });
  return aligned ? { cycles: peaked.length, peak_months: months.map((m) => m + 1) } : null;
}

function detectSpike(points, spanDays) {
  const values = points.map((point) => point.value);
  const peakIndex = values.indexOf(Math.max(...values));
  if (peakIndex < 2 || peakIndex > points.length - 3) return null;
  const baseline = median(values.slice(0, peakIndex));
  const peak = values[peakIndex];
  if (baseline > 0 ? peak < SPIKE_RATIO * baseline : peak <= 0) return null;
  const threshold = baseline > 0 ? SPIKE_ELEVATED_RATIO * baseline : 0;
  let first = peakIndex;
  while (first > 0 && values[first - 1] > threshold) first -= 1;
  let last = peakIndex;
  while (last < values.length - 1 && values[last + 1] > threshold) last += 1;
  if (last === values.length - 1) return null; // still elevated at the end: not (yet) a fad
  const elevatedDays = (points[last].at - points[first].at) / DAY_MS;
  const decayed = values[values.length - 1] <= (baseline > 0 ? SPIKE_DECAY_RATIO * baseline : 0);
  if (!decayed || elevatedDays > SPIKE_MAX_DAYS || elevatedDays > SPIKE_MAX_SHARE * spanDays) return null;
  return { baseline, peak, elevated_days: Math.round(elevatedDays) };
}

function directionShare(values, direction) {
  let count = 0;
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    if (direction > 0 ? change >= 0 : change <= 0) count += 1;
  }
  return count / (values.length - 1);
}

// `observations`: [{ observed_at|date, value, unit?, metric?, grade, source?, provider? }].
function classifyTrend(observations) {
  const points = usableObservations(observations);
  const base = {
    observations_used: points.length,
    metric: points.length ? points[0].metric : null,
    unit: points.length ? points[0].unit : null,
    time_window: points.length ? { from: new Date(points[0].at).toISOString(), to: new Date(points[points.length - 1].at).toISOString(), days: Math.round((points[points.length - 1].at - points[0].at) / DAY_MS) } : null,
    sources: [...new Set(points.map((point) => point.source).filter(Boolean))],
    providers: [...new Set(points.map((point) => point.provider).filter(Boolean))],
  };
  const spanDays = base.time_window ? base.time_window.days : 0;
  if (points.length < MIN_POINTS || spanDays < MIN_SPAN_DAYS) {
    return {
      ...base,
      classification: 'unknown',
      evidence_status: 'INSUFFICIENT',
      verification: 'NOT_VERIFIED',
      reason: `Trend not verified: ${points.length} dated measured/observed value(s) over ${spanDays} day(s); at least ${MIN_POINTS} over ${MIN_SPAN_DAYS} days are required.`,
    };
  }
  const verdict = (classification, reason, detail = {}) => ({ ...base, classification, evidence_status: 'SUFFICIENT', verification: 'VERIFIED', reason, detail });

  const seasonal = detectSeasonal(points);
  if (seasonal) return verdict('seasonal', `Peaks recur in the same month across ${seasonal.cycles} yearly cycles (month ${seasonal.peak_months.join(', ')}).`, seasonal);

  const spike = detectSpike(points, spanDays);
  if (spike) return verdict('fad', `A short spike: peak ${spike.peak} against a baseline of ${spike.baseline}, elevated for about ${spike.elevated_days} day(s), then decayed back near the baseline.`, spike);

  const values = points.map((point) => point.value);
  const third = Math.max(1, Math.floor(values.length / 3));
  const early = mean(values.slice(0, third));
  const late = mean(values.slice(-third));
  const max = Math.max(...values);
  const up = directionShare(values, 1);
  const down = directionShare(values, -1);

  if (late >= GROWTH_RATIO * Math.max(early, Number.EPSILON) && up >= PERSISTENCE_SHARE && values[values.length - 1] >= 0.8 * max) {
    const classification = early <= 0.1 * late ? 'emerging' : 'growing';
    return verdict(classification, `Sustained growth: the latest third averages ${late} against ${early} in the earliest, rising in ${Math.round(up * 100)}% of intervals.`, { early, late, persistence: up });
  }
  if (early > 0 && late <= DECLINE_RATIO * early && down >= PERSISTENCE_SHARE) {
    return verdict('declining', `Sustained decline: the latest third averages ${late} against ${early} in the earliest, falling in ${Math.round(down * 100)}% of intervals.`, { early, late, persistence: down });
  }
  const average = mean(values);
  const deviation = Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
  const variation = average > 0 ? deviation / average : 0;
  if (early > 0 && Math.abs(late / early - 1) <= STABLE_CHANGE && variation <= STABLE_VARIATION) {
    return verdict('stable', `Flat: the latest third is within ${Math.round(STABLE_CHANGE * 100)}% of the earliest and variation is low.`, { early, late, variation });
  }
  return { ...base, classification: 'unknown', evidence_status: 'SUFFICIENT', verification: 'NOT_VERIFIED', reason: 'Enough dated values, but no clear pattern (volatile); no trend is asserted.', detail: { early, late, variation } };
}

module.exports = {
  TREND_EVIDENCE_CLASSIFICATIONS,
  MIN_POINTS,
  MIN_SPAN_DAYS,
  SPIKE_MAX_DAYS,
  parseObservationDate,
  usableObservations,
  classifyTrend,
};
