/**
 * Inline script that runs before first paint to apply the saved theme.
 * Prevents flash of wrong theme on hydration.
 * This is a Server Component — it renders a <script> tag.
 */
export function ThemeScript() {
  const script = `
(function() {
  try {
    var saved = localStorage.getItem('chronos-theme');
    var preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var theme = saved || preferred;
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {}
})();
`.trim();

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
