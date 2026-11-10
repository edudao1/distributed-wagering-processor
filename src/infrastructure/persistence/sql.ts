import type { EntityManager } from "@mikro-orm/postgresql";

export async function query<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T[]> {
  const rows: unknown = await em.execute(sql, params);
  return rows as T[];
}
