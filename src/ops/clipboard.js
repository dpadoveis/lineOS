// Copying text to the clipboard on a plain-HTTP origin. navigator.clipboard
// exists only in secure contexts (HTTPS or localhost), and the ops stack is
// served over http://<tailnet-ip>, so the async API is simply absent there.
// The fallback is the classic hidden textarea + execCommand('copy'), which
// still works while the click that started the action counts as recent.
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      /* fall through to the textarea */
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (_) {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}
