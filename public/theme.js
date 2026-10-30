(function () {
  const KEY = 'vra_theme';
  const html = document.documentElement;

  function getStored() { try { return localStorage.getItem(KEY) || 'light'; } catch (_) { return 'light'; } }

  function apply(theme) {
    html.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = theme === 'dark' ? '🌙' : '☀️';
    }
  }

  function toggle() {
    const current = getStored();
    const next = current === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (_) {}
    apply(next);
  }

  function init() {
    apply(getStored());
    document.addEventListener('click', (e) => {
      if (e.target.id === 'theme-toggle' || e.target.closest('#theme-toggle')) toggle();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
