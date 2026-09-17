import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, peerIsOnline, roomKey, seal, PRESENCE_TTL, type PeerHello } from '../src/relay.ts';

test('a relay message opens only with the key derived from the same room code', async () => {
  const key = await roomKey('ABCD2345'), other = await roomKey('ABCD2346');
  const message = { type: 'sync', rounds: [], at: 1 };
  const box = await seal(key, message);
  assert.equal(box.length, 12 + JSON.stringify(message).length + 16);   // nonce + ciphertext + GCM tag
  assert.deepEqual(await open(key, box), { type: 'sync', rounds: [], at: 1 });
  assert.equal(await open(other, box), null);
  const tampered = box.slice(); tampered[20]! ^= 1;
  assert.equal(await open(key, tampered), null);
  assert.equal(await open(key, new Uint8Array(5)), null);
  assert.notDeepEqual(Array.from(await seal(key, 'x')), Array.from(await seal(key, 'x')));   // fresh nonce every time
});

test('presence follows the latest hello, its online flag and the heartbeat window', () => {
  const now = 1_000_000;
  const hello = (patch: Partial<PeerHello>): PeerHello => ({ token: 't', name: 'n', role: 'guest', seat: null, online: true, left: false, at: now, session: 's', ...patch });
  assert.equal(peerIsOnline(null, now), false);
  assert.equal(peerIsOnline(hello({}), now), true);
  assert.equal(peerIsOnline(hello({ at: now - PRESENCE_TTL + 1 }), now), true);
  assert.equal(peerIsOnline(hello({ at: now - PRESENCE_TTL }), now), false);
  assert.equal(peerIsOnline(hello({ online: false }), now), false);
  assert.equal(peerIsOnline(hello({ left: true }), now), false);
});
