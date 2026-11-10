import { IsolationLevel } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import type { WageringMetrics } from "../../application/ports/infrastructure";
import type { TransactionScope, UnitOfWork, UnitOfWorkOptions } from "../../application/ports/persistence";
import { METRICS } from "../../application/ports/tokens";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { translatePersistenceError } from "./database-errors";
import { MIKRO_ORM } from "./orm";
import { MikroOrmTransactionScope } from "./repositories";

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: WageringMetrics,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const em = this.orm.em.fork({ clear: true });
    const lockTimeout = Math.trunc(this.config.database.lockTimeoutMs);
    const statementTimeout = Math.trunc(this.config.database.statementTimeoutMs);
    try {
      return await em.transactional(
        async (transactional) => {
          await transactional.execute(`set local lock_timeout = '${lockTimeout}ms'`);
          await transactional.execute(`set local statement_timeout = '${statementTimeout}ms'`);
          return work(new MikroOrmTransactionScope(transactional));
        },
        {
          isolationLevel:
            options.isolation === "repeatable-read" ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      throw translatePersistenceError(error, this.metrics);
    }
  }
}
