// mic-hint.js (Audio bot): shows #micHint only while mic permission is not 'granted'. Text only, no layout changes.
// 'granted' -> hidden. 'prompt' / 'denied' / 'unknown' (Safari may not support the query) -> shown.
import { getMicPermission } from './audio.js';

const el = document.getElementById('micHint');
async function refresh() {
  if (!el) return;
  el.hidden = (await getMicPermission()) === 'granted';
}
if (el) {
  refresh();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); }); // re-check after returning from Settings
  document.addEventListener('click', () => setTimeout(refresh, 1500), true);                  // after the user answers a prompt
  try { navigator.permissions.query({ name: 'microphone' }).then((s) => s.addEventListener('change', refresh)).catch(() => {}); } catch (e) { /* unsupported */ }
}
