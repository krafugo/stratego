import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encodeConnect, encodePublish, encodeSubscribe, encodePuback, PINGREQ, DISCONNECT, PacketType } from '../src/mqtt.ts';

const bytes = (...parts: (number[] | Uint8Array)[]) => new Uint8Array(parts.flatMap(p => Array.from(p)));

test('CONNECT carries the protocol header, clean session, keep-alive, client id and an optional retained will', () => {
  const plain = encodeConnect('abc', 30);
  assert.deepEqual(Array.from(plain), [0x10, 15, 0, 4, 77, 81, 84, 84, 4, 0x02, 0, 30, 0, 3, 97, 98, 99]);
  const willed = encodeConnect('abc', 30, { topic: 't', payload: new Uint8Array([9, 9]), retain: true });
  assert.equal(willed[9], 0x02 | 0x04 | 0x20);
  assert.deepEqual(Array.from(willed.slice(-7)), [0, 1, 116, 0, 2, 9, 9]);
});

test('PUBLISH round-trips topic, payload, retain and QoS 1 packet id; SUBSCRIBE and PUBACK are well-formed', () => {
  const payload = new Uint8Array([1, 2, 3, 250]);
  const qos1 = encodePublish('stratego/v1/ABC/host/sync', payload, { retain: true, qos: 1, packetId: 258 });
  assert.equal(qos1[0], 0x30 | 0x02 | 0x01);
  const { packets, rest } = decode(qos1);
  assert.equal(rest.length, 0);
  assert.deepEqual(packets, [{ type: 3, topic: 'stratego/v1/ABC/host/sync', payload, retain: true, qos: 1, packetId: 258 }]);
  const qos0 = decode(encodePublish('t', payload)).packets[0] as { qos: number; packetId?: number; retain: boolean };
  assert.equal(qos0.qos, 0); assert.equal(qos0.packetId, undefined); assert.equal(qos0.retain, false);
  assert.deepEqual(Array.from(encodeSubscribe(7, ['a/b', 'c'])), [0x82, 12, 0, 7, 0, 3, 97, 47, 98, 1, 0, 1, 99, 1]);
  assert.deepEqual(Array.from(encodePuback(65535)), [0x40, 2, 255, 255]);
  assert.deepEqual(Array.from(PINGREQ), [0xC0, 0]);
  assert.deepEqual(Array.from(DISCONNECT), [0xE0, 0]);
});

test('decode handles multi-byte remaining lengths, several packets per frame and partial frames', () => {
  const big = encodePublish('t', new Uint8Array(300).fill(7));
  assert.deepEqual(Array.from(big.slice(1, 3)), [(303 % 128) | 128, Math.floor(303 / 128)]);
  const stream = bytes([0x20, 2, 0, 0], big, [0xD0, 0], [0x90, 3, 0, 7, 1]);
  const all = decode(stream);
  assert.deepEqual(all.packets.map(p => p.type), [PacketType.CONNACK, PacketType.PUBLISH, PacketType.PINGRESP, PacketType.SUBACK]);
  assert.deepEqual(all.packets[0], { type: 2, sessionPresent: false, returnCode: 0 });
  assert.deepEqual(all.packets[3], { type: 9, packetId: 7 });
  const cut = decode(stream.slice(0, 40));
  assert.equal(cut.packets.length, 1);
  assert.equal(cut.rest.length, 36);                       // the incomplete PUBLISH waits for the next frame
  const joined = decode(bytes(cut.rest, stream.slice(40)));
  assert.equal(joined.packets.length, 3);
  assert.throws(() => decode(new Uint8Array([0x30, 255, 255, 255, 255, 1])), /Malformed/);
});
