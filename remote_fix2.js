const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', () => {
  const commands = `
    node -e "
      const fs = require('fs');
      let x = fs.readFileSync('/home/panha_chan/mikrotik-dashboard/.env', 'utf8');
      x = x.split('\n').filter(line => !line.startsWith('CUSTOM_GRAPH_') && !line.includes('Default Legacy Graphs')).join('\n');
      x += '\n# Default Legacy Graphs\n';
      x += 'CUSTOM_GRAPH_1_DEV=MAIN\n';
      x += 'CUSTOM_GRAPH_1_IFACE=A-sfp-sfplus-1\n';
      x += 'CUSTOM_GRAPH_1_TITLE=A-sfp-sfplus-1 Traffic\n\n';
      x += 'CUSTOM_GRAPH_2_DEV=BRS\n';
      x += 'CUSTOM_GRAPH_2_IFACE=LACP X86\n';
      x += 'CUSTOM_GRAPH_2_TITLE=LACP X86 Traffic\n\n';
      x += 'CUSTOM_GRAPH_3_DEV=SW\n';
      x += 'CUSTOM_GRAPH_3_IFACE=sfp-sfpplus2\n';
      x += 'CUSTOM_GRAPH_3_TITLE=ARAH-BAROS Traffic\n';
      fs.writeFileSync('/home/panha_chan/mikrotik-dashboard/.env', x);
    "
    pm2 restart all
  `;
  conn.exec(commands, (err, stream) => {
    if (err) throw err;
    stream.on('close', (code) => {
      console.log('Fixed on server. Exit code:', code);
      conn.end();
    }).on('data', (data) => process.stdout.write(data))
      .stderr.on('data', (data) => process.stderr.write(data));
  });
}).connect({
  host: '192.168.35.95',
  port: 22,
  username: 'panha_chan',
  password: '2arahadmin'
});
