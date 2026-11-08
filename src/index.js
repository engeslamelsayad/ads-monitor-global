const config = require('./config');
const logger = require('./utils/logger');
const runtime = require('./telegram/runtime');
const admin = require('./telegram/admin');
const scheduler = require('./scheduler');

async function main() {
  logger.info('====================================');
  logger.info('  Ads Monitor — Multi-Tenant v2.0');
  logger.info(`  AI: ${config.anthropic.models.heavy} / ${config.anthropic.models.light}`);
  logger.info('====================================');

  await require('./web/server').start();
  admin.start();
  await runtime.startAll();
  scheduler.startAll();
}

process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', err));
process.on('uncaughtException', (err) => logger.error('Uncaught exception', err));

main().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
