const fs = require('fs');
const css = `
/* ─── NOC ZOOM ENHANCEMENTS (67% Legibility) ─── */

/* Increase Main Traffic RX/TX sizes */
#rx-current, #tx-current {
  font-size: 3.8rem !important;
  font-weight: 800 !important;
  color: #ffffff !important;
  line-height: 1 !important;
}

/* Custom Graphs values (IN/OUT) */
span[id^='val-cg-'][id$='-rx'], span[id^='val-cg-'][id$='-tx'] {
  font-size: 2.2rem !important;
  font-weight: 800 !important;
  color: #ffffff !important;
  line-height: 1 !important;
}

/* DNS Values */
#val-dns-total, #val-dns-blocked {
  font-size: 2.2rem !important;
  font-weight: 800 !important;
  color: #ffffff !important;
  line-height: 1 !important;
}

/* Other metrics like PPPoE total, Ping RTO, Connections */
#pppoe-total, #pppoe-online, #conn-total, #conn-established, #conn-src-ips, #conn-dst-ports, #ping-stat-status, #ping-stat-consecutive, #ping-stat-total-rto, #ping-stat-total-ok {
  font-size: 2.6rem !important;
  font-weight: 800 !important;
  color: #ffffff !important;
}

/* Enhancing Titles with Glow and Spacing */
p[style*='text-transform:uppercase'], p[style*='text-transform: uppercase'] {
  letter-spacing: 1.5px !important;
  font-weight: 800 !important;
  color: #00e5ff !important;
  text-shadow: 0 0 5px rgba(0, 229, 255, 0.4) !important;
}

/* The sub text units */
#rx-unit, #tx-unit {
  font-size: 1.2rem !important;
  font-weight: 600 !important;
  color: #94a3b8 !important;
}

/* Increase chart label font sizes slightly for legibility */
.dash-card p {
   font-size: 0.8rem !important;
}
`;
fs.appendFileSync('public/css/style.css', css);
console.log('Appended to style.css');
