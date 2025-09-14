import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
  // Server Configuration
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || '0.0.0.0',
    cors: {
      origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
      credentials: true
    }
  },

  // Database Configuration
  database: {
    path: process.env.DB_PATH || join(__dirname, '../../data/reports.db'),
    options: {
      busyTimeout: 30000,
      journal_mode: 'WAL',
      synchronous: 'NORMAL',
      cache_size: -64000,
      temp_store: 'MEMORY'
    }
  },

  // WhatsApp Configuration
  whatsapp: {
    sessionPath: process.env.WHATSAPP_SESSION_PATH || join(__dirname, '../../data/auth'),
    reconnectInterval: 5000,
    maxReconnectAttempts: 10,
    messageProcessingDelay: 100,
    qrTimeout: 60000
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    standardHeaders: true,
    legacyHeaders: false
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    maxFiles: 5,
    maxSize: '10m',
    format: 'json'
  },

  // Security
  security: {
    adminUsers: process.env.ADMIN_USERS?.split(',') || [],
    allowedCommands: [
      'help', 'status', 'stats', 'report', 'chats', 'messages'
    ],
    adminCommands: [
      'backup', 'vacuum', 'broadcast', 'restart'
    ]
  },

  // Reports
  reports: {
    schedules: {
      daily: '0 9 * * *',    // 9 AM daily
      weekly: '0 9 * * 1',   // 9 AM Monday
      monthly: '0 9 1 * *'   // 9 AM 1st of month
    },
    retention: {
      days: 90 // Keep reports for 90 days
    }
  }
};

export default config;