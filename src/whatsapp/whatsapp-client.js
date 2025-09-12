const { Client, LocalAuth } = require('whatsapp-web.js');
const Database = require('../database/database');
const logger = require('../utils/logger');

class WhatsAppClient {
  constructor() {
    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: './data/auth'
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ],
        timeout: 60000
      }
    });

    this.db = new Database();
    this.isReady = false;
    this.qrCode = null;
    this.messageQueue = [];
    this.processing = false;
    
    this.reportKeywords = new Set([
      'بلاغ', 'تبليغ', 'شكوى', 'مشكلة', 'انتهاك', 'مخالفة',
      'report', 'complaint', 'violation', 'abuse', 'spam'
    ]);
    
    this.requestKeywords = new Set([
      'طلب', 'استفسار', 'سؤال', 'مساعدة', 'دعم',
      'request', 'help', 'support', 'question', 'inquiry'
    ]);

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.on('qr', (qr) => {
      this.qrCode = qr;
      logger.info('QR Code generated for WhatsApp authentication');
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.qrCode = null;
      logger.info('WhatsApp client connected successfully');
      this.startMessageProcessor();
    });

    this.client.on('message', (message) => {
      this.messageQueue.push(message);
    });

    this.client.on('disconnected', (reason) => {
      this.isReady = false;
      logger.warn('WhatsApp client disconnected:', reason);
    });

    this.client.on('auth_failure', (message) => {
      logger.error('WhatsApp authentication failed:', message);
    });
  }

  startMessageProcessor() {
    if (this.processing) return;
    
    this.processing = true;
    this.processMessageQueue();
  }

  async processMessageQueue() {
    while (this.processing && this.isReady) {
      if (this.messageQueue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const message = this.messageQueue.shift();
      try {
        await this.handleMessage(message);
      } catch (error) {
        logger.error('Error processing message:', error);
      }
    }
  }

  async handleMessage(message) {
    if (!message.body || message.fromMe) return;

    const chat = await message.getChat();
    const contact = await message.getContact();
    
    await this.updateChannelInfo(chat);
    
    const analysis = this.analyzeMessage(message.body);
    
    if (analysis.isReport) {
      await this.handleReport(message, chat, contact, analysis);
    }
  }

  analyzeMessage(messageBody) {
    const text = messageBody.toLowerCase();
    
    const isReport = Array.from(this.reportKeywords).some(keyword => 
      text.includes(keyword.toLowerCase())
    );
    
    const isRequest = Array.from(this.requestKeywords).some(keyword => 
      text.includes(keyword.toLowerCase())
    );
    
    let severity = 1;
    if (text.includes('عاجل') || text.includes('urgent') || text.includes('خطير')) {
      severity = 3;
    } else if (text.includes('مهم') || text.includes('important')) {
      severity = 2;
    }
    
    let reportType = 'general';
    if (text.includes('سبام') || text.includes('spam')) {
      reportType = 'spam';
    } else if (text.includes('انتهاك') || text.includes('violation')) {
      reportType = 'violation';
    } else if (text.includes('محتوى غير لائق') || text.includes('inappropriate')) {
      reportType = 'inappropriate';
    }
    
    return { isReport, isRequest, severity, reportType };
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
        messageContent: message.body.substring(0, 1000), // Limit content length
        reportType: analysis.reportType,
        severity: analysis.severity
      };

      const reportId = await this.db.addReport(reportData);
      
      if (reportId) {
        await this.db.incrementChannelReports(chat.id._serialized);
        logger.info(`Report processed: ${reportId}`);
      }
      
    } catch (error) {
      logger.error('Error handling report:', error);
    }
  }

  async updateChannelInfo(chat) {
    try {
      let participantCount = 0;
      
      if (chat.isGroup && chat.participants) {
        participantCount = chat.participants.length;
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

  getStatus() {
    return {
      isReady: this.isReady,
      qrCode: this.qrCode,
      hasQR: !!this.qrCode,
      queueSize: this.messageQueue.length
    };
  }

  async start() {
    try {
      await this.client.initialize();
      logger.info('WhatsApp client initialization started');
    } catch (error) {
      logger.error('Error starting WhatsApp client:', error);
      throw error;
    }
  }

  async stop() {
    try {
      this.processing = false;
      await this.client.destroy();
      await this.db.close();
      logger.info('WhatsApp client stopped');
    } catch (error) {
      logger.error('Error stopping WhatsApp client:', error);
    }
  }

  async getChats() {
    if (!this.isReady) {
      throw new Error('WhatsApp client is not ready');
    }
    
    const chats = await this.client.getChats();
    return chats.slice(0, 100).map(chat => ({
      id: chat.id._serialized,
      name: chat.name || 'Private Chat',
      isGroup: chat.isGroup,
      participantCount: chat.participants ? chat.participants.length : 0
    }));
  }

  async sendMessage(chatId, message) {
    if (!this.isReady) {
      throw new Error('WhatsApp client is not ready');
    }
    
    await this.client.sendMessage(chatId, message);
    logger.info(`Message sent to ${chatId}`);
  }
}

module.exports = WhatsAppClient;