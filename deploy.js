const { NodeSSH } = require('node-ssh');
const path = require('path');
const ssh = new NodeSSH();

const filesToUpload = [
  'server.js',
  'routes/auth.js',
  'routes/sse.js',
  'routes/history.js',
  'routes/mikrotik.js',
  'routes/ping.js',
  'routes/settings.js',
  'routes/snmp-poller.js',
  'public/js/dashboard.js',
  'public/js/login.js',
  'public/index.html',
  'public/css/style.css'
];

async function deploy() {
  try {
    console.log('Connecting to server...');
    await ssh.connect({
      host: '192.168.35.95',
      username: 'panha_chan',
      password: '2arahadmin'
    });
    console.log('Connected!');

    const remoteDir = '/home/panha_chan/mikrotik-dashboard';
    
    // Upload files sequentially to prevent SFTP MaxChannels connection drops
    for (const file of filesToUpload) {
      const localPath = path.join(__dirname, file);
      const remotePath = `${remoteDir}/${file.replace(/\\/g, '/')}`;
      console.log(`Uploading ${file}...`);
      await ssh.putFile(localPath, remotePath);
    }
    console.log('All files uploaded successfully!');

    console.log('Restarting PM2 process...');
    const result = await ssh.execCommand('pm2 restart mikrotik-dashboard --update-env', { cwd: remoteDir });
    console.log(result.stdout);
    if(result.stderr) console.error('PM2 Warning:', result.stderr);

    console.log('Deployment complete!');
    ssh.dispose();
  } catch (err) {
    console.error('Deployment Failed:', err);
    ssh.dispose();
  }
}

deploy();
