const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const Database = require('../database/database');
const logger = require('../utils/logger');

class APIServer {
  constructor(whatsappClient) {
    this.app = express();
    this.whatsappClient = whatsappClient;
    this.db = new Database();
    this.clients = new Set(); // للـ Server-Sent Events
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // الأمان
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"]
        }
      }
    }));

    // CORS
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
      credentials: true
    }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 دقيقة
      max: 100, // حد أقصى 100 طلب لكل IP
      message: 'Too many requests from this IP, please try again later.'
    });
    this.app.use('/api/', limiter);

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Static files
    this.app.use(express.static(path.join(__dirname, '../../public')));

    // Logging
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // الصفحة الرئيسية
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    // حالة النظام
    this.app.get('/api/status', (req, res) => {
      const whatsappStatus = this.whatsappClient.getStatus();
      res.json({
        success: true,
        data: {
          server: 'running',
          whatsapp: whatsappStatus,
          timestamp: new Date().toISOString()
        }
      });
    });

    // رمز QR للواتساب
    this.app.get('/api/whatsapp/qr', (req, res) => {
      const status = this.whatsappClient.getStatus();
      res.json({
        success: true,
        data: {
          qrCode: status.qrCode,
          hasQR: status.hasQR,
          isReady: status.isReady
        }
      });
    });

    // الإحصائيات العامة
    this.app.get('/api/stats/general', async (req, res) => {
      try {
        const stats = await this.db.getGeneralStats();
        res.json({
          success: true,
          data: stats
        });
      } catch (error) {
        logger.error('Error getting general stats:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get statistics'
        });
      }
    });

    // قائمة القنوات مع الإحصائيات
    this.app.get('/api/channels', async (req, res) => {
      try {
        const channels = await this.db.getAllChannelsWithStats();
        res.json({
          success: true,
          data: channels
        });
      } catch (error) {
        logger.error('Error getting channels:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get channels'
        });
      }
    });

    // إحصائيات قناة محددة
    this.app.get('/api/channels/:chatId/stats', async (req, res) => {
      try {
        const { chatId } = req.params;
        const stats = await this.db.getChannelStats(chatId);
        
        if (!stats) {
          return res.status(404).json({
            success: false,
            error: 'Channel not found'
          });
        }
        
        res.json({
          success: true,
          data: stats
        });
      } catch (error) {
        logger.error('Error getting channel stats:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get channel statistics'
        });
      }
    });

    // البلاغات الأخيرة
    this.app.get('/api/reports/recent', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 50;
        const reports = await this.db.getRecentReports(limit);
        res.json({
          success: true,
          data: reports
        });
      } catch (error) {
        logger.error('Error getting recent reports:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get reports'
        });
      }
    });

    // البحث في البلاغات
    this.app.get('/api/reports/search', async (req, res) => {
      try {
        const { q: query, chatId } = req.query;
        
        if (!query || query.trim().length < 2) {
          return res.status(400).json({
            success: false,
            error: 'Search query must be at least 2 characters'
          });
        }
        
        const reports = await this.db.searchReports(query.trim(), chatId);
        res.json({
          success: true,
          data: reports
        });
      } catch (error) {
        logger.error('Error searching reports:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to search reports'
        });
      }
    });

    // إرسال رسالة عبر واتساب
    this.app.post('/api/whatsapp/send', async (req, res) => {
      try {
        const { chatId, message } = req.body;
        
        if (!chatId || !message) {
          return res.status(400).json({
            success: false,
            error: 'chatId and message are required'
          });
        }
        
        await this.whatsappClient.sendMessage(chatId, message);
        
        res.json({
          success: true,
          message: 'Message sent successfully'
        });
      } catch (error) {
        logger.error('Error sending message:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to send message'
        });
      }
    });

    // الحصول على قائمة المحادثات من واتساب
    this.app.get('/api/whatsapp/chats', async (req, res) => {
      try {
        const chats = await this.whatsappClient.getChats();
        res.json({
          success: true,
          data: chats
        });
      } catch (error) {
        logger.error('Error getting WhatsApp chats:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get chats'
        });
      }
    });

    // Server-Sent Events للتحديثات المباشرة
    this.app.get('/api/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      // إضافة العميل للقائمة
      this.clients.add(res);

      // إرسال رسالة ترحيب
      res.write('data: {"type": "connected", "message": "Connected to live updates"}\n\n');

      // إزالة العميل عند قطع الاتصال
      req.on('close', () => {
        this.clients.delete(res);
      });
    });

    // Webhook للإشعارات الخارجية
    this.app.post('/api/webhook/alerts', (req, res) => {
      try {
        const alertData = req.body;
        
        // إرسال التحديث لجميع العملاء المتصلين
        this.broadcastToClients({
          type: 'alert',
          data: alertData,
          timestamp: new Date().toISOString()
        });
        
        res.json({
          success: true,
          message: 'Alert received and broadcasted'
        });
      } catch (error) {
        logger.error('Error handling webhook alert:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to process alert'
        });
      }
    });

    // معالجة الأخطاء
    this.app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    });

    // معالجة الطرق غير الموجودة
    this.app.use('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found'
      });
    });
  }

  // إرسال تحديث لجميع العملاء المتصلين
  broadcastToClients(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    
    this.clients.forEach(client => {
      try {
        client.write(message);
      } catch (error) {
        // إزالة العميل المنقطع
        this.clients.delete(client);
      }
    });
  }

  // بدء تشغيل الخادم
  start(port = 3000) {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, () => {
          console.log(`API Server running on port ${port}`);
          logger.info(`API Server started on port ${port}`);
          resolve();
        });

        this.server.on('error', (error) => {
          logger.error('Server error:', error);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  // إيقاف الخادم
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('API Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = APIServer;