// The light/dark theme shared by all three screens (login, home and editor).
// The editor already kept the preference under this key; this module exists so
// the home and the login screen read and write exactly the same thing.
const KEY = 'flow-theme';

export function storedTheme() {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'dark';
  } catch (err) {
    return 'dark';
  }
}

export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(KEY, t);
  } catch (err) {
    /* localStorage blocked: the theme applies to this tab only */
  }
  return t;
}
