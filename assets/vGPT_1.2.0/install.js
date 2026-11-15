(() => {
  const button = document.getElementById('install');
  let pending;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    pending = event;
    button.hidden = false;
  });
  button.addEventListener('click', async () => {
    const event = pending;
    pending = null;
    button.hidden = true;
    if (event) await event.prompt().catch(() => {});
  });
  window.addEventListener('appinstalled', () => {
    pending = null;
    button.hidden = true;
  });
})();
