import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import { body, validationResult } from 'express-validator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class APIServer {
  constructor(whatsappClient) {
    this.app = express();
    this.whatsappClient = whatsappClient;
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
    this.app.use(cors(config.server.cors));

    // Rate limiting
    this.app.use('/api/', rateLimit(config.rateLimit));

    // Body parsing
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Static files
    this.app.use(express.static(join(__dirname, '../../public')));

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        logger.logRequest(req.method, req.path, res.statusCode, duration);
      });
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      const status = this.whatsappClient.getStatus();
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        whatsapp: status.isConnected,
        database: status.dbHealthy
      });
    });

    // Main page
    this.app.get('/', (req, res) => {
      res.sendFile(join(__dirname, '../../public/index.html'));
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
          isConnected: status.isConnected
        }
      });
    });

    // Statistics
    this.app.get('/api/stats', async (req, res) => {
      try {
        const stats = await this.whatsappClient.db.getStats();
        res.json({ success: true, data: stats });
      } catch (error) {
        logger.error('Error getting stats:', error);
        res.status(500).json({ success: false, error: 'Failed to get statistics' });
      }
    });

    // Chats
    this.app.get('/api/chats', async (req, res) => {
      try {
        const chats = await this.whatsappClient.getChats();
        res.json({ success: true, data: chats });
      } catch (error) {
        logger.error('Error getting chats:', error);
        res.status(500).json({ success: false, error: 'Failed to get chats' });
      }
    });

    // Recent messages
    this.app.get('/api/messages', async (req, res) => {
      try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
        const messages = await this.whatsappClient.db.getRecentMessages(limit);
        res.json({ success: true, data: messages });
      } catch (error) {
        logger.error('Error getting messages:', error);
        res.status(500).json({ success: false, error: 'Failed to get messages' });
      }
    });

    // Search messages
    this.app.get('/api/messages/search', async (req, res) => {
      try {
        const { q: query, chatId } = req.query;
        
        if (!query || query.trim().length < 2) {
          return res.status(400).json({
            success: false,
            error: 'Search query must be at least 2 characters'
          });
        }
        
        const messages = await this.whatsappClient.db.searchMessages(query.trim(), chatId);
        res.json({ success: true, data: messages });
      } catch (error) {
        logger.error('Error searching messages:', error);
        res.status(500).json({ success: false, error: 'Failed to search messages' });
      }
    });

    // Send message
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

    // Database operations
    this.app.post('/api/admin/vacuum', async (req, res) => {
      try {
        await this.whatsappClient.db.vacuum();
        res.json({ success: true, message: 'Database optimized successfully' });
      } catch (error) {
        logger.error('Error vacuuming database:', error);
        res.status(500).json({ success: false, error: 'Failed to optimize database' });
      }
    });

    this.app.post('/api/admin/backup', async (req, res) => {
      try {
        const backupPath = `./data/backup_${Date.now()}.db`;
        await this.whatsappClient.db.backup(backupPath);
        res.json({ success: true, message: 'Backup created successfully', path: backupPath });
      } catch (error) {
        logger.error('Error creating backup:', error);
        res.status(500).json({ success: false, error: 'Failed to create backup' });
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

  start(port = config.server.port) {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, config.server.host, () => {
          logger.info(`API Server started on ${config.server.host}:${port}`);
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

export default APIServer;