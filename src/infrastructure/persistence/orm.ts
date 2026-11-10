import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, MikroORM } from "@mikro-orm/postgresql";
import type { AppConfig } from "../../config/app-config";
import { MIGRATIONS } from "./migrations";
import { ENTITY_SCHEMAS } from "./records";

export const MIKRO_ORM = Symbol("MIKRO_ORM");

export function createOrmConfig(config: AppConfig) {
  return defineConfig({
    clientUrl: config.database.url,
    entities: ENTITY_SCHEMAS,
    pool: { min: 0, max: config.database.poolMax },
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: "schema_migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    allowGlobalContext: false,
    forceUtcTimezone: true,
    debug: false,
    discovery: { warnWhenNoEntities: false },
  });
}

export function initOrm(config: AppConfig): Promise<MikroORM> {
  return MikroORM.init(createOrmConfig(config));
}

@Injectable()
export class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
