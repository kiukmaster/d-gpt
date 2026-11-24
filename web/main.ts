import { Channel, invoke } from '@tauri-apps/api/core';
import { normalizeModels, resolveModel, type SchoolModel } from './models';
import { openModelPicker } from './picker';
import { renderMarkdown } from './markdown';
import { planContext, type ContextPlan } from './context';
import { deleteThread, listThreads, readThread, writeThread, type Thread, type Turn, type Usage } from './history';
import './fonts.css';
import './shell.css';
import './green-theme';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const message = element<HTMLTextAreaElement>('message');
const file = element<HTMLInputElement>('file');
const key = element<HTMLInputElement>('key');
const turns = element('turns');
const status = element('status');
const keyStatus = element('keyStatus');
const limit = 10 * 1024 * 1024;
type StreamText = { type: 'text'; text: string };
type ChatResult = { usage?: Usage; interruption?: string; summary?: string };
let models: SchoolModel[] = [];
let selected: SchoolModel | null = null;
let thread: Thread | null = null;
let attachment: Turn['image'];
let previewUrl: string | undefined;
let busy = false;
let requestId: string | null = null;
let connected = false;
let canCancel = false;
let stopRequested = false;

function feedback(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function explainSchoolError(error: unknown) {
  if (!error || typeof error !== 'object' || !('kind' in error) || error.kind !== 'school_api' ||
      !('reason' in error) || typeof error.reason !== 'string' || !('action' in error) || typeof error.action !== 'string' ||
      !('status' in error) || typeof error.status !== 'number') return feedback(error);
  const dialog = element<HTMLDialogElement>('schoolError');
  element('schoolErrorReason').textContent = error.reason;
  element('schoolErrorAction').textContent = error.action;
  const context = error.status >= 400 ? '오류 ' + error.status : '응답 도중 발생';
  element('schoolErrorCode').textContent = 'code' in error && typeof error.code === 'string' ? context + ' / ' + error.code : context;
  if (!dialog.open) dialog.showModal();
  return error.reason;
}
element<HTMLDialogElement>('schoolError').onclose = () => {
  (element('setup').hidden ? message : key).focus({ preventScroll: true });
};
function preference() {
  try { return localStorage.getItem('preferredModel'); } catch { return null; }
}
function updateSend() {
  element<HTMLButtonElement>('send').disabled = busy || !selected || !(message.value.trim() || attachment) || Boolean(attachment && selected.image !== '지원');
}
function updateConnect() {
  element<HTMLButtonElement>('connect').disabled = busy || !key.value.trim();
}
function update() {
  const model = element<HTMLButtonElement>('model');
  element('modelName').textContent = selected?.id ?? '사용 가능한 모델이 없습니다';
  const modelIndex = selected ? models.indexOf(selected) : -1;
  element('modelSwatch').style.setProperty('--model-color', modelIndex > 0 && modelIndex % 2 ? 'var(--model-alt, #2c63e6)' : 'var(--fill)');
  model.setAttribute('aria-label', selected ? '모델 바꾸기, 현재 모델 ' + selected.id : '사용 가능한 모델이 없습니다');
  model.disabled = busy || !models.length;
  const imageSupported = selected?.image === '지원';
  element<HTMLButtonElement>('attach').disabled = busy || !selected;
  element('attach').title = imageSupported ? '이미지 선택, 붙여넣기 또는 끌어다 놓기' : imageSupportHint();
  element<HTMLButtonElement>('removeImage').disabled = busy;
  element('removeImage').hidden = !attachment;
  if (!attachment) {
    element('attachmentPreview').removeAttribute('src');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
  }
  updateSend();
  element('send').hidden = Boolean(requestId);
  element('stop').hidden = !requestId;
  element<HTMLButtonElement>('stop').disabled = !canCancel;
  for (const id of ['manage','newChat','back','removeKey','retry','paste']) element<HTMLButtonElement>(id).disabled = busy;
  updateConnect();
  element('history').querySelectorAll('button').forEach(button => button.disabled = busy);
}
function showSetup(hasKey: boolean) {
  element('setup').hidden = false;
  element('workspace').hidden = true;
  element('keyForm').hidden = false;
  element('keyDone').hidden = true;
  element('keyHeading').textContent = hasKey ? 'API 키를 관리해 주세요' : 'API 키 하나면 시작할 수 있어요';
  element('connect').firstElementChild!.textContent = hasKey ? '새 키로 연결하기' : '연결하기';
  element<HTMLDetailsElement>('guide').open = false;
  element('back').hidden = !connected;
  element('removeKey').hidden = !hasKey;
  element('retry').hidden = !hasKey || connected;
  element('keyCreditNote').hidden = !hasKey;
  key.removeAttribute('aria-invalid');
  key.value = '';
  updateConnect();
  key.type = 'password';
  element('eye').setAttribute('aria-pressed','false');
  element('eye').setAttribute('aria-label','키 보기');
  element('eye').title = '키 보기';
  key.focus();
}
function showWorkspace() {
  element('setup').hidden = true;
  element('workspace').hidden = false;
  key.value = '';
  updateConversationLayout();
  update();
}
async function loadModels(raw: {data:unknown[]}) {
  models = normalizeModels(raw);
  selected = resolveModel(models, preference());
  connected = true;
  await refreshHistory();
}
async function attemptLoad(replacement?: string) {
  busy = true;
  element('connect').setAttribute('aria-busy', String(Boolean(replacement)));
  update();
  keyStatus.textContent = '연결을 확인하고 있습니다.';
  let registered = false;
  try {
    const raw = replacement
      ? await invoke<{data:unknown[]}>('connect_key', {key:replacement})
      : await invoke<{data:unknown[]}>('list_models');
    if (replacement) {
      registered = true;
      connected = false;
      key.value = '';
    }
    await loadModels(raw);
    keyStatus.textContent = '';
    if (replacement) {
      element('keyForm').hidden = true;
      element('keyDone').hidden = false;
      element('start').focus();
    } else { showWorkspace(); }
  } catch (error) {
    const detail = explainSchoolError(error);
    const missing = detail === '등록된 API 키가 없습니다.';
    showSetup(registered || connected || (!replacement && !missing) || !element('removeKey').hidden);
    if (replacement && !registered) {
      key.value = replacement;
      if (detail.includes('키') && !detail.includes('연결')) key.setAttribute('aria-invalid', 'true');
    }
    keyStatus.textContent = missing ? '' : detail;
  } finally { element('connect').removeAttribute('aria-busy'); busy = false; update(); }
}
element('start').onclick = () => {
  showWorkspace();
  if (models.length) {
    const model = element<HTMLButtonElement>('model');
    model.focus({preventScroll:true});
    model.click();
  }
  else message.focus();
};
element('replace').onclick = () => showSetup(true);
key.oninput = () => { key.removeAttribute('aria-invalid'); updateConnect(); };
element('eye').onclick = () => {
  key.type = key.type === 'password' ? 'text' : 'password';
  const visible = key.type === 'text';
  const label = visible ? '키 숨기기' : '키 보기';
  element('eye').setAttribute('aria-pressed', String(visible));
  element('eye').setAttribute('aria-label', label);
  element('eye').title = label;
};
element('paste').onclick = async () => {
  try {
    const pasted = await navigator.clipboard.readText();
    if (!busy && !element('keyForm').hidden && !element('setup').hidden) {
      key.value = pasted.trim();
      key.removeAttribute('aria-invalid');
      keyStatus.textContent = key.value ? '' : '복사한 API 키가 없습니다.';
      updateConnect();
    }
  } catch { keyStatus.textContent = '키 입력란에서 붙여넣기 단축키를 눌러 주세요.'; }
  key.focus();
};
element('keyForm').onsubmit = event => {
  event.preventDefault();
  if (!busy && key.value.trim()) void attemptLoad(key.value.trim());
};
element('retry').onclick = () => void attemptLoad();
element('openSchool').onclick = async () => {
  try { await invoke('open_school_site'); }
  catch (error) { keyStatus.textContent = feedback(error); }
};
element('manage').onclick = () => {
  if (narrow.matches) setSidebar(false);
  keyStatus.textContent = '';
  showSetup(true);
};
element('back').onclick = () => { showWorkspace(); message.focus({ preventScroll: true }); };

async function confirmRemoval(prompt: string) {
  const dialog = document.createElement('dialog');
  dialog.className = 'removal-dialog';
  const label = document.createElement('p');
  label.textContent = prompt;
  dialog.setAttribute('aria-label', prompt);
  dialog.append(label);
  for (const [name,value] of [['취소하기','cancel'],['삭제하기','delete']]) {
    const button = document.createElement('button');
    button.textContent = name;
    button.onclick = () => dialog.close(value);
    dialog.append(button);
  }
  document.body.append(dialog);
  return new Promise<boolean>(resolve => {
    dialog.onclose = () => { dialog.remove(); resolve(dialog.returnValue === 'delete'); };
    dialog.showModal();
  });
}
element('removeKey').onclick = async () => {
  if (busy || !await confirmRemoval('이 기기에서 저장된 API 키를 삭제할까요?')) return;
  busy = true; update();
  try {
    await invoke('forget_key');
    connected = false; models = []; selected = null;
    resetConversation();
    showSetup(false);
    keyStatus.textContent = '저장된 키를 삭제했습니다.';
  } catch (error) { keyStatus.textContent = feedback(error); }
  finally { busy = false; update(); }
};
function addCopyButton(article: HTMLElement, turn: Turn) {
  if (turn.role !== 'assistant' || !turn.content) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-answer';
  const label = document.createElement('span');
  label.textContent = '복사';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'ui-icon');
  icon.setAttribute('aria-hidden', 'true');
  const glyph = document.createElementNS(icon.namespaceURI, 'use');
  glyph.setAttribute('href', '#icon-copy');
  icon.append(glyph);
  button.append(icon, label);
  button.setAttribute('aria-label', '답변 복사하기');
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      label.textContent = '복사됨';
      glyph.setAttribute('href', '#icon-check');
      button.classList.add('done');
      status.textContent = '답변을 복사했습니다.';
    }
    catch { status.textContent = '답변을 선택한 뒤 복사 단축키를 눌러 주세요.'; }
  };
  article.append(button);
}
const tokenNumber = new Intl.NumberFormat('ko-KR');
function addUsage(article: HTMLElement, usage?: Usage) {
  const details = document.createElement('details');
  details.className = 'turn-usage';
  const summary = document.createElement('summary');
  summary.textContent = usage?.total === undefined ? '토큰 사용량' : '토큰 ' + tokenNumber.format(usage.total) + '개';
  details.append(summary);
  const list = document.createElement('dl');
  function row(label: string, value: number | undefined) {
    if (value === undefined) return;
    const term = document.createElement('dt');
    term.textContent = label;
    const count = document.createElement('dd');
    count.textContent = tokenNumber.format(value);
    list.append(term, count);
  }
  row('전체 입력', usage?.input);
  row('출력', usage?.output);
  row('합계', usage?.total);
  row('Cache Hit', usage?.cacheRead);
  row('CacheMiss', usage?.uncachedInput);
  row('캐시에 새로 쓴 입력', usage?.cacheWrite);
  if (usage?.uncachedInput === undefined) row('일반 입력', usage?.ordinaryInput);
  if (list.childElementCount) details.append(list);
  if (!usage || usage.cacheRead === undefined) {
    const note = document.createElement('p');
    note.textContent = usage ? '캐시 재사용 정보는 제공되지 않았어요.' : '이 답변에 저장된 토큰 정보가 없어요.';
    details.append(note);
  }
  article.append(details);
}
function renderTurn(turn: Turn, streaming = false) {
  const article = document.createElement('article');
  if (turn.role === 'user') article.className = 'user-turn';
  article.classList.toggle('streaming', streaming);
  const author = document.createElement('strong');
  author.textContent = turn.role === 'user' ? '나' : 'D-GPT';
  article.append(author);
  if (turn.image && ['image/png','image/jpeg','image/webp'].includes(turn.image.mime)) {
    const img = document.createElement('img');
    img.alt = '첨부한 이미지';
    img.src = 'data:' + turn.image.mime + ';base64,' + turn.image.data;
    article.append(img);
  }
  const content = document.createElement('div');
  content.className = 'turn-content';
  if (!streaming) renderMarkdown(content, turn.content);
  article.append(content);
  if (turn.interrupted) article.append(document.createElement('br'), '응답이 중단되었습니다.');
  addCopyButton(article, turn);
  if (turn.role === 'assistant' && !streaming) addUsage(article, turn.usage);
  turns.append(article);
  return { content, article };
}
function updateConversationLayout() {
  const home = !thread?.turns.length;
  element('welcome').hidden = !home;
  element('body').classList.toggle('home', home);
  message.placeholder = home ? '무엇이든 물어보세요' : '이어서 물어보세요';
  message.rows = home ? 3 : 1;
  resizeMessage();
}
function resizeMessage() {
  message.style.height = '';
  if (message.value) message.style.height = message.scrollHeight + 'px';
}
function renderThread() {
  updateConversationLayout();
  turns.replaceChildren();
  thread?.turns.forEach(turn => renderTurn(turn));
  if (thread?.checkpoint) showCheckpoint(thread);
  turns.scrollTop = turns.scrollHeight;
  update();
}
function showCheckpoint(active: Thread) {
  turns.querySelector('.context-summary')?.remove();
  const checkpoint = active.checkpoint;
  if (!checkpoint) return;
  const anchor = turns.querySelectorAll('article')[checkpoint.through - 1];
  if (!anchor) return;
  const details = document.createElement('details');
  details.className = 'turn-usage context-summary';
  const label = document.createElement('summary');
  label.textContent = '이전 메시지 ' + tokenNumber.format(checkpoint.through) + '개 요약 보기';
  const note = document.createElement('p');
  note.textContent = checkpoint.text;
  details.append(label, note);
  const usage = checkpoint.usage;
  if (usage?.input !== undefined || usage?.output !== undefined) {
    const cost = document.createElement('small');
    const values = [];
    if (usage.input !== undefined) values.push('입력 ' + tokenNumber.format(usage.input));
    if (usage.output !== undefined) values.push('출력 ' + tokenNumber.format(usage.output));
    cost.textContent = '최근 요약 요청의 토큰 사용량 (' + values.join(', ') + ')';
    details.append(cost);
  }
  anchor.after(details);
}
function resetConversation(next: Thread | null = null) {
  thread = next; attachment = undefined; message.value = ''; status.textContent = '';
  renderThread();
}
async function refreshHistory() {
  try {
    const entries = await listThreads();
    const nav = element('history');
    nav.replaceChildren();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const week = new Date(midnight);
    week.setDate(week.getDate() - 6);
    let previousGroup = '';
    for (const entry of entries) {
      const group = entry.updated >= midnight.getTime() ? '오늘' : entry.updated >= week.getTime() ? '지난 7일' : '이전 대화';
      if (group !== previousGroup) {
        const heading = document.createElement('h2');
        heading.className = 'history-heading';
        heading.textContent = group;
        nav.append(heading);
        previousGroup = group;
      }
      const row = document.createElement('div');
      row.className = 'history-row';
      const open = document.createElement('button');
      open.textContent = entry.title;
      open.setAttribute('aria-current', String(entry.id === thread?.id));
      open.onclick = async () => {
        if (busy) return;
        if (entry.id !== thread?.id) {
          busy = true; update();
          try {
            resetConversation(await readThread(entry.id));
            nav.querySelector('[aria-current=true]')?.setAttribute('aria-current','false');
            open.setAttribute('aria-current','true');
          } catch (error) { status.textContent = feedback(error); }
          finally { busy = false; update(); }
        }
        if (narrow.matches) {
          setSidebar(false);
          message.focus({ preventScroll: true });
        }
      };
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.setAttribute('aria-label', entry.title + ' 대화 삭제하기');
      remove.onclick = async () => {
        if (busy || !await confirmRemoval('이 대화를 삭제할까요?')) return;
        busy = true; update();
        try {
          await deleteThread(entry.id);
          if (thread?.id === entry.id) resetConversation();
          await refreshHistory();
        } catch (error) { status.textContent = feedback(error); }
        finally { busy = false; update(); }
      };
      row.append(open, remove); nav.append(row);
    }
    update();
  } catch (error) { status.textContent = '대화 목록을 불러오지 못했습니다. ' + feedback(error); }
}
element('newChat').onclick = () => {
  resetConversation();
  if (narrow.matches) setSidebar(false);
  element('history').querySelector('[aria-current=true]')?.setAttribute('aria-current','false');
  message.focus();
};
const narrow = matchMedia('(max-width:720px)');
function setSidebar(open: boolean) {
  const overlay = open && narrow.matches;
  element('sidebar').hidden = !open;
  element('toggle').hidden = open;
  element('sideBackdrop').hidden = !overlay;
  element('chatStage').inert = overlay;
  element('toggle').setAttribute('aria-expanded', String(open));
}
setSidebar(!narrow.matches);
narrow.onchange = () => setSidebar(!narrow.matches);
element('toggle').onclick = () => { setSidebar(true); element('sideClose').focus(); };
function closeSidebar() { setSidebar(false); element('toggle').focus(); }
element('sideClose').onclick = closeSidebar;
element('sideBackdrop').onclick = closeSidebar;
for (const text of [/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl', 'N']) {
  const keycap = document.createElement('kbd');
  keycap.textContent = text;
  element('shortcut').append(keycap);
}
document.addEventListener('keydown', event => {
  if (element('workspace').hidden || document.querySelector('dialog[open], [aria-modal="true"]')) return;
  if (event.key === 'Escape' && narrow.matches && !element('sidebar').hidden) closeSidebar();
  if (!busy && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    element<HTMLButtonElement>('newChat').click();
  }
});
element('model').onclick = () => {
  if (!selected || busy) return;
  openModelPicker(models, selected.id, choice => {
    selected = resolveModel(models, choice.id);
    if (selected && !busy) {
      try { localStorage.setItem('preferredModel', selected.id); } catch { /* Preferences are optional. */ }
      if (attachment && selected.image !== '지원') {
        status.textContent = '첨부한 이미지를 보내려면 이미지 지원 모델을 고르세요. 이미지를 빼면 글만 보낼 수 있어요.';
      } else {
        status.textContent = '';
      }
    }
    update();
  });
};
function imageSupportHint() {
  const reason = selected?.image === '미지원' ? '선택한 모델은 글만 받을 수 있어요.' : '선택한 모델의 이미지 지원 여부를 확인할 수 없어요.';
  return reason + (models.some(model => model.image === '지원') ? ' 모델 목록에서 이미지 지원 모델을 골라 주세요.' : ' 연결된 키에 이미지 지원이 확인된 모델이 없어요.');
}
element('attach').onclick = () => {
  if (selected?.image === '지원') { file.click(); return; }
  status.textContent = imageSupportHint();
  if (models.some(model => model.image === '지원')) {
    const model = element<HTMLButtonElement>('model');
    model.focus();
    model.click();
  }
};
element('removeImage').onclick = () => { attachment = undefined; update(); status.textContent = ''; message.focus(); };
async function attachImage(item: File) {
  if (busy) return;
  if (selected?.image !== '지원') { status.textContent = imageSupportHint(); return; }
  busy = true; update();
  try {
    if (!item.size) throw Error('내용이 없는 파일입니다.');
    if (4 * Math.ceil(item.size / 3) >= limit) throw Error('이미지를 전송 형식으로 바꾸면 학교의 10 MiB 한도를 넘습니다. 더 작은 이미지를 선택해 주세요.');
    const prefix = new Uint8Array(await item.slice(0, 12).arrayBuffer());
    const start = (...values: number[]) => values.every((value, i) => prefix[i] === value);
    const mime = start(137,80,78,71,13,10,26,10) ? 'image/png' : start(255,216,255) ? 'image/jpeg' :
      start(82,73,70,70) && String.fromCharCode(...prefix.slice(8)) === 'WEBP' ? 'image/webp' : '';
    if (!mime) throw Error('PNG, JPEG 또는 WebP 이미지를 선택해 주세요.');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      const failed = () => reject(Error('이미지 파일을 읽지 못했습니다.'));
      reader.onerror = reader.onabort = failed;
      reader.onload = () => {
        if (typeof reader.result !== 'string') return failed();
        const separator = reader.result.indexOf(',');
        if (separator < 0 || separator === reader.result.length - 1) return failed();
        resolve(reader.result.slice(separator + 1));
      };
      reader.readAsDataURL(item);
    });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(item.slice(0, item.size, mime));
    attachment = {mime, data};
    const name = item.name || '붙여넣은 이미지';
    element<HTMLImageElement>('attachmentPreview').src = previewUrl;
    element('attachmentName').textContent = name;
    element('removeImage').setAttribute('aria-label', name + ' 첨부 취소하기');
    status.textContent = '';
  } catch (error) { status.textContent = feedback(error); }
  finally { busy = false; update(); message.focus(); }
}
file.onchange = () => {
  const item = file.files?.[0]; file.value = '';
  if (item) void attachImage(item);
};
element('compose').onpaste = event => {
  const files = event.clipboardData?.files;
  if (!files?.length) return;
  event.preventDefault();
  if (files.length === 1) void attachImage(files[0]);
  else status.textContent = '한 메시지에는 이미지 한 장을 첨부할 수 있어요.';
};
const stage = element('body');
stage.ondragover = event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = !busy && selected?.image === '지원' ? 'copy' : 'none';
  element('compose').classList.toggle('is-drop-target', !busy && selected?.image === '지원');
};
stage.ondragleave = event => {
  if (!(event.relatedTarget instanceof Node && stage.contains(event.relatedTarget))) element('compose').classList.remove('is-drop-target');
};
stage.ondrop = event => {
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  event.preventDefault();
  element('compose').classList.remove('is-drop-target');
  if (files.length === 1) void attachImage(files[0]);
  else status.textContent = '한 메시지에는 이미지 한 장을 첨부할 수 있어요.';
};
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, event => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
}
for (const id of ['connect', 'start', 'send', 'stop']) {
  const button = element(id);
  const origin = (event: PointerEvent) => {
    const bounds = button.getBoundingClientRect();
    button.style.setProperty('--mx', (event.clientX - bounds.left) + 'px');
    button.style.setProperty('--my', (event.clientY - bounds.top) + 'px');
  };
  button.onpointerenter = button.onpointerleave = origin;
}
message.oninput = () => { resizeMessage(); updateSend(); };
message.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); element<HTMLFormElement>('compose').requestSubmit();
  }
};
element('stop').onclick = async () => {
  if (!requestId || !canCancel) return;
  stopRequested = true;
  canCancel = false; update();
  try { await invoke('cancel_chat', {requestId}); }
  catch (error) { status.textContent = feedback(error); canCancel = Boolean(requestId); update(); }
};
function contextError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'contextLimit' in error && error.contextLimit === true;
}

element('compose').onsubmit = async event => {
  event.preventDefault();
  const content = message.value.trim();
  if (busy || !selected || (!content && !attachment)) return;
  if (attachment && selected.image !== '지원') { status.textContent = imageSupportHint(); return; }
  const active: Thread = thread ?? {id:crypto.randomUUID(), title:(content || '이미지 질문').slice(0,45), updated:Date.now(), turns:[]};
  const user: Turn = {role:'user', content, ...(attachment ? {image:attachment} : {})};
  const previous = active.turns.slice();
  const modelId = selected.id;
  const supportsImages = selected.image === '지원';
  let summaryCalls = 0;
  async function prepare(plan: ContextPlan): Promise<Turn[]> {
    while (plan.kind !== 'too-large') {
      if (stopRequested) throw Error('요청을 중지했습니다.');
      if (!supportsImages && plan.messages.some(turn => turn.image)) {
        throw Error('아직 요약되지 않은 이미지가 있습니다. 이미지를 지원하는 모델을 선택해 주세요.');
      }
      if (plan.kind === 'ready') return plan.messages;
      if (summaryCalls >= 3) throw Error('오래된 대화 일부를 요약해 저장했습니다. 질문을 다시 보내면 이어서 정리합니다.');
      summaryCalls++;
      status.textContent = '이전 대화를 요약하고 있어요. 선택한 모델의 입력과 출력 토큰이 사용됩니다.';
      const result = await invoke<ChatResult>('send_chat', {modelId, messages:plan.messages, onEvent:null, requestId});
      if (stopRequested) throw Error('요청을 중지했습니다.');
      const text = result.summary?.trim();
      if (result.interruption || !text || text.length > 8_000) {
        throw Error('완성된 대화 요약을 받지 못했습니다. 원문은 그대로 보관되어 있습니다.');
      }
      const checkpoint = {through:plan.through, text, usage:result.usage};
      await writeThread({...active, checkpoint});
      active.checkpoint = checkpoint;
      showCheckpoint(active);
      plan = planContext(previous, user, checkpoint);
    }
    throw Error(plan.reason);
  }
  const originalDraft = message.value;
  message.value = '';
  busy = true; stopRequested = false; requestId = crypto.randomUUID(); canCancel = true; update();
  let messages: Turn[];
  function restoreDraft() {
    message.value = originalDraft + (message.value ? '\n' + message.value : '');
    resizeMessage();
  }
  try { messages = await prepare(planContext(previous, user, active.checkpoint)); }
  catch (error) {
    restoreDraft();
    requestId = null; canCancel = false; busy = false; update();
    status.textContent = explainSchoolError(error);
    return;
  }
  active.turns.push(user); active.updated = Date.now();
  try { await writeThread(active); }
  catch (error) {
    active.turns.pop();
    restoreDraft();
    requestId = null; canCancel = false; busy = false; update();
    status.textContent = '질문을 저장하지 못했습니다. ' + feedback(error); return;
  }
  thread = active;
  attachment = undefined;
  updateConversationLayout();
  renderTurn(user);
  update();
  const reply: Turn = {role:'assistant', content:''};
  const { content: replyView, article } = renderTurn(reply, true);
  const liveText = document.createTextNode('');
  replyView.append(liveText);
  turns.scrollTop = turns.scrollHeight;
  let pendingText = '';
  let paintFrame: number | undefined;
  function paintStream() {
    paintFrame = undefined;
    const follow = turns.scrollHeight - turns.scrollTop - turns.clientHeight < 90;
    liveText.appendData(pendingText);
    pendingText = '';
    if (follow) turns.scrollTop = turns.scrollHeight;
  }
  const channel = new Channel<StreamText>();
  channel.onmessage = chunk => {
    if (chunk.type === 'text' && chunk.text) {
      if (!reply.content) status.textContent = '답변을 작성하고 있습니다.';
      reply.content += chunk.text;
      pendingText += chunk.text;
      paintFrame ??= requestAnimationFrame(paintStream);
    }
  };
  status.textContent = '응답을 기다리고 있습니다.';
  const sendAnswer = () => invoke<ChatResult>('send_chat', {modelId,messages,onEvent:channel,requestId});
  let retryingContext = false;
  try {
    if (stopRequested) throw Error('요청을 중지했습니다.');
    let result: ChatResult;
    try { result = await sendAnswer(); }
    catch (error) {
      if (stopRequested || reply.content || !contextError(error)) throw error;
      const retry = planContext(previous, user, active.checkpoint, true);
      if (retry.kind !== 'compact') throw error;
      retryingContext = true;
      messages = await prepare(retry);
      retryingContext = false;
      status.textContent = '요약한 대화로 응답을 기다리고 있습니다.';
      result = await sendAnswer();
    }
    if (selected?.id === modelId && selected.access === 'unconfirmed') selected.access = 'verified';
    reply.usage = result.usage;
    if (result.interruption) reply.interrupted = true;
    status.textContent = result.interruption ?? '';
  } catch (error) {
    reply.interrupted = true;
    status.textContent = explainSchoolError(error);
    if (retryingContext) {
      // The original answer was rejected before producing text. Put the unsent draft back only after the rollback is durable.
      const priorThread = {...active, turns:previous};
      try {
        await writeThread(priorThread);
        active.turns = previous;
        attachment = user.image;
        if (attachment) element<HTMLImageElement>('attachmentPreview').src = 'data:' + attachment.mime + ';base64,' + attachment.data;
        restoreDraft();
        renderThread();
        requestId = null; canCancel = false; busy = false; update(); message.focus();
        return;
      } catch (saveError) {
        status.textContent += ' 질문을 입력창으로 되돌리지 못했습니다. ' + feedback(saveError);
      }
    }
  } finally {
    if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
  }
  active.turns.push(reply); active.updated = Date.now();
  const follow = turns.scrollHeight - turns.scrollTop - turns.clientHeight < 90;
  article.classList.remove('streaming');
  renderMarkdown(replyView, reply.content);
  if (reply.interrupted) article.append('응답이 중단되었습니다.');
  addCopyButton(article, reply);
  addUsage(article, reply.usage);
  if (follow) turns.scrollTop = turns.scrollHeight;
  requestId = null; canCancel = false; update();
  try { await writeThread(active); await refreshHistory(); }
  catch (error) { status.textContent += ' 응답을 저장하지 못했습니다. ' + feedback(error); }
  finally { busy = false; update(); message.focus(); }
};
showSetup(false);
void attemptLoad();
