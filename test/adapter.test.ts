import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { startAdapter, until } from './fixtures/adapter';
import { SimulatedMachine, token } from './fixtures/machine';

const config = { host: 'localhost', pollInterval: 1, setupPin: '', token };
const espresso = 'products.catalog.Espresso';
const commandResult = 'info.commandResult';
const espressoCommand = '@TP:02000809000002000100000000000000';

async function startPaired(
  t: TestContext,
  customRecipes?: ioBroker.AdapterConfig['customRecipes'],
) {
  const machine = new SimulatedMachine();
  const fixture = await startAdapter(t, machine, { ...config, customRecipes });
  await fixture.poll();
  await fixture.poll();
  await until(
    () =>
      fixture.adapter.states.get(commandResult)?.val === 'Statistics refreshed',
    'the startup statistics result',
  );
  return { machine, ...fixture };
}

test('a custom drink sends its saved recipe and resets after acceptance', async t => {
  const id = 'products.custom.My Drink';
  const { adapter, machine, poll } = await startPaired(t, [
    {
      name: 'My Drink',
      recipe: '{"productCode":5,"water":90,"milkAmount":9,"milkFoam":2}',
    },
  ]);
  assert.equal(adapter.objects.get(id)?.common.name, 'Brew My Drink');
  assert.equal(adapter.states.get(id)?.val, false);

  adapter.write(id, true, true);
  adapter.write(id, false);
  await poll();
  assert.deepEqual(machine.brewRequests, []);

  const response = machine.holdNextBrewReply();
  const pending = adapter.write(id, true);
  await response.arrived;
  assert.deepEqual(machine.brewRequests, [
    '@TP:05000512090201000100000000000000',
  ]);
  assert.deepEqual(adapter.states.get(id), pending);
  await response.release('@tp');
  await until(
    () => adapter.states.get(id)?.ack === true,
    'custom drink acknowledgment',
  );
  assert.equal(adapter.states.get(id)?.val, false);
  assert.equal(
    adapter.states.get(commandResult)?.val,
    'Machine accepted brew request for My Drink',
  );
});

test('a guided custom drink uses selected overrides and ignores values from a previous base drink', async t => {
  const id = 'products.custom.Guided Milkcoffee';
  const { adapter, machine } = await startPaired(t, [
    {
      name: 'Guided Milkcoffee',
      useJson: false,
      recipe: '{"productCode":2}',
      productCode: '5',
      strength: '2:1',
      water: 'default',
      milkAmount: '5:9',
      milkFoam: '5:0',
    },
  ]);
  adapter.write(id, true);
  await until(
    () => adapter.states.get(id)?.ack === true,
    'guided drink acknowledgment',
  );
  assert.equal(adapter.states.get(id)?.val, false);
  assert.deepEqual(machine.brewRequests, [
    '@TP:05000512090001000100000000000000',
  ]);
});

test('Admin recipe options follow the detected catalog and the selected product', async t => {
  const machine = new SimulatedMachine();
  const { adapter, poll } = await startAdapter(t, machine, config);
  function options(
    message: {
      productCode?: string;
      parameter?: string;
      selected?: string;
    } = {},
  ) {
    adapter.emit('message', {
      command: 'customRecipeOptions',
      from: 'system.adapter.admin.0',
      message,
      callback: { id: 1, ack: false, time: 0, message },
    });
    return adapter.replies.at(-1)?.data;
  }

  assert.deepEqual(options(), []);
  await poll();
  const products = options();
  assert(Array.isArray(products));
  assert.deepEqual(
    products.slice(0, 5).map(option => option.label),
    ['Barista Lungo', 'Cafe Barista', 'Cappuccino', 'Coffee', 'Cortado'],
  );
  assert.deepEqual(
    products.find(option => option.value === '5'),
    { value: '5', label: 'Milkcoffee' },
  );
  assert.deepEqual(options({ productCode: '2', parameter: 'milkFoam' }), []);
  const foam = options({ productCode: '5', parameter: 'milkFoam' });
  assert(Array.isArray(foam));
  assert.deepEqual(foam.slice(0, 2), [
    { value: 'default', label: 'Use default (3 s)' },
    { value: '5:0', label: '0 s' },
  ]);
  assert.deepEqual(foam.at(-1), { value: '5:45', label: '45 s' });
  const bypass = options({ productCode: '40', parameter: 'bypass' });
  assert(Array.isArray(bypass));
  assert.deepEqual(bypass.slice(0, 3), [
    { value: 'default', label: 'Use default (50 ml)' },
    { value: '40:0', label: '0 ml' },
    { value: '40:5', label: '5 ml' },
  ]);
  const water = options({
    productCode: '48',
    parameter: 'water',
    selected: '43:45',
  });
  assert(Array.isArray(water));
  assert.deepEqual(water[0], { value: '43:45', label: 'Use default (90 ml)' });
  assert.deepEqual(machine.brewRequests, []);
});

test('invalid custom drink parameters leave the switch unacknowledged', async t => {
  const id = 'products.custom.Too Much Milk';
  const { adapter, machine } = await startPaired(t, [
    { name: 'Too Much Milk', recipe: '{"productCode":5,"milkAmount":100}' },
  ]);
  const pending = adapter.write(id, true);
  await until(
    () =>
      adapter.states.get(commandResult)?.val ===
      'brew: Invalid milkAmount for Milkcoffee',
    'recipe validation failure',
  );
  assert.deepEqual(adapter.states.get(id), pending);
  assert.deepEqual(machine.brewRequests, []);
});

test('custom drink synchronization removes stale switches and skips ambiguous names', async t => {
  const prefix = 'products.custom.';
  const { adapter } = await startAdapter(
    t,
    new SimulatedMachine(),
    {
      ...config,
      customRecipes: [
        { name: 'Same.Name', recipe: '{"productCode":2}' },
        { name: 'Same_Name', recipe: '{"productCode":3}' },
        { name: 'Invalid JSON', recipe: '[' },
      ],
    },
    store => {
      store.objects.set(prefix + 'Old Drink', {
        type: 'state',
        common: {
          name: 'Brew Old Drink',
          role: 'switch',
        } as ioBroker.StateCommon,
        native: { customRecipe: true },
      });
    },
  );
  for (const name of ['Old Drink', 'Same_Name', 'Invalid JSON']) {
    assert.equal(adapter.objects.has(prefix + name), false);
  }
});

test('a brew switch resets only after the machine accepts the request', async t => {
  const { adapter, machine, poll } = await startPaired(t);
  assert.deepEqual(adapter.objects.get(espresso)?.common, {
    name: 'Brew Espresso',
    type: 'boolean',
    role: 'switch',
    read: true,
    write: true,
    def: false,
  });
  assert.equal(adapter.states.get(espresso)?.val, false);

  for (const [value, ack] of [
    [false, false],
    [true, true],
  ]) {
    const pollsBefore = machine.polls;
    adapter.write(espresso, value, ack);
    await poll();
    assert.equal(
      machine.polls,
      pollsBefore + 1,
      'only the normal poll should run',
    );
    assert.deepEqual(machine.brewRequests, []);
  }

  machine.ready = false;
  const pending = adapter.write(espresso, true);
  await until(
    () =>
      adapter.states.get(commandResult)?.val ===
      'brew: Machine is not ready to brew',
    'the rejected brew',
  );
  assert.deepEqual(adapter.states.get(espresso), pending);
  assert.deepEqual(machine.brewRequests, []);

  machine.ready = true;
  const beforeSuccess = adapter.writes.length;
  const response = machine.holdNextBrewReply();
  const requested = adapter.write(espresso, true);
  await response.arrived;
  await response.release('@TB');
  await poll();
  assert.deepEqual(adapter.states.get(espresso), requested);
  await response.release('@tp');
  await until(
    () => adapter.states.get(espresso)?.ack === true,
    'the acknowledged reset',
  );
  await until(() => machine.brewRequests.length > 0, 'the espresso request');
  assert.deepEqual(machine.brewRequests, [espressoCommand]);
  assert.deepEqual(
    adapter.writes
      .slice(beforeSuccess)
      .filter(({ id }) => id === espresso || id === commandResult),
    [
      { id: espresso, val: true, ack: false },
      {
        id: commandResult,
        val: 'Machine accepted brew request for Espresso',
        ack: true,
      },
      { id: espresso, val: false, ack: true },
    ],
  );
});

test('a machine brew rejection leaves the switch unacknowledged', async t => {
  const { adapter, machine } = await startPaired(t);
  machine.brewReply = '@tp:00';
  const requested = adapter.write(espresso, true);
  await until(
    () =>
      adapter.states.get(commandResult)?.val ===
      'brew: Machine rejected the brew request',
    'the machine rejection',
  );
  assert.deepEqual(adapter.states.get(espresso), requested);
  assert.deepEqual(machine.brewRequests, [espressoCommand]);
});

test('a missing machine brew reply leaves the switch unacknowledged', async t => {
  const { adapter, machine } = await startPaired(t);
  machine.brewReply = null;
  const requested = adapter.write(espresso, true);
  await until(
    () =>
      adapter.states.get(commandResult)?.val ===
      'brew: No matching TCP reply from machine',
    'the missing reply error',
  );
  assert.deepEqual(adapter.states.get(espresso), requested);
  assert.deepEqual(machine.brewRequests, [espressoCommand]);
});

test(
  'an in-flight brew leaves a newer write pending',
  { timeout: 8000 },
  async t => {
    const { adapter, machine, poll } = await startPaired(t);
    const auth = machine.holdNextAuthentication();
    adapter.write(espresso, true);
    await auth.arrived;

    const newer = adapter.write(espresso, true);
    await auth.release();
    await until(
      () =>
        adapter.states.get(commandResult)?.val ===
        'Machine accepted brew request for Espresso',
      'the first brew result',
    );
    // A subsequent poll gives the completed operation time to acknowledge its write.
    await poll();
    assert.deepEqual(machine.brewRequests, [espressoCommand]);
    assert.deepEqual(adapter.states.get(espresso), newer);
  },
);

test('an unpaired machine is reachable without an authenticated connection', async t => {
  const machine = new SimulatedMachine();
  const { adapter, poll } = await startAdapter(t, machine, {
    ...config,
    token: '',
  });
  await poll();
  assert.equal(adapter.states.get('info.reachable')?.val, true);
  assert.equal(adapter.states.get('info.connection')?.val, false);
  assert.deepEqual(machine.requests, []);
});

test('a paired machine reconnects after an outage without pairing again', async t => {
  const machine = new SimulatedMachine();
  const { adapter, now, poll } = await startAdapter(t, machine, config);
  await poll();
  assert.equal(adapter.states.get('info.connection')?.val, true);
  assert.equal(adapter.states.get('info.reachable')?.val, true);

  machine.online = false;
  await poll();
  assert.equal(adapter.states.get('info.connection')?.val, false);
  assert.equal(adapter.states.get('info.reachable')?.val, false);

  machine.online = true;
  machine.acceptsToken = false;
  await poll();
  assert.equal(adapter.states.get('info.connection')?.val, false);
  assert.equal(adapter.states.get('info.reachable')?.val, true);

  machine.acceptsToken = true;
  await poll(now() + 10_000);
  assert.equal(adapter.states.get('info.connection')?.val, true);
  assert.equal(adapter.states.get('info.reachable')?.val, true);
  assert.deepEqual(machine.requests, [
    `@HP:,696F42726F6B6572,${token}`,
    `@HP:,696F42726F6B6572,${token}`,
    `@HP:,696F42726F6B6572,${token}`,
  ]);
});

test('statistics refresh at startup and wait for idle when ten minutes are due', async t => {
  const { adapter, machine, now, poll } = await startPaired(t);
  assert.equal(machine.statisticsReads, 1);
  assert.equal(adapter.states.get('products.counts.Total')?.val, 12);
  assert.equal(adapter.states.get('products.counts.2 Espressi')?.val, 2);
  assert.equal(adapter.states.get('products.counts.2 Coffee')?.val, 3);
  assert.equal(adapter.objects.has('products.catalog.2 Espressi'), false);
  assert.equal(adapter.objects.has('products.catalog.2 Coffee'), false);
  const due = now() + 600_000;

  await poll(due - 1000);
  assert.equal(machine.statisticsReads, 1);

  await poll(due);
  await until(
    () => machine.statisticsReads === 2,
    'the ten-minute statistics refresh',
  );

  machine.brewing = true;
  await poll(due + 600_000);
  assert.equal(adapter.states.get('status.productRunning')?.val, true);
  assert.equal(machine.statisticsReads, 2);

  machine.brewing = false;
  await poll();
  await until(
    () => machine.statisticsReads === 3,
    'the deferred statistics refresh',
  );
  await poll();
  assert.equal(machine.statisticsReads, 3);
});

test('only a valid Admin pairing request reaches the machine', async t => {
  const machine = new SimulatedMachine();
  const { adapter } = await startAdapter(t, machine, {});
  const admin = 'system.adapter.admin.0';
  function request(
    id: number,
    from: string,
    message: { host?: string; setupPin?: string },
  ) {
    adapter.emit('message', {
      command: 'pair',
      from,
      message,
      callback: { id, ack: false, time: 0, message },
    });
  }

  request(1, admin, { setupPin: '' });
  request(2, 'system.adapter.javascript.0', {
    host: 'localhost',
    setupPin: '',
  });
  assert.deepEqual(
    adapter.replies.map(reply => [reply.callback.id, reply.to, reply.data]),
    [[1, admin, { error: 'Enter the machine IPv4 address or hostname.' }]],
  );
  assert.equal(machine.polls, 0);
  assert.deepEqual(machine.requests, []);

  request(3, admin, { host: 'localhost', setupPin: '' });
  await until(() => adapter.replies.length === 2, 'the pairing token');
  assert.deepEqual(
    adapter.replies.map(reply => reply.callback.id),
    [1, 3],
  );
  assert.deepEqual(adapter.replies[1].data, {
    result: 'paired',
    native: { host: 'localhost', setupPin: '', token },
  });
  assert.equal(machine.polls, 1);
  assert.deepEqual(machine.requests, ['@HP:,696F42726F6B6572,']);
});

test('statistics migrate plain hex counters and preserve legacy history settings', async t => {
  const machine = new SimulatedMachine();
  const hexEspresso = 'products.counts.02';
  const hexCoffee = 'products.counts.03';
  const history = { 'history.0': { enabled: true } };
  const { adapter, poll } = await startAdapter(t, machine, config, store => {
    for (const [id, name, custom] of [
      [hexEspresso, 'Espresso', undefined],
      [hexCoffee, 'Coffee', history],
    ] as const) {
      store.objects.set(id, {
        from: 'system.adapter.jura-wifi-2.0',
        type: 'state',
        common: {
          name,
          type: 'number',
          role: 'value',
          read: true,
          write: false,
          ...(custom && { custom }),
        },
        native: {},
      });
      store.write(id, 3, true);
    }
  });

  await poll();
  await poll();
  await until(
    () => adapter.states.get(commandResult)?.val === 'Statistics refreshed',
    'the named counters',
  );
  assert.equal(adapter.states.get('products.counts.Espresso')?.val, 5);
  assert.equal(adapter.states.get('products.counts.Total')?.val, 12);
  assert.equal(adapter.states.get('products.counts.Coffee')?.val, 7);
  assert.equal(adapter.states.get('maintenance.percent.descaling')?.val, null);
  assert.equal(adapter.objects.has(hexEspresso), false);
  assert.equal(adapter.states.has(hexEspresso), false);
  const legacy = adapter.objects.get(hexCoffee);
  assert.equal(legacy?.type, 'state');
  assert.deepEqual((legacy?.common as ioBroker.StateCommon).custom, history);
  assert.equal(adapter.states.get(hexCoffee)?.val, 3);
});
