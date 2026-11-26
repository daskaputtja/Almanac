const form = document.getElementById('form');
const input = document.getElementById('address');
const button = document.getElementById('go');
const error = document.getElementById('error');
const current = new URLSearchParams(location.search).get('current');
if (current) input.value = current;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = 'Checking…';
  error.textContent = '';
  const result = await window.almanacDesktop.connect(input.value);
  if (!result.ok) {
    error.textContent = result.error;
    button.disabled = false;
    button.textContent = 'Connect';
  }
});
