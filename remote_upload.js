const Client = require('ssh2-sftp-client');
const fs = require('fs');

const config = {
  host: '192.168.35.95',
  port: 22,
  username: 'panha_chan',
  password: '2arahadmin'
};

const sftp = new Client();

async function uploadFiles() {
  try {
    console.log('Connecting to remote...');
    await sftp.connect(config);
    
    console.log('Uploading style.css...');
    await sftp.fastPut('public/css/style.css', '/home/panha_chan/mikrotik-dashboard/public/css/style.css');

    console.log('Uploading dashboard.js...');
    await sftp.fastPut('public/js/dashboard.js', '/home/panha_chan/mikrotik-dashboard/public/js/dashboard.js');

    console.log('Done!');
    await sftp.end();
  } catch (e) {
    console.error(e);
  }
}
uploadFiles();
