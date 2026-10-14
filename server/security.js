import { randomBytes, createHash, createCipheriv, createDecipheriv, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const actual = await passwordHash(password, encoded.split(':')[0]);
  return actual.length === encoded.length && timingSafeEqual(Buffer.from(actual), Buffer.from(encoded));
}
export function vault(hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32 || !/^[a-f0-9]{64}$/i.test(hexKey)) throw new Error('APP_KEY must be 64 hexadecimal characters.');
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    decrypt(value) {
      const data = Buffer.from(value, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
    },
  };
}
export class AppError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
export function requireValue(condition, code, message, status = 400) {
  if (!condition) throw new AppError(status, code, message);
}
