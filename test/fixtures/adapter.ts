import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { compileFunction } from 'node:vm';
import { FORBIDDEN_CHARS } from '@iobroker/adapter-core/tools';
import * as protocol from '../../lib/jura';
import type { SimulatedMachine } from './machine';

type TestObject = Pick<ioBroker.Object, 'type' | 'common' | 'native'> & {
  from?: string;
};

export async function until(condition: () => boolean, description: string) {
  const deadline = performance.now() + 4000;
  while (!condition()) {
    assert(
      performance.now() < deadline,
      `Timed out waiting for ${description}`,
    );
    await delay(5);
  }
}

class StateStore extends EventEmitter {
  readonly namespace = 'jura-wifi-2.0';
  readonly FORBIDDEN_CHARS = FORBIDDEN_CHARS;
  readonly log = { error: () => {}, debug: () => {}, warn: () => {} };
  readonly objects = new Map<string, TestObject>();
  readonly states = new Map<string, ioBroker.State>();
  readonly writes: { id: string; val: ioBroker.StateValue; ack: boolean }[] =
    [];
  readonly replies: {
    to: string;
    command: string;
    data: unknown;
    callback: ioBroker.MessageCallbackInfo;
  }[] = [];
  private readonly subscriptions = new Set<string>();
  private ts = 0;

  constructor(readonly options: { config: ioBroker.AdapterConfig }) {
    super();
  }

  get config() {
    return this.options.config;
  }

  write(
    id: string,
    val: ioBroker.StateValue,
    ack = false,
    from = 'system.adapter.javascript.0',
  ) {
    const ts = ++this.ts;
    const state = { val, ack, from, ts, lc: ts };
    this.states.set(id, state);
    this.writes.push({ id, val, ack });
    if (
      [...this.subscriptions].some(pattern =>
        id.startsWith(pattern.slice(0, -1)),
      )
    ) {
      queueMicrotask(() =>
        this.emit('stateChange', this.namespace + '.' + id, state),
      );
    }
    return state;
  }

  async setStateAsync(id: string, val: ioBroker.StateValue, ack: boolean) {
    this.write(id, val, ack, 'system.adapter.' + this.namespace);
  }

  async setStateChangedAsync(
    id: string,
    val: ioBroker.StateValue,
    ack: boolean,
  ) {
    const current = this.states.get(id);
    if (current?.val !== val || current.ack !== ack)
      await this.setStateAsync(id, val, ack);
  }

  async subscribeStatesAsync(pattern: string) {
    assert(pattern.endsWith('.*'));
    this.subscriptions.add(pattern);
  }

  async getStateAsync(id: string) {
    return this.states.get(id) ?? null;
  }

  async getObjectAsync(id: string) {
    return this.objects.get(id) ?? null;
  }

  async getObjectViewAsync(
    design: string,
    search: string,
    { startkey, endkey }: { startkey: string; endkey: string },
  ) {
    assert.equal(design, 'system');
    assert.equal(search, 'state');
    return {
      rows: [...this.objects].flatMap(([id, value]) => {
        const key = `${this.namespace}.${id}`;
        return value.type === 'state' && key >= startkey && key <= endkey
          ? [{ id: key, value }]
          : [];
      }),
    };
  }

  async setObjectNotExistsAsync(id: string, object: TestObject) {
    if (this.objects.has(id)) return;
    this.objects.set(id, object);
    if (
      object.type === 'state' &&
      'def' in object.common &&
      object.common.def !== undefined
    ) {
      await this.setStateAsync(id, object.common.def, true);
    }
  }

  async delObjectAsync(id: string) {
    this.objects.delete(id);
    this.states.delete(id);
  }

  sendTo(
    to: string,
    command: string,
    data: unknown,
    callback: ioBroker.MessageCallbackInfo,
  ) {
    this.replies.push({ to, command, data, callback });
  }
}

export async function startAdapter(
  t: TestContext,
  machine: SimulatedMachine,
  config: ioBroker.AdapterConfig,
  seed?: (store: StateStore) => void,
) {
  await machine.start(t);
  let now = 0;
  let timer: { callback: () => void; due: number } | undefined;
  const entry = require.resolve('../../main');
  const requireFromAdapter = createRequire(entry);
  const load = compileFunction(
    readFileSync(entry, 'utf8'),
    ['require', 'module', 'performance', 'setTimeout', 'clearTimeout'],
    { filename: entry },
  );
  const fakeModule: { exports: unknown } = { exports: {} };
  const transport: Pick<
    typeof protocol,
    'authenticated' | 'pair' | 'pollStatus'
  > = {
    authenticated: (host, credentials, action, options) =>
      protocol.authenticated(host, credentials, action, {
        ...options,
        port: machine.tcpPort,
      }),
    pair: (host, pin, options) =>
      protocol.pair(host, pin, { ...options, port: machine.tcpPort }),
    pollStatus: (host, options) =>
      protocol.pollStatus(host, { ...options, port: machine.udpPort }),
  };
  const testRequire = (id: string) => {
    if (id === '@iobroker/adapter-core') return { Adapter: StateStore };
    if (id === './lib/jura') return { ...protocol, ...transport };
    return requireFromAdapter(id);
  };
  load(
    testRequire,
    fakeModule,
    { now: () => now },
    (callback: () => void, milliseconds: number) => {
      assert.equal(
        timer,
        undefined,
        'one status poll should be scheduled at a time',
      );
      timer = { callback, due: now + milliseconds };
      return timer;
    },
    (pending: typeof timer) => {
      if (pending === timer) timer = undefined;
    },
  );
  const factory = fakeModule.exports as (options: {
    config: ioBroker.AdapterConfig;
  }) => StateStore;
  const adapter = factory({ config });
  seed?.(adapter);
  t.after(() => new Promise<void>(resolve => adapter.emit('unload', resolve)));
  adapter.emit('ready');
  if (config.host) await until(() => timer !== undefined, 'the first poll');

  return {
    adapter,
    now: () => now,
    async poll(at?: number) {
      assert(timer, 'a poll should be scheduled');
      const { callback, due } = timer;
      const next = at ?? due;
      assert(next >= due, 'test clock cannot run a poll before its due time');
      now = next;
      timer = undefined;
      callback();
      await until(() => timer !== undefined, 'the next poll');
    },
  };
}
