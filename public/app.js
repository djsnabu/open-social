import { wallTime, toInstant } from './time.js';
import { cropImage } from './crop.js';

const $ = selector => document.querySelector(selector);
const labels = { draft: 'Luonnos', scheduled: 'Ajastettu', publishing: 'Julkaistaan', published: 'Julkaistu', failed: 'Epäonnistui', uncertain: 'Tarkista tulos', cancelled: 'Peruttu', connected: 'Yhdistetty', disconnected: 'Ei yhdistetty', reconnect_required: 'Yhdistä uudelleen', check_failed: 'Tarkistus epäonnistui' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const badge = state => `<span class="badge ${esc(state)}">${esc(labels[state] || state)}</span>`;
const providerName = provider => provider === 'facebook' ? 'Facebook' : 'Instagram';
let channels = [], posts = [], status, keys = [], nextOffset = null;
let editing = null, mediaId = null, mediaName = '', selectedDay = null;
let month = new Date().getMonth(), year = new Date().getFullYear(), uploading = false;
let noticeTimer, fetching = false, submitKey = null, actionKey = null;
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = [...new Set([browserZone, 'Europe/Helsinki', 'UTC', ...Intl.supportedValuesOf('timeZone')])];
for (const select of [$('#calendar-zone'), $('#post-zone')]) {
  select.innerHTML = zones.map(zone => `<option value="${esc(zone)}">${esc(zone)}</option>`).join('');
  select.value = browserZone;
}
function notify(message, error = false) {
  clearTimeout(noticeTimer); $('#notice').textContent = message; $('#notice').className = error ? 'error' : ''; $('#notice').hidden = false;
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, error ? 14000 : 6000);
}
async function api(path, { method = 'GET', data, idempotency, raw } = {}) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (raw) headers['Content-Type'] = raw.type;
  if (idempotency) headers['Idempotency-Key'] = idempotency;
  let response;
  try { response = await fetch(`/api/v1${path}`, { method, headers, body: raw || (data === undefined ? undefined : JSON.stringify(data)) }); }
  catch { throw new Error('Verkkoyhteys katkesi. Voit yrittää samaa toimintoa uudelleen.'); }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    const error = new Error(result.error?.message || 'Pyyntö epäonnistui.'); error.code = result.error?.code; throw error;
  }
  return result;
}
function showLogin() { $('#workspace').hidden = true; $('#login').hidden = false; }
function dateLabel(date, zone = $('#calendar-zone').value) {
  return new Intl.DateTimeFormat('fi-FI', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));
}
async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const [newChannels, result, newStatus] = await Promise.all([api('/channels'), api('/posts'), api('/status')]);
    channels = newChannels; posts = result.posts; nextOffset = result.nextOffset; status = newStatus;
    $('#login').hidden = true; $('#workspace').hidden = false;
    const selected = $('#post-channel').value;
    $('#post-channel').innerHTML = '<option value="">Valitse kanava</option>' + channels.map(c => `<option value="${esc(c.id)}">${esc(c.name)} · ${providerName(c.provider)}${c.status === 'connected' ? '' : ' · tarkista yhteys'}</option>`).join('');
    $('#post-channel').value = selected;
    $('#setup-note').hidden = status.metaConfigured && status.publishingEnabled;
    $('#setup-note').innerHTML = !status.metaConfigured
      ? 'Aloita yhdistämällä oma Meta-sovellus: lisää palvelimen asetuksiin <code>META_APP_ID</code> ja <code>META_APP_SECRET</code>. <a href="#channels">Kanavien yhdistäminen →</a>'
      : 'Julkaiseminen on pois käytöstä. Voit valmistella luonnoksia. Ota <code>ENABLE_PUBLISHING</code> käyttöön palvelimella, kun testitili on valittu.';
    renderCalendar(); renderChannels(); preview(); route();
  } finally { fetching = false; }
}
function route() {
  const view = ['calendar', 'editor', 'channels', 'agents'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'calendar';
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== view; });
  document.querySelectorAll('[data-nav]').forEach(el => { if (el.dataset.nav === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  if (view === 'channels' && status) candidates().catch(error => notify(error.message, true));
  if (view === 'agents' && status) loadKeys().catch(error => notify(error.message, true));
}
window.addEventListener('hashchange', route);

function renderCalendar() {
  const zone = $('#calendar-zone').value;
  const counts = [posts.filter(p => p.state === 'draft').length, posts.filter(p => p.state === 'scheduled').length, posts.filter(p => p.state === 'published').length, posts.filter(p => ['failed', 'uncertain'].includes(p.state)).length];
  $('#stats').innerHTML = ['Luonnosta', 'Ajastettua', 'Julkaistua', 'Tarkistettavaa'].map((label, i) => `<div class="stat"><strong>${counts[i]}</strong><span>${label}${nextOffset !== null ? ' (ladatut)' : ''}</span></div>`).join('');
  $('#month-title').textContent = new Intl.DateTimeFormat('fi-FI', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, 15)));
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first); start.setUTCDate(1 - (first.getUTCDay() + 6) % 7);
  const today = wallTime(Date.now(), zone).slice(0, 10);
  const scheduled = posts.filter(p => p.scheduled_at && p.state !== 'cancelled');
  let html = ['Ma', 'Ti', 'Ke', 'To', 'Pe', 'La', 'Su'].map(day => `<span class="weekday">${day}</span>`).join('');
  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getTime() + i * 86400000), day = date.toISOString().slice(0, 10);
    const count = scheduled.filter(p => wallTime(p.scheduled_at, zone).startsWith(day)).length;
    html += `<button class="day${date.getUTCMonth() !== month ? ' other' : ''}${day === today ? ' today' : ''}${day === selectedDay ? ' selected' : ''}" data-day="${day}" aria-label="${day}, ${count} julkaisua" aria-pressed="${day === selectedDay}"><span class="day-number">${date.getUTCDate()}</span>${count ? `<span class="day-count">${count} julk.</span>` : ''}</button>`;
  }
  $('#month-grid').innerHTML = html;
  $('#list-title').textContent = selectedDay ? `Julkaisut ${selectedDay.split('-').reverse().join('.')}` : 'Kuukauden julkaisut & luonnokset';
  $('#clear-day').hidden = !selectedDay;
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const filter = $('#state-filter').value;
  const visible = posts.filter(p => (filter === 'all' || p.state === filter) && (p.scheduled_at ? wallTime(p.scheduled_at, zone).startsWith(selectedDay || prefix) : !selectedDay));
  $('#post-list').innerHTML = visible.length ? visible.map(p => {
    const c = channels.find(c => c.id === p.channel_id);
    return `<article class="post-row">${p.media_id ? `<img class="thumb" src="/media/${esc(p.media_id)}.jpg" alt="">` : '<span class="avatar" aria-hidden="true">os</span>'}<div class="post-info"><h3>${esc(p.text || 'Kuvajulkaisu')}</h3><p>${esc(c?.name || 'Kanava')} · ${p.scheduled_at ? esc(dateLabel(p.scheduled_at)) : 'Ei ajastettu'}</p></div>${badge(p.state)}<button class="quiet" data-detail="${esc(p.id)}" aria-label="Avaa julkaisu: ${esc(p.text.slice(0, 50) || 'Kuvajulkaisu')}">Avaa →</button></article>`;
  }).join('') : '<div class="empty"><h3>Seuraava julkaisu alkaa tästä.</h3><p>Tässä näkymässä ei vielä ole julkaisuja. Yhdistä kanava ja tallenna ensimmäinen luonnos.</p><a href="#editor">Kirjoita julkaisu →</a></div>';
  $('#more-posts').hidden = nextOffset === null;
}
$('#month-grid').addEventListener('click', event => { const button = event.target.closest('[data-day]'); if (button) { selectedDay = button.dataset.day; renderCalendar(); } });
$('#prev-month').onclick = () => { month--; if (month < 0) { month = 11; year--; } selectedDay = null; renderCalendar(); };
$('#next-month').onclick = () => { month++; if (month > 11) { month = 0; year++; } selectedDay = null; renderCalendar(); };
$('#clear-day').onclick = () => { selectedDay = null; renderCalendar(); };
$('#calendar-zone').onchange = renderCalendar; $('#state-filter').onchange = renderCalendar;
$('#more-posts').onclick = async () => { try { const result = await api(`/posts?offset=${nextOffset}`); posts = [...new Map([...posts, ...result.posts].map(p => [p.id, p])).values()]; nextOffset = result.nextOffset; renderCalendar(); } catch (error) { notify(error.message, true); } };

function preview() {
  const c = channels.find(c => c.id === $('#post-channel').value);
  $('#preview-name').textContent = c?.name || 'Valitse kanava';
  $('#preview-provider').textContent = c ? providerName(c.provider) : 'Julkaisun alustava esikatselu';
  $('#preview-text').textContent = $('#post-text').value || 'Tekstisi näkyy tässä.';
  $('#char-count').textContent = `${[...$('#post-text').value].length}${c?.provider === 'instagram' ? ' / 2 200' : ''} merkkiä`;
  $('#preview-image').hidden = !mediaId;
  if (mediaId) $('#preview-image').src = `/media/${mediaId}.jpg`; else $('#preview-image').removeAttribute('src');
  $('#media-info').hidden = !mediaId; $('#media-info span').textContent = mediaName || 'Julkaisuun liitetty kuva';
}
$('#post-text').oninput = preview; $('#post-channel').onchange = preview;
$('#post-form').addEventListener('input', () => { submitKey = null; actionKey = null; });
function resetEditor() {
  editing = null; mediaId = null; mediaName = ''; submitKey = null; actionKey = null;
  $('#post-form').reset(); $('#post-zone').value = browserZone; $('#editor-title').textContent = 'Uusi julkaisu'; preview();
}
$('#new-draft').onclick = () => { if (!$('#post-text').value || confirm('Tyhjennetäänkö tallentamaton lomake?')) resetEditor(); };
$('#remove-image').onclick = () => { mediaId = null; mediaName = ''; submitKey = null; actionKey = null; $('#post-file').value = ''; preview(); };
async function attachImage(file, name) {
  if (uploading) return;
  uploading = true; $('#post-file').disabled = true; $('#crop-image').disabled = true;
  try {
    const cropped = await cropImage(file);
    if (!cropped) return;
    const image = await api('/media', { method: 'POST', raw: cropped });
    mediaId = image.id; mediaName = `${name} · ${image.width} × ${image.height}`;
    submitKey = null; actionKey = null; preview();
  } catch (error) { notify(error.message, true); }
  finally { uploading = false; $('#post-file').value = ''; $('#post-file').disabled = false; $('#crop-image').disabled = false; }
}
$('#post-file').onchange = () => {
  const file = $('#post-file').files[0]; if (file) attachImage(file, file.name);
};
$('#crop-image').onclick = async () => {
  if (uploading || !mediaId) return;
  try {
    const response = await fetch(`/media/${mediaId}.jpg`);
    if (!response.ok) throw new Error('Kuvan lataaminen epäonnistui.');
    await attachImage(await response.blob(), 'Rajattu kuva');
  } catch (error) { notify(error.message, true); }
};
$('#post-form').onsubmit = async event => {
  event.preventDefault();
  if (uploading) return notify('Odota kuvan latauksen valmistumista.', true);
  const action = event.submitter?.value || 'draft';
  const buttons = [...$('#post-form').querySelectorAll('button')];
  buttons.forEach(b => { b.disabled = true; });
  try {
    const data = { channel_id: $('#post-channel').value, text: $('#post-text').value, media_id: mediaId, timezone: $('#post-zone').value };
    let scheduledAt;
    if (action !== 'draft' && !status.publishingEnabled) throw new Error('Julkaiseminen on pois käytöstä. Tallenna luonnos ja viimeistele palvelimen Meta-asetukset.');
    if (action === 'schedule') {
      scheduledAt = toInstant($('#schedule-time').value, data.timezone);
      if (Date.parse(scheduledAt) <= Date.now()) throw new Error('Valitse tuleva julkaisuaika.');
    }
    if (action === 'publish' && !confirm('Julkaistaanko sisältö nyt valitulle kanavalle?')) return;
    submitKey ||= crypto.randomUUID();
    const saved = await api(editing ? `/posts/${editing.id}` : '/posts', { method: editing ? 'PATCH' : 'POST', data: { ...data, ...(editing ? { version: editing.version } : {}) }, idempotency: submitKey });
    editing = saved; submitKey = null;
    if (action !== 'draft') {
      actionKey ||= crypto.randomUUID();
      editing = await api(`/posts/${saved.id}/${action}`, { method: 'POST', data: { version: saved.version, ...(scheduledAt ? { scheduled_at: scheduledAt } : {}) }, idempotency: actionKey });
    }
    resetEditor(); await refresh(); location.hash = 'calendar';
    notify(action === 'draft' ? 'Luonnos tallennettu.' : action === 'schedule' ? 'Julkaisu ajastettu.' : 'Julkaisu lisätty jonoon. Vahvistettu tulos näkyy kalenterissa.');
  } catch (error) { notify(error.message, true); }
  finally { buttons.forEach(b => { b.disabled = false; }); }
};

async function details(id) {
  const [p, attempts] = await Promise.all([api(`/posts/${id}`), api(`/posts/${id}/attempts`)]);
  const c = channels.find(c => c.id === p.channel_id);
  $('#detail-content').innerHTML = `<p class="eyebrow">${esc(c?.name)} · ${esc(c ? providerName(c.provider) : '')}</p><h2>Julkaisun tiedot</h2>${badge(p.state)}<p class="small muted">${p.scheduled_at ? esc(dateLabel(p.scheduled_at, p.timezone)) + ' · ' + esc(p.timezone) : 'Ei ajastettu'}</p>${p.media_id ? `<img src="/media/${esc(p.media_id)}.jpg" alt="Julkaisun kuva">` : ''}<p>${esc(p.text)}</p>${p.error_message ? `<div class="error-box">${esc(p.error_message)}</div>` : ''}${p.remote_id ? `<p class="small">Julkaisutunniste: <code>${esc(p.remote_id)}</code></p>` : ''}<div id="publication-link"></div><div class="row-actions">${['draft', 'scheduled', 'failed'].includes(p.state) ? '<button id="edit-post">Muokkaa</button><button id="cancel-post" class="quiet">Peru julkaisu</button>' : ''}</div>${p.state === 'uncertain' ? '<form id="reconcile-form"><p>Tarkista ensin julkaisu kanavalta. Jos se löytyy, anna sen Meta-tunniste. Sovellus varmistaa kanavan ja tekstin.</p><label>Metan julkaisutunniste<input name="remote_id" required pattern="[0-9_]+"></label><button>Vahvista olemassa oleva julkaisu</button></form>' : ''}<h3>Julkaisuyritykset</h3>${attempts.length ? attempts.map(a => `<div class="attempt">${esc(dateLabel(a.started_at))} · ${esc(labels[a.outcome] || a.outcome)}${a.error_code ? ` · ${esc(a.error_code)}` : ''}</div>`).join('') : '<p class="small muted">Ei julkaisuyrityksiä.</p>'}`;
  if (p.remote_url) {
    try { const url = new URL(p.remote_url); if (url.protocol === 'https:' && /(^|\.)(facebook|instagram)\.com$/.test(url.hostname)) { const a = document.createElement('a'); a.href = url.href; a.textContent = 'Avaa julkaisu ↗'; a.target = '_blank'; a.rel = 'noreferrer'; $('#publication-link').append(a); } } catch { /* Keep the confirmed ID visible even without a valid link. */ }
  }
  if ($('#edit-post')) $('#edit-post').onclick = () => {
    editing = p; mediaId = p.media_id; submitKey = null; actionKey = null;
    $('#post-channel').value = p.channel_id; $('#post-text').value = p.text; $('#post-zone').value = p.timezone;
    $('#schedule-time').value = p.scheduled_at ? wallTime(p.scheduled_at, p.timezone) : '';
    $('#editor-title').textContent = 'Muokkaa julkaisua'; preview(); $('#details').close(); location.hash = 'editor';
  };
  if ($('#cancel-post')) $('#cancel-post').onclick = async () => {
    if (!confirm('Perutaanko julkaisu? Sisältö säilyy historiassa.')) return;
    try { await api(`/posts/${p.id}/cancel`, { method: 'POST', data: { version: p.version }, idempotency: crypto.randomUUID() }); $('#details').close(); await refresh(); notify('Julkaisu peruttu.'); } catch (error) { notify(error.message, true); }
  };
  if ($('#reconcile-form')) $('#reconcile-form').onsubmit = async event => {
    event.preventDefault();
    try { await api(`/posts/${p.id}/reconcile`, { method: 'POST', data: { version: p.version, remote_id: new FormData(event.target).get('remote_id') } }); await details(p.id); await refresh(); notify('Julkaisu vahvistettu.'); } catch (error) { notify(error.message, true); }
  };
  if (!$('#details').open) $('#details').showModal();
}
$('#post-list').onclick = event => { const button = event.target.closest('[data-detail]'); if (button) details(button.dataset.detail).catch(error => notify(error.message, true)); };
$('#close-details').onclick = () => $('#details').close();

function renderChannels() {
  $('#channel-list').innerHTML = channels.length ? channels.map(c => `<article class="channel-row"><span class="avatar" aria-hidden="true">${c.provider === 'facebook' ? 'f' : 'ig'}</span><div class="channel-info"><h3>${esc(c.name)}</h3><p>${providerName(c.provider)}${c.checked_at ? ` · Tarkistettu ${esc(dateLabel(c.checked_at))}` : ''}</p></div>${badge(c.status)}<div class="row-actions"><button class="quiet" data-check="${esc(c.id)}">Tarkista</button><button class="quiet" data-disconnect="${esc(c.id)}">Katkaise yhteys</button></div></article>`).join('') : '<div class="empty"><h3>Omat kanavasi, samassa paikassa.</h3><p>Yhtään kanavaa ei ole vielä yhdistetty. Aloita yllä olevasta Yhdistä Metaan -painikkeesta.</p></div>';
}
async function candidates() {
  const available = await api('/channels/candidates');
  $('#candidates').innerHTML = available.length ? '<h2>Valitse yhdistettävät kanavat</h2>' + available.map(c => `<div class="candidate"><div><strong>${esc(c.name)}</strong><br><span class="small">${providerName(c.provider)}</span></div><button data-select="${esc(c.remote_id)}" data-provider="${esc(c.provider)}">${channels.some(ch => ch.remote_id === c.remote_id && ch.provider === c.provider) ? 'Uudista yhteys' : 'Yhdistä kanava'}</button></div>`).join('') : '';
}
$('#connect').onclick = async () => { try { const result = await api('/channels/connect', { method: 'POST', data: {} }); location.assign(result.url); } catch (error) { notify(error.message, true); } };
$('#candidates').onclick = async event => {
  const button = event.target.closest('[data-select]'); if (!button) return;
  button.disabled = true;
  try { await api('/channels/select', { method: 'POST', data: { remote_id: button.dataset.select, provider: button.dataset.provider } }); await refresh(); notify('Kanava yhdistetty.'); } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
};
$('#channel-list').onclick = async event => {
  const button = event.target.closest('button'); if (!button) return;
  const id = button.dataset.check || button.dataset.disconnect; if (!id) return;
  if (button.dataset.disconnect && !confirm('Katkaistaanko yhteys? Kanavan ajastetut julkaisut palautetaan luonnoksiksi.')) return;
  button.disabled = true;
  try { const result = await api(`/channels/${id}${button.dataset.check ? '/check' : ''}`, { method: button.dataset.check ? 'POST' : 'DELETE', data: {} }); notify(result.note || 'Yhteys katkaistu.'); }
  catch (error) { notify(error.message, true); }
  finally { await refresh().catch(error => notify(error.message, true)); button.disabled = false; }
};
async function loadKeys() {
  keys = await api('/keys');
  $('#key-list').innerHTML = keys.map(key => `<div class="key-row"><strong>${esc(key.name)}</strong><p>${esc(key.scopes.join(' · '))}</p><button class="quiet" data-revoke="${esc(key.id)}">Peru avain</button></div>`).join('');
}
$('#key-form').onsubmit = async event => {
  event.preventDefault(); const form = new FormData(event.target);
  try { const result = await api('/keys', { method: 'POST', data: { name: form.get('name'), scopes: form.getAll('scope') } }); $('#key-value').value = result.token; $('#new-key').hidden = false; await loadKeys(); } catch (error) { notify(error.message, true); }
};
$('#hide-key').onclick = () => { $('#key-value').value = ''; $('#new-key').hidden = true; };
$('#key-list').onclick = async event => {
  const button = event.target.closest('[data-revoke]'); if (!button || !confirm('Perutaanko avaimen käyttöoikeus heti?')) return;
  try { await api(`/keys/${button.dataset.revoke}`, { method: 'DELETE' }); await loadKeys(); notify('API-avain peruttu.'); } catch (error) { notify(error.message, true); }
};
$('#login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { await api('/login', { method: 'POST', data: { password: new FormData(event.target).get('password') } }); event.target.reset(); await refresh(); }
  catch (error) { notify(error.message, true); } finally { button.disabled = false; }
};
$('#logout').onclick = async () => { try { await api('/logout', { method: 'POST', data: {} }); status = null; channels = []; posts = []; $('#key-value').value = ''; $('#new-key').hidden = true; resetEditor(); showLogin(); } catch (error) { notify(error.message, true); } };
const params = new URLSearchParams(location.search);
if (params.has('connection_error')) notify(params.get('connection_error') === 'no_channels'
  ? 'Meta ei palauttanut julkaistavia kanavia. Tarkista kirjautumisen sivuvalinnat ja yritysportfolion käyttöoikeudet, ja yhdistä uudelleen.'
  : `Kanavan yhdistäminen epäonnistui (${params.get('connection_error')}). Aloita yhdistäminen uudelleen.`, true);
if (location.search) history.replaceState(null, '', `/${location.hash}`);
refresh().catch(error => { if (error.code !== 'unauthorized') notify(error.message, true); });
setInterval(() => {
  if (status && !document.hidden && (!location.hash || location.hash === '#calendar') && !$('#details').open) refresh().catch(error => notify(error.message, true));
}, 15000);
