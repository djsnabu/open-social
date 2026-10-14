import { transaction } from './db.js';

export function createScheduler({ db, config, meta, secrets }) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      db.prepare('DELETE FROM oauth WHERE expires < ?').run(Date.now());
      db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
      const now = new Date().toISOString();
      const stale = new Date(Date.now() - 10 * 60000).toISOString();
      transaction(db, () => {
        db.prepare(`UPDATE attempts SET outcome='uncertain', finished_at=?, error_code='worker_interrupted'
          WHERE outcome='publishing' AND post_id IN (SELECT id FROM posts WHERE state='publishing' AND claimed_at < ?)` ).run(now, stale);
        db.prepare(`UPDATE posts SET state='uncertain', updated_at=?, version=version+1, error_code='worker_interrupted',
          error_message='Publishing was interrupted. Check the channel before trying again.' WHERE state='publishing' AND claimed_at < ?`).run(now, stale);
      });
      if (!config.publishingEnabled) return;
      const post = transaction(db, () => {
        const row = db.prepare(`UPDATE posts SET state='publishing', claimed_at=?, updated_at=?, version=version+1
          WHERE id=(SELECT id FROM posts WHERE state='scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1)
          AND state='scheduled' RETURNING *`).get(now, now, now);
        if (row) db.prepare('INSERT INTO attempts(post_id,started_at,outcome) VALUES(?,?,?)').run(row.id, now, 'publishing');
        return row;
      });
      if (!post) return;
      const channel = db.prepare('SELECT * FROM channels WHERE id=?').get(post.channel_id);
      let outcome, result, error;
      try {
        if (channel.status === 'disconnected') throw Object.assign(new Error('Reconnect the channel.'), { code: 'reconnect_required', uncertain: false });
        result = await meta.publish(post, channel, secrets.decrypt(channel.secret),
          post.media_id ? `${config.origin}/media/${post.media_id}.jpg` : null,
          id => db.prepare('UPDATE posts SET container_id=? WHERE id=?').run(id, post.id));
        outcome = 'published';
      } catch (caught) {
        error = caught;
        outcome = caught.uncertain === false ? 'failed' : 'uncertain';
      }
      transaction(db, () => {
        const finished = new Date().toISOString();
        db.prepare(`UPDATE posts SET state=?, remote_id=?, remote_url=?, error_code=?, error_message=?, updated_at=?, version=version+1 WHERE id=? AND state='publishing'`).run(
          outcome, result?.id || null, result?.url || null, error?.code || (error ? 'internal_error' : null),
          error?.status ? error.message : error ? 'Could not confirm the publishing result. Check the channel.' : null, finished, post.id);
        db.prepare(`UPDATE attempts SET outcome=?,finished_at=?,error_code=? WHERE post_id=? AND outcome='publishing'`).run(outcome, finished, error?.code || null, post.id);
        if (error?.code === 'reconnect_required') db.prepare("UPDATE channels SET status='reconnect_required' WHERE id=?").run(channel.id);
      });
    } finally { running = false; }
  }
  return { tick, get running() { return running; } };
}
