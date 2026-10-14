import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  const origin = new URL(env.PUBLIC_ORIGIN || 'http://localhost:4310');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN must be an origin without a path.');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('PUBLIC_ORIGIN requires HTTPS outside localhost.');
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(env.ADMIN_PASSWORD_HASH || '')) throw new Error('Run npm run setup first (ADMIN_PASSWORD_HASH missing).');
  if (!/^v\d+\.\d+$/.test(env.META_API_VERSION || 'v24.0')) throw new Error('Invalid META_API_VERSION.');
  const port = Number(env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  return {
    origin: origin.origin, host: env.HOST || '127.0.0.1', port,
    dataDir: resolve(env.DATA_DIR || 'data'), appKey: env.APP_KEY || '',
    passwordHash: env.ADMIN_PASSWORD_HASH, metaAppId: env.META_APP_ID || '',
    metaSecret: env.META_APP_SECRET || '', metaVersion: env.META_API_VERSION || 'v24.0',
    publishingEnabled: env.ENABLE_PUBLISHING === 'true',
  };
}
