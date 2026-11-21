import { normalizeModels, supportedModelIds } from './models';
import { openModelPicker } from './picker';
import './fonts.css';
import './green.css';

const examples = normalizeModels({ data: supportedModelIds.map(id => ({ id })) });
let current = examples[0];
const open = document.querySelector<HTMLButtonElement>('#open')!;
const label = document.querySelector<HTMLElement>('#chosen')!;
const glyph = document.querySelector<HTMLElement>('.preview-swatch')!;

function renderSelection() {
  label.textContent = current.id;
  glyph.style.backgroundColor = examples.indexOf(current) % 2 ? 'var(--model-alt)' : 'var(--fill)';
}

function show() {
  open.focus({ preventScroll: true });
  openModelPicker(examples, current.id, choice => {
    current = choice;
    renderSelection();
  }, true);
}

open.addEventListener('click', show);
renderSelection();
show();
