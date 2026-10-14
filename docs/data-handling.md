# Personal data in the pilot

What the pilot server collects about people, why, where it is kept and for how long. This is
**input for a review** against India's Digital Personal Data Protection Act, 2023 (DPDP) by NDMC's
legal or data protection team. It is not legal advice.

## Citizens

| Data | Why | Kept | Who sees it |
|---|---|---|---|
| Mobile number | to verify the reporter with an SMS code | **not stored**: used for the code, then turned into a reporter ID. The pending code is kept, hashed, for 5 minutes | the SMS provider (to deliver the code) |
| Reporter ID (`RP-…`, a keyed hash of the number) | track record, hourly report limit | with the reports | staff |
| Report: category, pole or map spot, time, "noticed", note | to fix the light | until the retention policy below | staff; the citizen sees their own reports |
| Location from "Use my location" (optional, only on tap) | evidence the reporter was near the pole | with the report | staff |
| Photo (optional) | evidence of the fault | **only stored with the AI check on**, after faces and number plates are blurred in the phone's browser; deleted after 90 days (`PHOTO_RETENTION_DAYS`) | staff; the citizen |
| The photo before blurring | to find faces and plates | sent to the AI provider (Anthropic) for the check; not stored by the pilot | the AI provider |
| IP address | rate limits against abuse | 24 hours | server only |
| Session cookie | stay verified on this phone | 30 days | server only |

Notes
- The reporter ID is **pseudonymised, not anonymous**: whoever holds the server's secret and a phone
  number can work out the ID. Treat it as personal data.
- Free-text notes can contain personal details; staff should not copy them elsewhere.
- Photos are downsized and re-encoded in the phone's browser before anything is sent, which removes
  EXIF data, including GPS position.
- Sharing on X is done by the citizen, from their own account, through X's web intent. The pilot only
  records that the complaint was shared (no account names).

## Staff

Username, display name, roles, crew name, a scrypt hash of the password, session cookies (12 hours),
and an audit trail of every change (who, what, when). Kept while the person has an account; the audit
trail is kept with the tickets.

## Processors (outside services)

- **Hosting** (wherever the server runs).
- **SMS provider** (MSG91 or Twilio): phone numbers and message text, to deliver codes and on-call alerts.
- **AI provider** (Anthropic), only with the AI check on: the downsized photo and the reported category.
- **X**: only when a citizen chooses to post, from their own account.

## To decide before citizens use it

1. **Retention** for reports and the audit trail (for example, 2 years after the ticket closes, then
   anonymise the reporter ID). The pilot deletes photos after 90 days; it does not yet expire reports.
2. **Notice and consent wording** shown before verification, in English and Hindi (the form says the
   number is used only to verify and is not stored, and the photo is used only to check the report).
3. **Rights requests**: how a citizen asks to see or erase their reports. An erase endpoint (delete
   photos, replace the reporter ID) is a next step.
4. **Breach response**: who is told, and how fast (DPDP requires notifying the Board and the people affected).
5. **Data processing agreements** with the SMS and AI providers, and where they store data.
