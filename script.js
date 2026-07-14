const pasteArea = document.getElementById('pasteArea');
const sentenceList = document.getElementById('sentenceList');
const prevBox = document.querySelector('.prev-sentence');
const boardBox = document.querySelector('.board');
const nextBox = document.querySelector('.next-sentence');
const prevSentenceText = document.getElementById('prevSentenceText');
const boardText = document.getElementById('boardText');
const nextSentenceText = document.getElementById('nextSentenceText');
const splitText = document.getElementById('splitText');
const fullTextActions = document.getElementById('fullTextActions');
const rePasteBtn = document.getElementById('rePasteBtn');
const spellcheckBtn = document.getElementById('spellcheckBtn');
const clearBtn = document.getElementById('clearBtn');
const answerBox = document.getElementById('answerBox');

const DEFAULT_PREV_TEXT = prevSentenceText.textContent;
const DEFAULT_BOARD_TEXT = boardText.textContent;
const DEFAULT_NEXT_TEXT = nextSentenceText.textContent;
const DEFAULT_SPLIT_TEXT = splitText.textContent;
const DEFAULT_ANSWER_TEXT = answerBox.textContent;
let answerRequestId = 0;

let sentences = [];
let currentIndex = -1;
const cutsBySentence = {};
const exceptionsBySentence = {};
const completedIndices = new Set();

// 커서는 글자 인덱스(0..문장길이) 기준의 "칸 사이" 위치. 예외로 묶인 단어는 한 덩어리로 건너뛴다.
let cursorChar = 0;
let selectionAnchorChar = null;

// 축약 복원 테이블 / 어원 테이블: 사용자가 사선을 클릭해서 등록한 판정만 들어간다 (registerCutType 참고).
// localStorage에 영속 저장 — 코드에 미리 채워두지 않는다.
const WORD_TABLE_KEY = 'morpheme_word_table';

function loadWordTable() {
  try {
    return JSON.parse(localStorage.getItem(WORD_TABLE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveWordTable(table) {
  localStorage.setItem(WORD_TABLE_KEY, JSON.stringify(table));
}

const wordTable = loadWordTable();

function isWordBoundaryChar(ch) {
  return ch === ' ' || ch === '.' || ch === ',' || ch === '!' || ch === '?';
}

// 절단이 속한 어절 전체(공백/문장부호 기준)와, 그 어절 시작 글자 인덱스.
function getWordRangeAtBoundary(text, boundary) {
  const chars = Array.from(text);
  let start = boundary;
  while (start > 0 && !isWordBoundaryChar(chars[start - 1])) start--;
  let end = boundary + 1;
  while (end < chars.length && !isWordBoundaryChar(chars[end])) end++;
  return { word: chars.slice(start, end).join(''), start };
}

// 프롬프트에 보여줄 라벨용.
function getWordAtBoundary(text, boundary) {
  return getWordRangeAtBoundary(text, boundary).word;
}

// 테이블 조회/저장용 키 — "어절 전체 + 그 어절 안에서 이 경계의 상대 위치".
// 어절 전체만 쓰면 "저장한다고" 안의 서로 다른 절단끼리 겹치는 버그가 있었고,
// 경계 양옆 두 글자만 쓰면 "는"처럼 흔한 글자가 완전히 다른 단어에서도 우연히 겹치는 버그가 있었음.
// 이 둘을 합치면 "같은 단어의 같은 위치"일 때만 매칭되어 둘 다 해결됨.
function getLookupKey(text, boundary) {
  const { word, start } = getWordRangeAtBoundary(text, boundary);
  return `${word}|${boundary - start}`;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function renderSentenceList() {
  sentenceList.innerHTML = '';
  sentences.forEach((s, i) => {
    const span = document.createElement('span');
    span.className = 'sentence';
    span.textContent = s;
    span.dataset.idx = i;
    span.addEventListener('click', () => selectSentence(i));
    sentenceList.appendChild(span);
    sentenceList.appendChild(document.createTextNode(' '));
  });
}

// 예외로 묶이지 않은 글자는 'char' 블록(1글자), 예외로 묶인 단어는 'exception' 블록(여러 글자) 하나로 취급한다.
function getBlocks(chars, exceptions) {
  const blocks = [];
  let idx = 0;
  while (idx < chars.length) {
    const exc = exceptions.find(r => r.start === idx);
    if (exc) {
      blocks.push({ type: 'exception', start: exc.start, end: exc.end });
      idx = exc.end + 1;
    } else {
      blocks.push({ type: 'char', start: idx, end: idx });
      idx++;
    }
  }
  return blocks;
}

function createGapElement(boundary, cuts) {
  const gap = document.createElement('span');
  gap.className = 'gap';
  gap.dataset.boundary = boundary;
  const cut = cuts.get(boundary);
  if (cut) {
    const line = document.createElement('span');
    line.className = `cut-line cut-${cut.type}`;
    gap.appendChild(line);
    if (cut.annotation) {
      const label = document.createElement('span');
      label.className = `cut-annotation ${cut.type === 'blue' ? 'above' : 'below'}`;
      label.textContent = cut.type === 'gray' ? `(어원:${cut.annotation})` : cut.annotation;
      gap.appendChild(label);
    }
  }
  return gap;
}

// 문장 하나를 글자/사선/예외 마크업으로 렌더링해서 container에 채운다.
// 도마(커서 있음), 이전문장/쪼갠전문(커서 없음) 모두 이 함수 하나로 그린다.
function renderSentenceMarkup(container, text, cuts, exceptions, cursorInfo) {
  container.innerHTML = '';
  if (!text) return;
  const chars = Array.from(text);
  const blocks = getBlocks(chars, exceptions);

  const selStart = cursorInfo && cursorInfo.selectionAnchor !== null
    ? Math.min(cursorInfo.selectionAnchor, cursorInfo.cursor) : -1;
  const selEnd = cursorInfo && cursorInfo.selectionAnchor !== null
    ? Math.max(cursorInfo.selectionAnchor, cursorInfo.cursor) : -1;

  function maybeAppendCursor(charPos) {
    if (cursorInfo && charPos === cursorInfo.cursor) {
      const cur = document.createElement('span');
      cur.className = 'cursor';
      container.appendChild(cur);
    }
  }

  maybeAppendCursor(0);
  blocks.forEach(block => {
    const isSelected = selStart !== -1 && block.start >= selStart && block.start < selEnd;
    if (block.type === 'exception') {
      const wrap = document.createElement('span');
      wrap.className = 'exception-word' + (isSelected ? ' selecting' : '');
      wrap.dataset.start = block.start;
      wrap.dataset.end = block.end;
      for (let k = block.start; k <= block.end; k++) {
        const charSpan = document.createElement('span');
        charSpan.className = 'char';
        charSpan.textContent = chars[k];
        wrap.appendChild(charSpan);
      }
      container.appendChild(wrap);
    } else {
      const charSpan = document.createElement('span');
      charSpan.className = 'char' + (isSelected ? ' selecting' : '');
      charSpan.textContent = chars[block.start];
      container.appendChild(charSpan);
    }
    if (block.end + 1 < chars.length) {
      container.appendChild(createGapElement(block.end, cuts));
    }
    maybeAppendCursor(block.end + 1);
  });
}

function renderBoard(i) {
  const text = sentences[i] || '';
  const cuts = cutsBySentence[i] || new Map();
  cutsBySentence[i] = cuts;
  const exceptions = exceptionsBySentence[i] || [];
  exceptionsBySentence[i] = exceptions;
  if (i !== currentIndex) {
    renderSentenceMarkup(boardText, text, cuts, exceptions, null);
    return;
  }
  renderSentenceMarkup(boardText, text, cuts, exceptions, { cursor: cursorChar, selectionAnchor: selectionAnchorChar });
}

function renderPrevSentence(i) {
  if (i < 0 || !sentences[i]) {
    prevSentenceText.textContent = DEFAULT_PREV_TEXT;
    return;
  }
  const cuts = cutsBySentence[i] || new Map();
  const exceptions = exceptionsBySentence[i] || [];
  renderSentenceMarkup(prevSentenceText, sentences[i], cuts, exceptions, null);
}

function renderSplitText() {
  const indices = Array.from(completedIndices).sort((a, b) => a - b);
  if (indices.length === 0) {
    splitText.classList.add('empty');
    splitText.textContent = DEFAULT_SPLIT_TEXT;
    updateAnswerBox('');
    return;
  }
  splitText.classList.remove('empty');
  splitText.innerHTML = '';
  indices.forEach((idx, n) => {
    const span = document.createElement('span');
    renderSentenceMarkup(span, sentences[idx], cutsBySentence[idx] || new Map(), exceptionsBySentence[idx] || [], null);
    splitText.appendChild(span);
    if (n < indices.length - 1) splitText.appendChild(document.createTextNode(' '));
  });
  updateAnswerBox(indices.map(idx => sentences[idx]).join(' '));
}

// "정답" 비교 페이지: 유저가 직접 쪼갠 결과(쪼갠 전문)를 스스로 대조해볼 수 있게
// 실제 형태소분석 결과를 보여준다. 쪼개는 과정 자체는 여전히 100% 유저 판단 — 결과가 나온 뒤의 대조용.
async function updateAnswerBox(text) {
  const requestId = ++answerRequestId;
  if (!text) {
    answerBox.classList.add('empty');
    answerBox.textContent = DEFAULT_ANSWER_TEXT;
    return;
  }
  try {
    const res = await fetch('https://intpdiary.duckdns.org/api/morpheme/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (requestId !== answerRequestId) return;
    if (!res.ok) throw new Error('analyze request failed');
    const data = await res.json();
    if (requestId !== answerRequestId) return;
    answerBox.classList.remove('empty');
    answerBox.textContent = data.formatted;
  } catch (err) {
    if (requestId !== answerRequestId) return;
    answerBox.classList.remove('empty');
    answerBox.textContent = '정답을 불러오지 못했습니다.';
  }
}

function toggleCut(boundary) {
  if (currentIndex < 0 || !sentences[currentIndex]) return;
  const cuts = cutsBySentence[currentIndex] || new Map();
  cutsBySentence[currentIndex] = cuts;
  if (cuts.has(boundary)) {
    cuts.delete(boundary);
  } else {
    // 새 절단은 항상 빨강으로 시작한다. 과거 등록 기록은 클릭해서 편집할 때 "제시"만 하고
    // 자동 적용은 하지 않는다 — 2글자 키가 우연히 겹치면 전혀 무관한 절단에 엉뚱한 주석이
    // 조용히 붙는 문제가 있었음(예: "도드라지는"의 "는"에 무관한 "이라고 하는"이 자동 적용됨).
    cuts.set(boundary, { type: 'red', annotation: '' });
  }
  renderBoard(currentIndex);
}

function registerCutType(boundary) {
  if (currentIndex < 0 || !sentences[currentIndex]) return;
  const cuts = cutsBySentence[currentIndex];
  const cut = cuts && cuts.get(boundary);
  if (!cut) return;

  const word = getWordAtBoundary(sentences[currentIndex], boundary);
  const key = getLookupKey(sentences[currentIndex], boundary);
  const suggestion = wordTable[key];

  let currentChoice = cut.type === 'blue' ? '2' : cut.type === 'gray' ? '3' : '1';
  let suggestionHint = '';
  if (cut.type === 'red' && suggestion) {
    currentChoice = suggestion.type === 'blue' ? '2' : '3';
    suggestionHint = `\n\n(이전에 "${key}"를 ${suggestion.type === 'blue' ? '복원' : '어원'} "${suggestion.annotation}"로 등록한 기록이 있습니다 — 이 절단에도 같은 판정이면 ${currentChoice} 선택)`;
  }

  const choice = window.prompt(
    `"${word}" 이 절단의 타입을 선택하세요.\n1 = 일반(빨강)\n2 = 복원(파랑)\n3 = 어원(회색 점선)${suggestionHint}`,
    currentChoice
  );
  if (choice === null) return;

  const suggestedAnnotation = suggestion ? suggestion.annotation : '';

  if (choice.trim() === '2') {
    const defaultAnnotation = cut.type === 'blue' ? cut.annotation : (suggestion && suggestion.type === 'blue' ? suggestedAnnotation : '');
    const annotation = window.prompt('복원형을 입력하세요 (예: 하/였/다)', defaultAnnotation);
    if (annotation === null) return;
    cut.type = 'blue';
    cut.annotation = annotation;
  } else if (choice.trim() === '3') {
    const defaultAnnotation = cut.type === 'gray' ? cut.annotation : (suggestion && suggestion.type === 'gray' ? suggestedAnnotation : '');
    const annotation = window.prompt('어원을 입력하세요 (예: 집/웅)', defaultAnnotation);
    if (annotation === null) return;
    cut.type = 'gray';
    cut.annotation = annotation;
  } else {
    cut.type = 'red';
    cut.annotation = '';
  }

  // 이 판정을 테이블에 등록 -> 같은 절단(경계 양옆 두 글자)이 다시 나오면 "제시"됨(자동 적용 아님)
  wordTable[key] = { type: cut.type, annotation: cut.annotation };
  saveWordTable(wordTable);

  renderBoard(currentIndex);
}

function toggleException(startChar, endChar) {
  if (currentIndex < 0 || !sentences[currentIndex]) return;
  const range = { start: Math.min(startChar, endChar), end: Math.max(startChar, endChar) };
  const exceptions = exceptionsBySentence[currentIndex] || [];
  exceptionsBySentence[currentIndex] = exceptions;

  const existingIdx = exceptions.findIndex(r => r.start === range.start && r.end === range.end);
  if (existingIdx !== -1) {
    exceptions.splice(existingIdx, 1);
  } else {
    const cuts = cutsBySentence[currentIndex];
    if (cuts) {
      for (let b = range.start; b < range.end; b++) cuts.delete(b);
    }
    exceptions.push(range);
  }
  renderBoard(currentIndex);
}

function selectSentence(i) {
  currentIndex = i;
  cursorChar = 0;
  selectionAnchorChar = null;
  renderPrevSentence(i - 1);
  renderBoard(i);
  nextSentenceText.textContent = sentences[i + 1] || '';
  sentenceList.querySelectorAll('.sentence').forEach(el => {
    el.classList.toggle('current', Number(el.dataset.idx) === i);
  });
}

function advanceSentence() {
  if (currentIndex < 0 || currentIndex >= sentences.length) return;

  completedIndices.add(currentIndex);
  renderSplitText();

  const rectPrevOld = prevBox.getBoundingClientRect();
  const rectCurrentOld = boardBox.getBoundingClientRect();
  const rectNextOld = nextBox.getBoundingClientRect();

  selectSentence(currentIndex + 1);

  // prevBox now shows what boardBox used to show -> make it appear where boardBox was, then let it settle back.
  const deltaPrev = rectCurrentOld.top - rectPrevOld.top;
  // boardBox now shows what nextBox used to show -> make it appear where nextBox was, then let it settle back.
  const deltaCurrent = rectNextOld.top - rectCurrentOld.top;

  [prevBox, boardBox, nextBox].forEach(el => { el.style.transition = 'none'; });
  prevBox.style.transform = `translateY(${deltaPrev}px)`;
  boardBox.style.transform = `translateY(${deltaCurrent}px)`;
  nextBox.style.transform = 'translateY(24px)';
  nextBox.style.opacity = '0';

  // force reflow so the jump above applies before the transition is restored
  void prevBox.offsetHeight;

  requestAnimationFrame(() => {
    [prevBox, boardBox, nextBox].forEach(el => { el.style.transition = ''; });
    prevBox.style.transform = '';
    boardBox.style.transform = '';
    nextBox.style.transform = '';
    nextBox.style.opacity = '';
  });
}

function showPasteMode() {
  pasteArea.hidden = false;
  sentenceList.hidden = true;
  fullTextActions.hidden = true;
  pasteArea.focus();
}

function showSentenceMode() {
  pasteArea.hidden = true;
  sentenceList.hidden = false;
  fullTextActions.hidden = false;
}

function loadText(text) {
  sentences = splitSentences(text);
  currentIndex = -1;
  cursorChar = 0;
  selectionAnchorChar = null;
  Object.keys(cutsBySentence).forEach(key => delete cutsBySentence[key]);
  Object.keys(exceptionsBySentence).forEach(key => delete exceptionsBySentence[key]);
  completedIndices.clear();
  renderSentenceList();
  renderSplitText();
  showSentenceMode();
}

pasteArea.addEventListener('input', () => {
  const text = pasteArea.value.trim();
  if (!text) return;
  loadText(text);
});

rePasteBtn.addEventListener('click', () => {
  pasteArea.value = sentences.join(' ');
  showPasteMode();
});

spellcheckBtn.addEventListener('click', async () => {
  const text = sentences.join(' ');
  if (!text) return;
  const originalLabel = spellcheckBtn.textContent;
  spellcheckBtn.disabled = true;
  spellcheckBtn.textContent = '교정 중…';
  try {
    const res = await fetch('https://intpdiary.duckdns.org/api/morpheme/spellcheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('spellcheck request failed');
    const data = await res.json();
    if (!data.corrections || data.corrections.length === 0) {
      window.alert('고칠 곳을 찾지 못했습니다.');
    } else {
      loadText(data.corrected);
    }
  } catch (err) {
    window.alert('맞춤법 교정 요청에 실패했습니다.');
  } finally {
    spellcheckBtn.disabled = false;
    spellcheckBtn.textContent = originalLabel;
  }
});

clearBtn.addEventListener('click', () => {
  sentences = [];
  currentIndex = -1;
  cursorChar = 0;
  selectionAnchorChar = null;
  pasteArea.value = '';
  sentenceList.innerHTML = '';
  Object.keys(cutsBySentence).forEach(key => delete cutsBySentence[key]);
  Object.keys(exceptionsBySentence).forEach(key => delete exceptionsBySentence[key]);
  completedIndices.clear();
  prevSentenceText.textContent = DEFAULT_PREV_TEXT;
  boardText.textContent = DEFAULT_BOARD_TEXT;
  nextSentenceText.textContent = DEFAULT_NEXT_TEXT;
  splitText.classList.add('empty');
  splitText.textContent = DEFAULT_SPLIT_TEXT;
  answerRequestId++;
  answerBox.classList.add('empty');
  answerBox.textContent = DEFAULT_ANSWER_TEXT;
  showPasteMode();
});

// 예외 표시는 이제 Shift+방향키+스페이스(키보드) 전용. 마우스 드래그로는 만들지 않는다.
boardText.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

boardText.addEventListener('click', (e) => {
  const gap = e.target.closest('.gap');
  if (gap) registerCutType(Number(gap.dataset.boundary));
});

function moveCursor(direction, extendSelection) {
  if (currentIndex < 0 || !sentences[currentIndex]) return;
  const chars = Array.from(sentences[currentIndex]);
  const blocks = getBlocks(chars, exceptionsBySentence[currentIndex] || []);
  const positions = [0, ...blocks.map(b => b.end + 1)];
  let posIdx = positions.indexOf(cursorChar);
  if (posIdx === -1) posIdx = 0;
  posIdx = direction > 0 ? Math.min(posIdx + 1, positions.length - 1) : Math.max(posIdx - 1, 0);

  if (extendSelection) {
    if (selectionAnchorChar === null) selectionAnchorChar = cursorChar;
  } else {
    selectionAnchorChar = null;
  }
  cursorChar = positions[posIdx];
  renderBoard(currentIndex);
}

function handleSpace() {
  if (currentIndex < 0 || !sentences[currentIndex]) return;
  if (selectionAnchorChar !== null && selectionAnchorChar !== cursorChar) {
    const start = Math.min(selectionAnchorChar, cursorChar);
    const end = Math.max(selectionAnchorChar, cursorChar) - 1;
    selectionAnchorChar = null;
    toggleException(start, end);
  } else {
    const chars = Array.from(sentences[currentIndex]);
    if (cursorChar > 0 && cursorChar < chars.length) {
      toggleCut(cursorChar - 1);
    }
  }
}

function handleBackspace() {
  if (currentIndex < 0 || !sentences[currentIndex]) return;
  const exceptions = exceptionsBySentence[currentIndex] || [];
  const exc = exceptions.find(r => r.end === cursorChar - 1);
  if (exc) {
    const idx = exceptions.indexOf(exc);
    exceptions.splice(idx, 1);
    cursorChar = exc.start;
    renderBoard(currentIndex);
    return;
  }
  const cuts = cutsBySentence[currentIndex];
  const boundary = cursorChar - 1;
  if (cuts && cuts.has(boundary)) {
    cuts.delete(boundary);
    renderBoard(currentIndex);
  }
}

document.addEventListener('keydown', (e) => {
  if (document.activeElement === pasteArea) return;

  if (e.key === 'Enter') {
    advanceSentence();
    return;
  }
  if (currentIndex < 0 || !sentences[currentIndex]) return;

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    moveCursor(1, e.shiftKey);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    moveCursor(-1, e.shiftKey);
  } else if (e.key === ' ') {
    e.preventDefault();
    handleSpace();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    handleBackspace();
  }
});
