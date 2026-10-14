import sharp from 'sharp';
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
app.db.prepare('INSERT INTO channels(id,provider,remote_id,name,secret) VALUES(?,?,?,?,?)').run('channel-ig', 'instagram', '456', 'Instagram (simuloitu)', app.secrets.encrypt('fake'));
const fixture = await sharp(Buffer.from('<svg width="1600" height="400"><rect width="800" height="400" fill="#88ab88"/><rect x="800" width="800" height="400" fill="#e6bb88"/><circle cx="800" cy="200" r="120" fill="#346538"/></svg>')).png().toBuffer();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(config.origin);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await page.getByLabel('Password', { exact: true }).fill('browser-test-only');
    await page.getByRole('button', { name: 'Open workspace' }).click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.weekday').first().innerText(), 'Mon');
    assert.equal(await page.locator('#month-title').innerText(), new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date()));
    await page.screenshot({ path: `artifacts/calendar-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await page.locator('nav a[href="#editor"]').click();
    await page.locator('#post-channel').selectOption('channel-1');
    await page.getByLabel('Post text').fill(`Selainkoe ${viewport.width}: kesän tapahtumat.`);
    await page.locator('#post-file').setInputFiles({ name: 'crop-test.png', mimeType: 'image/png', buffer: fixture });
    await page.locator('#crop-dialog').waitFor({ state: 'visible' });
    await page.locator('#crop-cancel').click();
    await page.waitForFunction(() => !document.querySelector('#post-file').disabled);
    assert.equal(await page.locator('#preview-image').isVisible(), false);
    for (const [ratio, width, height] of [['0.8', 1080, 1350], ['1', 1080, 1080], ['1.91', 1337, 700]]) {
      await page.locator('#post-file').setInputFiles({ name: 'crop-test.png', mimeType: 'image/png', buffer: fixture });
      await page.locator('#crop-ratio').selectOption(ratio);
      await page.locator('#crop-zoom').fill('1.5');
      await page.locator('#crop-x').fill('0.5');
      await page.locator('#crop-y').fill('0.7');
      assert.equal(await page.locator('#crop-dialog').evaluate(el => el.scrollWidth > el.clientWidth), false);
      if (ratio === '0.8') await page.screenshot({ path: `artifacts/crop-${viewport.width}.png`, fullPage: true });
      const response = page.waitForResponse(r => r.url().endsWith('/api/v1/media') && r.request().method() === 'POST');
      await page.locator('#crop-apply').click();
      const media = await (await response).json();
      assert.equal(media.width, width); assert.equal(media.height, height);
      await page.waitForFunction(id => document.querySelector('#preview-image').src.endsWith(`/media/${id}.jpg`), media.id);
    }
    const previousImage = await page.locator('#preview-image').getAttribute('src');
    await page.locator('#crop-image').click();
    await page.locator('#crop-dialog').waitFor({ state: 'visible' });
    await page.locator('#crop-dialog').press('Escape');
    await page.waitForFunction(() => !document.querySelector('#post-file').disabled);
    assert.equal(await page.locator('#preview-image').getAttribute('src'), previousImage);
    await page.locator('#post-channel').selectOption('channel-ig');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.locator('#calendar').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: `Open post: Selainkoe ${viewport.width}: kesän tapahtumat.` }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#post-channel').selectOption('channel-1');
    await page.locator('#remove-image').click(); // Local HTTP test server cannot serve public Meta images.
    await page.getByLabel('Post text').fill(`Muokattu selainkoe ${viewport.width}`);
    await page.locator('#post-zone').selectOption('UTC');
    const later = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    await page.locator('#schedule-time').fill(later);
    await page.screenshot({ path: `artifacts/editor-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.locator('#calendar').waitFor({ state: 'visible' });
    assert.equal(app.db.prepare('SELECT state FROM posts WHERE text=?').get(`Muokattu selainkoe ${viewport.width}`).state, 'scheduled');
    // Multiple posts on one day, including media and a cancelled post, use the real calendar renderer.
    const monthPrefix = new Date().toISOString().slice(0, 7), day = `${monthPrefix}-15`;
    const mediaId = app.db.prepare('SELECT id FROM media LIMIT 1').get().id;
    for (const [suffix, time, state, media] of [['late', '18:00', 'scheduled', null], ['early', '08:30', 'scheduled', mediaId], ['middle', '12:00', 'scheduled', null], ['cancelled', '09:00', 'cancelled', null]]) {
      app.db.prepare('INSERT INTO posts(id,channel_id,text,media_id,state,scheduled_at,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(`preview-${viewport.width}-${suffix}`, 'channel-1', `Kalenterikoe ${suffix} <teksti>`, media, state, `${day}T${time}:00.000Z`, 'UTC', new Date().toISOString(), new Date().toISOString());
    }
    await page.reload();
    await page.locator('#calendar-zone').selectOption('UTC');
    const previews = page.locator(`.calendar-post[data-detail^="preview-${viewport.width}-"]`);
    assert.deepEqual(await previews.evaluateAll(els => els.map(el => el.dataset.detail)), ['early', 'middle', 'late'].map(suffix => `preview-${viewport.width}-${suffix}`));
    assert.equal(await page.locator(`[data-day="${day}"]`).locator('..').locator(`.calendar-post[data-detail^="preview-${viewport.width}-"]`).count(), 3);
    const early = page.locator(`[data-detail="preview-${viewport.width}-early"]`).first();
    await early.locator('img').evaluate(img => img.decode());
    assert.match(await early.innerText(), /08:30/);
    assert.match(await early.innerText(), /<teksti>/);
    await early.click();
    await page.locator('#details').waitFor({ state: 'visible' });
    assert.match(await page.locator('#detail-content').innerText(), /Kalenterikoe early/);
    await page.locator('#close-details').click();
    await page.locator(`[data-day="${day}"]`).click();
    assert.match(await page.locator('#list-title').innerText(), /15/);
    await page.screenshot({ path: `artifacts/calendar-previews-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await page.locator(`[data-day="${day}"]`).dblclick();
    await page.locator('#compose-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#schedule-time').inputValue(), `${day}T12:00`);
    assert.equal(await page.locator('#post-zone').inputValue(), 'UTC');
    assert.equal(await page.locator('#compose-dialog #editor').count(), 1);
    await page.locator('#post-channel').selectOption('channel-1');
    await page.locator('#post-text').fill(`Päivän julkaisu ${viewport.width}`);
    await page.locator('#post-file').setInputFiles({ name: 'crop-test.png', mimeType: 'image/png', buffer: fixture });
    await page.locator('#crop-dialog').waitFor({ state: 'visible' });
    await page.locator('#crop-cancel').click();
    await page.waitForFunction(() => !document.querySelector('#post-file').disabled);
    assert.equal(await page.locator('#compose-dialog').isVisible(), true);
    await page.screenshot({ path: `artifacts/day-editor-${viewport.width}.png`, fullPage: false, animations: 'disabled' });
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await page.locator('#compose-dialog').waitFor({ state: 'hidden' });
    assert.equal(app.db.prepare('SELECT state FROM posts WHERE text=?').get(`Päivän julkaisu ${viewport.width}`).state, 'draft');
    await page.locator('#create-for-day').click();
    await page.locator('#compose-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#post-text').inputValue(), '');
    await page.locator('#post-channel').selectOption('channel-1');
    await page.locator('#post-text').fill(`Ikkunan ajastus ${viewport.width}`);
    await page.locator('#schedule-time').fill('2000-01-01T12:00');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.locator('#compose-dialog #notice').waitFor({ state: 'visible' });
    assert.match(await page.locator('#notice').innerText(), /future publish time/);
    await page.locator('#schedule-time').fill(later);
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.locator('#compose-dialog').waitFor({ state: 'hidden' });
    assert.equal(app.db.prepare('SELECT state FROM posts WHERE text=?').get(`Ikkunan ajastus ${viewport.width}`).state, 'scheduled');
    await page.locator('#create-for-day').click();
    await page.locator('#compose-dialog').waitFor({ state: 'visible' });
    await page.locator('#post-text').fill('Säilytä keskeneräinen teksti');
    await page.locator('#close-compose').click();
    await page.locator('nav a[href="#editor"]').click();
    assert.equal(await page.locator('#post-text').inputValue(), 'Säilytä keskeneräinen teksti');
    assert.equal(await page.locator('main #editor').count(), 1);
    await page.locator('nav a[href="#calendar"]').click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator(`[data-day="${day}"]`).dblclick();
    assert.equal(await page.locator('#compose-dialog').isVisible(), false);
    assert.equal(await page.locator('#post-text').inputValue(), 'Säilytä keskeneräinen teksti');
    await page.locator('nav a[href="#channels"]').click();
    await page.getByRole('button', { name: 'Check', exact: true }).first().click();
    await page.getByText('Connection works.', { exact: false }).waitFor();
    await page.screenshot({ path: `artifacts/channels-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await page.locator('nav a[href="#agents"]').click();
    await page.getByLabel('Key name').fill(`Selainkoe ${viewport.width}`);
    await page.getByRole('button', { name: 'Create API key' }).click();
    await page.locator('#new-key').waitFor({ state: 'visible' });
    assert.match(await page.locator('#key-value').inputValue(), /^os_/);
    await page.getByRole('button', { name: 'I have saved the key' }).click();
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
