const WhatsAppClient = require('./whatsapp/whatsapp-client');
const APIServer = require('./api/server');
const logger = require('./utils/logger');
const path = require('path');
const fs = require('fs');

class WhatsAppReportsBot {
  constructor() {
    this.whatsappClient = null;
    this.apiServer = null;
    this.isRunning = false;
    this.shutdownInProgress = false;
  }

  async start() {
    try {
      logger.info('Starting WhatsApp Reports Bot...');

      this.createRequiredDirectories();

      // Initialize WhatsApp client
      logger.info('Initializing WhatsApp client...');
      this.whatsappClient = new WhatsAppClient();
      await this.whatsappClient.start();

      // Start API server
      logger.info('Starting API server...');
      this.apiServer = new APIServer(this.whatsappClient);
      await this.apiServer.start(process.env.PORT || 3000);

      this.isRunning = true;
      logger.info('WhatsApp Reports Bot started successfully!');

      this.setupGracefulShutdown();

    } catch (error) {
      logger.error('Failed to start WhatsApp Reports Bot:', error);
      await this.cleanup();
      process.exit(1);
    }
  }

  createRequiredDirectories() {
    const directories = [
      path.join(__dirname, '../data'),
      path.join(__dirname, '../logs'),
      path.join(__dirname, '../data/auth')
    ];

    directories.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created directory: ${dir}`);
      }
    });
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.shutdownInProgress) return;
      this.shutdownInProgress = true;

      logger.info(`Received ${signal}. Starting graceful shutdown...`);
      
      try {
        await this.cleanup();
        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2'));
  }

  async cleanup() {
    this.isRunning = false;

    const cleanupTasks = [];

    if (this.apiServer) {
      logger.info('Stopping API server...');
      cleanupTasks.push(this.apiServer.stop());
    }

    if (this.whatsappClient) {
      logger.info('Stopping WhatsApp client...');
      cleanupTasks.push(this.whatsappClient.stop());
    }

    await Promise.allSettled(cleanupTasks);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      whatsapp: this.whatsappClient ? this.whatsappClient.getStatus() : null,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: require('../package.json').version
    };
  }
}

// Start bot if run directly
if (require.main === module) {
  const bot = new WhatsAppReportsBot();
  bot.start().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });
}

module.exports = WhatsAppReportsBot;