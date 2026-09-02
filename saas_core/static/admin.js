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
    case 'payment_events': return user.payment_events;
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
  // past_due keeps access, so it is worth seeing apart from a healthy sub;
  // comped is access granted from this dashboard, with nothing billed.
  let kind = 'free';
  let text = 'Free';
  if (user.plan === 'pro') {
    if (status === 'comped') { kind = 'comped'; text = 'Comped'; }
    else if (status === 'past_due') { kind = 'past_due'; text = 'Past due'; }
    else { kind = 'pro'; text = 'Paid'; }
  }
  span.className = `pill ${kind}`;
  span.textContent = text;
  if (status === 'comped') span.title = 'Granted from this dashboard; not billed through Stripe';
  else if (status === 'revoked') span.title = 'A granted subscription, removed from this dashboard';
  else if (status) span.title = `Stripe status: ${status}`;
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

    const events = user.payment_events || 0;
    const eventsCell = cell(tr, events ? String(events) : '—', 'num');
    if (!events) eventsCell.classList.add('count-none');
    eventsCell.title = events
      ? `${events} Stripe event${events === 1 ? '' : 's'}`
      : 'No Stripe events recorded';

    const joined = cell(tr, day(user.created_at) || '');
    joined.title = absolute(user.created_at);

    if (user.id === openUserId) tr.classList.add('open');
    tr.addEventListener('click', () => openPayments(user));
    rowsBody.appendChild(tr);
  }

  $('empty').hidden = users.length > 0;
  renderSummary(users);
  renderSortArrows();
}

function renderSummary(visible) {
  // A granted subscription is not revenue; the summary keeps the two apart.
  const comped = allUsers.filter((u) => u.plan === 'pro' && u.subscription_status === 'comped').length;
  const paying = allUsers.filter((u) => u.plan === 'pro').length - comped;
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const active = allUsers.filter((u) => u.last_active && u.last_active >= weekAgo).length;
  const words = allUsers.reduce((sum, u) => sum + u.words_window, 0);

  const parts = [
    `<b>${numbers.format(meta.total)}</b> account${meta.total === 1 ? '' : 's'}`,
    `<b>${numbers.format(paying)}</b> paying` + (comped ? ` · <b>${numbers.format(comped)}</b> comped` : ''),
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

/* ---------- One account's billing history ---------- */

/** Which account's drawer is open, so the row stays highlighted across a
 *  re-render. */
let openUserId = null;

/** Stripe sends minor units, except for the currencies that have none. */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

function money(cents, currency) {
  if (cents === null || cents === undefined) return null;
  const code = (currency || 'usd').toLowerCase();
  const amount = ZERO_DECIMAL.has(code) ? cents : cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code.toUpperCase(),
    }).format(amount);
  } catch {
    // An unknown currency code should still show the number.
    return `${amount} ${code.toUpperCase()}`;
  }
}

function eventRow(event) {
  const wrap = document.createElement('div');
  wrap.className = 'event';

  const top = document.createElement('div');
  top.className = 'event-top';
  const type = document.createElement('span');
  type.className = 'event-type';
  type.textContent = event.type;
  top.appendChild(type);

  const amount = document.createElement('span');
  const formatted = money(event.amount_cents, event.currency);
  // A failed payment carries an amount too — the amount it tried to take.
  // Colouring that like a collected one reads as revenue that never arrived.
  const collected = event.status === 'paid' || event.status === 'complete';
  const failed = event.type.includes('failed') || event.status === 'unpaid';
  amount.className = `event-amount ${
    !formatted ? 'none' : failed ? 'failed' : collected ? 'paid' : 'pending'
  }`;
  amount.textContent = formatted ? (failed ? `${formatted} failed` : formatted) : 'no charge';
  top.appendChild(amount);
  wrap.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'event-meta';
  meta.textContent = [absolute(event.created_at), event.status].filter(Boolean).join(' · ');
  wrap.appendChild(meta);

  if (event.object_id) {
    const id = document.createElement('div');
    id.className = 'event-id';
    id.textContent = event.object_id;
    wrap.appendChild(id);
  }
  return wrap;
}

/* Granting and removing the unlimited plan by hand — the dashboard's one
   write. A grant is marked "comped": paid-plan access with nothing billed.
   A Stripe subscription later takes the account over, and only then can a
   Stripe cancellation end the plan; a subscription Stripe is billing cannot
   be ended from here, since the charges would continue and the next renewal
   event would hand the access straight back. */
function subscriptionActions(user) {
  const wrap = document.createElement('div');
  wrap.className = 'drawer-actions';
  const note = document.createElement('p');
  note.className = 'event-meta';

  if (user.plan !== 'pro') {
    const btn = document.createElement('button');
    btn.className = 'btn accent';
    btn.textContent = 'Mark as subscribed';
    btn.addEventListener('click', () => setPlan(user, 'pro',
      `Give ${user.email} the unlimited plan?\n\nNothing is billed. If they later subscribe through Stripe, `
      + 'Stripe takes the subscription over; until then only this dashboard can remove it.'));
    wrap.appendChild(btn);
    note.textContent = 'Grants the unlimited plan with nothing billed.';
  } else if (user.subscription_status === 'comped') {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Remove subscription';
    btn.addEventListener('click', () => setPlan(user, 'free',
      `Remove ${user.email}'s granted subscription?\n\nThey return to the free plan immediately.`));
    wrap.appendChild(btn);
    note.textContent = 'This subscription was granted from this dashboard; nothing is billed.';
  } else {
    note.textContent = 'Billed through Stripe. To end it, cancel there; the account returns to '
      + 'the free plan when the subscription expires.';
  }
  wrap.appendChild(note);
  return wrap;
}

async function setPlan(user, plan, confirmText) {
  if (!window.confirm(confirmText)) return;
  try {
    const resp = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    if (resp.status === 401) {
      showGate();
      return;
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${resp.status})`);
    }
    // The table and the open drawer both show the change at once.
    await loadUsers();
    const fresh = allUsers.find((u) => u.id === user.id);
    if (fresh && openUserId === user.id) openPayments(fresh);
  } catch (err) {
    window.alert(err.message);
  }
}

function closeDrawer() {
  openUserId = null;
  $('drawer').hidden = true;
  for (const tr of rowsBody.querySelectorAll('tr.open')) tr.classList.remove('open');
}

async function openPayments(user) {
  openUserId = user.id;
  $('drawer').hidden = false;
  $('drawerEmail').textContent = user.email;
  $('drawerSub').textContent = 'Loading…';
  $('drawerBody').replaceChildren();
  for (const tr of rowsBody.querySelectorAll('tr.open')) tr.classList.remove('open');
  for (const tr of rowsBody.querySelectorAll('tr')) {
    if (tr.children[0].textContent === user.email) tr.classList.add('open');
  }

  const body = $('drawerBody');
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/payments`);
    if (!res.ok) throw new Error(`Could not load billing history (${res.status})`);
    const data = await res.json();
    // The drawer may have been closed, or another row opened, while this was
    // in flight.
    if (openUserId !== user.id) return;

    const events = data.events || [];
    $('drawerSub').textContent = events.length
      ? `${events.length} Stripe event${events.length === 1 ? '' : 's'}`
      : 'No Stripe events';

    body.replaceChildren();
    body.appendChild(subscriptionActions(user));
    if (data.stripe_customer_id || data.stripe_subscription_id) {
      const ids = document.createElement('p');
      ids.className = 'ids';
      for (const [label, value] of [
        ['Customer', data.stripe_customer_id],
        ['Subscription', data.stripe_subscription_id],
      ]) {
        if (!value) continue;
        const line = document.createElement('span');
        line.textContent = `${label}: `;
        const code = document.createElement('code');
        code.textContent = value;
        line.appendChild(code);
        line.appendChild(document.createElement('br'));
        ids.appendChild(line);
      }
      body.appendChild(ids);
    }
    if (!events.length) {
      const none = document.createElement('p');
      none.className = 'event-meta';
      none.textContent = 'Nothing has come in from Stripe for this account.';
      body.appendChild(none);
      return;
    }
    for (const event of events) body.appendChild(eventRow(event));
  } catch (err) {
    if (openUserId !== user.id) return;
    $('drawerSub').textContent = '';
    body.replaceChildren();
    const error = document.createElement('div');
    error.className = 'error';
    error.textContent = err.message;
    body.appendChild(error);
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
  closeDrawer();
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
  closeDrawer();
  showGate();
});

$('drawerClose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
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
