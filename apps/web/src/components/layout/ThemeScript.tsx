/**
 * Inline script that runs before first paint to apply the saved theme.
 * Prevents flash of wrong theme on hydration.
 * This is a Server Component — it renders a <script> tag.
 */
export function ThemeScript({ nonce }: { nonce?: string | undefined }) {
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

  // Carries the request's nonce: the CSP blocks inline scripts without it (ADR-0017). Browsers
  // hide a nonce from the page after load (so injected code cannot read it), which React would
  // otherwise report as a hydration mismatch.
  return (
    <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: script }} />
  );
}
