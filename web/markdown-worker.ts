import { Lexer, type MarkedToken, type Token } from 'marked';

const pageBudget = 4_000;

function weight(token: Token, depth = 0): number {
  if (depth > 48) return 1;
  const block = token as MarkedToken;
  if (block.type === 'table') {
    let count = 1;
    for (const row of [block.header, ...block.rows]) count += rowWeight(row, depth);
    return count;
  }
  const children = block.type === 'list' ? block.items : 'tokens' in block ? block.tokens : undefined;
  return 1 + (children?.reduce((sum, child) => sum + weight(child, depth + 1), 0) ?? 0);
}

function rowWeight(row: { tokens: Token[] }[], depth: number): number {
  return 1 + row.reduce((sum, cell) => sum + 1 + cell.tokens.reduce((n, child) => n + weight(child, depth + 1), 0), 0);
}

function* groups<T>(items: T[], cost: (item: T) => number, budget: number): Generator<T[]> {
  let group: T[] = [];
  let size = 0;
  for (const item of items) {
    const n = cost(item);
    if (group.length && size + n > budget) {
      yield group;
      group = [];
      size = 0;
    }
    group.push(item);
    size += n;
  }
  if (group.length) yield group;
}

function* splitBlocks(tokens: Token[]): Generator<Token> {
  for (const block of tokens as MarkedToken[]) {
    if (block.type === 'paragraph' && weight(block) > pageBudget) {
      for (const tokens of groups(block.tokens, item => weight(item), pageBudget - 1)) {
        const text = tokens.map(item => item.raw).join('');
        yield { ...block, raw: text, text, tokens };
      }
    } else if (block.type === 'list' && weight(block) > pageBudget) {
      let start = block.start;
      for (const items of groups(block.items, item => weight(item), pageBudget - 1)) {
        yield { ...block, raw: '', start, items };
        if (typeof start === 'number') start += items.length;
      }
    } else if (block.type === 'table' && block.rows.length && weight(block) > pageBudget) {
      const budget = pageBudget - rowWeight(block.header, 0) - 1;
      for (const rows of groups(block.rows, row => rowWeight(row, 0), budget)) {
        yield { ...block, raw: '', rows };
      }
    } else {
      yield block;
    }
  }
}

function lexDocument(source: string): Token[] {
  const options = { gfm: true, breaks: true };
  try {
    return Lexer.lex(source, options);
  } catch {
    return source.split(/(\r?\n[ \t]*\r?\n)/).flatMap((section): Token[] => {
      try {
        return Lexer.lex(section, options);
      } catch {
        return [{ type: 'text', raw: section, text: section }];
      }
    });
  }
}

self.onmessage = (event: MessageEvent<string>) => {
  try {
    const tokens = lexDocument(event.data);
    const blocks = Array.from(splitBlocks(tokens));
    const pages = Array.from(groups(blocks, block => weight(block), pageBudget));
    self.postMessage(pages.length ? pages : [[]]);
  } catch {
    self.postMessage(null);
  }
};
