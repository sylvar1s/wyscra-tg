// Live check of the encrypted session: ping, batching and rpc_error parsing (no account needed).
import { Sender } from '../dist/mtproto/sender.js';
import { DCS } from '../dist/mtproto/generated/dc.js';

const dc = DCS.find((d) => d.id === 2);
const s = new Sender({
  dcId: 2,
  host: dc.ip,
  port: dc.port,
  init: { apiId: 1, deviceModel: 'test', systemVersion: 'test', appVersion: '0', systemLangCode: 'en', langPack: '', langCode: 'en' },
  log: (l, m) => console.log(l, m),
});
await s.connect();
const t = Date.now();
const pongs = await Promise.all([1n, 2n, 3n].map((id) => s.invoke({ _: 'ping', ping_id: id })));
console.log('pings (one container):', pongs.map((p) => `${p._}#${p.ping_id}`).join(', '), `${Date.now() - t} ms`);
try {
  await s.invoke({ _: 'help.getNearestDc' });
} catch (e) {
  console.log('expected error with dummy api_id:', e.name, e.code, e.errorMessage);
}
s.close();
