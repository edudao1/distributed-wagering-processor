import "reflect-metadata";
import { loadConfig } from "../src/config/app-config";
import { initOrm } from "../src/infrastructure/persistence/orm";

const direction = process.argv[2] ?? "up";
const orm = await initOrm(loadConfig());

try {
  const migrator = orm.getMigrator();
  if (direction === "down") {
    await migrator.down();
  } else if (direction === "reset") {
    await migrator.down({ to: 0 });
    await migrator.up();
  } else {
    await migrator.up();
  }
  console.log(JSON.stringify({ level: "info", message: `migrations ${direction} finished` }));
} finally {
  await orm.close(true);
}
