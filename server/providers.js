/* ==========================================================================
 * Street Light GIS · server/providers.js
 * Outside services, each behind a small adapter chosen by environment variables:
 *   SMS (OTP codes, on-call alerts) · AI photo check · CCMS node polls.
 * Keys live only in the server's environment; the browser never sees them.
 * The live adapters follow each service's published API but have not been run against the live
 * service from this repository: test each with a real account before relying on it.
 * ========================================================================== */
'use strict';

const TIMEOUT_MS = 15000;

// ---- SMS ---------------------------------------------------------------------------------------
/**
 * SMS_PROVIDER = console (default: prints the message in the server log; for development only)
 *              | msg91   (MSG91_AUTHKEY, MSG91_OTP_TEMPLATE_ID, MSG91_ALERT_TEMPLATE_ID; India: DLT-registered templates)
 *              | twilio  (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)
 */
function smsProvider(env, log = console.log) {
  const kind = env.SMS_PROVIDER || 'console';
  if (kind === 'console') {
    return { kind, live: false, async send(phone, text) { log(`[sms:console] to ******${phone.slice(-4)}: ${text}`); } };
  }
  if (kind === 'msg91') {
    need(env, ['MSG91_AUTHKEY', 'MSG91_OTP_TEMPLATE_ID']);
    return {
      kind, live: true,
      // MSG91 Flow API: the template (registered on DLT) holds the wording; we send its variables.
      async send(phone, text, { otp = null, template = otp ? env.MSG91_OTP_TEMPLATE_ID : env.MSG91_ALERT_TEMPLATE_ID } = {}) {
        if (!template) throw new Error('MSG91_ALERT_TEMPLATE_ID is not set');
        await postJson('https://control.msg91.com/api/v5/flow', { authkey: env.MSG91_AUTHKEY },
          { template_id: template, short_url: '0', recipients: [{ mobiles: `91${phone}`, ...(otp ? { otp } : { message: text }) }] });
      },
    };
  }
  if (kind === 'twilio') {
    need(env, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']);
    return {
      kind, live: true,
      async send(phone, text) {
        const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
          method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: `+91${phone}`, From: env.TWILIO_FROM, Body: text }),
        });
        if (!res.ok) throw new Error(`twilio: HTTP ${res.status}`);
      },
    };
  }
  throw new Error(`SMS_PROVIDER: unknown "${kind}" (console, msg91 or twilio)`);
}

// ---- AI photo check ----------------------------------------------------------------------------
const PHOTO_PROMPT = (category) => `You help a city maintenance team check citizen photos of street-light problems.
The citizen reported: "${category}".
Look at the photo and reply with JSON only, no other text, in exactly this shape:
{"streetlight_visible": true|false,
 "lamp": "on"|"off"|"unclear",
 "dark_scene": true|false|null,
 "pole_damaged": true|false|null,
 "wires_exposed": true|false|null,
 "light_blocked": true|false|null,
 "redact": [{"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}]}
"redact" lists every human face and every vehicle number plate as boxes in fractions (0 to 1) of the
image width and height, measured from the top-left corner. Make the boxes generous rather than tight.
"dark_scene" is true when the photo was taken after dark. Use null when the photo does not show
enough to say. Do not describe or identify any person.`;

/**
 * ANTHROPIC_API_KEY set → the photo goes to Claude (model PHOTO_AI_MODEL) for findings and the boxes to
 * blur; otherwise there is no AI check and photos are not stored (they cannot be blurred first).
 */
function aiProvider(env) {
  if (!env.ANTHROPIC_API_KEY) return { configured: false };
  const model = env.PHOTO_AI_MODEL || 'claude-opus-5-5';
  return {
    configured: true,
    model,
    async check(jpeg, categoryLabel) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 600,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
            { type: 'text', text: PHOTO_PROMPT(categoryLabel) },
          ] }],
        }),
      });
      if (!res.ok) throw new Error(`AI photo check: HTTP ${res.status}`);
      const body = await res.json();
      const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      return parseFindings(text);
    },
  };
}

/** Pull the JSON object out of the model's reply and keep only well-formed fields. */
function parseFindings(text) {
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) throw new Error('AI photo check: no JSON in the reply');
  const raw = JSON.parse(m[0]);
  const tri = (v) => (v === true || v === false ? v : null);
  const unit = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const redact = (Array.isArray(raw.redact) ? raw.redact : []).slice(0, 50)
    .map((b) => ({ x: unit(b?.x), y: unit(b?.y), w: unit(b?.w), h: unit(b?.h) }))
    .filter((b) => b.w > 0 && b.h > 0);
  return {
    findings: {
      streetlight_visible: tri(raw.streetlight_visible),
      lamp: ['on', 'off', 'unclear'].includes(raw.lamp) ? raw.lamp : 'unclear', dark_scene: tri(raw.dark_scene),
      pole_damaged: tri(raw.pole_damaged), wires_exposed: tri(raw.wires_exposed), light_blocked: tri(raw.light_blocked),
    },
    redact,
  };
}

// ---- CCMS --------------------------------------------------------------------------------------
/**
 * CCMS_PROVIDER = simulated (default: the browser keeps its simulation)
 *               | http (CCMS_URL, CCMS_TOKEN): GET {CCMS_URL}/nodes/{pole uid}/status → { state: on|off|abnormal, at }
 * The http shape is an assumption: map it to the vendor's real API when NDMC shares it.
 */
function ccmsProvider(env) {
  const kind = env.CCMS_PROVIDER || 'simulated';
  if (kind === 'simulated') return { kind, async poll() { return { simulated: true }; } };
  if (kind === 'http') {
    need(env, ['CCMS_URL', 'CCMS_TOKEN']);
    return {
      kind,
      async poll(uid) {
        const res = await fetch(`${env.CCMS_URL.replace(/\/$/, '')}/nodes/${encodeURIComponent(uid)}/status`, {
          signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Bearer ${env.CCMS_TOKEN}`, accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`CCMS: HTTP ${res.status}`);
        const body = await res.json();
        if (!['on', 'off', 'abnormal'].includes(body.state)) throw new Error('CCMS: unexpected reply');
        return { simulated: false, state: body.state, at: body.at ?? new Date().toISOString() };
      },
    };
  }
  throw new Error(`CCMS_PROVIDER: unknown "${kind}" (simulated or http)`);
}

function need(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`missing environment variable(s): ${missing.join(', ')}`);
}
async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

module.exports = { smsProvider, aiProvider, ccmsProvider, parseFindings, PHOTO_PROMPT };
