// --- App color theme (dark / light / system) ---
// Loaded in <head> before the stylesheets so the right theme is in place on
// first paint. The preference lives in the global settings (appTheme); a
// copy in localStorage lets this run synchronously at startup.

(() => {
  const STORAGE_KEY = 'appTheme';
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');
  let preference = 'dark';
  try { preference = localStorage.getItem(STORAGE_KEY) || 'dark'; } catch {}

  function resolve(pref) {
    if (pref === 'system') return systemLight.matches ? 'light' : 'dark';
    return pref === 'light' ? 'light' : 'dark';
  }

  function apply() {
    const theme = resolve(preference);
    const root = document.documentElement;
    if (root.dataset.theme === theme) return;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.dispatchEvent(new CustomEvent('app-theme-change', { detail: { theme } }));
  }

  window.getAppTheme = () => resolve(preference);
  window.getAppThemePreference = () => preference;
  window.setAppThemePreference = (pref) => {
    preference = pref || 'dark';
    try { localStorage.setItem(STORAGE_KEY, preference); } catch {}
    apply();
  };

  systemLight.addEventListener('change', () => { if (preference === 'system') apply(); });
  apply();
})();
