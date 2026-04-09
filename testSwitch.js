const { runCommand } = require('./routes/routeros-api');

const test = async () => {
  console.log('Connecting to 192.20.40.2...');
  try {
    const ifaces = await runCommand('192.20.40.2', 8728, 'NOC-PLD', 'pns321', '/interface/print');
    console.log('Interfaces on Switch:');
    ifaces.forEach(i => console.log(`  [${i.type}] ${i.name} (Comment: ${i.comment || ''})`));
    process.exit(0);
  } catch (err) {
    console.error('Error connecting to switch:', err);
    process.exit(1);
  }
};
test();
