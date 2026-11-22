import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** A different sender than MAIL_FROM (Module 13 customer emails use the address set in the billing settings). */
  from?: string;
  replyTo?: string;
}

/** Sends email. The rest of the app only talks to this; the SMTP details live in the environment. */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/** Real SMTP: Mailpit on this computer during development, Aceva's own mailboxes in production. */
@Injectable()
export class SmtpMailer extends Mailer {
  private readonly logger = new Logger('Mailer');
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(ENV) env: Env) {
    super();
    this.from = env.MAIL_FROM;
    this.transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
      // nodemailer waits 2 minutes to connect, 30 seconds for the greeting and 10 minutes on a silent socket. A mail host
      // that drops packets must fail a send in seconds (inside the outbox dispatcher's 20-second limit per consumer).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({ ...message, from: message.from ?? this.from });
    } catch (error) {
      // Never log the message body (it can contain a reset link or a temporary password).
      this.logger.error(`Could not send an email to ${message.to}: ${(error as Error).message}`);
      throw error;
    }
  }
}
