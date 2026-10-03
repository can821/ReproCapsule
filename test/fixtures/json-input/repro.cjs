const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync('request.json', 'utf8'));
const items = Array.isArray(request.items) ? request.items : [];
if (items.some(item => item && item.kind === 'trigger' && item.payload && item.payload.enabled === true)) {
  throw new TypeError('JSON request triggers parser defect');
}
