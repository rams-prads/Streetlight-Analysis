#!/usr/bin/env node
/*
 * Unit tests for report confidence (confidence.js), run against the real config.js.
 * Plain Node, no dependencies:   node tools/test_confidence.js
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = ['config.js', 'confidence.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
const ctx = vm.createContext({});
vm.runInContext(`${source}\n;globalThis.api = { scoreReport, countsAsConfirmed, hashDistance, photoCheck, CONFIDENCE, CONFIDENCE_PRIORITY, CRITICALITY_BONUS, DARK_RUN_BONUS };`, ctx);
const { scoreReport, countsAsConfirmed, hashDistance, photoCheck, CONFIDENCE: cfg, CONFIDENCE_PRIORITY, CRITICALITY_BONUS, DARK_RUN_BONUS } = ctx.api;

const base = (over = {}) => ({ category: 'not_working', reporters: 1, ...over });
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('emergencies bypass scoring, whatever the evidence', () => {
  for (const category of ['exposed', 'shock']) {
    const r = scoreReport(base({ category, ccms: { night: 'on', daylight: 'off' }, photoMatch: { reportId: 'CR-1', samePole: false } }), cfg);
    assert.equal(r.bypass, true);
    assert.equal(r.band, null);
    assert.equal(r.score, null);
  }
});

test('a report with no evidence is neutral (not penalised)', () => {
  const r = scoreReport(base({ track: { reports: 0, confirmed: 0 } }), cfg);
  assert.equal(r.score, cfg.neutral);
  assert.equal(r.band, 'Likely');
  assert.ok(r.signals.every((s) => s.effect === 0 && s.points === 0), 'every signal neutral');
  // missing evidence is tagged so the view can fold it into one line
  assert.equal(r.signals.filter((s) => s.absent).map((s) => s.absent).join(','), 'CCMS node,track record,photo,location');
});

test('a CCMS contradiction gives Needs check, never a rejection', () => {
  const r = scoreReport(base({ ccms: { night: 'on', daylight: 'off' } }), cfg);
  assert.equal(r.band, 'Needs check');
  assert.equal(r.contradicted, true);
  assert.ok(!('rejected' in r));
  assert.match(r.signals.find((s) => s.key === 'ccms').text, /CCMS can be wrong/);
  // even strong reporter evidence only moves it up the queue: the check still comes first
  const strong = scoreReport(base({ ccms: { night: 'on' }, reporters: 4, track: { reports: 10, confirmed: 10 }, photo: { live: true }, location: { accuracyM: 5, distanceM: 4 } }), cfg);
  assert.equal(strong.band, 'Needs check');
  // day burning: CCMS off in daylight contradicts too
  assert.equal(scoreReport(base({ category: 'day_burning', ccms: { night: 'on', daylight: 'off' } }), cfg).band, 'Needs check');
});

test('CCMS support confirms a lamp report', () => {
  assert.equal(scoreReport(base({ ccms: { night: 'off' } }), cfg).band, 'Confirmed');
  assert.equal(scoreReport(base({ category: 'flickering', ccms: { night: 'abnormal' } }), cfg).band, 'Confirmed');
  assert.equal(scoreReport(base({ category: 'day_burning', ccms: { daylight: 'on' } }), cfg).band, 'Confirmed');
});

test('a far-away location is neutral; a close one supports; a rough one is ignored', () => {
  const far = scoreReport(base({ location: { accuracyM: 12, distanceM: 1400 } }), cfg);
  assert.equal(far.score, cfg.neutral);
  assert.equal(far.signals.find((s) => s.key === 'location').effect, 0);
  const near = scoreReport(base({ location: { accuracyM: 12, distanceM: 14 } }), cfg);
  assert.equal(near.score, cfg.neutral + cfg.locationMatch);
  const rough = scoreReport(base({ location: { accuracyM: cfg.locationMaxAccuracyM + 1, distanceM: 3 } }), cfg);
  assert.equal(rough.score, cfg.neutral);
});

test('independent reports raise confidence, up to the cap', () => {
  const s = (n) => scoreReport(base({ reporters: n }), cfg).score;
  assert.equal(s(1), cfg.neutral);
  assert.equal(s(2), cfg.neutral + cfg.perReporter);
  assert.ok(s(3) > s(2));
  assert.equal(s(1 + cfg.reporterCap), cfg.neutral + cfg.reporterCap * cfg.perReporter);
  assert.equal(s(20), s(1 + cfg.reporterCap), 'capped');
});

test('a reused photo on a different pole lowers confidence; a resubmission stays neutral', () => {
  const photo = { live: true };
  const clean = scoreReport(base({ photo }), cfg).score;
  const reused = scoreReport(base({ photo, photoMatch: { reportId: 'CR-D11', samePole: false, sameReporter: false, sameDay: true } }), cfg);
  assert.equal(reused.score, clean - cfg.photoReused);
  assert.match(reused.signals.find((s) => s.key === 'photo-match').text, /Photo matches report CR-D11/);
  const otherDay = scoreReport(base({ photo, photoMatch: { reportId: 'CR-1', samePole: true, sameReporter: false, sameDay: false } }), cfg).score;
  assert.equal(otherDay, clean - cfg.photoReused);
  const resubmitted = scoreReport(base({ photo, photoMatch: { reportId: 'CR-1', samePole: true, sameReporter: true, sameDay: false } }), cfg).score;
  assert.equal(resubmitted, clean);
});

test('"Different pole" counts as confirmed for the reporter', () => {
  assert.equal(countsAsConfirmed('different_pole'), true);
  assert.equal(countsAsConfirmed('confirmed'), true);
  assert.equal(countsAsConfirmed('obstruction'), true);
  assert.equal(countsAsConfirmed('no_fault'), false);
  const r = scoreReport(base({ field: 'different_pole', ccms: { night: 'on' } }), cfg);
  assert.equal(r.band, 'Confirmed');
});

test('a field check overrides everything; no fault reads "Not confirmed on site"', () => {
  const r = scoreReport(base({ field: 'no_fault', reporters: 5, ccms: { night: 'off' } }), cfg);
  assert.equal(r.band, null);
  assert.equal(r.final, 'Not confirmed on site');
});

test('track record counts only after enough reports; first-time reporters are neutral', () => {
  assert.equal(scoreReport(base({ track: { reports: cfg.trackMin - 1, confirmed: 0 } }), cfg).score, cfg.neutral);
  assert.ok(scoreReport(base({ track: { reports: 14, confirmed: 13 } }), cfg).score > cfg.neutral);
  assert.ok(scoreReport(base({ track: { reports: 6, confirmed: 1 } }), cfg).score < cfg.neutral);
});

test('photos count most for physical problems, and live more than uploaded', () => {
  const pts = (category, live) => scoreReport(base({ category, photo: { live } }), cfg).score - cfg.neutral;
  assert.ok(pts('damaged', true) > pts('not_working', true));
  assert.ok(pts('damaged', true) > pts('damaged', false));
  assert.ok(pts('blocked', false) > pts('not_working', true));
});

test('timing: plausible supports, implausible is neutral and noted', () => {
  const just = (dark) => scoreReport(base({ timing: { noticed: 'just_now', darkAtReport: dark } }), cfg);
  assert.equal(just(true).score, cfg.neutral + cfg.timing);
  assert.equal(just(false).score, cfg.neutral);
  assert.match(just(false).signals.find((s) => s.key === 'timing').text, /daylight/);
  assert.equal(scoreReport(base({ timing: { noticed: 'last_night', darkAtReport: false } }), cfg).score, cfg.neutral + cfg.timing);
});

test('circuit evidence supports a "not working" report', () => {
  assert.equal(scoreReport(base({ circuit: 'fault' }), cfg).score, cfg.neutral + cfg.circuitFault);
  assert.equal(scoreReport(base({ circuit: 'neighbour' }), cfg).score, cfg.neutral + cfg.circuitNeighbour);
});

test('confidence never outweighs safety, criticality or dark-run length in the priority', () => {
  const biggest = Math.max(...Object.values(CONFIDENCE_PRIORITY).map(Math.abs));
  assert.ok(biggest < Math.min(...Object.values(CRITICALITY_BONUS)));
  assert.ok(biggest < Math.min(...DARK_RUN_BONUS.map(([, pts]) => pts)));
});

test('no report or person is ever labelled fake, false or spam', () => {
  const words = /fake|false|spam|fraud|lie/i;
  const cases = [
    base(), base({ ccms: { night: 'on' } }), base({ field: 'no_fault' }), base({ photo: { live: false }, photoMatch: { reportId: 'X', samePole: false } }),
    base({ track: { reports: 9, confirmed: 0 } }), base({ timing: { noticed: 'just_now', darkAtReport: false } }), base({ category: 'shock' }),
  ];
  for (const c of cases) {
    const r = scoreReport(c, cfg);
    for (const s of r.signals) assert.doesNotMatch(s.text, words, s.text);
    if (r.final) assert.doesNotMatch(r.final, words);
  }
});

test('perceptual hash distance and the simulated AI photo check', () => {
  assert.equal(hashDistance('0000000000000000', '0000000000000000'), 0);
  assert.equal(hashDistance('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hashDistance('9c3e6a1f0b8d4e27', '9c3e6a1f0b8d4e26'), 1);
  assert.equal(photoCheck(null, 'damaged', {}).length, 0);
  const [s] = photoCheck({ hash: 'x' }, 'damaged', {});
  assert.equal(s.effect, 0);
  assert.match(s.text, /simulated/);
});

test('AI photo findings (pilot server) nudge confidence a little, and only where a photo can show it', () => {
  const ai = (f) => ({ kind: 'live', hash: null, ai: { streetlight_visible: true, lamp: 'unclear', dark_scene: null, pole_damaged: null, light_blocked: null, ...f } });
  const one = (photo, category) => photoCheck(photo, category, {}, cfg)[0];
  assert.equal(one(ai({ lamp: 'off', dark_scene: true }), 'not_working').points, cfg.aiPhoto);
  assert.equal(one(ai({ lamp: 'off', dark_scene: false }), 'not_working').effect, 0, 'lamps are off by day anyway');
  assert.equal(one(ai({ lamp: 'on' }), 'not_working').points, -cfg.aiPhoto);
  assert.equal(one(ai({ lamp: 'on', dark_scene: false }), 'day_burning').effect, 1);
  assert.equal(one(ai({ pole_damaged: true }), 'damaged').effect, 1);
  assert.equal(one(ai({ pole_damaged: null }), 'damaged').effect, 0, 'not clear is neutral');
  assert.equal(one(ai({ lamp: 'off', dark_scene: true }), 'flickering').effect, 0);
  assert.equal(one(ai({ streetlight_visible: false, lamp: 'off', dark_scene: true }), 'not_working').effect, 0);
  assert.ok(cfg.aiPhoto < cfg.photoLive && cfg.aiPhoto < cfg.ccms, 'smaller than a live photo or CCMS');
  // it never decides alone: a CCMS contradiction still gives Needs check, whatever the AI says
  const r = scoreReport({ category: 'not_working', reporters: 1, ccms: { night: 'on' }, photo: { live: true }, extra: photoCheck(ai({ lamp: 'off', dark_scene: true }), 'not_working', {}, cfg) }, cfg);
  assert.equal(r.band, 'Needs check');
});

for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`);
  }
}
console.log(`\n${passed} of ${tests.length} confidence tests passed`);
process.exit(passed === tests.length ? 0 : 1);
