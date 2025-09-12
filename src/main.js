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
  }

  async start() {
    try {
      logger.info('Starting WhatsApp Reports Bot...');

      // إنشاء المجلدات المطلوبة
      this.createRequiredDirectories();

      // بدء تشغيل عميل واتساب
      logger.info('Initializing WhatsApp client...');
      this.whatsappClient = new WhatsAppClient();
      await this.whatsappClient.start();

      // بدء تشغيل خادم API
      logger.info('Starting API server...');
      this.apiServer = new APIServer(this.whatsappClient);
      await this.apiServer.start(process.env.PORT || 3000);

      this.isRunning = true;
      logger.info('WhatsApp Reports Bot started successfully!');

      // معالجة إشارات النظام للإغلاق الآمن
      this.setupGracefulShutdown();

    } catch (error) {
      logger.error('Failed to start WhatsApp Reports Bot:', error);
      process.exit(1);
    }
  }

  createRequiredDirectories() {
    const directories = [
      path.join(__dirname, '../data'),
      path.join(__dirname, '../logs'),
      path.join(__dirname, '../temp')
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
      logger.info(`Received ${signal}. Starting graceful shutdown...`);
      
      if (this.isRunning) {
        this.isRunning = false;

        try {
          // إيقاف خادم API
          if (this.apiServer) {
            logger.info('Stopping API server...');
            await this.apiServer.stop();
          }

          // إيقاف عميل واتساب
          if (this.whatsappClient) {
            logger.info('Stopping WhatsApp client...');
            await this.whatsappClient.stop();
          }

          logger.info('Graceful shutdown completed');
          process.exit(0);

        } catch (error) {
          logger.error('Error during shutdown:', error);
          process.exit(1);
        }
      }
    };

    // معالجة إشارات النظام
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2')); // لـ nodemon

    // معالجة الأخطاء غير المتوقعة
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      shutdown('unhandledRejection');
    });
  }

  // الحصول على حالة النظام
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

// بدء تشغيل البوت إذا تم تشغيل الملف مباشرة
if (require.main === module) {
  const bot = new WhatsAppReportsBot();
  bot.start().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });
}

module.exports = WhatsAppReportsBot;