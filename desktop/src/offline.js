const params = new URLSearchParams(location.search);
const server = params.get('server');
const reason = params.get('reason');
if (server) document.getElementById('detail').textContent = `Couldn’t open ${server}${reason ? ` (${reason})` : ''}. Check your internet connection, or whether the server is up.`;
document.getElementById('retry').addEventListener('click', () => window.almanacDesktop.retry());
document.getElementById('change').addEventListener('click', () => window.almanacDesktop.change());
// Try again by itself every 30 seconds.
setTimeout(() => window.almanacDesktop.retry(), 30_000);
