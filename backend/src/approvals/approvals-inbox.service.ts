import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ApprovalItemView, ApprovalTypeName, ApprovalsListResponse, DecideApprovalRequest } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';

/**
 * A module that has things for someone to decide plugs into the approvals inbox with one of these (Module 5 tasks:
 * "task_review" and "extension"; later leave, payroll, finance...). The inbox shows every module's items in one list
 * (frontend/src/features/approvals); a decision is handed back to the provider that owns the item type.
 *
 * Register in onModuleInit:  this.inbox.register(this)   (ApprovalsInbox is exported by OrgModule).
 */
export interface ApprovalProvider {
  /** For logs and tests, for example "tasks". */
  readonly key: string;
  /** The item types this provider owns (ApprovalItemView.type); a decision for one of them is sent to it. */
  readonly types: readonly ApprovalTypeName[];
  /** Items waiting for THIS person to decide (never ones they asked for themselves; the inbox filters those out too). */
  list(actor: Actor): Promise<ApprovalItemView[]>;
  /**
   * Items waiting for the people BELOW the actor, read only (the CEO / Founder / Owner watches the whole company).
   * Each item carries `waitingFor` (the Emp-ID who must decide). Omit when the module has nothing to show.
   */
  oversight?(actor: Actor): Promise<ApprovalItemView[]>;
  /** How many requests the actor made that were routed to someone else (maker-checker). */
  routedUp?(actor: Actor): Promise<number>;
  /**
   * Decides one item. MUST re-check that the actor really is the person who may decide it (the inbox only found the
   * provider), apply the module's own rules, and throw a Nest HTTP exception when it is not allowed.
   */
  decide(
    actor: Actor,
    item: { type: ApprovalTypeName; refId: string },
    decision: 'approve' | 'reject',
    input: DecideApprovalRequest,
    client: RequestInfo,
  ): Promise<void>;
}

/** The permission that lets someone see what is waiting for others (the CEO / Founder / Owner, Director and CTO). */
const OVERSIGHT_PERMISSION = 'activity.view_all';

/** The one approvals inbox: a registry of providers (one per module) behind GET /approvals and POST /approvals/:id/{approve|reject}. */
@Injectable()
export class ApprovalsInbox {
  private readonly logger = new Logger('ApprovalsInbox');
  private readonly providers: ApprovalProvider[] = [];

  constructor(private readonly permissions: PermissionService) {}

  register(provider: ApprovalProvider): void {
    if (this.providers.some((p) => p.key === provider.key)) throw new Error(`Approval provider "${provider.key}" is registered twice`);
    for (const type of provider.types) {
      if (this.providers.some((p) => p.types.includes(type))) throw new Error(`Approval type "${type}" already has a provider`);
    }
    this.providers.push(provider);
  }

  /** What is waiting for this person, oldest first, plus how many of their own requests were routed to someone else. */
  async list(actor: Actor): Promise<ApprovalsListResponse> {
    const items: ApprovalItemView[] = [];
    let routedUp = 0;
    for (const p of this.providers) {
      try {
        items.push(...(await p.list(actor)).filter((i) => i.requester !== actor.empId));
        routedUp += (await p.routedUp?.(actor)) ?? 0;
      } catch (error) {
        // One module's problem must not empty the whole inbox.
        this.logger.error(`Approvals of "${p.key}" could not be listed: ${(error as Error).message}`);
      }
    }
    return { items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), routedUp };
  }

  /** Everything waiting for people below the viewer (read only). Empty unless the viewer may see all activity. */
  async oversight(actor: Actor): Promise<ApprovalItemView[]> {
    if (!(await this.permissions.can(actor.id, OVERSIGHT_PERMISSION))) return [];
    const out: ApprovalItemView[] = [];
    const seen = new Set<string>();
    for (const p of this.providers) {
      if (!p.oversight) continue;
      try {
        for (const item of await p.oversight(actor)) {
          if (item.requester === actor.empId || seen.has(item.id)) continue;
          seen.add(item.id);
          out.push(item);
        }
      } catch (error) {
        this.logger.error(`Oversight of "${p.key}" could not be listed: ${(error as Error).message}`);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** `itemId` is "<type>:<ref id>", for example "task_review:<task id>". Nobody decides their own request. */
  async decide(actor: Actor, itemId: string, decision: 'approve' | 'reject', input: DecideApprovalRequest, client: RequestInfo): Promise<{ ok: true }> {
    const split = /^([a-z_]+):(.+)$/.exec(itemId);
    if (!split) throw new BadRequestException({ statusCode: 400, code: 'invalid_item', message: 'That is not an approval item' });
    const type = split[1] as ApprovalTypeName;
    const provider = this.providers.find((p) => p.types.includes(type));
    if (!provider) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Approval item not found' });
    const waiting = (await provider.list(actor)).find((i) => i.id === itemId);
    if (!waiting) throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'This is not waiting for you' });
    if (waiting.requester === actor.empId) throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'Nobody approves their own request' });
    await provider.decide(actor, { type, refId: split[2] }, decision, input, client);
    return { ok: true };
  }
}
