import './green.css';

type Appearance = 'light' | 'dark';

const storageKey = 'dgpt-green-appearance';
const buttons: HTMLButtonElement[] = [];
const moon = '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>';
const sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19"/>';
let appearance: Appearance = 'light';

try {
  if (localStorage.getItem(storageKey) === 'dark') appearance = 'dark';
} catch {
  // Storage may be unavailable in the webview.
}

function renderAppearance() {
  document.documentElement.dataset.appearance = appearance;
  const label = appearance === 'light' ? '다크 모드' : '라이트 모드';
  const icon = appearance === 'light' ? moon : sun;
  for (const button of buttons) {
    button.innerHTML = `<svg class="ui-icon" aria-hidden="true" viewBox="0 0 24 24">${icon}</svg><span>${label}</span>`;
    button.setAttribute('aria-label', `${label}로 전환`);
  }
}

function toggleAppearance() {
  appearance = appearance === 'light' ? 'dark' : 'light';
  renderAppearance();
  try {
    localStorage.setItem(storageKey, appearance);
  } catch {
    // The selected appearance still applies for this session.
  }
}

document.querySelectorAll('#setup .shell-brand, .chat-stage > header').forEach(header => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'appearance-toggle';
  button.addEventListener('click', toggleAppearance);
  header.append(button);
  buttons.push(button);
});
renderAppearance();
