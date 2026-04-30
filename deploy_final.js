const Client = require('ssh2-sftp-client');
const { Client: SSHClient } = require('ssh2');

const config = {
  host: '192.168.35.95',
  port: 22,
  username: 'panha_chan',
  password: '2arahadmin'
};

const sftp = new Client();
const remotePath = '/home/panha_chan/mikrotik-dashboard/deploy.zip';

async function deploy() {
  try {
    console.log('Connecting SFTP...');
    await sftp.connect(config);
    console.log('Uploading deploy.zip...');
    await sftp.fastPut('deploy.zip', remotePath);
    console.log('Upload complete.');
    sftp.end();

    console.log('Connecting SSH to unzip and restart...');
    const conn = new SSHClient();
    conn.on('ready', () => {
      console.log('SSH connection ready. Executing commands...');
      const commands = `
        cd /home/panha_chan/mikrotik-dashboard
        unzip -o deploy.zip
        rm deploy.zip
        pm2 restart all || pm2 start server.js
      `;
      conn.exec(commands, (err, stream) => {
        if (err) throw err;
        stream.on('close', (code, signal) => {
          console.log('Commands executed. Exit code:', code);
          conn.end();
        }).on('data', (data) => {
          process.stdout.write(data.toString());
        }).stderr.on('data', (data) => {
          process.stderr.write(data.toString());
        });
      });
    }).connect(config);

  } catch (err) {
    console.error('Deploy error:', err);
  }
}

deploy();
