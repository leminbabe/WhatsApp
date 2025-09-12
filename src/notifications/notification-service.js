const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

class NotificationService {
  constructor() {
    this.webhookUrls = process.env.WEBHOOK_URLS ? process.env.WEBHOOK_URLS.split(',') : [];
    this.emailConfig = this.setupEmailConfig();
    this.alertThresholds = {
      high_severity: 1,
      spam_reports: 5,
      channel_reports: 10
    };
  }

  setupEmailConfig() {
    if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      logger.warn('Email configuration not found, email notifications disabled');
      return null;
    }

    return nodemailer.createTransporter({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT || 587,
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
  }

  async sendAlert(alertData) {
    const promises = [];

    // إرسال عبر Webhooks
    if (this.webhookUrls.length > 0) {
      promises.push(this.sendWebhookAlert(alertData));
    }

    // إرسال عبر البريد الإلكتروني
    if (this.emailConfig && process.env.ALERT_EMAIL_TO) {
      promises.push(this.sendEmailAlert(alertData));
    }

    // إرسال إشعار داخلي
    promises.push(this.sendInternalNotification(alertData));

    try {
      await Promise.allSettled(promises);
      logger.logAlert(alertData);
    } catch (error) {
      logger.error('Error sending alerts:', error);
    }
  }

  async sendWebhookAlert(alertData) {
    const payload = {
      timestamp: new Date().toISOString(),
      type: alertData.type,
      chatId: alertData.chatId,
      chatName: alertData.chatName,
      message: alertData.message,
      severity: alertData.severity || 'medium',
      reportId: alertData.reportId
    };

    const promises = this.webhookUrls.map(async (url) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'WhatsApp-Reports-Bot/1.0'
          },
          body: JSON.stringify(payload),
          timeout: 10000
        });

        if (!response.ok) {
          throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
        }

        logger.info(`Webhook alert sent successfully to ${url}`);
      } catch (error) {
        logger.error(`Failed to send webhook alert to ${url}:`, error);
      }
    });

    await Promise.allSettled(promises);
  }

  async sendEmailAlert(alertData) {
    if (!this.emailConfig) {
      return;
    }

    try {
      const subject = this.getEmailSubject(alertData);
      const htmlContent = this.generateEmailHTML(alertData);
      const textContent = this.generateEmailText(alertData);

      const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: process.env.ALERT_EMAIL_TO,
        subject: subject,
        text: textContent,
        html: htmlContent
      };

      await this.emailConfig.sendMail(mailOptions);
      logger.info('Email alert sent successfully');

    } catch (error) {
      logger.error('Failed to send email alert:', error);
    }
  }

  getEmailSubject(alertData) {
    const subjects = {
      'high_severity_report': '🚨 تنبيه: بلاغ عالي الخطورة',
      'spam_reports': '⚠️ تنبيه: بلاغات سبام متكررة',
      'channel_reports': '📊 تنبيه: زيادة في البلاغات',
      'system_alert': '🔧 تنبيه نظام'
    };

    return subjects[alertData.type] || '📢 تنبيه من بوت واتساب';
  }

  generateEmailHTML(alertData) {
    return `
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>تنبيه من بوت واتساب</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
            .content { padding: 20px; }
            .alert-info { background-color: #f8f9fa; border-right: 4px solid #dc3545; padding: 15px; margin: 15px 0; }
            .footer { background-color: #f8f9fa; padding: 15px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666; }
            .btn { display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🚨 تنبيه من بوت واتساب</h1>
            </div>
            <div class="content">
                <div class="alert-info">
                    <h3>تفاصيل التنبيه:</h3>
                    <p><strong>النوع:</strong> ${alertData.type}</p>
                    <p><strong>القناة:</strong> ${alertData.chatName || 'غير محدد'}</p>
                    <p><strong>الوقت:</strong> ${new Date().toLocaleString('ar-SA')}</p>
                    ${alertData.reportId ? `<p><strong>معرف البلاغ:</strong> ${alertData.reportId}</p>` : ''}
                </div>
                <div>
                    <h3>الرسالة:</h3>
                    <p>${alertData.message}</p>
                </div>
                <div style="text-align: center; margin: 20px 0;">
                    <a href="${process.env.DASHBOARD_URL || 'http://localhost:3000'}" class="btn">عرض لوحة التحكم</a>
                </div>
            </div>
            <div class="footer">
                <p>هذا تنبيه تلقائي من نظام مراقبة واتساب</p>
                <p>تم الإرسال في: ${new Date().toLocaleString('ar-SA')}</p>
            </div>
        </div>
    </body>
    </html>
    `;
  }

  generateEmailText(alertData) {
    return `
تنبيه من بوت واتساب

النوع: ${alertData.type}
القناة: ${alertData.chatName || 'غير محدد'}
الوقت: ${new Date().toLocaleString('ar-SA')}
${alertData.reportId ? `معرف البلاغ: ${alertData.reportId}` : ''}

الرسالة:
${alertData.message}

لعرض التفاصيل الكاملة، يرجى زيارة لوحة التحكم:
${process.env.DASHBOARD_URL || 'http://localhost:3000'}

---
هذا تنبيه تلقائي من نظام مراقبة واتساب
تم الإرسال في: ${new Date().toLocaleString('ar-SA')}
    `;
  }

  async sendInternalNotification(alertData) {
    // يمكن إضافة منطق إضافي هنا مثل حفظ الإشعار في قاعدة البيانات
    // أو إرساله عبر WebSocket للمستخدمين المتصلين
    
    logger.info('Internal notification processed', {
      type: alertData.type,
      chatId: alertData.chatId,
      message: alertData.message
    });
  }

  // فحص العتبات وإرسال التنبيهات التلقائية
  async checkThresholds(chatId, reportCount, reportType) {
    const alerts = [];

    // فحص عتبة البلاغات العالية الخطورة
    if (reportType === 'high_severity' && reportCount >= this.alertThresholds.high_severity) {
      alerts.push({
        type: 'high_severity_report',
        chatId: chatId,
        message: `تم تسجيل ${reportCount} بلاغ عالي الخطورة في هذه القناة`
      });
    }

    // فحص عتبة بلاغات السبام
    if (reportType === 'spam' && reportCount >= this.alertThresholds.spam_reports) {
      alerts.push({
        type: 'spam_reports',
        chatId: chatId,
        message: `تم تسجيل ${reportCount} بلاغ سبام في هذه القناة`
      });
    }

    // فحص العتبة العامة للبلاغات
    if (reportCount >= this.alertThresholds.channel_reports) {
      alerts.push({
        type: 'channel_reports',
        chatId: chatId,
        message: `تم تسجيل ${reportCount} بلاغ في هذه القناة`
      });
    }

    // إرسال التنبيهات
    for (const alert of alerts) {
      await this.sendAlert(alert);
    }

    return alerts.length > 0;
  }

  // تحديث إعدادات العتبات
  updateThresholds(newThresholds) {
    this.alertThresholds = { ...this.alertThresholds, ...newThresholds };
    logger.info('Alert thresholds updated', this.alertThresholds);
  }

  // الحصول على إعدادات العتبات الحالية
  getThresholds() {
    return this.alertThresholds;
  }

  // اختبار الإشعارات
  async testNotifications() {
    const testAlert = {
      type: 'system_alert',
      chatId: 'test_chat',
      chatName: 'اختبار النظام',
      message: 'هذا اختبار لنظام الإشعارات',
      severity: 'low'
    };

    try {
      await this.sendAlert(testAlert);
      return { success: true, message: 'تم إرسال الاختبار بنجاح' };
    } catch (error) {
      logger.error('Test notification failed:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = NotificationService;