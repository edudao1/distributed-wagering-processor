import "reflect-metadata";
import { createApplication } from "./bootstrap";
import { loadConfig } from "./config/app-config";

const config = loadConfig();
const app = await createApplication(config);
app.enableShutdownHooks();
await app.listen(config.port, "0.0.0.0");
