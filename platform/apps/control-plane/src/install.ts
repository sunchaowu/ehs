import { installInitialAdmin } from "./install-admin.js";

const required = [
  "DATABASE_SYSTEM_URL",
  "PLATFORM_TITLE",
  "DATABASE_PROD_ADMIN_URL",
  "DATABASE_TEST_ADMIN_URL",
  "REGISTRY_ADDRESS",
] as const;

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`缺少 ${missing.join("、")}`);
  process.exit(1);
}

const result = await installInitialAdmin(process.env.DATABASE_SYSTEM_URL!, {
  title: process.env.PLATFORM_TITLE!,
  prodAdminUrl: process.env.DATABASE_PROD_ADMIN_URL!,
  testAdminUrl: process.env.DATABASE_TEST_ADMIN_URL!,
  registryAddress: process.env.REGISTRY_ADDRESS!,
  reset: process.env.ADMIN_RESET === "1",
});

if (result.created) {
  console.log(`${result.username} ${result.password}`);
}
