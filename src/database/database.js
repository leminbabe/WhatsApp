import sqlite3 from 'sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import logger from '../utils/logger.js';
import config from '../config/config.js';

class Database {
  constructor() {
    this.db = null;
    this.isConnected = false;
    this.init();
  }

  init() {
    try {
      // Ensure data directory exists
      const dataDir = dirname(config.database.path);
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }

      // Create database connection
      this.db = new sqlite3.Database(config.database.path, (err) => {
        if (err) {
          logger.error('Database connection failed:', err);
          throw err;
        }
        this.isConnected = true;
        logger.info('Database connected successfully');
      });

      // Configure database
      this.configure();
      this.createTables();
      this.createIndexes();

    } catch (error) {
      logger.error('Database initialization failed:', error);
      throw error;
    }
  }

  configure() {
    const options = config.database.options;
    
    this.db.serialize(() => {
      this.db.run(`PRAGMA busy_timeout = ${options.busyTimeout}`);
      this.db.run(`PRAGMA journal_mode = ${options.journal_mode}`);
      this.db.run(`PRAGMA synchronous = ${options.synchronous}`);
      this.db.run(`PRAGMA cache_size = ${options.cache_size}`);
      this.db.run(`PRAGMA temp_store = ${options.temp_store}`);
      this.db.run('PRAGMA foreign_keys = ON');
    });
  }

  createTables() {
    const tables = [
      // Messages table
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE NOT NULL,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        chat_type TEXT CHECK(chat_type IN ('group', 'private')) DEFAULT 'private',
        sender_id TEXT NOT NULL,
        sender_name TEXT,
        message_content TEXT NOT NULL,
        message_type TEXT DEFAULT 'text',
        is_report BOOLEAN DEFAULT 0,
        is_request BOOLEAN DEFAULT 0,
        severity INTEGER DEFAULT 1,
        status TEXT CHECK(status IN ('pending', 'processed', 'responded', 'ignored')) DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Chats table
      `CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE NOT NULL,
        chat_name TEXT,
        chat_type TEXT CHECK(chat_type IN ('group', 'private')) DEFAULT 'private',
        participant_count INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        report_count INTEGER DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,

      // Reports table
      `CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_type TEXT NOT NULL,
        report_data TEXT NOT NULL,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        generated_by TEXT,
        file_path TEXT,
        status TEXT CHECK(status IN ('generated', 'sent', 'failed')) DEFAULT 'generated'
      )`,

      // System logs table
      `CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    this.db.serialize(() => {
      tables.forEach(sql => {
        this.db.run(sql, (err) => {
          if (err) {
            logger.error('Table creation error:', err);
          }
        });
      });
    });
  }

  createIndexes() {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_messages_is_report ON messages(is_report)',
      'CREATE INDEX IF NOT EXISTS idx_messages_is_request ON messages(is_request)',
      'CREATE INDEX IF NOT EXISTS idx_chats_chat_id ON chats(chat_id)',
      'CREATE INDEX IF NOT EXISTS idx_chats_last_activity ON chats(last_activity)',
      'CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports(generated_at)',
      'CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at)'
    ];

    this.db.serialize(() => {
      indexes.forEach(sql => {
        this.db.run(sql, (err) => {
          if (err) {
            logger.error('Index creation error:', err);
          }
        });
      });
    });
  }

  // Message operations
  async saveMessage(messageData) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO messages (
          message_id, chat_id, chat_name, chat_type,
          sender_id, sender_name, message_content, message_type,
          is_report, is_request, severity
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run([
        messageData.messageId,
        messageData.chatId,
        messageData.chatName,
        messageData.chatType,
        messageData.senderId,
        messageData.senderName,
        messageData.messageContent,
        messageData.messageType || 'text',
        messageData.isReport ? 1 : 0,
        messageData.isRequest ? 1 : 0,
        messageData.severity || 1
      ], function(err) {
        stmt.finalize();
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  // Chat operations
  async upsertChat(chatData) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO chats (
          chat_id, chat_name, chat_type, participant_count,
          message_count, report_count, request_count,
          last_activity, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          COALESCE((SELECT message_count FROM chats WHERE chat_id = ?), 0) + 1,
          COALESCE((SELECT report_count FROM chats WHERE chat_id = ?), 0) + ?,
          COALESCE((SELECT request_count FROM chats WHERE chat_id = ?), 0) + ?,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `);

      stmt.run([
        chatData.chatId,
        chatData.chatName,
        chatData.chatType,
        chatData.participantCount || 0,
        chatData.chatId, // for message_count subquery
        chatData.chatId, // for report_count subquery
        chatData.isReport ? 1 : 0,
        chatData.chatId, // for request_count subquery
        chatData.isRequest ? 1 : 0
      ], function(err) {
        stmt.finalize();
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  // Statistics
  async getStats() {
    return new Promise((resolve, reject) => {
      this.db.get(`
        SELECT 
          COUNT(*) as total_messages,
          COUNT(DISTINCT chat_id) as total_chats,
          COUNT(CASE WHEN is_report = 1 THEN 1 END) as total_reports,
          COUNT(CASE WHEN is_request = 1 THEN 1 END) as total_requests,
          COUNT(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 END) as messages_today,
          COUNT(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 END) as messages_week,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_messages
        FROM messages
      `, [], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row || {});
        }
      });
    });
  }

  // Get recent messages
  async getRecentMessages(limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT * FROM messages 
        ORDER BY created_at DESC 
        LIMIT ?
      `, [Math.min(limit, 1000)], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  // Get active chats
  async getActiveChats(limit = 100) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT * FROM chats 
        WHERE is_active = 1
        ORDER BY last_activity DESC 
        LIMIT ?
      `, [limit], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  // Search messages
  async searchMessages(query, chatId = null) {
    return new Promise((resolve, reject) => {
      let sql = `
        SELECT * FROM messages 
        WHERE (message_content LIKE ? OR sender_name LIKE ? OR chat_name LIKE ?)
      `;
      let params = [`%${query}%`, `%${query}%`, `%${query}%`];

      if (chatId) {
        sql += ` AND chat_id = ?`;
        params.push(chatId);
      }

      sql += ` ORDER BY created_at DESC LIMIT 100`;

      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  // Save report
  async saveReport(reportData) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO reports (report_type, report_data, generated_by, file_path)
        VALUES (?, ?, ?, ?)
      `);

      stmt.run([
        reportData.type,
        JSON.stringify(reportData.data),
        reportData.generatedBy,
        reportData.filePath
      ], function(err) {
        stmt.finalize();
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  // Database maintenance
  async vacuum() {
    return new Promise((resolve, reject) => {
      this.db.run('VACUUM', (err) => {
        if (err) {
          reject(err);
        } else {
          logger.info('Database vacuum completed');
          resolve();
        }
      });
    });
  }

  async backup(backupPath) {
    return new Promise((resolve, reject) => {
      this.db.backup(backupPath, (err) => {
        if (err) {
          reject(err);
        } else {
          logger.info(`Database backup created: ${backupPath}`);
          resolve();
        }
      });
    });
  }

  // Close database connection
  async close() {
    return new Promise((resolve) => {
      if (this.db && this.isConnected) {
        this.db.close((err) => {
          if (err) {
            logger.error('Database close error:', err);
          } else {
            logger.info('Database connection closed');
          }
          this.isConnected = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // Health check
  isHealthy() {
    return this.isConnected && this.db !== null;
  }
}

export default Database;