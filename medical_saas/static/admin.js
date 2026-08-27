'use strict';

/* The operator's dashboard.
 *
 * The server hands over every account in one response and the sorting,
 * searching and filtering happen here: at this size that is one query instead
 * of one per keystroke, and the table reorders instantly.
 *
 * Every value in a row comes from a user — an email address is whatever
 * someone typed into the sign-up box — so cells are filled with textContent
 * and never with innerHTML. */

const $ = (id) => document.getElementById(id);

const gate = $('gate');
const dashboard = $('dashboard');
const rowsBody = $('rows');

/** Everything the last fetch returned, unsorted and unfiltered. */
let allUsers = [];
let meta = { total: 0, shown: 0, truncated: false, free_words_per_week: 0 };

/** Which column the table is ordered by, and which way. */
let sortKey = 'last_active';
let sortDesc = true;

/* ---------- Formatting ---------- */

const numbers = new Intl.NumberFormat();

/** An absolute timestamp, for the title attribute where the exact moment
 *  matters more than the shape of it. */
function absolute(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** How long ago, in the shortest form that is still accurate. */
function relative(seconds) {
  if (!seconds) return null;
  const ago = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (ago < 90) return 'just now';
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  if (ago < 86400 * 30) return `${Math.floor(ago / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  });
}

/** A date without a time: joined and subscribed are day-scale facts. */
function day(seconds) {
  if (!seconds) return null;
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function cell(row, text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  row.appendChild(td);
  return td;
}

/* ---------- The table ---------- */

/** What a row sorts by for a given column. Nulls sort last in both
 *  directions, so "never active" never crowds out the rows worth reading. */
function sortValue(user, key) {
  switch (key) {
    case 'email': return user.email || '';
    case 'plan': return user.plan === 'pro' ? 1 : 0;
    case 'subscribed': return user.subscribed_at || null;
    case 'last_active': return user.last_active || null;
    case 'words_window': return user.words_window;
    case 'words_total': return user.words_total;
    case 'created_at': return user.created_at;
    default: return null;
  }
}

function compare(a, b, key) {
  const x = sortValue(a, key);
  const y = sortValue(b, key);
  if (x === null && y === null) return 0;
  if (x === null) return 1;   // absent sorts last
  if (y === null) return -1;
  if (typeof x === 'string') return x.localeCompare(y);
  return x - y;
}

function visibleUsers() {
  const term = $('search').value.trim().toLowerCase();
  const plan = $('planFilter').value;
  const activity = $('activityFilter').value;
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  const filtered = allUsers.filter((user) => {
    if (term && !user.email.toLowerCase().includes(term)) return false;
    if (plan !== 'all' && user.plan !== plan) return false;
    if (activity === 'week' && !(user.last_active && user.last_active >= weekAgo)) return false;
    if (activity === 'spoken' && user.turns === 0) return false;
    if (activity === 'never' && user.turns > 0) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const ordered = compare(a, b, sortKey);
    // Nulls stay at the bottom rather than flipping to the top on reverse.
    if (ordered === 0) return a.email.localeCompare(b.email);
    const bothPresent = sortValue(a, sortKey) !== null && sortValue(b, sortKey) !== null;
    return sortDesc && bothPresent ? -ordered : ordered;
  });
  return filtered;
}

/** The subscription cell: what the plan is, and when it changed. */
function subscriptionText(user) {
  if (user.plan === 'pro') {
    const since = day(user.subscribed_at);
    return since ? `Since ${since}` : 'Subscribed';
  }
  const ended = day(user.unsubscribed_at);
  if (ended) return `Cancelled ${ended}`;
  return 'Never';
}

function planPill(user) {
  const span = document.createElement('span');
  const status = user.subscription_status || '';
  // past_due keeps access, so it is worth seeing apart from a healthy sub.
  const kind = user.plan === 'pro' ? (status === 'past_due' ? 'past_due' : 'pro') : 'free';
  span.className = `pill ${kind}`;
  span.textContent = user.plan === 'pro' ? (status === 'past_due' ? 'Past due' : 'Paid') : 'Free';
  if (status) span.title = `Stripe status: ${status}`;
  return span;
}

function render() {
  const users = visibleUsers();
  rowsBody.replaceChildren();

  for (const user of users) {
    const tr = document.createElement('tr');

    cell(tr, user.email, 'email');

    const planCell = document.createElement('td');
    planCell.appendChild(planPill(user));
    tr.appendChild(planCell);

    const sub = cell(tr, subscriptionText(user));
    if (user.plan !== 'pro') sub.className = 'muted';
    if (user.subscribed_at) sub.title = absolute(user.subscribed_at);

    const active = relative(user.last_active);
    const activeCell = cell(tr, active || 'Never');
    if (!active) activeCell.className = 'muted';
    if (user.last_active) activeCell.title = absolute(user.last_active);

    // A free account at or over its allowance is the one number an operator
    // is looking for, so it is called out rather than left to be compared.
    const overLimit = user.plan !== 'pro'
      && meta.free_words_per_week > 0
      && user.words_window >= meta.free_words_per_week;
    const weekCell = cell(tr, numbers.format(user.words_window), 'num');
    if (overLimit) {
      weekCell.classList.add('over');
      weekCell.title = `At or over the free allowance of ${numbers.format(meta.free_words_per_week)}`;
    }

    const totalCell = cell(tr, numbers.format(user.words_total), 'num');
    totalCell.title = `${numbers.format(user.turns)} turns`;

    const joined = cell(tr, day(user.created_at) || '');
    joined.title = absolute(user.created_at);

    rowsBody.appendChild(tr);
  }

  $('empty').hidden = users.length > 0;
  renderSummary(users);
  renderSortArrows();
}

function renderSummary(visible) {
  const paying = allUsers.filter((u) => u.plan === 'pro').length;
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const active = allUsers.filter((u) => u.last_active && u.last_active >= weekAgo).length;
  const words = allUsers.reduce((sum, u) => sum + u.words_window, 0);

  const parts = [
    `<b>${numbers.format(meta.total)}</b> account${meta.total === 1 ? '' : 's'}`,
    `<b>${numbers.format(paying)}</b> paying`,
    `<b>${numbers.format(active)}</b> active this week`,
    `<b>${numbers.format(words)}</b> words this week`,
  ];
  if (visible.length !== allUsers.length) {
    parts.push(`showing <b>${numbers.format(visible.length)}</b>`);
  }
  if (meta.truncated) {
    parts.push(`<b>${numbers.format(meta.shown)}</b> newest loaded`);
  }
  // Only numbers this page computed go in here; nothing a user typed.
  $('summary').innerHTML = parts.join(' · ');
}

function renderSortArrows() {
  for (const th of document.querySelectorAll('thead th')) {
    const key = th.dataset.sort;
    const label = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = key === sortKey ? `${label} ${sortDesc ? '▼' : '▲'}` : label;
  }
}

/* ---------- Loading ---------- */

async function loadUsers() {
  const res = await fetch('/api/admin/users');
  if (res.status === 401) {
    showGate();
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  const data = await res.json();
  allUsers = data.users || [];
  meta = data;
  showDashboard();
  render();
}

function showGate() {
  gate.hidden = false;
  dashboard.hidden = true;
  $('refresh').hidden = true;
  $('signout').hidden = true;
  $('password').focus();
}

function showDashboard() {
  gate.hidden = true;
  dashboard.hidden = false;
  $('refresh').hidden = false;
  $('signout').hidden = false;
}

/* ---------- Wiring ---------- */

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('loginButton');
  const error = $('loginError');
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Wrong password.');
    }
    $('password').value = '';
    await loadUsers();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

$('signout').addEventListener('click', async () => {
  await fetch('/admin/logout', { method: 'POST' }).catch(() => {});
  allUsers = [];
  showGate();
});

$('refresh').addEventListener('click', () => {
  loadUsers().catch((err) => console.error(err));
});

for (const th of document.querySelectorAll('thead th')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (!key) return;
    if (key === sortKey) {
      sortDesc = !sortDesc;
    } else {
      sortKey = key;
      // Text reads better A-Z first; everything else is most-recent-first.
      sortDesc = key !== 'email';
    }
    render();
  });
}

for (const id of ['search', 'planFilter', 'activityFilter']) {
  $(id).addEventListener('input', render);
}

// Ask whether this browser already holds a session before drawing anything,
// so a signed-in admin does not see the password box flash past.
fetch('/api/admin/session')
  .then((r) => (r.ok ? r.json() : { authenticated: false }))
  .then((data) => (data.authenticated ? loadUsers() : showGate()))
  .catch(() => showGate());
