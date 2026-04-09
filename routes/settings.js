const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ENV_PATH = path.join(__dirname, '../.env');

// Helper to parse .env file natively into an object
function parseEnv() {
  const envVars = {};
  if (!fs.existsSync(ENV_PATH)) return envVars;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  lines.forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const idx = t.indexOf('=');
    if (idx < 0) return;
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    envVars[key] = val;
  });
  return envVars;
}

// GET current settings (mask passwords)
router.get('/', (req, res) => {
  const envVars = parseEnv();
  // Mask sensitive data for frontend rendering
  const safeEnv = { ...envVars };
  const maskFields = ['DASHBOARD_PASS', 'MK_PASS', 'TELEGRAM_BOT_TOKEN'];
  maskFields.forEach(field => {
    if (safeEnv[field]) {
      safeEnv[field] = '********'; // Masked placeholder
    }
  });
  res.json(safeEnv);
});

// POST to update settings
router.post('/', (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const currentEnv = parseEnv();
  let requiresRestart = false;

  // Identify if critical variables changed that actually require a PM2 backend restart to re-bind
  if (
    (payload.PORT && payload.PORT !== currentEnv.PORT) ||
    (payload.TELEGRAM_BOT_TOKEN && payload.TELEGRAM_BOT_TOKEN !== '********' && payload.TELEGRAM_BOT_TOKEN !== currentEnv.TELEGRAM_BOT_TOKEN)
  ) {
    requiresRestart = true;
  }

  // Read raw lines to preserve comments and structure
  let rawLines = [];
  if (fs.existsSync(ENV_PATH)) {
    rawLines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  }

  const keysUpdated = new Set();

  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx < 0) continue;
    const key = t.slice(0, idx).trim();
    
    if (payload.hasOwnProperty(key)) {
      let newVal = payload[key];
      // If user didn't change the masked password, keep it as it was
      if (newVal === '********') {
        newVal = currentEnv[key];
      }
      
      rawLines[i] = `${key}=${newVal}`;
      keysUpdated.add(key);
      process.env[key] = newVal; // Live memory update
    }
  }

  // Append any new keys that weren't in the file
  for (const [key, val] of Object.entries(payload)) {
    if (!keysUpdated.has(key) && val !== '********' && val !== '') {
      rawLines.push(`${key}=${val}`);
      process.env[key] = val;
    }
  }

  try {
    fs.writeFileSync(ENV_PATH, rawLines.join('\n'), 'utf8');
    
    if (requiresRestart) {
      // Respond to frontend immediately, then restart server after 1s delay
      res.json({ success: true, requiresRestart: true, message: 'Settings saved. Server is restarting...' });
      setTimeout(() => {
        console.log('[Settings] Triggering PM2 restart due to critical env changes...');
        exec('pm2 restart mikrotik-dashboard --update-env', (err) => {
          if (err) exec('pm2 restart 0 --update-env'); // fallback
        });
      }, 1000);
      return;
    }
    
    res.json({ success: true, requiresRestart: false, message: 'Settings saved successfully. No restart required.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write configuration: ' + err.message });
  }
});

module.exports = router;
