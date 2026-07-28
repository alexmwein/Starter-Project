const INLINE_PATTERN =
  /(`[^`\n]+`|(?<![\w*])\*\*(?![\s*])(?:[^*\n]*[^\s*\n])\*\*(?!\w)|(?<![\w*])\*(?![\s*])(?:[^*\n]*[^\s*\n])\*(?!\w))/;
const OPEN_FENCE_PATTERN = /^\s*```[^`]*$/;
const CLOSE_FENCE_PATTERN = /^\s*```\s*$/;
const HEADING_PATTERN = /^\s*#{1,6}\s+(.+)$/;
const UNORDERED_ITEM_PATTERN = /^\s*[-*+]\s+(.+)$/;
const ORDERED_ITEM_PATTERN = /^\s*(\d{1,9})[.)]\s+(.+)$/;

function parseBlocks(text) {
  const blocks = [];
  let paragraphLines = [];
  let list = null;
  let codeLines = null;

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') });
    paragraphLines = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push(list);
    list = null;
  }

  function flushCode() {
    if (!codeLines) return;
    blocks.push({
      type: 'code',
      text: codeLines.join('\n').replace(/\n+$/, ''),
    });
    codeLines = null;
  }

  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (codeLines) {
      if (CLOSE_FENCE_PATTERN.test(line)) flushCode();
      else codeLines.push(line);
      continue;
    }

    if (OPEN_FENCE_PATTERN.test(line)) {
      flushParagraph();
      flushList();
      codeLines = [];
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', text: heading[1] });
      continue;
    }

    const unorderedItem = line.match(UNORDERED_ITEM_PATTERN);
    if (unorderedItem) {
      flushParagraph();
      if (list?.type !== 'unordered-list') {
        flushList();
        list = { type: 'unordered-list', items: [] };
      }
      list.items.push(unorderedItem[1]);
      continue;
    }

    const orderedItem = line.match(ORDERED_ITEM_PATTERN);
    if (orderedItem) {
      flushParagraph();
      if (list?.type !== 'ordered-list') {
        flushList();
        list = {
          type: 'ordered-list',
          start: Number(orderedItem[1]),
          items: [],
        };
      }
      list.items.push({
        value: Number(orderedItem[1]),
        text: orderedItem[2],
      });
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  flushCode();
  return blocks;
}

function appendInline(document, parent, text) {
  for (const piece of String(text).split(INLINE_PATTERN)) {
    if (!piece) continue;
    if (piece.length > 2 && piece.startsWith('`') && piece.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = piece.slice(1, -1);
      parent.append(code);
      continue;
    }

    const strong =
      piece.length > 4 &&
      piece.startsWith('**') &&
      piece.endsWith('**');
    const emphasis =
      !strong &&
      piece.length > 2 &&
      piece.startsWith('*') &&
      piece.endsWith('*') &&
      !/^\d+(?:[.,]\d+)?$/.test(piece.slice(1, -1));
    if (strong || emphasis) {
      const element = document.createElement(strong ? 'strong' : 'em');
      element.textContent = piece.slice(strong ? 2 : 1, strong ? -2 : -1);
      parent.append(element);
    } else {
      parent.append(document.createTextNode(piece));
    }
  }
}

function inlineElement(document, tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  appendInline(document, element, text);
  return element;
}

export function renderRichText(document, text) {
  const fragment = document.createDocumentFragment();
  for (const block of parseBlocks(text)) {
    if (block.type === 'code') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.text;
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    if (block.type === 'heading') {
      fragment.append(
        inlineElement(document, 'h2', block.text, 'message-heading'),
      );
      continue;
    }

    if (
      block.type === 'unordered-list' ||
      block.type === 'ordered-list'
    ) {
      const list = document.createElement(
        block.type === 'unordered-list' ? 'ul' : 'ol',
      );
      if (block.type === 'ordered-list') list.start = block.start;
      for (const item of block.items) {
        const listItem = inlineElement(
          document,
          'li',
          block.type === 'ordered-list' ? item.text : item,
        );
        if (block.type === 'ordered-list') listItem.value = item.value;
        list.append(listItem);
      }
      fragment.append(list);
      continue;
    }

    fragment.append(inlineElement(document, 'p', block.text));
  }
  return fragment;
}
