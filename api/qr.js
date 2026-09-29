// QR code for the phone link (same as /qr.svg in server.js).
const QRCode = require('qrcode');
module.exports = async (req, res) => {
  const u = String(req.query.u || '').slice(0, 300);
  if (!u) { res.status(400).end(); return; }
  const svg = await QRCode.toString(u, { type: 'svg', margin: 1, color: { dark: '#0A0E13', light: '#FFFFFF' } });
  res.setHeader('content-type', 'image/svg+xml'); res.setHeader('cache-control', 'no-store');
  res.end(svg);
};
