const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class Database {
  constructor() {
    this.dbPath = path.join(__dirname, '../../data/reports.db');
    this.ensureDataDirectory();
    this.db = new sqlite3.Database(this.dbPath);
    this.db.configure('busyTimeout', 30000);
    this.initTables();
    this.createIndexes();
  }

  ensureDataDirectory() {
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  initTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE NOT NULL,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        chat_type TEXT CHECK(chat_type IN ('group', 'private')) DEFAULT 'private',
        sender_id TEXT NOT NULL,
        sender_name TEXT,
        message_content TEXT NOT NULL,
        report_type TEXT CHECK(report_type IN ('spam', 'violation', 'inappropriate', 'general')) DEFAULT 'general',
        severity INTEGER CHECK(severity BETWEEN 1 AND 3) DEFAULT 1,
        status TEXT CHECK(status IN ('pending', 'reviewed', 'resolved', 'dismissed')) DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE NOT NULL,
        chat_name TEXT,
        chat_type TEXT CHECK(chat_type IN ('group', 'private')) DEFAULT 'private',
        participant_count INTEGER DEFAULT 0,
        reports_count INTEGER DEFAULT 0,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_monitored BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        message TEXT NOT NULL,
        severity INTEGER DEFAULT 1,
        is_sent BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    tables.forEach(sql => {
      this.db.run(sql, (err) => {
        if (err) console.error('Table creation error:', err);
      });
    });
  }

  createIndexes() {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_reports_chat_id ON reports(chat_id)',
      'CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)',
      'CREATE INDEX IF NOT EXISTS idx_channels_chat_id ON channels(chat_id)',
      'CREATE INDEX IF NOT EXISTS idx_alerts_chat_id ON alerts(chat_id)'
    ];

    indexes.forEach(sql => {
      this.db.run(sql, (err) => {
        if (err) console.error('Index creation error:', err);
      });
    });
  }

  async addReport(reportData) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO reports (
          message_id, chat_id, chat_name, chat_type, 
          sender_id, sender_name, message_content, 
          report_type, severity
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run([
        reportData.messageId,
        reportData.chatId,
        reportData.chatName,
        reportData.chatType,
        reportData.senderId,
        reportData.senderName,
        reportData.messageContent,
        reportData.reportType,
        reportData.severity
      ], function(err) {
        stmt.finalize();
        if (err) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            resolve(null); // Duplicate message, ignore
          } else {
            reject(err);
          }
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  async upsertChannel(channelData) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO channels (
          chat_id, chat_name, chat_type, participant_count, 
          reports_count, last_activity, updated_at
        ) VALUES (
          ?, ?, ?, ?, 
          COALESCE((SELECT reports_count FROM channels WHERE chat_id = ?), 0),
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `);

      stmt.run([
        channelData.chatId,
        channelData.chatName,
        channelData.chatType,
        channelData.participantCount,
        channelData.chatId
      ], function(err) {
        stmt.finalize();
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  async incrementChannelReports(chatId) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        UPDATE channels 
        SET reports_count = reports_count + 1, 
            last_activity = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE chat_id = ?
      `);

      stmt.run([chatId], function(err) {
        stmt.finalize();
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  async getGeneralStats() {
    return new Promise((resolve, reject) => {
      this.db.get(`
        SELECT 
          COUNT(*) as total_reports,
          COUNT(DISTINCT chat_id) as total_channels,
          COUNT(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 END) as reports_today,
          COUNT(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 END) as reports_this_week,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_reports,
          COUNT(CASE WHEN severity >= 3 THEN 1 END) as high_severity_reports
        FROM reports
      `, [], (err, row) => {
        if (err) reject(err);
        else resolve(row || {});
      });
    });
  }

  async getAllChannelsWithStats() {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT 
          c.*,
          COALESCE(r.total_reports, 0) as total_reports,
          COALESCE(r.reports_today, 0) as reports_today,
          COALESCE(r.reports_last_week, 0) as reports_last_week
        FROM channels c
        LEFT JOIN (
          SELECT 
            chat_id,
            COUNT(*) as total_reports,
            COUNT(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 END) as reports_today,
            COUNT(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 END) as reports_last_week
          FROM reports
          GROUP BY chat_id
        ) r ON c.chat_id = r.chat_id
        ORDER BY c.reports_count DESC, c.last_activity DESC
        LIMIT 100
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getRecentReports(limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT * FROM reports 
        ORDER BY created_at DESC 
        LIMIT ?
      `, [Math.min(limit, 1000)], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async searchReports(query, chatId = null) {
    return new Promise((resolve, reject) => {
      let sql = `
        SELECT * FROM reports 
        WHERE (message_content LIKE ? OR sender_name LIKE ? OR chat_name LIKE ?)
      `;
      let params = [`%${query}%`, `%${query}%`, `%${query}%`];

      if (chatId) {
        sql += ` AND chat_id = ?`;
        params.push(chatId);
      }

      sql += ` ORDER BY created_at DESC LIMIT 100`;

      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      this.db.close((err) => {
        if (err) console.error('Database close error:', err);
        resolve();
      });
    });
  }
}

module.exports = Database;