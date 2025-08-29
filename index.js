const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const axios = require('axios');

const app = express();
app.use(express.json());

let recentLogs = [];
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };
  recentLogs.push(logEntry);
  if (recentLogs.length > 100) recentLogs.shift();
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
}

const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_EMAIL,
    pass: process.env.GMAIL_PASSWORD
  }
});

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = 'appUNIsu8KgvOlmi0';
const AIRTABLE_TABLE_NAME = 'Failed Payments';

async function addFailedPaymentToAirtable(paymentData) {
  try {
    const record = {
      fields: {
        'Payment ID': paymentData.id || 'N/A',
        'Customer ID': paymentData.customer || 'N/A',
        'Customer Email': paymentData.billing_details?.email || paymentData.receipt_email || 'N/A',
        'Amount': paymentData.amount ? (paymentData.amount / 100).toString() : 'N/A',
        'Currency': paymentData.currency?.toUpperCase() || 'USD',
        'Failure Reason': paymentData.failure_message || 'Unknown',
        'Date': new Date().toISOString(),
        'Status': 'Failed'
      }
    };

    await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
      { records: [record] },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    log(`Added failed payment to Airtable: ${paymentData.id}`);
  } catch (error) {
    log(`Error adding to Airtable: ${error.message}`, 'error');
    throw error;
  }
}

async function sendGmailAlert(paymentData) {
  try {
    const customerInfo = paymentData.billing_details?.email || 'Unknown';
    const amount = paymentData.amount ? `$${(paymentData.amount / 100).toFixed(2)}` : 'Unknown';
    
    const mailOptions = {
      from: process.env.GMAIL_EMAIL,
      to: process.env.GMAIL_EMAIL,
      subject: '🚨 Stripe Payment Failed Alert',
      html: `
        <h2>Payment Failure Alert</h2>
        <p><strong>Payment ID:</strong> ${paymentData.id}</p>
        <p><strong>Customer:</strong> ${customerInfo}</p>
        <p><strong>Amount:</strong> ${amount}</p>
        <p><strong>Reason:</strong> ${paymentData.failure_message || 'Unknown'}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      `
    };

    await transporter.sendMail(mailOptions);
    log(`Gmail alert sent for payment: ${paymentData.id}`);
  } catch (error) {
    log(`Error sending Gmail: ${error.message}`, 'error');
    throw error;
  }
}

app.post('/webhook/stripe', async (req, res) => {
  try {
    const event = req.body;
    log(`Received webhook: ${event.type}`);

    let paymentData = null;
    
    if (event.type === 'payment_intent.payment_failed' || 
        event.type === 'charge.failed' || 
        event.type === 'invoice.payment_failed') {
      paymentData = event.data.object;
    }

    if (paymentData) {
      await Promise.all([
        addFailedPaymentToAirtable(paymentData),
        sendGmailAlert(paymentData)
      ]);
      log(`Processed failed payment: ${paymentData.id}`);
    }

    res.json({ received: true });
  } catch (error) {
    log(`Webhook error: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'Stripe Payment Monitor',
    status: 'running',
    endpoints: ['/health', '/logs', '/test', '/webhook/stripe']
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/logs', (req, res) => {
  res.json({ logs: recentLogs.slice(-20) });
});

app.post('/test', async (req, res) => {
  try {
    const testData = {
      id: 'test_' + Date.now(),
      customer: 'cus_test',
      billing_details: { email: 'test@example.com' },
      amount: 1000,
      currency: 'usd',
      failure_message: 'Test payment failure'
    };

    await Promise.all([
      addFailedPaymentToAirtable(testData),
      sendGmailAlert(testData)
    ]);

    res.json({ success: true, message: 'Test completed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
});