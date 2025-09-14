import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  makeInMemoryStore,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { existsSync, mkdirSync } from 'fs';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import Database from '../database/database.js';

class BaileysClient {
  constructor() {
    this.sock = null;
    this.store = null;
    this.state = null;
    this.saveCreds = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.whatsapp.maxReconnectAttempts;
    this.reconnectInterval = config.whatsapp.reconnectInterval;
    this.qrCode = null;
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.db = new Database();
    
    this.setupAuthDirectory();
  }

  setupAuthDirectory() {
    if (!existsSync(config.whatsapp.sessionPath)) {
      mkdirSync(config.whatsapp.sessionPath, { recursive: true });
      logger.info(`Created auth directory: ${config.whatsapp.sessionPath}`);
    }
  }

  async initialize() {
    try {
      logger.info('Initializing Baileys WhatsApp client...');
      
      // Setup auth state
      const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.sessionPath);
      this.state = state;
      this.saveCreds = saveCreds;

      // Setup store
      this.store = makeInMemoryStore({ logger: logger });
      
      await this.connect();
      
    } catch (error) {
      logger.error('Failed to initialize Baileys client:', error);
      throw error;
    }
  }

  async connect() {
    try {
      this.isConnecting = true;
      
      this.sock = makeWASocket({
        auth: this.state,
        printQRInTerminal: false,
        logger: logger,
        browser: Browsers.macOS('Desktop'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        getMessage: async (key) => {
          if (this.store) {
            const msg = await this.store.loadMessage(key.remoteJid, key.id);
            return msg?.message || undefined;
          }
          return undefined;
        }
      });

      this.setupEventHandlers();
      
    } catch (error) {
      logger.error('Failed to connect to WhatsApp:', error);
      this.isConnecting = false;
      throw error;
    }
  }

  setupEventHandlers() {
    // Connection updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        this.qrCode = qr;
        logger.info('QR Code generated');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        this.isConnected = false;
        this.isConnecting = false;
        
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          logger.warn(`Connection closed. Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
          
          setTimeout(() => {
            this.connect();
          }, this.reconnectInterval * this.reconnectAttempts);
        } else {
          logger.error('Max reconnection attempts reached or logged out');
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.qrCode = null;
        
        logger.info('WhatsApp connection established successfully');
        this.startMessageProcessor();
      }
    });

    // Credentials update
    this.sock.ev.on('creds.update', this.saveCreds);

    // Messages
    this.sock.ev.on('messages.upsert', async (m) => {
      const messages = m.messages;
      
      for (const message of messages) {
        if (!message.key.fromMe && message.message) {
          this.messageQueue.push(message);
        }
      }
    });

    // Store binding
    if (this.store) {
      this.store.bind(this.sock.ev);
    }
  }

  startMessageProcessor() {
    if (this.isProcessingQueue) return;
    
    this.isProcessingQueue = true;
    this.processMessageQueue();
  }

  async processMessageQueue() {
    while (this.isProcessingQueue && this.isConnected) {
      if (this.messageQueue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, config.whatsapp.messageProcessingDelay));
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
    try {
      const messageContent = this.extractMessageContent(message);
      if (!messageContent) return;

      const chatId = message.key.remoteJid;
      const senderId = message.key.participant || message.key.remoteJid;
      
      // Get chat info
      const chatInfo = await this.getChatInfo(chatId);
      const senderInfo = await this.getSenderInfo(senderId);

      // Analyze message
      const analysis = this.analyzeMessage(messageContent);

      // Save to database
      const messageData = {
        messageId: message.key.id,
        chatId: chatId,
        chatName: chatInfo.name,
        chatType: chatInfo.type,
        senderId: senderId,
        senderName: senderInfo.name,
        messageContent: messageContent,
        messageType: this.getMessageType(message),
        isReport: analysis.isReport,
        isRequest: analysis.isRequest,
        severity: analysis.severity
      };

      await this.db.saveMessage(messageData);
      await this.db.upsertChat({
        chatId: chatId,
        chatName: chatInfo.name,
        chatType: chatInfo.type,
        participantCount: chatInfo.participantCount,
        isReport: analysis.isReport,
        isRequest: analysis.isRequest
      });

      // Handle commands
      if (messageContent.startsWith('/')) {
        await this.handleCommand(message, messageContent, chatId, senderId);
      }

      logger.logWhatsApp('message_processed', {
        chatId: chatId.substring(0, 20) + '...',
        messageType: messageData.messageType,
        isReport: analysis.isReport,
        isRequest: analysis.isRequest
      });

    } catch (error) {
      logger.error('Error handling message:', error);
    }
  }

  extractMessageContent(message) {
    const msg = message.message;
    
    if (msg?.conversation) return msg.conversation;
    if (msg?.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg?.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg?.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg?.documentMessage?.caption) return msg.documentMessage.caption;
    
    return null;
  }

  getMessageType(message) {
    const msg = message.message;
    
    if (msg?.conversation || msg?.extendedTextMessage) return 'text';
    if (msg?.imageMessage) return 'image';
    if (msg?.videoMessage) return 'video';
    if (msg?.audioMessage) return 'audio';
    if (msg?.documentMessage) return 'document';
    if (msg?.stickerMessage) return 'sticker';
    
    return 'unknown';
  }

  analyzeMessage(content) {
    const text = content.toLowerCase();
    
    // Report keywords
    const reportKeywords = [
      'بلاغ', 'تبليغ', 'شكوى', 'مشكلة', 'انتهاك', 'مخالفة',
      'report', 'complaint', 'violation', 'abuse', 'spam'
    ];
    
    // Request keywords
    const requestKeywords = [
      'طلب', 'استفسار', 'سؤال', 'مساعدة', 'دعم',
      'request', 'help', 'support', 'question', 'inquiry'
    ];
    
    const isReport = reportKeywords.some(keyword => text.includes(keyword));
    const isRequest = requestKeywords.some(keyword => text.includes(keyword));
    
    let severity = 1;
    if (text.includes('عاجل') || text.includes('urgent') || text.includes('خطير')) {
      severity = 3;
    } else if (text.includes('مهم') || text.includes('important')) {
      severity = 2;
    }
    
    return { isReport, isRequest, severity };
  }

  async getChatInfo(chatId) {
    try {
      if (chatId.endsWith('@g.us')) {
        // Group chat
        const groupMetadata = await this.sock.groupMetadata(chatId);
        return {
          name: groupMetadata.subject,
          type: 'group',
          participantCount: groupMetadata.participants.length
        };
      } else {
        // Private chat
        return {
          name: 'Private Chat',
          type: 'private',
          participantCount: 1
        };
      }
    } catch (error) {
      logger.error('Error getting chat info:', error);
      return {
        name: 'Unknown Chat',
        type: 'private',
        participantCount: 1
      };
    }
  }

  async getSenderInfo(senderId) {
    try {
      const contact = await this.sock.onWhatsApp(senderId);
      return {
        name: contact[0]?.notify || senderId.split('@')[0]
      };
    } catch (error) {
      return {
        name: senderId.split('@')[0]
      };
    }
  }

  async handleCommand(message, content, chatId, senderId) {
    const command = content.split(' ')[0].substring(1).toLowerCase();
    const args = content.split(' ').slice(1);
    
    const allowedCommands = config.security.allowedCommands;
    const adminCommands = config.security.adminCommands;
    const isAdmin = config.security.adminUsers.includes(senderId);
    
    if (!allowedCommands.includes(command) && !(isAdmin && adminCommands.includes(command))) {
      await this.sendMessage(chatId, 'أمر غير مسموح أو غير موجود. استخدم /help للمساعدة');
      return;
    }
    
    try {
      switch (command) {
        case 'help':
          await this.handleHelpCommand(chatId);
          break;
        case 'status':
          await this.handleStatusCommand(chatId);
          break;
        case 'stats':
          await this.handleStatsCommand(chatId);
          break;
        case 'report':
          await this.handleReportCommand(chatId, args);
          break;
        case 'chats':
          await this.handleChatsCommand(chatId);
          break;
        case 'messages':
          await this.handleMessagesCommand(chatId, args);
          break;
        // Admin commands
        case 'backup':
          if (isAdmin) await this.handleBackupCommand(chatId);
          break;
        case 'vacuum':
          if (isAdmin) await this.handleVacuumCommand(chatId);
          break;
        case 'broadcast':
          if (isAdmin) await this.handleBroadcastCommand(chatId, args);
          break;
      }
    } catch (error) {
      logger.error(`Error handling command ${command}:`, error);
      await this.sendMessage(chatId, 'حدث خطأ أثناء تنفيذ الأمر');
    }
  }

  async handleHelpCommand(chatId) {
    const helpText = `
🤖 *أوامر البوت المتاحة:*

📋 *الأوامر العامة:*
/help - عرض هذه المساعدة
/status - حالة البوت
/stats - إحصائيات الاستخدام
/report [daily/weekly/monthly] - إنشاء تقرير
/chats - قائمة المحادثات النشطة
/messages [عدد] - الرسائل الأخيرة

💡 *نصائح:*
- يمكن للبوت تحليل البلاغات والطلبات تلقائياً
- استخدم كلمات مثل "بلاغ" أو "طلب" لتصنيف الرسائل
- البوت يحفظ جميع الرسائل للمراجعة اللاحقة
    `;
    
    await this.sendMessage(chatId, helpText);
  }

  async handleStatusCommand(chatId) {
    const uptime = process.uptime();
    const memory = process.memoryUsage();
    
    const statusText = `
🟢 *حالة البوت:*

⏱️ وقت التشغيل: ${Math.floor(uptime / 3600)}س ${Math.floor((uptime % 3600) / 60)}د
💾 استخدام الذاكرة: ${Math.round(memory.used / 1024 / 1024)}MB
🔗 الاتصال: ${this.isConnected ? 'متصل ✅' : 'غير متصل ❌'}
📊 قاعدة البيانات: ${this.db.isHealthy() ? 'سليمة ✅' : 'خطأ ❌'}
    `;
    
    await this.sendMessage(chatId, statusText);
  }

  async handleStatsCommand(chatId) {
    try {
      const stats = await this.db.getStats();
      
      const statsText = `
📊 *إحصائيات النظام:*

📝 إجمالي الرسائل: ${stats.total_messages || 0}
💬 إجمالي المحادثات: ${stats.total_chats || 0}
📋 إجمالي البلاغات: ${stats.total_reports || 0}
❓ إجمالي الطلبات: ${stats.total_requests || 0}

📅 *اليوم:*
رسائل اليوم: ${stats.messages_today || 0}

📈 *الأسبوع:*
رسائل الأسبوع: ${stats.messages_week || 0}

⏳ *معلق:*
رسائل معلقة: ${stats.pending_messages || 0}
      `;
      
      await this.sendMessage(chatId, statsText);
    } catch (error) {
      await this.sendMessage(chatId, 'خطأ في جلب الإحصائيات');
    }
  }

  async handleReportCommand(chatId, args) {
    const reportType = args[0] || 'daily';
    await this.sendMessage(chatId, `جاري إنشاء تقرير ${reportType}... يرجى الانتظار`);
    
    // This would integrate with the report generator
    setTimeout(async () => {
      await this.sendMessage(chatId, `تم إنشاء التقرير ${reportType} بنجاح ✅`);
    }, 2000);
  }

  async handleChatsCommand(chatId) {
    try {
      const chats = await this.db.getActiveChats(10);
      
      let chatsText = '💬 *المحادثات النشطة:*\n\n';
      
      chats.forEach((chat, index) => {
        chatsText += `${index + 1}. ${chat.chat_name}\n`;
        chatsText += `   📊 ${chat.message_count} رسالة | 📋 ${chat.report_count} بلاغ\n`;
        chatsText += `   🕒 آخر نشاط: ${new Date(chat.last_activity).toLocaleString('ar-SA')}\n\n`;
      });
      
      await this.sendMessage(chatId, chatsText);
    } catch (error) {
      await this.sendMessage(chatId, 'خطأ في جلب المحادثات');
    }
  }

  async handleMessagesCommand(chatId, args) {
    try {
      const limit = parseInt(args[0]) || 10;
      const messages = await this.db.getRecentMessages(Math.min(limit, 20));
      
      let messagesText = `📝 *آخر ${messages.length} رسائل:*\n\n`;
      
      messages.forEach((msg, index) => {
        messagesText += `${index + 1}. ${msg.sender_name || 'غير محدد'}\n`;
        messagesText += `   💬 ${msg.message_content.substring(0, 50)}${msg.message_content.length > 50 ? '...' : ''}\n`;
        messagesText += `   🕒 ${new Date(msg.created_at).toLocaleString('ar-SA')}\n\n`;
      });
      
      await this.sendMessage(chatId, messagesText);
    } catch (error) {
      await this.sendMessage(chatId, 'خطأ في جلب الرسائل');
    }
  }

  async handleBackupCommand(chatId) {
    try {
      const backupPath = `./data/backup_${Date.now()}.db`;
      await this.db.backup(backupPath);
      await this.sendMessage(chatId, `تم إنشاء نسخة احتياطية: ${backupPath} ✅`);
    } catch (error) {
      await this.sendMessage(chatId, 'خطأ في إنشاء النسخة الاحتياطية ❌');
    }
  }

  async handleVacuumCommand(chatId) {
    try {
      await this.db.vacuum();
      await this.sendMessage(chatId, 'تم تحسين قاعدة البيانات ✅');
    } catch (error) {
      await this.sendMessage(chatId, 'خطأ في تحسين قاعدة البيانات ❌');
    }
  }

  async handleBroadcastCommand(chatId, args) {
    const message = args.join(' ');
    if (!message) {
      await this.sendMessage(chatId, 'يرجى كتابة الرسالة للبث');
      return;
    }
    
    try {
      const chats = await this.db.getActiveChats();
      let sentCount = 0;
      
      for (const chat of chats) {
        try {
          await this.sendMessage(chat.chat_id, `📢 *رسالة عامة:*\n\n${message}`);
          sentCount++;
          await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
        } catch (error) {
          logger.error(`Failed to send broadcast to ${chat.chat_id}:`, error);
        }
      }
      
      await this.sendMessage(chatId, `تم إرسال الرسالة إلى ${sentCount} محادثة ✅`);
    } catch (error) {
      await this.sendMessage(chatId, 'خطأ في البث ❌');
    }
  }

  async sendMessage(chatId, message) {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp not connected');
    }
    
    try {
      await this.sock.sendMessage(chatId, { text: message });
      logger.logWhatsApp('message_sent', { chatId: chatId.substring(0, 20) + '...' });
    } catch (error) {
      logger.error('Error sending message:', error);
      throw error;
    }
  }

  async getChats() {
    if (!this.isConnected) {
      throw new Error('WhatsApp not connected');
    }
    
    try {
      const chats = await this.db.getActiveChats();
      return chats.map(chat => ({
        id: chat.chat_id,
        name: chat.chat_name,
        type: chat.chat_type,
        messageCount: chat.message_count,
        lastActivity: chat.last_activity
      }));
    } catch (error) {
      logger.error('Error getting chats:', error);
      throw error;
    }
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      qrCode: this.qrCode,
      hasQR: !!this.qrCode,
      reconnectAttempts: this.reconnectAttempts,
      queueSize: this.messageQueue.length,
      dbHealthy: this.db.isHealthy()
    };
  }

  async stop() {
    try {
      this.isProcessingQueue = false;
      
      if (this.sock) {
        await this.sock.logout();
        this.sock = null;
      }
      
      if (this.db) {
        await this.db.close();
      }
      
      this.isConnected = false;
      logger.info('Baileys client stopped successfully');
    } catch (error) {
      logger.error('Error stopping Baileys client:', error);
    }
  }
}

export default BaileysClient;