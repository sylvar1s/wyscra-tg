// Live check: creates an MTProto auth key with a real Telegram DC (no account needed).
// node test/live-authkey.mjs [dcId]
import { createAuthKey } from '../dist/mtproto/auth-key.js';
import { DCS } from '../dist/mtproto/generated/dc.js';
import { Transport } from '../dist/mtproto/transport.js';

const dcId = Number(process.argv[2] ?? 2);
const dc = DCS.find((d) => d.id === dcId);
const t = new Transport({ host: dc.ip, port: dc.port, dcId });
const started = Date.now();
await t.connect();
const res = await createAuthKey(t, { dcId });
console.log(`DC${dcId} ${dc.ip}: auth key ${res.authKey.length} bytes, salt ${res.serverSalt}, time offset ${res.timeOffset}s, ${Date.now() - started} ms`);
t.close();
