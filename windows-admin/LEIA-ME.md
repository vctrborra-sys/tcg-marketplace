# TCG Marketplace — instalação limpa no Windows 10/11

## 1. Escolha onde guardar

Extraia o ZIP inteiro e mova a pasta `windows-admin` para um lugar fixo, por exemplo `C:\TCG-Marketplace`. **Faça isso antes de instalar.** Não execute arquivos direto de dentro do ZIP.

## 2. Instale

Instale Python 3.11 ou superior em https://www.python.org/downloads/windows/ (marque `Add Python to PATH`, se aparecer).

Dentro da pasta `windows-admin`, clique duas vezes em **`INSTALAR_WINDOWS.bat`**. Esse arquivo configura o ambiente, instala as dependências e pede uma nova senha para o primeiro usuário `admin`. A senha fica armazenada apenas como hash no banco local. Ao digitar ela não aparece na tela.

## 3. GitHub para publicação automática

Execute **`CONFIGURAR_GITHUB.bat`**, informando um token fine-grained limitado ao repositório `seu-usuario/tcg-marketplace` e à permissão `Contents: Read and write`. Não compartilhe esse token nem salve em arquivos de texto. Se a credencial antiga do Windows continuar no Gerenciador de Credenciais, talvez você não precise recriar o token.

## 4. Abra o painel

Clique duas vezes em **`INICIAR_PAINEL.bat`**, entre com admin no endereço `http://127.0.0.1:8765/`. Deixe a janela do programa aberta enquanto quiser sincronizar. Para iniciar automaticamente ao entrar no Windows, execute **`ATIVAR_INICIO_AUTOMATICO.bat`**.

## 5. Dados e recuperação

### Acessar de outras redes com hospedagem neste computador

O admin e seu banco continuam nesta instalação Windows. O acesso remoto usa **Tailscale Serve**, com HTTPS dentro da rede privada Tailscale; o login e a senha do painel permanecem os mesmos. O GitHub Pages continua hospedando a vitrine.

1. Instale [Tailscale para Windows](https://tailscale.com/download/windows) neste computador e entre na sua conta pelo ícone próximo ao relógio.
2. Execute [CONFIGURAR_ACESSO_REMOTO.bat](CONFIGURAR_ACESSO_REMOTO.bat). Se houver um link para habilitar HTTPS no Tailscale, conclua essa etapa e execute o arquivo novamente.
3. Abra [INICIAR_PAINEL.bat](INICIAR_PAINEL.bat) e mantenha este computador ligado, conectado e sem suspensão durante o acesso.
4. No outro computador, instale o Tailscale e conecte-o à mesma rede privada, com um dispositivo autorizado. Abra o endereço `https://nome-do-computador.rede.ts.net/` informado pelo configurador e use o login do TCG Marketplace.

O outro computador usa o mesmo estoque, usuários e histórico; não instale outra cópia do banco nele. O configurador não abre portas no roteador e preserva serviços Tailscale preexistentes na porta 443. Se o Tailscale ainda não estiver conectado ou faltar habilitar HTTPS, ele informa que a configuração está pendente.

O encaminhamento permanece no Tailscale em segundo plano. Para desligar somente esse acesso remoto, execute `tailscale serve --https=443 off` em um terminal no computador principal. O painel local continua disponível em `http://127.0.0.1:8765/`.

Referência: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).


O banco de dados do painel fica em `windows-admin\dados\marketplace.sqlite3`. **Nunca apague `dados`**: lá ficam cartas, usuários e histórico. Use `FAZER_BACKUP.bat` e guarde backups fora dessa pasta (um pendrive, por exemplo).

Se você apagou a instalação anterior, restaure `dados\marketplace.sqlite3` ou um backup `.sqlite3` anterior antes de rodar a instalação. Caso não haja backup, a instalação importa o catálogo de exemplo de `dados\catalogo-inicial.js`, com autoria atribuída a admin. Não dá para recuperar do GitHub senhas, outros usuários e alterações não publicadas.

Após restaurar banco anterior, `REDEFINIR_SENHA_ADMIN.bat` recupera a senha localmente quando necessário. Não publique o banco no GitHub, especialmente porque o repositório é público.

## 6. O que contém

`app.py`: aplicação local; `templates/admin.html` e `static/*`: interface; `dados/catalogo-inicial.js`: catálogo de exemplo importado na primeira instalação; `tests/test_logic.py`: verificações; arquivos `.bat`: instalar, iniciar, backup, senha, credencial e inicialização.

O idioma da carta é informado no cadastro/edição; a busca do painel mantém o formato simples. O site público continua no GitHub Pages. A vitrine publicada usa `index.html` e `assets` na raiz do repositório.

## Busca inteligente e nomes em português

No cadastro, digite qualquer palavra ou trecho do nome (por exemplo, `Ring` encontra `Sol Ring`).
O sistema sugere cartas automaticamente e reconhece palavras fora da ordem do nome.
O TCGdex fornece dados localizados de Pokémon em português; Scryfall fornece os nomes em inglês
(e impressões), e o MTGJSON fornece um índice adicional de nomes impressos em português do Brasil
quando disponíveis. Não inventamos traduções e o idioma da carta física continua sendo escolhido no cadastro.

**Na primeira pesquisa**, o programa prepara em segundo plano o índice de Magic PT-BR usando
`https://mtgjson.com/api/v5/AtomicCards.json.xz` (arquivo comprimido de cerca de 25 MiB).
A pesquisa de Pokémon e Magic em inglês continua disponível enquanto isso acontece.
O índice é mantido na pasta `dados` do computador para as pesquisas seguintes.
Fontes e licenças: [TCGdex](https://tcgdex.dev), [Scryfall](https://scryfall.com/docs/api),
[MTGJSON (MIT)](https://mtgjson.com/license/).

## Atualizar com um único arquivo

1. Baixe o arquivo `ATUALIZAR_DO_GITHUB.bat` diretamente do GitHub.
2. Coloque-o **na mesma pasta que contém `app.py`, `dados` e `INICIAR_PAINEL.bat`**.
3. Feche o painel e execute esse arquivo. Ele atualiza o código e faz backup dos arquivos antigos em
   `dados/backups`. Não modifica o banco de dados, senhas ou token.
4. Abra `INICIAR_PAINEL.bat` novamente.


## Backups e verificação

Cada execução de `FAZER_BACKUP.bat` cria uma nova cópia com data, horário e identificador. O serviço mantém também uma cópia diária. As cópias anteriores são preservadas; guarde uma cópia fora deste computador.

Para verificar o código sem usar o banco da instalação: `python -B windows-admin/tests/test_logic.py` a partir da raiz do projeto. Os testes usam banco, chave de sessão e catálogo inicial em uma pasta temporária. As verificações de interface estão em `node --test windows-admin/tests/test_frontend.js`.

## Categorias das cartas

No cadastro, o campo **Categorias (opcional)** permite marcar mais de uma característica, sem alterar a raridade:

- **Pokémon:** Foil, Reverse Foil e Full Art.
- **Magic:** Foil, Foil Especial e Promo.

Ao mudar o jogo, ficam disponíveis somente as categorias correspondentes. As categorias aparecem na coleção administrativa, no histórico, nas cartas da vitrine e nos detalhes da carta. Nenhuma categoria é atribuída automaticamente pela TCGdex ou pelo Scryfall.
