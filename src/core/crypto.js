const crypto = require('crypto');
const config = require('../config');

// تشفير توكنات العملاء (AES-256-GCM) قبل حفظها على الـ Volume
// الصيغة المحفوظة: enc:v1:<iv>:<tag>:<data> (base64)

function key() {
  if (!config.encryptionKey) throw new Error('ENCRYPTION_KEY غير مضبوط');
  return crypto.createHash('sha256').update(config.encryptionKey).digest();
}

function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function decrypt(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
  const [, , iv, tag, data] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// إخفاء التوكن عند العرض: abcd…wxyz
function mask(token) {
  if (!token) return '—';
  const t = String(token);
  return t.length <= 10 ? '••••' : `${t.slice(0, 4)}…${t.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask };
