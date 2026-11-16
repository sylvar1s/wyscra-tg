import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { RpcError, deserialize, fmt, html, markedId, parseHtml, serialize, unmarkId, LAYER, TelegramClient, MemorySession } from '../dist/mtproto/index.js';
import { Reader, Writer } from '../dist/mtproto/tl/binary.js';
import { readValue, resultType, ID } from '../dist/mtproto/tl/codec.js';
import { aesIgeDecrypt, aesIgeEncrypt, factorize, messageKeys, parseRsaKey } from '../dist/mtproto/crypto.js';
import { PUBLIC_KEYS } from '../dist/mtproto/generated/dc.js';

describe('TL codec', () => {
  test('layer is bundled', () => assert.ok(LAYER >= 200));

  test('ping serializes to the documented bytes', () => {
    const b = serialize({ _: 'ping', ping_id: 1n }).result();
    assert.equal(b.toString('hex'), 'ec77be7a' + '0100000000000000');
  });

  test('constructor with flags, true-flags, vectors, long and nested objects roundtrips', () => {
    const user = {
      _: 'user',
      self: true,
      bot: false,
      id: 123456789012n,
      access_hash: -5n,
      first_name: 'Иван 🚀',
      username: 'ivan',
      usernames: [{ _: 'username', editable: true, username: 'ivan2' }],
    };
    const back = deserialize(serialize(user).result());
    assert.equal(back._, 'user');
    assert.equal(back.self, true);
    assert.equal(back.bot, false);
    assert.equal(back.id, 123456789012n);
    assert.equal(back.access_hash, -5n);
    assert.equal(back.first_name, 'Иван 🚀');
    assert.equal(back.username, 'ivan');
    assert.equal(back.last_name, undefined);
    assert.equal(back.usernames[0].editable, true);
    assert.equal(back.usernames[0].active, false);
    assert.equal(back.usernames[0].username, 'ivan2');
  });

  test('bytes longer than 253 use the 4-byte length header and padding', () => {
    for (const len of [0, 1, 253, 254, 255, 1000, 70000]) {
      const data = Buffer.alloc(len, 7);
      const w = new Writer();
      w.bytes(data);
      assert.equal(w.pos % 4, 0);
      assert.deepEqual(new Reader(w.result()).bytes(), data);
    }
  });

  test('typed Vector<long> results and gzip_packed', () => {
    const w = new Writer();
    w.uint(ID.vector);
    w.int(2);
    w.long(1n);
    w.long(-2n);
    assert.deepEqual(readValue(new Reader(w.result()), resultType('messages.getMessagesViews') && { k: 'vector', bare: false, of: { k: 'long' } }), [1n, -2n]);

    const inner = serialize({ _: 'pong', msg_id: 5n, ping_id: 6n }).result();
    const g = new Writer();
    g.uint(ID.gzipPacked);
    g.bytes(gzipSync(inner));
    assert.deepEqual(deserialize(g.result()), { _: 'pong', msg_id: 5n, ping_id: 6n });
  });

  test('Bool and required params are validated', () => {
    assert.throws(() => serialize({ _: 'messages.sendMessage', message: 'x' }), /peer is required/);
    assert.throws(() => serialize({ _: 'no.suchMethod' }), /unknown constructor/);
  });
});

describe('crypto', () => {
  test('pq factorization (example from the MTProto docs)', () => {
    assert.deepEqual(factorize(0x17ed48941a08f981n), [0x494c553bn, 0x53911073n]);
  });
  test('AES-IGE roundtrip', () => {
    const key = Buffer.alloc(32, 1);
    const iv = Buffer.alloc(32, 2);
    const data = Buffer.from('0123456789abcdef'.repeat(8));
    const enc = aesIgeEncrypt(data, key, iv);
    assert.notDeepEqual(enc, data);
    assert.deepEqual(aesIgeDecrypt(enc, key, iv), data);
  });
  test('message key derivation is deterministic and direction-dependent', () => {
    const authKey = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 7) & 0xff));
    const msgKey = Buffer.alloc(16, 3);
    assert.deepEqual(messageKeys(authKey, msgKey, 0), messageKeys(authKey, msgKey, 0));
    assert.notDeepEqual(messageKeys(authKey, msgKey, 0).key, messageKeys(authKey, msgKey, 8).key);
  });
  test('bundled RSA key has the known fingerprint', () => {
    assert.equal(BigInt.asUintN(64, parseRsaKey(PUBLIC_KEYS[0]).fingerprint).toString(16), 'd09d1d85de64fd85');
  });
});

describe('HTML entities', () => {
  test('offsets are UTF-16 and nesting works', () => {
    const r = parseHtml('Hi 🚀 <b>bold <i>both</i></b> <a href="https://t.me">link</a> &lt;x&gt;');
    assert.equal(r.text, 'Hi 🚀 bold both link <x>');
    const pick = (t) => r.entities.find((e) => e._ === t);
    assert.deepEqual([pick('messageEntityBold').offset, pick('messageEntityBold').length], [6, 9]);
    assert.deepEqual([pick('messageEntityItalic').offset, pick('messageEntityItalic').length], [11, 4]);
    assert.equal(pick('messageEntityTextUrl').url, 'https://t.me');
  });
  test('pre with language, spoiler, mention', () => {
    const r = parseHtml('<pre><code class="language-js">x</code></pre><tg-spoiler>s</tg-spoiler><a href="tg://user?id=42">u</a>');
    assert.deepEqual(r.entities.map((e) => e._), ['messageEntityPre', 'messageEntitySpoiler', 'inputMessageEntityMentionName']);
    assert.equal(r.entities[0].language, 'js');
    assert.equal(r.entities[2].user_id.user_id, 42n);
  });
  test('html template output parses back', () => {
    const r = parseHtml(html`<b>${'<i>not tag</i>'}</b> ${fmt.code('a&b')}`.text);
    assert.equal(r.text, '<i>not tag</i> a&b');
  });
});

describe('misc', () => {
  test('marked ids match Bot API', () => {
    assert.equal(markedId('user', 5n), 5);
    assert.equal(markedId('chat', 5n), -5);
    assert.equal(markedId('channel', 1234567890n), -1001234567890);
    assert.deepEqual(unmarkId(-1001234567890), { type: 'channel', id: 1234567890n });
    assert.deepEqual(unmarkId(-5), { type: 'chat', id: 5n });
  });
  test('RpcError parses the numeric suffix', () => {
    const e = new RpcError(420, 'FLOOD_WAIT_31', 'messages.sendMessage');
    assert.equal(e.type, 'FLOOD_WAIT');
    assert.equal(e.value, 31);
    assert.ok(e.is('FLOOD_WAIT'));
  });
  test('typed api proxy builds method names', async () => {
    const client = new TelegramClient({ apiId: 1, apiHash: 'x', session: new MemorySession() });
    const seen = [];
    client.invoke = async (req) => (seen.push(req), true);
    await client.api.messages.getDialogs({ limit: 1 });
    await client.api.help.getConfig();
    assert.deepEqual(seen.map((r) => r._), ['messages.getDialogs', 'help.getConfig']);
    assert.equal(client.api.then, undefined, 'proxy is not thenable');
    assert.equal(client.api.messages.then, undefined);
  });
});
