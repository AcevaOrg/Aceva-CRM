import { Injectable, OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@aceva/contracts';
import { MAX_FAILED_PASSWORDS } from '../auth/auth.service';
import { parseUserAgent } from '../auth/user-agent';
import { CityLocator } from '../common/city-locator';
import { OutboxDispatcher, type StoredOutboxEvent } from '../events/outbox-dispatcher.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityAlertsService } from './activity-alerts.service';
import { ActivityRecorder } from './activity-recorder.service';
import { deviceFingerprint, deviceLabel, loginFailedDescription, logoutDescription, logoutHow, securityDescription } from './rules/activity-classify';
import { accountLockedAlert, isOutsideWorkingHours, newSignIn, newSignInAlert, outsideHoursAlert } from './rules/alert-rules';

type Of<T extends OutboxEvent['type']> = Extract<OutboxEvent, { type: T }>;

/** How many earlier sign-in places (device and city) are compared for the "new device or new city" rule. */
const KNOWN_PLACES = 500;

/**
 * Module 4's outbox consumers (registered on the shared OutboxDispatcher, see docs/EVENTS.md):
 *
 *   activity.auth         auth.login, auth.login_failed, auth.logout, auth.security (Module 2)  ->  activity records,
 *                         plus the alerts that follow from a login (new device or city, outside working hours) or from
 *                         the account locking itself after 5 wrong passwords
 *   activity.alert-rules  activity.flagged (written by ActivityRecorder)  ->  large export, many salary records,
 *                         repeated finance attempts
 *   activity.alert-mail   activity.alert.raised  ->  email to the Director and the CTO
 *
 * Every write is idempotent: activity records carry dedupe_key "outbox:<event id>" and alerts a dedupe key of their own,
 * so an event delivered twice changes nothing the second time.
 */
@Injectable()
export class ActivityConsumers implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly prisma: PrismaService,
    private readonly recorder: ActivityRecorder,
    private readonly alerts: ActivityAlertsService,
    private readonly cities: CityLocator,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register({
      name: 'activity.auth',
      handles: [
        { type: 'auth.login', version: 1 },
        { type: 'auth.login_failed', version: 1 },
        { type: 'auth.logout', version: 1 },
        { type: 'auth.security', version: 1 },
      ],
      handle: (event, stored) => this.onAuth(event, stored),
    });
    this.dispatcher.register({
      name: 'activity.alert-rules',
      handles: [{ type: 'activity.flagged', version: 1 }],
      handle: async (event) => {
        if (event.type === 'activity.flagged') await this.alerts.evaluate(event.payload);
      },
    });
    this.dispatcher.register({
      name: 'activity.alert-mail',
      handles: [{ type: 'activity.alert.raised', version: 1 }],
      handle: async (event) => {
        if (event.type === 'activity.alert.raised') await this.alerts.mail(event.payload.alertId);
      },
    });
  }

  private async onAuth(event: OutboxEvent, stored: StoredOutboxEvent): Promise<void> {
    switch (event.type) {
      case 'auth.login':
        return this.onLogin(event, stored);
      case 'auth.login_failed':
        return this.onLoginFailed(event, stored);
      case 'auth.logout':
        return this.onLogout(event, stored);
      case 'auth.security':
        return this.onSecurity(event, stored);
      default:
        return;
    }
  }

  private employee(empId: string) {
    return this.prisma.employee.findUnique({ where: { empId }, select: { id: true, empId: true } });
  }

  private async onLogin(event: Of<'auth.login'>, stored: StoredOutboxEvent): Promise<void> {
    const person = await this.employee(event.payload.empId);
    const session = await this.prisma.session.findUnique({
      where: { id: event.payload.sessionId },
      select: { id: true, employeeId: true, createdAt: true, ip: true, device: true, browser: true, os: true, city: true },
    });
    if (!person || !session) return; // nothing to attach the record to (cannot happen for events Module 2 wrote)
    const city = session.city ?? this.cities.cityFor(session.ip ?? event.payload.ip);
    const device = deviceLabel(session);
    const at = stored.occurredAt;

    // Compare with the places this person signed in from before (the very first sign-in only sets the baseline).
    const earlier = await this.prisma.session.findMany({
      where: { employeeId: person.id, createdAt: { lt: session.createdAt }, id: { not: session.id } },
      orderBy: { createdAt: 'desc' },
      take: KNOWN_PLACES,
      select: { device: true, browser: true, os: true, city: true },
    });
    const place = newSignIn(
      earlier.map((s) => ({ fingerprint: deviceFingerprint(s), city: s.city })),
      { fingerprint: deviceFingerprint(session), city },
    );
    const rules = await this.alerts.rules();
    const fresh = this.alerts.isFresh(at);
    const newDevice = place.newDevice && rules.newDevice;
    const newCity = place.newCity && rules.newCity;

    await this.prisma.$transaction(async (tx) => {
      await this.recorder.write(tx, [
        {
          employeeId: person.id,
          empId: person.empId,
          occurredAt: at,
          action: 'login',
          module: 'Login',
          description: 'Signed in',
          sessionId: session.id,
          ip: session.ip ?? event.payload.ip,
          city,
          device,
          dedupeKey: `outbox:${stored.id}`,
          details: { newDevice: place.newDevice, newCity: place.newCity },
        },
      ]);
      if (!fresh) return;
      const usualCities = [...new Set(earlier.map((s) => s.city).filter((c): c is string => !!c))].slice(0, 3);
      const alert = newSignInAlert({ newDevice, newCity, device, city, ip: session.ip ?? event.payload.ip, usualCities });
      if (alert) {
        await this.alerts.raise(tx, { ...alert, employeeId: person.id, empId: person.empId, occurredAt: at, dedupeKey: `new_device:${session.id}`, data: { sessionId: session.id } });
      }
      if (rules.outsideHours && isOutsideWorkingHours(at, rules.outsideFrom, rules.outsideTo)) {
        await this.alerts.raise(tx, {
          ...outsideHoursAlert(at, { city, device }),
          employeeId: person.id,
          empId: person.empId,
          occurredAt: at,
          dedupeKey: `outside_hours:${session.id}`,
          data: { sessionId: session.id, from: rules.outsideFrom, to: rules.outsideTo },
        });
      }
    });
  }

  private async onLoginFailed(event: Of<'auth.login_failed'>, stored: StoredOutboxEvent): Promise<void> {
    // An Emp-ID that matched nobody has no activity record (activity belongs to a person); Module 2 keeps those attempts.
    if (!event.payload.empId) return;
    const person = await this.employee(event.payload.empId);
    if (!person) return;
    const ua = parseUserAgent(event.payload.userAgent);
    await this.prisma.$transaction((tx) =>
      this.recorder.write(tx, [
        {
          employeeId: person.id,
          empId: person.empId,
          occurredAt: stored.occurredAt,
          action: 'login_failed',
          module: 'Login',
          description: loginFailedDescription(event.payload.reason),
          ip: event.payload.ip,
          city: this.cities.cityFor(event.payload.ip),
          device: deviceLabel(ua),
          dedupeKey: `outbox:${stored.id}`,
          details: { reason: event.payload.reason },
        },
      ]),
    );
  }

  private async onLogout(event: Of<'auth.logout'>, stored: StoredOutboxEvent): Promise<void> {
    const person = await this.employee(event.payload.empId);
    const session = await this.prisma.session.findUnique({ where: { id: event.payload.sessionId }, select: { id: true, ip: true, device: true, browser: true, os: true, city: true } });
    if (!person || !session) return;
    await this.prisma.$transaction((tx) =>
      this.recorder.write(tx, [
        {
          employeeId: person.id,
          empId: person.empId,
          occurredAt: stored.occurredAt,
          action: 'logout',
          module: 'Login',
          description: logoutDescription(event.payload.reason),
          sessionId: session.id,
          ip: session.ip,
          city: session.city ?? this.cities.cityFor(session.ip),
          device: deviceLabel(session),
          dedupeKey: `outbox:${stored.id}`,
          details: { how: logoutHow(event.payload.reason), reason: event.payload.reason },
        },
      ]),
    );
  }

  private async onSecurity(event: Of<'auth.security'>, stored: StoredOutboxEvent): Promise<void> {
    const person = await this.employee(event.payload.empId);
    if (!person) return;
    const { kind, byEmpId } = event.payload;
    const lockedBySystem = kind === 'account_locked' && byEmpId === null;
    const lastFailure = lockedBySystem
      ? await this.prisma.loginAttempt.findFirst({ where: { employeeId: person.id, success: false }, orderBy: { createdAt: 'desc' }, select: { ip: true, userAgent: true } })
      : null;
    const failureDevice = lastFailure ? deviceLabel(parseUserAgent(lastFailure.userAgent)) : null;
    const failureCity = lastFailure ? this.cities.cityFor(lastFailure.ip) : null;

    await this.prisma.$transaction(async (tx) => {
      await this.recorder.write(tx, [
        {
          employeeId: person.id,
          empId: person.empId,
          occurredAt: stored.occurredAt,
          action: 'security',
          module: 'Login',
          description: securityDescription(kind, byEmpId),
          target: byEmpId,
          ip: lastFailure?.ip ?? null,
          city: failureCity,
          device: failureDevice,
          dedupeKey: `outbox:${stored.id}`,
          details: { kind, by: byEmpId ?? (kind === 'account_locked' ? 'system' : 'self') },
        },
      ]);
      if (lockedBySystem && this.alerts.isFresh(stored.occurredAt)) {
        await this.alerts.raise(tx, {
          ...accountLockedAlert({ attempts: MAX_FAILED_PASSWORDS, device: failureDevice, city: failureCity, ip: lastFailure?.ip ?? null }),
          employeeId: person.id,
          empId: person.empId,
          occurredAt: stored.occurredAt,
          dedupeKey: `account_locked:${stored.id}`,
        });
      }
    });
  }
}
