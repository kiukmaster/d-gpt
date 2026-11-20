import type { SchoolModel } from './models';
import './picker.css';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, label = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = label;
  return node;
}

function button(className: string, label: string) {
  const node = element('button', className, label);
  node.type = 'button';
  return node;
}

function imageLabel(model: SchoolModel) {
  return '이미지 ' + model.image;
}

export function openModelPicker(models: readonly SchoolModel[], currentId: string | null, onSelect: (model: SchoolModel) => void, example = false): void {
  if (document.querySelector('dialog.model-picker[open]')) return;
  const opener = document.activeElement;
  const dialog = element('dialog', 'model-picker');
  const header = element('header', 'mp-header');
  const title = element('h2', 'mp-title', '모델 선택');
  title.id = 'mp-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const close = button('mp-close', '×');
  close.setAttribute('aria-label', '모델 선택 닫기');
  close.onclick = () => dialog.close();
  header.append(title);
  if (example) header.append(element('span', 'mp-example', '예시 데이터'));
  header.append(close);

  const content = element('div', 'mp-content');
  const stage = element('div', 'mp-stage');
  const face = element('div', 'mp-face');
  const ticks = element('div', 'mp-ticks');
  const majors = element('div', 'mp-majors');
  const rotor = element('div', 'mp-rotor');
  const zone = button('mp-zone', '');
  zone.tabIndex = -1;
  const disc = element('div', 'mp-disc');
  const name = element('strong', 'mp-name');
  const state = element('span', 'mp-state');
  disc.append(name, state);
  for (const decoration of [rotor, ticks, majors, disc]) decoration.setAttribute('aria-hidden', 'true');
  face.append(zone, ticks, majors, rotor, disc);
  const labels = element('div', 'mp-labels');
  stage.append(face, labels);

  const footer = element('footer', 'mp-footer');
  const modelId = element('div', 'mp-full-name');
  const capabilities = element('div', 'mp-capabilities');
  const image = element('span', 'mp-image');
  capabilities.append(image, element('span', '', '동영상 미지원'), element('span', '', '기타 파일 미지원'));
  const paging = element('div', 'mp-paging');
  const previous = button('mp-page-button', '‹');
  const next = button('mp-page-button', '›');
  previous.setAttribute('aria-label', '이전 모델 페이지');
  next.setAttribute('aria-label', '다음 모델 페이지');
  const counter = element('span', 'mp-counter');
  paging.append(previous, counter, next);
  const hints = element('p', 'mp-hints');
  for (const [keys, label] of [['← →', '이동'], ['Enter', '선택'], ['Esc', '닫기']]) {
    const hint = element('span', '');
    hint.append(element('kbd', '', keys), label);
    hints.append(hint);
  }
  footer.append(modelId, capabilities, paging, hints);
  const empty = element('p', 'mp-empty');
  content.append(stage, empty);
  const search = element('input', 'mp-search');
  search.type = 'search';
  search.placeholder = '모델 검색';
  search.setAttribute('aria-label', '이름 또는 제공사로 모델 검색');
  const pageSize = 5;
  if (models.length > pageSize * 2) header.insertBefore(search, close);
  dialog.append(header, content, footer);
  document.body.append(dialog);

  let matches = models;
  let cursor = Math.max(0, models.findIndex(model => model.id === currentId));
  let shown = -1;
  let page = -1;
  let count = 0;
  let angle = 0;
  let committed = false;
  let stops: HTMLButtonElement[] = [];

  function point(index: number) {
    const model = matches[index];
    if (!model || shown === index) return;
    shown = index;
    const slot = index - page * pageSize;
    const degrees = slot * 360 / count;
    angle += ((degrees - angle) % 360 + 540) % 360 - 180;
    rotor.style.transform = 'rotate(' + angle + 'deg)';
    name.textContent = model.id;
    state.textContent = model.id === currentId ? '지금 사용 중' : '클릭하여 선택';
    state.dataset.current = String(model.id === currentId);
    modelId.textContent = model.provider + ' / ' + model.id;
    image.textContent = imageLabel(model);
    image.dataset.support = model.image;
    zone.setAttribute('aria-label', model.id + ' 선택');
    stops.forEach((stop, i) => {
      stop.classList.toggle('mp-pointed', slot === i);
      stop.tabIndex = i === cursor - page * pageSize ? 0 : -1;
    });
  }

  function commit(index: number) {
    const model = matches[index];
    if (committed || !model) return;
    committed = true;
    point(index);
    state.textContent = '선택했습니다';
    state.dataset.current = 'true';
    // Apply immediately. The short pulse only controls the visual dismissal.
    if (model.id !== currentId) onSelect(model);
    if (!dialog.open) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || document.hidden) {
      dialog.close();
      return;
    }
    const pulse = disc.animate([
      { boxShadow: '0 0 0 0 rgba(199,180,255,.72)', scale: '.97' },
      { boxShadow: '0 0 0 18px rgba(199,180,255,0)', scale: '1' }
    ], { duration: 205, easing: 'ease-out' });
    pulse.onfinish = pulse.oncancel = () => { if (dialog.open) dialog.close(); };
  }

  function renderPage() {
    page = Math.floor(cursor / pageSize);
    const start = page * pageSize;
    const visible = matches.slice(start, start + pageSize);
    count = visible.length;
    stage.dataset.count = String(count);
    shown = -1;
    labels.replaceChildren();
    majors.replaceChildren();
    stops = visible.map((model, slot) => {
      const index = start + slot;
      const degrees = slot * 360 / count;
      const radians = degrees * Math.PI / 180;
      const x = Math.sin(radians), y = -Math.cos(radians);
      const major = element('i', 'mp-major');
      major.style.transform = 'rotate(' + degrees + 'deg)';
      majors.append(major);
      const stop = button('mp-stop', '');
      stop.style.setProperty('--x', String(x));
      stop.style.setProperty('--y', String(y));
      stop.style.setProperty('--order', String(slot));
      stop.dataset.align = Math.abs(x) < .3 ? 'center' : x > 0 ? 'left' : 'right';
      stop.dataset.vertical = Math.abs(x) >= .3 ? 'middle' : y < 0 ? 'above' : 'below';
      const line = element('span', 'mp-stop-line');
      line.append(element('strong', 'mp-stop-name', model.id));
      const current = model.id === currentId;
      if (current) line.append(element('span', 'mp-current', '사용 중'));
      stop.append(line, element('span', 'mp-stop-meta', model.provider + ' / ' + imageLabel(model)));
      const description = model.provider + ' ' + model.id + ', ' + imageLabel(model) + ', 동영상 미지원, 기타 파일 미지원';
      stop.title = description;
      stop.setAttribute('aria-label', description);
      stop.setAttribute('aria-pressed', String(current));
      stop.onpointerenter = event => { if (!committed && event.pointerType === 'mouse') point(index); };
      stop.onpointerleave = () => { if (!committed) point(cursor); };
      stop.onfocus = () => { if (!committed) { cursor = index; shown = -1; point(index); } };
      stop.onclick = () => commit(index);
      labels.append(stop);
      return stop;
    });
    const pages = Math.ceil(matches.length / pageSize);
    previous.disabled = page === 0;
    next.disabled = page + 1 >= pages;
    counter.textContent = (page + 1) + ' / ' + pages;
    paging.hidden = pages <= 1;
    stage.hidden = footer.hidden = !count;
    empty.hidden = !!count;
    empty.textContent = models.length ? '검색 결과가 없습니다.' : '선택할 수 있는 모델이 없습니다.';
    point(cursor);
  }

  function move(index: number) {
    if (!matches.length || committed) return;
    cursor = (index + matches.length) % matches.length;
    if (page !== Math.floor(cursor / pageSize)) renderPage();
    stops[cursor % pageSize].focus({ preventScroll: true });
  }

  previous.onclick = () => move((page - 1) * pageSize);
  next.onclick = () => move((page + 1) * pageSize);
  search.oninput = () => {
    if (committed) return;
    const query = search.value.trim().toLowerCase();
    matches = query ? models.filter(model => (model.provider + ' ' + model.id).toLowerCase().includes(query)) : models;
    cursor = Math.max(0, matches.findIndex(model => model.id === currentId));
    renderPage();
  };
  search.onkeydown = event => {
    if (!event.isComposing && (event.key === 'ArrowDown' || event.key === 'Enter') && count) {
      event.preventDefault();
      move(cursor);
    }
  };
  stage.onkeydown = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const targets: Record<string, number> = {
      ArrowRight: cursor + 1, ArrowDown: cursor + 1, ArrowLeft: cursor - 1,
      ArrowUp: cursor - 1, Home: 0, End: matches.length - 1
    };
    if (event.key in targets) {
      event.preventDefault();
      move(targets[event.key]);
    }
  };

  function hit(event: MouseEvent) {
    const bounds = face.getBoundingClientRect();
    const dx = event.clientX - bounds.left - bounds.width / 2;
    const dy = event.clientY - bounds.top - bounds.height / 2;
    if (Math.hypot(dx, dy) < disc.offsetWidth / 2) return cursor;
    const turn = Math.atan2(dx, -dy) / (2 * Math.PI);
    return page * pageSize + (Math.round(turn * count) + count) % count;
  }
  zone.onpointermove = event => { if (!committed && event.pointerType === 'mouse') point(hit(event)); };
  zone.onpointerdown = event => { if (!committed && event.pointerType !== 'mouse') point(hit(event)); };
  zone.onpointerleave = event => { if (!committed && event.pointerType === 'mouse') point(cursor); };
  zone.onclick = () => commit(shown);
  let wheelDistance = 0;
  let lastWheelStep = 0;
  zone.addEventListener('wheel', event => {
    if (event.ctrlKey || committed || matches.length < 2) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheelStep < 140) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? face.clientHeight : 1;
    wheelDistance += event.deltaY * unit;
    if (Math.abs(wheelDistance) < 50) return;
    move(shown + Math.sign(wheelDistance));
    lastWheelStep = now;
    wheelDistance = 0;
  }, { passive: false });
  dialog.onclick = event => {
    if (event.target === dialog || event.target === content || event.target === stage) dialog.close();
  };
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener instanceof HTMLElement && opener.isConnected) {
      if (opener instanceof HTMLButtonElement) opener.setAttribute('aria-expanded', 'false');
      opener.focus({ preventScroll: true });
    }
  }, { once: true });
  renderPage();
  dialog.showModal();
  if (opener instanceof HTMLButtonElement) {
    opener.setAttribute('aria-expanded', 'true');
    const start = opener.getBoundingClientRect();
    const end = face.getBoundingClientRect();
    stage.style.setProperty('--fly-x', (start.left + start.width / 2 - end.left - end.width / 2) + 'px');
    stage.style.setProperty('--fly-y', (start.top + start.height / 2 - end.top - end.height / 2) + 'px');
  }
  stage.classList.add('mp-enter');
  (stops[cursor % pageSize] ?? close).focus({ preventScroll: true });
}
