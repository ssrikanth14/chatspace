
import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, env } from "prisma/config";

const configDir = dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: resolve(configDir, "../../.env"),
});

export default defineConfig({
  schema: resolve(configDir, "prisma/schema.prisma"),
  migrations: {
    path: resolve(configDir, "prisma/migrations"),
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
