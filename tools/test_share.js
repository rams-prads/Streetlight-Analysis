#!/usr/bin/env node
/*
 * Unit tests for public-escalation text (share.js): X's weighted counting, fitting, handles, links.
 * Plain Node, no dependencies:   node tools/test_share.js
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = ['config.js', 'share.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
const ctx = vm.createContext({});
vm.runInContext(`${source}\n;globalThis.api = { weightedLength, buildPost, buildUpdate, intentUrl, isPlaceholderHandle, X_POST, CITIZEN_TEXT };`, ctx);
const { weightedLength, buildPost, buildUpdate, intentUrl, isPlaceholderHandle, X_POST: cfg, CITIZEN_TEXT } = ctx.api;
const tr = (lang) => (key, vars = {}) => CITIZEN_TEXT[lang][key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('weighted length follows X: Latin 1, Devanagari 1, CJK and emoji 2, links 23, NFC', () => {
  assert.equal(weightedLength('Hello world', cfg), 11);
  assert.equal(weightedLength('बत्ती', cfg), [...'बत्ती'].length);
  assert.equal(weightedLength('日本', cfg), 4);
  assert.equal(weightedLength('😀', cfg), 2);
  assert.equal(weightedLength('see https://lights.example.org/very/long/path#ticket=TKT-2026-0156', cfg), 4 + 23);
  assert.equal(weightedLength('café', cfg), 4); // decomposed é counts once after NFC
});

const sample = { id: 'TKT-2026-0156', category: 'Flickering', road: 'Outer Circle', landmark: 'Rajiv Chowk metro exit 7', days: 3 };

test('the post carries the ID, category, road, landmark, days and handle', () => {
  const text = buildPost({ ...sample, url: 'https://lights.example.org/#ticket=TKT-2026-0156', handle: '@NDMC_Electrical' }, tr('en'), cfg);
  for (const part of ['TKT-2026-0156', 'Flickering', 'Outer Circle', 'Rajiv Chowk metro exit 7', '3 days', '#ticket=TKT-2026-0156', '@NDMC_Electrical']) {
    assert.ok(text.includes(part), `${part} in "${text}"`);
  }
  assert.ok(weightedLength(text, cfg) <= cfg.maxWeighted);
});

test('placeholder handles are left out; no link without BASE_URL', () => {
  assert.equal(isPlaceholderHandle('@OFFICIAL_HANDLE_ELECTRICAL'), true);
  assert.equal(isPlaceholderHandle('@NDMC_Electrical'), false);
  const text = buildPost({ ...sample, url: null, handle: '@OFFICIAL_HANDLE_ELECTRICAL' }, tr('en'), cfg);
  assert.ok(!text.includes('@') && !text.includes('http') && !text.includes('Status'), text);
});

test('one day reads "1 day"', () => {
  assert.match(buildPost({ ...sample, days: 1 }, tr('en'), cfg), /Open for 1 day\./);
});

test('Hindi posts use the Hindi template and still fit', () => {
  const text = buildPost({ ...sample, category: 'टिमटिमा रही है', url: 'https://lights.example.org/#ticket=TKT-2026-0156', handle: '@NDMC_Electrical' }, tr('hi'), cfg);
  assert.ok(text.includes('शिकायत') && text.includes('टिमटिमा रही है'), text);
  assert.ok(weightedLength(text, cfg) <= cfg.maxWeighted);
});

test('long inputs are fitted within 280 weighted characters, dropping the least important parts first', () => {
  const long = 'x'.repeat(200);
  const text = buildPost({ ...sample, road: long, landmark: 'y'.repeat(80), url: 'https://lights.example.org/#ticket=1', handle: '@NDMC_Electrical' }, tr('en'), cfg);
  assert.ok(weightedLength(text, cfg) <= cfg.maxWeighted, `${weightedLength(text, cfg)}`);
  assert.ok(!text.includes('yyyy'), 'landmark dropped first');
  const huge = buildPost({ ...sample, road: 'z'.repeat(400) }, tr('en'), cfg);
  assert.ok(weightedLength(huge, cfg) <= cfg.maxWeighted && huge.endsWith('…'));
});

test('the intent link is X\'s official web intent with the text URL-encoded', () => {
  const url = intentUrl('Hello & नमस्ते #1', cfg);
  assert.ok(url.startsWith('https://x.com/intent/tweet?text='));
  assert.equal(decodeURIComponent(url.split('text=')[1]), 'Hello & नमस्ते #1');
});

test('the department update is short, factual and fits', () => {
  const text = buildUpdate({ id: 'TKT-2026-0154', category: 'Not working', road: 'Middle Circle', date: '14 Oct 2026' }, cfg);
  assert.match(text, /^Fixed: streetlight complaint TKT-2026-0154/);
  assert.ok(weightedLength(text, cfg) <= cfg.maxWeighted);
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
console.log(`\n${passed} of ${tests.length} sharing tests passed`);
process.exit(passed === tests.length ? 0 : 1);
