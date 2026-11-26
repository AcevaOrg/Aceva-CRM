import { Injectable } from '@nestjs/common';
import { RealtimeBus } from '../redis/realtime-bus.service';

/** Relay topic: these people's access may have changed (payload: Emp-IDs only). */
export const ACCESS_CHANGED_TOPIC = 'access-changed';

/**
 * Tells every server, right after the change is committed, that some people's access may have changed: a department
 * move, a new department head, a level or role change, a duty given or ended. Live connections (Module 14, part 2) then
 * re-check those people at once: their permission to use messaging and the conversations they may see.
 *
 * It only speeds things up. Every live delivery is authorised from the database anyway, and every server re-checks its
 * sockets every minute, so a change made some other way (a script) is still caught. Never throws.
 */
@Injectable()
export class AccessChangeNotifier {
  constructor(private readonly bus: RealtimeBus) {}

  async changed(empIds: Array<string | null | undefined>): Promise<void> {
    const list = [...new Set(empIds.filter((e): e is string => !!e))];
    if (list.length) await this.bus.publish(ACCESS_CHANGED_TOPIC, { empIds: list });
  }
}
