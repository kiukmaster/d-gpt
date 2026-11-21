import type { SchoolModel } from './models';
import './picker.css';

const modelExamples: Record<string, string> = {
  'gpt-6-astra': '여러 논문의 근거를 비교하거나 복잡한 문제를 단계별로 풀 때 잘 맞아요.',
  'gpt-6-sol': '자료를 분석하고 그 결과를 보고서 초안으로 정리해 줘요.',
  'gpt-5.6-sol': '과제 코드에서 오류의 원인을 찾고 수정 방법을 설명해 줘요.',
  'gpt-6-luna': '수업 중 처음 듣는 개념을 짧은 예시로 빠르게 설명해 줘요.',
  'gpt-5.6-terra': '강의 노트에서 핵심을 뽑고 시험 대비 문제를 만들어 줘요.',
  'gpt-5.6-luna': '단어 뜻을 묻거나 짧은 예문을 만드는 간단한 질문에 잘 맞아요.',
  'claude-opus-5-5': '긴 글의 논리를 따라가며 서로 다른 주장과 근거를 꼼꼼히 비교해 줘요.',
  'claude-sonnet-5-5': '발표 초안의 흐름을 다듬고 슬라이드마다 어울리는 제목을 제안해 줘요.',
  'claude-haiku-5-5': '짧은 글을 빠르게 요약하거나 설문 답변을 주제별로 묶을 때 잘 맞아요.',
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function openModelPicker(models: readonly SchoolModel[], currentId: string | null, onSelect: (model: SchoolModel) => void, example = false): void {
  if (document.querySelector('dialog.model-picker[open]')) return;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = opener?.closest<HTMLElement>('[data-picker-host], .maincol');
  const bar = opener?.closest<HTMLElement>('[data-picker-bar], .titlebar, .preview-bar');
  const dialog = element('dialog', 'model-picker');
  dialog.setAttribute('aria-labelledby', 'model-picker-title');
  const header = element('header', 'pk-head');
  const title = element('h2', 'pk-title', '모델 선택');
  title.id = 'model-picker-title';
  const hint = element('span', 'pk-hint', example ? '예시 데이터' : '숫자 키로 바로 고를 수 있어요');
  const close = element('button', 'ghost pk-close', '닫기');
  close.type = 'button';
  close.append(element('kbd', 'kc sm', 'Esc'));
  header.append(title, hint, close);
  const providers = ['OpenAI', 'Claude'] as const;
  let provider = models.find(model => model.id === currentId)?.provider ?? models[0]?.provider ?? 'OpenAI';
  const tabList = element('div', 'pk-tabs');
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', '모델 제공사');
  const stack = element('div', 'stack');
  stack.id = 'model-picker-panel';
  stack.setAttribute('role', 'tabpanel');
  const tabs = providers.map(value => {
    const tab = element('button', 'pk-tab', value === 'OpenAI' ? 'GPT' : 'Claude');
    tab.type = 'button';
    tab.id = 'model-picker-tab-' + value;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', stack.id);
    tab.onclick = () => {
      if (provider === value) return;
      provider = value;
      renderPanel();
      tab.focus({ preventScroll: true });
    };
    tabList.append(tab);
    return tab;
  });
  const toolbar = element('div', 'pk-toolbar');
  const orderLabel = element('span', 'pk-order');
  toolbar.append(tabList, orderLabel);
  dialog.append(header, toolbar, stack);
  let slabs: HTMLButtonElement[] = [];
  function dismiss() {
    if (dialog.open) dialog.close();
  }

  function createSlab(model: SchoolModel, index: number) {
    const current = model.id === currentId;
    const slab = element('button', 'slab' + (models.indexOf(model) % 2 ? ' c1' : '') + (current ? ' on' : ''));
    slab.type = 'button';
    slab.setAttribute('aria-pressed', String(current));
    const key = element('kbd', 'kc', String(index + 1));
    key.hidden = index >= 9;
    const main = element('span', 's-main');
    const image = '이미지 ' + model.image + (model.imageSource === 'provider' ? ' (제조사 기준)' : '');
    const access = model.access === 'unconfirmed' ? ' / 키 권한 확인 전' : '';
    main.append(element('span', 's-name', model.id));
    if (modelExamples[model.id]) main.append(element('span', 's-example', modelExamples[model.id]));
    main.append(element('span', 's-desc', image + ' / 동영상 미지원 / 기타 파일 미지원' + access));
    const state = element('span', 's-state');
    const pill = element('span', 'pill', '사용 중');
    pill.hidden = !current;
    const go = element('span', 's-go', current ? '그대로 사용' : '선택');
    const arrow = element('span', '', '→');
    arrow.setAttribute('aria-hidden', 'true');
    go.append(arrow);
    state.append(pill, go);
    slab.append(key, main, state);
    function setOrigin(event: PointerEvent) {
      const bounds = slab.getBoundingClientRect();
      slab.style.setProperty('--mx', (event.clientX - bounds.left) + 'px');
      slab.style.setProperty('--my', (event.clientY - bounds.top) + 'px');
    }
    slab.onpointerenter = slab.onpointerleave = setOrigin;
    slab.onclick = () => {
      if (!current) {
        onSelect(model);
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) opener?.animate([
          { transform: 'scale(.9)' }, { transform: 'scale(1.08)', offset: .55 }, { transform: 'scale(1)' }
        ], { duration: 400, easing: 'cubic-bezier(.2,.9,.3,1.3)' });
      }
      dismiss();
    };
    return slab;
  }
  function renderPanel() {
    const visible = models.filter(model => model.provider === provider);
    const activeTab = tabs[providers.indexOf(provider)];
    for (const tab of tabs) {
      tab.tabIndex = tab === activeTab ? 0 : -1;
      tab.setAttribute('aria-selected', String(tab === activeTab));
    }
    stack.setAttribute('aria-labelledby', activeTab.id);
    orderLabel.textContent = provider === 'OpenAI' ? 'Agents’ Last Exam 점수순' : 'GDPval-AA v2.1 점수순';
    orderLabel.title = '제조사가 공개한 실무 과제 점수가 높은 모델부터 표시합니다.';
    stack.className = 'stack rows d2';
    slabs = visible.map(createSlab);
    stack.replaceChildren(...slabs);
    if (!slabs.length) {
      stack.append(element('p', 'mp-empty', '이 키로 사용할 수 있는 ' + activeTab.textContent + ' 모델이 없습니다.'));
    }
  }
  renderPanel();
  close.onclick = dismiss;
  dialog.oncancel = event => { event.preventDefault(); dismiss(); };
  dialog.onclick = event => { if (event.target === dialog) dismiss(); };
  dialog.onkeydown = event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (/^[1-9]$/.test(event.key)) {
      const slab = slabs[Number(event.key) - 1];
      if (slab) { event.preventDefault(); slab.click(); }
      return;
    }
    const focused = document.activeElement as HTMLButtonElement;
    const tabIndex = tabs.indexOf(focused);
    if (tabIndex >= 0 && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : 1 - tabIndex;
      tabs[target].click();
      tabs[target].focus();
      return;
    }
    if (tabIndex >= 0 && event.key === 'ArrowDown' && slabs.length) {
      event.preventDefault();
      (slabs.find(slab => slab.classList.contains('on')) ?? slabs[0]).focus();
      return;
    }
    const index = slabs.indexOf(focused);
    if (index < 0) return;
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (direction) {
      event.preventDefault();
      slabs[(index + direction + slabs.length) % slabs.length].focus();
    }
  };

  function position() {
    const bounds = host?.getBoundingClientRect();
    dialog.style.left = (bounds?.left ?? 0) + 'px';
    dialog.style.right = (bounds ? Math.max(0, window.innerWidth - bounds.right) : 0) + 'px';
    dialog.style.top = (bar?.getBoundingClientRect().bottom ?? bounds?.top ?? 0) + 'px';
    dialog.style.bottom = (bounds ? Math.max(0, window.innerHeight - bounds.bottom) : 0) + 'px';
  }
  const resize = new ResizeObserver(position);
  if (host) resize.observe(host);
  if (bar) resize.observe(bar);
  window.addEventListener('resize', position);
  dialog.onclose = () => {
    resize.disconnect();
    window.removeEventListener('resize', position);
    dialog.remove();
    opener?.setAttribute('aria-expanded', 'false');
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  document.body.append(dialog);
  position();
  dialog.showModal();
  opener?.setAttribute('aria-expanded', 'true');
  (slabs.find(slab => slab.classList.contains('on')) ?? tabs[providers.indexOf(provider)]).focus({ preventScroll: true });
  void stack.offsetWidth;
  dialog.classList.add('picking');
}
