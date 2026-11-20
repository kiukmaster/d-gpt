import { normalizeModels } from './models';
import { openModelPicker } from './picker';

const examples = normalizeModels({ data: [
  { id: 'gpt-4o', input_modalities: ['text', 'image'] },
  { id: 'claude-sonnet-example' },
  { id: 'gpt-text-example', input_modalities: ['text'] }
] });
let current = examples[0];
const open = document.querySelector<HTMLButtonElement>('#open')!;
const label = document.querySelector<HTMLElement>('#chosen')!;
const glyph = document.querySelector<HTMLElement>('.preview-gauge')!;

function renderSelection() {
  label.textContent = current.id;
  glyph.style.transform = 'rotate(' + examples.indexOf(current) * 360 / examples.length + 'deg)';
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
