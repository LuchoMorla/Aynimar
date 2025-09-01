const { config } = require('./../config/config');
const https = require('https');

  async function  sendMail(infoMail) {
    const apiKey = config.smtpMailKey;
    
    const emailData = {
      sender: {
        name: "Aynimar",
        email: infoMail.from
      },
      to: [{
        email: infoMail.to
      }],
      subject: infoMail.subject,
      htmlContent: infoMail.html
    };

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(emailData);
      
      const options = {
        hostname: 'api.brevo.com',
        port: 443,
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'api-key': apiKey,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('Email sent via Brevo API:', JSON.parse(data));
            resolve({ message: `mail sent to ${infoMail.to}` });
          } else {
            console.error('Brevo API error:', res.statusCode, data);
            reject(new Error(`Brevo API error: ${res.statusCode} - ${data}`));
          }
        });
      });

      req.on('error', (error) => {
        console.error('Error sending email via Brevo API:', error);
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  module.exports = sendMail;