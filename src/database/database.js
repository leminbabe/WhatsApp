const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
  constructor() {
    this.db = new sqlite3.Database(path.join(__dirname, '../../data/reports.db'));
    this.initTables();
  }

  initTables() {
    // جدول البلاغات
    this.db.run(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        chat_type TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT,
        message_content TEXT,
        report_type TEXT,
        severity INTEGER DEFAULT 1,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول القنوات والمجموعات
    this.db.run(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE NOT NULL,
        chat_name TEXT,
        chat_type TEXT,
        participant_count INTEGER DEFAULT 0,
        reports_count INTEGER DEFAULT 0,
        last_activity DATETIME,
        is_monitored BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول الإحصائيات
    this.db.run(`
      CREATE TABLE IF NOT EXISTS statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE NOT NULL,
        chat_id TEXT,
        reports_count INTEGER DEFAULT 0,
        requests_count INTEGER DEFAULT 0,
        total_messages INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول التنبيهات
    this.db.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        message TEXT,
        is_sent BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  // إضافة بلاغ جديد
  addReport(reportData) {
    return new Promise((resolve, reject) => {
      const {
        messageId, chatId, chatName, chatType, senderId, 
        senderName, messageContent, reportType, severity
      } = reportData;

      this.db.run(`
        INSERT INTO reports (
          message_id, chat_id, chat_name, chat_type, 
          sender_id, sender_name, message_content, 
          report_type, severity
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [messageId, chatId, chatName, chatType, senderId, senderName, messageContent, reportType, severity],
      function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  // تحديث أو إضافة قناة
  upsertChannel(channelData) {
    return new Promise((resolve, reject) => {
      const { chatId, chatName, chatType, participantCount } = channelData;
      
      this.db.run(`
        INSERT OR REPLACE INTO channels (
          chat_id, chat_name, chat_type, participant_count, 
          reports_count, last_activity, updated_at
        ) VALUES (
          ?, ?, ?, ?, 
          COALESCE((SELECT reports_count FROM channels WHERE chat_id = ?), 0),
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `, [chatId, chatName, chatType, participantCount, chatId],
      function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  // زيادة عدد البلاغات للقناة
  incrementChannelReports(chatId) {
    return new Promise((resolve, reject) => {
      this.db.run(`
        UPDATE channels 
        SET reports_count = reports_count + 1, 
            last_activity = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE chat_id = ?
      `, [chatId], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  // الحصول على إحصائيات القناة
  getChannelStats(chatId) {
    return new Promise((resolve, reject) => {
      this.db.get(`
        SELECT 
          c.*,
          COUNT(r.id) as total_reports,
          COUNT(CASE WHEN r.created_at >= date('now', '-7 days') THEN 1 END) as reports_last_week,
          COUNT(CASE WHEN r.created_at >= date('now', '-1 day') THEN 1 END) as reports_today
        FROM channels c
        LEFT JOIN reports r ON c.chat_id = r.chat_id
        WHERE c.chat_id = ?
        GROUP BY c.id
      `, [chatId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  // الحصول على جميع القنوات مع الإحصائيات
  getAllChannelsWithStats() {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT 
          c.*,
          COUNT(r.id) as total_reports,
          COUNT(CASE WHEN r.created_at >= date('now', '-7 days') THEN 1 END) as reports_last_week,
          COUNT(CASE WHEN r.created_at >= date('now', '-1 day') THEN 1 END) as reports_today,
          MAX(r.created_at) as last_report_date
        FROM channels c
        LEFT JOIN reports r ON c.chat_id = r.chat_id
        GROUP BY c.id
        ORDER BY c.reports_count DESC, c.last_activity DESC
      `, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // الحصول على البلاغات الأخيرة
  getRecentReports(limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT * FROM reports 
        ORDER BY created_at DESC 
        LIMIT ?
      `, [limit], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // البحث في البلاغات
  searchReports(query, chatId = null) {
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
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // الحصول على الإحصائيات العامة
  getGeneralStats() {
    return new Promise((resolve, reject) => {
      this.db.get(`
        SELECT 
          COUNT(*) as total_reports,
          COUNT(DISTINCT chat_id) as total_channels,
          COUNT(CASE WHEN created_at >= date('now', '-1 day') THEN 1 END) as reports_today,
          COUNT(CASE WHEN created_at >= date('now', '-7 days') THEN 1 END) as reports_this_week,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_reports,
          COUNT(CASE WHEN severity >= 3 THEN 1 END) as high_severity_reports
        FROM reports
      `, [], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  // إضافة تنبيه
  addAlert(chatId, alertType, message) {
    return new Promise((resolve, reject) => {
      this.db.run(`
        INSERT INTO alerts (chat_id, alert_type, message)
        VALUES (?, ?, ?)
      `, [chatId, alertType, message], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  // الحصول على التنبيهات غير المرسلة
  getUnsentAlerts() {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT * FROM alerts 
        WHERE is_sent = 0 
        ORDER BY created_at ASC
      `, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // تحديث حالة التنبيه
  markAlertAsSent(alertId) {
    return new Promise((resolve, reject) => {
      this.db.run(`
        UPDATE alerts 
        SET is_sent = 1 
        WHERE id = ?
      `, [alertId], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = Database;