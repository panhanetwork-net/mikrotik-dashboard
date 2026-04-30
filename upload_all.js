const { Client } = require('ssh2');
const fs = require('fs');

const sshConfig = {
  host: '192.168.35.95',
  port: 22,
  username: 'panha_chan',
  password: '2arahadmin'
};

const REMOTE_DIR = '/home/panha_chan/mikrotik-dashboard/';
const filesToUpload = [
  { local: 'public/css/style.css', remote: 'public/css/style.css' },
  { local: 'public/js/dashboard.js', remote: 'public/js/dashboard.js' },
  { local: 'public/dashboard.html', remote: 'public/dashboard.html' },
  { local: 'routes/mikrotik.js', remote: 'routes/mikrotik.js' },
  { local: 'routes/settings.js', remote: 'routes/settings.js' },
  { local: 'routes/alerts.js', remote: 'routes/alerts.js' },
  { local: 'routes/ping.js', remote: 'routes/ping.js' },
];

const conn = new Client();
conn.on('ready', () => {
  console.log('Connecting to remote...');
  
  conn.sftp((err, sftp) => {
    if (err) throw err;
    
    let uploaded = 0;
    
    for (const f of filesToUpload) {
      if (!fs.existsSync(f.local)) {
        console.error('File not found locally:', f.local);
        uploaded++;
        continue;
      }
      console.log('Uploading', f.local, '...');
      sftp.fastPut(f.local, REMOTE_DIR + f.remote, (err) => {
        if (err) throw err;
        console.log('Uploaded', f.local);
        uploaded++;
        if (uploaded === filesToUpload.length) {
          console.log('All files uploaded. Restarting pm2 service...');
          conn.exec('cd /home/panha_chan/mikrotik-dashboard && pm2 restart mikrotik-dashboard', (err, stream) => {
            if (err) throw err;
            stream.on('close', () => {
              console.log('Done!');
              sftp.end();
              conn.end();
            }).on('data', data => process.stdout.write(data))
              .stderr.on('data', data => process.stderr.write(data));
          });
        }
      });
    }
  });
}).connect(sshConfig);
