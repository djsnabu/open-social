import { createHmac } from 'node:crypto';
import { AppError, requireValue } from './security.js';

export class ProviderError extends AppError {
  constructor(code, message, uncertain = false) { super(502, code, message); this.uncertain = uncertain; }
}

export function createMeta(config, transport = fetch) {
  const base = `https://graph.facebook.com/${config.metaVersion}`;
  async function graph(path, token, params = {}, method = 'GET', publication = false) {
    const url = new URL(`${base}/${path}`);
    const fields = new URLSearchParams(params);
    if (token) fields.set('appsecret_proof', createHmac('sha256', config.metaSecret).update(token).digest('hex'));
    if (method === 'GET') url.search = fields.toString();
    let response, data;
    try {
      response = await transport(url, {
        method, headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: method === 'POST' ? fields : undefined,
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      data = await response.json();
    } catch {
      throw new ProviderError('provider_unavailable', 'The connection to Meta was lost. Check the post status before trying again.', publication);
    }
    if (!response.ok || data.error) {
      const code = data.error?.code;
      // Provider error text may contain tokens or private content; store only our own messages.
      if (code === 190) throw new ProviderError('reconnect_required', 'Channel authentication has expired. Reconnect the channel.');
      if ([10, 200].includes(code)) throw new ProviderError('permission_required', 'The Meta app or user lacks publishing permission. Check permissions and reconnect.');
      throw new ProviderError('provider_rejected', 'Meta rejected the request. Check image requirements, channel permissions and Meta service status.', publication && (response.status >= 500 || data.error?.is_transient === true));
    }
    return data;
  }
  const requireId = (data, publication = false) => {
    if (!/^\d+(?:_\d+)?$/.test(data?.id || '')) throw new ProviderError('invalid_provider_response', 'Meta did not return a post ID.', publication);
    return data.id;
  };
  return {
    authorizationUrl(state) {
      const url = new URL(`https://www.facebook.com/${config.metaVersion}/dialog/oauth`);
      url.search = new URLSearchParams({ client_id: config.metaAppId, redirect_uri: `${config.origin}/auth/meta/callback`, state,
        response_type: 'code', auth_type: 'rerequest', scope: 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management' });
      return url.href;
    },
    async discover(code) {
      const short = await graph('oauth/access_token', null, { client_id: config.metaAppId, client_secret: config.metaSecret, redirect_uri: `${config.origin}/auth/meta/callback`, code });
      requireValue(typeof short.access_token === 'string', 'oauth_failed', 'Meta did not return an access token.', 502);
      const long = await graph('oauth/access_token', null, { grant_type: 'fb_exchange_token', client_id: config.metaAppId, client_secret: config.metaSecret, fb_exchange_token: short.access_token });
      requireValue(typeof long.access_token === 'string', 'oauth_failed', 'Meta did not return a long-lived access token.', 502);
      const candidates = [];
      let after;
      for (let page = 0; page < 50; page++) {
        const data = await graph('me/accounts', long.access_token, { fields: 'id,name,access_token,tasks,instagram_business_account{id,username}', limit: '100', ...(after ? { after } : {}) });
        for (const item of data.data || []) {
          if (!item.access_token || !/^\d+$/.test(item.id)) continue;
          if (!item.tasks?.some(t => ['CREATE_CONTENT', 'MANAGE', 'PROFILE_PLUS_FULL_CONTROL'].includes(t))) continue;
          candidates.push({ provider: 'facebook', remote_id: item.id, name: item.name, token: item.access_token });
          if (item.instagram_business_account?.id) candidates.push({ provider: 'instagram', remote_id: item.instagram_business_account.id, name: item.instagram_business_account.username || item.name, token: item.access_token });
        }
        if (!data.paging?.next) return candidates;
        after = data.paging.cursors?.after;
        requireValue(after, 'pagination_failed', 'Could not load the next page of channels.', 502);
      }
      throw new AppError(502, 'too_many_channels', 'More than 5,000 pages: limit the page permissions granted to the app.');
    },
    async health(channel, token) {
      const data = await graph(channel.remote_id, token, { fields: 'id' });
      return requireId(data) === channel.remote_id;
    },
    async publish(post, channel, token, mediaUrl, onContainer) {
      if (channel.provider === 'facebook') {
        const data = await graph(`${channel.remote_id}/${mediaUrl ? 'photos' : 'feed'}`, token,
          mediaUrl ? { url: mediaUrl, caption: post.text, published: 'true' } : { message: post.text }, 'POST', true);
        const id = requireId({ id: data.post_id || data.id }, true);
        return { id, url: `https://www.facebook.com/${id}` };
      }
      let container = post.container_id;
      if (!container) {
        container = requireId(await graph(`${channel.remote_id}/media`, token, { image_url: mediaUrl, caption: post.text }, 'POST'));
        onContainer(container);
      }
      let ready = false;
      for (let i = 0; i < 10; i++) {
        const result = await graph(container, token, { fields: 'status_code' });
        if (result.status_code === 'FINISHED') { ready = true; break; }
        if (['ERROR', 'EXPIRED'].includes(result.status_code)) throw new ProviderError('media_rejected', 'Meta rejected the image. Check the JPEG dimensions and aspect ratio.');
        if (result.status_code === 'PUBLISHED') throw new ProviderError('already_published', 'The image is already published. Check the post ID.', true);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) throw new ProviderError('media_processing', 'Image processing did not finish. You can try again later.');
      const id = requireId(await graph(`${channel.remote_id}/media_publish`, token, { creation_id: container }, 'POST', true), true);
      let url = null;
      try { url = (await graph(id, token, { fields: 'permalink' })).permalink || null; } catch { /* Publication is already confirmed by its ID. */ }
      return { id, url };
    },
    async reconcile(post, channel, token, remoteId) {
      requireValue(/^\d+(?:_\d+)?$/.test(remoteId), 'invalid_remote_id', 'Invalid post ID.');
      const fields = channel.provider === 'facebook' ? 'id,from,message,permalink_url' : 'id,owner,caption,permalink';
      const data = await graph(remoteId, token, { fields });
      requireValue(String(data.from?.id || data.owner?.id) === channel.remote_id && (data.message || data.caption || '') === post.text,
        'publication_mismatch', 'The post channel or text does not match this draft.', 409);
      return { id: requireId(data), url: data.permalink_url || data.permalink || null };
    },
  };
}
