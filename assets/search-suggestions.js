(function () {
  'use strict';
  const normalize = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR')
      .trim();
  const tokens = (value) => normalize(value).split(/\s+/).filter(Boolean);
  const fits = (name, query) => tokens(query).every((word) => normalize(name).includes(word));
  const namesOf = (card) =>
    [card.name, card.scryfall, ...(Array.isArray(card.aliases) ? card.aliases : [])].filter(
      (value) => typeof value === 'string' && value,
    );
  function distance(left, right) {
    let previous = Array.from(
      {
        length: right.length + 1,
      },
      (_, i) => i,
    );
    for (let i = 1; i <= left.length; i++) {
      const next = [i];
      for (let j = 1; j <= right.length; j++)
        next[j] = Math.min(
          next[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
        );
      previous = next;
    }
    return previous[right.length];
  }
  function score(name, query) {
    const value = normalize(name),
      q = normalize(query);
    if (value === q) return 0;
    if (value.startsWith(q)) return 10 + (value.length - q.length) / 1000;
    if (fits(value, q)) return 20 + value.indexOf(tokens(q)[0]) / 1000;
    const nearest = Math.min(
      distance(value, q),
      ...value.split(/\s+/).map((word) => distance(word, q)),
    );
    return nearest <= Math.max(1, Math.floor(q.length * 0.3)) ? 30 + nearest : Infinity;
  }
  function rank(items, query, game = 'all') {
    if (normalize(query).length < 2) return [];
    const unique = new Map();
    for (const item of items) {
      if (
        !item ||
        typeof item.name !== 'string' ||
        !['Pokémon', 'Magic'].includes(item.game) ||
        (game !== 'all' && item.game !== game)
      )
        continue;
      const name = item.name.trim().slice(0, 120);
      if (!name) continue;
      const key = item.game + ':' + normalize(name),
        previous = unique.get(key);
      const aliases = [...new Set([...(previous?.aliases || []), ...namesOf(item)])];
      unique.set(key, {
        name: name,
        game: item.game,
        aliases: aliases,
      });
    }
    return [...unique.values()]
      .map((item) => ({
        item: item,
        score: Math.min(...item.aliases.map((name) => score(name, query))),
      }))
      .filter((row) => Number.isFinite(row.score))
      .sort(
        (a, b) =>
          a.score - b.score ||
          a.item.name.localeCompare(b.item.name, 'pt-BR', {
            sensitivity: 'base',
            numeric: true,
          }) ||
          a.item.game.localeCompare(b.item.game),
      )
      .slice(0, 5)
      .map((row) => row.item);
  }
  function matchesCard(card, query, selection = null) {
    const q = normalize(query);
    if (!q) return true;
    if (selection && q === normalize(selection.name)) {
      return (
        card.game === selection.game &&
        namesOf(card).some((name) =>
          namesOf(selection).some(
            (alias) => normalize(alias) === normalize(name) || fits(name, alias),
          ),
        )
      );
    }
    return fits(namesOf(card).join(' '), q);
  }
  async function json(url, signal) {
    const response = await fetch(url, {
      signal: signal,
      headers: {
        Accept: 'application/json',
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw Error('Consulta indisponível');
    return response.json();
  }
  async function pokemon(query, signal) {
    const fragment =
      tokens(query)
        .filter((word) => word.length >= 2)
        .sort((a, b) => b.length - a.length)[0] || normalize(query);
    const params = new URLSearchParams({
      name: 'like:' + fragment,
      'pagination:page': '1',
      'pagination:itemsPerPage': '160',
    });
    const responses = await Promise.allSettled(
      ['pt', 'en'].map((lang) =>
        json('https://api.tcgdex.net/v2/' + lang + '/cards?' + params, signal),
      ),
    );
    return responses
      .flatMap((result) =>
        result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : [],
      )
      .filter((card) => typeof card?.name === 'string')
      .map((card) => ({
        name: card.name,
        game: 'Pokémon',
      }));
  }
  async function magic(query, signal) {
    const items = [];
    try {
      const data = await json(
        'https://api.scryfall.com/cards/autocomplete?' +
          new URLSearchParams({
            q: query,
          }),
        signal,
      );
      if (Array.isArray(data?.data))
        for (const name of data.data)
          if (typeof name === 'string')
            items.push({
              name: name,
              game: 'Magic',
            });
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (signal.aborted) return items;
    try {
      const terms = tokens(query).map((word) => 'name:"' + word.replace(/["\\]/g, '') + '"');
      const params = new URLSearchParams({
        q: terms.join(' ') + ' (lang:en or lang:pt)',
        unique: 'prints',
        include_multilingual: 'true',
        order: 'name',
      });
      const data = await json('https://api.scryfall.com/cards/search?' + params, signal);
      if (Array.isArray(data?.data))
        for (const card of data.data) {
          if (typeof card?.name === 'string')
            items.push({
              name: card.printed_name || card.name,
              game: 'Magic',
              aliases: [card.name, card.printed_name].filter(Boolean),
            });
        }
    } catch (error) {
      if (signal.aborted) throw error;
    }
    return items;
  }
  async function fetchSuggestions(query, game, signal) {
    if (normalize(query).length < 2 || signal.aborted) return [];
    const requests = [];
    if (game === 'all' || game === 'Pokémon') requests.push(pokemon(query, signal));
    if (game === 'all' || game === 'Magic') requests.push(magic(query, signal));
    const results = await Promise.allSettled(requests);
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }
  function attach({
    input: input,
    container: container,
    getGame: getGame,
    getCards: getCards,
    onSelect: onSelect,
  }) {
    let timer = null,
      controller = null,
      version = 0;
    function clear() {
      ++version;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (controller) {
        controller.abort();
        controller = null;
      }
      container.replaceChildren();
      container.hidden = true;
    }
    function show(items) {
      container.replaceChildren();
      container.hidden = !items.length;
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'search-suggestion';
        const name = document.createElement('span');
        name.textContent = item.name;
        const game = document.createElement('small');
        game.textContent = item.game === 'Magic' ? 'Magic: The Gathering' : 'Pokemon TCG';
        button.append(name, game);
        button.addEventListener('click', () => {
          clear();
          input.value = item.name;
          onSelect(item);
        });
        container.append(button);
      }
    }
    function local() {
      return getCards().filter((card) => card.published);
    }
    async function load(query, game, current) {
      const active = new AbortController();
      controller = active;
      const timeout = setTimeout(() => active.abort(), 8000);
      try {
        const remote = await fetchSuggestions(query, game, active.signal);
        if (
          current !== version ||
          active.signal.aborted ||
          input.value.trim() !== query ||
          getGame() !== game
        )
          return;
        show(rank([...local(), ...remote], query, game));
      } finally {
        clearTimeout(timeout);
        if (controller === active) controller = null;
      }
    }
    input.addEventListener('input', () => {
      clear();
      const query = input.value.trim().slice(0, 90),
        game = getGame();
      if (normalize(query).length < 2) return;
      show(rank(local(), query, game));
      const current = version;
      timer = setTimeout(() => {
        timer = null;
        load(query, game, current).catch(() => {});
      }, 650);
    });
    document.addEventListener('pointerdown', (event) => {
      if (event.target !== input && !container.contains(event.target)) clear();
    });
    return {
      clear: clear,
    };
  }
  window.MarketplaceSearch = {
    normalize: normalize,
    tokens: tokens,
    rank: rank,
    matchesCard: matchesCard,
    fetchSuggestions: fetchSuggestions,
    attach: attach,
  };
})();
