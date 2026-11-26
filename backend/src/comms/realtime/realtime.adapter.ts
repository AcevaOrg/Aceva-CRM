import type { IncomingMessage } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { REALTIME_PATH, SOCKET_MAX_PACKET_BYTES } from '@aceva/contracts';
import type { Server, ServerOptions } from 'socket.io';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env';
import { originAllowed } from './socket-rules';

/**
 * The Socket.IO server for Module 14 (part 2), with the security settings fixed here whatever a gateway asks for:
 *  - WebSocket only (decision D7): no long-polling, so no sticky sessions behind a load balancer and no HTTP fallback;
 *  - the Origin header must be the Aceva website, checked before the upgrade (CORS does not protect WebSockets);
 *  - small packets only (the browser sends little more than acknowledgements);
 *  - no built-in "connection state recovery": missed events are recovered from the database by sequence number.
 * The session itself is checked by CommsGateway when the socket connects.
 */
export class RealtimeAdapter extends IoAdapter {
  private readonly env: Env;

  constructor(app: INestApplication) {
    super(app);
    this.env = app.get<Env>(ENV);
  }

  createIOServer(port: number, options?: Partial<ServerOptions>): Server {
    const allowed = this.env.CORS_ORIGIN;
    const fixed: Partial<ServerOptions> = {
      ...options,
      path: REALTIME_PATH,
      serveClient: false,
      transports: ['websocket'],
      allowUpgrades: false,
      maxHttpBufferSize: SOCKET_MAX_PACKET_BYTES,
      pingInterval: 25_000,
      pingTimeout: 20_000,
      connectTimeout: 10_000,
      perMessageDeflate: false,
      httpCompression: false,
      cors: undefined,
      allowRequest: (req: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
        callback(null, originAllowed(req.headers.origin, allowed));
      },
    };
    delete (fixed as { connectionStateRecovery?: unknown }).connectionStateRecovery;
    return super.createIOServer(port, fixed) as Server;
  }
}
