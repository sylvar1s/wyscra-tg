import {
  aesIgeDecrypt,
  aesIgeEncrypt,
  checkDhParams,
  checkDhValue,
  factorize,
  fromBigInt,
  modPow,
  parseRsaKey,
  random,
  rsaPad,
  sha1,
  toBigInt,
  type RsaKey,
} from './crypto.js';
import { PUBLIC_KEYS, TEST_PUBLIC_KEYS } from './generated/dc.js';
import { Reader, Writer } from './tl/binary.js';
import { readObject, serialize, type TlObject } from './tl/codec.js';
import type { Transport } from './transport.js';

let keys: RsaKey[] | undefined;
let testKeys: RsaKey[] | undefined;

export interface AuthKeyResult {
  authKey: Buffer;
  serverSalt: bigint;
  /** server time - local time, seconds */
  timeOffset: number;
}

/** Runs the DH exchange over a fresh transport and returns a new permanent auth key. */
export async function createAuthKey(
  transport: Transport,
  opts: { dcId: number; testServers?: boolean; media?: boolean },
): Promise<AuthKeyResult> {
  const queue: Buffer[] = [];
  let waiter: ((b: Buffer) => void) | undefined;
  let failed: ((e: Error) => void) | undefined;
  transport.onPacket = (p) => (waiter ? (waiter(p), (waiter = undefined)) : queue.push(p));
  transport.onClose = (e) => failed?.(e ?? new Error('Connection closed during auth key exchange'));

  let lastMsgId = 0n;
  const call = async (obj: TlObject): Promise<any> => {
    const body = serialize(obj).result();
    const w = new Writer(20 + body.length);
    w.long(0n);
    let msgId = (BigInt(Math.floor(Date.now() / 1000)) << 32n) | (BigInt(Date.now() % 1000) << 22n);
    msgId &= ~3n;
    if (msgId <= lastMsgId) msgId = lastMsgId + 4n;
    lastMsgId = msgId;
    w.long(msgId);
    w.int(body.length);
    w.raw(body);
    transport.send(w.result());
    const packet = queue.shift() ?? (await new Promise<Buffer>((resolve, reject) => ((waiter = resolve), (failed = reject))));
    const r = new Reader(packet);
    if (r.long() !== 0n) throw new Error('Expected an unencrypted message');
    r.long(); // msg_id
    const len = r.int();
    return readObject(new Reader(r.raw(len)));
  };

  const nonce = random(16);
  const resPQ = await call({ _: 'req_pq_multi', nonce });
  if (!Buffer.from(resPQ.nonce).equals(nonce)) throw new Error('resPQ: nonce mismatch');

  const pool = opts.testServers ? (testKeys ??= TEST_PUBLIC_KEYS.map(parseRsaKey)) : (keys ??= PUBLIC_KEYS.map(parseRsaKey));
  const fingerprints: bigint[] = resPQ.server_public_key_fingerprints;
  const key = pool.find((k) => fingerprints.includes(k.fingerprint));
  if (!key) throw new Error(`No known RSA key for fingerprints ${fingerprints.map((f) => f.toString(16)).join(', ')}`);

  const pq = toBigInt(resPQ.pq);
  const [p, q] = factorize(pq);
  const newNonce = random(32);
  const serverNonce: Buffer = resPQ.server_nonce;
  let dc = opts.dcId + (opts.testServers ? 10000 : 0);
  if (opts.media) dc = -dc;

  const inner = serialize({
    _: 'p_q_inner_data_dc',
    pq: resPQ.pq,
    p: fromBigInt(p),
    q: fromBigInt(q),
    nonce,
    server_nonce: serverNonce,
    new_nonce: newNonce,
    dc,
  }).result();

  const dhParams = await call({
    _: 'req_DH_params',
    nonce,
    server_nonce: serverNonce,
    p: fromBigInt(p),
    q: fromBigInt(q),
    public_key_fingerprint: key.fingerprint,
    encrypted_data: rsaPad(inner, key),
  });
  if (dhParams._ !== 'server_DH_params_ok') throw new Error(`req_DH_params failed: ${dhParams._}`);
  if (!Buffer.from(dhParams.nonce).equals(nonce) || !Buffer.from(dhParams.server_nonce).equals(serverNonce)) {
    throw new Error('server_DH_params: nonce mismatch');
  }

  const tmpKey = Buffer.concat([sha1(newNonce, serverNonce), sha1(serverNonce, newNonce).subarray(0, 12)]);
  const tmpIv = Buffer.concat([sha1(serverNonce, newNonce).subarray(12, 20), sha1(newNonce, newNonce), newNonce.subarray(0, 4)]);
  const answerWithHash = aesIgeDecrypt(dhParams.encrypted_answer, tmpKey, tmpIv);
  const ar = new Reader(answerWithHash);
  ar.pos = 20;
  const dhInner = readObject(ar);
  if (!sha1(answerWithHash.subarray(20, ar.pos)).equals(answerWithHash.subarray(0, 20))) throw new Error('server_DH_inner_data: hash mismatch');
  if (dhInner._ !== 'server_DH_inner_data') throw new Error(`Unexpected ${dhInner._}`);
  if (!Buffer.from(dhInner.nonce).equals(nonce) || !Buffer.from(dhInner.server_nonce).equals(serverNonce)) {
    throw new Error('server_DH_inner_data: nonce mismatch');
  }

  const dhPrime = toBigInt(dhInner.dh_prime);
  const g = BigInt(dhInner.g);
  const gA = toBigInt(dhInner.g_a);
  checkDhParams(dhPrime, dhInner.g);
  checkDhValue(gA, dhPrime);
  const timeOffset = dhInner.server_time - Math.floor(Date.now() / 1000);

  let retryId = 0n;
  for (let attempt = 0; attempt < 5; attempt++) {
    const b = toBigInt(random(256));
    const gB = modPow(g, b, dhPrime);
    checkDhValue(gB, dhPrime);
    const clientInner = serialize({
      _: 'client_DH_inner_data',
      nonce,
      server_nonce: serverNonce,
      retry_id: retryId,
      g_b: fromBigInt(gB),
    }).result();
    let data = Buffer.concat([sha1(clientInner), clientInner]);
    if (data.length % 16) data = Buffer.concat([data, random(16 - (data.length % 16))]);

    const res = await call({
      _: 'set_client_DH_params',
      nonce,
      server_nonce: serverNonce,
      encrypted_data: aesIgeEncrypt(data, tmpKey, tmpIv),
    });

    const authKey = fromBigInt(modPow(gA, b, dhPrime), 256);
    const auxHash = sha1(authKey).subarray(0, 8);
    const expect = (n: number) => sha1(newNonce, Buffer.from([n]), auxHash).subarray(4, 20);

    if (res._ === 'dh_gen_ok') {
      if (!Buffer.from(res.new_nonce_hash1).equals(expect(1))) throw new Error('dh_gen_ok: new_nonce_hash1 mismatch');
      const salt = Buffer.allocUnsafe(8);
      for (let i = 0; i < 8; i++) salt[i] = newNonce[i] ^ serverNonce[i];
      return { authKey, serverSalt: salt.readBigInt64LE(0), timeOffset };
    }
    if (res._ === 'dh_gen_retry') {
      if (!Buffer.from(res.new_nonce_hash2).equals(expect(2))) throw new Error('dh_gen_retry: hash mismatch');
      retryId = auxHash.readBigInt64LE(0);
      continue;
    }
    throw new Error('Auth key generation failed (dh_gen_fail)');
  }
  throw new Error('Auth key generation: too many retries');
}
