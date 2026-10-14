import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { passwordHash } from '../server/security.js';

const dir = await mkdtemp(join(tmpdir(), 'open-social-browser-'));
await mkdir('artifacts', { recursive: true });
const config = { origin: 'http://127.0.0.1', dataDir: dir, appKey: 'ab'.repeat(32), passwordHash: await passwordHash('browser-test-only'),
  metaAppId: 'test', metaSecret: 'test', metaVersion: 'v24.0', publishingEnabled: true };
let publications = 0;
const app = await createApp(config, { meta: {
  publish: async () => { publications++; return { id: '123_456', url: 'https://www.facebook.com/123_456' }; }, health: async () => true,
} });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
config.origin = `http://127.0.0.1:${app.server.address().port}`;
app.db.prepare('INSERT INTO channels(id,provider,remote_id,name,secret) VALUES(?,?,?,?,?)').run('channel-1', 'facebook', '123', 'Testikanava (simuloitu)', app.secrets.encrypt('fake'));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(config.origin);
    await page.getByLabel('Salasana', { exact: true }).fill('browser-test-only');
    await page.getByRole('button', { name: 'Avaa työtila' }).click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.screenshot({ path: `artifacts/calendar-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await page.locator('nav a[href="#editor"]').click();
    await page.locator('#post-channel').selectOption('channel-1');
    await page.getByLabel('Julkaisun teksti').fill(`Selainkoe ${viewport.width}: kesän tapahtumat.`);
    await page.getByRole('button', { name: 'Tallenna luonnos', exact: true }).click();
    await page.locator('#calendar').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: `Avaa julkaisu: Selainkoe ${viewport.width}: kesän tapahtumat.` }).click();
    await page.getByRole('button', { name: 'Muokkaa', exact: true }).click();
    await page.getByLabel('Julkaisun teksti').fill(`Muokattu selainkoe ${viewport.width}`);
    await page.locator('#post-zone').selectOption('UTC');
    const later = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    await page.locator('#schedule-time').fill(later);
    await page.screenshot({ path: `artifacts/editor-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Ajasta', exact: true }).click();
    await page.locator('#calendar').waitFor({ state: 'visible' });
    assert.equal(app.db.prepare('SELECT state FROM posts WHERE text=?').get(`Muokattu selainkoe ${viewport.width}`).state, 'scheduled');
    await page.locator('nav a[href="#channels"]').click();
    await page.getByRole('button', { name: 'Tarkista', exact: true }).click();
    await page.getByText('Yhteys toimii.', { exact: false }).waitFor();
    await page.screenshot({ path: `artifacts/channels-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await page.locator('nav a[href="#agents"]').click();
    await page.getByLabel('Avaimen nimi').fill(`Selainkoe ${viewport.width}`);
    await page.getByRole('button', { name: 'Luo API-avain' }).click();
    await page.locator('#new-key').waitFor({ state: 'visible' });
    assert.match(await page.locator('#key-value').inputValue(), /^os_/);
    await page.getByRole('button', { name: 'Olen tallentanut avaimen' }).click();
    assert.equal(await page.locator('#key-value').inputValue(), '');
    for (const view of ['calendar', 'editor', 'channels', 'agents']) {
      await page.locator(`nav a[href="#${view}"]`).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Horizontal overflow in ${view} at ${viewport.width}`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  assert.equal(publications, 0, 'Browser tests must not accidentally publish');
  console.log('Browser checks passed: login, drafts, editing, scheduling, channel check, API key, four responsive views at 1440px and 390px. Only a fake provider was used.');
} finally {
  await browser.close(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true });
}
