// Minimal fake Bot API server for tests.
import { createServer } from 'node:http';

export async function startMock(handlers = {}) {
  const calls = [];
  const updates = [];
  const acked = [];
  let waiting = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const m = /\/bot[^/]+\/(\w+)$/.exec(req.url);
    const method = m?.[1];
    let params = {};
    const files = {};
    const type = req.headers['content-type'] ?? '';
    if (type.startsWith('application/json')) params = JSON.parse(body.toString() || '{}');
    else if (type.startsWith('multipart/form-data')) {
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': type }, body }).formData();
      for (const [k, v] of form) {
        if (typeof v === 'string') params[k] = v;
        else files[k] = { name: v.name, size: v.size, text: await v.text() };
      }
    }
    calls.push({ method, params, files, contentType: type });
    const reply = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));

    if (method === 'getUpdates') {
      // Telegram semantics: a positive offset confirms (forgets) every update below it; updates at or above it
      // are returned again until confirmed, `limit` at a time.
      const offset = Number(params.offset ?? 0);
      if (offset > 0) while (updates.length && updates[0].update_id < offset) acked.push(updates.shift().update_id);
      const limit = Number(params.limit ?? 100);
      const batch = () => updates.slice(0, limit);
      if (updates.length) return reply({ ok: true, result: batch() });
      const timeout = Number(params.timeout ?? 0) * 1000;
      if (!timeout) return reply({ ok: true, result: [] });
      const t = setTimeout(() => ((waiting = null), reply({ ok: true, result: [] })), Math.min(timeout, 300));
      waiting = () => (clearTimeout(t), (waiting = null), reply({ ok: true, result: batch() }));
      return;
    }
    const h = handlers[method];
    if (h) {
      const r = await h(params, calls);
      return r && 'ok' in r ? reply(r) : reply({ ok: true, result: r });
    }
    if (method === 'getMe') return reply({ ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } });
    if (method.startsWith('send')) {
      return reply({ ok: true, result: { message_id: calls.length, date: 1, chat: { id: Number(params.chat_id), type: 'private' }, text: params.text } });
    }
    return reply({ ok: true, result: true });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    calls,
    /** Update ids Telegram has forgotten because a later offset confirmed them. */
    acked,
    /** Updates still held by "Telegram" (not confirmed yet). */
    get unconfirmed() {
      return updates.map((u) => u.update_id);
    },
    push(...u) {
      updates.push(...u);
      updates.sort((a, b) => a.update_id - b.update_id);
      waiting?.();
    },
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  };
}

let uid = 1;
export const textUpdate = (text, { chat = 10, user = 20, entities } = {}) => ({
  update_id: uid++,
  message: {
    message_id: uid,
    date: 1,
    chat: { id: chat, type: 'private' },
    from: { id: user, is_bot: false, first_name: 'U' },
    text,
    entities: entities ?? (text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined),
  },
});
export const callbackUpdate = (data, { chat = 10, user = 20 } = {}) => ({
  update_id: uid++,
  callback_query: {
    id: `cb${uid}`,
    from: { id: user, is_bot: false, first_name: 'U' },
    chat_instance: 'x',
    data,
    message: { message_id: 5, date: 1, chat: { id: chat, type: 'private' }, text: 'menu' },
  },
});
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('until(): timed out');
    await wait(10);
  }
}
