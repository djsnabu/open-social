import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { openDatabase, transaction } from './db.js';
import { AppError, requireValue, digest, randomToken, verifyPassword, vault } from './security.js';
import { createMeta } from './meta.js';
import { createScheduler } from './scheduler.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const scopes = ['posts:read', 'posts:write', 'posts:publish', 'channels:read', 'media:write'];
const now = () => new Date().toISOString();
const channelFields = 'id,provider,remote_id,name,status,checked_at';

async function body(req, limit = 65536, json = true) {
  requireValue(!json || req.headers['content-type']?.split(';')[0] === 'application/json', 'content_type', 'Käytä application/json-sisältötyyppiä.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    requireValue(size <= limit, 'body_too_large', 'Tiedosto tai pyyntö on liian suuri.', 413);
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (!json) return buffer;
  let data;
  try { data = JSON.parse(buffer.toString()); } catch { throw new AppError(400, 'invalid_json', 'Virheellinen JSON.'); }
  requireValue(data && typeof data === 'object' && !Array.isArray(data), 'invalid_body', 'Pyynnön on oltava JSON-objekti.');
  return data;
}

export async function createApp(config, options = {}) {
  const secrets = vault(config.appKey);
  await mkdir(resolve(config.dataDir, 'media'), { recursive: true, mode: 0o700 });
  const db = openDatabase(resolve(config.dataDir, 'open-social.db'));
  const meta = options.meta || createMeta(config);
  const scheduler = createScheduler({ db, config, meta, secrets });
  const attempts = new Map();
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const cookie = (token, age = 86400) => `os_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${config.origin.startsWith('https:') ? '; Secure' : ''}`;

  function authenticate(req) {
    if (req.headers.authorization) {
      requireValue(req.headers.authorization.startsWith('Bearer '), 'unauthorized', 'Käytä Bearer-avainta.', 401);
      const key = db.prepare('SELECT id,scopes FROM api_keys WHERE hash=?').get(digest(req.headers.authorization.slice(7)));
      requireValue(key, 'unauthorized', 'API-avain puuttuu tai on peruttu.', 401);
      return { id: key.id, scopes: JSON.parse(key.scopes), owner: false };
    }
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('os_session='))?.slice(11);
    const hash = digest(token || '');
    requireValue(db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(hash, Date.now()), 'unauthorized', 'Kirjaudu sisään.', 401);
    if (!['GET', 'HEAD'].includes(req.method)) requireValue(req.headers.origin === config.origin, 'invalid_origin', 'Pyynnön alkuperä ei täsmää.', 403);
    return { id: 'owner', owner: true, hash };
  }
  function need(user, scope) { requireValue(user.owner || user.scopes.includes(scope), 'forbidden', `Puuttuva oikeus: ${scope}.`, 403); }
  function owner(user) { requireValue(user.owner, 'forbidden', 'Toiminto vaatii ylläpitäjän selainistunnon.', 403); }
  function channel(id) {
    const row = db.prepare('SELECT * FROM channels WHERE id=?').get(typeof id === 'string' ? id : '');
    requireValue(row, 'channel_not_found', 'Valitse olemassa oleva kanava.', 404);
    return row;
  }
  function post(id) {
    const row = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
    requireValue(row, 'post_not_found', 'Julkaisua ei löydy.', 404);
    return row;
  }
  function validPost(data) {
    const selected = channel(data.channel_id);
    requireValue(typeof data.text === 'string' && data.text.length <= 63206, 'invalid_text', 'Tekstin enimmäispituus on 63 206 merkkiä.');
    requireValue(typeof data.timezone === 'string' && data.timezone.length <= 100, 'invalid_timezone', 'Anna IANA-aikavyöhyke.');
    try { new Intl.DateTimeFormat('en', { timeZone: data.timezone }); } catch { throw new AppError(400, 'invalid_timezone', 'Tuntematon aikavyöhyke.'); }
    requireValue(data.media_id == null || (typeof data.media_id === 'string' && db.prepare('SELECT id FROM media WHERE id=?').get(data.media_id)), 'invalid_media', 'Kuvaa ei löydy.');
    requireValue(data.text.trim() || data.media_id, 'empty_post', 'Lisää teksti tai kuva.');
    if (selected.provider === 'instagram') {
      requireValue(data.media_id, 'image_required', 'Instagram-julkaisu tarvitsee kuvan.');
      requireValue([...data.text].length <= 2200, 'caption_too_long', 'Instagram-tekstin enimmäispituus on 2 200 merkkiä.');
      const media = db.prepare('SELECT * FROM media WHERE id=?').get(data.media_id);
      requireValue(media.width / media.height >= 0.8 && media.width / media.height <= 1.91, 'image_ratio', 'Instagram-kuvan kuvasuhteen on oltava 4:5–1,91:1.');
    }
    return selected;
  }
  function version(data, row) { requireValue(Number.isInteger(data.version) && data.version === row.version, 'version_conflict', 'Julkaisu on muuttunut. Päivitä näkymä ja yritä uudelleen.', 409); }
  function idempotent(req, user, data, fn) {
    const key = req.headers['idempotency-key'];
    requireValue(typeof key === 'string' && /^[\w.-]{8,128}$/.test(key), 'idempotency_required', 'Anna Idempotency-Key (8–128 merkkiä).');
    const fingerprint = digest(`${req.method} ${req.url}\n${JSON.stringify(data)}`);
    return transaction(db, () => {
      const previous = db.prepare('SELECT * FROM requests WHERE principal=? AND key=?').get(user.id, key);
      if (previous) {
        requireValue(previous.fingerprint === fingerprint, 'idempotency_conflict', 'Avain on käytetty eri pyyntöön.', 409);
        return JSON.parse(previous.response);
      }
      const response = fn();
      db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(user.id, key, fingerprint, JSON.stringify(response));
      return response;
    });
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let path;
    try {
      requireValue(req.url.startsWith('/') && !req.url.startsWith('//'), 'invalid_path', 'Virheellinen osoite.');
      const url = new URL(req.url, config.origin);
      path = url.pathname;
      requireValue(req.headers.host === new URL(config.origin).host, 'invalid_host', 'Tuntematon palvelinosoite.', 400);
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/time.js'].includes(path)) {
        const name = path === '/' ? 'index.html' : path.slice(1);
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
        return res.end(await readFile(resolve(publicDir, name)));
      }
      if (req.method === 'GET' && /^\/media\/[a-f0-9-]{36}\.jpg$/.test(path)) {
        const id = path.slice(7, -4);
        requireValue(db.prepare('SELECT id FROM media WHERE id=?').get(id), 'not_found', 'Kuvaa ei löydy.', 404);
        const shared = db.prepare("SELECT id FROM posts WHERE media_id=? AND state IN ('publishing','published','uncertain')").get(id);
        if (!shared) { const reader = authenticate(req); need(reader, 'posts:read'); }
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', shared ? 'public, max-age=3600' : 'private, no-store');
        return res.end(await readFile(resolve(config.dataDir, 'media', path.slice(7))));
      }
      if (path === '/api/v1/login' && req.method === 'POST') {
        requireValue(req.headers.origin === config.origin, 'invalid_origin', 'Kirjaudu sovelluksen omalta sivulta.', 403);
        const key = req.socket.remoteAddress;
        for (const [ip, entry] of attempts) if (entry.until < Date.now()) attempts.delete(ip);
        const entry = attempts.get(key) || { count: 0, until: Date.now() + 15 * 60000 };
        requireValue(entry.count < 10 && attempts.size < 10000, 'rate_limited', 'Liian monta yritystä. Odota 15 minuuttia.', 429);
        entry.count++; attempts.set(key, entry);
        const data = await body(req, 4096);
        requireValue(typeof data.password === 'string' && data.password.length <= 256, 'invalid_password', 'Virheellinen salasana.', 401);
        requireValue(await verifyPassword(data.password, config.passwordHash), 'invalid_password', 'Virheellinen salasana.', 401);
        attempts.delete(key);
        const token = randomToken();
        db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
        db.prepare('INSERT INTO sessions VALUES(?,?)').run(digest(token), Date.now() + 86400000);
        res.setHeader('Set-Cookie', cookie(token));
        return send(res, 200, { ok: true });
      }
      const user = authenticate(req);
      if (path === '/api/v1/logout' && req.method === 'POST') {
        owner(user); db.prepare('DELETE FROM sessions WHERE hash=?').run(user.hash);
        db.prepare('DELETE FROM oauth WHERE session_hash=?').run(user.hash);
        res.setHeader('Set-Cookie', cookie('', 0)); return send(res, 200, { ok: true });
      }
      if (path === '/api/v1/status' && req.method === 'GET') {
        return send(res, 200, { owner: user.owner, metaConfigured: Boolean(config.metaAppId && config.metaSecret), publishingEnabled: config.publishingEnabled,
          origin: config.origin, scopes: user.owner ? scopes : user.scopes });
      }
      if (path === '/api/v1/keys') {
        owner(user);
        if (req.method === 'GET') return send(res, 200, db.prepare('SELECT id,name,scopes,created_at FROM api_keys ORDER BY created_at DESC').all().map(k => ({ ...k, scopes: JSON.parse(k.scopes) })));
        if (req.method === 'POST') {
          const data = await body(req);
          requireValue(typeof data.name === 'string' && data.name.trim() && data.name.length <= 80, 'invalid_name', 'Anna avaimelle nimi.');
          requireValue(Array.isArray(data.scopes) && data.scopes.length && data.scopes.every(s => scopes.includes(s)), 'invalid_scopes', 'Valitse tunnettuja API-oikeuksia.');
          const token = `os_${randomToken()}`, id = randomUUID();
          db.prepare('INSERT INTO api_keys VALUES(?,?,?,?,?)').run(id, data.name, digest(token), JSON.stringify([...new Set(data.scopes)]), now());
          return send(res, 201, { id, token });
        }
      }
      if (path.startsWith('/api/v1/keys/') && req.method === 'DELETE') {
        owner(user); db.prepare('DELETE FROM api_keys WHERE id=?').run(path.split('/').at(-1)); return send(res, 200, { ok: true });
      }
      if (path === '/api/v1/channels' && req.method === 'GET') {
        need(user, 'channels:read'); return send(res, 200, db.prepare(`SELECT ${channelFields} FROM channels ORDER BY name`).all());
      }
      if (path === '/api/v1/channels/connect' && req.method === 'POST') {
        owner(user);
        requireValue(config.metaAppId && config.metaSecret, 'meta_not_configured', 'Lisää META_APP_ID ja META_APP_SECRET palvelimen asetuksiin.', 409);
        const state = randomToken();
        db.prepare('DELETE FROM oauth WHERE expires < ? OR session_hash=?').run(Date.now(), user.hash);
        db.prepare('INSERT INTO oauth VALUES(?,?,?,NULL)').run(digest(state), user.hash, Date.now() + 600000);
        return send(res, 200, { url: meta.authorizationUrl(state) });
      }
      if (path === '/auth/meta/callback' && req.method === 'GET') {
        owner(user);
        const flow = db.prepare('DELETE FROM oauth WHERE hash=? AND session_hash=? AND expires>? AND candidates IS NULL RETURNING *').get(digest(url.searchParams.get('state') || ''), user.hash, Date.now());
        requireValue(flow, 'invalid_oauth_state', 'Yhdistämispyyntö vanheni tai ei kuulu tähän istuntoon. Aloita uudelleen.', 400);
        requireValue(!url.searchParams.has('error') && url.searchParams.get('code'), 'oauth_denied', 'Metan kirjautuminen peruttiin. Yritä uudelleen.');
        const candidates = await meta.discover(url.searchParams.get('code'));
        requireValue(candidates.length, 'no_channels', 'Meta ei palauttanut julkaistavia kanavia. Tarkista sivuvalinnat ja yritysportfolion oikeudet.', 409);
        db.prepare('INSERT INTO oauth VALUES(?,?,?,?)').run(flow.hash, user.hash, Date.now() + 600000, secrets.encrypt(candidates));
        res.writeHead(303, { Location: '/?connected=choose#channels' }); return res.end();
      }
      if (path === '/api/v1/channels/candidates' && req.method === 'GET') {
        owner(user);
        const flow = db.prepare('SELECT * FROM oauth WHERE session_hash=? AND expires>? AND candidates IS NOT NULL').get(user.hash, Date.now());
        const candidates = flow ? secrets.decrypt(flow.candidates).map(({ token, ...item }) => item) : [];
        return send(res, 200, candidates);
      }
      if (path === '/api/v1/channels/select' && req.method === 'POST') {
        owner(user); const data = await body(req);
        const flow = db.prepare('SELECT * FROM oauth WHERE session_hash=? AND expires>? AND candidates IS NOT NULL').get(user.hash, Date.now());
        requireValue(flow, 'connection_expired', 'Kanavavalinta vanheni. Yhdistä uudelleen.', 409);
        const selected = secrets.decrypt(flow.candidates).find(c => c.provider === data.provider && c.remote_id === data.remote_id);
        requireValue(selected, 'invalid_channel', 'Valitse Metan palauttama kanava.');
        db.prepare(`INSERT INTO channels(id,provider,remote_id,name,secret,status,checked_at) VALUES(?,?,?,?,?,'connected',?)
          ON CONFLICT(provider,remote_id) DO UPDATE SET name=excluded.name,secret=excluded.secret,status='connected',checked_at=excluded.checked_at`).run(
          randomUUID(), selected.provider, selected.remote_id, selected.name, secrets.encrypt(selected.token), now());
        return send(res, 200, { ok: true });
      }
      const channelRoute = path.match(/^\/api\/v1\/channels\/([\w-]+)(?:\/(check))?$/);
      if (channelRoute) {
        owner(user); const selected = channel(channelRoute[1]);
        if (req.method === 'POST' && channelRoute[2] === 'check') {
          requireValue(selected.status !== 'disconnected', 'reconnect_required', 'Yhdistä kanava uudelleen.', 409);
          let status = 'connected';
          try { requireValue(await meta.health(selected, secrets.decrypt(selected.secret)), 'reconnect_required', 'Kanavaa ei voitu vahvistaa.', 502); }
          catch (error) {
            status = error.code === 'reconnect_required' ? 'reconnect_required' : 'check_failed';
            db.prepare('UPDATE channels SET status=?,checked_at=? WHERE id=?').run(status, now(), selected.id);
            throw error;
          }
          db.prepare('UPDATE channels SET status=?,checked_at=? WHERE id=?').run(status, now(), selected.id);
          return send(res, 200, { status, note: 'Yhteys toimii. Julkaisuoikeus varmistuu vasta testijulkaisulla.' });
        }
        if (req.method === 'DELETE') {
          transaction(db, () => {
            requireValue(!db.prepare("SELECT id FROM posts WHERE channel_id=? AND state='publishing'").get(selected.id), 'publication_in_progress', 'Odota käynnissä olevan julkaisun valmistumista.', 409);
            db.prepare("UPDATE channels SET status='disconnected',secret='' WHERE id=?").run(selected.id);
            db.prepare("UPDATE posts SET state='draft',scheduled_at=NULL,updated_at=?,version=version+1 WHERE channel_id=? AND state='scheduled'").run(now(), selected.id);
          });
          return send(res, 200, { ok: true });
        }
      }
      if (path === '/api/v1/media' && req.method === 'POST') {
        need(user, 'media:write');
        requireValue(['image/jpeg', 'image/png', 'image/webp'].includes(req.headers['content-type']), 'invalid_media_type', 'Valitse JPEG-, PNG- tai WebP-kuva.', 415);
        const input = await body(req, 8 * 1024 * 1024, false);
        let output;
        try {
          const decoder = sharp(input, { limitInputPixels: 40000000, failOn: 'warning' });
          const metadata = await decoder.metadata();
          requireValue(['jpeg', 'png', 'webp'].includes(metadata.format) && (metadata.pages || 1) === 1, 'invalid_image', 'Valitse tavallinen, ei-animoitu kuva.');
          output = await decoder.rotate().resize({ width: 1440, height: 1800, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
        } catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, 'invalid_image', 'Kuvaa ei voitu lukea. Enintään 40 megapikseliä ja 8 Mt.'); }
        const id = randomUUID();
        const file = resolve(config.dataDir, 'media', `${id}.jpg`);
        await writeFile(file, output.data, { flag: 'wx', mode: 0o600 });
        try { db.prepare('INSERT INTO media VALUES(?,?,?,?,?)').run(id, output.info.width, output.info.height, output.data.length, now()); }
        catch (error) { await unlink(file); throw error; }
        return send(res, 201, { id, url: `/media/${id}.jpg`, width: output.info.width, height: output.info.height, size: output.data.length });
      }
      if (path === '/api/v1/posts' && req.method === 'GET') {
        need(user, 'posts:read');
        const offset = Number(url.searchParams.get('offset') || 0);
        requireValue(Number.isInteger(offset) && offset >= 0, 'invalid_offset', 'Virheellinen sivutus.');
        const state = url.searchParams.get('state');
        const where = state ? 'WHERE state=?' : '';
        const params = state ? [state] : [];
        const rows = db.prepare(`SELECT * FROM posts ${where} ORDER BY COALESCE(scheduled_at,created_at) DESC,id LIMIT 200 OFFSET ?`).all(...params, offset);
        return send(res, 200, { posts: rows, total: db.prepare(`SELECT count(*) AS n FROM posts ${where}`).get(...params).n, nextOffset: rows.length === 200 ? offset + 200 : null });
      }
      if (path === '/api/v1/posts' && req.method === 'POST') {
        need(user, 'posts:write'); const data = await body(req);
        const result = idempotent(req, user, data, () => {
          validPost(data);
          const id = randomUUID();
          db.prepare('INSERT INTO posts(id,channel_id,text,media_id,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, data.channel_id, data.text, data.media_id || null, data.timezone, now(), now());
          return post(id);
        });
        return send(res, 201, result);
      }
      const postRoute = path.match(/^\/api\/v1\/posts\/([\w-]+)(?:\/(publish|schedule|cancel|attempts|reconcile))?$/);
      if (postRoute) {
        const [, id, action] = postRoute;
        if (req.method === 'GET') {
          requireValue(!action || action === 'attempts', 'not_found', 'Tuntematon toiminto.', 404);
          need(user, 'posts:read');
          const row = post(id);
          return send(res, 200, action === 'attempts' ? db.prepare('SELECT * FROM attempts WHERE post_id=? ORDER BY id DESC').all(id) : row);
        }
        if (action === 'reconcile' && req.method === 'POST') {
          owner(user); const data = await body(req); const row = post(id); version(data, row);
          requireValue(row.state === 'uncertain', 'invalid_state', 'Vain epäselvän julkaisun voi täsmäyttää.', 409);
          const selected = channel(row.channel_id);
          requireValue(selected.status !== 'disconnected', 'reconnect_required', 'Yhdistä kanava uudelleen.', 409);
          const result = await meta.reconcile(row, selected, secrets.decrypt(selected.secret), data.remote_id);
          requireValue(db.prepare("UPDATE posts SET state='published',remote_id=?,remote_url=?,error_code=NULL,error_message=NULL,version=version+1,updated_at=? WHERE id=? AND version=? AND state='uncertain'").run(result.id, result.url, now(), id, row.version).changes, 'version_conflict', 'Julkaisu muuttui tarkistuksen aikana.', 409);
          return send(res, 200, post(id));
        }
        need(user, action === 'publish' || action === 'schedule' ? 'posts:publish' : 'posts:write');
        requireValue((req.method === 'PATCH' && !action) || (req.method === 'POST' && ['publish', 'schedule', 'cancel'].includes(action)), 'not_found', 'Tuntematon toiminto.', 404);
        const data = await body(req);
        const result = idempotent(req, user, data, () => {
          const row = post(id); version(data, row);
          if (req.method === 'PATCH') {
            requireValue(['draft', 'scheduled', 'failed'].includes(row.state), 'invalid_state', 'Tätä julkaisua ei voi muokata.', 409);
            const changed = { ...row, ...data }; validPost(changed);
            db.prepare(`UPDATE posts SET channel_id=?,text=?,media_id=?,timezone=?,state='draft',scheduled_at=NULL,container_id=NULL,
              error_code=NULL,error_message=NULL,version=version+1,updated_at=? WHERE id=?`).run(changed.channel_id, changed.text, changed.media_id || null, changed.timezone, now(), id);
          } else if (action === 'cancel') {
            requireValue(['draft', 'scheduled', 'failed'].includes(row.state), 'invalid_state', 'Käynnissä olevaa tai epäselvää julkaisua ei voi perua.', 409);
            db.prepare("UPDATE posts SET state='cancelled',scheduled_at=NULL,version=version+1,updated_at=? WHERE id=?").run(now(), id);
          } else {
            requireValue(config.publishingEnabled, 'publishing_disabled', 'Julkaiseminen on pois käytöstä. Ota ENABLE_PUBLISHING käyttöön palvelimella testitilin valinnan jälkeen.', 409);
            requireValue(['draft', 'failed'].includes(row.state), 'invalid_state', 'Julkaisua ei voi lähettää uudelleen tässä tilassa.', 409);
            const selected = validPost(row);
            requireValue(selected.status === 'connected', 'reconnect_required', 'Tarkista kanavayhteys tai yhdistä uudelleen.', 409);
            requireValue(!row.media_id || config.origin.startsWith('https:'), 'public_media_required', 'Kuvajulkaisu tarvitsee julkisen HTTPS-osoitteen.', 409);
            let date = now();
            if (action === 'schedule') {
              requireValue(typeof data.scheduled_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(data.scheduled_at), 'invalid_schedule', 'Anna yksiselitteinen UTC-aika, esimerkiksi 2026-12-01T10:00:00Z.');
              const ms = Date.parse(data.scheduled_at);
              requireValue(Number.isFinite(ms) && ms > Date.now() && new Date(ms).toISOString().slice(0, 19) === data.scheduled_at.slice(0, 19), 'invalid_schedule', 'Ajastuksen täytyy olla kelvollinen tuleva ajankohta.');
              date = new Date(ms).toISOString();
            }
            db.prepare("UPDATE posts SET state='scheduled',scheduled_at=?,error_code=NULL,error_message=NULL,version=version+1,updated_at=? WHERE id=?").run(date, now(), id);
          }
          return post(id);
        });
        return send(res, 200, result);
      }
      throw new AppError(404, 'not_found', 'Osoitetta ei löydy.');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error.status === 413) res.setHeader('Connection', 'close');
      if (path === '/auth/meta/callback') {
        res.writeHead(303, { Location: `/?connection_error=${encodeURIComponent(error.code || 'connection_failed')}#channels` }); return res.end();
      }
      send(res, error.status || 500, { error: { code: error.code && error.status ? error.code : 'internal_error', message: error.status ? error.message : 'Palvelinvirhe. Pyyntöä ei voitu suorittaa.' } });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return { server, db, config, scheduler, secrets };
}
