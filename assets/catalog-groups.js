(function () {
  'use strict';
  const normalize = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR')
      .trim()
      .replace(/\s+/g, ' ');
  const price = (card) =>
    typeof card.price === 'number' && Number.isFinite(card.price) && card.price >= 0
      ? card.price
      : Infinity;
  function group(cards) {
    const buckets = new Map();
    for (const card of cards) {
      if (!card.published) continue;
      const play = card.game === 'Pokémon' && card.playPokemon === true;
      const key =
        card.game +
        '\0' +
        normalize(card.name) +
        '\0' +
        Boolean(card.demo) +
        '\0' +
        (play ? 'play:' + card.playPokemonNumber : '');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(card);
    }
    const result = [];
    for (const members of buckets.values()) {
      const editions = new Set(members.map((card) => normalize(card.set)));
      if (editions.size < 2) {
        result.push(...members);
        continue;
      }
      const variants = members.slice().sort((a, b) => {
        const left = price(a),
          right = price(b);
        if (left !== right) return left < right ? -1 : 1;
        return (
          String(a.set || '').localeCompare(String(b.set || ''), 'pt-BR', {
            numeric: true,
          }) || String(a.id).localeCompare(String(b.id))
        );
      });
      const cheapest = variants[0];
      const quantity = members.reduce(
        (sum, card) =>
          sum + (Number.isInteger(card.quantity) && card.quantity >= 0 ? card.quantity : 0),
        0,
      );
      result.push({
        ...cheapest,
        quantity: quantity,
        variants: variants,
        editionCount: editions.size,
      });
    }
    return result;
  }
  window.MarketplaceGroups = {
    group: group,
  };
})();
