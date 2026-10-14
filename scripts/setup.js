import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { passwordHash, randomToken } from '../server/security.js';

try { await readFile('.env'); console.error('.env already exists; preserved. Edit it to change configuration.'); process.exit(1); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir('data', { recursive: true, mode: 0o700 });
const password = randomToken();
await writeFile('data/initial-password.txt', `${password}\n`, { mode: 0o600, flag: 'wx' });
await writeFile('.env', `PUBLIC_ORIGIN=http://localhost:4310
HOST=127.0.0.1
PORT=4310
APP_KEY=${randomBytes(32).toString('hex')}
ADMIN_PASSWORD_HASH=${await passwordHash(password)}
META_APP_ID=
META_APP_SECRET=
META_API_VERSION=v24.0
ENABLE_PUBLISHING=false
`, { mode: 0o600, flag: 'wx' });
console.log('Created .env and data/initial-password.txt (owner-readable only). Run npm start, then sign in with the password in that file.');
