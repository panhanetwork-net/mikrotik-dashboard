'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // Animasi entrance
  if (window.gsap) {
    gsap.to('#login-card', { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out', delay: 0.1 });
  } else {
    document.getElementById('login-card').style.opacity = '1';
    document.getElementById('login-card').style.transform = 'none';
  }

  // Handle form submit
  document.getElementById('login-form').addEventListener('submit', handleLogin);
});

async function handleLogin(e) {
  e.preventDefault();

  const username = document.getElementById('f-user').value.trim();
  const password = document.getElementById('f-pass').value;

  const errEl  = document.getElementById('login-error');
  const lbl    = document.getElementById('login-label');
  const spn    = document.getElementById('login-spinner');
  const btn    = document.getElementById('login-btn');

  errEl.style.display = 'none';
  errEl.textContent   = '';

  lbl.style.display = 'none';
  spn.style.display = 'inline';
  btn.disabled      = true;

  try {
    const res = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error((data && data.error) || 'Login gagal. Periksa kembali kredensial Anda.');
    }

    window.location.href = '/dashboard';

  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';

    if (window.gsap) {
      gsap.fromTo(errEl, { x: -8 }, { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.5)' });
    }
  } finally {
    lbl.style.display = 'inline';
    spn.style.display = 'none';
    btn.disabled      = false;
  }
}
