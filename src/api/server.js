const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { body, validationResult } = require('express-validator');
const path = require('path');
const Database = require('../database/database');
const logger = require('../utils/logger');

class APIServer {
  constructor(whatsappClient) {
    this.app = express();
    this.whatsappClient = whatsappClient;
    this.db = new Database();
    this.clients = new Set();
    this.server = null;
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Security
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"]
        }
      }
    }));

    // Compression
    this.app.use(compression());

    // CORS
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      credentials: true
    }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false
    });
    this.app.use('/api/', limiter);

    // Body parsing
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Static files
    this.app.use(express.static(path.join(__dirname, '../../public')));

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
      });
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Main page
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    // System status
    this.app.get('/api/status', (req, res) => {
      const whatsappStatus = this.whatsappClient.getStatus();
      res.json({
        success: true,
        data: {
          server: 'running',
          whatsapp: whatsappStatus,
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          memory: process.memoryUsage()
        }
      });
    });

    // WhatsApp QR code
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

    // General statistics
    this.app.get('/api/stats/general', async (req, res) => {
      try {
        const stats = await this.db.getGeneralStats();
        res.json({ success: true, data: stats });
      } catch (error) {
        logger.error('Error getting general stats:', error);
        res.status(500).json({ success: false, error: 'Failed to get statistics' });
      }
    });

    // Channels list
    this.app.get('/api/channels', async (req, res) => {
      try {
        const channels = await this.db.getAllChannelsWithStats();
        res.json({ success: true, data: channels });
      } catch (error) {
        logger.error('Error getting channels:', error);
        res.status(500).json({ success: false, error: 'Failed to get channels' });
      }
    });

    // Recent reports
    this.app.get('/api/reports/recent', async (req, res) => {
      try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
        const reports = await this.db.getRecentReports(limit);
        res.json({ success: true, data: reports });
      } catch (error) {
        logger.error('Error getting recent reports:', error);
        res.status(500).json({ success: false, error: 'Failed to get reports' });
      }
    });

    // Search reports
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
        res.json({ success: true, data: reports });
      } catch (error) {
        logger.error('Error searching reports:', error);
        res.status(500).json({ success: false, error: 'Failed to search reports' });
      }
    });

    // Send WhatsApp message
    this.app.post('/api/whatsapp/send', [
      body('chatId').notEmpty().trim(),
      body('message').notEmpty().trim().isLength({ max: 1000 })
    ], async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Invalid input',
          details: errors.array()
        });
      }

      try {
        const { chatId, message } = req.body;
        await this.whatsappClient.sendMessage(chatId, message);
        res.json({ success: true, message: 'Message sent successfully' });
      } catch (error) {
        logger.error('Error sending message:', error);
        res.status(500).json({ success: false, error: 'Failed to send message' });
      }
    });

    // Get WhatsApp chats
    this.app.get('/api/whatsapp/chats', async (req, res) => {
      try {
        const chats = await this.whatsappClient.getChats();
        res.json({ success: true, data: chats });
      } catch (error) {
        logger.error('Error getting WhatsApp chats:', error);
        res.status(500).json({ success: false, error: 'Failed to get chats' });
      }
    });

    // Server-Sent Events
    this.app.get('/api/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      this.clients.add(res);
      res.write('data: {"type": "connected", "message": "Connected to live updates"}\n\n');

      req.on('close', () => {
        this.clients.delete(res);
      });
    });

    // Export data
    this.app.get('/api/export/reports', async (req, res) => {
      try {
        const reports = await this.db.getRecentReports(10000);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="reports.json"');
        res.json(reports);
      } catch (error) {
        logger.error('Error exporting reports:', error);
        res.status(500).json({ success: false, error: 'Failed to export data' });
      }
    });

    // Error handling
    this.app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    });

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({ success: false, error: 'Endpoint not found' });
    });
  }

  broadcastToClients(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    
    this.clients.forEach(client => {
      try {
        client.write(message);
      } catch (error) {
        this.clients.delete(client);
      }
    });
  }

  start(port = 3000) {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, () => {
          logger.info(`API Server started on port ${port}`);
          resolve();
        });

        this.server.on('error', reject);
      } catch (error) {
        reject(error);
      }
    });
  }

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