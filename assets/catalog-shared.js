(function () {
  'use strict';
  const KEY = 'tcg-marketplace:catalogo-local:v1';
  const CONDITIONS = ['NM', 'SP', 'MP', 'HP', 'D'];
  const CATEGORIES = Object.freeze({
    Pokémon: Object.freeze(['Foil', 'Reverse Foil', 'Full Art']),
    Magic: Object.freeze(['Foil', 'Foil Especial', 'Promo']),
  });
  const RARITIES = Object.freeze({
    Pokémon: Object.freeze([
      'Comum',
      'Incomum',
      'Rara',
      'Rara Dupla',
      'Ultra Rara',
      'Ilustração Rara',
      'Ilustração Rara Especial',
      'Rara Hiper',
      'ACE SPEC',
    ]),
    Magic: Object.freeze(['Comum', 'Incomum', 'Rara', 'Mítica', 'SLD']),
  });
  function rarityFromTCGdex(value) {
    const original = typeof value === 'string' ? value.trim() : '';
    if (RARITIES['Pokémon'].includes(original)) return original;
    const normalized = original
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[–—_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const translate = {
      common: 'Comum',
      uncommon: 'Incomum',
      rare: 'Rara',
      'rare holo': 'Rara',
      'rare holographic': 'Rara',
      'ultra rare': 'Ultra Rara',
      'rare ultra': 'Ultra Rara',
      'rara ultra': 'Ultra Rara',
      'ultra raras': 'Ultra Rara',
      'rare double': 'Rara Dupla',
      'double rare': 'Rara Dupla',
      'illustration rare': 'Ilustração Rara',
      'rare illustration': 'Ilustração Rara',
      'special illustration rare': 'Ilustração Rara Especial',
      'rare special illustration': 'Ilustração Rara Especial',
      'hyper rare': 'Rara Hiper',
      'rare hyper': 'Rara Hiper',
      'ace spec': 'ACE SPEC',
      'ace spec rare': 'ACE SPEC',
      'rare ace': 'ACE SPEC',
      'ilustracao rara': 'Ilustração Rara',
      'ilustracao rara especial': 'Ilustração Rara Especial',
      'rara dupla': 'Rara Dupla',
      'rara hiper': 'Rara Hiper',
      'ultra rara': 'Ultra Rara',
      comum: 'Comum',
      incomum: 'Incomum',
      rara: 'Rara',
    };
    return translate[normalized] || '';
  }
  function rarityFromScryfall(rarity, setCode) {
    if (String(setCode || '').toLowerCase() === 'sld') return 'SLD';
    return (
      {
        common: 'Comum',
        uncommon: 'Incomum',
        rare: 'Rara',
        mythic: 'Mítica',
      }[String(rarity || '').toLowerCase()] || ''
    );
  }
  const CONDITON_NAMES = {
    NM: 'Near Mint — excelente',
    SP: 'Slightly Played — leves marcas',
    MP: 'Moderately Played — desgaste moderado',
    HP: 'Heavily Played — desgaste intenso',
    D: 'Damaged — danificada',
  };
  const FALLBACK = Object.freeze({
    version: 1,
    updatedAt: '',
    items: [],
  });
  function str(s, max = 500) {
    return typeof s === 'string' ? s.trim().slice(0, max) : '';
  }
  function url(u) {
    const x = str(u, 800);
    return /^https:\/\//i.test(x) || /^assets\/[a-zA-Z0-9_./%-]+$/.test(x) ? x : '';
  }
  function normalize(item) {
    if (!item || typeof item !== 'object') return null;
    const name = str(item.name, 120);
    if (!name) return null;
    const price =
      item.price === null || item.price === '' || item.price === undefined
        ? null
        : Number(item.price);
    return {
      id: str(item.id, 100) || 'item-' + Math.random().toString(36).slice(2),
      game: item.game === 'Pokémon' ? 'Pokémon' : 'Magic',
      name: name,
      set: str(item.set, 140),
      language: str(item.language, 60),
      categories: CATEGORIES[item.game === 'Pokémon' ? 'Pokémon' : 'Magic'].filter(
        (value) => Array.isArray(item.categories) && item.categories.includes(value),
      ),
      playPokemon:
        item.game === 'Pokémon' &&
        item.playPokemon === true &&
        /^[0-9]{1,30}$/.test(str(item.playPokemonNumber, 31)),
      playPokemonNumber:
        item.game === 'Pokémon' &&
        item.playPokemon === true &&
        /^[0-9]{1,30}$/.test(str(item.playPokemonNumber, 31))
          ? str(item.playPokemonNumber, 30)
          : '',
      rarity:
        (item.game === 'Pokémon' && str(item.rarity, 40) === 'Ultra Raras'
          ? 'Ultra Rara'
          : str(item.rarity, 40)) || 'Não informada',
      condition: CONDITIONS.includes(item.condition) ? item.condition : '',
      price:
        price !== null && Number.isFinite(price) && price >= 0
          ? Math.round(price * 100) / 100
          : null,
      quantity:
        Number.isInteger(Number(item.quantity)) && Number(item.quantity) >= 0
          ? Number(item.quantity)
          : 0,
      published: item.published !== false,
      demo: item.demo === true,
      image: url(item.image),
      tcgdexId: str(item.tcgdexId, 100),
      tcgdexLanguage: ['pt', 'en'].includes(item.tcgdexLanguage) ? item.tcgdexLanguage : '',
      scryfall: str(item.scryfall, 140),
      scryfallId: str(item.scryfallId, 60),
      scryfallSet: str(item.scryfallSet, 12),
      scryfallNumber: str(item.scryfallNumber, 30),
      scryfallLanguage: str(item.scryfallLanguage, 12),
      description: str(item.description, 1200),
    };
  }
  function normalizeCatalog(raw) {
    const source = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items) ? raw.items : [];
    const used = new Set();
    const items = [];
    for (const candidate of source) {
      const item = normalize(candidate);
      if (item) {
        if (used.has(item.id)) item.id = 'item-' + Math.random().toString(36).slice(2);
        used.add(item.id);
        items.push(item);
      }
    }
    return {
      version: 1,
      updatedAt: str(raw?.updatedAt, 70),
      items: items,
    };
  }
  function bundled() {
    return normalizeCatalog(window.TCG_CATALOG || FALLBACK);
  }
  function getLocal() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? normalizeCatalog(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }
  function get() {
    return getLocal() || bundled();
  }
  function save(items) {
    const doc = normalizeCatalog({
      updatedAt: new Date().toISOString(),
      items: items,
    });
    localStorage.setItem(KEY, JSON.stringify(doc));
    return doc;
  }
  function clear() {
    localStorage.removeItem(KEY);
  }
  function money(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        })
      : 'Sob consulta';
  }
  function safeText(s) {
    return String(s ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  }
  window.MarketplaceCatalog = {
    KEY: KEY,
    CONDITIONS: CONDITIONS,
    CATEGORIES: CATEGORIES,
    CONDITON_NAMES: CONDITON_NAMES,
    RARITIES: RARITIES,
    rarityFromTCGdex: rarityFromTCGdex,
    rarityFromScryfall: rarityFromScryfall,
    normalize: normalize,
    normalizeCatalog: normalizeCatalog,
    bundled: bundled,
    getLocal: getLocal,
    get: get,
    save: save,
    clear: clear,
    money: money,
    safeText: safeText,
    url: url,
  };
})();
