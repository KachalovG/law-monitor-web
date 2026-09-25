const OWNER_DEFAULT = 'KachalovG/law-monitor-rf';
const WORKFLOW = 'web-monitor.yml';
const NAMES = { KPK: 'КПК', SKPK: 'СКПК', LOMBARD: 'ЛОМБАРДЫ', ZHKK: 'ЖНК' };
const SOURCE_NAMES = ['Pravo.gov.ru', 'Банк России', 'КонсультантПлюс'];
const SOURCE_URLS = { 'Pravo.gov.ru': 'https://publication.pravo.gov.ru/', 'Банк России': 'https://www.cbr.ru/analytics/na_vr/', 'КонсультантПлюс': 'https://www.consultant.ru/law/hotdocs/' };
const $ = (id) => document.getElementById(id);

let token = '';
let repo = OWNER_DEFAULT;
let report = null;
let mode = 'today';
let filter = 'ALL';
let activeRunId = null;
let pollTimer = null;
let polling = false;
let connectionVersion = 0;
let pollFailures = 0;
function rememberRun() {
  try { if (activeRunId) sessionStorage.setItem('law-monitor-run', JSON.stringify({ repo, id: String(activeRunId) })); else sessionStorage.removeItem('law-monitor-run'); } catch { /* optional recovery storage */ }
}
function restoreRun() {
  try { const saved = JSON.parse(sessionStorage.getItem('law-monitor-run') || 'null'); if (saved?.repo === repo && /^\d+$/.test(saved.id)) activeRunId = saved.id; } catch { /* invalid recovery data */ }
}
function setBusy(busy) {
  $('run-button').disabled = busy;
  $('run-button').firstChild.textContent = busy ? 'Проверка выполняется… ' : 'Запустить проверку ';
}

function moscowDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function displayDate(value) {
  if (!value) return '—';
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : /^\d{2}\.\d{2}\.\d{4}$/.test(value) ? `${value.slice(6)}-${value.slice(3, 5)}-${value.slice(0, 2)}` : null;
  if (!iso) return value;
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch { return null; }
}

function showNotice(message, type = 'info') {
  const node = $('notice');
  node.textContent = message;
  node.className = `notice${type === 'error' ? ' error' : ''}`;
}

function hideNotice() { $('notice').classList.add('hidden'); }

function apiPath(path) { return `https://api.github.com/repos/${repo}${path}`; }

async function api(url, options = {}) {
  if (!token) throw new Error('Сначала подключите репозиторий на вкладке «Подключение».');
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', ...(options.headers || {}) },
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(25000),
    });
  } catch { throw new Error('Нет соединения с GitHub API. Проверьте сеть и доступность GitHub.'); }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Токен GitHub недействителен или истёк.');
    if (response.status === 403) throw new Error('Недостаточно прав токена или превышен лимит GitHub API.');
    if (response.status === 404) throw new Error('Репозиторий, workflow или отчёт не найдены. Проверьте настройку.');
    throw new Error(`GitHub API вернул HTTP ${response.status}.`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function repoName(value) {
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) throw new Error('Укажите репозиторий как владелец/название.');
  return cleaned;
}

async function connect() {
  const candidate = $('token-input').value.trim();
  if (!candidate) throw new Error('Введите fine-grained токен GitHub.');
  const previous = token;
  const previousRepo = repo;
  token = candidate;
  try {
    repo = repoName($('repo-input').value);
    await api(apiPath(''));
    await api(apiPath(`/actions/workflows/${WORKFLOW}`));
    connectionVersion++;
    stopPolling(); activeRunId = null;
    $('token-input').value = '';
    $('connection-pill').innerHTML = '<i></i> Подключено';
    $('connection-pill').classList.add('connected');
    setManualLink();
    hideNotice();
    await refreshReport();
    restoreRun();
    if (activeRunId) { setBusy(true); startPolling(); }
    showView('overview');
  } catch (error) {
    token = previous;
    repo = previousRepo;
    throw error;
  }
}

function disconnect() {
  connectionVersion++;
  token = '';
  report = null;
  activeRunId = null;
  stopPolling();
  setBusy(false);
  $('token-input').value = '';
  $('connection-pill').innerHTML = '<i></i> Не подключено';
  $('connection-pill').classList.remove('connected');
  render();
  showNotice('Соединение закрыто. Токен удалён из памяти вкладки.');
}

function setManualLink() {
  const href = `https://github.com/${repo}/actions/workflows/${WORKFLOW}`;
  if (!activeRunId) $('run-link').href = href;
}

function selectedRange() {
  const today = moscowDate();
  if (mode === 'today') return { from_date: today, to_date: today, mode };
  const first = $('from-date').value;
  const last = mode === 'day' ? first : $('to-date').value;
  if (!first || !last) throw new Error('Укажите обе даты периода.');
  const a = new Date(`${first}T12:00:00Z`);
  const b = new Date(`${last}T12:00:00Z`);
  const current = new Date(`${today}T12:00:00Z`);
  if (a > b) throw new Error('Дата начала должна быть не позднее даты окончания.');
  if (b > current) throw new Error('Нельзя проверять будущие публикации.');
  if ((b - a) / 86400000 > 30) throw new Error('Максимум — 31 день включительно.');
  return { from_date: first, to_date: last, mode };
}

async function run() {
  if (activeRunId) throw new Error('Проверка уже выполняется. Дождитесь результата.');
  const dates = selectedRange();
  if (!token) { showView('settings'); throw new Error('Подключите GitHub на этой странице — затем запуск и результаты будут доступны прямо здесь.'); }
  const button = $('run-button');
  button.disabled = true;
  button.firstChild.textContent = 'Запускаю… ';
  try {
    const result = await api(apiPath(`/actions/workflows/${WORKFLOW}/dispatches`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { ...dates, send_telegram: String($('send-telegram').checked) } }),
    });
    activeRunId = result?.workflow_run_id || null;
    if (!activeRunId) throw new Error('GitHub принял запрос, но не вернул номер проверки. Не повторяйте запуск сразу: обновите данные через минуту.');
    rememberRun(); pollFailures = 0;
    if (result?.html_url) $('run-link').href = result.html_url;
    $('run-status').textContent = 'Проверка запущена';
    $('run-description').textContent = 'GitHub Actions обрабатывает публикации. Страница обновит результат автоматически.';
    $('status-indicator').textContent = 'В РАБОТЕ';
    $('status-indicator').className = 'status-indicator warn';
    showNotice('Проверка запущена. Можно оставить вкладку открытой: результат появится после завершения GitHub Actions.');
    startPolling();
  } finally {
    setBusy(!!activeRunId);
  }
}

function decodeContent(content) {
  const binary = atob(content.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

async function refreshReport(runId = null) {
  if (!token) return;
  const version = connectionVersion;
  try {
    const path = runId ? `data/web-reports/${encodeURIComponent(runId)}.json` : 'data/web-report.json';
    const file = await api(apiPath(`/contents/${path}?ref=main`));
    const encoded = file.content || (file.sha ? (await api(apiPath(`/git/blobs/${encodeURIComponent(file.sha)}`))).content : null);
    if (!encoded) throw new Error('Отчёт недоступен через GitHub API.');
    const parsed = JSON.parse(decodeContent(encoded));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.documents) || !Array.isArray(parsed.sources)) throw new Error('Неизвестный формат отчёта.');
    if (version !== connectionVersion || !token) return;
    report = parsed;
    render();
  } catch (error) {
    if (!String(error.message).includes('не найдены')) throw error;
  }
}

async function checkRun() {
  if (!activeRunId || !token || polling) return;
  polling = true;
  const id = String(activeRunId), version = connectionVersion;
  try {
    const runInfo = await api(apiPath(`/actions/runs/${id}`));
    if (version !== connectionVersion || id !== String(activeRunId)) return;
    pollFailures = 0;
    if (runInfo.status !== 'completed') {
      $('run-status').textContent = runInfo.status === 'queued' ? 'Проверка в очереди' : 'Проверяем публикации';
      $('status-indicator').textContent = 'В РАБОТЕ';
      $('run-description').textContent = 'Можно оставить страницу открытой. Результат появится автоматически.';
      return;
    }
    stopPolling();
    await refreshReport(id);
    if (version !== connectionVersion) return;
    activeRunId = null; rememberRun(); setBusy(false);
    if (report?.runId === id) {
      const warnings = report.warnings?.length ? ' ' + report.warnings.join(' ') : '';
      showNotice((runInfo.conclusion === 'success' ? 'Проверка завершена. Результат обновлён.' : 'Проверка завершена не полностью. Доступные результаты показаны ниже.') + warnings, runInfo.conclusion === 'success' ? 'info' : 'error');
    } else {
      $('run-status').textContent = 'Проверка не завершилась';
      $('status-indicator').textContent = 'ОШИБКА';
      showNotice(`Не удалось подготовить отчёт (${runInfo.conclusion || 'ошибка выполнения'}). Можно повторить запуск.`, 'error');
    }
  } catch (error) {
    if (version !== connectionVersion) return;
    pollFailures++;
    showNotice(`${error.message} Ожидание результата продолжится автоматически.`, 'error');
    if (activeRunId && !pollTimer) pollTimer = setInterval(checkRun, 12000);
  } finally { polling = false; }
}

function startPolling() { stopPolling(); checkRun(); pollTimer = setInterval(checkRun, 9000); }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

function showView(name) {
  const valid = ['overview', 'documents', 'sources', 'settings'];
  const view = valid.includes(name) ? name : 'overview';
  for (const candidate of valid) $(candidate + '-view').classList.toggle('hidden', candidate !== view);
  for (const link of document.querySelectorAll('.nav-link')) link.classList.toggle('active', link.dataset.view === view);
  $('breadcrumb').textContent = ({ overview: 'ОБЗОР', documents: 'ДОКУМЕНТЫ', sources: 'ИСТОЧНИКИ', settings: 'ПОДКЛЮЧЕНИЕ' })[view];
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
}

function setMode(next) {
  mode = next;
  for (const button of document.querySelectorAll('.mode')) button.classList.toggle('active', button.dataset.mode === mode);
  $('date-fields').classList.toggle('hidden', mode === 'today');
  $('to-wrap').classList.toggle('hidden', mode !== 'period');
  $('mode-hint').textContent = ({ today: 'Публикации за текущий день по Москве', day: 'Один день по дате публикации', period: 'До 31 дня включительно' })[mode];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function empty(text) {
  const node = el('div', 'empty-state');
  node.append(el('span', '', '◌'), el('strong', '', 'Документов пока нет'), el('p', '', text));
  return node;
}

function card(doc) {
  const row = el('article', 'document-row');
  const day = el('div', 'doc-date');
  day.append(el('strong', '', displayDate(doc.publicationDate)), el('small', '', 'ПУБЛИКАЦИЯ'));
  const body = el('div', 'doc-body');
  body.append(el('strong', '', doc.title || 'Документ без названия'), el('p', '', doc.source || 'Источник не указан'));
  const tags = el('div', 'doc-tags');
  for (const category of doc.categories || []) tags.append(el('span', 'tag', NAMES[category] || category));
  if (doc.classification === 'manual_review') tags.append(el('span', 'tag review', 'РУЧНАЯ ПРОВЕРКА'));
  body.append(tags);
  const button = el('button', 'doc-open', '↗');
  button.type = 'button'; button.setAttribute('aria-label', `Открыть ${doc.title || 'документ'}`);
  button.addEventListener('click', () => openDocument(doc));
  row.append(day, body, button);
  return row;
}

function openDocument(doc) {
  const body = $('dialog-body');
  body.replaceChildren();
  const tags = el('div', 'doc-tags');
  for (const category of doc.categories || []) tags.append(el('span', 'tag', NAMES[category] || category));
  body.append(tags, el('h2', 'dialog-title', doc.title || 'Документ'), el('div', 'dialog-meta', `${doc.source || 'Источник'} · опубликован ${displayDate(doc.publicationDate)}`));
  const fields = [
    ['Что изменилось', doc.summary?.what_changed], ['Кого касается', doc.summary?.who_affected],
    ['Было', doc.summary?.before], ['Стало', doc.summary?.after],
    ['Вступает в силу', doc.summary?.effective_date], ['Что важно сделать', doc.summary?.actions],
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    const dl = el('dl', 'dialog-summary');
    dl.append(el('dt', '', label.toUpperCase()), el('dd', '', value));
    body.append(dl);
  }
  const href = safeUrl(doc.url);
  if (href) { const link = el('a', 'source-link', 'Открыть первоисточник ↗'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link); }
  $('document-dialog').showModal();
}

function renderDocuments() {
  const docs = report?.documents || [];
  const overview = $('overview-documents');
  overview.replaceChildren();
  if (!docs.length) overview.append(empty('После проверки здесь появятся релевантные документы с резюме и ссылками на источники.'));
  else for (const doc of docs.slice(0, 3)) overview.append(card(doc));
  const listed = filter === 'ALL' ? docs : docs.filter((item) => (item.categories || []).includes(filter));
  const all = $('all-document-list'); all.replaceChildren();
  if (!listed.length) all.append(empty('Для выбранной категории документов нет.'));
  else for (const doc of listed) all.append(card(doc));
  $('documents-count').textContent = `${docs.length} ДОКУМЕНТОВ`;
}

function renderSources() {
  const host = $('source-cards'); host.replaceChildren();
  const sources = report?.sources || SOURCE_NAMES.map((name) => ({ name, status: 'ожидает проверки', count: null }));
  for (const [index, source] of sources.entries()) {
    const node = el('div', 'source-card');
    const title = el('h3');
    const link = el('a', '', source.name);
    link.href = SOURCE_URLS[source.name] || '#sources';
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    title.append(link);
    node.append(el('span', 'source-num', `ИСТОЧНИК 0${index + 1}`), title, el('p', '', source.note || (source.count == null ? 'Статус появится после первого запуска.' : `Найдено публикаций: ${source.count}`)));
    node.append(el('span', `source-state${source.status === 'ok' ? '' : ' warn'}`, source.count == null ? 'ОЖИДАНИЕ' : `${source.status === 'ok' ? 'ДОСТУПЕН' : 'ПРОВЕРКА НЕПОЛНАЯ'} · ${source.count}`));
    host.append(node);
  }
}

function render() {
  $('today-label').textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).format(new Date());
  const stats = report?.stats || {};
  for (const [id, value] of [['metric-checked', stats.checked], ['metric-matched', stats.matched], ['metric-relevant', stats.relevant], ['metric-review', stats.manualReview]]) $(id).textContent = Number.isFinite(value) ? new Intl.NumberFormat('ru-RU').format(value) : '—';
  if (report) {
    $('run-status').textContent = report.stats?.errors ? 'Частичная проверка' : 'Проверка завершена';
    $('run-description').textContent = report.stats?.errors ? 'Некоторые источники или документы недоступны. Итог неполный.' : `Период публикации: ${displayDate(report.period?.from)} — ${displayDate(report.period?.to)}`;
    $('status-indicator').textContent = report.stats?.errors ? 'НЕПОЛНО' : 'ГОТОВО';
    $('status-indicator').className = `status-indicator ${report.stats?.errors ? 'warn' : 'ok'}`;
    $('last-run-date').textContent = `ПОСЛЕДНЯЯ ПРОВЕРКА · ${report.finishedAt ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(report.finishedAt)) : '—'}`;
    if (report.runId) $('run-link').href = `https://github.com/${repo}/actions/runs/${encodeURIComponent(report.runId)}`;
    if (report.warnings?.length) showNotice(report.warnings.join(' '));
  } else {
    $('run-status').textContent = 'Пока нет данных';
    $('run-description').textContent = 'Подключите GitHub, чтобы получить результаты из приватного репозитория.';
    $('status-indicator').textContent = 'ОЖИДАНИЕ';
    $('status-indicator').className = 'status-indicator';
    $('last-run-date').textContent = 'ПОСЛЕДНЯЯ ПРОВЕРКА · —';
  }
  renderDocuments(); renderSources();
}

function action(handler) { return async () => { try { hideNotice(); await handler(); } catch (error) { showNotice(error.message, 'error'); } }; }

document.querySelectorAll('.nav-link').forEach((item) => item.addEventListener('click', (event) => { event.preventDefault(); showView(item.dataset.view); }));
document.querySelectorAll('.mode').forEach((item) => item.addEventListener('click', () => setMode(item.dataset.mode)));
document.querySelectorAll('.filter').forEach((item) => item.addEventListener('click', () => {
  filter = item.dataset.filter;
  document.querySelectorAll('.filter').forEach((button) => button.classList.toggle('active', button.dataset.filter === filter));
  renderDocuments();
}));
$('connect-button').addEventListener('click', action(connect));
$('disconnect-button').addEventListener('click', disconnect);
$('run-button').addEventListener('click', action(run));
$('refresh-button').addEventListener('click', action(() => activeRunId ? checkRun() : refreshReport()));
$('all-documents').addEventListener('click', () => showView('documents'));
$('close-dialog').addEventListener('click', () => $('document-dialog').close());
$('document-dialog').addEventListener('click', (event) => { if (event.target === $('document-dialog')) $('document-dialog').close(); });
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
$('from-date').value = moscowDate(); $('to-date').value = moscowDate();
$('from-date').max = moscowDate(); $('to-date').max = moscowDate();
setManualLink(); setMode('today'); render(); showView(location.hash.slice(1));
