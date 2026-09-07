'use strict';

// The organic social content cadence policy: "how many content units per day, across
// all platforms?" Pure and deterministic - it counts records and compares the count to
// a configured target. Nothing here reads a file, calls a model, or reaches a network;
// the caller supplies both the already-built calendar records and the already-loaded
// business configuration.
//
// WHY THIS IS CONFIGURATION, NOT A CONSTANT. The number is a per-business decision, so
// it lives in configuration/business.yaml's `social_content.daily_content_units` (see
// CLAUDE.md rule 14: business rules and thresholds belong in configuration/, so the
// system can point at a different store without a code change). There is NO default
// anywhere in this module: an unconfigured, blank, zero, negative, or non-integer value
// yields null, and a null target produces no cadence report at all. The agent never
// invents a cadence of its own (CLAUDE.md rule 1).
//
// WHAT COUNTS AS A UNIT. Exactly one agent/core/contentCalendarModel.js record - one
// planned organic post - counted on its own `date`. Counting is ACROSS platforms
// combined, not per platform: two entries on the same date count as 2 whether they are
// both Instagram or one Instagram and one TikTok. Paid advertising
// (agent/core/adCampaignModel.js) is a different concern with its own budget and
// approval boundary and is never counted here - this module imports nothing from it.
//
// REPORT, NEVER REJECT. checkDailyContentCadence() returns a description of what was
// planned versus what was targeted. It has no throw path and no reject path: an
// off-target day is reported as a limitation on the result, the same way every other
// honesty gap in this project is surfaced rather than silently corrected. Deciding what
// to do about an off-target calendar is the human's call, not this module's.
//
// DATES ARE COMPARED AS THE CALLER WROTE THEM. contentCalendarModel.js's own `date`
// field is a caller-supplied string ("never a fabricated schedule"), so days are grouped
// by that exact trimmed string. No date is parsed, normalized, or invented here - two
// spellings of the same day are two days as far as this module is concerned, which is
// honest about what it actually knows.

const CADENCE_CONFIG_PATH = 'social_content.daily_content_units';

// The one sentence stating exactly what is and is not counted. Carried onto every
// cadence report so a reader never has to guess the counting rule.
const CADENCE_SCOPE =
  'Counted across all social platforms combined (not per platform), organic content calendar entries only - paid ad campaigns are never counted toward this target.';

const DAY_STATUSES = ['on_target', 'over_target', 'under_target'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reads the configured daily target out of an already-loaded business config object.
// Returns a positive integer, or null when nothing usable is configured - null is the
// normal, expected case for a business that has not set a cadence, not an error.
function readDailyContentUnitsTarget(businessConfig) {
  if (!isPlainObject(businessConfig)) return null;
  const socialContent = businessConfig.social_content;
  if (!isPlainObject(socialContent)) return null;
  return normalizeDailyContentUnits(socialContent.daily_content_units);
}

// The single place a candidate target is judged usable, so the config path and a
// caller-supplied override are held to exactly the same standard. A target must be a
// whole number greater than zero; anything else (blank, null, 0, -1, 1.5, "two") is not
// a cadence and becomes null rather than being coerced into one.
function normalizeDailyContentUnits(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

// Groups already-built content calendar records by their own `date` string and compares
// each day's count to the target. Returns null - not an empty report - when there is no
// target or no dated record to count, so a caller can simply skip cadence reporting.
function checkDailyContentCadence(calendarRecords, dailyContentUnits) {
  const target = normalizeDailyContentUnits(dailyContentUnits);
  if (target === null) return null;

  const records = Array.isArray(calendarRecords) ? calendarRecords : [];
  const countsByDate = new Map();
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    const date = typeof record.date === 'string' ? record.date.trim() : '';
    if (date === '') continue;
    countsByDate.set(date, (countsByDate.get(date) || 0) + 1);
  }
  if (countsByDate.size === 0) return null;

  const days = [...countsByDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, plannedUnits]) => ({
      date,
      planned_units: plannedUnits,
      target_units: target,
      status: plannedUnits === target ? 'on_target' : plannedUnits > target ? 'over_target' : 'under_target',
    }));

  return {
    target_units_per_day: target,
    scope: CADENCE_SCOPE,
    days,
    off_target_days: days.filter((day) => day.status !== 'on_target'),
  };
}

// Turns a cadence report into the limitation lines a result envelope carries. An
// on-target calendar produces no lines at all - a limitation is for something a reader
// needs to know is wrong, and nothing is. Returns [] for a null report for the same
// reason.
function describeCadenceLimitations(cadenceCheck) {
  if (!isPlainObject(cadenceCheck) || !Array.isArray(cadenceCheck.off_target_days)) return [];
  return cadenceCheck.off_target_days.map((day) => {
    const direction = day.status === 'over_target' ? 'over' : 'under';
    return (
      `Planned content volume for ${day.date} is ${direction} the configured target: ` +
      `${day.planned_units} unit(s) planned against a target of ${day.target_units} per day. ` +
      `${CADENCE_SCOPE} Reported only - the calendar is not rejected, and the target is not enforced ` +
      `(configuration/business.yaml ${CADENCE_CONFIG_PATH}).`
    );
  });
}

module.exports = {
  CADENCE_CONFIG_PATH,
  CADENCE_SCOPE,
  DAY_STATUSES,
  readDailyContentUnitsTarget,
  normalizeDailyContentUnits,
  checkDailyContentCadence,
  describeCadenceLimitations,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - organic social content cadence policy:\n');
  console.log(`Configured at: configuration/business.yaml ${CADENCE_CONFIG_PATH}`);
  console.log(`Scope: ${CADENCE_SCOPE}\n`);

  const cases = {
    'no target configured': [[{ date: '2026-11-14' }], null],
    'on target (2 across two platforms)': [
      [{ date: '2026-11-14', platform: 'instagram' }, { date: '2026-11-14', platform: 'tiktok' }],
      2,
    ],
    'under target': [[{ date: '2026-11-14', platform: 'instagram' }], 2],
    'over target': [
      [
        { date: '2026-11-14', platform: 'instagram' },
        { date: '2026-11-14', platform: 'tiktok' },
        { date: '2026-11-14', platform: 'pinterest' },
      ],
      2,
    ],
  };

  for (const [label, [records, target]] of Object.entries(cases)) {
    const check = checkDailyContentCadence(records, target);
    console.log(`--- ${label} ---`);
    console.log(`  report: ${check ? JSON.stringify(check.days) : '(none)'}`);
    for (const line of describeCadenceLimitations(check)) console.log(`  limitation: ${line}`);
    console.log('');
  }

  console.log('No calendar above is real - every entry is a placeholder for demonstration.');
}
