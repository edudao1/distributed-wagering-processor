import type { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import type { OutboxBacklog, OutboxStore } from "../../application/ports/persistence";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { translatePersistenceError } from "./database-errors";
import { outboxMessageFromRow, type OutboxRow } from "./mappers";
import { MIKRO_ORM } from "./orm";
import { query } from "./sql";

const CLAIM_SQL = `
update outbox_messages
   set locked_by = ?, locked_until = now() + (?::int * interval '1 millisecond')
 where id in (
       select id
         from outbox_messages
        where published_at is null
          and next_attempt_at <= now()
          and (locked_until is null or locked_until < now())
        order by occurred_at, id
        limit ?::int
          for update skip locked
       )
returning id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at`;

@Injectable()
export class MikroOrmOutboxStore implements OutboxStore {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  async claim(owner: string, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.run<OutboxRow>(CLAIM_SQL, [owner, leaseMs, limit]);
    return rows
      .map(outboxMessageFromRow)
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.run(
      `update outbox_messages
          set published_at = ?, locked_by = null, locked_until = null
        where id = ? and published_at is null`,
      [message.publishedAt ?? new Date(), message.id],
    );
  }

  async release(message: OutboxMessage, owner: string, error: string): Promise<void> {
    await this.run(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, last_error = ?, locked_by = null, locked_until = null
        where id = ? and locked_by = ? and published_at is null`,
      [message.attempts, message.nextAttemptAt ?? new Date(), error, message.id, owner],
    );
  }

  async backlog(): Promise<OutboxBacklog> {
    const [row] = await this.run<{ pending: number | string; lag_seconds: number | string | null }>(
      `select count(*)::int as pending,
              coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as lag_seconds
         from outbox_messages
        where published_at is null`,
    );
    return { pending: Number(row?.pending ?? 0), lagSeconds: Number(row?.lag_seconds ?? 0) };
  }

  private async run<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      return await query<T>(this.orm.em.fork(), sql, params);
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
