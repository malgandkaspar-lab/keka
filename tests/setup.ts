// Test environment: isolated database + Redis DB index, silent logging.
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://shorts:shorts@localhost:5432/shorts_factory_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
process.env.AUTH_SECRET ??= "test-auth-secret-0123456789abcdef-0123456789";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR ??= "./storage/test";
process.env.WORK_DIR ??= "./storage/test/tmp";
