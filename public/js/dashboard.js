'use strict';

/* ─── Constants ──────────────────────────────────────────────────────────── */
const PORT_NAMES = {
  '80':'HTTP','443':'HTTPS','22':'SSH','21':'FTP','25':'SMTP','53':'DNS',
  '110':'POP3','143':'IMAP','3306':'MySQL','5432':'PgSQL','3389':'RDP',
  '23':'Telnet','8080':'HTTP-Alt','8443':'HTTPS-Alt','1194':'OpenVPN',
  '1723':'PPTP','4500':'IPSec','500':'IKE',
};

/* ─── State ─────────────────────────────────────────────────────────────── */
let pollTimer    = null;
let pollInterval = 3000;
let rxPeak = 0, txPeak = 0;
let prevRxBytes = {}, prevTxBytes = {}, prevTimestamp = null;
let chartRx, chartTx, chartSfp, chartLacp, chartArah, chartDns;
const MAX_POINTS = 60;
const rxData = new Array(MAX_POINTS).fill(0);
const txData = new Array(MAX_POINTS).fill(0);
const historySfpRx    = new Array(MAX_POINTS).fill(0), historySfpTx    = new Array(MAX_POINTS).fill(0);
const historyLacpRx   = new Array(MAX_POINTS).fill(0), historyLacpTx   = new Array(MAX_POINTS).fill(0);
const historyArahRx   = new Array(MAX_POINTS).fill(0), historyArahTx   = new Array(MAX_POINTS).fill(0);
const historyDnsTotal = new Array(MAX_POINTS).fill(0), historyDnsBlock = new Array(MAX_POINTS).fill(0);
const LABELS = Array.from({ length: MAX_POINTS }, () => '');
let isOnline = true;
let activeTab = 'dashboard';
let allPppoe  = [];
let allConns  = [];
let chartHistGlobal, chartHistSfp, chartHistLacp, chartHistArah;
const ifaceCharts = {}; // name -> { rxData, txData, chart }
const MAX_IFACE_POINTS = 30;
// SNMP state (declared here so switchTab can reference them safely)
let snmpDevices = [];
let snmpIfaceTimer = null;

/* ─── Init ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const me = await fetch('/api/me').then(r => r.json());
    if (!me.ok) { window.location.href = '/'; return; }
    document.getElementById('header-host-label').textContent = me.routerIp;
  } catch (_) {
    window.location.href = '/';
    return;
  }
  initCharts();
  gsap.to('.fade-up', { opacity: 1, y: 0, duration: .5, ease: 'power3.out', stagger: .06, delay: .1 });
  await fetchMikrotikDevices();
  startPolling();
  startStatusMonitor();
  fetchPingStatus();
  setInterval(fetchPingStatus, 10000);
});

/* ─── Tab Switching ──────────────────────────────────────────────────────── */
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('visible'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('section-' + tab).classList.add('visible');
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'snmp') { fetchSnmpDevices(); }
  else { clearTimeout(snmpIfaceTimer); }
}

/* ─── Utility ────────────────────────────────────────────────────────────── */
function fmt(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtRate(bps) {
  if (bps < 1000) return { val: bps.toFixed(1), unit: 'bps' };
  if (bps < 1e6)  return { val: (bps / 1e3).toFixed(1), unit: 'Kbps' };
  if (bps < 1e9)  return { val: (bps / 1e6).toFixed(2), unit: 'Mbps' };
  return { val: (bps / 1e9).toFixed(2), unit: 'Gbps' };
}

function typeColor(type) {
  const map = { ether:'#3b82f6', wlan:'#22c55e', bridge:'#f59e0b', vlan:'#a855f7', pppoe:'#06b6d4', lte:'#ec4899', loopback:'#64748b' };
  return map[(type || '').toLowerCase()] || '#3b82f6';
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  const current = parseFloat(el.textContent) || 0;
  gsap.to({ val: current }, {
    val: target, duration: .5, ease: 'power2.out',
    onUpdate: function() { el.textContent = Math.round(this.targets()[0].val); }
  });
}

function showToast(msg, duration = 4000) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.style.display = 'flex';
  gsap.fromTo(t, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .3 });
  setTimeout(() => gsap.to(t, { opacity: 0, y: 8, duration: .3, onComplete: () => t.style.display = 'none' }), duration);
}

/* ─── Chart Implementations ────────────────────────────────────────────────── */
Chart.defaults.color = '#8b9ab0';
Chart.defaults.font.family = "'Inter', sans-serif";

const getSingleChartConfig = (isTraffic = true) => ({
  type: 'line',
  options: {
    layout: { padding: { bottom: 10 } },
    responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: 'index', intersect: false, backgroundColor: '#1e2534', titleColor: '#8b9ab0', bodyColor: '#e2e8f0', borderColor: '#2d3748', borderWidth: 1,
        callbacks: { label: ctx => { return isTraffic ? fmtRate(ctx.raw).val + ' ' + fmtRate(ctx.raw).unit : ctx.raw + ' Q' } },
      },
    },
    scales: {
      x: { display: false },
      y: { display: true, min: 0, grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false }, ticks: {
        color: '#8b9ab0', font: { size: 10 }, maxTicksLimit: 5, callback: v => { const f = !isTraffic ? {val:v,unit:''} : fmtRate(v); return f.val + ' ' + f.unit; } } },
    },
    elements: {
      point: { radius: 0, hitRadius: 10, hoverRadius: 4 },
      line: { tension: 0.4, borderWidth: 2 }
    }
  }
});

const getDualChartConfig = () => ({
  type: 'line',
  options: {
    layout: { padding: { bottom: 10 } },
    responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
    plugins: { legend: { display: false }, tooltip: {
      mode: 'index', intersect: false, backgroundColor: '#1e2534', titleColor: '#8b9ab0', bodyColor: '#e2e8f0', borderColor: '#2d3748', borderWidth: 1,
      callbacks: { label: ctx => { const f = fmtRate(ctx.raw); return ` ${f.val} ${f.unit}`; } },
    }},
    scales: {
      x: { display: false },
      y: { display: true, min: 0, grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false }, ticks: {
        color: '#8b9ab0', font: { size: 10 }, maxTicksLimit: 4, callback: v => { const f = fmtRate(v); return f.val + ' ' + f.unit; } } },
    },
    elements: {
      point: { radius: 0, hitRadius: 10, hoverRadius: 4 },
      line: { tension: 0.4, borderWidth: 1.5 }
    }
  }
});

function initCharts() {
  const initC = (id, color) => new Chart(document.getElementById(id), {
    ...getSingleChartConfig(true),
    data: {
      labels: LABELS,
      datasets: [{ data: [], borderColor: color, backgroundColor: color.replace('rgb', 'rgba').replace(')', ',0.08)'), fill: true }],
    },
  });

  chartRx  = initC('chart-rx',  'rgb(59,130,246)');
  chartTx  = initC('chart-tx',  'rgb(168,85,247)');
  
  const initDual = (id, c1, c2, d1, d2) => new Chart(document.getElementById(id), {
    ...getDualChartConfig(),
    data: {
      labels: LABELS,
      datasets: [
        { data: d1, borderColor: c1, backgroundColor: c1.replace(')', ',0.1)').replace('rgb','rgba'), fill: true },
        { data: d2, borderColor: c2, backgroundColor: 'transparent', fill: false }
      ]
    }
  });

  chartSfp  = initDual('chart-sfp',  'rgb(56, 189, 248)', 'rgb(244, 114, 182)', historySfpRx, historySfpTx);
  chartLacp = initDual('chart-lacp', 'rgb(251, 191, 36)', 'rgb(251, 113, 133)', historyLacpRx, historyLacpTx);
  chartArah = initDual('chart-arah', 'rgb(74, 222, 128)', 'rgb(192, 132, 252)', historyArahRx, historyArahTx);
  
  chartDns = new Chart(document.getElementById('chart-dns'), {
    ...getDualChartConfig(),
    data: {
      labels: LABELS,
      datasets: [
        { data: historyDnsTotal, borderColor: 'rgb(96, 165, 250)', backgroundColor: 'rgba(96, 165, 250, 0.1)', fill: true },
        { data: historyDnsBlock, borderColor: 'rgb(45, 212, 191)', backgroundColor: 'transparent', fill: false }
      ]
    }
  });
}

function updateIfaceChart(name, type, rxBps, txBps) {
  // Skip PPPoE session tunnel interfaces — only show core interfaces
  if ((type || '').toLowerCase().startsWith('pppoe')) return;
  const safeId = name.replace(/[^a-zA-Z0-9]/g, '-');
  const grid = document.getElementById('iface-charts-grid');
  if (!grid) return;
  if (!ifaceCharts[name]) {
    const div = document.createElement('div');
    div.className = 'dash-card';
    const color = typeColor(type);
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:7px;">
          <div style="width:8px;height:8px;border-radius:2px;background:${color};flex-shrink:0;"></div>
          <span style="color:#fff;font-weight:600;font-size:.82rem;">${name}</span>
          <span style="color:var(--muted);font-size:.68rem;">${type||'ether'}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span id="ic-rx-${safeId}" style="font-size:.72rem;color:#3b82f6;font-family:monospace;">—</span>
          <span style="color:var(--muted);font-size:.7rem;">/</span>
          <span id="ic-tx-${safeId}" style="font-size:.72rem;color:#a855f7;font-family:monospace;">—</span>
        </div>
      </div>
      <div style="height:64px;position:relative;"><canvas id="ic-cv-${safeId}"></canvas></div>`;
    grid.appendChild(div);
    const rxD = new Array(MAX_IFACE_POINTS).fill(0);
    const txD = new Array(MAX_IFACE_POINTS).fill(0);
    const chart = new Chart(document.getElementById('ic-cv-'+safeId).getContext('2d'), {
      type: 'line',
      data: { labels: new Array(MAX_IFACE_POINTS).fill(''),
        datasets: [
          { data: rxD.slice(), borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,.08)', borderWidth:1.5, pointRadius:0, tension:0.4, fill:true },
          { data: txD.slice(), borderColor:'#a855f7', backgroundColor:'rgba(168,85,247,.08)', borderWidth:1.5, pointRadius:0, tension:0.4, fill:true },
        ] },
      options: {
        responsive:true, maintainAspectRatio:false, animation:{duration:0},
        plugins:{ legend:{display:false}, tooltip:{enabled:false} },
        scales:{ x:{display:false}, y:{display:false, min:0} },
      },
    });
    ifaceCharts[name] = { rxData:rxD, txData:txD, chart };
  }
  const ic = ifaceCharts[name];
  ic.rxData.push(rxBps); ic.rxData.shift();
  ic.txData.push(txBps); ic.txData.shift();
  ic.chart.data.datasets[0].data = ic.rxData.slice();
  ic.chart.data.datasets[1].data = ic.txData.slice();
  ic.chart.options.scales.y.max = Math.max(...ic.rxData, ...ic.txData) * 1.2 || 1;
  ic.chart.update('none');
  const rxF = fmtRate(rxBps), txF = fmtRate(txBps);
  const rxEl = document.getElementById('ic-rx-'+safeId);
  const txEl = document.getElementById('ic-tx-'+safeId);
  if (rxEl) rxEl.textContent = rxF.val+' '+rxF.unit;
  if (txEl) txEl.textContent = txF.val+' '+txF.unit;
}

function setChartData(chart, inArr, outArr, dataArray, key) {
  const sliced = dataArray.slice(-MAX_POINTS);
  // Pad if < MAX_POINTS
  while(sliced.length < MAX_POINTS) { sliced.unshift({[key]:{rx:0,tx:0}}); }

  sliced.forEach((p, i) => {
    inArr[i]  = p[key] ? p[key].rx : 0;
    outArr[i] = p[key] ? p[key].tx : 0;
  });
  
  chart.data.datasets[0].data = inArr.slice();
  chart.data.datasets[1].data = outArr.slice();
  chart.options.scales.y.max  = Math.max(...inArr, ...outArr) * 1.2 || 1;
  chart.update('none');
}

function updateTrafficLabels(dataArray, key, idIn, idOut) {
  if (!dataArray || !dataArray.length) return;
  const latest = dataArray[dataArray.length - 1];
  if (!latest || !latest[key]) return;
  
  const rx = fmtRate(latest[key].rx), tx = fmtRate(latest[key].tx);
  if(document.getElementById(idIn)) document.getElementById(idIn).textContent  = rx.val;
  if(document.getElementById(idOut)) document.getElementById(idOut).textContent = tx.val;
}

function setChartDataSingle(chart, arr, dataArray, key, subkey) {
  const sliced = dataArray.slice(-MAX_POINTS);
  while(sliced.length < MAX_POINTS) { sliced.unshift({[key]:{rx:0,tx:0}}); }

  sliced.forEach((p, i) => { arr[i] = p[key] ? p[key][subkey] : 0; });
  
  chart.data.datasets[0].data = arr.slice();
  chart.options.scales.y.max  = Math.max(...arr) * 1.2 || 1;
  chart.update('none');
}

/* ─── Traffic UI ─────────────────────────────────────────────────────────── */
function updateTrafficUI(data) {
  if (!data || !data.length) return;
  
  // Update Labels (Times) locally for dashboard 60-points
  const slicedData = data.slice(-MAX_POINTS);
  const now = new Date();
  // Provide basic timestamps if missing, else map actual backend ts
  const currentLabels = slicedData.map((p, i) => {
    const d = new Date(p.ts || (now.getTime() - (MAX_POINTS - i) * pollInterval));
    return d.getHours().toString().padStart(2,'0') + ':' + 
           d.getMinutes().toString().padStart(2,'0') + ':' + 
           d.getSeconds().toString().padStart(2,'0');
  });
  while(currentLabels.length < MAX_POINTS) { currentLabels.unshift(''); }

  const applyLabels = (c) => { c.data.labels = currentLabels.slice(); };
  [chartRx, chartTx, chartSfp, chartLacp, chartArah, chartDns].forEach(c => {
    if(c && c.data) applyLabels(c);
  });

  // Update single charts
  setChartDataSingle(chartRx, rxData, data, 'total', 'rx');
  setChartDataSingle(chartTx, txData, data, 'total', 'tx');

  // Update dual PRTG charts
  setChartData(chartSfp, historySfpRx, historySfpTx, data, 'sfp');
  setChartData(chartLacp, historyLacpRx, historyLacpTx, data, 'lacp');
  setChartData(chartArah, historyArahRx, historyArahTx, data, 'arah');

  updateTrafficLabels(data, 'sfp', 'val-sfp-rx', 'val-sfp-tx');
  updateTrafficLabels(data, 'lacp', 'val-lacp-rx', 'val-lacp-tx');
  updateTrafficLabels(data, 'arah', 'val-arah-rx', 'val-arah-tx');
  
  // Update Peak labels for Top Cards
  const latest = data[data.length - 1];
  if (latest && latest.total) {
    const rxBps = latest.total.rx, txBps = latest.total.tx;
    const rx = fmtRate(rxBps), tx = fmtRate(txBps);
    document.getElementById('rx-current').textContent = rx.val;
    document.getElementById('rx-unit').textContent    = rx.unit;
    document.getElementById('tx-current').textContent = tx.val;
    document.getElementById('tx-unit').textContent    = tx.unit;
    if (rxBps > rxPeak) {
      rxPeak = rxBps;
      const p = fmtRate(rxPeak);
      document.getElementById('rx-peak').textContent      = p.val;
      document.getElementById('rx-peak-unit').textContent = p.unit;
    }
    if (txBps > txPeak) {
      txPeak = txBps;
      const p = fmtRate(txPeak);
      document.getElementById('tx-peak').textContent      = p.val;
      document.getElementById('tx-peak-unit').textContent = p.unit;
    }
  }
}

// ─── Fetch: Technitium DNS ──────────────────────────────────────────────────
async function fetchTechnitium() {
  try {
    const d = await fetch('/api/technitium/chart').then(r => r.json());
    if (d.error) throw new Error(d.error);
    
    if (d.response && d.response.stats) {
      const totalNum = d.response.stats.totalQueries || 0;
      const blckNum  = d.response.stats.totalBlocked || 0;
      
      const now = new Date();
      document.getElementById('val-dns-time').textContent = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
      
      document.getElementById('val-dns-total').textContent = totalNum.toLocaleString();
      document.getElementById('val-dns-blocked').textContent = blckNum.toLocaleString();

      historyDnsTotal.push(totalNum); historyDnsTotal.shift();
      historyDnsBlock.push(blckNum);  historyDnsBlock.shift();

      chartDns.data.datasets[0].data = historyDnsTotal.slice();
      chartDns.data.datasets[1].data = historyDnsBlock.slice();
      chartDns.options.scales.y.max  = Math.max(...historyDnsTotal, ...historyDnsBlock) * 1.1 || 1;
      chartDns.update('none');
      document.getElementById('dns-error').style.display = 'none';
      document.getElementById('chart-dns').style.opacity = '1';
    }
  } catch(e) {
    document.getElementById('dns-error').textContent = 'Proxy Error: ' + e.message;
    document.getElementById('dns-error').style.display = 'flex';
    document.getElementById('chart-dns').style.opacity = '0.2';
  }
}

/* ─── Health UI ─────────────────────────────────────────────────────────── */
function updateHealthUI(data) {
  let boardTemp = null, cpuTemp = null, voltage = null;
  if (Array.isArray(data)) {
    data.forEach(item => {
      const n = (item.name || '').toLowerCase();
      const v = parseFloat(item.value);
      if (n.includes('board-temperature') || n === 'temperature') boardTemp = v;
      else if (n.includes('cpu-temperature')) cpuTemp = v;
      else if (n.includes('voltage') || n.includes('psu')) voltage = v;
    });
  } else if (data && typeof data === 'object') {
    boardTemp = parseFloat(data['board-temperature'] || data['temperature'] || NaN);
    cpuTemp   = parseFloat(data['cpu-temperature'] || NaN);
    voltage   = parseFloat(data['voltage'] || NaN);
  }

}

/* ─── Fetch: Resources ───────────────────────────────────────────────────── */
async function fetchResources() {
  const r = await fetch('/api/mikrotik/resources').then(res => res.json());
  if (r.error) throw new Error(r.error);

  const applyRes = (obj, suffix) => {
    if (!obj || Object.keys(obj).length === 0) return;
    
    const cpu    = parseInt(obj['cpu-load'] || 0);
    const total  = parseInt(obj['total-memory'] || 1);
    const free   = parseInt(obj['free-memory'] || 0);
    const used   = total - free;
    const memPct = Math.round((used / total) * 100);

    animateNumber(`cpu-val-${suffix}`, cpu);
    gsap.to(`#cpu-bar-${suffix}`, { width: cpu + '%', duration: .6, ease: 'power2.out' });
    document.getElementById(`cpu-bar-${suffix}`).style.background =
      cpu > 80 ? 'linear-gradient(90deg,#ef4444,#f87171)' :
      cpu > 50 ? 'linear-gradient(90deg,#f59e0b,#fbbf24)' :
                 'linear-gradient(90deg,#3b82f6,#60a5fa)';

    document.getElementById(`mem-used-${suffix}`).textContent  = Math.round(used / 1048576);
    document.getElementById(`mem-total-${suffix}`).textContent = Math.round(total / 1048576);
    document.getElementById(`mem-pct-${suffix}`).textContent   = memPct + '%';
    gsap.to(`#mem-bar-${suffix}`, { width: memPct + '%', duration: .6, ease: 'power2.out' });

    const u = obj['uptime'] || '';
    let d=0,h=0,m=0,s=0;
    const wk=u.match(/(\d+)w/); if(wk) d+=+wk[1]*7;
    const dy=u.match(/(\d+)d/); if(dy) d+=+dy[1];
    const hr=u.match(/(\d+)h/); if(hr) h=+hr[1];
    const mn=u.match(/(\d+)m/); if(mn) m=+mn[1];
    const sc=u.match(/(\d+)s/); if(sc) s=+sc[1];

    document.getElementById(`uptime-val-${suffix}`).textContent = `${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    document.getElementById(`up-d-${suffix}`).textContent = d;
    document.getElementById(`up-h-${suffix}`).textContent = h;
    document.getElementById(`up-m-${suffix}`).textContent = m;
  };

  applyRes(r.main, 'main');
  applyRes(r.r42, 'r42');
  applyRes(r.r50, 'r50');
  applyRes(r.r155, 'r155');
}

/* ─── Fetch: Health ──────────────────────────────────────────────────────── */
async function fetchHealth() {
  try {
    const data = await fetch('/api/mikrotik/health').then(r => r.json());
    if (!data.error) updateHealthUI(data);
  } catch (_) {}
}

/* ─── Fetch: Traffic ─────────────────────────────────────────────────────── */
async function fetchTraffic() {
  const sel = document.getElementById('mk-device-select');
  const key = (sel && sel.value) ? sel.value : 'MAIN';

  const data = await fetch(`/api/mikrotik/interface/stats/${key}`).then(r => r.json());
  if (data.error) throw new Error(data.error);
  
  let totalRx = 0, totalTx = 0;
  if (Array.isArray(data)) {
    data.forEach(e => {
      totalRx += parseInt(e['rx-bits-per-second'] || 0);
      totalTx += parseInt(e['tx-bits-per-second'] || 0);
    });
  }
  updateTrafficUI(totalRx, totalTx);
}

/* ─── Fetch: MikroTik Devices Dropdown ─────────────────────────────────────── */
async function fetchMikrotikDevices() {
  try {
    const devices = await fetch('/api/mikrotik/devices', { headers: { 'Authorization': getAuthHeader() } }).then(r => r.json());
    if (devices.error) throw new Error(devices.error);

    const sel = document.getElementById('mk-device-select');
    if (!sel) return;

    if (!Array.isArray(devices) || devices.length <= 1) {
      sel.style.display = 'none';
      return;
    }

    const currentVal = sel.value || 'MAIN';
    sel.innerHTML = devices.map(d => `<option value="${d.key}">${d.label} [${d.host}]</option>`).join('');
    
    // Restore or set to 'MAIN' natively
    if (devices.find(d => d.key === currentVal)) sel.value = currentVal;
    sel.style.display = 'inline-block';
  } catch (err) {
    console.error('Gagal meload MikroTik Devices', err);
  }
}

/* ─── Fetch: Interfaces ──────────────────────────────────────────────────── */
async function fetchInterfaces() {
  const sel = document.getElementById('mk-device-select');
  const key = (sel && sel.value) ? sel.value : 'MAIN';

  const res = await fetch(`/api/mikrotik/interfaces/${key}`).then(r => r.json());
  if (res.error) throw new Error(res.error);
  
  // New backend schema: { total, up, down, vlan, interfaces: [...] }
  const active = (res.interfaces || []).filter(i => i.up);
  document.getElementById('iface-count').textContent = `${active.length} interface`;

  const now = Date.now();
  const rows = active.map(iface => {
    const rxBytes = parseInt(iface.rxBytes || 0);
    const txBytes = parseInt(iface.txBytes || 0);
    let rxRateHtml = '<span style="color:var(--muted)">—</span>';
    let txRateHtml = '<span style="color:var(--muted)">—</span>';

    if (prevRxBytes[iface.name] !== undefined && prevTimestamp) {
      const dt = (now - prevTimestamp) / 1000;
      if (dt > 0) {
        const rxBps = Math.max(0, ((rxBytes - prevRxBytes[iface.name]) / dt) * 8);
        const txBps = Math.max(0, ((txBytes - prevTxBytes[iface.name]) / dt) * 8);
        const rxR = fmtRate(rxBps), txR = fmtRate(txBps);
        rxRateHtml = `<span style="color:#3b82f6;font-family:monospace;">${rxR.val} ${rxR.unit}</span>`;
        txRateHtml = `<span style="color:#a855f7;font-family:monospace;">${txR.val} ${txR.unit}</span>`;
        updateIfaceChart(iface.name, iface.type, rxBps, txBps);
      }
    }
    prevRxBytes[iface.name] = rxBytes;
    prevTxBytes[iface.name] = txBytes;

    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px;">
        <div style="width:8px;height:8px;border-radius:2px;background:${typeColor(iface.type)};flex-shrink:0;"></div>
        <div><div style="color:#fff;font-weight:500;">${iface.name}</div><div style="color:var(--muted);font-size:.68rem;">${iface.type||'ether'}</div></div>
      </div></td>
      <td><span class="status-up"><span style="width:5px;height:5px;background:#22c55e;border-radius:50%;display:inline-block;"></span>UP</span></td>
      <td>${rxRateHtml}</td>
      <td>${txRateHtml}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${fmt(rxBytes)}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${fmt(txBytes)}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.75rem;">${iface['mac-address']||'—'}</td>
    </tr>`;
  }).join('');

  document.getElementById('iface-tbody').innerHTML = rows || `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">Tidak ada interface aktif</td></tr>`;
  prevTimestamp = now;
}

/* ─── Fetch: PPPoE Sessions ──────────────────────────────────────── */
async function fetchPppoe() {
  const data = await fetch('/api/mikrotik/pppoe-active').then(r => r.json());
  if (data.error) throw new Error(data.error);
  const total = data.total || 0;
  allPppoe = Array.isArray(data.sessions) ? data.sessions : [];
  document.getElementById('pppoe-total').textContent = total.toLocaleString('id-ID');
  document.getElementById('pppoe-online').textContent = total.toLocaleString('id-ID');
  document.getElementById('pppoe-total-badge').textContent = `${total.toLocaleString('id-ID')} sesi`;
  const badge = document.getElementById('pppoe-badge');
  badge.textContent = total.toLocaleString('id-ID');
  badge.style.display = total ? 'inline' : 'none';
  renderPppoeTable(allPppoe.slice(0, 500));
}

function renderPppoeTable(sessions) {
  if (!sessions.length) {
    document.getElementById('pppoe-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:28px;">Tidak ada sesi PPPoE aktif.</td></tr>`;
    return;
  }
  document.getElementById('pppoe-tbody').innerHTML = sessions.map(s => {
    const user   = s.name || '—';
    const ip     = s.address || '—';
    const caller = s['caller-id'] || s['mac-address'] || '—';
    const svc    = s.service || '—';
    const uptime = s.uptime || '—';
    const enc    = s.encoding || '—';
    return `<tr>
      <td style="color:#e2e8f0;font-weight:500;">${user}</td>
      <td style="font-family:monospace;color:#3b82f6;font-size:.78rem;">${ip}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${caller}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.75rem;">${svc}</td>
      <td style="font-family:monospace;color:#22c55e;font-size:.75rem;">${uptime}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.72rem;">${enc}</td>
    </tr>`;
  }).join('');
}

function filterPppoe() {
  const q = document.getElementById('pppoe-search').value.toLowerCase();
  // Search all sessions in memory, show all matches; default shows first 500
  const filtered = q ? allPppoe.filter(s => JSON.stringify(s).toLowerCase().includes(q)) : allPppoe.slice(0, 500);
  renderPppoeTable(filtered);
  document.getElementById('pppoe-total-badge').textContent = q
    ? `${filtered.length.toLocaleString('id-ID')} hasil`
    : `${allPppoe.length.toLocaleString('id-ID')} sesi`;
}



/* ─── Fetch: Connections ─────────────────────────────────────────────────── */
async function fetchConnections() {
  const data = await fetch('/api/mikrotik/connections').then(r => r.json());
  if (data.error) throw new Error(data.error);
  const total = data.total || 0;
  allConns = Array.isArray(data.connections) ? data.connections : [];

  const established = allConns.filter(c => (c['tcp-state']||c.state||'').toLowerCase() === 'established');
  const srcIPs      = new Set(allConns.map(c => (c['src-address']||'').split(':')[0]).filter(Boolean));
  const dstPorts    = new Set(allConns.map(c => {
    const dst = c['dst-address'] || '';
    return dst.includes(':') ? dst.substring(dst.lastIndexOf(':')+1) : '';
  }).filter(Boolean));

  document.getElementById('conn-total').textContent       = total.toLocaleString('id-ID');
  document.getElementById('conn-established').textContent = established.length.toLocaleString('id-ID');
  document.getElementById('conn-src-ips').textContent     = srcIPs.size.toLocaleString('id-ID');
  document.getElementById('conn-dst-ports').textContent   = dstPorts.size.toLocaleString('id-ID');
  document.getElementById('conn-count').textContent       = `500 dari ${total.toLocaleString('id-ID')} koneksi`;

  const badge = document.getElementById('conn-badge');
  badge.textContent = total.toLocaleString('id-ID');
  badge.style.display = total ? 'inline' : 'none';

  renderTopPorts(allConns);
  renderTopIPs(allConns);
  renderConnTable(allConns.slice(0, 500)); // show first 500 only
}

function renderTopPorts(conns, limit = 8) {
  const portCount = {};
  conns.forEach(c => {
    const dst = c['dst-address'] || '';
    const port = dst.includes(':') ? dst.substring(dst.lastIndexOf(':')+1) : '';
    if (port) portCount[port] = (portCount[port] || 0) + 1;
  });
  const sorted = Object.entries(portCount).sort((a,b)=>b[1]-a[1]).slice(0, limit);
  const max = sorted[0]?.[1] || 1;
  const el = document.getElementById('top-ports-list');
  if (!sorted.length) { el.innerHTML = `<div style="color:var(--muted);font-size:.8rem;">Tidak ada data</div>`; return; }
  el.innerHTML = sorted.map(([port, cnt]) => {
    const pct = (cnt / max * 100).toFixed(0);
    const name = PORT_NAMES[port] ? ` <span style="color:var(--muted);font-size:.7rem;">${PORT_NAMES[port]}</span>` : '';
    return `<div class="rank-bar-row">
      <div style="width:80px;flex-shrink:0;font-family:monospace;font-size:.78rem;color:#3b82f6;font-weight:600;">:${port}${name}</div>
      <div class="rank-bar-bg"><div class="rank-bar-fill" style="background:linear-gradient(90deg,#3b82f6,#60a5fa);width:${pct}%;"></div></div>
      <div style="width:36px;text-align:right;font-size:.75rem;color:#e2e8f0;">${cnt}</div>
    </div>`;
  }).join('');
}

function renderTopIPs(conns, limit = 8) {
  const ipCount = {};
  conns.forEach(c => {
    const src = (c['src-address']||'').split(':')[0];
    if (src) ipCount[src] = (ipCount[src]||0) + 1;
  });
  const sorted = Object.entries(ipCount).sort((a,b)=>b[1]-a[1]).slice(0, limit);
  const max = sorted[0]?.[1] || 1;
  const el = document.getElementById('top-ips-list');
  if (!sorted.length) { el.innerHTML = `<div style="color:var(--muted);font-size:.8rem;">Tidak ada data</div>`; return; }
  el.innerHTML = sorted.map(([ip, cnt]) => {
    const pct = (cnt / max * 100).toFixed(0);
    return `<div class="rank-bar-row">
      <div style="width:120px;flex-shrink:0;font-family:monospace;font-size:.78rem;color:#22c55e;">${ip}</div>
      <div class="rank-bar-bg"><div class="rank-bar-fill" style="background:linear-gradient(90deg,#22c55e,#4ade80);width:${pct}%;"></div></div>
      <div style="width:36px;text-align:right;font-size:.75rem;color:#e2e8f0;">${cnt}</div>
    </div>`;
  }).join('');
}

function renderConnTable(conns) {
  if (!conns.length) {
    document.getElementById('conn-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px;">Tidak ada koneksi aktif.</td></tr>`;
    return;
  }
  document.getElementById('conn-tbody').innerHTML = conns.map(c => {
    const proto   = (c.protocol || '—').toUpperCase();
    const srcFull = c['src-address'] || '—';
    const dstFull = c['dst-address'] || '—';

    const srcSplit = srcFull.lastIndexOf(':');
    const srcIp   = srcSplit > 0 ? srcFull.substring(0, srcSplit) : srcFull;
    const srcPort = srcSplit > 0 ? srcFull.substring(srcSplit+1) : '—';

    const dstSplit = dstFull.lastIndexOf(':');
    const dstIp   = dstSplit > 0 ? dstFull.substring(0, dstSplit) : dstFull;
    const dstPort = dstSplit > 0 ? dstFull.substring(dstSplit+1) : '—';

    const portLabel = PORT_NAMES[dstPort] ? ` <span style="color:var(--muted);font-size:.68rem;">${PORT_NAMES[dstPort]}</span>` : '';
    const state     = c['tcp-state'] || c.state || '—';
    const stateBadge = state.toLowerCase() === 'established'
      ? `<span class="status-up" style="font-size:.68rem;">${state}</span>`
      : `<span class="status-warn" style="font-size:.68rem;">${state}</span>`;

    const bytes = (() => {
      const b = (parseInt(c['orig-bytes']||0) + parseInt(c['repl-bytes']||0));
      return fmt(b);
    })();

    return `<tr>
      <td><span style="font-family:monospace;font-size:.72rem;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);border-radius:4px;padding:1px 6px;color:#60a5fa;">${proto}</span></td>
      <td style="font-family:monospace;color:#e2e8f0;font-size:.78rem;">${srcIp}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.78rem;">${srcPort}</td>
      <td style="font-family:monospace;color:#e2e8f0;font-size:.78rem;">${dstIp}</td>
      <td style="font-family:monospace;font-size:.78rem;color:#a855f7;">${dstPort}${portLabel}</td>
      <td>${stateBadge}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${bytes}</td>
    </tr>`;
  }).join('');
}

function filterConnections() {
  const q = document.getElementById('conn-search').value.toLowerCase();
  // Search ALL fetched connections in memory; default shows first 500
  const filtered = q ? allConns.filter(c => JSON.stringify(c).toLowerCase().includes(q)) : allConns.slice(0, 500);
  renderConnTable(filtered);
  document.getElementById('conn-count').textContent = q
    ? `${filtered.length.toLocaleString('id-ID')} hasil pencarian`
    : `500 dari ${allConns.length.toLocaleString('id-ID')} koneksi`;
}

/* ─── Poll Loop ──────────────────────────────────────────────────────────── */
async function fetchMikrotikStats() {
  await Promise.all([
    fetchInterfaces(),
    fetchTraffic()
  ]);
}

async function fetchAll() {
  try {
    await Promise.all([
      fetchTechnitium(),
      fetchResources(),
      fetchMikrotikStats(),
      fetchHealth(),
      fetchPppoe(),
      fetchConnections(),
      fetchFirewallAndLogs(),
      fetchHistory(),
    ]);
    document.getElementById('last-update').textContent =
      new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

function startPolling() {
  fetchAll();
  pollTimer = setInterval(fetchAll, pollInterval);
}

function changeInterval() {
  pollInterval = parseInt(document.getElementById('interval-select').value);
  clearInterval(pollTimer);
  startPolling();
}

/* ─── Status Monitor ─────────────────────────────────────────────────────── */
async function startStatusMonitor() {
  setInterval(async () => {
    try {
      const { online } = await fetch('/api/alerts/status').then(r => r.json());
      const banner = document.getElementById('offline-banner');
      if (!online && isOnline) {
        isOnline = false;
        banner.style.display = 'block';
        showToast('Router offline! Tim NOC diberitahu via Telegram.', 6000);
      } else if (online && !isOnline) {
        isOnline = true;
        banner.style.display = 'none';
        showToast('Router kembali online!', 4000);
      }
    } catch (_) {}
  }, 15000);
}

/* ─── Actions ────────────────────────────────────────────────────────────── */
async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
}

async function testTelegram() {
  try {
    await fetch('/api/alerts/test', { method: 'POST' });
    showToast('Notifikasi test berhasil dikirim ke Telegram!', 4000);
  } catch (err) {
    showToast('Gagal kirim test Telegram: ' + err.message);
  }
}

/* ─── History Chart ─────────────────────────────────────────────────────────── */
function histChartConfig(colorIn, colorOut) {
  return {
    type: 'line',
    data: { labels: [], datasets: [
      { data: [], borderColor: colorIn, backgroundColor: colorIn.replace('rgb', 'rgba').replace(')', ',0.1)'), borderWidth: 1, pointRadius: 0, fill: true, tension: 0.1 },
      { data: [], borderColor: colorOut, backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, fill: false, tension: 0.1 }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: {
        mode: 'index', intersect: false, backgroundColor: '#1e2534', titleColor: '#8b9ab0', bodyColor: '#e2e8f0', borderColor: '#2d3748', borderWidth: 1,
        callbacks: { label: ctx => { const f = fmtRate(ctx.raw); return ` ${f.val} ${f.unit}`; } }
      }},
      scales: {
        x: { display: true, grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 9 }, maxRotation: 45, maxTicksLimit: 12 } },
        y: { display: true, min: 0, grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false }, ticks: {
          color: '#8b9ab0', font: { size: 10 }, maxTicksLimit: 4, callback: v => { const f = fmtRate(v); return f.val + ' ' + f.unit; } } },
      },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
    }
  };
}

function initHistoryChart() {
  if (chartHistGlobal) return;
  chartHistGlobal = new Chart(document.getElementById('chart-hist-global').getContext('2d'), histChartConfig('rgb(74, 222, 128)', 'rgb(192, 132, 252)'));
  chartHistSfp    = new Chart(document.getElementById('chart-hist-sfp').getContext('2d'), histChartConfig('rgb(56, 189, 248)', 'rgb(244, 114, 182)'));
  chartHistLacp   = new Chart(document.getElementById('chart-hist-lacp').getContext('2d'), histChartConfig('rgb(251, 191, 36)', 'rgb(251, 113, 133)'));
  chartHistArah   = new Chart(document.getElementById('chart-hist-arah').getContext('2d'), histChartConfig('rgb(74, 222, 128)', 'rgb(192, 132, 252)'));
}

/* ─── Fetch: Queues (Bandwidth per IP) ──────────────────────────────────────── */
async function fetchQueues() {
  try {
    const data = await fetch('/api/mikrotik/queues').then(r => r.json());
    if (data.error) { document.getElementById('queue-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:#f87171;padding:20px;">Error: ${data.error}</td></tr>`; return; }
    const queues = Array.isArray(data) ? data : [];
    document.getElementById('queue-count').textContent = `${queues.length} queue`;
    if (!queues.length) {
      document.getElementById('queue-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px;">Tidak ada queue terkonfigurasi.</td></tr>`;
      return;
    }
    document.getElementById('queue-tbody').innerHTML = queues.map(q => {
      const maxLimit = q['max-limit'] || '0/0';
      const [dl, ul] = maxLimit.split('/');
      const bytesStr = q.bytes || '0/0';
      const [rxBytes, txBytes] = bytesStr.split('/').map(v => parseInt(v) || 0);
      const rateStr  = q.rate || '0/0';
      const [rxR1, txR1] = rateStr.split('/').map(v => parseInt(v) || 0);
      const rxRate = fmtRate(rxR1), txRate = fmtRate(txR1);
      const disabled = q.disabled === 'true' || q.disabled === true;
      const badge    = disabled
        ? `<span style="color:var(--muted);font-size:.72rem;">disabled</span>`
        : `<span class="status-up" style="font-size:.68rem;"><span style="width:5px;height:5px;background:#22c55e;border-radius:50%;display:inline-block;"></span>active</span>`;
      return `<tr>
        <td style="color:#e2e8f0;font-weight:500;">${q.name||'—'}</td>
        <td style="font-family:monospace;color:#3b82f6;font-size:.78rem;">${q.target||q['dst-address']||'—'}</td>
        <td style="font-family:monospace;color:var(--muted);font-size:.75rem;">${(()=>{const d=fmtRate(parseInt(dl)||0),u=fmtRate(parseInt(ul)||0);return d.val+' '+d.unit+' / '+u.val+' '+u.unit})()}</td>
        <td style="font-family:monospace;color:#22c55e;font-size:.78rem;">${rxRate.val} ${rxRate.unit}</td>
        <td style="font-family:monospace;color:#a855f7;font-size:.78rem;">${txRate.val} ${txRate.unit}</td>
        <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${fmt(rxBytes+txBytes)}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    document.getElementById('queue-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:#f87171;padding:20px;">Gagal: ${err.message}</td></tr>`;
  }
}

/* ─── Fetch: Firewall Stats + System Log ────────────────────────────────────── */
const BRUTE_KEYWORDS = ['login failure', 'login failed', 'brute', 'port scan', 'syn flood', 'blocked', 'dropped', 'invalid'];
let allLogs = [];

async function fetchFirewallAndLogs() {
  // Firewall
  try {
    const fwData = await fetch('/api/mikrotik/firewall-stats').then(r => r.json());
    if (!fwData.error) renderFirewallTable(fwData);
  } catch (_) {}

  // Logs
  try {
    const logs = await fetch('/api/mikrotik/logs').then(r => r.json());
    if (!Array.isArray(logs)) return;
    allLogs = logs;

    // Brute force / scan detection
    const bruteEntries = logs.filter(l => BRUTE_KEYWORDS.some(k => (l.message||l.topics||'').toLowerCase().includes(k)));
    const brutePanel   = document.getElementById('brute-panel');
    if (bruteEntries.length) {
      brutePanel.style.display = 'block';
      document.getElementById('brute-count').textContent = `${bruteEntries.length} kejadian`;
      document.getElementById('brute-list').innerHTML = bruteEntries.slice(0, 10).map(l =>
        `<div>[${l.time||''}] ${l.topics||''} — ${l.message||''}</div>`).join('');
      const fwBadge = document.getElementById('fw-badge');
      fwBadge.textContent = bruteEntries.length;
      fwBadge.style.display = 'inline';
    } else {
      brutePanel.style.display = 'none';
      document.getElementById('fw-badge').style.display = 'none';
    }

    // Severity summary
    const sev = { critical:0, error:0, warning:0, info:0, debug:0 };
    logs.forEach(l => {
      const t = (l.topics||'').toLowerCase();
      if (t.includes('critical')) sev.critical++;
      else if (t.includes('error')) sev.error++;
      else if (t.includes('warning')||t.includes('warn')) sev.warning++;
      else if (t.includes('debug')) sev.debug++;
      else sev.info++;
    });
    const maxSev = Math.max(...Object.values(sev)) || 1;
    const sevColors = { critical:'#ef4444', error:'#f97316', warning:'#f59e0b', info:'#3b82f6', debug:'#8b9ab0' };
    document.getElementById('log-summary').innerHTML = Object.entries(sev).filter(([,v])=>v>0).map(([k,v]) =>
      `<div class="rank-bar-row">
        <div style="width:64px;flex-shrink:0;font-size:.75rem;color:${sevColors[k]};font-weight:600;text-transform:capitalize;">${k}</div>
        <div class="rank-bar-bg"><div class="rank-bar-fill" style="background:${sevColors[k]};width:${(v/maxSev*100).toFixed(0)}%;"></div></div>
        <div style="width:36px;text-align:right;font-size:.75rem;color:#e2e8f0;">${v}</div>
      </div>`).join('');

    renderLogViewer(logs);
  } catch (_) {}
}

function renderFirewallTable(fwData) {
  const rules = [...(fwData.filter||[]),...(fwData.nat||[]),...(fwData.mangle||[])]
    .filter(r => r.action==='drop'||r.action==='reject'||r.action==='tarpit')
    .sort((a,b) => parseInt(b.packets||0)-parseInt(a.packets||0))
    .slice(0,20);
  if (!rules.length) {
    document.getElementById('fw-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px;">Tidak ada drop rule aktif.</td></tr>`;
    return;
  }
  const actionColor = { drop:'#ef4444', reject:'#f97316', tarpit:'#8b5cf6' };
  document.getElementById('fw-tbody').innerHTML = rules.map(r => {
    const pkt = parseInt(r.packets||0);
    return `<tr>
      <td style="font-family:monospace;font-size:.75rem;color:#3b82f6;">${r.chain||'—'}</td>
      <td><span style="background:${(actionColor[r.action]||'#64748b')}22;border:1px solid ${(actionColor[r.action]||'#64748b')}44;border-radius:4px;padding:1px 6px;font-size:.68rem;color:${actionColor[r.action]||'#94a3b8'};font-family:monospace;">${r.action}</span></td>
      <td style="font-family:monospace;font-size:.75rem;color:#94a3b8;">${r['src-address']||r['src-address-list']||'any'}</td>
      <td style="font-family:monospace;font-size:.75rem;color:#a855f7;">${r['dst-port']||'—'}</td>
      <td style="font-family:monospace;font-size:.75rem;color:${pkt>1000?'#f87171':'#e2e8f0'};font-weight:${pkt>1000?700:400};">${pkt.toLocaleString()}</td>
      <td style="font-family:monospace;font-size:.75rem;color:#94a3b8;">${fmt(parseInt(r.bytes||0))}</td>
    </tr>`;
  }).join('');
}

const LOG_COLORS = {
  critical: { bg:'rgba(239,68,68,.15)',   border:'rgba(239,68,68,.3)',   text:'#f87171' },
  error:    { bg:'rgba(249,115,22,.12)',  border:'rgba(249,115,22,.25)', text:'#fb923c' },
  warning:  { bg:'rgba(245,158,11,.1)',   border:'rgba(245,158,11,.2)',  text:'#fbbf24' },
  info:     { bg:'rgba(59,130,246,.08)',  border:'rgba(59,130,246,.15)', text:'#60a5fa' },
  debug:    { bg:'rgba(100,116,139,.08)', border:'rgba(100,116,139,.15)',text:'#94a3b8' },
};

function logSeverity(l) {
  const t = (l.topics||'').toLowerCase();
  if (t.includes('critical')) return 'critical';
  if (t.includes('error'))    return 'error';
  if (t.includes('warning')||t.includes('warn')) return 'warning';
  if (t.includes('debug'))    return 'debug';
  return 'info';
}

function renderLogViewer(logs) {
  const q     = (document.getElementById('log-search')?.value||'').toLowerCase();
  const topic = document.getElementById('log-filter-topic')?.value||'';
  const filt  = logs.filter(l => {
    if (topic && !(l.topics||'').toLowerCase().includes(topic)) return false;
    if (q && !JSON.stringify(l).toLowerCase().includes(q)) return false;
    return true;
  });
  document.getElementById('log-viewer').innerHTML = filt.slice(0,100).map(l => {
    const sev = logSeverity(l);
    const c   = LOG_COLORS[sev]||LOG_COLORS.info;
    return `<div style="padding:4px 8px;border-radius:5px;background:${c.bg};border-left:2px solid ${c.border};display:flex;gap:10px;">
      <span style="color:${c.text};min-width:60px;flex-shrink:0;">[${(l.time||'').substring(0,8)}]</span>
      <span style="color:#8b9ab0;min-width:70px;flex-shrink:0;font-size:.7rem;">${(l.topics||'').substring(0,20)}</span>
      <span style="color:#e2e8f0;">${l.message||''}</span>
    </div>`;
  }).join('')||`<div style="color:var(--muted);padding:16px;text-align:center;">Tidak ada log yang cocok.</div>`;
}

function filterLog() { renderLogViewer(allLogs); }

/* ─── Fetch: DNS Cache ───────────────────────────────────────────────────────── */
let allDns = [];

async function fetchDnsCache() {
  try {
    const data = await fetch('/api/mikrotik/dns-cache').then(r => r.json());
    if (data.error) return;
    allDns = Array.isArray(data) ? data : [];
    document.getElementById('dns-count').textContent = `${allDns.length} entry`;
    renderDnsTable(allDns);
  } catch (_) {}
}

function renderDnsTable(entries) {
  if (!entries.length) {
    document.getElementById('dns-tbody').innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:28px;">Tidak ada cache DNS.</td></tr>`;
    return;
  }
  document.getElementById('dns-tbody').innerHTML = entries.map(e => {
    const name = e.name||'—';
    const type = e.type||e['dns-type']||'A';
    const addr = e.address||e.data||'—';
    const ttl  = e.ttl||e['live-time']||'—';
    const tc   = type==='AAAA'?'#a855f7':type==='CNAME'?'#f59e0b':type==='MX'?'#22c55e':'#3b82f6';
    return `<tr>
      <td style="color:#e2e8f0;font-family:monospace;font-size:.8rem;">${name}</td>
      <td><span style="background:${tc}22;border:1px solid ${tc}44;border-radius:4px;padding:1px 6px;font-size:.7rem;color:${tc};font-family:monospace;">${type}</span></td>
      <td style="font-family:monospace;color:#3b82f6;font-size:.78rem;">${addr}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.75rem;">${ttl}</td>
    </tr>`;
  }).join('');
}

function filterDns() {
  const q = document.getElementById('dns-search').value.toLowerCase();
  renderDnsTable(q ? allDns.filter(e => JSON.stringify(e).toLowerCase().includes(q)) : allDns);
}

/* ─── Fetch: Ping Status ────────────────────────────────────────────── */
async function fetchPingStatus() {
  try {
    const d = await fetch('/api/ping/status').then(r => r.json());
    const iconEl  = document.getElementById('ping-status-icon');
    const textEl  = document.getElementById('ping-status-text');
    const detailEl= document.getElementById('ping-status-detail');
    const badge   = document.getElementById('ping-badge');
    const tzOpts  = { timeZone: 'Asia/Jakarta' };

    if (d.online === true) {
      iconEl.innerHTML = `<svg width="56" height="56" fill="none" viewBox="0 0 24 24" stroke="#22c55e" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"/></svg>`;
      textEl.textContent = 'Koneksi Ping AMAN';
      textEl.style.color = '#22c55e';
      detailEl.textContent = `Target: ${d.target} — Total sukses: ${d.totalSuccess}`;
      badge.style.display = 'none';
      document.getElementById('ping-stat-status').style.color = '#22c55e';
      document.getElementById('ping-stat-status').textContent = 'Online';
    } else if (d.online === false) {
      iconEl.innerHTML = `<svg width="56" height="56" fill="none" viewBox="0 0 24 24" stroke="#ef4444" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>`;
      textEl.textContent = `RTO — ${d.consecutiveRTO}x Berturut-turut`;
      textEl.style.color = '#ef4444';
      detailEl.textContent = d.lastRTODetail || `Target: ${d.target}`;
      badge.textContent = d.consecutiveRTO;
      badge.style.background = '#ef4444';
      badge.style.display = 'inline';
      document.getElementById('ping-stat-status').style.color = '#ef4444';
      document.getElementById('ping-stat-status').textContent = 'RTO';
    } else {
      textEl.textContent = 'Menginisialisasi…';
      textEl.style.color = '#8b9ab0';
    }

    document.getElementById('ping-stat-consecutive').textContent = d.consecutiveRTO || 0;
    document.getElementById('ping-stat-total-rto').textContent   = d.totalRTO || 0;
    document.getElementById('ping-stat-total-ok').textContent    = d.totalSuccess || 0;
    document.getElementById('ping-last-ok').textContent  = d.lastSuccess
      ? new Date(d.lastSuccess).toLocaleString('id-ID', tzOpts) : '—';
    document.getElementById('ping-last-rto').textContent = d.lastRTO
      ? new Date(d.lastRTO).toLocaleString('id-ID', tzOpts) : '—';
    document.getElementById('ping-last-rto-detail').textContent = d.lastRTODetail || '';
  } catch (_) {}
}

/* ─── Fetch: History (chart + alerts + uptime) ───────────────────────────────── */
async function fetchHistory() {
  try {
    initHistoryChart();
    const [traffic, uptimeEvts, thresholdEvts] = await Promise.all([
      fetch('/api/history/traffic').then(r => r.json()).catch(() => []),
      fetch('/api/history/uptime').then(r => r.json()).catch(() => []),
      fetch('/api/history/threshold-alerts').then(r => r.json()).catch(() => []),
    ]);

    // Traffic history chart updates BOTH the main dashboard and the history tab
    if (Array.isArray(traffic)) {
      updateTrafficUI(traffic);

      if (traffic.length) {
        const histLabels = traffic.map(p => {
          const d = new Date(p.ts || Date.now());
          return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
        });
        
        const setHistData = (chart, key) => {
          if (!chart) return;
          chart.data.labels = histLabels;
          chart.data.datasets[0].data = traffic.map(p => p[key] ? p[key].rx : 0);
          chart.data.datasets[1].data = traffic.map(p => p[key] ? p[key].tx : 0);
          chart.update('none');
        };

        setHistData(chartHistGlobal, 'total');
        setHistData(chartHistSfp, 'sfp');
        setHistData(chartHistLacp, 'lacp');
        setHistData(chartHistArah, 'arah');

        document.getElementById('history-points').textContent = `${traffic.length} titik data (Maks 24h)`;
      }
    }

    // Threshold alert list
    const alertEl = document.getElementById('alert-list');
    const alertBadge = document.getElementById('alert-badge');
    if (!thresholdEvts.length) {
      alertEl.innerHTML = `<div style="color:var(--muted);font-size:.82rem;text-align:center;padding:20px;display:flex;align-items:center;justify-content:center;gap:8px;"><svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Tidak ada threshold alert tercatat.</div>`;
      alertBadge.style.display = 'none';
    } else {
      alertBadge.textContent = thresholdEvts.length;
      alertBadge.style.display = 'inline';
      alertEl.innerHTML = thresholdEvts.map(a => {
        const ts    = new Date(a.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const color = a.type==='cpu'?'#3b82f6':a.type==='cpu-temp'?'#ef4444':'#f97316';
        return `<div style="background:${color}11;border:1px solid ${color}33;border-radius:8px;padding:8px 12px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
            <span style="font-weight:600;color:${color};font-size:.8rem;">${a.label}</span>
            <span style="font-size:.7rem;color:var(--muted);">${ts}</span>
          </div>
          <div style="font-size:.75rem;color:#e2e8f0;">Nilai: <strong>${(a.value||0).toFixed(1)}${a.unit}</strong> &gt; threshold ${a.threshold}${a.unit}</div>
        </div>`;
      }).join('');
    }

    // Uptime / reboot history
    const uptimeEl = document.getElementById('uptime-list');
    if (!uptimeEvts.length) {
      uptimeEl.innerHTML = `<div style="color:var(--muted);font-size:.82rem;text-align:center;padding:20px;">Belum ada event uptime tercatat.</div>`;
    } else {
      uptimeEl.innerHTML = uptimeEvts.map(e => {
        const ts    = new Date(e.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const iconSvg = e.event==='reboot'
          ? `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`
          : `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3l14 9-14 9V3z"/></svg>`;
        const color = e.event==='reboot'?'#f97316':'#22c55e';
        return `<div style="background:${color}11;border:1px solid ${color}33;border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:.82rem;color:#e2e8f0;display:flex;align-items:center;gap:6px;">${iconSvg} ${e.label}</span>
          <div style="text-align:right;">
            <div style="font-size:.7rem;color:var(--muted);">${ts}</div>
            <div style="font-family:monospace;font-size:.72rem;color:${color};">${e.uptimeStr}</div>
          </div>
        </div>`;
      }).join('');
    }
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  SNMP Devices
 * ═══════════════════════════════════════════════════════════════════════════ */

function fmtBytes(n) {
  if (!n || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtSnmpUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

async function fetchSnmpDevices() {
  try {
    const devices = await fetch('/api/snmp/devices').then(r => r.json());
    snmpDevices = Array.isArray(devices) ? devices : [];

    // Populate device select (no placeholder — auto-select first)
    const sel = document.getElementById('snmp-device-select');
    if (sel) {
      const prevKey = sel.value;
      sel.innerHTML = '';
      snmpDevices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.key;
        opt.textContent = `${d.label} (${d.host})`;
        sel.appendChild(opt);
      });
      // Try restoring previous selection or pick first
      if (prevKey && snmpDevices.find(d => d.key === prevKey)) {
        sel.value = prevKey;
      } else if (snmpDevices.length) {
        sel.value = snmpDevices[0].key;
        loadSnmpInterfaces();
      }
    }

    // Fetch all device sysinfo for summary cards
    const allInfo = await fetch('/api/snmp/all').then(r => r.json());
    renderSnmpDeviceCards(allInfo);
  } catch (e) {
    console.warn('[SNMP] fetchSnmpDevices error:', e.message);
  }
}

function renderSnmpDeviceCards(devices) {
  const container = document.getElementById('snmp-device-cards');
  if (!container) return;
  if (!devices || !devices.length) {
    container.innerHTML = `<div style="color:var(--muted);font-size:.8rem;padding:12px;">Tidak ada perangkat SNMP yang dikonfigurasi di .env</div>`;
    return;
  }
  container.innerHTML = devices.map(d => {
    const online = !d.error;
    const statusColor = online ? '#22c55e' : '#ef4444';
    const uptime = online ? fmtSnmpUptime(d.uptime_s || 0) : '—';
    return `
      <div class="dash-card fade-up" style="padding:16px;cursor:pointer;" onclick="document.getElementById('snmp-device-select').value='${d.key}';loadSnmpInterfaces();">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
          <div>
            <div style="font-size:.7rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px;">SNMP Device</div>
            <div style="font-size:1rem;font-weight:700;color:#e2e8f0;">${d.label}</div>
            <div style="font-family:monospace;font-size:.72rem;color:var(--muted);">${d.host}</div>
          </div>
          <span style="background:${statusColor}22;border:1px solid ${statusColor}44;color:${statusColor};font-size:.68rem;font-weight:600;padding:2px 8px;border-radius:6px;white-space:nowrap;">
            ${online ? '● Online' : '● Offline'}
          </span>
        </div>
        ${online ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:.75rem;">
          <div style="background:var(--card-bg);border-radius:8px;padding:8px;">
            <div style="color:var(--muted);font-size:.65rem;margin-bottom:2px;">UPTIME</div>
            <div style="font-family:monospace;color:#10b981;font-weight:600;">${uptime}</div>
          </div>
          <div style="background:var(--card-bg);border-radius:8px;padding:8px;">
            <div style="color:var(--muted);font-size:.65rem;margin-bottom:2px;">SYS NAME</div>
            <div style="font-family:monospace;color:#3b82f6;font-weight:600;font-size:.7rem;">${(d.name || '—').substring(0,16)}</div>
          </div>
        </div>
        <div style="margin-top:8px;font-size:.65rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(d.descr || '').substring(0,60)}</div>
        ` : `<div style="color:#ef4444;font-size:.75rem;">${d.error || 'Connection failed'}</div>`}
      </div>`;
  }).join('');
}

function renderSnmpIfaceStats(ifaces) {
  const container = document.getElementById('snmp-iface-stats');
  if (!container) return;
  const total     = ifaces.length;
  const upCount   = ifaces.filter(i => i.status === 'up').length;
  const downCount = ifaces.filter(i => i.status === 'down').length;
  const vlanCount = ifaces.filter(i => (i.alias || '').toLowerCase().includes('vlan') || (i.name || '').toLowerCase().includes('vlan')).length;
  const stats = [
    { label: 'Total Interface', value: total,     color: '#3b82f6', icon: '⊞' },
    { label: 'Up',              value: upCount,   color: '#22c55e', icon: '▲' },
    { label: 'Down',            value: downCount, color: '#ef4444', icon: '▼' },
    { label: 'VLAN / vlanif',   value: vlanCount, color: '#a855f7', icon: '⬡' },
  ];
  container.innerHTML = stats.map((s, idx) => `
    <div class="snmp-stat-card" style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:16px;animation-delay:${idx * 60}ms;">
      <div style="width:44px;height:44px;border-radius:50%;background:${s.color}18;border:1.5px solid ${s.color}44;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="font-size:1.3rem;font-weight:800;color:${s.color};font-variant-numeric:tabular-nums;">${s.value}</span>
      </div>
      <div>
        <div style="font-size:.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px;">${s.label}</div>
        <div style="font-size:.9rem;font-weight:700;color:#e2e8f0;">${s.value} <span style="font-size:.7rem;font-weight:400;color:var(--muted);">entri</span></div>
      </div>
    </div>`).join('');
}

async function loadSnmpInterfaces() {
  const sel = document.getElementById('snmp-device-select');
  const key = sel ? sel.value : '';

  const tbody = document.getElementById('snmp-iface-tbody');
  const countEl = document.getElementById('snmp-iface-count');

  // Clear timeout to prevent overlapping refreshes
  clearTimeout(snmpIfaceTimer);

  if (!key) return;

  // Anti-blink: only show loading if tbody is currently empty
  if (tbody && !tbody.querySelector('tr td[data-iface]')) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;">Memuat data interface...</td></tr>`;
  }

  try {
    const data = await fetch(`/api/snmp/interfaces/${key}`).then(r => r.json());
    const errMsg = data.error || (data.sysinfo && data.sysinfo.error);
    if (errMsg) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#ef4444;padding:24px;">${errMsg}</td></tr>`;
      if (countEl) countEl.textContent = '0 entri';
      // reset summary cards to skeletons or zero
      const statsContainer = document.getElementById('snmp-iface-stats');
      if (statsContainer) {
        statsContainer.innerHTML = `
          <div class="snmp-stat-skeleton"></div>
          <div class="snmp-stat-skeleton"></div>
          <div class="snmp-stat-skeleton"></div>
          <div class="snmp-stat-skeleton"></div>`;
      }
      return;
    }

    const ifaces = data.interfaces || [];
    if (countEl) countEl.textContent = `${ifaces.length} interface`;

    // Update summary stats cards
    renderSnmpIfaceStats(ifaces);

    if (!ifaces.length) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;">Tidak ada interface ditemukan</td></tr>`;
      return;
    }

    // Anti-blink: build new HTML and only set if it changed
    const newHtml = ifaces.map(i => {
      const isUp = i.status === 'up';
      const statusDot = `<span style="color:${isUp ? '#22c55e' : '#ef4444'};font-weight:700;">${isUp ? '●' : '○'}</span> ${i.status || '—'}`;
      const alias = i.alias || '';
      const isVlan = alias.toLowerCase().includes('vlan') || (i.name || '').toLowerCase().includes('vlan');
      const aliasHtml = alias
        ? `<span style="background:${isVlan ? 'rgba(168,85,247,.12)' : 'rgba(59,130,246,.1)'};color:${isVlan ? '#c084fc' : '#60a5fa'};border-radius:5px;padding:1px 6px;font-size:.7rem;font-family:monospace;">${alias}</span>`
        : `<span style="color:var(--muted);">—</span>`;
      const speed = i.speed ? `${i.speed} Mbps` : '—';
      return `<tr>
        <td data-iface style="font-family:monospace;font-size:.75rem;color:var(--muted);padding:7px 12px;">${i.idx}</td>
        <td style="color:#e2e8f0;font-weight:500;padding:7px 12px;">${i.name || '—'}</td>
        <td style="padding:7px 12px;">${aliasHtml}</td>
        <td style="text-align:right;font-family:monospace;font-size:.75rem;color:var(--muted);padding:7px 12px;">${speed}</td>
        <td style="text-align:right;font-family:monospace;font-size:.75rem;color:#3b82f6;padding:7px 12px;">${fmtBytes(i.rxOctets)}</td>
        <td style="text-align:right;font-family:monospace;font-size:.75rem;color:#a855f7;padding:7px 12px;">${fmtBytes(i.txOctets)}</td>
        <td style="text-align:center;font-size:.75rem;padding:7px 12px;">${statusDot}</td>
      </tr>`;
    }).join('');

    if (tbody && tbody.innerHTML !== newHtml) tbody.innerHTML = newHtml;

    // Auto-refresh every 30s while on SNMP tab
    clearTimeout(snmpIfaceTimer);
    snmpIfaceTimer = setTimeout(() => {
      if (activeTab === 'snmp') loadSnmpInterfaces();
    }, 30000);

  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#ef4444;padding:24px;">${e.message}</td></tr>`;
  }
}

// (SNMP tab hook is integrated into switchTab above)

// ═════════════════════ GUI SETTINGS MODAL ═════════════════════

let dynamicMkCount = 0;
let dynamicSnmpCount = 0;

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.settings-pane').forEach(p => p.style.display = 'none');
  
  document.getElementById(`st-${tab}`).classList.add('active');
  document.getElementById(`settings-${tab}`).style.display = 'block';
}

function buildMkBlock(key, label, host, apiPort, webPort, userStr, disabled) {
  const isMain = key === 'MIKROTIK';
  const namePrefix = isMain ? 'MIKROTIK' : `MK_DEVICE_${key}`;
  
  return `
    <div class="mk-node-block" style="padding:12px;background:var(--bg-color);border:1px solid var(--border-color);border-radius:8px;position:relative;">
      ${!isMain ? `<button type="button" onclick="this.parentElement.remove()" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#ef4444;cursor:pointer;font-size:1rem;line-height:1;">&times;</button>` : ''}
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">Identifier Key (Tanpa Spasi, contoh: R50)</label>
        <input type="text" class="login-input" value="${isMain ? 'MAIN' : key}" ${isMain ? 'disabled' : `name="dyn_mk_key_${dynamicMkCount}"`}  style="padding:8px;font-size:.8rem;background:${isMain?'transparent':'rgba(255,255,255,0.05)'};color:${isMain?'var(--muted)':'#e2e8f0'};" required>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">Label Dashboard</label>
        <input type="text" ${isMain ? '' : `name="dyn_mk_lbl_${dynamicMkCount}"`} class="login-input" placeholder="e.g. .50 BRS Utama" value="${label}" style="padding:8px;font-size:.8rem;" ${isMain ? 'disabled title="MAIN default"' : 'required'}>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">IP / Host</label>
        <input type="text" name="${namePrefix}_HOST" class="login-input" value="${host}" style="padding:8px;font-size:.8rem;" required>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">API Port</label>
          <input type="number" name="${namePrefix}_API_PORT" class="login-input" value="${apiPort}" style="padding:8px;font-size:.8rem;" required>
        </div>
        <div>
          <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">Web Port (Grafik)</label>
          <input type="number" name="${namePrefix}_WEB_PORT" class="login-input" value="${webPort}" style="padding:8px;font-size:.8rem;" ${isMain ? '' : 'placeholder="Opsional"'}>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">Username</label>
          <input type="text" name="${namePrefix}_USER" class="login-input" value="${userStr}" style="padding:8px;font-size:.8rem;" required>
        </div>
        <div>
          <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">Password</label>
          <input type="password" name="${namePrefix}_PASS" class="login-input" style="padding:8px;font-size:.8rem;" placeholder="********">
        </div>
      </div>
    </div>
  `;
}

function buildSnmpBlock(key, label, host, comm) {
  return `
    <div class="snmp-node-block" style="padding:12px;background:var(--bg-color);border:1px solid var(--border-color);border-radius:8px;position:relative;">
      <button type="button" onclick="this.parentElement.remove()" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#ef4444;cursor:pointer;font-size:1rem;line-height:1;">&times;</button>
      <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-bottom:12px;">
        <div>
          <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">Key (e.g. OLT1)</label>
          <input type="text" name="dyn_snmp_key_${dynamicSnmpCount}" class="login-input" value="${key}" style="padding:8px;font-size:.8rem;" required>
        </div>
        <div>
          <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">Label (e.g. OLT ZTE Arah)</label>
          <input type="text" name="dyn_snmp_lbl_${dynamicSnmpCount}" class="login-input" value="${label}" style="padding:8px;font-size:.8rem;" required>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">IP Target</label>
          <input type="text" name="dyn_snmp_host_${dynamicSnmpCount}" class="login-input" value="${host}" style="padding:8px;font-size:.8rem;" required>
        </div>
        <div>
          <label style="display:block;font-size:.7rem;color:#94a3b8;margin-bottom:4px;">Community (SNMP v2c)</label>
          <input type="text" name="dyn_snmp_comm_${dynamicSnmpCount}" class="login-input" value="${comm}" style="padding:8px;font-size:.8rem;" required>
        </div>
      </div>
    </div>
  `;
}

function addMikrotikNode() {
  dynamicMkCount++;
  document.getElementById('dyn-mikrotik-list').insertAdjacentHTML('beforeend', buildMkBlock('', '', '', '8728', '', ''));
}

function addSnmpNode() {
  dynamicSnmpCount++;
  document.getElementById('dyn-snmp-list').insertAdjacentHTML('beforeend', buildSnmpBlock('', '', '', 'public'));
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings', { headers: { 'Authorization': getAuthHeader() } });
    if (res.status === 401 || res.status === 403) return logout();
    const data = await res.json();
    
    // Auto-fill standard inputs
    for (const [key, val] of Object.entries(data)) {
      const input = document.getElementById(`s_${key}`);
      if (input) {
        if (input.type === 'password' && val === '********') {
          input.value = ''; 
        } else {
          input.value = val;
        }
      }
    }

    // Build MikroTik List
    const mkContainer = document.getElementById('dyn-mikrotik-list');
    mkContainer.innerHTML = '';
    const mainHost = data.MIKROTIK_HOST || '';
    mkContainer.innerHTML += buildMkBlock('MIKROTIK', '.31 Utama (CCR)', mainHost, data.MIKROTIK_API_PORT || '56988', data.MIKROTIK_WEB_PORT || '80', data.MIKROTIK_USER || '');
    
    // Legacy mapping (BRS, R50, etc into dynamic slots for editing)
    const leg = ['BRS', 'R50', 'R155'];
    leg.forEach(k => {
      if (data[`${k}_HOST`]) {
        dynamicMkCount++;
        mkContainer.innerHTML += buildMkBlock(k, data[`MK_DEVICE_${k}_LABEL`] || k, data[`${k}_HOST`], data[`${k}_API_PORT`], data[`${k}_WEB_PORT`]||'', data[`${k}_USER`]);
      }
    });

    for (const k of Object.keys(data)) {
      const match = k.match(/^MK_DEVICE_([A-Z0-9_]+)_HOST$/);
      if (match) {
        dynamicMkCount++;
        const pKey = match[1];
        mkContainer.innerHTML += buildMkBlock(pKey, data[`MK_DEVICE_${pKey}_LABEL`], data[k], data[`MK_DEVICE_${pKey}_API_PORT`], data[`MK_DEVICE_${pKey}_WEB_PORT`], data[`MK_DEVICE_${pKey}_USER`]);
      }
    }

    // Build SNMP List
    const snmpContainer = document.getElementById('dyn-snmp-list');
    snmpContainer.innerHTML = '';
    for (const k of Object.keys(data)) {
      const match = k.match(/^SNMP_DEVICE_([A-Z0-9_]+)_HOST$/);
      if (match) {
        dynamicSnmpCount++;
        const pKey = match[1];
        snmpContainer.innerHTML += buildSnmpBlock(pKey, data[`SNMP_DEVICE_${pKey}_LABEL`], data[k], data[`SNMP_DEVICE_${pKey}_COMMUNITY`]);
      }
    }
  } catch (err) {
    showToast('Gagal memuat pengaturan: ' + err.message);
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const btn = document.getElementById('settings-save-btn');
  btn.textContent = 'Menyimpan...';
  btn.disabled = true;

  const form = document.getElementById('settings-form');
  const fd = new FormData(form);
  const payload = {};
  
  // Array management: Instruct backend to wipe all dynamic keys before assigning from form
  payload._DELETE_PREFIXES = ['MK_DEVICE_', 'SNMP_DEVICE_', 'BRS_HOST', 'R50_HOST', 'R155_HOST', 'BRS_API_PORT', 'R50_API_PORT', 'R155_API_PORT', 'BRS_USER', 'R50_USER', 'R155_USER'];

  const mkPairs = {};
  const snmpPairs = {};

  fd.forEach((value, key) => {
    const val = value.trim();
    if (val === '') return;

    // Intercept dynamically generated names and turn them into standardized prefixes
    if (key.startsWith('dyn_mk_key_')) {
      const idx = key.replace('dyn_mk_key_', '');
      mkPairs[idx] = mkPairs[idx] || {};
      mkPairs[idx].key = val.replace(/[^A-Z0-9_]/gi, '').toUpperCase();
    } else if (key.startsWith('dyn_mk_lbl_')) {
      const idx = key.replace('dyn_mk_lbl_', '');
      mkPairs[idx] = mkPairs[idx] || {};
      mkPairs[idx].label = val;
    } else if (key.startsWith('dyn_snmp_')) {
      // dyn_snmp_key_1, dyn_snmp_lbl_1, dyn_snmp_host_1, dyn_snmp_comm_1
      const parts = key.split('_');
      const prop = parts[2];
      const idx = parts[3];
      snmpPairs[idx] = snmpPairs[idx] || {};
      if (prop === 'key') snmpPairs[idx].key = val.replace(/[^A-Z0-9_]/gi, '').toUpperCase();
      if (prop === 'lbl') snmpPairs[idx].label = val;
      if (prop === 'host') snmpPairs[idx].host = val;
      if (prop === 'comm') snmpPairs[idx].comm = val;
    } else {
      payload[key] = val; // MIKROTIK_HOST, MK_DEVICE_XYZ_... inputs mapped natively
    }
  });

  // Re-inject mapped pairs into payload
  for (const idx of Object.keys(mkPairs)) {
    const m = mkPairs[idx];
    if (m.key) {
      payload[`MK_DEVICE_${m.key}_LABEL`] = m.label || m.key;
      // Note: The rest of MK_DEVICE_<KEY>_HOST is already in payload because the inputs are dynamically named
    }
  }

  for (const idx of Object.keys(snmpPairs)) {
    const p = snmpPairs[idx];
    if (p.key && p.host) {
      payload[`SNMP_DEVICE_${p.key}_HOST`] = p.host;
      payload[`SNMP_DEVICE_${p.key}_COMMUNITY`] = p.comm || 'public';
      payload[`SNMP_DEVICE_${p.key}_LABEL`] = p.label || p.key;
    }
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(payload)
    });
    
    if (res.status === 401 || res.status === 403) return logout();
    const data = await res.json();
    
    if (data.error) throw new Error(data.error);

    document.getElementById('settings-modal').style.display = 'none';

    if (data.requiresRestart) {
      // Show PM2 restart blocking overlay
      const overlay = document.getElementById('restart-overlay');
      overlay.style.display = 'flex';
      let sec = 4;
      const cnt = document.getElementById('restart-countdown');
      const timer = setInterval(() => {
        sec--;
        if (cnt) cnt.textContent = sec;
        if (sec <= 0) {
          clearInterval(timer);
          window.location.reload();
        }
      }, 1000);
    } else {
      showToast(data.message || 'Pengaturan berhasil disimpan');
      // Soft refresh connections natively
      fetchMikrotikStats();
    }
    
  } catch (err) {
    showToast('Gagal menyimpan: ' + err.message);
  } finally {
    btn.textContent = 'Simpan Pengaturan';
    btn.disabled = false;
  }
}
