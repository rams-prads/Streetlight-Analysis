/* ==========================================================================
 * Street Light GIS · share.js
 * Section 9b: public escalation text. Pure functions (no DOM, no state), tested by tools/test_share.js.
 * The citizen posts from their own account through X's web intent; nothing is posted automatically.
 * ========================================================================== */
'use strict';

/** Post length as X counts it: NFC text, weight 1 inside cfg.singleRanges and 2 elsewhere, every link 23. */
function weightedLength(text, cfg) {
  let length = 0;
  const rest = String(text).normalize('NFC').replace(/https?:\/\/\S+/g, () => {
    length += cfg.urlWeight;
    return '';
  });
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    length += cfg.singleRanges.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return length;
}

/** Placeholder handles (not yet replaced with verified official ones) are left out of posts. */
const isPlaceholderHandle = (handle) => !handle || /^@OFFICIAL_HANDLE_/.test(handle);

/**
 * The citizen's post, in their language (`t(key, vars)` reads the citizen dictionary): complaint ID,
 * category, road and nearby landmark, days open, the public status link and the department's handle.
 * The landmark, then the days open, then the link are dropped if needed to fit X's limit.
 */
function buildPost({ id, category, road, landmark = null, days, url = null, handle = null }, t, cfg) {
  const main = (near) => t('post_main', { id, category, road, near: near && landmark ? t('post_near', { landmark }) : '' });
  const open = days <= 1 ? t('post_open_one') : t('post_open', { days });
  const status = url ? t('post_status', { url }) : '';
  const tag = isPlaceholderHandle(handle) ? '' : handle;
  const tries = [[main(true), open, status, tag], [main(false), open, status, tag], [main(false), status, tag], [main(false), tag]];
  for (const parts of tries) {
    const text = parts.filter(Boolean).join(' ');
    if (weightedLength(text, cfg) <= cfg.maxWeighted) return text;
  }
  return fitWeighted(tries[tries.length - 1].filter(Boolean).join(' '), cfg);
}

/** The department's short "fixed" update for its own account (operators, after a shared ticket closes). */
function buildUpdate({ id, category, road, date, url = null }, cfg) {
  const text = [`Fixed: streetlight complaint ${id} (${category}, ${road}) was repaired on ${date}. Thank you for reporting.`,
    url ? `Status: ${url}` : ''].filter(Boolean).join(' ');
  return fitWeighted(text, cfg);
}

/** Last resort: cut the text, character by character, until it fits (with an ellipsis). */
function fitWeighted(text, cfg) {
  if (weightedLength(text, cfg) <= cfg.maxWeighted) return text;
  const chars = [...String(text).normalize('NFC')];
  while (chars.length && weightedLength(`${chars.join('')}…`, cfg) > cfg.maxWeighted) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/** X's official web intent with the post text pre-filled; the citizen reviews and posts it themselves. */
const intentUrl = (text, cfg) => `${cfg.intentUrl}?text=${encodeURIComponent(text)}`;
