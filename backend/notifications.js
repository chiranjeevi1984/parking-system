const twilio = require('twilio');

const channel = (process.env.TWILIO_ALERT_CHANNEL || 'sms').toLowerCase();
const configured = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
const client = configured ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

function e164PhoneNumber(value) {
  const number = String(value || '').replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : null;
}

function whatsappAddress(value) {
  return value?.startsWith('whatsapp:') ? value : `whatsapp:${value}`;
}

async function sendAlert({ to, body }) {
  const recipient = e164PhoneNumber(to);
  if (!client) return { sent: false, reason: 'Twilio is not configured' };
  if (!recipient) return { sent: false, reason: 'Vehicle phone number is not E.164 format' };

  const requests = [];
  if ((channel === 'sms' || channel === 'both') && process.env.TWILIO_SMS_FROM) {
    requests.push(client.messages.create({ from: process.env.TWILIO_SMS_FROM, to: recipient, body }));
  }
  if ((channel === 'whatsapp' || channel === 'both') && process.env.TWILIO_WHATSAPP_FROM) {
    requests.push(client.messages.create({ from: whatsappAddress(process.env.TWILIO_WHATSAPP_FROM), to: whatsappAddress(recipient), body }));
  }
  if (!requests.length) return { sent: false, reason: 'No sender is configured for the selected alert channel' };

  const results = await Promise.allSettled(requests);
  const delivered = results.filter(result => result.status === 'fulfilled').map(result => result.value.sid);
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason?.message || 'Twilio message failed');
  if (failures.length) console.error('Parking alert failed:', failures.join('; '));
  return { sent: delivered.length > 0, messageSids: delivered, failures };
}

function timeText(value) {
  return new Intl.DateTimeFormat('en-IN', { 
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit', 
    minute: '2-digit', 
    hour12: true 
  }).format(new Date(value));
}

function moneyText(value) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value));
}

async function sendEntryAlert(vehicle, session) {
  return sendAlert({
    to: vehicle.phone_number,
    body: `Parking Alert: Vehicle ${vehicle.vehicle_number} entered the parking area at ${timeText(session.entry_time)}. Keep this message for your reference.`
  });
}

async function sendExitAlert(vehicle, session, paymentStatus) {
  const paid = String(paymentStatus).toLowerCase() === 'success';
  const status = paid ? 'Paid' : 'Pending';
  return sendAlert({
    to: vehicle.phone_number,
    body: `Parking Alert: Vehicle ${vehicle.vehicle_number} exited the parking area. Parking fee: ${moneyText(session.amount)}. Payment status: ${status}. Thank you!`
  });
}

module.exports = { sendEntryAlert, sendExitAlert };
