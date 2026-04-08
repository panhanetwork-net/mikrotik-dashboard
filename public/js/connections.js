'use strict';

// Known port names for display
const PORT_NAMES = {
  '80': 'HTTP', '443': 'HTTPS', '22': 'SSH', '21': 'FTP', '25': 'SMTP',
  '53': 'DNS', '110': 'POP3', '143': 'IMAP', '3306': 'MySQL', '5432': 'PostgreSQL',
  '3389': 'RDP', '23': 'Telnet', '8080': 'HTTP-Alt', '8443': 'HTTPS-Alt',
  '1194': 'OpenVPN', '1723': 'PPTP', '4500': 'IPSec', '500': 'IKE',
};

let allConns = [];

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const me = await fetch('/api/me').then(r => r.json());
    if (!me.ok) { window.location.href = '/'; return; }
  } catch (_) {
    window.location.href = '/';
    return;
  }
  if (window.gsap) gsap.to('.fade-up', { opacity: 1, y: 0, duration: .5, ease: 'power3.out', stagger: .06 });
  await loadConnections();
});

async function loadConnections() {
  document.getElementById('conn-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:40px;"><span class="spinner"></span> Memuat koneksi aktif…</td></tr>`;
  try {
    const data = await fetch('/api/mikrotik/connections').then(r => r.json());
    if (data.error) throw new Error(data.error);
    allConns = data;
    updateStats(data);
    renderTopPorts(data);
    renderTopIPs(data);
    renderTable(data);
  } catch (err) {
    showToast('Error: ' + err.message);
    document.getElementById('conn-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:#f87171;padding:32px;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

function updateStats(conns) {
  const established = conns.filter(c => (c['tcp-state'] || c.state || '').toLowerCase() === 'established');
  const srcIPs = new Set(conns.map(c => (c['src-address'] || '').split(':')[0]).filter(Boolean));
  const dstPorts = new Set(conns.map(c => {
    const dst = c['dst-address'] || '';
    return dst.includes(':') ? dst.split(':')[1] : '';
  }).filter(Boolean));

  document.getElementById('conn-total').textContent       = conns.length;
  document.getElementById('conn-established').textContent = established.length;
  document.getElementById('conn-src-ips').textContent     = srcIPs.size;
  document.getElementById('conn-dst-ports').textContent   = dstPorts.size;
  document.getElementById('conn-count').textContent       = `${conns.length} koneksi`;
}

function renderTopPorts(conns, limit = 8) {
  const portCount = {};
  conns.forEach(c => {
    const dst = c['dst-address'] || '';
    const port = dst.includes(':') ? dst.split(':')[1] : '';
    if (port) portCount[port] = (portCount[port] || 0) + 1;
  });

  const sorted = Object.entries(portCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const max = sorted[0]?.[1] || 1;
  const el = document.getElementById('top-ports-list');

  if (!sorted.length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:.82rem;">Tidak ada data koneksi</div>`;
    return;
  }

  el.innerHTML = sorted.map(([port, cnt]) => {
    const pct = (cnt / max * 100).toFixed(0);
    const name = PORT_NAMES[port] ? `<span style="color:var(--muted);margin-left:6px;font-size:.72rem;">(${PORT_NAMES[port]})</span>` : '';
    return `<div style="display:flex;align-items:center;gap:12px;">
      <div style="width:70px;flex-shrink:0;text-align:right;font-family:monospace;font-size:.82rem;color:#3b82f6;font-weight:600;">:${port}${name}</div>
      <div style="flex:1;background:var(--border);border-radius:99px;height:8px;overflow:hidden;">
        <div style="height:100%;border-radius:99px;background:linear-gradient(90deg,#3b82f6,#60a5fa);width:${pct}%;transition:width .6s ease;"></div>
      </div>
      <div style="width:48px;text-align:right;font-size:.78rem;color:#e2e8f0;">${cnt}</div>
    </div>`;
  }).join('');
}

function renderTopIPs(conns, limit = 8) {
  const ipCount = {};
  conns.forEach(c => {
    const src = (c['src-address'] || '').split(':')[0];
    if (src) ipCount[src] = (ipCount[src] || 0) + 1;
  });

  const sorted = Object.entries(ipCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const max = sorted[0]?.[1] || 1;
  const el = document.getElementById('top-ips-list');

  if (!sorted.length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:.82rem;">Tidak ada data koneksi</div>`;
    return;
  }

  el.innerHTML = sorted.map(([ip, cnt]) => {
    const pct = (cnt / max * 100).toFixed(0);
    return `<div style="display:flex;align-items:center;gap:12px;">
      <div style="width:140px;flex-shrink:0;font-family:monospace;font-size:.8rem;color:#22c55e;">${ip}</div>
      <div style="flex:1;background:var(--border);border-radius:99px;height:8px;overflow:hidden;">
        <div style="height:100%;border-radius:99px;background:linear-gradient(90deg,#22c55e,#4ade80);width:${pct}%;transition:width .6s ease;"></div>
      </div>
      <div style="width:48px;text-align:right;font-size:.78rem;color:#e2e8f0;">${cnt}</div>
    </div>`;
  }).join('');
}

function fmtBytes(b) {
  if (!b || isNaN(b)) return '—';
  b = parseInt(b);
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

function renderTable(conns) {
  if (!conns.length) {
    document.getElementById('conn-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px;">Tidak ada koneksi aktif.</td></tr>`;
    return;
  }

  const rows = conns.map(c => {
    const proto = (c.protocol || c['protocol'] || '—').toUpperCase();
    const src = c['src-address'] || '—';
    const dst = c['dst-address'] || '—';

    const [srcIp, srcPort] = src.includes(':') ? src.rsplit ? [src.substring(0, src.lastIndexOf(':')), src.substring(src.lastIndexOf(':')+1)] : src.split(':') : [src, '—'];
    const dstParts = dst.includes(':') ? (() => { const i = dst.lastIndexOf(':'); return [dst.substring(0, i), dst.substring(i+1)]; })() : [dst, '—'];
    const [dstIp, dstPort] = dstParts;

    const portName = PORT_NAMES[dstPort] ? `<span style="color:var(--muted);font-size:.68rem;margin-left:4px;">${PORT_NAMES[dstPort]}</span>` : '';
    const state   = c['tcp-state'] || c.state || '—';
    const stateCls = state.toLowerCase() === 'established' ? 'status-up' : 'status-warn';
    const bytes   = fmtBytes((parseInt(c['orig-bytes']||0) + parseInt(c['repl-bytes']||0)));

    return `<tr>
      <td><span style="font-family:monospace;font-size:.75rem;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);border-radius:4px;padding:1px 7px;color:#60a5fa;">${proto}</span></td>
      <td style="font-family:monospace;color:#e2e8f0;font-size:.78rem;">${srcIp || src}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.78rem;">${srcPort || '—'}</td>
      <td style="font-family:monospace;color:#e2e8f0;font-size:.78rem;">${dstIp}</td>
      <td style="font-family:monospace;font-size:.78rem;color:#a855f7;">${dstPort}${portName}</td>
      <td><span class="${stateCls}" style="font-size:.68rem;">${state}</span></td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.75rem;">${bytes}</td>
    </tr>`;
  }).join('');

  document.getElementById('conn-tbody').innerHTML = rows;
}

function filterConnections() {
  const q = document.getElementById('search-conn').value.toLowerCase();
  if (!q) {
    renderTable(allConns);
    document.getElementById('conn-count').textContent = `${allConns.length} koneksi`;
    return;
  }
  const filtered = allConns.filter(c =>
    JSON.stringify(c).toLowerCase().includes(q)
  );
  renderTable(filtered);
  document.getElementById('conn-count').textContent = `${filtered.length} koneksi`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 5000);
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
}
