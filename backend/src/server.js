'use strict';
const app = require('./app');
const env = require('./config/env');
const { connectDb } = require('./config/db');
const workflowService = require('./services/workflow.service');
const retryWorker = require('./services/retryWorker');
const logger = require('./utils/logger');

async function main() {
  await connectDb();
  await workflowService.seedFromFiles();
  if (env.ENABLE_RETRY_WORKER) retryWorker.start();
  app.listen(env.PORT, () => logger.info(`API on http://localhost:${env.PORT}  (Swagger UI: /docs)`));
}

main().catch((err) => { logger.error('Startup failed:', err.message); process.exit(1); });
