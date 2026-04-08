'use strict';

let allLeases = [];

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const me = await fetch('/api/me').then(r => r.json());
    if (!me.ok) { window.location.href = '/'; return; }
  } catch (_) {
    window.location.href = '/';
    return;
  }
  if (window.gsap) gsap.to('.fade-up', { opacity: 1, y: 0, duration: .5, ease: 'power3.out', stagger: .06 });
  await loadLeases();
});

async function loadLeases() {
  document.getElementById('dhcp-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:40px;"><span class="spinner"></span> Memuat data DHCP…</td></tr>`;
  try {
    const data = await fetch('/api/mikrotik/dhcp-leases').then(r => r.json());
    if (data.error) throw new Error(data.error);
    allLeases = data;
    updateStats(data);
    renderTable(data);
  } catch (err) {
    showToast('Error: ' + err.message);
    document.getElementById('dhcp-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:#f87171;padding:32px;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

function updateStats(leases) {
  const active  = leases.filter(l => l.status === 'bound' || l.dynamic === 'true' || l.dynamic === true);
  const waiting = leases.filter(l => l.status === 'waiting' || l.status === 'offered');
  const expired = leases.filter(l => l.status === 'expired');

  document.getElementById('dhcp-total').textContent   = leases.length;
  document.getElementById('dhcp-active').textContent  = active.length;
  document.getElementById('dhcp-waiting').textContent = waiting.length;
  document.getElementById('dhcp-expired').textContent = expired.length;
}

function renderTable(leases) {
  if (!leases.length) {
    document.getElementById('dhcp-tbody').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px;">Tidak ada data lease.</td></tr>`;
    return;
  }

  const rows = leases.map(l => {
    const ip       = l['address'] || l['ip-address'] || '—';
    const mac      = l['mac-address'] || '—';
    const hostname = l['host-name'] || l['hostname'] || l['active-host-name'] || '<span style="color:var(--muted)">—</span>';
    const server   = l['server'] || l['dhcp-server'] || '—';
    const status   = l['status'] || (l.dynamic === 'true' ? 'bound' : 'static');
    const expires  = l['expires-after'] || l['lease-time'] || '—';

    const statusBadge = status === 'bound'
      ? `<span class="status-up"><span style="width:5px;height:5px;background:#22c55e;border-radius:50%;display:inline-block;"></span>${status}</span>`
      : status === 'waiting' || status === 'offered'
        ? `<span class="status-warn">${status}</span>`
        : `<span style="color:var(--muted);font-size:.75rem;">${status}</span>`;

    return `<tr>
      <td style="font-family:monospace;color:#3b82f6;font-weight:600;">${ip}</td>
      <td style="font-family:monospace;color:#94a3b8;font-size:.78rem;">${mac}</td>
      <td style="color:#e2e8f0;">${hostname}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.78rem;">${server}</td>
      <td>${statusBadge}</td>
      <td style="font-family:monospace;color:var(--muted);font-size:.78rem;">${expires}</td>
    </tr>`;
  }).join('');

  document.getElementById('dhcp-tbody').innerHTML = rows;
}

function filterLeases() {
  const q = document.getElementById('search-leases').value.toLowerCase();
  if (!q) { renderTable(allLeases); return; }
  const filtered = allLeases.filter(l =>
    (l['address'] || '').toLowerCase().includes(q) ||
    (l['mac-address'] || '').toLowerCase().includes(q) ||
    (l['host-name'] || l['hostname'] || l['active-host-name'] || '').toLowerCase().includes(q) ||
    (l['server'] || '').toLowerCase().includes(q)
  );
  renderTable(filtered);
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
