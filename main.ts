import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import {
  authenticated,
  brewPayload,
  catalogFor,
  pair,
  pollStatus,
  productCounters,
  readStatistics,
  type Credentials,
  type MachineCatalog,
  type MachineStatus,
  type Product,
  type Statistics,
} from './lib/jura';

declare global {
  namespace ioBroker {
    interface AdapterConfig {
      host?: string;
      pollInterval?: number;
      setupPin?: string;
      token?: string;
      customRecipes?: CustomRecipeConfig[];
    }
  }
}

type ProductIdentity = Pick<Product, 'code' | 'name'>;
type BrewRequest = Record<string, unknown>;
type CustomRecipeConfig = {
  name: string;
  recipe?: string;
  useJson?: boolean;
  productCode?: string;
} & Partial<Record<RecipeParameter, string>>;
type CustomRecipe = { name: string; request: BrewRequest };
type BrewSwitch = { product: Product } | CustomRecipe;
type PairingResponse =
  | { error: string }
  | {
      result: 'paired';
      native: { host: string; setupPin: string; token: string };
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBrewRequest(json: string): BrewRequest {
  const request: unknown = JSON.parse(json);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Brew request must be a JSON object');
  }
  return request as BrewRequest;
}

const recipeParameters = {
  strength: { field: 'strength', unit: '' },
  water: { field: 'water', unit: ' ml' },
  milkAmount: { field: 'milkAmount', unit: ' s' },
  milkFoam: { field: 'milk', unit: ' s' },
  bypass: { field: 'bypass', unit: ' ml' },
  temperature: { field: 'defaultTemperature', unit: '' },
} as const satisfies Record<string, { field: keyof Product; unit: string }>;
type RecipeParameter = keyof typeof recipeParameters;

function customBrewRequest(row: CustomRecipeConfig): BrewRequest {
  if (row.useJson ?? Boolean(row.recipe)) {
    return parseBrewRequest(row.recipe ?? '');
  }

  const productCode = Number(row.productCode);
  if (!Number.isInteger(productCode) || productCode <= 0) {
    throw new Error('Select a base drink or enter a JSON recipe');
  }
  const request: BrewRequest = { productCode };
  const prefix = `${productCode}:`;
  for (const key of Object.keys(recipeParameters) as RecipeParameter[]) {
    const option = row[key];
    // An override selected for an earlier base drink must not affect the new one.
    if (typeof option === 'string' && option.startsWith(prefix)) {
      const value = option.slice(prefix.length);
      request[key] = key === 'temperature' ? value : Number(value);
    }
  }
  return request;
}

function recipeOptions(
  products: readonly Product[],
  { productCode, parameter }: { productCode?: unknown; parameter?: unknown },
) {
  if (parameter === undefined) {
    return products
      .map(({ code, name }) => ({ value: String(code), label: name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'en'));
  }
  if (
    typeof parameter !== 'string' ||
    !Object.hasOwn(recipeParameters, parameter)
  )
    return [];
  const product = products.find(({ code }) => String(code) === productCode);
  const { field, unit } = recipeParameters[parameter as RecipeParameter];
  const setting = product?.[field];
  if (!product || setting === undefined) return [];

  const values =
    typeof setting === 'string'
      ? ['LOW', 'NORMAL', 'HIGH']
      : Array.from(
          {
            length: Math.floor((setting.max - setting.min) / setting.step) + 1,
          },
          (_, i) => setting.min + i * setting.step,
        );
  const defaultValue = typeof setting === 'string' ? setting : setting.default;
  return [
    { value: 'default', label: `Use default (${defaultValue}${unit})` },
    ...values.map(value => ({
      value: `${product.code}:${value}`,
      label: `${value}${unit}`,
    })),
  ];
}

const commands = {
  brew: ['Brew with JSON parameters', 'string', 'json', ''],
  stop: ['Stop the current product step', 'boolean', 'button.stop', false],
  refreshStatistics: [
    'Read product and maintenance counters',
    'boolean',
    'button',
    false,
  ],
} as const;

type Command = keyof typeof commands;

function isCommand(command: string): command is Command {
  return Object.hasOwn(commands, command);
}

// Avoid authentication traffic during brewing and keep retries off the fast UDP poll path.
const AUTH_RECHECK_MS = 60000;
const AUTH_RETRY_MS = 10000;
const STATISTICS_INTERVAL_MS = 10 * 60 * 1000;

const statusStates = {
  'info.name': ['Machine name', 'string', 'info.name'],
  'info.model': ['Model and firmware', 'string', 'text'],
  'info.module': ['WiFi module and firmware', 'string', 'text'],
  'info.articleNumber': ['Article number', 'number', 'value'],
  'info.commandResult': ['Last command result', 'string', 'text'],
  'status.productRunning': ['Product running', 'boolean', 'indicator.working'],
  'status.ready': ['Coffee ready', 'boolean', 'indicator'],
  'status.activeAlerts': ['Active idle flags', 'string', 'json'],
  'status.payload': ['Raw UDP status payload', 'string', 'text'],
  'status.phaseCode': ['Product phase code', 'number', 'value'],
  'status.phase': ['Product phase', 'string', 'text'],
  'status.dispensed': ['Water dispensed', 'number', 'value', 'ml'],
  'status.target': ['Target water', 'number', 'value', 'ml'],
  'status.progress': ['Dispensing progress', 'number', 'value', '%'],
  'products.catalog': ['Supported products and parameters', 'string', 'json'],
} as const;

const productId = (code: number) =>
  code.toString(16).toUpperCase().padStart(2, '0');

type JuraAdapterOptions = Omit<AdapterOptions, 'name'>;

class JuraAdapter extends Adapter {
  private readonly lifecycle = new AbortController();
  private machineHost = '';
  private interval = 2000;
  private timer?: NodeJS.Timeout;
  private startup?: Promise<void>;
  private polling?: Promise<void>;
  private operation?: Promise<unknown>;
  private pairing?: Promise<string>;
  private credentials: Credentials | null = null;
  private authenticationCheck?: Promise<void>;
  private nextAuthentication?: number;
  private nextStatisticsRefresh = 0;
  private reachable?: boolean;
  private isAuthenticated = false;
  private brewRequestedUntil?: number;
  private switchCatalog?: MachineCatalog | null;
  private countCatalog?: MachineCatalog;
  private productSwitches?: Map<string, Product>;
  private readonly customRecipes = new Map<string, CustomRecipe>();

  constructor(options: JuraAdapterOptions = {}) {
    super({ ...options, name: 'jura-wifi-2' });
    this.on('ready', () => {
      this.startup = this.start().catch(error =>
        this.log.error(errorMessage(error)),
      );
    });
    this.on('message', (message: ioBroker.Message) => {
      this.onMessage(message).catch(error =>
        this.log.error(errorMessage(error)),
      );
    });
    this.on(
      'stateChange',
      (id: string, state: ioBroker.State | null | undefined) =>
        this.onCommand(id, state),
    );
    this.on('unload', (callback: ioBroker.EmptyCallback) => {
      this.lifecycle.abort();
      clearTimeout(this.timer);
      Promise.allSettled([
        this.startup,
        this.polling,
        this.operation,
        this.pairing,
      ])
        .then(() =>
          this.publish({ 'info.connection': false, 'info.reachable': false }),
        )
        .catch(error => this.log.debug(errorMessage(error)))
        .finally(callback);
    });
  }

  private async state(
    id: string,
    name: string,
    type: ioBroker.StateCommon['type'],
    role: string,
    extra: Pick<ioBroker.StateCommon, 'unit' | 'def'> &
      Partial<Pick<ioBroker.StateCommon, 'write'>> = {},
    native: Record<string, unknown> = {},
  ) {
    await this.setObjectNotExistsAsync(id, {
      type: 'state',
      common: { name, type, role, read: true, write: false, ...extra },
      native,
    });
  }

  private async channel(id: string, name: string) {
    await this.setObjectNotExistsAsync(id, {
      type: 'channel',
      common: { name },
      native: {},
    });
  }

  private async start() {
    await this.publish({ 'info.connection': false, 'info.reachable': false });
    const pin = this.config.setupPin?.trim() ?? '';
    const token = this.config.token?.trim();
    this.credentials = token ? { pin, token } : null;
    this.machineHost = this.config.host?.trim() ?? '';
    if (!this.machineHost) {
      this.log.warn(
        'Set the machine IP address or hostname in the instance settings',
      );
      return;
    }

    const interval = Number(this.config.pollInterval);
    this.interval =
      Number.isFinite(interval) && interval >= 1 && interval <= 60
        ? interval * 1000
        : 2000;
    for (const [id, name] of Object.entries({
      status: 'Machine status',
      products: 'Products',
      maintenance: 'Maintenance',
      commands: 'Commands',
    }))
      await this.channel(id, name);
    for (const [id, [name, type, role, unit]] of Object.entries(statusStates)) {
      await this.state(id, name, type, role, unit ? { unit } : {});
    }
    for (const [command, [name, type, role, idle]] of Object.entries(
      commands,
    )) {
      await this.state(`commands.${command}`, name, type, role, {
        write: true,
        def: idle,
      });
      await this.setStateAsync(`commands.${command}`, idle, true);
    }
    await this.setStateAsync('info.commandResult', '', true);
    await this.syncCustomRecipes();
    if (this.lifecycle.signal.aborted) return;
    await this.subscribeStatesAsync('commands.*');
    await this.subscribeStatesAsync('products.catalog.*');
    await this.subscribeStatesAsync('products.custom.*');
    this.nextStatisticsRefresh = performance.now();
    if (!this.lifecycle.signal.aborted) this.schedulePoll(0);
  }

  private schedulePoll(delay: number) {
    this.timer = setTimeout(() => {
      this.polling = this.poll()
        .catch(error => this.log.error(errorMessage(error)))
        .finally(() => {
          if (!this.lifecycle.signal.aborted) this.schedulePoll(this.interval);
        });
    }, delay);
  }

  private async poll() {
    let status: MachineStatus;
    try {
      status = await pollStatus(this.machineHost, {
        signal: this.lifecycle.signal,
      });
    } catch (error) {
      if (this.lifecycle.signal.aborted) return;
      if (this.reachable !== false) this.log.warn(errorMessage(error));
      this.reachable = false;
      this.isAuthenticated = false;
      this.nextAuthentication = undefined;
      await this.publish({ 'info.connection': false, 'info.reachable': false });
      return;
    }
    if (this.lifecycle.signal.aborted) return;

    const catalog = catalogFor(status.model);
    if (catalog !== this.switchCatalog) {
      const switches = this.productStates('catalog', catalog?.products ?? []);
      await Promise.all(
        Array.from(switches, ([id, product]) =>
          this.syncProductSwitch(id, product),
        ),
      );
      this.productSwitches = switches;
      this.switchCatalog = catalog;
    }
    const alerts = status.alertBits?.map(bit => ({
      bit,
      name: catalog?.alertBits[bit] ?? null,
    }));
    await this.publish({
      'info.name': status.name,
      'info.model': status.model,
      'info.module': status.module,
      'info.articleNumber': status.articleNumber,
      'status.productRunning': status.productRunning,
      'status.ready': catalog
        ? (status.alertBits?.includes(13) ?? false)
        : null,
      'status.activeAlerts': alerts ? JSON.stringify(alerts) : null,
      'status.payload': status.payload,
      'status.phaseCode': status.progress?.code ?? null,
      'status.phase': status.progress?.phase ?? null,
      'status.dispensed': status.progress?.dispensedMl ?? null,
      'status.target': status.progress?.targetMl ?? null,
      'status.progress': status.progress?.percent ?? null,
      'products.catalog': catalog ? JSON.stringify(catalog.products) : null,
    });
    this.reachable = true;
    await this.setStateChangedAsync('info.reachable', true, true);
    if (
      !this.credentials ||
      status.productRunning ||
      this.operation ||
      this.pairing ||
      this.recentBrew()
    )
      return;

    const now = performance.now();
    if (this.isAuthenticated && now >= this.nextStatisticsRefresh) {
      this.nextStatisticsRefresh = now + STATISTICS_INTERVAL_MS;
      this.startOperation(() => this.runCommand('refreshStatistics'));
    } else if (now >= (this.nextAuthentication ?? 0)) {
      this.authenticationCheck = this.verifyAuthentication();
      try {
        await this.authenticationCheck;
      } finally {
        this.authenticationCheck = undefined;
      }
    }
  }

  private productStates<T extends ProductIdentity>(
    group: 'catalog' | 'counts',
    products: T[],
  ): Map<string, T> {
    const entries = products.map(
      product =>
        [
          `products.${group}.${this.productStateName(product.name)}`,
          product,
        ] as const,
    );
    return new Map(
      entries.map(([id, product]) => {
        const sharedName = entries.some(
          ([otherId, other]) => otherId === id && other !== product,
        );
        return [
          sharedName ? `${id} (${productId(product.code)})` : id,
          product,
        ];
      }),
    );
  }

  private productStateName(name: string) {
    return name.replace(this.FORBIDDEN_CHARS, '_').replaceAll('.', '_');
  }

  private async syncCustomRecipes() {
    const prefix = 'products.custom.';
    const seen = new Set<string>();
    const rows = this.config.customRecipes;
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = typeof row?.name === 'string' ? row.name.trim() : '';
      if (!name) {
        this.log.warn('Custom drink requires a name');
        continue;
      }
      const id = prefix + this.productStateName(name);
      if (seen.has(id)) {
        this.customRecipes.delete(id);
        this.log.warn(
          `Custom drink names must have distinct state IDs: ${name}`,
        );
        continue;
      }
      seen.add(id);
      try {
        const request = customBrewRequest(row);
        if (!Number.isInteger(request.productCode)) {
          throw new Error('Use a numeric productCode from products.catalog');
        }
        this.customRecipes.set(id, { name, request });
      } catch (error) {
        this.log.warn(`Custom drink ${name}: ${errorMessage(error)}`);
      }
    }

    const startkey = `${this.namespace}.${prefix}`;
    const { rows: states } = await this.getObjectViewAsync('system', 'state', {
      startkey,
      endkey: `${startkey.slice(0, -1)}/`,
    });
    for (const { id, value } of states) {
      if (
        id.startsWith(startkey) &&
        value.native.customRecipe === true &&
        !value.common.custom &&
        !value.common.dontDelete &&
        !this.customRecipes.has(id.slice(this.namespace.length + 1))
      ) {
        await this.delObjectAsync(id.slice(this.namespace.length + 1));
      }
    }

    if (this.customRecipes.size)
      await this.channel('products.custom', 'Custom drinks');
    for (const [id, { name }] of this.customRecipes) {
      await this.state(
        id,
        `Brew ${name}`,
        'boolean',
        'switch',
        { write: true, def: false },
        { customRecipe: true },
      );
    }
  }

  private async syncProductSwitch(id: string, product: Product) {
    const name = `Brew ${product.name}`;
    await this.state(id, name, 'boolean', 'switch', {
      write: true,
      def: false,
    });

    const legacyId = `products.catalog.${productId(product.code)}`;
    if (id !== legacyId) await this.removeLegacyState(legacyId, name, 'switch');
  }

  private async removeLegacyState(
    legacyId: string,
    name: string,
    role: string,
  ) {
    const legacy = await this.getObjectAsync(legacyId);
    // Preserve user-managed objects and history configuration at old IDs.
    if (
      legacy?.from === `system.adapter.${this.namespace}` &&
      legacy.type === 'state' &&
      legacy.common.name === name &&
      legacy.common.role === role &&
      !legacy.common.custom &&
      !legacy.common.dontDelete
    ) {
      await this.delObjectAsync(legacyId);
    }
  }

  private async verifyAuthentication() {
    if (!this.credentials) return;
    let accepted = false;
    try {
      await authenticated(this.machineHost, this.credentials, () => {}, {
        signal: this.lifecycle.signal,
        timeout: 2500,
      });
      accepted = true;
    } catch (error) {
      if (this.lifecycle.signal.aborted) return;
      this.log.debug(`Authentication check: ${errorMessage(error)}`);
    }
    if (this.lifecycle.signal.aborted) return;
    this.isAuthenticated = accepted;
    this.nextAuthentication =
      performance.now() + (accepted ? AUTH_RECHECK_MS : AUTH_RETRY_MS);
    await this.setStateChangedAsync('info.connection', accepted, true);
  }

  private recentBrew() {
    return performance.now() < (this.brewRequestedUntil ?? 0);
  }

  private async publish(values: Record<string, ioBroker.StateValue>) {
    await Promise.all(
      Object.entries(values).map(([id, value]) =>
        this.setStateChangedAsync(id, value, true),
      ),
    );
  }

  private async onMessage(request: ioBroker.Message) {
    if (
      !request?.callback ||
      !/^system\.adapter\.admin\.\d+$/.test(request.from)
    )
      return;
    if (request.command === 'customRecipeOptions') {
      this.sendTo(
        request.from,
        request.command,
        recipeOptions(
          this.switchCatalog?.products ?? [],
          request.message ?? {},
        ),
        request.callback,
      );
      return;
    }
    if (request.command !== 'pair') return;
    const callback = request.callback;
    const reply = (result: PairingResponse) =>
      this.sendTo(request.from, request.command, result, callback);
    const message: { host?: unknown; setupPin?: unknown } | null | undefined =
      request.message;
    const host = typeof message?.host === 'string' ? message.host.trim() : '';
    const enteredPin = message?.setupPin ?? '';
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/i.test(host)) {
      return reply({ error: 'Enter the machine IPv4 address or hostname.' });
    }
    if (
      typeof enteredPin !== 'string' ||
      !/^\d{0,16}$/.test(enteredPin.trim())
    ) {
      return reply({
        error:
          'Enter a numeric machine setup PIN or leave it blank if PIN protection is off.',
      });
    }
    const setupPin = enteredPin.trim();
    if (this.pairing || this.operation || this.lifecycle.signal.aborted) {
      return reply({ error: 'The adapter is busy. Try again shortly.' });
    }

    this.pairing = this.pairMachine(host, setupPin);
    try {
      const token = await this.pairing;
      reply({ result: 'paired', native: { host, setupPin, token } });
    } catch (error) {
      if (!this.lifecycle.signal.aborted) reply({ error: errorMessage(error) });
    } finally {
      this.pairing = undefined;
    }
  }

  private async pairMachine(host: string, setupPin: string) {
    // Fit within the 30-second callback limit of older Admin versions.
    const signal = AbortSignal.any([
      this.lifecycle.signal,
      AbortSignal.timeout(26000),
    ]);
    await this.authenticationCheck;
    const status = await pollStatus(host, { signal });
    if (status.productRunning || this.recentBrew()) {
      throw new Error('Wait until the machine is idle before pairing.');
    }
    try {
      return await pair(host, setupPin, { signal, timeout: 22000 });
    } catch (error) {
      if (signal.aborted || errorMessage(error) === 'TCP exchange timed out') {
        throw new Error(
          'Pairing timed out. Confirm the prompt on the machine after clicking Pair.',
        );
      }
      throw error;
    }
  }

  private onCommand(id: string, state: ioBroker.State | null | undefined) {
    const prefix = `${this.namespace}.`;
    if (
      this.lifecycle.signal.aborted ||
      !id.startsWith(prefix) ||
      !state ||
      state.ack
    )
      return;

    const relativeId = id.slice(prefix.length);
    const product = this.productSwitches?.get(relativeId);
    const brewSwitch = product
      ? { product }
      : this.customRecipes.get(relativeId);
    if (!brewSwitch && !relativeId.startsWith('commands.')) return;
    const command = brewSwitch ? 'brew' : relativeId.slice('commands.'.length);
    if (!isCommand(command)) return;
    if (
      brewSwitch || command !== 'brew' ? state.val !== true : state.val === ''
    )
      return;

    const resetCommand = () =>
      this.setStateAsync(`commands.${command}`, commands[command][3], true);
    if (this.operation || this.pairing) {
      this.log.warn(
        `Ignored ${relativeId} while another request is in progress`,
      );
      if (!brewSwitch)
        resetCommand().catch(error => this.log.error(errorMessage(error)));
      return;
    }

    this.startOperation(async () => {
      try {
        const success = await this.runCommand(command, state.val, brewSwitch);
        if (success && brewSwitch && !this.lifecycle.signal.aborted) {
          const current = await this.getStateAsync(relativeId);
          if (
            current?.val === true &&
            !current.ack &&
            current.ts === state.ts &&
            current.from === state.from
          ) {
            await this.setStateAsync(relativeId, false, true);
          }
        }
      } finally {
        if (!brewSwitch && !this.lifecycle.signal.aborted) await resetCommand();
      }
    });
  }

  private startOperation(action: () => Promise<unknown>) {
    this.operation = action()
      .catch(error => this.log.error(errorMessage(error)))
      .finally(() => {
        this.operation = undefined;
      });
  }

  private async runCommand(
    command: Command,
    value?: ioBroker.StateValue,
    brewSwitch?: BrewSwitch,
  ): Promise<boolean> {
    const options = { signal: this.lifecycle.signal };
    try {
      if (!this.credentials)
        throw new Error('Pair the machine in the adapter settings');
      await this.authenticationCheck;
      const status = await pollStatus(this.machineHost, options);
      const catalog = catalogFor(status.model);
      if (!catalog) throw new Error(`No product catalog for ${status.model}`);
      const recentBrew = this.recentBrew();
      let result;
      if (command === 'brew') {
        if (!status.alertBits?.includes(13) || recentBrew)
          throw new Error('Machine is not ready to brew');
        const switchProduct =
          brewSwitch && 'product' in brewSwitch
            ? brewSwitch.product
            : undefined;
        if (switchProduct && !catalog.products.includes(switchProduct)) {
          throw new Error(
            'The machine model changed. Use a brew switch from the current product catalog',
          );
        }
        const custom =
          brewSwitch && 'request' in brewSwitch ? brewSwitch : undefined;
        const request =
          custom?.request ??
          (switchProduct ? {} : parseBrewRequest(String(value)));
        const { productCode, ...overrides } = request;
        const product =
          switchProduct ??
          catalog.products.find(entry => entry.code === productCode);
        if (!product)
          throw new Error('Use a productCode from products.catalog');
        const payload = brewPayload(product, overrides);
        await authenticated(
          this.machineHost,
          this.credentials,
          async ({ request }) => {
            this.brewRequestedUntil = performance.now() + 3000;
            const reply = await request(
              `@TP:${payload}`,
              /^@(?:tp|an)(?::.*)?$/i,
            );
            if (!/^@tp$/i.test(reply)) {
              throw new Error('Machine rejected the brew request');
            }
          },
          options,
        );
        result = `Machine accepted brew request for ${custom?.name ?? product.name}`;
      } else if (command === 'stop') {
        if (!status.productRunning && !recentBrew)
          throw new Error('No product is running');
        await authenticated(
          this.machineHost,
          this.credentials,
          ({ send }) => send('@TG:FF'),
          options,
        );
        result = 'Sent stop request';
      } else {
        if (status.productRunning || recentBrew)
          throw new Error('Wait until the machine is idle');
        const stats = await authenticated(
          this.machineHost,
          this.credentials,
          connection => readStatistics(connection, catalog),
          options,
        );
        await this.publishStatistics(stats, catalog);
        result = 'Statistics refreshed';
      }
      await this.setStateAsync('info.commandResult', result, true);
      return true;
    } catch (error) {
      if (this.lifecycle.signal.aborted) return false;
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'JURA_AUTH_REJECTED'
      ) {
        this.isAuthenticated = false;
        this.nextAuthentication = performance.now() + AUTH_RETRY_MS;
        await this.setStateChangedAsync('info.connection', false, true);
      }
      const message = `${command}: ${errorMessage(error)}`;
      this.log.warn(message);
      await this.setStateAsync('info.commandResult', message, true);
      return false;
    }
  }

  private async publishStatistics(stats: Statistics, catalog: MachineCatalog) {
    await this.channel('products.counts', 'Product counters');
    await this.channel('maintenance.percent', 'Maintenance progress');
    await this.channel('maintenance.cycles', 'Maintenance cycle counters');
    const values: Record<string, ioBroker.StateValue> = {};
    const products = productCounters(catalog);
    const countStates = this.productStates('counts', products);
    const counts = new Map(stats.products);
    for (const [id, product] of countStates) {
      await this.state(id, product.name, 'number', 'value');
      values[id] = counts.get(product.code) ?? null;
    }
    for (const [kind, names, counters, unit] of [
      ['percent', catalog.maintenanceStatusFields, stats.maintenance, '%'],
      ['cycles', catalog.maintenanceCounterFields, stats.cycles, undefined],
    ] as const) {
      for (const [index, name] of names.entries()) {
        const id = `maintenance.${kind}.${name.toLowerCase().replaceAll(' ', '_')}`;
        await this.state(id, name, 'number', 'value', unit ? { unit } : {});
        values[id] = counters[index];
      }
    }
    await this.publish(values);

    if (this.countCatalog !== catalog) {
      for (const [code] of stats.products) {
        const legacyId = `products.counts.${productId(code)}`;
        const product = products.find(entry => entry.code === code);
        if (product && !countStates.has(legacyId)) {
          await this.removeLegacyState(legacyId, product.name, 'value');
        }
      }
      this.countCatalog = catalog;
    }
  }
}

function createAdapter(options?: JuraAdapterOptions): JuraAdapter {
  return new JuraAdapter(options);
}

if (require.main === module) createAdapter();

export = createAdapter;
