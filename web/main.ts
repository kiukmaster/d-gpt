import { Channel, invoke } from '@tauri-apps/api/core';
import { normalizeModels, resolveModel, type SchoolModel } from './models';
import { openModelPicker } from './picker';
import { deleteThread, listThreads, readThread, writeThread, type Thread, type Turn } from './history';
import './shell.css';

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
type StreamEvent = {type:'text'|'usage', text?:string, input?:number, output?:number};
let models: SchoolModel[] = [];
let selected: SchoolModel | null = null;
let thread: Thread | null = null;
let attachment: Turn['image'];
let busy = false;
let requestId: string | null = null;
let connected = false;
let canCancel = false;

function feedback(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function preference() {
  try { return localStorage.getItem('preferredModel'); } catch { return null; }
}
function updateSend() {
  element<HTMLButtonElement>('send').disabled = busy || !selected || !(message.value.trim() || attachment);
}
function updateConnect() {
  element<HTMLButtonElement>('connect').disabled = busy || !key.value.trim();
}
function update() {
  const model = element<HTMLButtonElement>('model');
  element('modelName').textContent = selected?.id ?? '사용 가능한 모델이 없습니다';
  const modelIndex = selected ? models.indexOf(selected) : -1;
  const dialPageSize = 5;
  const slot = Math.max(0, modelIndex) % dialPageSize;
  const count = Math.min(dialPageSize, models.length - Math.max(0, modelIndex) + slot);
  model.style.setProperty('--model-angle', (count ? slot * 360 / count : 0) + 'deg');
  model.setAttribute('aria-label', selected ? '모델 바꾸기, 현재 모델 ' + selected.id : '사용 가능한 모델이 없습니다');
  model.disabled = busy || !models.length;
  const imageSupported = selected?.image === '지원';
  element<HTMLButtonElement>('attach').disabled = busy || !imageSupported;
  element('attach').title = imageSupported ? 'PNG, JPEG, WebP 이미지를 첨부하세요' :
    selected?.image === '미지원' ? '이 모델은 이미지 입력을 지원하지 않습니다.' : '이 모델의 이미지 지원을 확인할 수 없습니다.';
  element<HTMLButtonElement>('removeImage').disabled = busy;
  element('removeImage').hidden = !attachment;
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
  renderThread();
}
async function loadModels(raw: {data:unknown[]}) {
  models = normalizeModels(raw);
  selected = resolveModel(models, preference());
  connected = true;
  if (selected?.image !== '지원') attachment = undefined;
  await refreshHistory();
}
async function attemptLoad(replacement?: string) {
  busy = true;
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
    const detail = feedback(error);
    const missing = detail === '등록된 API 키가 없습니다.';
    showSetup(registered || connected || (!replacement && !missing) || !element('removeKey').hidden);
    if (replacement && !registered) key.value = replacement;
    keyStatus.textContent = missing ? '' : detail;
  } finally { busy = false; update(); }
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
key.oninput = updateConnect;
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
element('manage').onclick = () => { keyStatus.textContent = ''; showSetup(true); };
element('back').onclick = () => { showWorkspace(); message.focus(); };

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
  button.textContent = '복사';
  button.setAttribute('aria-label', '답변 복사하기');
  button.onclick = async () => {
    try { await navigator.clipboard.writeText(turn.content); status.textContent = '답변을 복사했습니다.'; }
    catch { status.textContent = '답변을 선택한 뒤 복사 단축키를 눌러 주세요.'; }
  };
  article.append(button);
}
function renderTurn(turn: Turn) {
  const article = document.createElement('article');
  if (turn.role === 'user') article.className = 'user-turn';
  const author = document.createElement('strong');
  author.textContent = turn.role === 'user' ? '나' : 'D-GPT';
  article.append(author);
  if (turn.image && ['image/png','image/jpeg','image/webp'].includes(turn.image.mime)) {
    const img = document.createElement('img');
    img.alt = '첨부한 이미지';
    img.src = 'data:' + turn.image.mime + ';base64,' + turn.image.data;
    article.append(img);
  }
  const body = document.createTextNode(turn.content);
  article.append(body);
  if (turn.interrupted) article.append(document.createElement('br'), '응답이 중단되었습니다.');
  addCopyButton(article, turn);
  turns.append(article);
  return body;
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
  thread?.turns.forEach(renderTurn);
  turns.scrollTop = turns.scrollHeight;
  update();
}
function resetConversation() {
  thread = null; attachment = undefined; message.value = ''; status.textContent = '';
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
        busy = true; update();
        try {
          const loaded = await readThread(entry.id);
          resetConversation(); thread = loaded; renderThread();
          if (narrow.matches) setSidebar(false);
          nav.querySelector('[aria-current=true]')?.setAttribute('aria-current','false');
          open.setAttribute('aria-current','true');
        } catch (error) { status.textContent = feedback(error); }
        finally { busy = false; update(); }
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
  element('sidebar').hidden = !open;
  element('toggle').hidden = open;
  element('sideBackdrop').hidden = !open || !narrow.matches;
  element('toggle').setAttribute('aria-expanded', String(open));
}
setSidebar(!narrow.matches);
narrow.onchange = () => setSidebar(!narrow.matches);
element('toggle').onclick = () => { setSidebar(true); element('sideClose').focus(); };
function closeSidebar() { setSidebar(false); element('toggle').focus(); }
element('sideClose').onclick = closeSidebar;
element('sideBackdrop').onclick = closeSidebar;
element('shortcut').textContent = /Mac/.test(navigator.platform) ? '⌘ N' : 'Ctrl N';
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
        attachment = undefined;
        status.textContent = '선택한 모델에서 이미지를 사용할 수 없어 첨부를 해제했습니다.';
      }
    }
    update();
  });
};
element('attach').onclick = () => file.click();
element('removeImage').onclick = () => { attachment = undefined; update(); };
file.onchange = async () => {
  const item = file.files?.[0]; file.value = '';
  if (!item || busy || selected?.image !== '지원') return;
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
    attachment = {mime, data};
    element('removeImage').textContent = item.name + ' ×';
    element('removeImage').setAttribute('aria-label', item.name + ' 첨부 취소하기');
    status.textContent = '';
  } catch (error) { status.textContent = feedback(error); }
  finally { busy = false; update(); }
};
message.oninput = () => { resizeMessage(); updateSend(); };
message.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); element<HTMLFormElement>('compose').requestSubmit();
  }
};
element('stop').onclick = async () => {
  if (!requestId || !canCancel) return;
  canCancel = false; update();
  try { await invoke('cancel_chat', {requestId}); }
  catch (error) { status.textContent = feedback(error); canCancel = Boolean(requestId); update(); }
};
element('compose').onsubmit = async event => {
  event.preventDefault();
  const content = message.value.trim();
  if (busy || !selected || (!content && !attachment)) return;
  if (selected.image !== '지원' && thread?.turns.some(turn => turn.image)) {
    status.textContent = '이미지가 있는 대화입니다. 이미지를 지원하는 모델을 선택하거나 새 대화를 시작해 주세요.';
    return;
  }
  const active: Thread = thread ?? {id:crypto.randomUUID(), title:(content || '이미지 질문').slice(0,45), updated:Date.now(), turns:[]};
  const user: Turn = {role:'user', content, ...(attachment ? {image:attachment} : {})};
  const messages = [...active.turns.filter(turn => turn.content || turn.image), user].map(({role,content,image}) => ({role,content,...(image ? {image} : {})}));
  if (messages.reduce((bytes, item) => bytes + (item.image?.data.length ?? 0) + item.content.length, 0) >= limit) {
    status.textContent = '이 대화와 첨부를 합치면 학교의 10 MiB 한도를 넘습니다. 첨부를 줄이거나 새 대화를 시작해 주세요.';
    return;
  }
  const modelId = selected.id;
  const originalDraft = message.value;
  message.value = '';
  busy = true; update();
  active.turns.push(user); active.updated = Date.now();
  try { await writeThread(active); }
  catch (error) {
    active.turns.pop();
    message.value = originalDraft + (message.value ? '\n' + message.value : '');
    busy = false; update();
    status.textContent = '질문을 저장하지 못했습니다. ' + feedback(error); return;
  }
  thread = active;
  attachment = undefined;
  requestId = crypto.randomUUID(); canCancel = true;
  updateConversationLayout();
  renderTurn(user);
  update();
  const reply: Turn = {role:'assistant', content:''};
  const body = renderTurn(reply);
  turns.scrollTop = turns.scrollHeight;
  const channel = new Channel<StreamEvent>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  channel.onmessage = chunk => {
    if (chunk.type === 'text' && chunk.text) {
      const follow = turns.scrollHeight - turns.scrollTop - turns.clientHeight < 90;
      if (!reply.content) status.textContent = '답변을 작성하고 있습니다.';
      reply.content += chunk.text; body.appendData(chunk.text);
      if (follow) turns.scrollTop = turns.scrollHeight;
    } else if (chunk.type === 'usage') {
      inputTokens = chunk.input ?? inputTokens;
      outputTokens = chunk.output ?? outputTokens;
    }
  };
  status.textContent = '응답을 기다리고 있습니다.';
  try {
    await invoke('send_chat', {modelId,messages,onEvent:channel,requestId});
    const usage = [inputTokens === undefined ? '' : '입력 ' + inputTokens, outputTokens === undefined ? '' : '출력 ' + outputTokens].filter(Boolean).join(', ');
    status.textContent = usage ? '사용한 토큰 수: ' + usage : '';
  } catch (error) {
    reply.interrupted = true;
    body.parentElement?.append(document.createElement('br'), '응답이 중단되었습니다.');
    status.textContent = feedback(error);
  }
  active.turns.push(reply); active.updated = Date.now();
  if (body.parentElement) addCopyButton(body.parentElement, reply);
  requestId = null; canCancel = false; update();
  try { await writeThread(active); await refreshHistory(); }
  catch (error) { status.textContent += ' 응답을 저장하지 못했습니다. ' + feedback(error); }
  finally { busy = false; update(); message.focus(); }
};
showSetup(false);
void attemptLoad();
