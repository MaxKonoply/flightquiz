/*
  FlightQuiz: полностью статический квиз.
  Данные автора сохраняются в localStorage.
  При отправке квиз сжимается и помещается в ?quiz=... адреса страницы.
  Короткие ссылки создаются через публичный API is.gd; если API недоступен,
  остаётся полная ссылка. Старые ссылки с #quiz= по-прежнему открываются.
  Для работы на GitHub Pages не нужен собственный сервер или API-ключ.
*/
(() => {
  'use strict';

  const STORAGE_KEY = 'flightquiz.editor.v1';
  const MAX_QUESTIONS = 24;
  const MAX_ANSWERS = 40;
  const app = document.getElementById('app');
  const hero = document.getElementById('hero');
  const homeButton = document.getElementById('homeButton');
  const toastEl = document.getElementById('toast');
  let toastTimer;

  const state = {
    mode: 'builder',
    editor: loadEditor(),
    selected: 0,
    bankIndex: 0,
    shareUrl: '',
    fullShareUrl: '',
    shareNote: '',
    shareBusy: false,
    playQuiz: null,
    preview: false,
    step: 0,
    guesses: [],
    guestError: ''
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function plain(value, max = 200) {
    return String(value ?? '').trim().slice(0, max);
  }

  function createFromBank(index) {
    const entry = QUESTION_BANK[index];
    return {
      text: entry.question,
      answers: entry.answers.map((text, idx) => ({text, weight: DEFAULT_WEIGHTS[idx] ?? 1})),
      right: {type: 'preset', index: 0}
    };
  }

  function freshEditor() {
    return {
      title: 'Насколько хорошо ты меня знаешь?',
      questions: STARTER_QUESTION_INDICES.map(createFromBank)
    };
  }

  function normalizeEditor(raw) {
    if (!raw || !Array.isArray(raw.questions) || !raw.questions.length) return null;
    const questions = raw.questions.slice(0, MAX_QUESTIONS).map(q => {
      const answers = Array.isArray(q.answers) ? q.answers.slice(0, MAX_ANSWERS).map(a => ({
        text: plain(a.text, 160),
        weight: Math.max(0, Math.min(999, Number(a.weight) || 0))
      })) : [];
      if (answers.length === 0) answers.push({text: 'Да', weight: 1});
      const custom = q.right && q.right.type === 'custom';
      return {
        text: plain(q.text, 220),
        answers,
        right: custom
          ? {type: 'custom', text: plain(q.right.text, 160)}
          : {type: 'preset', index: Math.max(0, Math.min(answers.length - 1, Number(q.right?.index) || 0))}
      };
    });
    return {title: plain(raw.title, 100) || 'Мой квиз для друзей', questions};
  }

  function loadEditor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeEditor(JSON.parse(raw)) || freshEditor();
    } catch (e) { console.warn('Не удалось прочитать сохранённые вопросы', e); }
    return freshEditor();
  }

  function saveEditor() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.editor)); }
    catch (e) { console.warn('Браузер не разрешает локальное сохранение', e); }
  }

  function toast(message) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add('visible');
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 3100);
  }

  function sourceUrl() {
    // Не переносим старые параметры ?quiz= и #quiz= в новые ссылки.
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    return url.href;
  }

  // Кэш не даёт заново обращаться к сокращателю при повторном нажатии.
  const shortLinkCache = new Map();

  function probPct(answers, index) {
    const total = answers.reduce((sum, a) => sum + Math.max(0, Number(a.weight) || 0), 0);
    if (total <= 0) return Math.round(100 / Math.max(1, answers.length));
    return Math.round(1000 * Math.max(0, Number(answers[index]?.weight) || 0) / total) / 10;
  }

  function sortedAnswers(question) {
    return question.answers.map((answer, index) => ({...answer, index}))
      .sort((a, b) => b.weight - a.weight || a.index - b.index);
  }

  function correctText(q) {
    return q.right?.type === 'custom'
      ? plain(q.right.text, 160)
      : plain(q.answers[q.right?.index ?? 0]?.text, 160);
  }

  function validateEditor() {
    if (!state.editor.title.trim()) return 'Введи название квиза.';
    if (!state.editor.questions.length) return 'Добавь хотя бы один вопрос.';
    for (let i = 0; i < state.editor.questions.length; i++) {
      const q = state.editor.questions[i];
      if (!q.text.trim()) return `У вопроса №${i + 1} нет текста.`;
      if (q.answers.filter(a => a.text.trim()).length < 2) return `Для вопроса №${i + 1} нужны хотя бы 2 варианта.`;
      if (!correctText(q)) return `Выбери свой ответ для вопроса №${i + 1}.`;
    }
    return '';
  }

  function snapshot() {
    return {
      title: state.editor.title.trim(),
      questions: state.editor.questions.map(q => ({
        text: q.text.trim(),
        answers: sortedAnswers(q).filter(a => a.text.trim()).map(a => ({text: a.text.trim(), weight: a.weight})),
        correct: correctText(q)
      }))
    };
  }

  function render() {
    const isGuest = state.mode !== 'builder';
    hero.classList.toggle('hide', isGuest);
    homeButton.classList.toggle('hide', state.mode === 'builder');
    switch (state.mode) {
      case 'builder': app.innerHTML = renderBuilder(); break;
      case 'intro': app.innerHTML = renderIntro(); break;
      case 'play': app.innerHTML = renderPlay(); break;
      case 'results': app.innerHTML = renderResults(); break;
      case 'error': app.innerHTML = renderError(); break;
    }
  }

  function renderBuilder() {
    const editor = state.editor;
    state.selected = Math.min(Math.max(state.selected, 0), editor.questions.length - 1);
    const selected = editor.questions[state.selected];
    const totalOptions = editor.questions.reduce((sum, q) => sum + q.answers.length, 0);
    return `
      <div class="workspace">
        <aside class="panel sidebar">
          <div class="panel-head"><div><div class="section-label">ТВОЯ КОЛЛЕКЦИЯ</div><h2>Мои вопросы</h2></div><span class="badge-count">${editor.questions.length}/${MAX_QUESTIONS}</span></div>
          <p class="helper">Нажми на вопрос, чтобы изменить его варианты и свой ответ.</p>
          <div class="question-list" role="list" aria-label="Вопросы квиза">
            ${editor.questions.map((q, idx) => `<button role="listitem" type="button" class="question-item ${idx === state.selected ? 'is-selected' : ''}" data-action="select-question" data-index="${idx}">
              <span class="question-index">${idx + 1}</span><span class="question-item-body"><span class="question-title" data-sidebar-title="${idx}">${esc(q.text || 'Новый вопрос')}</span><span class="question-item-sub">${q.answers.length} вариантов ответа</span></span>
            </button>`).join('')}
          </div>
          <div class="sidebar-divider"></div>
          <div class="stack"><label class="field-label" for="bankSelect">Добавить вопрос из списка</label>
            <select class="select" id="bankSelect" data-role="bank-select">${QUESTION_BANK.map((q, idx) => `<option value="${idx}" ${state.bankIndex === idx ? 'selected' : ''}>${esc(q.question)}</option>`).join('')}</select>
            <button type="button" class="button button--secondary button--wide" data-action="add-bank">+ Добавить из списка</button>
            <button type="button" class="button button--ghost button--wide" data-action="add-custom">+ Придумать свой вопрос</button>
          </div>
          <div class="sidebar-divider"></div>
          <div class="file-buttons"><button type="button" class="button button--ghost button--small" data-action="export">↓ JSON</button><button type="button" class="button button--ghost button--small" data-action="import">↑ JSON</button><button type="button" class="button button--danger button--small" data-action="reset">Сброс</button></div>
          <input class="upload-hidden" id="importFile" type="file" accept=".json,application/json" data-role="import-file" />
        </aside>
        <div class="builder-main">
          <section class="panel editor">
            <div class="editor-top"><div><div class="section-label">РЕДАКТОР ВОПРОСА</div><h2>Вопрос ${state.selected + 1} <span class="muted">/ ${editor.questions.length}</span></h2></div>
              <div class="editor-top-actions"><button class="button button--secondary button--small" type="button" data-action="move-up" title="Переместить вопрос выше" ${state.selected === 0 ? 'disabled' : ''}>↑</button>
              <button class="button button--secondary button--small" type="button" data-action="move-down" title="Переместить вопрос ниже" ${state.selected === editor.questions.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="button button--danger button--small" type="button" data-action="delete-question" title="Удалить вопрос">Удалить</button></div></div>
            <label class="field-label" for="questionText">Текст вопроса</label>
            <textarea id="questionText" data-role="question-text" maxlength="220" class="textarea" placeholder="Например: куда я поеду летом?">${esc(selected.text)}</textarea>
            <div class="answer-toolbar"><div><h3>Варианты ответов</h3><p class="helper">Выбери <b>✓</b> рядом с правильным ответом. Больший вес = выше вероятность.</p></div><span class="badge-count">${selected.answers.length} шт.</span></div>
            <div class="answer-list">${sortedAnswers(selected).map(a => renderAnswerRow(a, selected)).join('')}</div>
            <div class="row-actions"><button class="button button--secondary button--small" data-action="add-answer" type="button">+ Добавить ответ</button>
              <button class="button button--ghost button--small" data-action="random-answer" type="button">🎲 Выбрать ответ по весам</button></div>
            <div class="custom-answer">
              <div class="custom-answer-top"><button type="button" class="choice-button ${selected.right.type === 'custom' ? 'is-correct' : ''}" data-action="select-custom" aria-label="Выбрать свой ответ">${selected.right.type === 'custom' ? '✓' : '+'}</button><div><strong>Мой вариант ответа</strong><div class="helper">Можно написать ответ, которого нет в списке.</div></div></div>
              <input class="input" maxlength="160" data-role="custom-answer" aria-label="Собственный правильный ответ" placeholder="Впиши свой правильный ответ..." value="${esc(selected.right.type === 'custom' ? selected.right.text : '')}" />
            </div>
            <div class="tip">Вес — относительное число. Например, веса 70 и 30 дают вероятность 70% и 30%. Если ответов много, проценты рассчитываются от суммы всех весов. Это твои настройки, а не статистика людей.</div>
          </section>
          <section class="panel bottom-panel"><div class="bottom-panel-head"><div><div class="section-label">ПОЧТИ ГОТОВО</div><h3>Отправь тест друзьям</h3></div><span class="badge-count">✦ готово к игре</span></div>
            <label class="field-label" for="quizTitle">Название теста</label><input class="input" id="quizTitle" maxlength="100" data-role="quiz-title" value="${esc(editor.title)}" />
            <div class="stats-mini"><span><b>${editor.questions.length}</b> вопросов</span><span><b>${totalOptions}</b> вариантов</span><span><b>${QUESTION_BANK.length}</b> идей в банке</span></div>
            <div class="bottom-actions"><button type="button" class="button" data-action="share" ${state.shareBusy ? 'disabled' : ''}>${state.shareBusy ? 'Создаю короткую ссылку…' : '↗ Создать короткую ссылку'}</button><button type="button" class="button button--secondary" data-action="preview">Посмотреть как игрок</button></div>
            ${state.shareUrl ? `<div class="share-output"><div class="field-label confirm-note">${esc(state.shareNote || 'Ссылка готова — отправь её друзьям:')}</div><div class="share-url" tabindex="0">${esc(state.shareUrl)}</div><button class="button button--ghost button--small" type="button" data-action="copy-share">Скопировать ссылку</button>${state.fullShareUrl && state.fullShareUrl !== state.shareUrl ? '<button class="button button--ghost button--small" type="button" data-action="copy-full-share">Скопировать полную ссылку</button>' : ''}</div>` : ''}
            <div class="tip">Сайт работает на GitHub Pages без базы данных. Данные квиза упакованы в ссылку, а для её сокращения используется is.gd. Если сервис недоступен, можно скопировать полную ссылку. Результаты друзья увидят у себя на экране.</div>
          </section>
        </div>
      </div>`;
  }

  function renderAnswerRow(a, q) {
    const selected = q.right.type === 'preset' && q.right.index === a.index;
    const pct = probPct(q.answers, a.index);
    return `<div class="answer-row ${selected ? 'is-correct' : ''}" data-answer-index="${a.index}">
      <button type="button" class="choice-button ${selected ? 'is-correct' : ''}" data-action="select-answer" data-index="${a.index}" title="Назначить своим правильным ответом" aria-label="Выбрать ответ №${a.index + 1}">${selected ? '✓' : '+'}</button>
      <div class="answer-right"><input class="input answer-input" type="text" maxlength="160" data-role="answer-text" data-index="${a.index}" aria-label="Текст ответа №${a.index + 1}" placeholder="Напиши вариант..." value="${esc(a.text)}" />
        <div class="answer-meta"><span data-prob-index="${a.index}">${pct}% условный шанс</span><span class="prob-track"><span class="prob-fill" data-prob-fill="${a.index}" style="display:block;width:${pct}%"></span></span></div></div>
      <input class="input weight-field" type="number" min="0" max="999" step="1" data-role="weight" data-index="${a.index}" title="Вес ответа" aria-label="Вес ответа №${a.index + 1}" value="${a.weight}" />
      <button type="button" class="button button--ghost button--round" data-action="delete-answer" data-index="${a.index}" aria-label="Удалить ответ №${a.index + 1}" title="Удалить ответ">×</button>
    </div>`;
  }

  function renderIntro() {
    const quiz = state.playQuiz;
    return `<div class="intro-wrap"><section class="panel center-panel">
      <div class="center-badge">✈</div><div class="section-label">ТЕСТ НА ДРУЖБУ</div><h2>${esc(quiz.title)}</h2>
      <p>Тебя ждёт ${quiz.questions.length} вопросов. Попробуй угадать ответы автора и узнай, насколько хорошо вы знаете друг друга!</p>
      <div class="center-meta"><span>✦ ${quiz.questions.length} вопросов</span><span>✦ ${quiz.questions.reduce((sum, q) => sum + q.answers.length, 0)} вариантов</span><span>✦ Результат в конце</span></div>
      <div class="center-buttons"><button type="button" class="button" data-action="start-play">Начать квиз →</button><button type="button" class="button button--secondary" data-action="go-home">Создать свой</button></div>
      ${state.preview ? '<p class="helper" style="margin-top:16px">Это предварительный просмотр. Ответы никому не отправляются.</p>' : ''}
    </section></div>`;
  }

  function renderPlay() {
    const quiz = state.playQuiz;
    const q = quiz.questions[state.step];
    const selected = state.guesses[state.step];
    const sorted = q.answers.map((a, idx) => ({...a, idx})).sort((a, b) => b.weight - a.weight || a.idx - b.idx);
    return `<div class="play-wrap"><section class="panel play-panel">
      <div class="progress-header"><span>ВОПРОС <strong>${state.step + 1}</strong> ИЗ <strong>${quiz.questions.length}</strong></span><span>${Math.round((state.step + 1) / quiz.questions.length * 100)}%</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${(state.step + 1) / quiz.questions.length * 100}%"></div></div>
      <h2 class="play-question">${esc(q.text)}</h2><p class="play-hint">Выбери ответ или впиши свой вариант. Проценты — условные веса, заданные автором.</p>
      <div class="guess-grid">${sorted.map(a => {
        const isChosen = selected?.type === 'preset' && selected.index === a.idx;
        return `<button type="button" class="guess-option ${isChosen ? 'selected' : ''}" data-action="choose-guess" data-index="${a.idx}">
          <span class="option-radio"></span><span>${esc(a.text)}</span><span class="option-prob">${probPct(q.answers, a.idx)}%</span></button>`;
      }).join('')}</div>
      <div class="guess-custom"><button type="button" class="guess-option ${selected?.type === 'custom' ? 'selected' : ''}" data-action="choose-custom"><span class="option-radio"></span>Мой вариант ответа</button>
        ${selected?.type === 'custom' ? `<input class="input guess-custom-input" data-role="guess-custom-input" maxlength="160" placeholder="Напиши свой ответ..." aria-label="Свой вариант ответа" value="${esc(selected.text)}" />` : ''}</div>
      <div class="play-actions"><button type="button" class="button button--ghost" data-action="prev-step" ${state.step === 0 ? 'disabled' : ''}>← Назад</button>
        <button type="button" class="button" id="nextStep" data-action="next-step" ${!guessText(selected, q) ? 'disabled' : ''}>${state.step + 1 === quiz.questions.length ? 'Посмотреть результат' : 'Далее →'}</button></div>
    </section></div>`;
  }

  function guessText(guess, q) {
    if (!guess) return '';
    if (guess.type === 'custom') return String(guess.text || '').trim();
    return String(q.answers[guess.index]?.text || '').trim();
  }

  function canonical(text) {
    return String(text ?? '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  }

  function getResults() {
    const quiz = state.playQuiz;
    const details = quiz.questions.map((q, idx) => {
      const answer = guessText(state.guesses[idx], q);
      const ok = !!answer && canonical(answer) === canonical(q.correct);
      return {question: q.text, correct: q.correct, answer: answer || 'Нет ответа', ok};
    });
    const correct = details.filter(d => d.ok).length;
    const pct = Math.round(correct / quiz.questions.length * 100);
    let rank = 'Фейковый друг 🤡';
    let caption = 'Похоже, впереди ещё много интересных открытий друг о друге.';
    if (pct >= 90) {rank = 'Настоящий бестик 👑'; caption = 'Это почти телепатия. Ты знаешь автора лучше остальных!';}
    else if (pct >= 65) {rank = 'Почти бестик ✨'; caption = 'Очень достойно! Ты хорошо знаешь автора.';}
    else if (pct >= 40) {rank = 'Свой человек 💜'; caption = 'Хорошее начало. Осталось узнать ещё пару секретов.';}
    return {details, correct, pct, rank, caption};
  }

  function renderResults() {
    const result = getResults();
    return `<div class="result-wrap"><section class="panel center-panel">
      <div class="center-badge">🏆</div><div class="section-label">ТВОЙ РЕЗУЛЬТАТ</div><div class="score-number">${result.correct}<span> / ${state.playQuiz.questions.length}</span></div>
      <h2 class="result-title">${esc(result.rank)}</h2><p class="result-subtitle">${esc(result.caption)}</p>
      <div class="center-meta"><span>${result.pct}% правильных ответов</span><span>${state.playQuiz.questions.length} вопросов</span></div>
      <div class="center-buttons"><button type="button" class="button" data-action="copy-result">Поделиться результатом</button><button type="button" class="button button--secondary" data-action="restart-play">Пройти ещё раз</button><button type="button" class="button button--ghost" data-action="go-home">Сделать свой квиз</button></div>
      <div class="review"><h3>Разбор ответов</h3>${result.details.map((d, idx) => `<div class="review-item"><span class="review-icon ${d.ok ? 'ok' : ''}">${d.ok ? '✓' : '×'}</span><div>
        <div class="review-q">${idx + 1}. ${esc(d.question)}</div><div class="review-a">Твой ответ: <strong>${esc(d.answer)}</strong></div>
        ${d.ok ? '' : `<div class="review-a">Ответ автора: <strong>${esc(d.correct)}</strong></div>`}</div></div>`).join('')}</div>
    </section></div>`;
  }

  function renderError() {
    return `<div class="panel center-panel not-found"><div class="center-badge">!</div><h2>Не получилось открыть квиз</h2><p>${esc(state.guestError || 'Ссылка повреждена или неполная.')}</p>
      <button class="button" data-action="go-home" type="button">Создать свой квиз</button></div>`;
  }

  function scrollApp() {
    app.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  function changeBuilder() {
    state.shareUrl = '';
    saveEditor();
    render();
  }

  function changeQuestion(delta) {
    const from = state.selected;
    const to = from + delta;
    if (to < 0 || to >= state.editor.questions.length) return;
    [state.editor.questions[from], state.editor.questions[to]] = [state.editor.questions[to], state.editor.questions[from]];
    state.selected = to;
    changeBuilder();
  }

  function addQuestion(index) {
    if (state.editor.questions.length >= MAX_QUESTIONS) return toast(`Максимум ${MAX_QUESTIONS} вопроса.`);
    const q = typeof index === 'number' ? createFromBank(index) : {
      text: '', answers: ['Да', 'Нет', 'Возможно', 'Не знаю'].map((text, i) => ({text, weight: [40, 30, 20, 10][i]})),
      right: {type: 'preset', index: 0}
    };
    state.editor.questions.push(q);
    state.selected = state.editor.questions.length - 1;
    changeBuilder();
    if (typeof index !== 'number') document.getElementById('questionText')?.focus();
    toast('Вопрос добавлен');
  }

  function weightedRandomIndex(q) {
    const valid = q.answers.map((answer, index) => ({index, weight: Math.max(0, Number(answer.weight) || 0)}))
      .filter(item => q.answers[item.index].text.trim());
    if (!valid.length) return 0;
    const total = valid.reduce((sum, a) => sum + a.weight, 0);
    if (!total) return valid[Math.floor(Math.random() * valid.length)].index;
    let n = Math.random() * total;
    for (const a of valid) {n -= a.weight; if (n < 0) return a.index;}
    return valid[valid.length - 1].index;
  }

  // Unicode-safe base64url. No libraries or network requests.
  function base64url(bytes) {
    let raw = '';
    for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function unbase64url(text) {
    let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob(b64);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function encodeQuiz(quiz) {
    // Short keys save space; questions are [question, [[answer, weight]], correct].
    const value = {v: 1, t: quiz.title, q: quiz.questions.map(q => [q.text, q.answers.map(a => [a.text, a.weight]), q.correct])};
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined') {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
      const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
      return 'g' + base64url(zipped);
    }
    return 'b' + base64url(bytes);
  }

  async function decodeQuiz(encoded) {
    if (!encoded || encoded.length > 100000) throw new Error('Ссылка слишком длинная.');
    let bytes = unbase64url(encoded.slice(1));
    if (encoded[0] === 'g') {
      if (typeof DecompressionStream === 'undefined') throw new Error('Этот браузер не поддерживает распаковку ссылки. Открой ссылку в новой версии браузера.');
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (encoded[0] !== 'b') throw new Error('Неизвестный формат ссылки.');
    if (bytes.length > 180000) throw new Error('Слишком много данных в ссылке.');
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed.v !== 1 || !Array.isArray(parsed.q) || !parsed.q.length || parsed.q.length > MAX_QUESTIONS) throw new Error('Некорректные вопросы.');
    const questions = parsed.q.map(row => {
      if (!Array.isArray(row) || row.length !== 3 || !Array.isArray(row[1]) || row[1].length < 2 || row[1].length > MAX_ANSWERS) throw new Error('Некорректные ответы в ссылке.');
      const text = plain(row[0], 220);
      const correct = plain(row[2], 160);
      const answers = row[1].map(a => ({text: plain(a[0], 160), weight: Math.max(0, Math.min(999, Number(a[1]) || 0))}));
      if (!text || !correct || answers.some(a => !a.text)) throw new Error('Некорректные тексты в ссылке.');
      return {text, correct, answers};
    });
    return {title: plain(parsed.t, 100) || 'Мой квиз', questions};
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const field = document.createElement('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      return copied;
    } catch (e) {return false;}
  }

  async function shortenLink(longUrl) {
    if (shortLinkCache.has(longUrl)) return shortLinkCache.get(longUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      // Полная ссылка передаётся сервису целиком, включая параметр ?quiz=.
      const endpoint = `https://is.gd/create.php?format=json&url=${encodeURIComponent(longUrl)}`;
      const response = await fetch(endpoint, {signal: controller.signal});
      if (!response.ok) throw new Error(`is.gd: HTTP ${response.status}`);
      const data = await response.json();
      if (typeof data.shorturl !== 'string' || !/^https:\/\/is\.gd\/[a-zA-Z0-9_-]+$/.test(data.shorturl)) {
        throw new Error(data.errormessage || 'Не удалось сократить ссылку');
      }
      shortLinkCache.set(longUrl, data.shorturl);
      return data.shorturl;
    } catch (error) {
      console.warn('Сокращатель ссылок недоступен', error);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function makeShareLink() {
    if (state.shareBusy) return;
    const error = validateEditor();
    if (error) return toast(error);
    state.shareBusy = true;
    render();
    try {
      const encoded = await encodeQuiz(snapshot());
      // Параметры ?... сохраняются при переходе через сокращатели ссылок.
      // Раньше здесь был #quiz=, который в goo.su терялся.
      const longUrl = `${sourceUrl()}?quiz=${encoded}`;
      const shortUrl = await shortenLink(longUrl);
      state.fullShareUrl = longUrl;
      state.shareUrl = shortUrl || longUrl;
      state.shareNote = shortUrl
        ? 'Короткая ссылка готова — отправь её друзьям:'
        : 'Сокращатель сейчас недоступен. Ниже полная рабочая ссылка:';
      if (await copyText(state.shareUrl)) toast(shortUrl ? 'Короткая ссылка скопирована!' : 'Полная ссылка скопирована!');
      else toast('Ссылка готова — скопируй её из блока ниже.');
    } catch (error) {
      console.error(error);
      toast('Не удалось создать ссылку. Попробуй обновить браузер.');
    } finally {
      state.shareBusy = false;
      render();
    }
  }

  function startPreview() {
    const error = validateEditor();
    if (error) return toast(error);
    state.playQuiz = snapshot();
    state.preview = true;
    state.guesses = [];
    state.step = 0;
    state.mode = 'intro';
    render();
    scrollApp();
  }

  function goHome() {
    history.replaceState(null, '', sourceUrl());
    state.mode = 'builder';
    state.preview = false;
    state.playQuiz = null;
    state.guestError = '';
    render();
    window.scrollTo({top: 0, behavior: 'smooth'});
  }

  function exportFile() {
    const contents = JSON.stringify(state.editor, null, 2);
    const blob = new Blob([contents], {type: 'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'flightquiz-questions.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('JSON с вопросами скачан');
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > 500000) return toast('Файл слишком большой (максимум 500 КБ).');
    try {
      const loaded = normalizeEditor(JSON.parse(await file.text()));
      if (!loaded) return toast('В файле нет вопросов.');
      state.editor = loaded;
      state.selected = 0;
      changeBuilder();
      toast('Вопросы импортированы');
    } catch (e) {toast('Не удалось открыть JSON с вопросами.');}
  }

  function deleteAnswer(idx) {
    const q = state.editor.questions[state.selected];
    if (q.answers.length <= 2) return toast('Нужно минимум два варианта ответа.');
    q.answers.splice(idx, 1);
    if (q.right.type === 'preset') {
      if (q.right.index === idx) q.right.index = 0;
      else if (q.right.index > idx) q.right.index--;
    }
    changeBuilder();
  }

  app.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button || !app.contains(button)) return;
    const action = button.dataset.action;
    const idx = Number(button.dataset.index);
    const q = state.editor.questions[state.selected];
    switch (action) {
      case 'select-question': state.selected = idx; render(); break;
      case 'add-bank': addQuestion(state.bankIndex); break;
      case 'add-custom': addQuestion(); break;
      case 'move-up': changeQuestion(-1); break;
      case 'move-down': changeQuestion(1); break;
      case 'delete-question':
        if (state.editor.questions.length === 1) return toast('Нужно оставить хотя бы один вопрос.');
        state.editor.questions.splice(state.selected, 1); state.selected = Math.max(0, state.selected - 1); changeBuilder(); break;
      case 'select-answer': q.right = {type: 'preset', index: idx}; changeBuilder(); break;
      case 'select-custom': q.right = {type: 'custom', text: q.right.type === 'custom' ? q.right.text : ''}; changeBuilder(); document.querySelector('[data-role="custom-answer"]')?.focus(); break;
      case 'add-answer':
        if (q.answers.length >= MAX_ANSWERS) return toast(`Максимум ${MAX_ANSWERS} ответов на вопрос.`);
        q.answers.push({text: '', weight: 1}); changeBuilder();
        document.querySelector(`[data-role="answer-text"][data-index="${q.answers.length - 1}"]`)?.focus(); break;
      case 'delete-answer': deleteAnswer(idx); break;
      case 'random-answer': q.right = {type: 'preset', index: weightedRandomIndex(q)}; changeBuilder(); toast('Ответ выбран с учётом заданных весов'); break;
      case 'reset':
        if (!window.confirm('Сбросить все вопросы и ответы к исходным?')) break;
        state.editor = freshEditor(); state.selected = 0; changeBuilder(); toast('Исходный квиз восстановлен'); break;
      case 'export': exportFile(); break;
      case 'import': document.getElementById('importFile')?.click(); break;
      case 'share': makeShareLink(); break;
      case 'copy-share': copyText(state.shareUrl).then(ok => toast(ok ? 'Ссылка скопирована!' : 'Скопируй ссылку вручную из блока выше.')); break;
      case 'copy-full-share': copyText(state.fullShareUrl).then(ok => toast(ok ? 'Полная ссылка скопирована!' : 'Не получилось скопировать полную ссылку.')); break;
      case 'preview': startPreview(); break;
      case 'go-home': goHome(); break;
      case 'start-play': state.mode = 'play'; state.step = 0; state.guesses = []; render(); scrollApp(); break;
      case 'choose-guess': state.guesses[state.step] = {type: 'preset', index: idx}; render(); break;
      case 'choose-custom': state.guesses[state.step] = {type: 'custom', text: state.guesses[state.step]?.type === 'custom' ? state.guesses[state.step].text : ''}; render(); document.querySelector('[data-role="guess-custom-input"]')?.focus(); break;
      case 'prev-step': if (state.step > 0) {state.step--; render(); scrollApp();} break;
      case 'next-step':
        if (!guessText(state.guesses[state.step], state.playQuiz.questions[state.step])) return toast('Выбери или впиши ответ.');
        if (state.step + 1 >= state.playQuiz.questions.length) state.mode = 'results';
        else state.step++;
        render(); scrollApp(); break;
      case 'restart-play': state.mode = 'play'; state.step = 0; state.guesses = []; render(); scrollApp(); break;
      case 'copy-result': {
        const result = getResults();
        const text = `Я прошёл(ла) тест «${state.playQuiz.title}» и набрал(а) ${result.correct}/${state.playQuiz.questions.length} (${result.pct}%) — ${result.rank}!\n${state.preview ? '' : location.href}`;
        copyText(text).then(ok => toast(ok ? 'Результат скопирован!' : 'Не удалось скопировать текст.'));
        break;
      }
    }
  });

  app.addEventListener('input', event => {
    const node = event.target;
    const role = node.dataset.role;
    if (!role) return;
    if (state.mode === 'builder') {
      const q = state.editor.questions[state.selected];
      const idx = Number(node.dataset.index);
      if (role === 'question-text') {
        q.text = node.value.slice(0, 220);
        const title = app.querySelector(`[data-sidebar-title="${state.selected}"]`);
        if (title) title.textContent = q.text || 'Новый вопрос';
      } else if (role === 'answer-text') {
        q.answers[idx].text = node.value.slice(0, 160);
      } else if (role === 'weight') {
        q.answers[idx].weight = Math.max(0, Math.min(999, Number(node.value) || 0));
        for (const a of q.answers.map((a, idx) => idx)) {
          const percent = probPct(q.answers, a);
          const label = app.querySelector(`[data-prob-index="${a}"]`);
          const fill = app.querySelector(`[data-prob-fill="${a}"]`);
          if (label) label.textContent = `${percent}% условный шанс`;
          if (fill) fill.style.width = `${percent}%`;
        }
      } else if (role === 'custom-answer') {
        q.right = {type: 'custom', text: node.value.slice(0, 160)};
        const radio = app.querySelector('[data-action="select-custom"]');
        if (radio) {radio.classList.add('is-correct'); radio.textContent = '✓';}
        app.querySelectorAll('.answer-row.is-correct, [data-action="select-answer"].is-correct').forEach(el => el.classList.remove('is-correct'));
      } else if (role === 'quiz-title') {
        state.editor.title = node.value.slice(0, 100);
      } else return;
      state.shareUrl = '';
      saveEditor();
    } else if (state.mode === 'play') {
      if (role === 'guess-custom-input') {
        state.guesses[state.step] = {type: 'custom', text: node.value.slice(0, 160)};
        const next = document.getElementById('nextStep');
        if (next) next.disabled = !node.value.trim();
      } else if (role === 'filter-options') {
        const term = canonical(node.value);
        app.querySelectorAll('[data-option-search]').forEach(option => {option.hidden = !canonical(option.dataset.optionSearch).includes(term);});
      }
    }
  });

  app.addEventListener('change', event => {
    const node = event.target;
    if (node.dataset.role === 'bank-select') state.bankIndex = Number(node.value);
    if (node.dataset.role === 'import-file') importFile(node.files?.[0]);
    if (state.mode === 'builder' && node.dataset.role === 'weight') {
      // Sort DOM rows in place: re-rendering on blur would cancel a click on
      // the next button (e.g. «Создать ссылку»).
      const question = state.editor.questions[state.selected];
      const rows = Array.from(app.querySelectorAll('.answer-list > .answer-row'));
      const list = app.querySelector('.answer-list');
      rows.sort((a, b) => {
        const ai = Number(a.dataset.answerIndex);
        const bi = Number(b.dataset.answerIndex);
        return question.answers[bi].weight - question.answers[ai].weight || ai - bi;
      }).forEach(row => list.appendChild(row));
      saveEditor();
    }
  });

  async function readSharedQuiz() {
    // Поддерживаем и новый формат ?quiz=, и старый формат #quiz=.
    const encoded = new URLSearchParams(location.search).get('quiz') ||
      (location.hash.startsWith('#quiz=') ? location.hash.slice('#quiz='.length) : '');
    if (!encoded) {
      state.mode = 'builder';
      state.playQuiz = null;
      state.preview = false;
      render();
      return;
    }
    try {
      state.playQuiz = await decodeQuiz(encoded);
      state.preview = false;
      state.mode = 'intro';
      state.step = 0;
      state.guesses = [];
    } catch (error) {
      console.error('Неверная ссылка на квиз', error);
      state.guestError = error.message || 'Ссылка повреждена или неполная.';
      state.mode = 'error';
    }
    render();
  }

  homeButton.addEventListener('click', goHome);
  window.addEventListener('hashchange', readSharedQuiz);
  window.addEventListener('popstate', readSharedQuiz);
  readSharedQuiz();
})();
