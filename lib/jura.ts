// Protocol port from kykc/juras (MIT), see README.md.
import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import path from 'node:path';

interface ProductRange {
  default: number;
  min: number;
  max: number;
  step: number;
}

type ProductField = keyof typeof brewFields;
type Temperature = keyof typeof temperatures;

export interface Product extends Partial<Record<ProductField, ProductRange>> {
  code: number;
  name: string;
  kind: 'COFFEE' | 'MILK' | 'COFFEE_MILK' | 'WATER';
  defaultTemperature?: Temperature;
  preselections?: Record<string, true | number>;
  additionalSettings?: Record<
    string,
    { argument: string } & (
      | { range: ProductRange }
      | { default: string; options: Record<string, string> }
    )
  >;
}

export interface MachineCatalog {
  modelId: string;
  products: Product[];
  intakeF18?: boolean;
  preselectionCombinations?: string[][];
  extraProductCounters?: ProductCounter[];
  alertBits: Record<number, string | undefined>;
  brewStateNames: Record<string, string | undefined>;
  dispensingStates: string[];
  maintenanceStatusFields: string[];
  maintenanceCounterFields: string[];
}

interface ProductCounter {
  code: number;
  name: string;
  slot?: number;
}

interface BrewProgress {
  code: number;
  phase: string;
  dispensedMl: number | null;
  targetMl: number | null;
  percent: number | null;
}

export interface MachineStatus {
  module: string;
  name: string;
  model: string;
  articleNumber: number;
  productRunning: boolean;
  payload: string;
  alertBits: number[] | null;
  progress: BrewProgress | null;
}

interface ConnectionOptions {
  port?: number;
  timeout?: number;
  signal?: AbortSignal;
}

interface Connection {
  send(command: string): Promise<void>;
  request(command: string, matches: RegExp): Promise<string>;
}

export interface Credentials {
  pin: string;
  token: string;
}

export interface Statistics {
  products: [code: number, count: number | null][];
  maintenance: (number | null)[];
  cycles: (number | null)[];
}

const PORT = 51515;
const SPECIAL = new Set([0, 0x0a, 0x0d, 0x26, 0x1b]);
const END = Buffer.from('\r\n');
const LUT_A = [1, 0, 3, 2, 15, 14, 8, 10, 6, 13, 7, 12, 11, 9, 5, 4];
const LUT_B = [9, 12, 6, 11, 10, 15, 2, 14, 13, 0, 4, 3, 1, 8, 7, 5];
const temperatures = { LOW: 0, NORMAL: 1, HIGH: 2 };
interface BrewField {
  offset: number;
  scale?: number;
  shift?: number;
  overrideOnly?: boolean;
}

export const brewFields = {
  grindLevel: { offset: 1, shift: 4, overrideOnly: true },
  strength: { offset: 2 },
  water: { offset: 3, scale: 5 },
  milkAmount: { offset: 4 },
  milk: { offset: 5 },
  strokes: { offset: 7, overrideOnly: true },
  bypass: { offset: 9, scale: 5 },
  milkPause: { offset: 10, overrideOnly: true },
  milkFoamTemperature: { offset: 13, shift: 4, overrideOnly: true },
  milkTemperature: { offset: 13, overrideOnly: true },
} as const satisfies Record<string, BrewField>;

interface Preselection {
  label: string;
  mask?: number;
  legacy?: { offset: number; value: number; conflicts?: string };
}

const preselections = {
  powder: {
    label: 'Ground coffee',
    mask: 0x01,
    legacy: { offset: 2, value: 0, conflicts: 'strength' },
  },
  xtrashot: {
    label: 'Extra shot',
    mask: 0x02,
    legacy: { offset: 7, value: 2, conflicts: 'strokes' },
  },
  sweetfoam: { label: 'Sweet foam', mask: 0x04 },
  lightbrew: {
    label: 'Light brew',
    mask: 0x08,
    legacy: { offset: 6, value: 0x81, conflicts: 'temperature' },
  },
  coldbrew: {
    label: 'Cold brew',
    mask: 0x10,
    legacy: { offset: 6, value: 0x80, conflicts: 'temperature' },
  },
  double: { label: 'Double', mask: 0x40, legacy: { offset: 0, value: 0 } },
  strongcoldbrew: { label: 'Strong cold brew', mask: 0x80 },
} as const satisfies Record<string, Preselection>;

type PreselectionName = keyof typeof preselections;
type GrinderField = 'grinderRatio' | 'grindLevel';

function availablePreselections(product: Product, machine: MachineCatalog) {
  return (Object.keys(preselections) as PreselectionName[]).filter(name => {
    const setting: Preselection = preselections[name];
    return (
      product.preselections?.[name] &&
      (machine.intakeF18 ? setting.mask : setting.legacy)
    );
  });
}

export function preselectionOptions(product: Product, machine: MachineCatalog) {
  const names = availablePreselections(product, machine);
  const groups = new Set(names.map(String));
  for (const row of machine.preselectionCombinations ?? []) {
    let subsets: PreselectionName[][] = [[]];
    for (const name of names.filter(name => row.includes(name))) {
      subsets = [...subsets, ...subsets.map(subset => [...subset, name])];
    }
    for (const subset of subsets) {
      if (subset.length > 1) groups.add(subset.join('+'));
    }
  }
  return [...groups].map(value => ({
    value,
    label: value
      .split('+')
      .map(name => preselections[name as PreselectionName].label)
      .join(' + '),
  }));
}

export function grinderOptions(product: Product, field: GrinderField) {
  const ratio = field === 'grinderRatio';
  const setting =
    product.additionalSettings?.[ratio ? 'GRINDER_RATIO' : 'GRINDER_FREENESS'];
  if (setting?.argument !== (ratio ? 'F2' : 'F17') || !('options' in setting))
    return [];
  return Object.entries(setting.options).map(([hex, name]) => {
    const wireValue = Number.parseInt(hex, 16);
    return {
      value: ratio ? wireValue : Number(name),
      label: ratio ? name.replace('_', ' / ') : name,
      wireValue,
      default: hex === setting.default,
    };
  });
}

function requestedPreselections(
  product: Product,
  machine: MachineCatalog | undefined,
  requested: unknown,
): PreselectionName[] {
  if (requested === undefined) return [];
  if (
    !Array.isArray(requested) ||
    requested.some(name => typeof name !== 'string')
  ) {
    throw new Error('preselections must be an array of names');
  }
  const names = [...new Set<string>(requested)] as PreselectionName[];
  if (!names.length) return [];
  const available = machine ? availablePreselections(product, machine) : [];
  for (const name of names) {
    if (!available.includes(name))
      throw new Error(`Unsupported preselection ${name} for ${product.name}`);
  }
  if (
    names.length > 1 &&
    !machine?.preselectionCombinations?.some(row =>
      names.every(name => row.includes(name)),
    )
  ) {
    throw new Error(`Invalid preselection combination for ${product.name}`);
  }
  return names;
}

const catalogDirectory = path.join(__dirname, '..', '..', 'lib', 'catalogs');
const catalogIds = new Set(
  readdirSync(catalogDirectory)
    .filter(file => file.endsWith('.json'))
    .map(file => path.basename(file, '.json')),
);

function transform(key: number, data: Buffer): Buffer {
  const high = key >> 4;
  const low = key & 15;
  function nibble(value: number, counter: number): number {
    const block = counter >> 4;
    const a = LUT_A[(value + counter + high) & 15];
    const b = LUT_B[(block + a + low - counter - high) & 15];
    return (
      (LUT_A[(b + high + counter - low - block) & 15] - counter - high) & 15
    );
  }

  const result = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index++) {
    const byte = data[index];
    result[index] =
      (nibble(byte >> 4, index * 2) << 4) | nibble(byte & 15, index * 2 + 1);
  }
  return result;
}

export function encodeFrame(
  command: string,
  key = (randomInt(16) << 4) | randomInt(14),
): Buffer {
  const bytes = [0x2a];
  for (const byte of [
    key,
    ...transform(key, Buffer.from(command + '\r\n', 'ascii')),
  ]) {
    if (SPECIAL.has(byte)) bytes.push(0x1b, byte ^ 0x80);
    else bytes.push(byte);
  }
  return Buffer.from([...bytes, ...END]);
}

export function decodeFrame(frame: Buffer): string | null {
  if (frame[0] !== 0x2a || !frame.subarray(-2).equals(END)) return null;
  const bytes = [];
  const end = frame.length - 2;
  for (let i = 1; i < end; i++) {
    const byte = frame[i];
    if (byte === 0x1b) {
      // The Z10 also escapes bytes outside the transmit escape set.
      if (++i >= end) return null;
      bytes.push(frame[i] ^ 0x80);
    } else {
      if (SPECIAL.has(byte)) return null;
      bytes.push(byte);
    }
  }
  if (bytes.length < 3) return null;
  const data = transform(bytes[0], Buffer.from(bytes.slice(1)));
  if (!data.subarray(-2).equals(END)) return null;
  return data.subarray(0, -2).toString('ascii');
}

export function catalogFor(model: string): MachineCatalog | null {
  const modelCode = model.trim().split(/\s+/, 1)[0].toUpperCase();
  // Model strings can have an M before the firmware version (e.g. EF545M V02.01).
  const id = catalogIds.has(modelCode)
    ? modelCode
    : modelCode.replace(/M$/, '');
  return catalogIds.has(id)
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load and cache the selected catalog synchronously.
    ? (require(path.join(catalogDirectory, id + '.json')) as MachineCatalog)
    : null;
}

export function decodeStatus(packet: Buffer): MachineStatus | null {
  if (
    packet.length < 110 ||
    packet.readUInt16BE(0) !== packet.length ||
    (packet.readUInt16BE(2) & 0xcfff) !== 0x85f3
  )
    return null;
  const text = (start: number, end: number) =>
    packet.toString('latin1', start, end).replace(/\0.*$/s, '').trim();
  const model = text(52, 68);
  const productRunning = (packet[109] & 1) === 0;
  const payload = packet.subarray(110);
  if (payload.length < (productRunning ? 16 : 7)) return null;

  const status: MachineStatus = {
    module: text(4, 20),
    name: text(20, 52),
    model,
    articleNumber: packet.readUInt16BE(68),
    productRunning,
    payload: payload.toString('hex').toUpperCase(),
    alertBits: null,
    progress: null,
  };
  if (productRunning) {
    const code = payload[0];
    const machine = catalogFor(model);
    const dispensing = machine?.dispensingStates.some(
      state => Number(state) === code,
    );
    status.progress = {
      code,
      phase: dispensing
        ? 'Dispensing'
        : (machine?.brewStateNames[
            '0x' + code.toString(16).padStart(2, '0').toUpperCase()
          ] ?? 'Unknown'),
      dispensedMl: dispensing ? payload[4] * 5 : null,
      targetMl: dispensing ? payload[5] * 5 : null,
      percent: dispensing ? Math.min(payload[14], 100) : null,
    };
  } else {
    status.alertBits = Array.from({ length: 56 }, (_, bit) => bit).filter(
      bit => payload[bit >> 3] & (0x80 >> (bit & 7)),
    );
  }
  return status;
}

export function pollStatus(
  host: string,
  options: ConnectionOptions = {},
): Promise<MachineStatus> {
  const { port = PORT, timeout = 2500, signal } = options;
  const deadline = AbortSignal.timeout(timeout);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise((resolve, reject) => {
    requestSignal.throwIfAborted();
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const aborted = () => finish(new Error('No UDP status reply from machine'));
    function finish(result: Error | MachineStatus) {
      if (settled) return;
      settled = true;
      requestSignal.removeEventListener('abort', aborted);
      socket.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }
    requestSignal.addEventListener('abort', aborted, { once: true });
    socket.once('error', finish);
    socket.on('message', packet => {
      const status = decodeStatus(packet);
      if (status) finish(status);
    });
    socket.connect(port, host, (error?: Error) => {
      if (settled) return;
      if (error) return finish(error);
      const packet = Buffer.alloc(16);
      packet.writeUInt32BE(0x0010a5f3);
      socket
        .remoteAddress()
        .address.split('.')
        .forEach((octet, index) => {
          packet[index + 4] = Number(octet);
        });
      socket.send(packet);
    });
  });
}

async function* readFrames(socket: Socket): AsyncGenerator<string, void> {
  let pending = Buffer.alloc(0);
  for await (const chunk of socket as AsyncIterable<Buffer>) {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(END)) !== -1) {
      const frame = decodeFrame(pending.subarray(0, end + END.length));
      pending = pending.subarray(end + END.length);
      if (frame) yield frame;
    }
    if (pending.length > 4096) throw new Error('Oversized TCP frame');
  }
}

async function withConnection<T>(
  host: string,
  action: (connection: Connection) => T | Promise<T>,
  { port = PORT, timeout = 8000, signal }: ConnectionOptions = {},
): Promise<T> {
  const deadline = AbortSignal.timeout(timeout);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  signal.throwIfAborted();
  const socket = net.createConnection({ host, port, family: 4, signal });
  socket.on('error', () => {}); // Connect, stream and write awaiters handle socket errors.
  try {
    await once(socket, 'connect', { signal });
    socket.setNoDelay(true);
    const frames = readFrames(socket);
    const send = (command: string) =>
      new Promise<void>((resolve, reject) => {
        socket.write(encodeFrame(command), error =>
          error ? reject(error) : resolve(),
        );
      });
    const request = async (command: string, matches: RegExp) => {
      await send(command);
      for (let count = 0; count < 24; count++) {
        const frame = await frames.next();
        if (frame.done) break;
        if (matches.test(frame.value)) return frame.value;
      }
      throw new Error('No matching TCP reply from machine');
    };
    return await action({ send, request });
  } catch (error) {
    if (deadline.aborted) throw new Error('TCP exchange timed out');
    throw error;
  } finally {
    socket.end();
    socket.destroySoon();
  }
}

function authCommand(pin = '', token = '') {
  if (!/^\d{0,16}$/.test(pin) || (token && !/^[\da-f]{64}$/i.test(token))) {
    throw new Error('Invalid setup PIN or pairing token');
  }
  const label = Buffer.from('ioBroker', 'ascii').toString('hex').toUpperCase();
  return `@HP:${pin},${label},${token}`;
}

export async function pair(
  host: string,
  pin: string,
  options: ConnectionOptions = {},
): Promise<string> {
  return withConnection(
    host,
    async ({ request }) => {
      const reply = await request(authCommand(pin), /^@hp/i);
      const token = /^@hp4:([\da-f]{64})$/i.exec(reply)?.[1];
      if (!token) {
        throw new Error(
          'Machine did not issue a pairing token. Check the display and enter the setup PIN if PIN protection is on.',
        );
      }
      return token;
    },
    { timeout: 90000, ...options },
  );
}

export function authenticated<T>(
  host: string,
  { pin, token }: Credentials,
  action: (connection: Connection) => T | Promise<T>,
  options?: ConnectionOptions,
): Promise<T> {
  if (!token) throw new Error('Configure a pairing token first');
  return withConnection(
    host,
    async connection => {
      const reply = await connection.request(authCommand(pin, token), /^@hp/i);
      if (!/^@hp4$/i.test(reply)) {
        throw Object.assign(
          new Error('Machine rejected the setup PIN or pairing token'),
          {
            code: 'JURA_AUTH_REJECTED',
          },
        );
      }
      return action(connection);
    },
    options,
  );
}

export function brewPayload(
  product: Product,
  {
    preselections: requested,
    grinderRatio,
    ...overrides
  }: Readonly<Record<string, unknown>> = {},
  machine?: MachineCatalog,
): string {
  if (Object.hasOwn(overrides, 'milkFoam')) {
    if (Object.hasOwn(overrides, 'milk')) {
      throw new Error('Use only one of milkFoam and milk');
    }
    const { milkFoam, ...otherOverrides } = overrides;
    overrides = { ...otherOverrides, milk: milkFoam };
  }
  for (const field of Object.keys(overrides)) {
    if (field !== 'temperature' && !Object.hasOwn(brewFields, field)) {
      throw new Error(`Unknown brew parameter: ${field}`);
    }
  }

  const selected = requestedPreselections(product, machine, requested);
  const masked = machine?.intakeF18 && selected.length > 0;
  const extendedGrind = grinderOptions(product, 'grindLevel');
  const useF17 =
    extendedGrind.length > 0 &&
    (Object.hasOwn(overrides, 'grindLevel') || selected.length > 0);
  const bytes = Buffer.alloc(masked ? 20 : useF17 ? 17 : 16);
  bytes[0] = product.code;
  bytes[8] = 1;
  for (const field of Object.keys(brewFields) as ProductField[]) {
    if (field === 'grindLevel' && useF17) continue;
    const {
      offset,
      scale = 1,
      shift = 0,
      overrideOnly,
    }: BrewField = brewFields[field];
    const range = product[field];
    const value = Object.hasOwn(overrides, field)
      ? overrides[field]
      : overrideOnly
        ? undefined
        : range?.default;
    if (value === undefined) continue;
    if (
      !range ||
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < range.min ||
      value > range.max ||
      (value - range.min) % range.step !== 0 ||
      value % scale !== 0
    ) {
      throw new Error(`Invalid ${field} for ${product.name}`);
    }
    bytes[offset] |= (value / scale) << shift;
  }

  const temperature = Object.hasOwn(overrides, 'temperature')
    ? overrides.temperature
    : product.defaultTemperature;
  if (temperature !== undefined) {
    if (
      !product.defaultTemperature ||
      typeof temperature !== 'string' ||
      !Object.hasOwn(temperatures, temperature)
    ) {
      throw new Error(`Invalid temperature for ${product.name}`);
    }
    bytes[6] = temperatures[temperature as Temperature];
  }
  if (grinderRatio !== undefined) {
    const option = grinderOptions(product, 'grinderRatio').find(
      option => option.value === grinderRatio,
    );
    if (!option) throw new Error(`Invalid grinderRatio for ${product.name}`);
    bytes[1] |= option.wireValue;
  }
  if (useF17) {
    const option = extendedGrind.find(option =>
      Object.hasOwn(overrides, 'grindLevel')
        ? option.value === overrides.grindLevel
        : option.default,
    );
    if (!option) throw new Error(`Invalid grindLevel for ${product.name}`);
    bytes[16] = option.wireValue;
  }
  for (const name of selected) {
    const selection: Preselection = preselections[name];
    if (masked) {
      bytes[19] |= selection.mask!;
    } else if (selection.legacy) {
      const { offset, value, conflicts } = selection.legacy;
      if (conflicts && Object.hasOwn(overrides, conflicts)) {
        throw new Error(`${name} conflicts with ${conflicts} for ${product.name}`);
      }
      bytes[offset] = name === 'double' ? Number(product.preselections?.double) : value;
    }
  }
  return bytes.toString('hex').toUpperCase();
}

export function productCounters(machine: MachineCatalog): ProductCounter[] {
  return [
    { code: 0, name: 'Total' },
    ...machine.products,
    ...(machine.extraProductCounters ?? []),
  ];
}

export async function readStatistics(
  connection: Pick<Connection, 'request'>,
  machine: MachineCatalog,
): Promise<Statistics> {
  const pages = new Map<number, Buffer>();
  async function readCount(slot: number) {
    const page = slot >> 2;
    let bytes = pages.get(page);
    if (!bytes) {
      const hex = page.toString(16).padStart(2, '0').toUpperCase();
      const reply = await connection.request(
        `@TR:32,${hex}`,
        new RegExp(`^@tr:32,${hex},[\\da-f]{16}$`, 'i'),
      );
      bytes = Buffer.from(reply.split(',')[2], 'hex');
      pages.set(page, bytes);
    }
    const count = bytes.readUInt16BE((slot & 3) * 2);
    return count === 0xffff ? null : count;
  }

  const products: Statistics['products'] = [];
  for (const { code, slot = code } of productCounters(machine)) {
    let count = await readCount(slot);
    if (count === null && slot !== code) count = await readCount(code);
    products.push([code, count]);
  }

  const status = await connection.request(
    '@TG:C0',
    /^@tg:c0(?:[\da-f]{2}){2,3}$/i,
  );
  const counters = await connection.request(
    '@TG:43',
    /^@tg:43(?:[\da-f]{4}){4,6}$/i,
  );
  const service = Buffer.from(status.slice(6), 'hex');
  const cycles = Buffer.from(counters.slice(6), 'hex');
  return {
    products,
    maintenance: machine.maintenanceStatusFields.map((_, index) => {
      const value = service[index];
      return value === 0xff ? null : (value ?? null);
    }),
    cycles: machine.maintenanceCounterFields.map((_, index) =>
      index < cycles.length / 2 ? cycles.readUInt16BE(index * 2) : null,
    ),
  };
}
