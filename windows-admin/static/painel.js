'use strict';

const $ = (id) => document.getElementById(id);

let csrf = document.querySelector('meta[name="csrf-token"]').content;

let signed = null,
  cards = [],
  history = [],
  users = [],
  editId = null,
  extras = {};

let playPokemonSupported = false;

let clientsSupported = false,
  clients = [],
  clientEditId = null;

let saleCard = null,
  saleId = null,
  deleteTarget = null;

let saleAction = null;

const isOwner = () => signed?.role === 'proprietario';

const rarities = {
  Pokémon: [
    'Comum',
    'Incomum',
    'Rara',
    'Rara Dupla',
    'Ultra Rara',
    'Ilustração Rara',
    'Ilustração Rara Especial',
    'Rara Hiper',
    'ACE SPEC',
  ],
  Magic: ['Comum', 'Incomum', 'Rara', 'Mítica', 'SLD'],
};

const categoriesByGame = {
  Pokémon: ['Foil', 'Reverse Foil', 'Full Art'],
  Magic: ['Foil', 'Foil Especial', 'Promo'],
};

const money = (n) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
      })
    : 'Sob consulta';

const alphabeticalCollator = new Intl.Collator('pt-BR', {
  sensitivity: 'base',
  numeric: true,
});

const textCompare = (left, right) =>
  alphabeticalCollator.compare(String(left || ''), String(right || ''));

const compareCardAlphabetically = (a, b) =>
  textCompare(a.name, b.name) ||
  textCompare(a.set || a.edition, b.set || b.edition) ||
  textCompare(a.number, b.number);

const msg = (t) => {
  $('message').textContent = t;
};

function formError(id, message = '') {
  $(id).textContent = message;
}

function formBusy(form, busy, label) {
  form.setAttribute('aria-busy', String(busy));
  const button = form.querySelector('button[type="submit"]');
  if (busy) {
    button.dataset.idleLabel = button.textContent;
    button.textContent = label;
  } else button.textContent = button.dataset.idleLabel || button.textContent;
  button.disabled = busy;
}

async function api(path, method = 'GET', data, signal) {
  const opts = {
    method: method,
    signal: signal,
    credentials: 'same-origin',
    headers: {
      'X-CSRF-Token': csrf,
    },
  };
  if (data !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  const res = await fetch('/api/' + path, opts);
  const x = await res.json().catch(() => ({
    error: 'Resposta inválida.',
  }));
  if (!res.ok) throw Error(x.error || x.message || 'Falha na requisição.');
  return x;
}

function labelFor(c) {
  return [c.name, c.set].filter(Boolean).join(' · ');
}

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function setLogin(u) {
  signed = u;
  $('login-screen').hidden = !!u;
  $('dashboard').hidden = !u;
  $('logout').hidden = !u;
  $('account-name').textContent = u ? `${u.username} · ${u.role}` : '';
  $('user-create').hidden = !!u && u.role !== 'proprietario';
}

async function start() {
  try {
    const s = await api('session');
    playPokemonSupported = s.playPokemonSupported === true;
    clientsSupported = s.clientsSupported === true;
    $('clients-tab').hidden = !clientsSupported;
    setLogin(s.user);
    $('install-hint').hidden = s.initialized;
    if (s.user) await refresh();
  } catch (e) {
    formError('login-error', e.message);
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (form.getAttribute('aria-busy') === 'true') return;
  formError('login-error');
  formBusy(form, true, 'Entrando...');
  try {
    const x = await api('login', 'POST', {
      username: $('login-user').value,
      password: $('login-pass').value,
    });
    csrf = x.csrf;
    setLogin(x.user);
    $('login-pass').value = '';
    await refresh();
  } catch (err) {
    formError('login-error', err.message);
  } finally {
    formBusy(form, false);
  }
});

$('logout').addEventListener('click', async () => {
  try {
    await api('logout', 'POST');
    location.reload();
  } catch (err) {
    msg(err.message);
  }
});

async function refresh() {
  try {
    const [a, b, c, d, s, cl] = await Promise.all([
      api('cards'),
      api('history'),
      api('users'),
      api('status'),
      api('sales'),
      clientsSupported
        ? api('clients')
        : Promise.resolve({
            items: [],
          }),
    ]);
    cards = a.items;
    history = b.items;
    users = c.items;
    clients = cl.items;
    renderCards();
    renderHistory();
    renderUsers();
    renderStatus(d);
    renderSales(s);
    renderClients();
  } catch (e) {
    msg(e.message);
  }
}

function renderStatus(d) {
  const state = d.lastError ? 'error' : !d.hasToken ? 'warning' : d.dirty ? 'pending' : 'ready';
  $('sync-state').parentElement.dataset.state = state;
  $('sync-state').textContent = d.lastError
    ? 'Falha na publicação'
    : !d.hasToken
      ? 'Token GitHub não configurado'
      : d.dirty
        ? 'Alterações aguardando publicação'
        : d.lastPublish
          ? 'Catálogo enviado ao GitHub'
          : 'Nenhum envio nesta instalação';
  $('sync-info').textContent = d.lastError
    ? 'Falha: ' + d.lastError
    : d.lastPublish
      ? 'Último envio: ' +
        new Date(d.lastPublish).toLocaleString('pt-BR') +
        ' · Aguarde a atualização da vitrine.'
      : 'O catálogo publicado será atualizado após o primeiro envio.';
}

$('publish-now').addEventListener('click', async () => {
  const btn = $('publish-now');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await api('publish', 'POST');
    msg(r.message);
    await refresh();
  } catch (e) {
    msg(e.message);
  } finally {
    btn.disabled = false;
  }
});

for (const button of document.querySelectorAll('[data-tab]'))
  button.addEventListener('click', () => {
    for (const b of document.querySelectorAll('[data-tab]'))
      b.classList.toggle('active', b === button);
    for (const id of ['collection', 'history', 'sales', 'clients', 'users', 'settings'])
      $('tab-' + id).hidden = button.dataset.tab !== id;
    msg('');
  });

$('filter-name').addEventListener('input', renderCards);

$('filter-game').addEventListener('change', renderCards);

function renderCards() {
  const totalCents = cards.reduce((total, card) => {
    const { price: price, quantity: quantity } = card;
    return (
      total +
      (typeof price === 'number' &&
      Number.isFinite(price) &&
      price >= 0 &&
      Number.isInteger(quantity) &&
      quantity > 0
        ? Math.round(price * 100) * quantity
        : 0)
    );
  }, 0);
  if ($('collection-total')) $('collection-total').textContent = money(totalCents / 100);
  const tbody = $('cards-body');
  const q = normalizedName($('filter-name').value).trim(),
    g = $('filter-game').value;
  const filtered = cards
    .filter(
      (c) =>
        (!g || c.game === g) &&
        normalizedName([c.name, c.set, c.description].filter(Boolean).join(' ')).includes(q),
    )
    .sort(compareCardAlphabetically);
  $('cards-count').textContent = filtered.length + ' de ' + cards.length + ' registros';
  const labels = [
    'Carta',
    'Jogo',
    'Conservação',
    'Preço',
    'Qtd.',
    'Cadastrado por',
    'Vitrine',
    'Ações',
  ];
  const clientsById = new Map(clients.map((item) => [item.id, item]));
  const owner = isOwner();
  const rows = [];
  for (const c of filtered) {
    const tr = el('tr');
    const td0 = el('td');
    const wrap = el('div', undefined, 'namecell');
    if (c.image) {
      const img = el('img');
      img.className = 'thumb';
      img.alt = '';
      img.src = c.image;
      img.loading = 'lazy';
      img.addEventListener(
        'error',
        () => {
          img.hidden = true;
        },
        {
          once: true,
        },
      );
      wrap.append(img);
    }
    const group = el('div');
    group.append(el('strong', c.name), el('small', c.set));
    if (c.categories?.length)
      group.append(el('small', c.categories.join(' · '), 'category-summary'));
    const client = clientsById.get(c.commissionClientId);
    if (client)
      group.append(
        el(
          'small',
          'Comissão: ' +
            client.name +
            ' · ' +
            client.commissionPercent.toLocaleString('pt-BR') +
            '%',
          'category-summary',
        ),
      );
    wrap.append(group);
    td0.append(wrap);
    tr.append(td0);
    for (const val of [
      c.game,
      c.condition,
      money(c.price),
      String(c.quantity),
      c.author || '—',
      c.published ? 'Sim' : 'Não',
    ])
      tr.append(el('td', val));
    const controls = el('td');
    const act = el('div', undefined, 'actions');
    if (c.canEdit) {
      const edit = el('button', 'Editar', 'secondary');
      edit.addEventListener('click', () => openForm(c));
      act.append(edit);
    }
    if (owner) {
      const sold = el('button', 'Carta vendida', 'secondary');
      sold.disabled = c.quantity < 1;
      sold.addEventListener('click', () => openSale(c));
      act.append(sold);
    }
    if (c.canEdit) {
      const del = el('button', 'Excluir', 'subtle danger');
      del.addEventListener('click', () => removeCard(c, del));
      act.append(del);
    }
    if (!act.children.length) act.append(el('span', 'Somente leitura', 'muted'));
    controls.append(act);
    tr.append(controls);
    Array.from(tr.children).forEach((td, i) => {
      td.dataset.label = labels[i];
    });
    rows.push(tr);
  }
  tbody.replaceChildren(...rows);
  if (!filtered.length) {
    const tr = el('tr');
    const td = el('td', 'Nenhuma carta encontrada.');
    td.colSpan = 8;
    tr.append(td);
    tbody.append(tr);
  }
}

function updateRarities(game, selected = '') {
  const select = $('card-rarity');
  select.replaceChildren();
  const placeholder = el('option', 'Selecione a raridade');
  placeholder.value = '';
  placeholder.disabled = true;
  select.append(placeholder);
  for (const rarity of rarities[game]) {
    const option = el('option', rarity);
    option.value = rarity;
    select.append(option);
  }
  select.value = rarities[game].includes(selected) ? selected : '';
}

function selectedCategories() {
  return Array.from($('card-categories').querySelectorAll('input:checked'), (input) => input.value);
}

function updateCategories(game, selected = []) {
  const target = $('card-categories');
  target.replaceChildren();
  for (const category of categoriesByGame[game]) {
    const label = el('label', undefined, 'category-option');
    const input = el('input');
    input.type = 'checkbox';
    input.value = category;
    input.name = 'categories';
    input.checked = Array.isArray(selected) && selected.includes(category);
    label.append(input, el('span', category));
    target.append(label);
  }
}

function clearOtherGameMetadata(game) {
  for (const key of [
    'tcgdexId',
    'tcgdexLanguage',
    'scryfall',
    'scryfallId',
    'scryfallSet',
    'scryfallNumber',
    'scryfallLanguage',
  ]) {
    if (
      (game === 'Magic' && key.startsWith('tcgdex')) ||
      (game === 'Pokémon' && key.startsWith('scryfall'))
    )
      extras[key] = '';
  }
}

function updatePlayPokemon() {
  const pokemon = $('card-game').value === 'Pokémon',
    checkbox = $('card-play-pokemon'),
    number = $('card-play-pokemon-number');
  if (!checkbox || !number) return;
  $('play-pokemon-fields').hidden = !pokemon;
  checkbox.disabled = !pokemon || !playPokemonSupported;
  $('play-pokemon-restart').hidden = playPokemonSupported || !pokemon;
  if (!pokemon) {
    checkbox.checked = false;
    number.value = '';
  }
  const enabled = pokemon && checkbox.checked && playPokemonSupported;
  $('play-pokemon-number-field').hidden = !enabled;
  number.disabled = !enabled;
  number.required = enabled;
}

$('card-play-pokemon')?.addEventListener('change', updatePlayPokemon);

$('card-game').addEventListener('change', () => {
  const game = $('card-game').value;
  updateRarities(game);
  updateCategories(game, selectedCategories());
  updatePlayPokemon();
  clearOtherGameMetadata(game);
  activatePrintSearch(game, false);
});

for (const id of ['card-set', 'card-rarity', 'card-image'])
  $(id).addEventListener('input', cancelSelection);

$('new-card').addEventListener('click', () => openForm());

function openForm(card = null) {
  editId = card?.id || null;
  extras = card
    ? Object.fromEntries(
        [
          'tcgdexId',
          'tcgdexLanguage',
          'scryfall',
          'scryfallId',
          'scryfallSet',
          'scryfallNumber',
          'scryfallLanguage',
        ].map((k) => [k, card[k] || '']),
      )
    : {};
  $('duplicate-card').hidden = !editId;
  $('dialog-title').textContent = card ? 'Editar carta' : 'Cadastrar carta';
  $('card-game').value = card?.game || 'Pokémon';
  updateRarities($('card-game').value, card?.rarity || '');
  updateCategories($('card-game').value, card?.categories || []);
  $('card-commission').checked = !!card?.commissionClientId;
  updateCommissionClients(card?.commissionClientId || '');
  if ($('card-play-pokemon')) {
    $('card-play-pokemon').checked = card?.playPokemon === true;
    $('card-play-pokemon-number').value = card?.playPokemonNumber || '';
  }
  updatePlayPokemon();
  for (const [k, v] of Object.entries({
    name: card?.name || '',
    set: card?.set || '',
    condition: card?.condition || 'NM',
    price: card?.price ?? 0,
    quantity: card?.quantity ?? 1,
    image: card?.image || '',
    description: card?.description || '',
    language: card?.language || '',
  }))
    $('card-' + k).value = v;
  $('card-published').checked = card?.published !== false;
  $('magic-set-code').value = '';
  formError('card-error');
  activatePrintSearch($('card-game').value);
  $('card-dialog').showModal();
}

function closeForm() {
  cancelSearch();
  cancelSelection();
  $('card-dialog').close();
}

for (const b of ['cancel-x', 'cancel-form']) $(b).addEventListener('click', closeForm);

$('card-dialog').addEventListener('cancel', (event) => {
  if ($('card-form').getAttribute('aria-busy') === 'true') event.preventDefault();
  else {
    cancelSearch();
    cancelSelection();
  }
});

$('card-dialog').addEventListener('close', () => {
  if (!$('card-dialog').open) {
    cancelSearch();
    cancelSelection();
  }
});

$('card-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (form.getAttribute('aria-busy') === 'true') return;
  const obj = {
    ...extras,
    game: $('card-game').value,
    rarity: $('card-rarity').value,
    categories: selectedCategories(),
    name: $('card-name').value,
    set: $('card-set').value,
    condition: $('card-condition').value,
    price: Number($('card-price').value),
    quantity: Number($('card-quantity').value),
    image: $('card-image').value,
    description: $('card-description').value,
    language: $('card-language').value.trim(),
    published: $('card-published').checked,
  };
  if (playPokemonSupported) {
    obj.playPokemon = obj.game === 'Pokémon' && $('card-play-pokemon').checked;
    obj.playPokemonNumber = obj.playPokemon ? $('card-play-pokemon-number').value.trim() : '';
  }
  if (clientsSupported) {
    if ($('card-commission').checked && !$('card-client').value) {
      formError('card-error', 'Selecione um cliente cadastrado para a comissão.');
      return;
    }
    obj.commissionClientId = $('card-commission').checked ? $('card-client').value : '';
  }
  formError('card-error');
  cancelSelection();
  formBusy(form, true, 'Salvando...');
  $('cancel-x').disabled = true;
  $('cancel-form').disabled = true;
  try {
    await api(
      editId ? 'cards/' + encodeURIComponent(editId) : 'cards',
      editId ? 'PUT' : 'POST',
      obj,
    );
    closeForm();
    msg('Carta salva! Alterações aguardando publicação automática.');
    await refresh();
  } catch (err) {
    formError('card-error', err.message);
  } finally {
    formBusy(form, false);
    $('cancel-x').disabled = false;
    $('cancel-form').disabled = false;
  }
});

function removeCard(c, button) {
  if (button.disabled) return;
  deleteTarget = c;
  $('delete-card-name').textContent = labelFor(c);
  formError('delete-error');
  $('delete-dialog').showModal();
}

$('cancel-delete').addEventListener('click', () => {
  $('delete-dialog').close();
});

$('delete-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!deleteTarget || form.getAttribute('aria-busy') === 'true') return;
  formBusy(form, true, 'Excluindo...');
  $('cancel-delete').disabled = true;
  formError('delete-error');
  try {
    await api('cards/' + encodeURIComponent(deleteTarget.id), 'DELETE');
    $('delete-dialog').close();
    deleteTarget = null;
    msg('Carta excluída.');
    await refresh();
  } catch (err) {
    formError('delete-error', err.message);
  } finally {
    formBusy(form, false);
    $('cancel-delete').disabled = false;
  }
});

$('duplicate-card').addEventListener('click', () => {
  if (!editId || $('card-form').getAttribute('aria-busy') === 'true') return;
  cancelSearch();
  cancelSelection();
  editId = null;
  $('card-quantity').value = 1;
  $('dialog-title').textContent = 'Adicionar cópia da carta';
  $('duplicate-card').hidden = true;
  formError('card-error');
});

function openSale(card) {
  saleCard = card;
  saleId = crypto.randomUUID();
  $('sale-card-name').textContent = labelFor(card);
  $('sale-quantity').value = 1;
  $('sale-quantity').max = card.quantity;
  $('sale-price').value = card.price ?? 0;
  formError('sale-error');
  $('sale-dialog').showModal();
}

$('cancel-sale').addEventListener('click', () => {
  $('sale-dialog').close();
});

for (const [dialog, form] of [
  ['sale-dialog', 'sale-form'],
  ['delete-dialog', 'delete-form'],
  ['sale-action-dialog', 'sale-action-form'],
])
  $(dialog).addEventListener('cancel', (event) => {
    if ($(form).getAttribute('aria-busy') === 'true') event.preventDefault();
  });

$('sale-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!saleCard || form.getAttribute('aria-busy') === 'true') return;
  formBusy(form, true, 'Registrando...');
  $('cancel-sale').disabled = true;
  formError('sale-error');
  try {
    await api('cards/' + encodeURIComponent(saleCard.id) + '/sales', 'POST', {
      saleId: saleId,
      quantity: Number($('sale-quantity').value),
      price: Number($('sale-price').value),
    });
    $('sale-dialog').close();
    saleCard = null;
    msg('Venda registrada e estoque atualizado.');
    await refresh();
  } catch (err) {
    formError('sale-error', err.message);
  } finally {
    formBusy(form, false);
    $('cancel-sale').disabled = false;
  }
});

function renderSales(data) {
  $('sales-total').textContent = money(data.totalCents / 100);
  const target = $('sales-list');
  target.replaceChildren();
  for (const sale of data.items) {
    const entry = el('div', undefined, 'entry');
    entry.append(el('strong', labelFor(sale.card)));
    entry.append(
      el('small', new Date(sale.timestamp).toLocaleString('pt-BR') + ' · ' + sale.username),
    );
    entry.append(
      el(
        'div',
        sale.quantity +
          ' unidade(s) × ' +
          money(sale.unitCents / 100) +
          ' · Total: ' +
          money(sale.totalCents / 100),
        'diff',
      ),
    );
    if (isOwner()) {
      const actions = el('div', undefined, 'actions');
      for (const [action, label, style] of [
        ['restore', 'Voltar para vitrine', 'secondary'],
        ['delete', 'Excluir venda', 'subtle danger'],
      ]) {
        const button = el('button', label, style);
        button.addEventListener('click', () => openSaleAction(sale, action));
        actions.append(button);
      }
      entry.append(actions);
    }
    target.append(entry);
  }
  if (!data.items.length) target.append(el('p', 'Nenhuma venda registrada.'));
}

function openSaleAction(sale, action) {
  saleAction = {
    sale: sale,
    action: action,
  };
  const restoring = action === 'restore';
  $('sale-action-title').textContent = restoring ? 'Voltar para vitrine?' : 'Excluir venda?';
  $('sale-action-name').textContent = labelFor(sale.card);
  $('sale-action-description').textContent = restoring
    ? `Devolver ${sale.quantity} unidade(s) ao estoque e exibir a carta na vitrine. O valor de ${money(sale.totalCents / 100)} será retirado da receita total.`
    : `Excluir esta venda do histórico de vendas e retirar ${money(sale.totalCents / 100)} da receita total. As unidades não voltarão ao estoque. A operação permanecerá no histórico de alterações.`;
  $('confirm-sale-action').textContent = restoring ? 'Confirmar devolução' : 'Confirmar exclusão';
  formError('sale-action-error');
  $('sale-action-dialog').showModal();
}

$('cancel-sale-action').addEventListener('click', () => {
  $('sale-action-dialog').close();
});

$('sale-action-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!saleAction || form.getAttribute('aria-busy') === 'true') return;
  const { sale: sale, action: action } = saleAction;
  formError('sale-action-error');
  formBusy(form, true, 'Confirmando...');
  $('cancel-sale-action').disabled = true;
  try {
    await api(
      'sales/' + encodeURIComponent(sale.id) + (action === 'restore' ? '/restore' : ''),
      action === 'restore' ? 'POST' : 'DELETE',
    );
    $('sale-action-dialog').close();
    saleAction = null;
    msg(
      action === 'restore'
        ? 'Carta devolvida à vitrine. Receita e estoque atualizados.'
        : 'Venda excluída. Receita atualizada; estoque preservado.',
    );
    await refresh();
  } catch (err) {
    formError('sale-action-error', err.message);
  } finally {
    formBusy(form, false);
    $('cancel-sale-action').disabled = false;
  }
});

function changes(a, b) {
  if (!a) return 'Cadastro inicial';
  if (!b) return 'Exclusão';
  const labels = {
    name: 'Nome',
    set: 'Edição',
    rarity: 'Raridade',
    categories: 'Categorias',
    playPokemon: 'Play Pokemon',
    playPokemonNumber: 'Número Play Pokemon',
    commissionClientId: 'Cliente da comissão',
    price: 'Preço',
    quantity: 'Quantidade',
    condition: 'Conservação',
    language: 'Idioma',
    published: 'Visibilidade',
    image: 'Imagem',
    description: 'Descrição',
    game: 'Jogo',
  };
  const value = (row, key) =>
    key === 'categories'
      ? Array.isArray(row[key])
        ? row[key]
        : []
      : key === 'playPokemon'
        ? row[key] === true
        : ['playPokemonNumber', 'commissionClientId'].includes(key)
          ? row[key] || ''
          : row[key];
  const format = (row, key) =>
    key === 'commissionClientId'
      ? clients.find((client) => client.id === row[key])?.name || row[key] || 'Nenhum'
      : key === 'categories'
        ? value(row, key).join(', ') || 'Nenhuma'
        : key === 'playPokemon'
          ? value(row, key)
            ? 'Sim'
            : 'Não'
          : String(row[key] ?? '');
  return (
    Object.keys(labels)
      .filter((k) => JSON.stringify(value(a, k)) !== JSON.stringify(value(b, k)))
      .map((k) => labels[k] + ': ' + format(a, k) + ' → ' + format(b, k))
      .join(' • ') || 'Registro salvo sem alteração de valores'
  );
}

function renderHistory() {
  const target = $('audit-list');
  target.replaceChildren();
  for (const row of history) {
    const div = el('div', undefined, 'entry');
    div.append(el('strong', row.username + ' — ' + row.action + ' — ' + row.card_name));
    div.append(el('small', new Date(row.timestamp).toLocaleString('pt-BR')));
    div.append(el('div', changes(row.before, row.after), 'diff'));
    target.append(div);
  }
  if (!history.length) target.append(el('p', 'Nenhuma alteração registrada.'));
}

function renderUsers() {
  const target = $('users-list');
  target.replaceChildren();
  for (const u of users) {
    const box = el('div', undefined, 'userbox');
    box.append(
      el('strong', u.username),
      el('small', u.role === 'proprietario' ? 'Proprietário' : 'Editor'),
      el('small', 'Criado em ' + new Date(u.created_at).toLocaleDateString('pt-BR')),
    );
    target.append(box);
  }
}

function updateCommissionClients(selected = $('card-client').value) {
  $('card-commission-fields').hidden = !clientsSupported;
  const select = $('card-client');
  select.replaceChildren();
  const blank = el(
    'option',
    clients.length ? 'Selecione o cliente' : 'Cadastre um cliente na aba Clientes',
  );
  blank.value = '';
  select.append(blank);
  for (const client of clients) {
    const option = el(
      'option',
      client.name + ' · ' + client.commissionPercent.toLocaleString('pt-BR') + '%',
    );
    option.value = client.id;
    select.append(option);
  }
  select.value = selected;
  const enabled = clientsSupported && $('card-commission').checked;
  $('card-client-field').hidden = !enabled;
  select.disabled = !enabled;
  select.required = enabled;
}

$('card-commission').addEventListener('change', () => updateCommissionClients());

function renderClients() {
  const target = $('clients-body');
  target.replaceChildren();
  for (const client of clients.slice().sort((a, b) => textCompare(a.name, b.name))) {
    const tr = el('tr');
    for (const [label, value] of [
      ['Nome', client.name],
      ['Telefone', client.phone],
      ['CPF', client.cpf],
      ['Comissão', client.commissionPercent.toLocaleString('pt-BR') + '%'],
    ]) {
      const td = el('td', value);
      td.dataset.label = label;
      tr.append(td);
    }
    const td = el('td');
    td.dataset.label = 'Ações';
    const button = el('button', 'Editar', 'secondary');
    button.addEventListener('click', () => openClient(client));
    td.append(button);
    tr.append(td);
    target.append(tr);
  }
  if (!clients.length) {
    const tr = el('tr'),
      td = el('td', 'Nenhum cliente cadastrado.');
    td.colSpan = 5;
    tr.append(td);
    target.append(tr);
  }
}

function openClient(client = null) {
  clientEditId = client?.id || null;
  $('client-dialog-title').textContent = client ? 'Editar cliente' : 'Cadastrar cliente';
  for (const key of ['name', 'phone', 'cpf']) $('client-' + key).value = client?.[key] || '';
  $('client-percent').value = client?.commissionPercent ?? '';
  formError('client-error');
  $('client-dialog').showModal();
}

$('new-client').addEventListener('click', () => openClient());

$('cancel-client').addEventListener('click', () => $('client-dialog').close());

$('client-dialog').addEventListener('cancel', (event) => {
  if ($('client-form').getAttribute('aria-busy') === 'true') event.preventDefault();
});

$('client-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.getAttribute('aria-busy') === 'true') return;
  const data = {
    name: $('client-name').value.trim(),
    phone: $('client-phone').value.trim(),
    cpf: $('client-cpf').value.trim(),
    commissionPercent: $('client-percent').value,
  };
  formError('client-error');
  formBusy(form, true, 'Salvando...');
  $('cancel-client').disabled = true;
  try {
    const result = await api(
      clientEditId ? 'clients/' + encodeURIComponent(clientEditId) : 'clients',
      clientEditId ? 'PUT' : 'POST',
      data,
    );
    clients = clients.filter((client) => client.id !== result.item.id).concat(result.item);
    renderClients();
    renderCards();
    $('client-dialog').close();
    msg('Cliente salvo.');
  } catch (err) {
    formError('client-error', err.message);
  } finally {
    formBusy(form, false);
    $('cancel-client').disabled = false;
  }
});

for (const [id, path, values, success, label] of [
  [
    'user-form',
    'users',
    () => ({
      username: $('new-username').value,
      password: $('new-userpass').value,
      role: $('new-role').value,
    }),
    'Usuário criado.',
    'Criando...',
  ],
  [
    'password-form',
    'password',
    () => ({
      oldPassword: $('old-password').value,
      newPassword: $('new-password').value,
    }),
    'Senha atualizada.',
    'Atualizando...',
  ],
])
  $(id).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.getAttribute('aria-busy') === 'true') return;
    formError(id + '-error');
    formBusy(form, true, label);
    try {
      await api(path, 'POST', values());
      form.reset();
      msg(success);
      if (path === 'users') await refresh();
    } catch (err) {
      formError(id + '-error', err.message);
    } finally {
      formBusy(form, false);
    }
  });

function rarityFromTCGdex(value) {
  if (rarities.Pokémon.includes(value)) return value;
  const key = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[–—_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    {
      common: 'Comum',
      uncommon: 'Incomum',
      rare: 'Rara',
      'rare holo': 'Rara',
      'rare holographic': 'Rara',
      'double rare': 'Rara Dupla',
      'rare double': 'Rara Dupla',
      'ultra rare': 'Ultra Rara',
      'rare ultra': 'Ultra Rara',
      'ultra raras': 'Ultra Rara',
      'illustration rare': 'Ilustração Rara',
      'rare illustration': 'Ilustração Rara',
      'special illustration rare': 'Ilustração Rara Especial',
      'rare special illustration': 'Ilustração Rara Especial',
      'hyper rare': 'Rara Hiper',
      'rare hyper': 'Rara Hiper',
      'ace spec': 'ACE SPEC',
      'ace spec rare': 'ACE SPEC',
      'rare ace': 'ACE SPEC',
    }[key] || ''
  );
}

function rarityFromScryfall(card) {
  if (card.set === 'sld') return 'SLD';
  return (
    {
      common: 'Comum',
      uncommon: 'Incomum',
      rare: 'Rara',
      mythic: 'Mítica',
    }[card.rarity] || ''
  );
}

const languageLabels = {
  en: 'Inglês',
  pt: 'Português',
  es: 'Espanhol',
  ja: 'Japonês',
  fr: 'Francês',
  de: 'Alemão',
  it: 'Italiano',
};

let printSearchGame = 'Pokémon',
  printSearchVersion = 0,
  previewTimer = null,
  availablePrints = [],
  shownPrints = 0,
  pokemonSetsPromise = null;

let searchController = null,
  selectionController = null,
  selectionVersion = 0;

function searchBusy(busy) {
  $('api-search-btn').disabled = busy;
  $('api-results').setAttribute('aria-busy', String(busy));
}

function cancelSearch() {
  ++printSearchVersion;
  if (searchController) {
    searchController.abort();
    searchController = null;
  }
  if (previewTimer !== null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  searchBusy(false);
}

function cancelSelection() {
  ++selectionVersion;
  if (selectionController) {
    selectionController.abort();
    selectionController = null;
    $('search-status').textContent =
      'Carregamento de detalhes cancelado. Confira os campos antes de salvar.';
  }
}

const visiblePrintsBatch = 36;

const normalizedName = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');

function searchWordTokens(value) {
  return normalizedName(value).trim().split(/\s+/).filter(Boolean);
}

function fitsQuery(name, query) {
  const normalized = normalizedName(name);
  return searchWordTokens(query).every((word) => normalized.includes(word));
}

function getSearchFragment(value) {
  return (
    searchWordTokens(value)
      .filter((x) => x.length >= 2)
      .sort((a, b) => b.length - a.length)[0] || value.trim()
  );
}

function activatePrintSearch(game, clear = true) {
  printSearchGame = game;
  cancelSearch();
  cancelSelection();
  for (const tab of document.querySelectorAll('[data-search-game]')) {
    const selected = tab.dataset.searchGame === game;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  $('magic-set-field').hidden = game !== 'Magic';
  $('magic-lang-field').hidden = game !== 'Magic';
  $('api-search-btn').textContent = game === 'Magic' ? '⌕ Buscar Magic' : '⌕ Buscar Pokémon';
  $('api-search').placeholder =
    game === 'Magic' ? 'Ex.: Mikaeus, the Unhallowed' : 'Ex.: Pikachu, Zoroark...';
  $('search-tip').textContent =
    game === 'Magic'
      ? 'Veja as artes e edições de cada impressão. O código da coleção e o idioma acima filtram as impressões da busca; confira o idioma físico da sua carta no cadastro.'
      : 'Veja as cartas e edições de Pokémon TCG, com suas imagens. Clique na impressão que corresponde à sua carta.';
  if (clear) $('api-search').value = '';
  availablePrints = [];
  shownPrints = 0;
  $('api-results').replaceChildren();
  $('search-status').textContent = '';
  $('more-prints').hidden = true;
}

document.querySelectorAll('[data-search-game]').forEach((tab) => {
  tab.addEventListener('click', () => {
    activatePrintSearch(tab.dataset.searchGame);
    $('api-search').focus();
  });
});

async function pokemonSetNames() {
  if (!pokemonSetsPromise) {
    pokemonSetsPromise = fetch('https://api.tcgdex.net/v2/pt/sets')
      .then((r) => {
        if (!r.ok) throw Error('Coleções indisponíveis');
        return r.json();
      })
      .then((sets) => new Map((Array.isArray(sets) ? sets : []).map((s) => [s.id, s.name])))
      .catch(() => {
        pokemonSetsPromise = null;
        return new Map();
      });
  }
  return pokemonSetsPromise;
}

async function getPokemonPrints(query, preview, version, signal) {
  const fragment = getSearchFragment(query);
  const setNames = await pokemonSetNames();
  if (version !== printSearchVersion || signal.aborted) return [];
  const byId = new Map();
  for (const lang of ['en', 'pt']) {
    let page = 1;
    while (page <= (preview ? 1 : 20)) {
      const params = new URLSearchParams({
        name: 'like:' + fragment,
        'pagination:page': String(page),
        'pagination:itemsPerPage': '160',
      });
      if (version !== printSearchVersion || signal.aborted) return [];
      const response = await fetch(
        'https://api.tcgdex.net/v2/' + lang + '/cards?' + params.toString(),
        {
          signal: signal,
        },
      );
      if (!response.ok) {
        if (lang === 'en') break;
        if (!byId.size) throw Error('TCGdex não conseguiu carregar as impressões.');
        break;
      }
      const batch = await response.json();
      if (version !== printSearchVersion) return [];
      if (!Array.isArray(batch)) break;
      for (const card of batch) {
        if (card.id && fitsQuery(card.name, query))
          byId.set(card.id, {
            ...card,
            tcgdexLanguage: lang,
          });
      }
      if (batch.length < 160) break;
      page++;
    }
  }
  return [...byId.values()]
    .map((card) => {
      const code = card.id?.split('-')[0] || '';
      const number = card.localId || card.id?.slice(code.length + 1) || '';
      return {
        game: 'Pokémon',
        name: card.name,
        edition: setNames.get(code) || code,
        number: number,
        set: [setNames.get(code) || code, number].filter(Boolean).join(' · '),
        image: card.image ? card.image + '/high.webp' : '',
        tcgdexId: card.id,
        tcgdexLanguage: card.tcgdexLanguage,
        rarity: '',
        printLang: card.tcgdexLanguage,
        printKey: 'poke:' + card.id,
      };
    })
    .sort(
      (a, b) =>
        a.edition.localeCompare(b.edition, 'pt-BR') ||
        a.number.localeCompare(b.number, 'pt-BR', {
          numeric: true,
        }),
    );
}

async function getLocalizedMagicName(query, signal) {
  try {
    const data = await api(
      'search/nomes-pt?q=' + encodeURIComponent(query),
      'GET',
      undefined,
      signal,
    );
    if (data.status === 'pronto' && Array.isArray(data.items) && data.items.length) {
      const exact = data.items.find(
        (x) => normalizedName(x.localizedName) === normalizedName(query),
      );
      return (exact || data.items[0]).name || query;
    }
  } catch (_) {}
  return query;
}

async function getMagicPrints(query, preview, version, signal) {
  const code = $('magic-set-code').value.trim().toLocaleLowerCase('en-US');
  const lang = $('magic-print-lang').value;
  const canonical = await getLocalizedMagicName(query, signal);
  if (version !== printSearchVersion || signal.aborted) return [];
  const terms = searchWordTokens(canonical);
  const searchParts = terms.map((term) => 'name:"' + term.replace(/["\\]/g, '') + '"');
  if (code) searchParts.push('set:' + code.replace(/[^a-z0-9]/g, ''));
  searchParts.push('lang:' + lang);
  const params = new URLSearchParams({
    q: searchParts.join(' '),
    unique: 'prints',
    order: 'released',
    dir: 'desc',
    include_multilingual: 'true',
    include_variations: 'true',
  });
  let url = 'https://api.scryfall.com/cards/search?' + params.toString();
  const prints = [];
  let page = 0;
  while (url && page < (preview ? 1 : 25)) {
    if (version !== printSearchVersion || signal.aborted) return [];
    const response = await fetch(url, {
      signal: signal,
    });
    if (version !== printSearchVersion) return [];
    if (!response.ok) {
      if (response.status === 404) break;
      throw Error('Scryfall não conseguiu carregar as edições.');
    }
    const data = await response.json();
    if (!Array.isArray(data.data)) throw Error('Resposta inesperada do Scryfall.');
    prints.push(...data.data);
    const next = typeof data.next_page === 'string' ? data.next_page : '';
    url = data.has_more && next.startsWith('https://api.scryfall.com/cards/search?') ? next : null;
    page++;
    if (url) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const mapped = prints.map((card) => ({
    game: 'Magic',
    name: card.printed_name || card.name,
    canonicalName: card.name,
    edition: card.set_name || card.set,
    number: card.collector_number || '',
    set: [card.set_name || card.set, card.collector_number].filter(Boolean).join(' · '),
    image: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || '',
    rarity: rarityFromScryfall(card),
    printLang: card.lang || lang,
    scryfallId: card.id,
    scryfallSet: card.set,
    scryfallNumber: card.collector_number,
    scryfallLanguage: card.lang,
    printKey: 'magic:' + card.id,
  }));
  return mapped;
}

function printResultCard(card) {
  const button = el('button', undefined, 'print-card');
  button.type = 'button';
  button.title = 'Selecionar ' + card.name + ' · ' + card.set;
  if (card.image) {
    const image = el('img');
    image.src = card.image;
    image.loading = 'lazy';
    image.alt = 'Imagem da impressão ' + card.name;
    button.append(image);
  } else button.append(el('div', 'Imagem indisponível', 'print-placeholder'));
  button.append(el('strong', card.name), el('small', card.edition));
  button.append(
    el(
      'small',
      '#' + card.number + ' · ' + (languageLabels[card.printLang] || card.printLang || ''),
    ),
  );
  button.append(el('small', '+ Cadastrar esta impressão', 'print-card-action'));
  button.addEventListener('click', () => choosePrint(card));
  return button;
}

function appendPrintCards() {
  const target = $('api-results');
  const finish = Math.min(shownPrints + visiblePrintsBatch, availablePrints.length);
  for (let i = shownPrints; i < finish; i++) target.append(printResultCard(availablePrints[i]));
  shownPrints = finish;
  $('more-prints').hidden = shownPrints >= availablePrints.length;
  $('more-prints').textContent =
    'Mostrar mais impressões (' + (availablePrints.length - shownPrints) + ' restantes)';
}

$('more-prints').addEventListener('click', appendPrintCards);

async function choosePrint(card) {
  if ($('card-form').getAttribute('aria-busy') === 'true' || !$('card-dialog').open) return;
  cancelSearch();
  cancelSelection();
  const version = selectionVersion;
  $('card-game').value = card.game;
  updateRarities(card.game, card.rarity);
  updateCategories(card.game, selectedCategories());
  updatePlayPokemon();
  $('card-name').value = card.name;
  $('card-set').value = card.set;
  $('card-image').value = card.image || '';
  extras = {
    ...extras,
    tcgdexId: card.game === 'Pokémon' ? card.tcgdexId || '' : '',
    tcgdexLanguage: card.game === 'Pokémon' ? card.tcgdexLanguage || '' : '',
    scryfall: card.game === 'Magic' ? card.canonicalName || card.name : '',
    scryfallId: card.game === 'Magic' ? card.scryfallId || '' : '',
    scryfallSet: card.game === 'Magic' ? card.scryfallSet || '' : '',
    scryfallNumber: card.game === 'Magic' ? card.scryfallNumber || '' : '',
    scryfallLanguage: card.game === 'Magic' ? card.scryfallLanguage || '' : '',
  };
  let detailLoaded = false;
  $('search-status').textContent =
    'Impressão selecionada: ' + card.name + '. Carregando detalhes...';
  if (card.game === 'Pokémon' && card.tcgdexId) {
    const controller = new AbortController();
    selectionController = controller;
    try {
      const lang = card.tcgdexLanguage || 'pt';
      const response = await fetch(
        'https://api.tcgdex.net/v2/' + lang + '/cards/' + encodeURIComponent(card.tcgdexId),
        {
          signal: controller.signal,
        },
      );
      if (response.ok) {
        const d = await response.json();
        if (version !== selectionVersion || !$('card-dialog').open || controller.signal.aborted)
          return;
        if (d.id === card.tcgdexId) {
          $('card-set').value = [d.set?.name || card.edition, d.localId || card.number]
            .filter(Boolean)
            .join(' · ');
          updateRarities('Pokémon', rarityFromTCGdex(d.rarity));
          if (d.image) $('card-image').value = d.image + '/high.webp';
          detailLoaded = true;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    } finally {
      if (selectionController === controller) selectionController = null;
    }
  }
  if (version !== selectionVersion || !$('card-dialog').open) return;
  const review = $('card-rarity').value
    ? ''
    : ' Raridade não reconhecida; selecione-a manualmente.';
  $('search-status').textContent =
    'Impressão selecionada: ' +
    card.name +
    ' — ' +
    card.set +
    '.' +
    review +
    (card.game === 'Pokémon' && !detailLoaded ? ' Não foi possível completar os detalhes.' : '') +
    ' Confira idioma, preço e conservação antes de salvar.';
  $('card-name').focus();
}

async function runPrintSearch(preview = false) {
  cancelSearch();
  cancelSelection();
  const query = $('api-search').value.trim();
  if (query.length < 2) {
    if (!preview) $('search-status').textContent = 'Digite pelo menos 2 letras para pesquisar.';
    return;
  }
  const version = printSearchVersion;
  const controller = new AbortController();
  searchController = controller;
  const game = printSearchGame;
  const status = $('search-status');
  status.textContent =
    'Buscando ' + (game === 'Magic' ? 'impressões no Scryfall...' : 'impressões na TCGdex...');
  searchBusy(true);
  try {
    const result =
      game === 'Magic'
        ? await getMagicPrints(query, preview, version, controller.signal)
        : await getPokemonPrints(query, preview, version, controller.signal);
    if (version !== printSearchVersion || !$('card-dialog').open) return;
    availablePrints = result.slice().sort(compareCardAlphabetically);
    shownPrints = 0;
    $('api-results').replaceChildren();
    if (!result.length)
      status.textContent = 'Nenhuma impressão encontrada. Experimente outro nome ou idioma.';
    else {
      status.textContent =
        result.length +
        ' ' +
        (result.length === 1 ? 'impressão encontrada' : 'impressões encontradas') +
        (preview ? ' · Prévia automática; clique em Buscar para ver mais.' : '') +
        '. Clique na arte e edição desejadas.';
      appendPrintCards();
    }
  } catch (err) {
    if (version === printSearchVersion && err.name !== 'AbortError')
      status.textContent = err.message + ' Você ainda pode cadastrar manualmente.';
  } finally {
    if (version === printSearchVersion) {
      searchBusy(false);
      searchController = null;
    }
  }
}

function schedulePrintPreview() {
  cancelSearch();
  cancelSelection();
  if ($('api-search').value.trim().length < 3) {
    availablePrints = [];
    $('api-results').replaceChildren();
    $('more-prints').hidden = true;
    $('search-status').textContent = '';
    return;
  }
  previewTimer = setTimeout(() => runPrintSearch(true), 650);
}

$('api-search').addEventListener('input', schedulePrintPreview);

$('magic-set-code').addEventListener('input', schedulePrintPreview);

$('magic-print-lang').addEventListener('change', () => runPrintSearch(true));

$('api-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runPrintSearch(false);
  }
});

$('api-search-btn').addEventListener('click', () => runPrintSearch(false));

setInterval(() => {
  if (signed)
    api('status')
      .then(renderStatus)
      .catch(() => {});
}, 30000);

start();
