import BaileysClient from './whatsapp/baileys-client.js';
import APIServer from './api/server.js';
import logger from './utils/logger.js';
import config from './config/config.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

class WhatsAppBot {
  constructor() {
    this.whatsappClient = null;
    this.apiServer = null;
    this.isRunning = false;
    this.shutdownInProgress = false;
  }

  async start() {
    try {
      logger.info('Starting WhatsApp Bot System...');

      // Create required directories
      this.createRequiredDirectories();

      // Initialize WhatsApp client
      logger.info('Initializing Baileys WhatsApp client...');
      this.whatsappClient = new BaileysClient();
      await this.whatsappClient.initialize();

      // Start API server
      logger.info('Starting API server...');
      this.apiServer = new APIServer(this.whatsappClient);
      await this.apiServer.start();

      this.isRunning = true;
      logger.info('WhatsApp Bot System started successfully!');
      logger.info(`Dashboard available at: http://localhost:${config.server.port}`);

      this.setupGracefulShutdown();

    } catch (error) {
      logger.error('Failed to start WhatsApp Bot System:', error);
      await this.cleanup();
      process.exit(1);
    }
  }

  createRequiredDirectories() {
    const directories = [
      dirname(config.database.path),
      config.whatsapp.sessionPath,
      './logs',
      './data/reports'
    ];

    directories.forEach(dir => {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
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
      version: '2.0.0'
    };
  }
}

// Start bot if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const bot = new WhatsAppBot();
  bot.start().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });
}

export default WhatsAppBot;