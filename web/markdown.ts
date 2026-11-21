import { Lexer, type MarkedToken, type Token } from 'marked';

const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

type ParsedPages = Token[][];
const work: { container: HTMLElement; source: string; pending: Text }[] = [];
let parsing = false;

function showPages(container: HTMLElement, pages: ParsedPages): void {
  if (pages.length === 1) {
    renderPage(container, pages[0]);
    return;
  }
  const doc = container.ownerDocument;
  if (pages.length <= 4) {
    const parts = pages.map(() => doc.createElement('div'));
    container.replaceChildren(...parts);
    let index = 0;
    function appendPart() {
      if (!container.isConnected || parts[index].parentNode !== container) return;
      const scroll = container.closest<HTMLElement>('#turns');
      const follow = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
      renderPage(parts[index], pages[index]);
      if (follow) scroll.scrollTop = scroll.scrollHeight;
      if (++index < pages.length) requestAnimationFrame(appendPart);
    }
    appendPart();
    return;
  }
  const content = doc.createElement('div');
  const controls = doc.createElement('nav');
  controls.setAttribute('aria-label', '긴 메시지 페이지');
  const back = doc.createElement('button');
  const forward = doc.createElement('button');
  const label = doc.createElement('span');
  label.setAttribute('aria-live', 'polite');
  back.type = forward.type = 'button';
  back.textContent = '이전';
  forward.textContent = '다음';
  let index = 0;
  function show() {
    renderPage(content, pages[index]);
    label.textContent = ' ' + (index + 1) + ' / ' + pages.length + ' ';
    back.disabled = index === 0;
    forward.disabled = index === pages.length - 1;
  }
  back.onclick = () => { index--; show(); };
  forward.onclick = () => { index++; show(); };
  controls.append(back, label, forward);
  container.replaceChildren(controls, content);
  show();
}

function parseNext(): void {
  if (parsing) return;
  const task = work.shift();
  if (!task) return;
  if (!task.container.isConnected || task.pending.parentNode !== task.container) {
    queueMicrotask(parseNext);
    return;
  }
  parsing = true;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function finish(pages?: ParsedPages): void {
    clearTimeout(timer);
    worker?.terminate();
    parsing = false;
    if (pages && task && task.container.isConnected && task.pending.parentNode === task.container) {
      showPages(task.container, pages);
    }
    queueMicrotask(parseNext);
  }
  try {
    worker = new Worker(new URL('./markdown-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ParsedPages | null>) => finish(event.data ?? undefined);
    worker.onerror = () => finish();
    worker.onmessageerror = () => finish();
    timer = setTimeout(() => finish(), 30_000);
    worker.postMessage(task.source);
  } catch {
    finish();
  }
}

export function renderMarkdown(container: HTMLElement, source: string): void {
  if (source.length <= 24_000 && (source.match(/[\n*_|<>\[\]~`]/g)?.length ?? 0) < 2_000) {
    try {
      renderPage(container, Lexer.lex(source, { gfm: true, breaks: true }));
      return;
    } catch { /* Retry isolated blocks in the worker. */ }
  }
  const pending = container.ownerDocument.createTextNode(source);
  container.replaceChildren(pending);
  work.push({ container, source, pending });
  queueMicrotask(parseNext);
}

function renderPage(container: HTMLElement, blocks: Token[]): void {
  const document = container.ownerDocument;
  const fragment = document.createDocumentFragment();
  let remaining = 8_000;

  function render(parent: ParentNode, tokens: Token[], depth: number): void {
    // The built-in lexer is used without extensions, so only built-in tokens are emitted.
    for (const [index, token] of (tokens as MarkedToken[]).entries()) {
      if (depth > 48 || remaining <= 0) {
        parent.append(document.createTextNode(tokens.slice(index).map(item => item.raw).join('')));
        break;
      }
      remaining--;
      switch (token.type) {
        case 'space':
        case 'def':
          break;
        case 'heading':
        case 'paragraph':
        case 'blockquote':
        case 'strong':
        case 'em':
        case 'del':
        case 'list_item': {
          const tag = token.type === 'heading' ? headings[token.depth - 1] :
            token.type === 'paragraph' ? 'p' : token.type === 'list_item' ? 'li' : token.type;
          const child = document.createElement(tag);
          render(child, token.tokens, depth + 1);
          parent.append(child);
          break;
        }
        case 'list': {
          const list = document.createElement(token.ordered ? 'ol' : 'ul');
          if (token.ordered && typeof token.start === 'number' && token.start !== 1) {
            list.setAttribute('start', String(token.start));
          }
          render(list, token.items, depth + 1);
          parent.append(list);
          break;
        }
        case 'table': {
          if ((token.rows.length + 1) * token.header.length > remaining) {
            const text = token.raw || [token.header, ...token.rows].map(row => row.map(cell => cell.text).join(' | ')).join('\n');
            parent.append(document.createTextNode(text));
            break;
          }
          const table = document.createElement('table');
          const head = document.createElement('thead');
          const body = document.createElement('tbody');
          table.append(head, body);
          for (const [index, cells] of [token.header, ...token.rows].entries()) {
            const row = document.createElement('tr');
            for (const cell of cells) {
              remaining--;
              const item = document.createElement(index === 0 ? 'th' : 'td');
              if (cell.align) item.style.textAlign = cell.align;
              render(item, cell.tokens, depth + 1);
              row.append(item);
            }
            (index === 0 ? head : body).append(row);
          }
          const wrapper = document.createElement('div');
          wrapper.className = 'md-table';
          wrapper.append(table);
          parent.append(wrapper);
          break;
        }
        case 'code': {
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = token.text;
          if (token.lang) {
            const label = document.createElement('span');
            label.className = 'code-language';
            label.textContent = token.lang;
            pre.append(label);
          }
          pre.append(code);
          parent.append(pre);
          break;
        }
        case 'codespan': {
          const code = document.createElement('code');
          code.textContent = token.text;
          parent.append(code);
          break;
        }
        case 'link':
          render(parent, token.tokens, depth + 1);
          if (token.text !== token.href) parent.append(document.createTextNode(' (' + token.href + ')'));
          break;
        case 'image':
        case 'html':
          parent.append(document.createTextNode(token.raw));
          break;
        case 'text':
          if (token.tokens) render(parent, token.tokens, depth + 1);
          else parent.append(document.createTextNode(token.text));
          break;
        case 'escape':
          parent.append(document.createTextNode(token.text));
          break;
        case 'checkbox':
          parent.append(document.createTextNode(token.checked ? '[x] ' : '[ ] '));
          break;
        case 'br':
        case 'hr':
          parent.append(document.createElement(token.type));
          break;
      }
    }
  }

  render(fragment, blocks, 0);
  container.replaceChildren(fragment);
}
