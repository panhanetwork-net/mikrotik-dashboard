const Client = require('ssh2-sftp-client');
const { Client: SSHClient } = require('ssh2');

const config = {
  host: '192.168.35.95',
  port: 22,
  username: 'panha_chan',
  password: '2arahadmin'
};

const sftp = new Client();
const remotePath = '/home/panha_chan/mikrotik-dashboard/.env';

async function fix() {
  try {
    await sftp.connect(config);
    const envBuffer = await sftp.get(remotePath);
    let content = envBuffer.toString('utf8');
    
    // Clean up all lines with CUSTOM_GRAPH_
    content = content.split('\n')
      .filter(line => !line.startsWith('CUSTOM_GRAPH_') && !line.includes('Default Legacy Graphs'))
      .join('\n');
    
    // Append the correct ones
    content += '\n# Default Legacy Graphs\n';
    content += 'CUSTOM_GRAPH_1_DEV=MAIN\n';
    content += 'CUSTOM_GRAPH_1_IFACE=A-sfp-sfplus-1\n';
    content += 'CUSTOM_GRAPH_1_TITLE=A-sfp-sfplus-1 Traffic\n\n';
    content += 'CUSTOM_GRAPH_2_DEV=BRS\n';
    content += 'CUSTOM_GRAPH_2_IFACE=LACP X86\n';
    content += 'CUSTOM_GRAPH_2_TITLE=LACP X86 Traffic\n\n';
    content += 'CUSTOM_GRAPH_3_DEV=SW\n';
    content += 'CUSTOM_GRAPH_3_IFACE=sfp-sfpplus2\n';
    content += 'CUSTOM_GRAPH_3_TITLE=ARAH-BAROS Traffic\n';
    
    // Upload back
    await sftp.put(Buffer.from(content), remotePath);
    console.log('.env uploaded.');
    await sftp.end();

    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.exec('pm2 restart mikrotik-dashboard', (err, stream) => {
        if (err) throw err;
        stream.on('close', (code) => {
          console.log('Restarted PM2. Exit code:', code);
          conn.end();
        }).on('data', d => process.stdout.write(d))
          .stderr.on('data', d => process.stderr.write(d));
      });
    }).connect(config);
  } catch (e) {
    console.error(e);
  }
}
fix();
