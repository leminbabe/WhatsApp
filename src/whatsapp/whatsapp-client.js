const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Database = require('../database/database');
const logger = require('../utils/logger');
const NotificationService = require('../notifications/notification-service');

class WhatsAppClient {
  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      }
    });

    this.db = new Database();
    this.notificationService = new NotificationService();
    this.isReady = false;
    this.qrCode = null;
    
    this.setupEventHandlers();
    this.reportKeywords = [
      'بلاغ', 'تبليغ', 'شكوى', 'مشكلة', 'انتهاك', 'مخالفة',
      'report', 'complaint', 'violation', 'abuse', 'spam'
    ];
    
    this.requestKeywords = [
      'طلب', 'استفسار', 'سؤال', 'مساعدة', 'دعم',
      'request', 'help', 'support', 'question', 'inquiry'
    ];
  }

  setupEventHandlers() {
    // عرض رمز QR للمصادقة
    this.client.on('qr', (qr) => {
      console.log('QR Code received, scan please!');
      qrcode.generate(qr, { small: true });
      this.qrCode = qr;
      logger.info('QR Code generated for WhatsApp authentication');
    });

    // عند الاتصال بنجاح
    this.client.on('ready', () => {
      console.log('WhatsApp Client is ready!');
      this.isReady = true;
      this.qrCode = null;
      logger.info('WhatsApp client connected successfully');
      this.startMonitoring();
    });

    // عند استقبال رسالة جديدة
    this.client.on('message', async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        logger.error('Error handling message:', error);
      }
    });

    // عند انضمام عضو جديد للمجموعة
    this.client.on('group_join', async (notification) => {
      try {
        await this.handleGroupJoin(notification);
      } catch (error) {
        logger.error('Error handling group join:', error);
      }
    });

    // عند مغادرة عضو للمجموعة
    this.client.on('group_leave', async (notification) => {
      try {
        await this.handleGroupLeave(notification);
      } catch (error) {
        logger.error('Error handling group leave:', error);
      }
    });

    // معالجة الأخطاء
    this.client.on('disconnected', (reason) => {
      console.log('WhatsApp Client was logged out:', reason);
      this.isReady = false;
      logger.warn('WhatsApp client disconnected:', reason);
    });

    this.client.on('auth_failure', (message) => {
      console.error('Authentication failed:', message);
      logger.error('WhatsApp authentication failed:', message);
    });
  }

  async handleMessage(message) {
    const chat = await message.getChat();
    const contact = await message.getContact();
    
    // تحديث معلومات القناة/المحادثة
    await this.updateChannelInfo(chat);
    
    // تحليل الرسالة للبحث عن البلاغات والطلبات
    const analysis = this.analyzeMessage(message.body);
    
    if (analysis.isReport) {
      await this.handleReport(message, chat, contact, analysis);
    } else if (analysis.isRequest) {
      await this.handleRequest(message, chat, contact, analysis);
    }

    // تسجيل النشاط
    logger.info(`Message received from ${contact.name || contact.number} in ${chat.name || chat.id.user}`);
  }

  analyzeMessage(messageBody) {
    const text = messageBody.toLowerCase();
    
    // فحص البلاغات
    const isReport = this.reportKeywords.some(keyword => 
      text.includes(keyword.toLowerCase())
    );
    
    // فحص الطلبات
    const isRequest = this.requestKeywords.some(keyword => 
      text.includes(keyword.toLowerCase())
    );
    
    // تحديد مستوى الخطورة
    let severity = 1;
    if (text.includes('عاجل') || text.includes('urgent') || text.includes('خطير')) {
      severity = 3;
    } else if (text.includes('مهم') || text.includes('important')) {
      severity = 2;
    }
    
    // تحديد نوع البلاغ
    let reportType = 'general';
    if (text.includes('سبام') || text.includes('spam')) {
      reportType = 'spam';
    } else if (text.includes('انتهاك') || text.includes('violation')) {
      reportType = 'violation';
    } else if (text.includes('محتوى غير لائق') || text.includes('inappropriate')) {
      reportType = 'inappropriate_content';
    }
    
    return {
      isReport,
      isRequest,
      severity,
      reportType,
      confidence: this.calculateConfidence(text, isReport, isRequest)
    };
  }

  calculateConfidence(text, isReport, isRequest) {
    let confidence = 0;
    
    if (isReport) {
      // زيادة الثقة بناءً على وجود كلمات مفتاحية إضافية
      if (text.includes('أريد تبليغ') || text.includes('want to report')) confidence += 0.3;
      if (text.includes('مشكلة في') || text.includes('problem with')) confidence += 0.2;
      if (text.includes('ضد القوانين') || text.includes('against rules')) confidence += 0.2;
    }
    
    if (isRequest) {
      if (text.includes('أريد طلب') || text.includes('i need')) confidence += 0.3;
      if (text.includes('مساعدة في') || text.includes('help with')) confidence += 0.2;
      if (text.includes('كيف') || text.includes('how to')) confidence += 0.2;
    }
    
    return Math.min(confidence, 1.0);
  }

  async handleReport(message, chat, contact, analysis) {
    try {
      const reportData = {
        messageId: message.id._serialized,
        chatId: chat.id._serialized,
        chatName: chat.name || 'Private Chat',
        chatType: chat.isGroup ? 'group' : 'private',
        senderId: contact.id._serialized,
        senderName: contact.name || contact.pushname || contact.number,
        messageContent: message.body,
        reportType: analysis.reportType,
        severity: analysis.severity
      };

      // حفظ البلاغ في قاعدة البيانات
      const reportId = await this.db.addReport(reportData);
      
      // تحديث عداد البلاغات للقناة
      await this.db.incrementChannelReports(chat.id._serialized);
      
      // إرسال تنبيه إذا كان البلاغ عالي الخطورة
      if (analysis.severity >= 2) {
        await this.sendHighSeverityAlert(reportData, reportId);
      }
      
      // إرسال رد تأكيد للمرسل
      await message.reply('تم استلام بلاغكم وسيتم مراجعته قريباً. شكراً لكم.');
      
      logger.info(`Report received and processed: ${reportId}`);
      
    } catch (error) {
      logger.error('Error handling report:', error);
      await message.reply('عذراً، حدث خطأ في معالجة بلاغكم. يرجى المحاولة مرة أخرى.');
    }
  }

  async handleRequest(message, chat, contact, analysis) {
    try {
      // تسجيل الطلب (يمكن إضافة جدول منفصل للطلبات)
      logger.info(`Request received from ${contact.name || contact.number}: ${message.body}`);
      
      // إرسال رد تلقائي
      await message.reply('تم استلام طلبكم وسيتم الرد عليه في أقرب وقت ممكن.');
      
    } catch (error) {
      logger.error('Error handling request:', error);
    }
  }

  async updateChannelInfo(chat) {
    try {
      let participantCount = 0;
      
      if (chat.isGroup) {
        participantCount = chat.participants ? chat.participants.length : 0;
      }
      
      const channelData = {
        chatId: chat.id._serialized,
        chatName: chat.name || 'Private Chat',
        chatType: chat.isGroup ? 'group' : 'private',
        participantCount: participantCount
      };
      
      await this.db.upsertChannel(channelData);
      
    } catch (error) {
      logger.error('Error updating channel info:', error);
    }
  }

  async sendHighSeverityAlert(reportData, reportId) {
    try {
      const alertMessage = `تنبيه: بلاغ عالي الخطورة
القناة: ${reportData.chatName}
المرسل: ${reportData.senderName}
المحتوى: ${reportData.messageContent.substring(0, 100)}...
معرف البلاغ: ${reportId}`;

      // إضافة التنبيه لقاعدة البيانات
      await this.db.addAlert(reportData.chatId, 'high_severity', alertMessage);
      
      // إرسال التنبيه عبر خدمة الإشعارات
      await this.notificationService.sendAlert({
        type: 'high_severity_report',
        chatId: reportData.chatId,
        chatName: reportData.chatName,
        message: alertMessage,
        reportId: reportId
      });
      
    } catch (error) {
      logger.error('Error sending high severity alert:', error);
    }
  }

  async handleGroupJoin(notification) {
    try {
      const chat = await notification.getChat();
      await this.updateChannelInfo(chat);
      logger.info(`New member joined group: ${chat.name}`);
    } catch (error) {
      logger.error('Error handling group join:', error);
    }
  }

  async handleGroupLeave(notification) {
    try {
      const chat = await notification.getChat();
      await this.updateChannelInfo(chat);
      logger.info(`Member left group: ${chat.name}`);
    } catch (error) {
      logger.error('Error handling group leave:', error);
    }
  }

  async startMonitoring() {
    // بدء مراقبة دورية للتنبيهات
    setInterval(async () => {
      try {
        await this.processUnsentAlerts();
      } catch (error) {
        logger.error('Error processing unsent alerts:', error);
      }
    }, 30000); // كل 30 ثانية

    logger.info('WhatsApp monitoring started');
  }

  async processUnsentAlerts() {
    try {
      const alerts = await this.db.getUnsentAlerts();
      
      for (const alert of alerts) {
        await this.notificationService.sendAlert({
          type: alert.alert_type,
          chatId: alert.chat_id,
          message: alert.message
        });
        
        await this.db.markAlertAsSent(alert.id);
      }
      
    } catch (error) {
      logger.error('Error processing unsent alerts:', error);
    }
  }

  // الحصول على معلومات الحالة
  getStatus() {
    return {
      isReady: this.isReady,
      qrCode: this.qrCode,
      hasQR: !!this.qrCode
    };
  }

  // بدء تشغيل العميل
  async start() {
    try {
      await this.client.initialize();
      logger.info('WhatsApp client initialization started');
    } catch (error) {
      logger.error('Error starting WhatsApp client:', error);
      throw error;
    }
  }

  // إيقاف العميل
  async stop() {
    try {
      await this.client.destroy();
      this.db.close();
      logger.info('WhatsApp client stopped');
    } catch (error) {
      logger.error('Error stopping WhatsApp client:', error);
    }
  }

  // الحصول على معلومات المحادثات
  async getChats() {
    try {
      if (!this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }
      
      const chats = await this.client.getChats();
      return chats.map(chat => ({
        id: chat.id._serialized,
        name: chat.name || 'Private Chat',
        isGroup: chat.isGroup,
        participantCount: chat.participants ? chat.participants.length : 0,
        lastMessage: chat.lastMessage ? {
          body: chat.lastMessage.body,
          timestamp: chat.lastMessage.timestamp
        } : null
      }));
      
    } catch (error) {
      logger.error('Error getting chats:', error);
      throw error;
    }
  }

  // إرسال رسالة
  async sendMessage(chatId, message) {
    try {
      if (!this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }
      
      await this.client.sendMessage(chatId, message);
      logger.info(`Message sent to ${chatId}`);
      
    } catch (error) {
      logger.error('Error sending message:', error);
      throw error;
    }
  }
}

module.exports = WhatsAppClient;