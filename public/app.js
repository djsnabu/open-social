import { wallTime, toInstant } from './time.js';
import { cropImage } from './crop.js';

const $ = selector => document.querySelector(selector);
const labels = { draft: 'Draft', scheduled: 'Scheduled', publishing: 'Publishing', published: 'Published', failed: 'Failed', uncertain: 'Check result', cancelled: 'Cancelled', connected: 'Connected', disconnected: 'Disconnected', reconnect_required: 'Reconnect', check_failed: 'Check failed' };
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
  if ($('#compose-dialog').open) $('#compose-dialog').prepend($('#notice')); else document.body.prepend($('#notice'));
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, error ? 14000 : 6000);
}
async function api(path, { method = 'GET', data, idempotency, raw } = {}) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (raw) headers['Content-Type'] = raw.type;
  if (idempotency) headers['Idempotency-Key'] = idempotency;
  let response;
  try { response = await fetch(`/api/v1${path}`, { method, headers, body: raw || (data === undefined ? undefined : JSON.stringify(data)) }); }
  catch { throw new Error('Connection lost. You can try the same action again.'); }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    const error = new Error(result.error?.message || 'Request failed.'); error.code = result.error?.code; throw error;
  }
  return result;
}
function showLogin() { $('#workspace').hidden = true; $('#login').hidden = false; }
function dateLabel(date, zone = $('#calendar-zone').value) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));
}
async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const [newChannels, result, newStatus] = await Promise.all([api('/channels'), api('/posts'), api('/status')]);
    channels = newChannels; posts = result.posts; nextOffset = result.nextOffset; status = newStatus;
    $('#login').hidden = true; $('#workspace').hidden = false;
    const selected = $('#post-channel').value;
    $('#post-channel').innerHTML = '<option value="">Choose a channel</option>' + channels.map(c => `<option value="${esc(c.id)}">${esc(c.name)} · ${providerName(c.provider)}${c.status === 'connected' ? '' : ' · check connection'}</option>`).join('');
    $('#post-channel').value = selected;
    $('#setup-note').hidden = status.metaConfigured && status.publishingEnabled;
    $('#setup-note').innerHTML = !status.metaConfigured
      ? 'Connect your Meta app: add these server settings: <code>META_APP_ID</code> and <code>META_APP_SECRET</code>. <a href="#channels">Connect channels →</a>'
      : 'Publishing is disabled. You can prepare drafts. Enable <code>ENABLE_PUBLISHING</code> on the server after selecting a test account.';
    renderCalendar(); renderChannels(); preview(); route();
  } finally { fetching = false; }
}
function route() {
  const view = ['calendar', 'editor', 'channels', 'agents'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'calendar';
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id === 'editor' && $('#compose-dialog').open ? false : el.id !== view; });
  document.querySelectorAll('[data-nav]').forEach(el => { if (el.dataset.nav === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  if (view === 'channels' && status) candidates().catch(error => notify(error.message, true));
  if (view === 'agents' && status) loadKeys().catch(error => notify(error.message, true));
}
window.addEventListener('hashchange', route);

function renderCalendar(updateGrid = true) {
  const zone = $('#calendar-zone').value;
  const counts = [posts.filter(p => p.state === 'draft').length, posts.filter(p => p.state === 'scheduled').length, posts.filter(p => p.state === 'published').length, posts.filter(p => ['failed', 'uncertain'].includes(p.state)).length];
  $('#stats').innerHTML = ['Drafts', 'Scheduled', 'Published', 'Needs attention'].map((label, i) => `<div class="stat"><strong>${counts[i]}</strong><span>${label}${nextOffset !== null ? ' (loaded)' : ''}</span></div>`).join('');
  $('#month-title').textContent = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, 15)));
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first); start.setUTCDate(1 - (first.getUTCDay() + 6) % 7);
  const today = wallTime(Date.now(), zone).slice(0, 10);
  const scheduled = posts.filter(p => p.scheduled_at && p.state !== 'cancelled').sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at) || a.id.localeCompare(b.id));
  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => `<span class="weekday">${day}</span>`).join('');
  for (let i = 0; i < 42; i++) {
    const date = new Date(start.getTime() + i * 86400000), day = date.toISOString().slice(0, 10);
    const dayPosts = scheduled.filter(p => wallTime(p.scheduled_at, zone).startsWith(day));
    const previews = dayPosts.map(p => {
      const channel = channels.find(c => c.id === p.channel_id);
      const time = wallTime(p.scheduled_at, zone).slice(11, 16);
      const name = `${channel?.name || 'Channel'} · ${channel ? providerName(channel.provider) : ''}`;
      return `<button class="calendar-post" data-detail="${esc(p.id)}" aria-label="${esc(`${time} · ${name} · ${labels[p.state]} · ${p.text || 'Image post'}`)}">
        <span class="calendar-post-time">${time} <span>${esc(channel?.provider === 'instagram' ? 'IG' : 'FB')}</span></span>
        ${p.media_id ? `<img src="/media/${esc(p.media_id)}.jpg" alt="" loading="lazy">` : ''}
        <span class="calendar-post-text">${esc(p.text || 'Image post')}</span>
        <span class="calendar-post-channel">${esc(channel?.name || 'Channel')}</span>${badge(p.state)}</button>`;
    }).join('');
    html += `<div data-calendar-day="${day}" class="day${date.getUTCMonth() !== month ? ' other' : ''}${day === today ? ' today' : ''}${day === selectedDay ? ' selected' : ''}"><button class="day-heading" data-day="${day}" aria-label="${day}, ${dayPosts.length} posts" aria-pressed="${day === selectedDay}"><span class="day-number">${date.getUTCDate()}</span>${dayPosts.length ? `<span class="day-count">${dayPosts.length} posts</span>` : ''}</button><div class="day-posts">${previews}</div></div>`;
  }
  // Keep day buttons in place on selection so the browser can recognize a double-click.
  if (updateGrid) $('#month-grid').innerHTML = html;
  for (const button of document.querySelectorAll('[data-day]')) {
    const selected = button.dataset.day === selectedDay;
    button.setAttribute('aria-pressed', String(selected)); button.closest('.day').classList.toggle('selected', selected);
  }
  $('#list-title').textContent = selectedDay ? `Posts ${selectedDay.split('-').reverse().join('/')}` : 'Monthly posts & drafts';
  $('#clear-day').hidden = !selectedDay; $('#create-for-day').hidden = !selectedDay;
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const filter = $('#state-filter').value;
  const visible = posts.filter(p => (filter === 'all' || p.state === filter) && (p.scheduled_at ? wallTime(p.scheduled_at, zone).startsWith(selectedDay || prefix) : !selectedDay));
  $('#post-list').innerHTML = visible.length ? visible.map(p => {
    const c = channels.find(c => c.id === p.channel_id);
    return `<article class="post-row">${p.media_id ? `<img class="thumb" src="/media/${esc(p.media_id)}.jpg" alt="">` : '<span class="avatar" aria-hidden="true">os</span>'}<div class="post-info"><h3>${esc(p.text || 'Image post')}</h3><p>${esc(c?.name || 'Channel')} · ${p.scheduled_at ? esc(dateLabel(p.scheduled_at)) : 'Not scheduled'}</p></div>${badge(p.state)}<button class="quiet" data-detail="${esc(p.id)}" aria-label="Open post: ${esc(p.text.slice(0, 50) || 'Image post')}">Open →</button></article>`;
  }).join('') : '<div class="empty"><h3>Your next post starts here.</h3><p>No posts in this view yet. Connect a channel and save your first draft.</p><a href="#editor">Write a post →</a></div>';
  $('#more-posts').hidden = nextOffset === null;
}
$('#month-grid').addEventListener('click', event => { const post = event.target.closest('[data-detail]'); if (post) { details(post.dataset.detail).catch(error => notify(error.message, true)); return; } const button = event.target.closest('[data-day]'); if (button) { selectedDay = button.dataset.day; renderCalendar(false); } });
function openDayEditor(day) {
  if (uploading) return notify('Wait for the image upload to finish.', true);
  if ((editing || mediaId || $('#post-text').value) && !confirm('Start a new post? Unsaved form content will be cleared.')) return;
  selectedDay = day; renderCalendar(false);
  resetEditor();
  $('#post-zone').value = $('#calendar-zone').value;
  $('#schedule-time').value = `${day}T12:00`;
  $('#editor-title').textContent = `New post · ${day.split('-').reverse().join('/')}`;
  $('#compose-dialog').append($('#editor'));
  $('#editor').hidden = false;
  $('#compose-dialog').showModal();
  $('#post-channel').focus();
}
$('#month-grid').addEventListener('dblclick', event => {
  if (event.target.closest('[data-detail]')) return;
  const day = event.target.closest('[data-calendar-day]');
  if (day) openDayEditor(day.dataset.calendarDay);
});
$('#create-for-day').onclick = () => { if (selectedDay) openDayEditor(selectedDay); };
$('#close-compose').onclick = () => $('#compose-dialog').close();
$('#compose-dialog').onclose = () => {
  document.body.prepend($('#notice')); $('#channels').before($('#editor')); route();
};
$('#prev-month').onclick = () => { month--; if (month < 0) { month = 11; year--; } selectedDay = null; renderCalendar(); };
$('#next-month').onclick = () => { month++; if (month > 11) { month = 0; year++; } selectedDay = null; renderCalendar(); };
$('#clear-day').onclick = () => { selectedDay = null; renderCalendar(); };
$('#calendar-zone').onchange = renderCalendar; $('#state-filter').onchange = renderCalendar;
$('#more-posts').onclick = async () => { try { const result = await api(`/posts?offset=${nextOffset}`); posts = [...new Map([...posts, ...result.posts].map(p => [p.id, p])).values()]; nextOffset = result.nextOffset; renderCalendar(); } catch (error) { notify(error.message, true); } };

function preview() {
  const c = channels.find(c => c.id === $('#post-channel').value);
  $('#preview-name').textContent = c?.name || 'Choose a channel';
  $('#preview-provider').textContent = c ? providerName(c.provider) : 'Post preview';
  $('#preview-text').textContent = $('#post-text').value || 'Your text appears here.';
  $('#char-count').textContent = `${[...$('#post-text').value].length}${c?.provider === 'instagram' ? ' / 2,200' : ''} characters`;
  $('#preview-image').hidden = !mediaId;
  if (mediaId) $('#preview-image').src = `/media/${mediaId}.jpg`; else $('#preview-image').removeAttribute('src');
  $('#media-info').hidden = !mediaId; $('#media-info span').textContent = mediaName || 'Attached image';
}
$('#post-text').oninput = preview; $('#post-channel').onchange = preview;
$('#post-form').addEventListener('input', () => { submitKey = null; actionKey = null; });
function resetEditor() {
  editing = null; mediaId = null; mediaName = ''; submitKey = null; actionKey = null;
  $('#post-form').reset(); $('#post-zone').value = browserZone; $('#editor-title').textContent = 'New post'; preview();
}
$('#new-draft').onclick = () => { if (!$('#post-text').value || confirm('Clear the unsaved form?')) resetEditor(); };
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
    if (!response.ok) throw new Error('Could not load the image.');
    await attachImage(await response.blob(), 'Cropped image');
  } catch (error) { notify(error.message, true); }
};
$('#post-form').onsubmit = async event => {
  event.preventDefault();
  if (uploading) return notify('Wait for the image upload to finish.', true);
  const action = event.submitter?.value || 'draft';
  const buttons = [...$('#post-form').querySelectorAll('button')];
  buttons.forEach(b => { b.disabled = true; });
  try {
    const data = { channel_id: $('#post-channel').value, text: $('#post-text').value, media_id: mediaId, timezone: $('#post-zone').value };
    let scheduledAt;
    if (action !== 'draft' && !status.publishingEnabled) throw new Error('Publishing is disabled. Save a draft and complete the server Meta settings.');
    if (action === 'schedule') {
      scheduledAt = toInstant($('#schedule-time').value, data.timezone);
      if (Date.parse(scheduledAt) <= Date.now()) throw new Error('Choose a future publish time.');
    }
    if (action === 'publish' && !confirm('Publish this content to the selected channel now?')) return;
    submitKey ||= crypto.randomUUID();
    const saved = await api(editing ? `/posts/${editing.id}` : '/posts', { method: editing ? 'PATCH' : 'POST', data: { ...data, ...(editing ? { version: editing.version } : {}) }, idempotency: submitKey });
    editing = saved; submitKey = null;
    if (action !== 'draft') {
      actionKey ||= crypto.randomUUID();
      editing = await api(`/posts/${saved.id}/${action}`, { method: 'POST', data: { version: saved.version, ...(scheduledAt ? { scheduled_at: scheduledAt } : {}) }, idempotency: actionKey });
    }
    resetEditor(); if ($('#compose-dialog').open) $('#compose-dialog').close(); await refresh(); location.hash = 'calendar';
    notify(action === 'draft' ? 'Draft saved.' : action === 'schedule' ? 'Post scheduled.' : 'Post queued. The confirmed result will appear in the calendar.');
  } catch (error) { notify(error.message, true); }
  finally { buttons.forEach(b => { b.disabled = false; }); }
};

async function details(id) {
  const [p, attempts] = await Promise.all([api(`/posts/${id}`), api(`/posts/${id}/attempts`)]);
  const c = channels.find(c => c.id === p.channel_id);
  $('#detail-content').innerHTML = `<p class="eyebrow">${esc(c?.name)} · ${esc(c ? providerName(c.provider) : '')}</p><h2>Post details</h2>${badge(p.state)}<p class="small muted">${p.scheduled_at ? esc(dateLabel(p.scheduled_at, p.timezone)) + ' · ' + esc(p.timezone) : 'Not scheduled'}</p>${p.media_id ? `<img src="/media/${esc(p.media_id)}.jpg" alt="Post image">` : ''}<p>${esc(p.text)}</p>${p.error_message ? `<div class="error-box">${esc(p.error_message)}</div>` : ''}${p.remote_id ? `<p class="small">Post ID: <code>${esc(p.remote_id)}</code></p>` : ''}<div id="publication-link"></div><div class="row-actions">${['draft', 'scheduled', 'failed'].includes(p.state) ? '<button id="edit-post">Edit</button><button id="cancel-post" class="quiet">Cancel post</button>' : ''}</div>${p.state === 'uncertain' ? '<form id="reconcile-form"><p>Check the channel for the post first. If you find it, enter its Meta ID. The app will verify the channel and text.</p><label>Meta post ID<input name="remote_id" required pattern="[0-9_]+"></label><button>Confirm existing post</button></form>' : ''}<h3>Publishing attempts</h3>${attempts.length ? attempts.map(a => `<div class="attempt">${esc(dateLabel(a.started_at))} · ${esc(labels[a.outcome] || a.outcome)}${a.error_code ? ` · ${esc(a.error_code)}` : ''}</div>`).join('') : '<p class="small muted">No publishing attempts.</p>'}`;
  if (p.remote_url) {
    try { const url = new URL(p.remote_url); if (url.protocol === 'https:' && /(^|\.)(facebook|instagram)\.com$/.test(url.hostname)) { const a = document.createElement('a'); a.href = url.href; a.textContent = 'Open post ↗'; a.target = '_blank'; a.rel = 'noreferrer'; $('#publication-link').append(a); } } catch { /* Keep the confirmed ID visible even without a valid link. */ }
  }
  if ($('#edit-post')) $('#edit-post').onclick = () => {
    editing = p; mediaId = p.media_id; submitKey = null; actionKey = null;
    $('#post-channel').value = p.channel_id; $('#post-text').value = p.text; $('#post-zone').value = p.timezone;
    $('#schedule-time').value = p.scheduled_at ? wallTime(p.scheduled_at, p.timezone) : '';
    $('#editor-title').textContent = 'Edit post'; preview(); $('#details').close(); location.hash = 'editor';
  };
  if ($('#cancel-post')) $('#cancel-post').onclick = async () => {
    if (!confirm('Cancel this post? Its content will remain in the history.')) return;
    try { await api(`/posts/${p.id}/cancel`, { method: 'POST', data: { version: p.version }, idempotency: crypto.randomUUID() }); $('#details').close(); await refresh(); notify('Post cancelled.'); } catch (error) { notify(error.message, true); }
  };
  if ($('#reconcile-form')) $('#reconcile-form').onsubmit = async event => {
    event.preventDefault();
    try { await api(`/posts/${p.id}/reconcile`, { method: 'POST', data: { version: p.version, remote_id: new FormData(event.target).get('remote_id') } }); await details(p.id); await refresh(); notify('Post confirmed.'); } catch (error) { notify(error.message, true); }
  };
  if (!$('#details').open) $('#details').showModal();
}
$('#post-list').onclick = event => { const button = event.target.closest('[data-detail]'); if (button) details(button.dataset.detail).catch(error => notify(error.message, true)); };
$('#close-details').onclick = () => $('#details').close();

function renderChannels() {
  $('#channel-list').innerHTML = channels.length ? channels.map(c => `<article class="channel-row"><span class="avatar" aria-hidden="true">${c.provider === 'facebook' ? 'f' : 'ig'}</span><div class="channel-info"><h3>${esc(c.name)}</h3><p>${providerName(c.provider)}${c.checked_at ? ` · Checked ${esc(dateLabel(c.checked_at))}` : ''}</p></div>${badge(c.status)}<div class="row-actions"><button class="quiet" data-check="${esc(c.id)}">Check</button><button class="quiet" data-disconnect="${esc(c.id)}">Disconnect</button></div></article>`).join('') : '<div class="empty"><h3>Your channels, together.</h3><p>No channels connected yet. Use the Connect to Meta button above to get started.</p></div>';
}
async function candidates() {
  const available = await api('/channels/candidates');
  $('#candidates').innerHTML = available.length ? '<h2>Choose channels to connect</h2>' + available.map(c => `<div class="candidate"><div><strong>${esc(c.name)}</strong><br><span class="small">${providerName(c.provider)}</span></div><button data-select="${esc(c.remote_id)}" data-provider="${esc(c.provider)}">${channels.some(ch => ch.remote_id === c.remote_id && ch.provider === c.provider) ? 'Reconnect' : 'Connect channel'}</button></div>`).join('') : '';
}
$('#connect').onclick = async () => { try { const result = await api('/channels/connect', { method: 'POST', data: {} }); location.assign(result.url); } catch (error) { notify(error.message, true); } };
$('#candidates').onclick = async event => {
  const button = event.target.closest('[data-select]'); if (!button) return;
  button.disabled = true;
  try { await api('/channels/select', { method: 'POST', data: { remote_id: button.dataset.select, provider: button.dataset.provider } }); await refresh(); notify('Channel connected.'); } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
};
$('#channel-list').onclick = async event => {
  const button = event.target.closest('button'); if (!button) return;
  const id = button.dataset.check || button.dataset.disconnect; if (!id) return;
  if (button.dataset.disconnect && !confirm('Disconnect this channel? Its scheduled posts will become drafts.')) return;
  button.disabled = true;
  try { const result = await api(`/channels/${id}${button.dataset.check ? '/check' : ''}`, { method: button.dataset.check ? 'POST' : 'DELETE', data: {} }); notify(result.note || 'Channel disconnected.'); }
  catch (error) { notify(error.message, true); }
  finally { await refresh().catch(error => notify(error.message, true)); button.disabled = false; }
};
async function loadKeys() {
  keys = await api('/keys');
  $('#key-list').innerHTML = keys.map(key => `<div class="key-row"><strong>${esc(key.name)}</strong><p>${esc(key.scopes.join(' · '))}</p><button class="quiet" data-revoke="${esc(key.id)}">Revoke key</button></div>`).join('');
}
$('#key-form').onsubmit = async event => {
  event.preventDefault(); const form = new FormData(event.target);
  try { const result = await api('/keys', { method: 'POST', data: { name: form.get('name'), scopes: form.getAll('scope') } }); $('#key-value').value = result.token; $('#new-key').hidden = false; await loadKeys(); } catch (error) { notify(error.message, true); }
};
$('#hide-key').onclick = () => { $('#key-value').value = ''; $('#new-key').hidden = true; };
$('#key-list').onclick = async event => {
  const button = event.target.closest('[data-revoke]'); if (!button || !confirm('Revoke this key immediately?')) return;
  try { await api(`/keys/${button.dataset.revoke}`, { method: 'DELETE' }); await loadKeys(); notify('API key revoked.'); } catch (error) { notify(error.message, true); }
};
$('#login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { await api('/login', { method: 'POST', data: { password: new FormData(event.target).get('password') } }); event.target.reset(); await refresh(); }
  catch (error) { notify(error.message, true); } finally { button.disabled = false; }
};
$('#logout').onclick = async () => { try { await api('/logout', { method: 'POST', data: {} }); status = null; channels = []; posts = []; $('#key-value').value = ''; $('#new-key').hidden = true; resetEditor(); showLogin(); } catch (error) { notify(error.message, true); } };
const params = new URLSearchParams(location.search);
if (params.has('connection_error')) notify(params.get('connection_error') === 'no_channels'
  ? 'Meta returned no publishing channels. Check your page selections and business portfolio permissions, then reconnect.'
  : `Channel connection failed (${params.get('connection_error')}). Start the connection again.`, true);
if (location.search) history.replaceState(null, '', `/${location.hash}`);
refresh().catch(error => { if (error.code !== 'unauthorized') notify(error.message, true); });
setInterval(() => {
  if (status && !document.hidden && (!location.hash || location.hash === '#calendar') && !$('#details').open && !$('#compose-dialog').open) refresh().catch(error => notify(error.message, true));
}, 15000);
