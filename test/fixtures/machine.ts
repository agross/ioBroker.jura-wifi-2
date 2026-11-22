import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import net, { type Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { decodeFrame, encodeFrame } from '../../lib/jura';

export const token = 'a'.repeat(64);
const clientId = '696F42726F6B6572';

export class SimulatedMachine {
  model = 'EF545M V02.01';
  online = true;
  acceptsToken = true;
  brewReply: string | null = '@tp';
  ready = true;
  brewing = false;
  phaseCode = 0;
  idleAlertBits: number[] = [];
  polls = 0;
  readonly requests: string[] = [];
  private waiting?: (socket: Socket) => void;
  private waitingForBrew?: (socket: Socket) => void;
  private readonly clients = new Set<Socket>();
  private readonly udp = dgram.createSocket('udp4');
  private readonly tcp = net.createServer(socket => this.readCommands(socket));

  get udpPort() {
    return this.udp.address().port;
  }

  get tcpPort() {
    const address = this.tcp.address();
    assert(address && typeof address === 'object');
    return address.port;
  }

  get brewRequests() {
    return this.requests.filter(command => command.startsWith('@TP:'));
  }

  get statisticsReads() {
    return this.requests.filter(command => command === '@TG:43').length;
  }

  async start(t: TestContext) {
    t.after(async () => {
      for (const client of this.clients) client.destroy();
      const closeTcp = new Promise<void>(resolve =>
        this.tcp.close(() => resolve()),
      );
      this.udp.close();
      await closeTcp;
    });
    this.udp.on('message', (_request, remote) => {
      this.polls++;
      if (!this.online) return;
      const reply = Buffer.alloc(this.brewing ? 126 : 117);
      reply.writeUInt16BE(reply.length);
      reply.writeUInt16BE(0xa5f3, 2);
      reply.write(this.model, 52, 16, 'ascii');
      reply[109] = this.brewing ? 0 : 1;
      if (this.brewing) reply[110] = this.phaseCode;
      if (this.ready && !this.brewing) reply[111] = 4;
      if (!this.brewing) {
        for (const bit of this.idleAlertBits) {
          reply[110 + (bit >> 3)] |= 0x80 >> (bit & 7);
        }
      }
      this.udp.send(reply, remote.port, remote.address);
    });
    this.udp.bind(0, '127.0.0.1');
    this.tcp.listen(0, '127.0.0.1');
    await Promise.all([
      once(this.udp, 'listening'),
      once(this.tcp, 'listening'),
    ]);
  }

  holdNextAuthentication() {
    assert.equal(this.waiting, undefined);
    const promise = new Promise<Socket>(resolve => {
      this.waiting = resolve;
    });
    return {
      arrived: promise,
      async release() {
        (await promise).write(encodeFrame('@hp4'));
      },
    };
  }

  holdNextBrewReply() {
    assert.equal(this.waitingForBrew, undefined);
    const arrived = new Promise<Socket>(resolve => {
      this.waitingForBrew = resolve;
    });
    return {
      arrived,
      async release(reply: string) {
        (await arrived).write(encodeFrame(reply));
      },
    };
  }

  private readCommands(socket: Socket) {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    let bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      let end;
      while ((end = bytes.indexOf('\r\n')) !== -1) {
        const command = decodeFrame(bytes.subarray(0, end + 2));
        bytes = bytes.subarray(end + 2);
        assert(command);
        this.requests.push(command);
        const reply = this.reply(command, socket);
        if (reply) socket.write(encodeFrame(reply));
      }
    });
  }

  private reply(command: string, socket: Socket) {
    if (command === `@HP:,${clientId},`) return '@hp4:' + token;
    if (command === `@HP:,${clientId},${token}`) {
      if (this.waiting) {
        const hold = this.waiting;
        this.waiting = undefined;
        hold(socket);
        return;
      }
      return this.acceptsToken ? '@hp4' : '@hp5:01';
    }
    if (command === '@TR:32,04') return '@tr:32,04,FFFFFFFF00020003';
    if (command.startsWith('@TR:32,'))
      return command.toLowerCase() + ',000CFFFF00050007';
    if (command === '@TG:C0') return '@tg:C00A50FF';
    if (command === '@TG:43') return '@tg:43000100020003000400050006';
    if (command.startsWith('@TP:')) {
      if (this.waitingForBrew) {
        const hold = this.waitingForBrew;
        this.waitingForBrew = undefined;
        hold(socket);
        return;
      }
      if (this.brewReply === null) socket.end();
      return this.brewReply;
    }
  }
}
