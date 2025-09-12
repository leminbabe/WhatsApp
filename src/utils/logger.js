const winston = require('winston');
const path = require('path');

// إنشاء مجلد السجلات إذا لم يكن موجوداً
const fs = require('fs');
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// تكوين Winston
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'whatsapp-reports-bot' },
  transports: [
    // كتابة جميع السجلات في combined.log
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // كتابة الأخطاء فقط في error.log
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // سجلات التطبيق في app.log
    new winston.transports.File({ 
      filename: path.join(logsDir, 'app.log'),
      level: 'info',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// إضافة سجلات وحدة التحكم في بيئة التطوير
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(meta).length > 0) {
          msg += ` ${JSON.stringify(meta)}`;
        }
        return msg;
      })
    )
  }));
}

// دالات مساعدة للسجلات المخصصة
logger.logReport = (reportData) => {
  logger.info('New report received', {
    type: 'report',
    chatId: reportData.chatId,
    chatName: reportData.chatName,
    senderId: reportData.senderId,
    reportType: reportData.reportType,
    severity: reportData.severity
  });
};

logger.logAlert = (alertData) => {
  logger.warn('Alert triggered', {
    type: 'alert',
    alertType: alertData.type,
    chatId: alertData.chatId,
    message: alertData.message
  });
};

logger.logWhatsAppEvent = (eventType, data) => {
  logger.info('WhatsApp event', {
    type: 'whatsapp_event',
    eventType: eventType,
    data: data
  });
};

logger.logAPIRequest = (req, res, responseTime) => {
  logger.info('API request', {
    type: 'api_request',
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    statusCode: res.statusCode,
    responseTime: responseTime
  });
};

logger.logDatabaseOperation = (operation, table, data) => {
  logger.debug('Database operation', {
    type: 'database',
    operation: operation,
    table: table,
    data: data
  });
};

// معالجة الأخطاء غير المتوقعة
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = logger;