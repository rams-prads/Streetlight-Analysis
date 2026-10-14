#!/usr/bin/env node
/* ==========================================================================
 * Street Light GIS · server/admin.js
 * Staff accounts, from the server's own machine (there is no sign-up page).
 *
 *   node server/admin.js add-user <username> --roles operator,management [--name "Asha V."] [--crew "R2 · Deepak R."]
 *   node server/admin.js set-password <username>
 *   node server/admin.js disable <username> | enable <username>
 *   node server/admin.js list
 *
 * Passwords are read from the terminal (or the STAFF_PASSWORD variable, for scripts), never from arguments.
 * Uses the same DATA_DIR / DB_FILE / SESSION_SECRET as the server.
 * ========================================================================== */
'use strict';
const path = require('node:path');
const readline = require('node:readline');
const { openStore } = require('./store');
const { Auth, loadSecret } = require('./auth');

async function askPassword() {
  if (process.env.STAFF_PASSWORD) return process.env.STAFF_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (!s.startsWith('Password')) rl.output.write('*'); else rl.output.write(s); };
  const pw = await new Promise((resolve) => rl.question('Password (10+ characters): ', resolve));
  rl.close();
  process.stdout.write('\n');
  return pw;
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, username, ...rest] = process.argv.slice(2);
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const store = openStore(process.env.DB_FILE || path.join(dataDir, 'streetlight.db'));
  const auth = new Auth(store, loadSecret(process.env, dataDir));
  switch (cmd) {
    case 'add-user': {
      const roles = String(flag(rest, 'roles') ?? '').split(',');
      auth.addUser({ username, name: flag(rest, 'name'), roles, crew: flag(rest, 'crew') ?? null, password: await askPassword() });
      console.log(`Added ${username} (${roles.join(', ')})`);
      break;
    }
    case 'set-password':
      auth.setPassword(username, await askPassword());
      console.log(`Password changed for ${username}; their sessions were ended.`);
      break;
    case 'disable':
    case 'enable':
      auth.setDisabled(username, cmd === 'disable');
      console.log(`${username} ${cmd}d`);
      break;
    case 'list':
      for (const u of auth.users()) console.log(`${u.username.padEnd(16)} ${u.roles.join(',').padEnd(28)} ${u.crew ?? ''}${u.disabled ? '  (disabled)' : ''}`);
      break;
    default:
      console.log('Usage: node server/admin.js add-user <username> --roles operator,field,management [--name N] [--crew C] | set-password <u> | disable <u> | enable <u> | list');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
