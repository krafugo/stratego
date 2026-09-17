import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STUN, planIce } from '../src/ice.ts';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 } as Storage; };
const turnA = { urls: 'turn:a.example:3478', username: 'u', credential: 'c' };
const turnB = { urls: ['turn:b.example:80', 'turns:b.example:443'], username: 'u', credential: 'c' };

test('STUN only when no relay is configured; nothing is probed', async () => {
  let probes = 0;
  const plan = await planIce({}, async () => { probes++; return true; }, memory());
  assert.deepEqual(plan, { servers: DEFAULT_STUN, relays: 0, probed: 0 });
  assert.equal(probes, 0);
});

test('only relays that answer are kept, duplicates are probed once, and the result is cached', async () => {
  const probed: string[] = [];
  const probe = async (s: RTCIceServer) => { probed.push(String(s.urls)); return String(s.urls).includes('b.example'); };
  const cache = memory();
  const plan = await planIce({ turnServers: [turnA, turnB, turnA] }, probe, cache);
  assert.equal(probed.length, 2);
  assert.deepEqual(plan.servers, [...DEFAULT_STUN, turnB]);
  assert.equal(plan.relays, 1); assert.equal(plan.probed, 2);
  const again = await planIce({ turnServers: [turnA, turnB] }, async () => { throw new Error('should not probe'); }, cache);
  assert.deepEqual(again.servers, plan.servers);
});

test('when no relay answers they all stay configured, and a probe that throws counts as down', async () => {
  const plan = await planIce({ iceServers: [{ urls: 'stun:s.example' }, turnA], turnServers: [turnB] }, async s => { if (String(s.urls).includes('b.')) throw new Error('boom'); return false; }, memory());
  assert.deepEqual(plan.servers, [{ urls: 'stun:s.example' }, turnA, turnB]);
  assert.equal(plan.relays, 0); assert.equal(plan.probed, 2);
});
