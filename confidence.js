/* ==========================================================================
 * Street Light GIS · confidence.js
 * Section 9a: report confidence. Pure functions only: evidence in, band and reasons out.
 * No DOM, no map, no clock, no state, so tools/test_confidence.js can run them in Node.
 *
 * Confidence changes the ORDER in which reports are handled and HOW they are checked.
 * It never decides whether a report is recorded, and no report is ever rejected.
 * ========================================================================== */
'use strict';

/**
 * Score how well one citizen report is backed by evidence.
 *
 * ev = {
 *   category,                                     report category id
 *   field:    null | 'confirmed' | 'different_pole' | 'obstruction' | 'no_fault'   on-site result (final)
 *   ccms:     null | { night: 'on' | 'off' | 'abnormal', daylight: 'on' | 'off', poll?: bool }
 *   circuit:  null | 'fault' | 'neighbour'        on a detected circuit/cable fault, or a dark neighbour
 *   reporters: number                             distinct reporters on this pole or spot (this one included)
 *   track:    null | { reports, confirmed }       this reporter's past reports and how many were confirmed
 *   photo:    null | { live: bool }
 *   photoMatch: null | { reportId, samePole, sameReporter, sameDay }   an earlier report with a near-identical photo
 *   location: null | { accuracyM, distanceM }     from "Use my location"
 *   timing:   null | { noticed, darkAtReport }    noticed: 'last_night' | 'earlier_today' | 'just_now' | null
 *   extra:    []                                  signals from photoCheck()
 * }
 * Returns { bypass, band, final, score, contradicted, signals: [{ key, effect: 1 | 0 | -1, points, text, absent? }] }.
 * `absent` names evidence the report simply does not have (no photo, no location, …), so a view can fold those lines.
 */
function scoreReport(ev, cfg) {
  const signals = [];
  const add = (key, points, text, effect = Math.sign(points)) => signals.push({ key, effect, points, text });
  const none = (key, text, absent) => signals.push({ key, effect: 0, points: 0, text, absent });

  // Safety first: emergencies are never scored and always go out at once.
  if (cfg.emergencyCategories.includes(ev.category)) {
    add('safety', 0, 'Safety emergency: dispatched at once, not scored');
    return { bypass: true, band: null, final: null, score: null, contradicted: false, signals };
  }

  // A field check is final and overrides everything else.
  if (ev.field) {
    const result = FIELD_RESULTS[ev.field];
    add('field', 0, result.text, result.confirmed ? 1 : 0);
    return { bypass: false, band: result.confirmed ? 'Confirmed' : null, final: result.final, score: null, contradicted: false, signals };
  }

  let score = cfg.neutral;
  let contradicted = false;
  const night = cfg.nightCategories.includes(ev.category);
  const day = cfg.dayCategories.includes(ev.category);

  // CCMS: what the pole's node says about the lamp.
  if (night || day) {
    const c = ev.ccms;
    const via = c?.poll ? 'CCMS poll' : 'CCMS';
    const when = c?.poll ? 'now' : 'at its last switch-on';
    if (!c) {
      none('ccms', 'No CCMS node on this pole', 'CCMS node');
    } else if (night && (c.night === 'off' || c.night === 'abnormal')) {
      add('ccms', cfg.ccms, `${via}: lamp ${c.night === 'off' ? 'off' : 'abnormal'} ${when}`);
    } else if (night) {
      add('ccms', -cfg.ccms, `${via}: lamp on ${when} (CCMS can be wrong)`);
      contradicted = true;
    } else if (c.daylight === 'on') {
      add('ccms', cfg.ccms, `${via}: lamp on in daylight`);
    } else {
      add('ccms', -cfg.ccms, `${via}: lamp off in daylight (CCMS can be wrong)`);
      contradicted = true;
    }
    score += signals[signals.length - 1].points;
  }

  // Circuit: a dark stretch around the pole backs up a "not working" report.
  if (ev.category === 'not_working' && ev.circuit) {
    const pts = ev.circuit === 'fault' ? cfg.circuitFault : cfg.circuitNeighbour;
    add('circuit', pts, ev.circuit === 'fault' ? 'On a detected circuit or cable fault' : 'Next pole on its circuit is dark');
    score += pts;
  }

  // Independent reporters, counted up to a cap.
  const extra = Math.min(cfg.reporterCap, Math.max(0, (ev.reporters ?? 1) - 1));
  if (extra > 0) {
    add('reporters', extra * cfg.perReporter, `${ev.reporters} independent reporters`);
    score += extra * cfg.perReporter;
  }

  // Track record: only once there is one. New reporters are neutral.
  const t = ev.track;
  if (t && t.reports >= cfg.trackMin) {
    const pts = Math.round((t.confirmed / t.reports - 0.5) * cfg.trackWeight);
    add('track', pts, `${t.confirmed} of ${t.reports} past reports confirmed on site`);
    score += pts;
  } else {
    none('track', 'New reporter: no track record yet', 'track record');
  }

  // Photo: optional; a live photo counts more, and photos count most for physical problems.
  if (ev.photo) {
    const relevance = cfg.photoRelevance[ev.category] ?? 0.5;
    const pts = Math.round((ev.photo.live ? cfg.photoLive : cfg.photoUpload) * relevance);
    add('photo', pts, `${ev.photo.live ? 'Photo taken in the app' : 'Uploaded photo'}${relevance < 0.5 ? ' (shows little for this problem)' : ''}`);
    score += pts;
    const m = ev.photoMatch;
    if (m && m.samePole && m.sameReporter) {
      add('photo-match', 0, `Same photo as their report ${m.reportId} on this pole`);
    } else if (m && (!m.samePole || !m.sameDay)) {
      add('photo-match', -cfg.photoReused, `Photo matches report ${m.reportId}`);
      score -= cfg.photoReused;
    }
  } else {
    none('photo', 'No photo', 'photo');
  }

  // Location: only from "Use my location". Close by supports; far away is neutral, never negative.
  const loc = ev.location;
  if (!loc) {
    none('location', 'No location shared', 'location');
  } else if (loc.accuracyM > cfg.locationMaxAccuracyM) {
    add('location', 0, `Location too rough (±${Math.round(loc.accuracyM)} m), not used`);
  } else if (loc.distanceM <= cfg.locationMatchM) {
    add('location', cfg.locationMatch, `Reporter was ${Math.round(loc.distanceM)} m from the pole`);
    score += cfg.locationMatch;
  } else {
    add('location', 0, `Reported from ${formatDistance(loc.distanceM)} away (often reported later, from elsewhere)`);
  }

  // Timing: can the problem be seen when the reporter says it was?
  const tm = ev.timing;
  if (tm && night && tm.noticed) {
    if (tm.noticed === 'just_now' && !tm.darkAtReport) {
      add('timing', 0, 'Said "just now" in daylight, when lamps are off');
    } else {
      add('timing', cfg.timing, `Noticed ${NOTICED_TEXT[tm.noticed]}: lamps are on then`);
      score += cfg.timing;
    }
  } else if (tm && day) {
    if (tm.darkAtReport) add('timing', 0, 'Reported after dark, when day burning cannot be seen');
    else {
      add('timing', cfg.timing, 'Reported in daylight, when it can be seen');
      score += cfg.timing;
    }
  }

  for (const s of ev.extra ?? []) {
    signals.push(s);
    score += s.points;
  }

  const band = contradicted ? 'Needs check' : bandOf(score, cfg);
  return { bypass: false, band, final: null, score, contradicted, signals };
}

const bandOf = (score, cfg) => (score >= cfg.confirmedMin ? 'Confirmed' : score >= cfg.likelyMin ? 'Likely' : 'Needs check');
const NOTICED_TEXT = { last_night: 'last night', earlier_today: 'earlier today', just_now: 'just now, after dark' };
const FIELD_RESULTS = {
  confirmed: { confirmed: true, text: 'Fault confirmed on site', final: 'Confirmed on site' },
  different_pole: { confirmed: true, text: 'Fault found on a neighbouring pole', final: 'Confirmed on site (nearby pole)' },
  obstruction: { confirmed: true, text: 'Light blocked by a tree or hoarding', final: 'Confirmed on site (obstruction)' },
  no_fault: { confirmed: false, text: 'Working when checked on site', final: 'Not confirmed on site' },
};
/** Whether an on-site outcome counts as a confirmed report for the reporter's track record. */
const countsAsConfirmed = (outcome) => Boolean(FIELD_RESULTS[outcome]?.confirmed);
const formatDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** Bits that differ between two 64-bit perceptual hashes written as 16 hex digits. */
function hashDistance(a, b) {
  let bits = 0;
  for (let i = 0; i < 16; i += 4) {
    let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
    while (x) {
      bits += x & 1;
      x >>>= 1;
    }
  }
  return bits;
}

/**
 * AI photo check: a pluggable hook. Input: the photo, the category and the pole; output: signals with
 * reasons, in the same shape scoreReport uses. On the pilot server with an AI check configured, the
 * photo carries the model's findings (photo.ai); they move confidence a little (cfg.aiPhoto), never
 * decide on their own. Without findings (the demo, or no AI configured) it is a simulated stub.
 */
function photoCheck(photo, category, pole, cfg = CONFIDENCE) { // eslint-disable-line no-unused-vars
  if (!photo) return [];
  const f = photo.ai;
  if (!f) return [{ key: 'ai', effect: 0, points: 0, text: 'AI photo check: simulated, not run' }];
  const say = (effect, text) => [{ key: 'ai', effect, points: effect * cfg.aiPhoto, text: `AI photo check: ${text}` }];
  const yesNo = (v, yes, no) => (v === true ? say(1, yes) : v === false ? say(-1, no) : say(0, 'not clear from the photo'));
  if (f.streetlight_visible === false && category !== 'blocked') return say(0, 'no street light in view');
  if (category === 'not_working') {
    if (f.lamp === 'on') return say(-1, 'lamp looks on');
    return f.lamp === 'off' && f.dark_scene === true ? say(1, 'lamp looks off after dark') : say(0, 'lamp state not clear (lamps are off by day)');
  }
  if (category === 'day_burning') {
    if (f.dark_scene === true) return say(0, 'photo taken after dark');
    return f.lamp === 'on' ? say(1, 'lamp looks on in daylight') : f.lamp === 'off' ? say(-1, 'lamp looks off') : say(0, 'lamp state not clear');
  }
  if (category === 'damaged') return yesNo(f.pole_damaged, 'pole looks damaged', 'pole looks intact');
  if (category === 'blocked') return yesNo(f.light_blocked, 'light looks blocked', 'light does not look blocked');
  return say(0, category === 'flickering' ? 'flicker cannot be seen in a photo' : 'nothing to check for this problem');
}
