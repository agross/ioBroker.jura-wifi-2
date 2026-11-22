import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  authenticated,
  brewPayload,
  catalogFor,
  decodeFrame,
  decodeStatus,
  encodeFrame,
  pair,
  pollStatus,
  readStatistics,
} from '../lib/jura';

function statusPacket(payload: Buffer, idle = true) {
  const reply = Buffer.alloc(110 + payload.length);
  reply.writeUInt16BE(reply.length);
  reply.writeUInt16BE(0xa5f3, 2);
  reply.write('TT237W V06.11', 4);
  reply.write('Z10', 20);
  reply.write('EF545M V02.01', 52);
  reply.writeUInt16BE(15368, 68);
  reply[109] = idle ? 0x81 : 0x80;
  payload.copy(reply, 110);
  return reply;
}

test('TCP frames match upstream vectors including escaped keys and payloads', () => {
  for (const [key, command, vector] of [
    [0x5a, '@TG:C0', '2a5ab3809313f0cd9ba50d0a'],
    [0x26, '@TR:32,00', '2a1ba678e3ac1b8d8ad780a662e4e60d0a'],
  ] as const) {
    assert.deepEqual(encodeFrame(command, key), Buffer.from(vector, 'hex'));
    assert.equal(decodeFrame(Buffer.from(vector, 'hex')), command);
  }
  assert.equal(decodeFrame(Buffer.from('2a1b0d0a', 'hex')), null);
});

test('TCP decodes the escaped counter frame observed on the Z10', () => {
  const reply = Buffer.from(
    '2a1bab08b9dfbd89f991969cc58a6f6fb8f5c5ce7bbd74d41baba76d4edda5440d0a',
    'hex',
  );
  assert.equal(decodeFrame(reply), '@tr:32,0A,0000004AFFFF0031');
});

test('catalog lookup preserves model variants and supports every bundled model', () => {
  const directory = join(__dirname, '..', '..', 'lib', 'catalogs');
  for (const file of readdirSync(directory)) {
    const id = file.replace(/\.json$/, '');
    const catalog = catalogFor(`${id}M V01.00`);
    assert(catalog);
    assert.equal(catalog.modelId, id);
    for (const product of catalog.products) {
      assert.match(brewPayload(product), /^[A-F0-9]{32}$/);
    }
  }
  assert.equal(
    catalogFor(' ef532coffeeonly V01.00 ')?.modelId,
    'EF532COFFEEONLY',
  );
  assert.equal(catalogFor('EF545M V02.01')?.modelId, 'EF545');
  assert.equal(catalogFor('EF1030M V01.06')?.modelId, 'EF1030');
  assert.equal(catalogFor('EF545V99M V01.00'), null);
});

test('UDP decodes the Z10 identity, idle flags and dispensing progress', () => {
  const status = decodeStatus(
    statusPacket(Buffer.from('002400000c0008', 'hex')),
  );
  assert(status);
  assert.equal(status.model, 'EF545M V02.01');
  assert.equal(status.module, 'TT237W V06.11');
  assert.equal(status.name, 'Z10');
  assert.equal(status.articleNumber, 15368);
  assert.deepEqual(status.alertBits, [10, 13, 36, 37, 52]);
  assert.equal(status.productRunning, false);

  const progress = Buffer.alloc(16);
  progress[0] = 0x34;
  progress[4] = 4;
  progress[5] = 12;
  progress[14] = 33;
  const running = decodeStatus(statusPacket(progress, false));
  assert(running);
  assert.equal(running.productRunning, true);
  assert.equal(running.alertBits, null);
  assert.deepEqual(running.progress, {
    code: 0x34,
    phase: 'Dispensing',
    dispensedMl: 20,
    targetMl: 60,
    percent: 33,
  });
  assert.equal(
    decodeStatus(statusPacket(progress.subarray(0, 15), false)),
    null,
  );
});

test('UDP sends a unicast request and times out without a valid status', async t => {
  const server = dgram.createSocket('udp4');
  t.after(() => server.close());
  server.bind(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.once('message', (message, remote) => {
    assert.equal(message.toString('hex'), '0010a5f37f0000010000000000000000');
    server.send(statusPacket(Buffer.alloc(7)), remote.port, remote.address);
  });
  assert.equal(
    (await pollStatus('localhost', { port })).model,
    'EF545M V02.01',
  );
  await assert.rejects(
    pollStatus('localhost', { port, timeout: 100 }),
    /No UDP status reply/,
  );
});

test('UDP reports a hostname lookup failure without crashing', async () => {
  await assert.rejects(pollStatus('256.256.256.256'), { code: 'ENOTFOUND' });
});

test('brew data uses catalog defaults and rejects unsupported or out-of-step overrides', () => {
  const espresso = catalogFor('EF545M V02.01')?.products[0];
  assert(espresso);
  assert.equal(brewPayload(espresso), '02000809000002000100000000000000');
  assert.equal(
    brewPayload(espresso, { water: 60, strength: 8, temperature: 'HIGH' }),
    '0200080C000002000100000000000000',
  );
  assert.throws(() => brewPayload(espresso, { milk: 5 }), /Invalid milk/);
  assert.throws(() => brewPayload(espresso, { water: 61 }), /Invalid water/);
  assert.throws(
    () => brewPayload(espresso, { temperature: 'toString' }),
    /Invalid temperature/,
  );
});

test('legacy preselections encode cold brew, ground coffee, extra shot, and double', () => {
  const z10 = catalogFor('EF545M V02.01')!;
  const espresso = z10.products.find(product => product.code === 2)!;
  const cappuccino = z10.products.find(product => product.code === 4)!;
  assert.equal(brewPayload(espresso, { preselections: ['coldbrew'] }, z10),
    '02000809000080000100000000000000');
  assert.equal(brewPayload(espresso, { preselections: ['powder'] }, z10),
    '02000009000002000100000000000000');
  assert.equal(brewPayload(cappuccino, { preselections: ['xtrashot'] }, z10),
    '0400080C000E01020100000000000000');
  assert.equal(brewPayload(espresso, { preselections: ['double'], water: 50 }, z10),
    '3100080A000002000100000000000000');
  assert.throws(() => brewPayload(cappuccino, { preselections: ['fakesweetfoam'] }, z10),
    /Unsupported preselection/);
  assert.throws(() => brewPayload(espresso, { preselections: ['coldbrew', 'double'] }, z10),
    /Invalid preselection combination/);
  assert.throws(() => brewPayload(espresso, { preselections: ['coldbrew'], temperature: 'LOW' }, z10),
    /coldbrew conflicts with temperature/);
  assert.throws(() => brewPayload(espresso, { preselections: 'coldbrew' }, z10),
    /must be an array/);
});

test('IntakeF18 preselections use the mask byte and preserve the selected grind level', () => {
  const machine = catalogFor('EF1123 V01.00')!;
  const espresso = machine.products.find(product => product.code === 2)!;
  assert.equal(brewPayload(espresso), '02000809000002000100000000000000');
  assert.equal(brewPayload(espresso, { grindLevel: 1 }, machine),
    '0200080900000200010000000000000001');
  assert.equal(brewPayload(espresso, { preselections: ['lightbrew', 'double'], grindLevel: 1 }, machine),
    '0200080900000200010000000000000001000048');
  assert.equal(brewPayload(espresso, { preselections: ['coldbrew', 'strongcoldbrew'] }, machine),
    '0200080900000200010000000000000002000090');
  assert.throws(() => brewPayload(espresso, { preselections: ['double', 'strongcoldbrew'] }, machine),
    /Invalid preselection combination/);
  assert.throws(() => brewPayload(espresso, { grindLevel: 9 }, machine), /Invalid grindLevel/);
});

test('grinder ratio encodes only profile choices and shares the byte with grind level', () => {
  const espresso = catalogFor('EF566 V01.00')!.products.find(product => product.code === 2)!;
  assert.equal(brewPayload(espresso, { grinderRatio: 0 }), '02000809000002000100000000000000');
  assert.equal(brewPayload(espresso, { grinderRatio: 4 }), '02040809000002000100000000000000');
  assert.throws(() => brewPayload(espresso, { grinderRatio: 5 }), /Invalid grinderRatio/);
  const twoGrinders = catalogFor('EF1060 V01.00')!.products.find(product => product.code === 2)!;
  assert.equal(brewPayload(twoGrinders, { grinderRatio: 2, grindLevel: 5 }),
    '02520609000002000100000000000000');
  assert.throws(() => brewPayload(twoGrinders, { grinderRatio: 1 }), /Invalid grinderRatio/);
});

test('Z10 milk and foam encode independently with a legacy foam alias', () => {
  const milkcoffee = catalogFor('EF545M V02.01')!.products.find(
    product => product.code === 5,
  )!;
  assert.equal(brewPayload(milkcoffee), '05000512070301000100000000000000');
  assert.equal(
    brewPayload(milkcoffee, { milkAmount: 9, milkFoam: 0 }),
    '05000512090001000100000000000000',
  );
  assert.equal(
    brewPayload(milkcoffee, { milk: 4 }),
    brewPayload(milkcoffee, { milkFoam: 4 }),
  );
  assert.throws(
    () => brewPayload(milkcoffee, { milkAmount: 0 }),
    /Invalid milkAmount/,
  );
  assert.throws(
    () => brewPayload(milkcoffee, { milk: 1, milkFoam: 2 }),
    /Use only one/,
  );
});

test('Z10 recipe overrides encode grind, jug cycles, milk pause and both milk temperatures', () => {
  const { products } = catalogFor('EF545M V02.01')!;
  const latte = products.find(product => product.code === 7)!;
  const pot = products.find(product => product.code === 12)!;

  assert.equal(brewPayload(latte), '07000809041602000100000000000000');
  assert.equal(
    brewPayload(latte, {
      grindLevel: 5,
      milkPause: 12,
      milkFoamTemperature: 8,
      milkTemperature: 10,
    }),
    '075008090416020001000C00008A0000',
  );
  assert.equal(brewPayload(latte, { milkTemperature: 10 }).slice(26, 28), '0A');
  assert.equal(
    brewPayload(latte, { milkFoamTemperature: 8 }).slice(26, 28),
    '80',
  );
  assert.equal(
    brewPayload(pot, { strokes: 2 }),
    '0C00050E00000102010A000000000000',
  );
  assert.throws(
    () => brewPayload(latte, { grindLevel: 0 }),
    /Invalid grindLevel/,
  );
  assert.throws(
    () => brewPayload(latte, { milkPause: 61 }),
    /Invalid milkPause/,
  );
  assert.throws(
    () => brewPayload(latte, { milkFoamTemperature: 11 }),
    /Invalid milkFoamTemperature/,
  );
  assert.throws(
    () => brewPayload(latte, { milkTemperature: 0 }),
    /Invalid milkTemperature/,
  );
  assert.throws(() => brewPayload(pot, { strokes: 6 }), /Invalid strokes/);
  assert.throws(() => brewPayload(latte, { strokes: 2 }), /Invalid strokes/);
});

test('TCP pairs, authenticates and sends brew and stop on separate sessions', async t => {
  const token = 'a'.repeat(64);
  const seen: (string | null)[] = [];
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const command = decodeFrame(pending.subarray(0, end + 2));
        pending = pending.subarray(end + 2);
        seen.push(command);
        if (command === '@HP:012345,696F42726F6B6572,') {
          socket.write(encodeFrame('@hp4:' + token));
        } else if (command === '@HP:012345,696F42726F6B6572,' + token) {
          const reply = Buffer.concat([
            encodeFrame('@tf:00'),
            encodeFrame('@hp4'),
          ]);
          socket.write(reply.subarray(0, -1));
          setImmediate(() => socket.write(reply.subarray(-1)));
        } else if (command?.startsWith('@HP:')) {
          socket.end(encodeFrame('@hp5:00'));
        }
      }
    });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  assert.equal(await pair('127.0.0.1', '012345', { port }), token);

  const credentials = { pin: '012345', token };
  const brew = '@TP:02000809000002000100000000000000';
  for (const command of [brew, '@TG:FF']) {
    const connected = once(server, 'connection');
    await authenticated('127.0.0.1', credentials, ({ send }) => send(command), {
      port,
    });
    const [socket] = (await connected) as [Socket];
    if (!socket.destroyed) await once(socket, 'close');
    assert.equal(seen.at(-1), command);
  }
  await assert.rejects(
    authenticated(
      '127.0.0.1',
      { ...credentials, token: 'b'.repeat(64) },
      ({ send }) => send(brew),
      { port },
    ),
    /Machine rejected/,
  );
  assert.equal(seen.filter(command => command === brew).length, 1);
});

test('TCP pairs and reauthenticates with an empty PIN and a saved token', async t => {
  const token = 'c'.repeat(64);
  const seen: (string | null)[] = [];
  const server = net.createServer(async socket => {
    let bytes = Buffer.alloc(0);
    for await (const chunk of socket as AsyncIterable<Buffer>) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.indexOf('\r\n') === -1) continue;
      const command = decodeFrame(bytes);
      seen.push(command);
      if (command === '@HP:,696F42726F6B6572,')
        socket.end(encodeFrame('@hp4:' + token));
      else if (command === '@HP:,696F42726F6B6572,' + token)
        socket.end(encodeFrame('@hp4'));
      else socket.end(encodeFrame('@hp5:00'));
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const options = { port: address.port, timeout: 1000 };
  const pairedToken = await pair('127.0.0.1', '', options);
  assert.equal(pairedToken, token);
  assert.equal(
    await authenticated(
      '127.0.0.1',
      { pin: '', token: pairedToken },
      () => true,
      options,
    ),
    true,
  );
  assert.deepEqual(seen, [
    '@HP:,696F42726F6B6572,',
    '@HP:,696F42726F6B6572,' + token,
  ]);
});

test('statistics use model counter pages and preserve unavailable values', async () => {
  const seen: (string | null)[] = [];
  const machine = catalogFor('EF545M V02.01');
  assert(machine);
  const stats = await readStatistics(
    {
      async request(command, matcher) {
        seen.push(command);
        let reply = command.replace('@TR', '@tr').replace('@TG', '@tg');
        if (command.startsWith('@TR')) reply += ',000C0000FFFF0003';
        if (command === '@TG:C0') reply += '05FF64';
        if (command === '@TG:43') reply += '000100020003000400050006';
        assert.match(reply, matcher);
        return reply;
      },
    },
    machine,
  );
  assert.equal(seen.length, new Set(seen).size);
  assert(seen.includes('@TR:32,0C'));
  assert.deepEqual(stats.products.slice(0, 3), [
    [0, 12],
    [2, null],
    [3, 3],
  ]);
  assert.deepEqual(stats.maintenance, [5, null, 100]);
  assert.deepEqual(stats.cycles, [1, 2, 3, 4, 5, 6]);
});

test('Z10 double-drink counters prefer remapped slots and fall back when unavailable', async () => {
  const requests: string[] = [];
  const stats = await readStatistics(
    {
      async request(command, matcher) {
        requests.push(command);
        const data: Record<string, string> = {
          '@TR:32,04': ',FFFFFFFF0000FFFF',
          '@TR:32,0C': ',0000002900000000',
          '@TR:32,0D': ',0000000000870000',
          '@TG:C0': '05FF64',
          '@TG:43': '000100020003000400050006',
        };
        const reply =
          command.toLowerCase() + (data[command] ?? ',0000000000000000');
        assert.match(reply, matcher);
        return reply;
      },
    },
    catalogFor('EF545M V02.01')!,
  );
  assert.deepEqual(stats.products.slice(-2), [
    [49, 0],
    [54, 135],
  ]);
  assert.equal(requests.filter(command => command === '@TR:32,04').length, 1);
});

test('statistics accept the shorter maintenance banks defined by a model variant', async () => {
  const machine = catalogFor('EF567_CM V01.00');
  assert(machine);
  const stats = await readStatistics(
    {
      async request(command, matcher) {
        let reply;
        if (command === '@TG:C0') reply = '@tg:C00A64';
        else if (command === '@TG:43') reply = '@tg:4300010002000300040005';
        else reply = command.toLowerCase() + ',000C000000000003';
        assert.match(reply, matcher);
        return reply;
      },
    },
    machine,
  );
  assert.deepEqual(machine.maintenanceStatusFields, ['Cleaning', 'Descaling']);
  assert.deepEqual(stats.maintenance, [10, 100]);
  assert.deepEqual(stats.cycles, [1, 2, 3, 4, 5]);
});
