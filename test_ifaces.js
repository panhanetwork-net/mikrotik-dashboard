const { runCommand } = require('./routes/routeros-api.js');
(async () => {
  try {
    const r = await runCommand('157.66.36.31', 56988, 'NOC-PLD', 'pns321', '/interface/print');
    console.log(r.map(i => i.name).filter(n => typeof n === 'string' && !n.startsWith('<') && !n.toLowerCase().includes('pppoe')).slice(0, 30));
  } catch (e) { console.error(e); }
})();
