# TCG Marketplace

Modelo pronto de vitrine para lojas de cartas **Magic: The Gathering** e **Pokémon TCG**, com painel administrativo local para Windows.

- **Vitrine pública** (`index.html` + `assets/`): site estático para GitHub Pages, com busca por nome com sugestões (TCGdex e Scryfall), filtro por jogo, faixa de preço, ordenação, paginação, agrupamento de edições e contato pelo WhatsApp.
- **Painel Windows** (`windows-admin/`): Flask + SQLite + Waitress em `http://127.0.0.1:8765/`, com login, cadastro de cartas pela TCGdex/Scryfall, estoque, vendas, clientes com comissão, histórico de alterações e publicação automática do catálogo no GitHub.

A vitrine está em **inglês** e os preços em **dólar (US$)**. O catálogo incluído (`assets/catalogo.js`) é **fictício**: 24 cartas populares de Magic e Pokémon, com preços definidos pela posição no catálogo (R$ 480 na 1ª posição e R$ 20 a menos em cada posição seguinte, convertidos para dólar pela cotação de 09/11/2026, US$ 1 = R$ 5,5046: de US$ 87,20 a US$ 3,63). O painel administrativo continua em português e também exibe os valores em US$.

## Como montar a sua vitrine

1. Crie um repositório no GitHub e envie estes arquivos.
2. Em **Settings → Pages**, publique o branch `main` na raiz. Se tiver domínio próprio, crie um arquivo `CNAME` com ele.
3. Personalize:
   - **WhatsApp:** em `index.html`, troque `5500000000000` (constante `WHATSAPP_NUMBER` e links `wa.me`) pelo seu número com DDI e DDD.
   - **Repositório:** em `windows-admin/app.py` (`REPO`) e em `windows-admin/ATUALIZAR_DO_GITHUB.bat` (`BASE_URL`), troque `seu-usuario/tcg-marketplace` pelo seu repositório.
   - **Marca e arte:** nome no cabeçalho de `index.html` e de `windows-admin/templates/admin.html`; banner em `assets/banner.webp` (1600 × 900 px; o arquivo de exemplo indica onde a arte aparece) e `assets/banner.jpg` para compartilhamento em redes sociais; ícone em `assets/icone.png`.
4. Instale o painel seguindo [windows-admin/LEIA-ME.md](windows-admin/LEIA-ME.md). Na primeira instalação ele importa o catálogo de exemplo de `windows-admin/dados/catalogo-inicial.js`; apague ou edite essas cartas pelo painel.

## Segurança

O repositório costuma ser público. Nunca envie ao GitHub `windows-admin/dados/*.sqlite3`, `dados/backups`, `dados/.chave-sessao`, `.env`, senhas ou tokens. O `.gitignore` já exclui esses arquivos. O token do GitHub fica no Gerenciador de Credenciais do Windows (serviço `TCGMarketplace-Windows`).

## Testes

```powershell
python -B windows-admin/tests/test_logic.py
windows-admin/.venv/Scripts/python.exe -B windows-admin/tests/test_sales.py
node --test windows-admin/tests/test_frontend.js
```

Os testes usam pasta temporária para banco, chave de sessão e catálogo, e simulam as respostas de rede.

## Créditos

Dados e imagens de cartas: [TCGdex](https://tcgdex.dev), [Scryfall](https://scryfall.com/docs/api) e [MTGJSON](https://mtgjson.com/license/). Magic: The Gathering e Pokémon pertencem a seus respectivos titulares; este projeto não tem afiliação oficial.

## Autor

Criado por **Victor Borra** — [github.com/vctrborra-sys](https://github.com/vctrborra-sys).

## Licença

Distribuído sob a [licença MIT](LICENSE). Você pode usar, copiar e modificar o código, inclusive comercialmente, desde que mantenha o aviso de copyright e a licença.
