'use strict';

const test = require('node:test');

const assert = require('node:assert/strict');

const fs = require('node:fs');

const path = require('node:path');

const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

function element() {
  const listeners = {},
    attributes = {};
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    hidden: false,
    open: false,
    children: [],
    dataset: {},
    parentElement: {
      dataset: {},
    },
    classList: {
      toggle() {},
    },
    focus() {},
    reset() {},
    setAttribute(key, value) {
      attributes[key] = value;
    },
    getAttribute(key) {
      return attributes[key] ?? null;
    },
    addEventListener(name, fn) {
      (listeners[name] ??= []).push(fn);
    },
    async emit(name) {
      for (const fn of listeners[name] || [])
        await fn({
          currentTarget: this,
          preventDefault() {},
        });
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    querySelector() {
      return (this.submitButton ??= element());
    },
    querySelectorAll(selector) {
      const descendants = this.children.flatMap((node) => [node, ...node.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      return selector === 'input:checked'
        ? descendants.filter((node) => node.type === 'checkbox' && node.checked)
        : [];
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
}

function panel(
  fetch = async () => {
    throw Error('Unexpected network request');
  },
) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const document = {
    getElementById: get,
    querySelector: () => ({
      content: 'test-csrf',
    }),
    querySelectorAll: () => [],
    createElement: element,
  };
  const context = vm.createContext({
    document: document,
    fetch: fetch,
    AbortController: AbortController,
    URLSearchParams: URLSearchParams,
    Intl: Intl,
    crypto: require('node:crypto').webcrypto,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: () => 0,
    confirm: () => true,
  });
  const source = fs
    .readFileSync(path.join(root, 'windows-admin/static/painel.js'), 'utf8')
    .replace(/\nstart\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext('playPokemonSupported=true', context);
  get('card-game').value = 'Pokémon';
  get('card-dialog').open = true;
  return {
    get: get,
    run: (code) => vm.runInContext(code, context),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return {
    promise: promise,
    resolve: resolve,
  };
}

const response = (data) => ({
  ok: true,
  json: async () => data,
});

const pokemon = (id, name) => ({
  game: 'Pokémon',
  name: name,
  set: 'Initial ' + id,
  edition: 'Initial',
  number: id,
  tcgdexId: id,
  tcgdexLanguage: 'pt',
  image: 'https://example.test/' + id,
  rarity: '',
});

test('comissão seleciona cliente e preserva vínculo ao adicionar cópia', async () => {
  let payload;
  const p = panel(async (url, opts) => {
    if (url === '/api/cards' && opts.method === 'POST') {
      payload = JSON.parse(opts.body);
      return response({});
    }
    throw Error('Offline');
  });
  p.run(
    `clientsSupported=true;clients=[{id:'client-test',name:'Cliente de teste',commissionPercent:12.5}];openForm({id:'original',name:'Carta',game:'Magic',rarity:'Rara',commissionClientId:'client-test'})`,
  );
  assert.equal(p.get('card-commission').checked, true);
  assert.equal(p.get('card-client').value, 'client-test');
  assert.equal(p.get('card-client').required, true);
  assert.equal(p.get('card-client-field').hidden, false);
  await p.get('duplicate-card').emit('click');
  await p.get('card-form').emit('submit');
  assert.equal(payload.commissionClientId, 'client-test');
  assert.equal(payload.quantity, 1);
  assert.equal('cpf' in payload, false);
  assert.equal('commissionPercent' in payload, false);
});

test('comissão exige cliente e desmarcar remove o vínculo', async () => {
  let payload,
    calls = 0;
  const p = panel(async (url, opts) => {
    calls++;
    if (opts.method === 'POST') {
      payload = JSON.parse(opts.body);
      return response({});
    }
    throw Error('Offline');
  });
  p.run(`clientsSupported=true;openForm();`);
  p.get('card-commission').checked = true;
  await p.get('card-commission').emit('change');
  await p.get('card-form').emit('submit');
  assert.equal(calls, 0);
  assert.match(p.get('card-error').textContent, /cliente cadastrado/);
  p.get('card-commission').checked = false;
  await p.get('card-commission').emit('change');
  assert.equal(p.get('card-client').disabled, true);
  assert.equal(p.get('card-client').required, false);
  await p.get('card-form').emit('submit');
  assert.equal(payload.commissionClientId, '');
});

test('cadastro de cliente bloqueia envio duplicado e permite editar', async () => {
  const d = deferred();
  let calls = 0,
    payload,
    url;
  const p = panel((path, opts) => {
    calls++;
    url = path;
    payload = JSON.parse(opts.body);
    return d.promise;
  });
  p.run(
    `openClient({id:'client-test',name:'Cliente de teste',phone:'11999990000',cpf:'00000000000',commissionPercent:12.5})`,
  );
  assert.equal(p.get('client-name').value, 'Cliente de teste');
  p.get('client-percent').value = '15';
  const pending = p.get('client-form').emit('submit');
  await p.get('client-form').emit('submit');
  assert.equal(calls, 1);
  assert.equal(url, '/api/clients/client-test');
  assert.equal(payload.commissionPercent, '15');
  d.resolve(
    response({
      item: {
        id: 'client-test',
        ...payload,
        commissionPercent: 15,
      },
    }),
  );
  await pending;
  assert.equal(p.get('client-dialog').open, false);
  assert.equal(p.run('clients[0].commissionPercent'), 15);
});

test('erro ao salvar cliente mantém formulário e valores para correção', async () => {
  const p = panel(async () => ({
    ok: false,
    json: async () => ({
      error: 'Já existe um cliente com esse CPF.',
    }),
  }));
  p.run('openClient()');
  p.get('client-name').value = 'Cliente de teste';
  await p.get('client-form').emit('submit');
  assert.equal(p.get('client-dialog').open, true);
  assert.equal(p.get('client-name').value, 'Cliente de teste');
  assert.match(p.get('client-error').textContent, /CPF/);
  assert.equal(p.get('cancel-client').disabled, false);
});

test('a resposta de uma seleção anterior não sobrescreve outra carta', async () => {
  const requests = [];
  const p = panel((url, opts) => {
    const d = deferred();
    requests.push({
      ...d,
      signal: opts.signal,
    });
    return d.promise;
  });
  const first = p.run(`choosePrint(${JSON.stringify(pokemon('a', 'First'))})`);
  const second = p.run(`choosePrint(${JSON.stringify(pokemon('b', 'Second'))})`);
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(
    response({
      id: 'b',
      set: {
        name: 'Correct B',
      },
      localId: '2',
      rarity: 'Rare Double',
    }),
  );
  await second;
  requests[0].resolve(
    response({
      id: 'a',
      set: {
        name: 'Wrong A',
      },
      localId: '1',
      rarity: 'Common',
    }),
  );
  await first;
  assert.equal(p.get('card-name').value, 'Second');
  assert.equal(p.get('card-set').value, 'Correct B · 2');
  assert.equal(p.get('card-rarity').value, 'Rara Dupla');
  assert.equal(p.get('api-search-btn').disabled, false);
});

test('fechar e reabrir o formulário invalida detalhes pendentes', async () => {
  const d = deferred();
  const p = panel(() => d.promise);
  const pending = p.run(`choosePrint(${JSON.stringify(pokemon('a', 'First'))})`);
  p.run(
    `closeForm();openForm({id:'existing',game:'Magic',name:'Existing',set:'Keep me',rarity:'Mítica',language:'Japonês',scryfallId:'print-id'})`,
  );
  d.resolve(
    response({
      id: 'a',
      set: {
        name: 'Wrong',
      },
      localId: '1',
      rarity: 'Common',
    }),
  );
  await pending;
  assert.equal(p.get('card-set').value, 'Keep me');
  assert.equal(p.get('card-game').value, 'Magic');
  assert.equal(p.get('card-language').value, 'Japonês');
  assert.equal(p.run('extras.scryfallId'), 'print-id');
});

test('edição manual tem prioridade sobre detalhes pendentes', async () => {
  const d = deferred();
  const p = panel(() => d.promise);
  const pending = p.run(`choosePrint(${JSON.stringify(pokemon('a', 'First'))})`);
  p.get('card-set').value = 'Manual edition';
  await p.get('card-set').emit('input');
  d.resolve(
    response({
      id: 'a',
      set: {
        name: 'API edition',
      },
      localId: '1',
      rarity: 'Common',
    }),
  );
  await pending;
  assert.equal(p.get('card-set').value, 'Manual edition');
});

test('trocar a busca de jogo libera o botão e impede consultas obsoletas', async () => {
  const d = deferred();
  let calls = 0;
  const p = panel(() => {
    calls++;
    return d.promise;
  });
  p.get('api-search').value = 'Pikachu';
  const pending = p.run('runPrintSearch(false)');
  assert.equal(p.get('api-search-btn').disabled, true);
  p.run(`activatePrintSearch('Magic')`);
  assert.equal(p.get('api-search-btn').disabled, false);
  d.resolve(response([]));
  await pending;
  assert.equal(calls, 1);
  assert.equal(p.get('api-results').getAttribute('aria-busy'), 'false');
  assert.equal(p.get('api-search-btn').disabled, false);
});

test('raridade desconhecida exige escolha e o idioma físico é preservado', async () => {
  const p = panel();
  p.get('card-language').value = 'Japonês';
  await p.run(
    `choosePrint({game:'Magic',name:'Example',set:'Test',rarity:'unexpected',scryfallId:'id',printLang:'en'})`,
  );
  assert.equal(p.get('card-rarity').value, '');
  assert.equal(p.get('card-language').value, 'Japonês');
  assert.match(p.get('search-status').textContent, /selecione-a manualmente/);
  assert.equal(p.run(`rarityFromTCGdex('Rare Special Illustration')`), 'Ilustração Rara Especial');
  assert.equal(p.run(`rarityFromTCGdex('Unrecognized')`), '');
});

test('categorias acompanham o jogo e permitem múltipla seleção sem mudar a raridade', async () => {
  const p = panel();
  p.run(`openForm({game:'Pokémon',name:'Pikachu',rarity:'Rara',categories:['Foil','Full Art']})`);
  const options = () => p.get('card-categories').children.map((label) => label.children[0].value);
  assert.deepEqual(options(), ['Foil', 'Reverse Foil', 'Full Art']);
  assert.deepEqual(Array.from(p.run('selectedCategories()')), ['Foil', 'Full Art']);
  assert.equal(p.get('card-rarity').value, 'Rara');
  p.get('card-game').value = 'Magic';
  await p.get('card-game').emit('change');
  assert.deepEqual(options(), ['Foil', 'Foil Especial', 'Promo']);
  assert.deepEqual(Array.from(p.run('selectedCategories()')), ['Foil']);
  p.run('openForm()');
  assert.deepEqual(Array.from(p.run('selectedCategories()')), []);
});

test('escolher uma impressão mantém as categorias compatíveis e o histórico as descreve', async () => {
  const p = panel();
  p.run(`openForm({game:'Magic',name:'Example',rarity:'Rara',categories:['Foil','Promo']})`);
  await p.run(
    `choosePrint({game:'Magic',name:'Another print',set:'Test',rarity:'Mítica',scryfallId:'id'})`,
  );
  assert.deepEqual(Array.from(p.run('selectedCategories()')), ['Foil', 'Promo']);
  assert.equal(p.get('card-rarity').value, 'Mítica');
  assert.match(
    p.run(`changes({categories:[]},{categories:['Foil','Promo']})`),
    /Categorias: Nenhuma → Foil, Promo/,
  );
  assert.equal(p.run(`changes({}, {categories:[]})`), 'Registro salvo sem alteração de valores');
});

test('categorias são enviadas pelo formulário', async () => {
  let payload;
  const p = panel(async (url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: false,
      json: async () => ({
        error: 'Test',
      }),
    };
  });
  p.run(
    `openForm({game:'Magic',name:'Example',rarity:'Rara',categories:['Foil Especial','Promo']})`,
  );
  await p.get('card-form').emit('submit');
  assert.deepEqual(payload.categories, ['Foil Especial', 'Promo']);
  assert.equal(payload.rarity, 'Rara');
});

test('vitrine normaliza categorias por jogo e mantém cartas antigas compatíveis', () => {
  const context = vm.createContext({
    window: {},
    localStorage: {
      getItem: () => null,
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/catalog-shared.js'), 'utf8'), context);
  const normalize = context.window.MarketplaceCatalog.normalize;
  assert.deepEqual(
    Array.from(
      normalize({
        game: 'Pokémon',
        name: 'Example',
      }).categories,
    ),
    [],
  );
  assert.deepEqual(
    Array.from(
      normalize({
        game: 'Pokémon',
        name: 'Example',
        categories: ['Full Art', 'Foil', 'Foil', 'Promo'],
      }).categories,
    ),
    ['Foil', 'Full Art'],
  );
  assert.deepEqual(
    Array.from(
      normalize({
        game: 'Magic',
        name: 'Example',
        categories: ['Reverse Foil', 'Promo', 'Foil Especial'],
      }).categories,
    ),
    ['Foil Especial', 'Promo'],
  );
  assert.deepEqual(
    Array.from(
      normalize({
        game: 'Magic',
        name: 'Example',
        categories: 'Foil',
      }).categories,
    ),
    [],
  );
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  vm.runInContext(
    source.slice(
      source.indexOf('function inventory(c)'),
      source.indexOf('function updateFilterHighlights()'),
    ),
    context,
  );
  context.e = context.window.MarketplaceCatalog.safeText;
  const inventory = context.inventory({
    categories: ['Foil', 'Full Art'],
    quantity: 2,
    condition: 'NM',
    language: 'English',
  });
  assert.doesNotMatch(inventory, /Foil|Full Art/);
  assert.deepEqual(
    Array.from(inventory.matchAll(/>([^<]+)<\/span>/g), (match) => match[1]),
    ['2 Unidades', 'NM', 'English'],
  );
  assert.match(
    context.inventory({
      quantity: 1,
      condition: 'NM',
    }),
    /1 Unidade<\/span><span class="inventory-pill">NM/,
  );
  assert.match(
    context.inventory({
      quantity: 0,
      condition: 'NM',
    }),
    /class="inventory-pill out">Esgotada/,
  );
});

test('salvar duas vezes gera uma requisição e mostra falhas no formulário', async () => {
  const d = deferred();
  let calls = 0;
  const p = panel(() => {
    calls++;
    return d.promise;
  });
  p.get('card-name').value = 'Preserve this';
  p.get('card-rarity').value = 'Comum';
  p.get('card-language').value = 'Português';
  const first = p.get('card-form').emit('submit');
  await p.get('card-form').emit('submit');
  assert.equal(calls, 1);
  assert.equal(p.get('card-form').querySelector().disabled, true);
  d.resolve({
    ok: false,
    json: async () => ({
      error: 'Falha de teste',
    }),
  });
  await first;
  assert.equal(p.get('card-error').textContent, 'Falha de teste');
  assert.equal(p.get('card-dialog').open, true);
  assert.equal(p.get('card-name').value, 'Preserve this');
  assert.equal(p.get('card-form').querySelector().disabled, false);
});

test('catálogo preserva todos os registros acima de 2.500 cartas', () => {
  const context = vm.createContext({
    window: {},
    localStorage: {
      getItem: () => null,
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/catalog-shared.js'), 'utf8'), context);
  const items = Array.from(
    {
      length: 3001,
    },
    (_, i) => ({
      id: 'c' + i,
      name: 'Carta ' + i,
      game: 'Magic',
      published: true,
    }),
  );
  const catalog = context.window.MarketplaceCatalog.normalizeCatalog({
    items: items,
  });
  assert.equal(catalog.items.length, 3001);
  assert.equal(catalog.items[3000].id, 'c3000');
});

function storefront(sort, min = '', max = '') {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const context = vm.createContext({
    cards: [
      {
        id: 'unknown',
        name: 'Consulta',
        price: null,
        published: true,
      },
      {
        id: 'zero',
        name: 'Grátis',
        price: 0,
        published: true,
      },
      {
        id: 'paid',
        name: 'Preço',
        price: 10,
        published: true,
      },
    ],
    window: {},
    displayedCards: [],
    search: {
      value: '',
    },
    selectedGame: 'all',
    selectedSuggestion: null,
    minPrice: {
      value: min,
      valueAsNumber: Number(min),
    },
    maxPrice: {
      value: max,
      valueAsNumber: Number(max),
    },
    sortBy: {
      value: sort,
    },
    PAGE_SIZE: 12,
    currentPage: 1,
    grid: get('grid'),
    pagination: get('pagination'),
    paginationInfo: get('paginationInfo'),
    document: {
      getElementById: get,
    },
    updateFilterHighlights() {},
    e: String,
    imageFor: () => '',
    inventory: () => '',
    store: {
      money: String,
    },
    placeholder: '',
  });
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  vm.runInContext(
    fs.readFileSync(path.join(root, 'assets/search-suggestions.js'), 'utf8'),
    context,
  );
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/catalog-groups.js'), 'utf8'), context);
  vm.runInContext(
    source.slice(
      source.indexOf('function playPokemonBadge('),
      source.indexOf('function openCard('),
    ) + '\nrender();',
    context,
  );
  return Array.from(get('grid').innerHTML.matchAll(/<h3>(.*?)<\/h3>/g), (match) => match[1]);
}

test('preços sob consulta ficam ao final nas duas ordenações', () => {
  assert.deepEqual(storefront('priceAsc'), ['Grátis', 'Preço', 'Consulta']);
  assert.deepEqual(storefront('priceDesc'), ['Preço', 'Grátis', 'Consulta']);
});

test('filtros de preço excluem valores desconhecidos e preservam zero', () => {
  assert.deepEqual(storefront('priceAsc', '0'), ['Grátis', 'Preço']);
  assert.deepEqual(storefront('priceAsc', '', '5'), ['Grátis']);
});

function searchLibrary(
  fetch = async () => {
    throw Error('Offline');
  },
  extra = {},
) {
  const context = vm.createContext({
    window: {},
    fetch: fetch,
    AbortController: AbortController,
    URLSearchParams: URLSearchParams,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    ...extra,
  });
  vm.runInContext(
    fs.readFileSync(path.join(root, 'assets/search-suggestions.js'), 'utf8'),
    context,
  );
  return context.window.MarketplaceSearch;
}

test('sugestões combinam os jogos, deduplicam e limitam aos cinco nomes mais próximos', () => {
  const lib = searchLibrary();
  const items = [
    {
      name: 'Sol Ring',
      game: 'Magic',
    },
    {
      name: 'Sol Ring',
      game: 'Magic',
    },
    {
      name: 'Solrock',
      game: 'Pokémon',
    },
    {
      name: 'Solitude',
      game: 'Magic',
    },
    {
      name: 'Sol Grail',
      game: 'Magic',
    },
    {
      name: 'Solrock ex',
      game: 'Pokémon',
    },
    {
      name: 'Sol Ring',
      game: 'Pokémon',
    },
    {
      name: 'Completely unrelated',
      game: 'Magic',
    },
  ];
  const ranked = lib.rank(items, 'sol', 'all');
  assert.equal(ranked.length, 5);
  assert.equal(new Set(ranked.map((item) => item.game + item.name)).size, 5);
  assert.ok(ranked.some((item) => item.game === 'Magic'));
  assert.ok(ranked.some((item) => item.game === 'Pokémon'));
  assert.ok(lib.rank(items, 'sol', 'Magic').every((item) => item.game === 'Magic'));
  assert.equal(
    lib.rank(
      [
        {
          name: 'Clarita',
          game: 'Pokémon',
        },
        {
          name: 'Clarita ex',
          game: 'Pokémon',
        },
      ],
      'clarita',
    )[0].name,
    'Clarita',
  );
  assert.equal(
    lib.rank(
      [
        {
          name: 'Flabébé',
          game: 'Pokémon',
        },
      ],
      'flabebe',
    )[0].name,
    'Flabébé',
  );
});

test('cada universo consulta sua biblioteca e Todos consulta as duas', async () => {
  const requests = [];
  const lib = searchLibrary(async (url) => {
    requests.push(url);
    if (url.includes('tcgdex'))
      return response([
        {
          name: 'Solrock',
        },
      ]);
    if (url.includes('autocomplete'))
      return response({
        data: ['Sol Ring'],
      });
    return response({
      data: [
        {
          name: 'Sol Ring',
          printed_name: 'Anel Solar',
        },
      ],
    });
  });
  const signal = new AbortController().signal;
  const pokemon = await lib.fetchSuggestions('sol', 'Pokémon', signal);
  assert.ok(requests.every((url) => url.startsWith('https://api.tcgdex.net/')));
  assert.ok(pokemon.every((item) => item.game === 'Pokémon'));
  requests.length = 0;
  const magic = await lib.fetchSuggestions('sol', 'Magic', signal);
  assert.ok(requests.every((url) => url.startsWith('https://api.scryfall.com/')));
  assert.ok(magic.every((item) => item.game === 'Magic'));
  requests.length = 0;
  const all = await lib.fetchSuggestions('sol', 'all', signal);
  assert.ok(all.some((item) => item.game === 'Pokémon'));
  assert.ok(all.some((item) => item.game === 'Magic'));
  assert.ok(requests.some((url) => url.includes('tcgdex')));
  assert.ok(requests.some((url) => url.includes('scryfall')));
});

test('falha de uma biblioteca não elimina sugestões da outra', async () => {
  const lib = searchLibrary(async (url) => {
    if (url.includes('scryfall')) throw Error('Offline');
    return response([
      {
        name: 'Pikachu',
      },
    ]);
  });
  const results = await lib.fetchSuggestions('pika', 'all', new AbortController().signal);
  assert.equal(lib.rank(results, 'pika').length, 1);
  assert.equal(results[0].game, 'Pokémon');
});

test('seleção de nome traduzido encontra o catálogo pelo nome canônico e respeita o jogo', () => {
  const lib = searchLibrary();
  const selected = {
    name: 'Anel Solar',
    game: 'Magic',
    aliases: ['Anel Solar', 'Sol Ring'],
  };
  assert.equal(
    lib.matchesCard(
      {
        name: 'Sol Ring',
        game: 'Magic',
      },
      'Anel Solar',
      selected,
    ),
    true,
  );
  assert.equal(
    lib.matchesCard(
      {
        name: 'Sol Ring',
        game: 'Pokémon',
      },
      'Anel Solar',
      selected,
    ),
    false,
  );
  assert.equal(
    lib.matchesCard(
      {
        name: 'Zoroark ex do N',
        game: 'Pokémon',
      },
      'n zoroark',
    ),
    true,
  );
  assert.equal(
    lib.matchesCard(
      {
        name: 'Flabébé',
        game: 'Pokémon',
      },
      'flabebe',
    ),
    true,
  );
  assert.equal(
    lib.matchesCard(
      {
        name: 'Clarita',
        set: 'Escuridão Absoluta',
        game: 'Pokémon',
      },
      'sol',
    ),
    false,
  );
});

test('respostas de buscas antigas não substituem as sugestões da busca atual', async () => {
  const timers = new Map();
  let nextTimer = 0;
  const pending = [];
  const input = element(),
    container = element();
  const document = {
    createElement: element,
    addEventListener() {},
  };
  const lib = searchLibrary(
    (url) => {
      const d = deferred();
      pending.push({
        ...d,
        url: url,
      });
      return d.promise;
    },
    {
      document: document,
      setTimeout(fn, ms) {
        const id = ++nextTimer;
        timers.set(id, {
          fn: fn,
          ms: ms,
        });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  );
  const attached = lib.attach({
    input: input,
    container: container,
    getGame: () => 'Pokémon',
    getCards: () => [],
    onSelect() {},
  });
  const runDebounce = () => {
    for (const [id, timer] of timers)
      if (timer.ms === 650) {
        timers.delete(id);
        timer.fn();
      }
  };
  input.value = 'pika';
  await input.emit('input');
  runDebounce();
  input.value = 'char';
  await input.emit('input');
  runDebounce();
  pending[2].resolve(
    response([
      {
        name: 'Charizard',
      },
    ]),
  );
  pending[3].resolve(
    response([
      {
        name: 'Charizard ex',
      },
    ]),
  );
  await new Promise(setImmediate);
  assert.equal(container.children[0].children[0].textContent, 'Charizard');
  pending[0].resolve(
    response([
      {
        name: 'Pikachu',
      },
    ]),
  );
  pending[1].resolve(
    response([
      {
        name: 'Pikachu ex',
      },
    ]),
  );
  await new Promise(setImmediate);
  assert.equal(container.children[0].children[0].textContent, 'Charizard');
  attached.clear();
  assert.equal(container.hidden, true);
});

test('sugestão local é clicável, segura e não inclui cartas ocultas', async () => {
  const input = element(),
    container = element();
  let selected;
  const lib = searchLibrary(undefined, {
    document: {
      createElement: element,
      addEventListener() {},
    },
  });
  const attached = lib.attach({
    input: input,
    container: container,
    getGame: () => 'Magic',
    getCards: () => [
      {
        name: 'Sol <script>',
        game: 'Magic',
        published: true,
      },
      {
        name: 'Sol hidden',
        game: 'Magic',
        published: false,
      },
    ],
    onSelect: (item) => {
      selected = item;
    },
  });
  input.value = 'sol';
  await input.emit('input');
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].children[0].textContent, 'Sol <script>');
  assert.equal(container.children[0].children[0].innerHTML, '');
  await container.children[0].emit('click');
  assert.equal(input.value, 'Sol <script>');
  assert.equal(selected.game, 'Magic');
  assert.equal(container.hidden, true);
  attached.clear();
});

function groupCatalog(cards) {
  const context = vm.createContext({
    window: {},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/catalog-groups.js'), 'utf8'), context);
  return context.window.MarketplaceGroups.group(cards);
}

test('edições diferentes usam preço, conservação e arte da mais barata e somam estoque', () => {
  const cards = [
    {
      id: 'expensive',
      game: 'Pokémon',
      name: 'Zoroark ex do N',
      set: 'Amigos de Jornada · 098',
      price: 18,
      quantity: 1,
      condition: 'NM',
      image: 'https://example.test/expensive',
      published: true,
    },
    {
      id: 'cheap',
      game: 'Pokémon',
      name: 'Zoroark ex do N',
      set: 'Heróis Excelsos · 137',
      price: 17,
      quantity: 3,
      condition: 'SP',
      image: 'https://example.test/cheap',
      published: true,
    },
  ];
  const original = JSON.stringify(cards),
    groups = groupCatalog(cards);
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.price, 17);
  assert.equal(group.quantity, 4);
  assert.equal(group.condition, 'SP');
  assert.equal(group.image, 'https://example.test/cheap');
  assert.equal(group.id, 'cheap');
  assert.equal(group.editionCount, 2);
  assert.deepEqual(
    Array.from(group.variants, (card) => [card.set, card.price, card.quantity]),
    [
      ['Heróis Excelsos · 137', 17, 3],
      ['Amigos de Jornada · 098', 18, 1],
    ],
  );
  assert.equal(JSON.stringify(cards), original);
});

test('agrupamento respeita jogo, nome e edições e exclui cadastros não publicados', () => {
  const card = {
    id: 'a',
    game: 'Magic',
    name: 'Sol Ring',
    set: 'A',
    price: 10,
    quantity: 2,
    published: true,
  };
  const rows = groupCatalog([
    card,
    {
      ...card,
      id: 'b',
      price: 20,
    },
    {
      ...card,
      id: 'c',
      game: 'Pokémon',
      set: 'B',
    },
    {
      ...card,
      id: 'd',
      name: 'Another card',
      set: 'B',
    },
    {
      ...card,
      id: 'hidden',
      set: 'B',
      published: false,
    },
  ]);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => !row.variants));
  assert.equal(
    groupCatalog([
      card,
      {
        ...card,
        id: 'b',
        name: 'sol ring',
        set: 'B',
      },
    ]).length,
    1,
  );
});

test('preço desconhecido não vira zero e preço zero continua válido no grupo', () => {
  const card = {
    game: 'Magic',
    name: 'Example',
    quantity: 1,
    published: true,
  };
  const group = groupCatalog([
    {
      ...card,
      id: 'unknown',
      set: 'A',
      price: null,
    },
    {
      ...card,
      id: 'free',
      set: 'B',
      price: 0,
    },
    {
      ...card,
      id: 'paid',
      set: 'C',
      price: 10,
    },
  ])[0];
  assert.equal(group.id, 'free');
  assert.equal(group.price, 0);
  assert.equal(group.quantity, 3);
});

test('adicionar cópia preserva ajustes e envia um cadastro independente', async () => {
  let method, payload, url;
  const p = panel(async (u, o) => {
    url = u;
    method = o.method;
    payload = JSON.parse(o.body);
    return {
      ok: false,
      json: async () => ({
        error: 'Teste',
      }),
    };
  });
  p.run(
    `openForm({id:'original',game:'Magic',name:'Sol Ring',set:'Commander',rarity:'Rara',condition:'NM',language:'Português',price:20,quantity:5,categories:['Foil'],scryfallId:'print'})`,
  );
  p.get('card-price').value = 18;
  await p.get('duplicate-card').emit('click');
  assert.equal(p.run('editId'), null);
  assert.equal(p.get('card-quantity').value, 1);
  await p.get('card-form').emit('submit');
  assert.equal(method, 'POST');
  assert.equal(url, '/api/cards');
  assert.equal(payload.price, 18);
  assert.equal(payload.scryfallId, 'print');
  assert.deepEqual(payload.categories, ['Foil']);
});

test('venda bloqueia envio duplo e mantém identificador ao tentar novamente', async () => {
  const requests = [],
    d = deferred();
  const p = panel(async (url, options) => {
    requests.push(JSON.parse(options.body));
    return d.promise;
  });
  p.run(`openSale({id:'card',name:'Teste',quantity:3,price:12})`);
  const first = p.get('sale-form').emit('submit');
  await p.get('sale-form').emit('submit');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].quantity, 1);
  d.resolve({
    ok: false,
    json: async () => ({
      error: 'Falha temporária',
    }),
  });
  await first;
  assert.equal(p.get('sale-error').textContent, 'Falha temporária');
  await p.get('sale-form').emit('submit');
  assert.equal(requests[0].saleId, requests[1].saleId);
});

test('exclusão só envia requisição ao confirmar e permite cancelar', async () => {
  let count = 0;
  const p = panel(async () => {
    count++;
    return {
      ok: false,
      json: async () => ({
        error: 'Teste',
      }),
    };
  });
  p.run(`removeCard({id:'card',name:'Teste'}, {disabled:false})`);
  assert.equal(count, 0);
  assert.equal(p.get('delete-dialog').open, true);
  await p.get('cancel-delete').emit('click');
  assert.equal(count, 0);
  assert.equal(p.get('delete-dialog').open, false);
  p.run(`removeCard({id:'card',name:'Teste'}, {disabled:false})`);
  await p.get('delete-form').emit('submit');
  assert.equal(count, 1);
});

test('editores só recebem ações de edição nas próprias cartas e não recebem venda', () => {
  const p = panel();
  p.run(
    `signed={role:'editor'};cards=[{id:'mine',name:'Minha',canEdit:true,quantity:1},{id:'other',name:'Outra',canEdit:false,quantity:1}];renderCards()`,
  );
  const rows = p.get('cards-body').children;
  const text = (node) => node.querySelectorAll('*').map((child) => child.textContent);
  assert.ok(text(rows[0]).includes('Editar'));
  assert.ok(text(rows[0]).includes('Excluir'));
  assert.ok(!text(rows[0]).includes('Carta vendida'));
  assert.ok(text(rows[1]).includes('Somente leitura'));
  assert.ok(!text(rows[1]).includes('Editar'));
  assert.ok(!text(rows[1]).includes('Excluir'));
  p.run(`signed={role:'proprietario'};cards=cards.map(c=>({...c,canEdit:true}));renderCards()`);
  assert.ok(text(p.get('cards-body').children[1]).includes('Carta vendida'));
});

test('valor da coleção soma preço por estoque, inclui cartas ocultas e não depende dos filtros', () => {
  const p = panel();
  p.run(
    `cards=[{name:'A',price:12.35,quantity:2},{name:'B',price:0.1,quantity:3,published:false},{name:'Vendida',price:100,quantity:0},{name:'Sem preço',price:null,quantity:2}];renderCards()`,
  );
  assert.match(p.get('collection-total').textContent, /25,00/);
  p.get('filter-name').value = 'Nenhuma';
  p.run('renderCards()');
  assert.match(p.get('collection-total').textContent, /25,00/);
  p.run('cards=[];renderCards()');
  assert.match(p.get('collection-total').textContent, /0,00/);
});

test('busca administrativa encontra descrição sem acentos e preserva nome, edição e jogo', () => {
  const p = panel();
  p.run(
    `cards=[{id:'a',name:'Sol Ring',set:'Commander',game:'Magic',description:'Edição promocional com assinatura'},{id:'b',name:'Pikachu',set:'Base Set',game:'Pokémon'}]`,
  );
  const search = (query, game = '') => {
    p.get('filter-name').value = query;
    p.get('filter-game').value = game;
    p.run('renderCards()');
    return p.get('cards-count').textContent;
  };
  assert.equal(search('  ASSINATURA  '), '1 de 2 registros');
  assert.equal(search('edicao promocional'), '1 de 2 registros');
  assert.equal(search('sol ring'), '1 de 2 registros');
  assert.equal(search('base set'), '1 de 2 registros');
  assert.equal(search('assinatura', 'Pokémon'), '0 de 2 registros');
  assert.equal(search(''), '2 de 2 registros');
  assert.equal(search('undefined'), '0 de 2 registros');
});

test('somente administrador recebe ações no histórico de vendas', () => {
  const p = panel();
  const data = {
    totalCents: 1000,
    items: [
      {
        id: 'sale',
        card: {
          name: 'Carta',
        },
        quantity: 1,
        unitCents: 1000,
        totalCents: 1000,
      },
    ],
  };
  p.run(`signed={role:'editor'};renderSales(${JSON.stringify(data)})`);
  const texts = () =>
    p
      .get('sales-list')
      .querySelectorAll('*')
      .map((node) => node.textContent);
  assert.ok(!texts().includes('Excluir venda'));
  assert.ok(!texts().includes('Voltar para vitrine'));
  p.run(`signed={role:'proprietario'};renderSales(${JSON.stringify(data)})`);
  assert.ok(texts().includes('Excluir venda'));
  assert.ok(texts().includes('Voltar para vitrine'));
});

test('devolver ou excluir venda exige confirmação e bloqueia requisição duplicada', async () => {
  const requests = [],
    d = deferred();
  const p = panel(async (url, opts) => {
    requests.push({
      url: url,
      method: opts.method,
    });
    return d.promise;
  });
  const sale = {
    id: 'sale-id',
    card: {
      name: 'Teste',
    },
    quantity: 2,
    totalCents: 1000,
  };
  p.run(`openSaleAction(${JSON.stringify(sale)},'restore')`);
  assert.equal(requests.length, 0);
  assert.match(p.get('sale-action-description').textContent, /Devolver 2/);
  await p.get('cancel-sale-action').emit('click');
  assert.equal(requests.length, 0);
  p.run(`openSaleAction(${JSON.stringify(sale)},'delete')`);
  assert.match(p.get('sale-action-description').textContent, /não voltarão ao estoque/);
  const pending = p.get('sale-action-form').emit('submit');
  await p.get('sale-action-form').emit('submit');
  assert.deepEqual(requests, [
    {
      url: '/api/sales/sale-id',
      method: 'DELETE',
    },
  ]);
  d.resolve({
    ok: false,
    json: async () => ({
      error: 'Falha de teste',
    }),
  });
  await pending;
  assert.equal(p.get('sale-action-error').textContent, 'Falha de teste');
  p.run(`openSaleAction(${JSON.stringify(sale)},'restore')`);
  await p.get('sale-action-form').emit('submit');
  assert.deepEqual(requests[1], {
    url: '/api/sales/sale-id/restore',
    method: 'POST',
  });
});

test('Play Pokemon habilita número somente em Pokémon e preserva na cópia', async () => {
  const p = panel();
  p.run(
    `openForm({game:'Pokémon',name:'Stamped',rarity:'Comum',playPokemon:true,playPokemonNumber:'00123'})`,
  );
  assert.equal(p.get('play-pokemon-fields').hidden, false);
  assert.equal(p.get('card-play-pokemon-number').value, '00123');
  assert.equal(p.get('card-play-pokemon-number').required, true);
  p.run(`editId='original'`);
  await p.get('duplicate-card').emit('click');
  assert.equal(p.get('card-play-pokemon').checked, true);
  assert.equal(p.get('card-play-pokemon-number').value, '00123');
  p.get('card-play-pokemon').checked = false;
  await p.get('card-play-pokemon').emit('change');
  assert.equal(p.get('card-play-pokemon-number').disabled, true);
  assert.equal(p.get('card-play-pokemon-number').required, false);
  p.get('card-game').value = 'Magic';
  await p.get('card-game').emit('change');
  assert.equal(p.get('play-pokemon-fields').hidden, true);
  assert.equal(p.get('card-play-pokemon-number').value, '');
  p.run('openForm()');
  assert.equal(p.get('card-play-pokemon').checked, false);
});

test('Play Pokemon envia o número e registra alterações no histórico', async () => {
  let payload;
  const p = panel(async (url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: false,
      json: async () => ({
        error: 'Test',
      }),
    };
  });
  p.run(
    `openForm({game:'Pokémon',name:'Example',rarity:'Comum',playPokemon:true,playPokemonNumber:'00123'})`,
  );
  await p.get('card-form').emit('submit');
  assert.equal(payload.playPokemon, true);
  assert.equal(payload.playPokemonNumber, '00123');
  p.get('card-play-pokemon').checked = false;
  await p.get('card-play-pokemon').emit('change');
  await p.get('card-form').emit('submit');
  assert.equal(payload.playPokemon, false);
  assert.equal(payload.playPokemonNumber, '');
  assert.match(
    p.run(`changes({playPokemon:false},{playPokemon:true,playPokemonNumber:'00123'})`),
    /Play Pokemon: Não → Sim/,
  );
  assert.equal(
    p.run(`changes({}, {playPokemon:false,playPokemonNumber:''})`),
    'Registro salvo sem alteração de valores',
  );
});

test('vitrine mostra o logo original sem número e preserva o número no cadastro', () => {
  const context = vm.createContext({
    window: {},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/catalog-shared.js'), 'utf8'), context);
  const normalize = context.window.MarketplaceCatalog.normalize;
  const card = normalize({
    id: 'p1',
    name: 'Pikachu',
    game: 'Pokémon',
    playPokemon: true,
    playPokemonNumber: '00123',
  });
  assert.equal(card.playPokemon, true);
  assert.equal(card.playPokemonNumber, '00123');
  for (const item of [
    {
      name: 'Old',
      game: 'Pokémon',
    },
    {
      ...card,
      game: 'Magic',
    },
    {
      ...card,
      playPokemon: false,
    },
    {
      ...card,
      playPokemonNumber: '<img onerror=x>',
    },
  ])
    assert.equal(normalize(item).playPokemon, false);
  context.e = context.window.MarketplaceCatalog.safeText;
  context.imageFor = () => 'https://example.test/original.webp';
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  vm.runInContext(
    source.slice(
      source.indexOf('function playPokemonBadge('),
      source.indexOf('function render() {'),
    ),
    context,
  );
  const html = context.cardArtwork(card);
  assert.match(html, /assets\/play-pokemon\.png/);
  assert.doesNotMatch(html, /Nº|00123/);
  assert.match(html, /https:\/\/example.test\/original.webp/);
  assert.doesNotMatch(
    context.cardArtwork({
      ...card,
      playPokemon: false,
    }),
    /play-pokemon/,
  );
  assert.equal(
    context.playPokemonBadge({
      ...card,
      game: 'Magic',
    }),
    '',
  );
});

test('agrupamento separa Play Pokemon de cartas comuns e de números diferentes', () => {
  const card = {
    id: 'regular',
    name: 'Pikachu',
    game: 'Pokémon',
    set: 'A',
    price: 10,
    quantity: 1,
    published: true,
  };
  const result = groupCatalog([
    card,
    {
      ...card,
      id: 'play1',
      set: 'B',
      playPokemon: true,
      playPokemonNumber: '001',
    },
    {
      ...card,
      id: 'play2',
      set: 'C',
      playPokemon: true,
      playPokemonNumber: '002',
    },
    {
      ...card,
      id: 'play3',
      set: 'D',
      playPokemon: true,
      playPokemonNumber: '001',
    },
  ]);
  assert.equal(result.length, 3);
  const stamped = result.find((row) => row.playPokemonNumber === '001');
  assert.equal(stamped.quantity, 2);
  assert.equal(stamped.variants.length, 2);
});

test('painel antigo não oferece salvar Play Pokemon sem suporte do servidor', async () => {
  let payload;
  const p = panel(async (url, options) => {
    payload = JSON.parse(options.body);
    return {
      ok: false,
      json: async () => ({
        error: 'Test',
      }),
    };
  });
  p.run(`playPokemonSupported=false;openForm({game:'Pokémon',name:'Example',rarity:'Comum'})`);
  assert.equal(p.get('card-play-pokemon').disabled, true);
  assert.equal(p.get('play-pokemon-restart').hidden, false);
  assert.equal(p.get('card-play-pokemon-number').required, false);
  await p.get('card-form').emit('submit');
  assert.equal('playPokemon' in payload, false);
  assert.equal('playPokemonNumber' in payload, false);
  assert.doesNotThrow(() =>
    p.run(
      `const originalGet=document.getElementById;document.getElementById=id=>id.startsWith('card-play-pokemon')?null:originalGet(id);openForm();updatePlayPokemon();`,
    ),
  );
});

test('modal mostra preço separado dos metadados e preserva zero, consulta e grupos', () => {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  get('overlay').classList.add = () => {};
  const context = vm.createContext({
    document: {
      getElementById: get,
      activeElement: null,
      body: {
        style: {},
      },
    },
    priorFocus: null,
    imageFor: (card) => card.image || '',
    e: String,
    playPokemonBadge: () => '',
    overlay: get('overlay'),
    closeButton: get('close'),
    WHATSAPP_NUMBER: '5500000000000',
    store: {
      money: (value) =>
        typeof value === 'number'
          ? value.toLocaleString('pt-BR', {
              style: 'currency',
              currency: 'BRL',
            })
          : 'Sob consulta',
    },
  });
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  vm.runInContext(
    source.slice(
      source.indexOf('function openCard('),
      source.indexOf('function closeCard('),
    ),
    context,
  );
  const card = {
    name: 'Energia',
    game: 'Pokémon',
    set: 'Edição',
    rarity: 'Rara',
    condition: 'NM',
    quantity: 1,
    price: 4,
  };
  const open = (row) => vm.runInContext('openCard(' + JSON.stringify(row) + ')', context);
  open(card);
  assert.match(get('modalPrice').textContent, /R\$\s*4,00/);
  assert.doesNotMatch(get('modalMeta').textContent, /R\$/);
  assert.match(get('modalMeta').textContent, /Estoque: 1/);
  assert.match(get('modalContact').href, /wa\.me\/5500000000000\?text=/);
  open({
    ...card,
    price: 0,
  });
  assert.match(get('modalPrice').textContent, /R\$\s*0,00/);
  open({
    ...card,
    price: null,
  });
  assert.equal(get('modalPrice').textContent, 'Sob consulta');
  open({
    ...card,
    variants: [card],
  });
  assert.match(get('modalPrice').textContent, /Apartir de: R\$\s*4,00/);
  open({
    ...card,
    demo: true,
  });
  assert.equal(get('modalPrice').textContent, 'Sob consulta');
});
