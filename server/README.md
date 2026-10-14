# Pilot server

A small backend for the pilot. It serves the app and a JSON API from one address, so no key or secret
ever reaches the browser. The demo is unchanged: opened from `file://` or GitHub Pages, the app runs
entirely in the browser as before.

**Requires** Node.js 22.13 or later (it uses the built-in `node:sqlite`). No packages, no build step.

## Run it

```
node server/admin.js add-user asha --roles operator,management --name "Asha V."
node server/admin.js add-user deepak --roles field --name "Deepak R." --crew "R2 · Deepak R."
node server/server.js
```

Open <http://localhost:8080>. Visitors and citizens get the Citizen view; **Staff sign-in** opens the
views a person's roles allow. There is no sign-up page: staff accounts are created on the server's
machine with `admin.js` (`add-user`, `set-password`, `disable`, `enable`, `list`). Passwords are
typed at a prompt (or passed in `STAFF_PASSWORD` for scripts), never as arguments.

The first start copies the dataset (`data/streetlights.js`) into the database. After that the database
is the record; regenerating the dataset does not change a running pilot.

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT`, `HOST` | `8080`, `127.0.0.1` | where the server listens; use `0.0.0.0` behind a reverse proxy on another machine |
| `DATA_DIR` | `server/data` | database, photos and the generated secret. **Back this folder up.** |
| `SESSION_SECRET` | random, kept in `DATA_DIR/secret` | key for sessions, OTP codes and reporter IDs. Changing it signs everyone out and gives every citizen a new reporter ID |
| `TRUST_PROXY` | off | `1` when behind a reverse proxy that sets `X-Forwarded-For` / `X-Forwarded-Proto` |
| `PUBLIC_BASE_URL` | the address the app is opened at | public address for QR labels and status links, e.g. `https://lights.example.org/` |
| `OFFICIAL_HANDLES_JSON` | placeholders | verified X handles, e.g. `{"electrical":"@...","horticulture":"@...","emergency":"@..."}` |
| `SMS_PROVIDER` | `console` | `console` prints messages in the server log (development only); `msg91` or `twilio` for real SMS |
| `MSG91_AUTHKEY`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_ALERT_TEMPLATE_ID` | | MSG91 Flow API; templates must be registered on DLT (Indian SMS rules) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | | Twilio Messages API |
| `OTP_DEV_ECHO` | off | `1` shows the OTP code on screen, only while `SMS_PROVIDER=console` (for testing) |
| `ONCALL_PHONE` | none | a mobile number that gets an SMS for every safety emergency report |
| `ANTHROPIC_API_KEY` | none | turns on the AI photo check (Claude); without it, photos are not uploaded at all |
| `PHOTO_AI_MODEL` | `claude-opus-5-5` | the model for the photo check |
| `PHOTO_RETENTION_DAYS` | `90` | photos are deleted this many days after upload, and their links removed |
| `CCMS_PROVIDER` | `simulated` | `http` polls a live CCMS (`CCMS_URL`, `CCMS_TOKEN`) |
| `DEMO_CLOCK` | off | `1` lets `?now=` move the clock (demos only; the pilot runs on real time) |

## Deploying

- Put it behind HTTPS (a reverse proxy such as Caddy or nginx) and set `TRUST_PROXY=1`. Cookies are
  marked `Secure` on HTTPS. Camera, location and the share sheet also need HTTPS on phones.
- Keep `DATA_DIR` on persistent storage and back it up (it is one SQLite file plus the photo folder).
- Set `SMS_PROVIDER` to a real provider before citizens use it; with `console`, nobody receives codes.
- One server process. SQLite handles a pilot's load (a few dozen staff, thousands of reports) easily;
  a city-wide rollout would move to PostgreSQL/PostGIS.

## How it works

- **Saved state.** The app's workflow logic stays in the browser. The server stores the state as
  documents (one per pole, ticket, report, reporter and audit entry, plus settings), each with a
  revision number. After each action a staff browser sends the documents that changed. If another
  person changed one of them first, nothing is written: that browser reloads the latest state and
  says so. Staff browsers ask for other people's changes every 5 seconds.
- **IDs.** Ticket and report numbers are handed out by the server, so two browsers never use the same
  one. They are unique, not always consecutive.
- **Citizens.** A citizen verifies their mobile number with an SMS code. The number is not stored: it
  becomes a reporter ID (a keyed hash), so track records follow the person without keeping the
  number. Citizens can send reports, answer "Fixed?" and record that they shared a complaint. Each
  report waits in an inbox until a staff browser puts it on a ticket, using the same rules as the
  demo, usually within seconds. Safety emergencies also send an SMS to `ONCALL_PHONE` at once.
  **Keep at least one staff screen open in the control room** so reports are processed around the clock.
- **What the public sees.** Poles and tickets, without staff notes, crew names, the audit trail or
  other people's reports. A verified citizen also sees their own reports.
- **Photos.** In the browser, a photo is downsized and re-encoded (which also removes EXIF, including
  GPS). With the AI check on, the server sends it to Claude, which returns its findings and boxes
  around faces and number plates; the browser blurs those boxes and only then uploads the picture.
  Without the AI check, no photo is uploaded: only its fingerprint, for "same photo" matching.
  Photos are deleted after `PHOTO_RETENTION_DAYS`.
- **Security.** Passwords are hashed with scrypt; sessions are random tokens stored hashed, in
  HttpOnly, SameSite=Strict cookies; every write needs the app's own header (blocking cross-site
  requests); sign-in, OTP and citizen writes are rate-limited; static files are an allow-list (never
  `server/`, `tools/` or dotfiles); every document write is logged with who made it (`writes` table).

## Limits, honestly

- The MSG91, Twilio and CCMS adapters follow those services' published APIs but have not been run
  against the live services from this repository. Test each with a real account first. The CCMS
  reply shape (`{ state, at }`) is an assumption until NDMC shares its CCMS vendor's API.
- Blurring happens in the browser; the server cannot verify that it did. Server-side blurring needs
  an image library (a next step). The AI's boxes are approximate, so they are padded generously.
- Staff are trusted within their sign-in: any staff member can change any ticket (every write is
  logged). Finer rules per role (e.g. field crews only their own jobs) are a next step.
- Citizen SMS updates ("your light is fixed") are not sent yet: they need consent wording and a
  stored number, which this design avoids for now.

## Tests

```
node tools/test_server.js          # the API against a throwaway database (fake SMS and AI)
node tools/e2e/run.mjs server.mjs  # the app in headless Chrome against a running server
```
