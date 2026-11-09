from __future__ import annotations
import base64
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone
import getpass
import json
import logging
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from flask import Flask, abort, jsonify, redirect, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from nomes_pt import suggest_names as query_portuguese_names

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get('MARKETPLACE_DATA', str(BASE / 'dados')))
DATA.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.environ.get('MARKETPLACE_DB', str(DATA / 'marketplace.sqlite3')))
KEY_PATH = DATA / '.chave-sessao'
REPO = 'seu-usuario/tcg-marketplace'
BRANCH = 'main'
GITHUB_FILE = 'assets/catalogo.js'
KEYRING_SERVICE = 'TCGMarketplace-Windows'
KEYRING_NAME = 'github-token'
RARITIES = {
    'Pokémon': ['Comum','Incomum','Rara','Rara Dupla','Ultra Rara','Ilustração Rara','Ilustração Rara Especial','Rara Hiper','ACE SPEC'],
    'Magic': ['Comum','Incomum','Rara','Mítica','SLD']
}
CONDITIONS = ['NM', 'SP', 'MP', 'HP', 'D']
CATEGORIES = {
    'Pokémon': ['Foil', 'Reverse Foil', 'Full Art'],
    'Magic': ['Foil', 'Foil Especial', 'Promo'],
}
FIELDS = ['id','game','name','set','rarity','categories','playPokemon','playPokemonNumber','condition','language','price','quantity','published','demo','image',
          'tcgdexId','tcgdexLanguage','scryfall','scryfallId','scryfallSet','scryfallNumber','scryfallLanguage','description']
LOGGER = logging.getLogger('marketplace')
PUBLISH_LOCK = threading.Lock()
WAKE = threading.Event()
FAILED = {}


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class ManagedConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10, factory=ManagedConnection)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA busy_timeout=10000')
    return conn


def initialize_db():
    with db() as c:
        c.executescript('''
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL COLLATE NOCASE UNIQUE,
            pw_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('proprietario','editor')),
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS cards (
            id TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            author_id INTEGER REFERENCES users(id),
            editor_id INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id TEXT,
            card_name TEXT NOT NULL,
            user_id INTEGER NOT NULL REFERENCES users(id),
            action TEXT NOT NULL,
            before_json TEXT,
            after_json TEXT,
            timestamp TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS clients (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            cpf TEXT NOT NULL UNIQUE,
            commission_percent REAL NOT NULL CHECK(commission_percent >= 0 AND commission_percent <= 100),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sales (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL,
            card_json TEXT NOT NULL,
            user_id INTEGER NOT NULL REFERENCES users(id),
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            unit_cents INTEGER NOT NULL CHECK(unit_cents >= 0),
            timestamp TEXT NOT NULL
          );
        ''')
        sales_columns = {r['name'] for r in c.execute('PRAGMA table_info(sales)')}
        if 'status' not in sales_columns:
            c.execute("ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
        if 'author_id' not in sales_columns:
            c.execute('ALTER TABLE sales ADD COLUMN author_id INTEGER REFERENCES users(id)')
        c.execute("INSERT OR IGNORE INTO metadata VALUES ('revision','0')")
        c.execute("INSERT OR IGNORE INTO metadata VALUES ('dirty','0')")
        c.execute("INSERT OR IGNORE INTO metadata VALUES ('last_publish','')")
        c.execute("INSERT OR IGNORE INTO metadata VALUES ('last_error','')")


def secret_key():
    if KEY_PATH.exists():
        return KEY_PATH.read_bytes()
    secret = secrets.token_bytes(48)
    with KEY_PATH.open('xb') as f:
        f.write(secret)
    return secret

app = Flask(__name__, template_folder=str(BASE / 'templates'))
app.secret_key = secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=False,
    PERMANENT_SESSION_LIFETIME=60 * 60 * 8,
    MAX_CONTENT_LENGTH=100 * 1024,
)
initialize_db()


def current_user(c):
    user_id = session.get('user_id')
    if not user_id:
        return None
    return c.execute('SELECT id,username,role FROM users WHERE id=?', (user_id,)).fetchone()


def require_user(c):
    u = current_user(c)
    if not u:
        abort(401)
    return u


def require_owner(c):
    u = require_user(c)
    if u['role'] != 'proprietario':
        abort(403)
    return u


def can_edit_card(user, row):
    return user['role'] == 'proprietario' or row['author_id'] == user['id']


def require_card_editor(user, row):
    if not can_edit_card(user, row):
        abort(403, 'Editores só podem alterar ou excluir cartas que cadastraram.')


@app.before_request
def check_csrf():
    if 'csrf' not in session:
        session['csrf'] = secrets.token_urlsafe(32)
    if request.method in ('POST','PUT','PATCH','DELETE'):
        sent = request.headers.get('X-CSRF-Token','')
        if not secrets.compare_digest(sent, session['csrf']):
            abort(403, 'Token de proteção inválido. Atualize a página.')


@app.after_request
def secure_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' https: data:; connect-src 'self' https://api.tcgdex.net "
        "https://api.scryfall.com; form-action 'self'; frame-ancestors 'none'"
    )
    return response


@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(400)
def api_errors(e):
    if request.path.startswith('/api/'):
        return jsonify(error=e.description), e.code
    return f'Erro {e.code}: {e.description}', e.code


@app.route('/')
def home():
    return render_template('admin.html', csrf=session['csrf'])


@app.get('/api/session')
def session_info():
    with db() as c:
        user = current_user(c)
        count = c.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']
        return jsonify(user=dict(user) if user else None, initialized=count>0, playPokemonSupported=True, clientsSupported=True)


@app.post('/api/login')
def login():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get('username','')).strip()
    password = str(payload.get('password',''))
    key = (username.casefold(), request.remote_addr)
    attempts, until = FAILED.get(key,(0,0))
    if until > time.time():
        return jsonify(error='Muitas tentativas. Aguarde 15 minutos.'), 429
    with db() as c:
        u = c.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        if not u or not check_password_hash(u['pw_hash'], password):
            attempts += 1
            FAILED[key] = (attempts, time.time()+900 if attempts>=5 else 0)
            return jsonify(error='Usuário ou senha incorretos.'), 401
        FAILED.pop(key,None)
        session.clear()
        session['user_id'] = u['id']
        session['csrf'] = secrets.token_urlsafe(32)
        session.permanent = True
        return jsonify(user={'username':u['username'], 'role':u['role']},csrf=session['csrf'])


@app.post('/api/logout')
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get('/api/search/nomes-pt')
def search_portuguese_names():
    with db() as c:
        require_user(c)
    query=str(request.args.get('q',''))[:90]
    if len(query.strip())<2:
        return jsonify(items=[],status='idle')
    return jsonify(query_portuguese_names(DATA, query))


@app.get('/api/cards')
def list_cards():
    with db() as c:
        u = require_user(c)
        rows = c.execute('''SELECT cards.*, u.username AS author, e.username AS editor
            FROM cards LEFT JOIN users u ON u.id=cards.author_id
            LEFT JOIN users e ON e.id=cards.editor_id ORDER BY cards.updated_at DESC''').fetchall()
        return jsonify(items=[{**json.loads(r['data_json']), 'author':r['author'], 'editor':r['editor'],
            'canEdit':can_edit_card(u, r), 'createdAt':r['created_at'],'updatedAt':r['updated_at']} for r in rows])


def normalize_card(data, card_id):
    if not isinstance(data,dict):
        abort(400, 'Dados inválidos.')
    client_id = data.get('commissionClientId', '')
    if not isinstance(client_id, str) or len(client_id) > 80:
        abort(400, 'Cliente da comissão inválido.')
    game = data.get('game')
    if game not in RARITIES:
        abort(400,'Jogo inválido.')
    def st(k,n=500):
        return str(data.get(k,'') or '').strip()[:n]
    name = st('name',120)
    if not name:
        abort(400, 'Informe o nome da carta.')
    rarity = st('rarity',80)
    if rarity == 'Ultra Raras' and game=='Pokémon': rarity='Ultra Rara'
    if rarity not in RARITIES[game]:
        abort(400, 'Raridade inválida.')
    categories = data.get('categories', [])
    if not isinstance(categories, list) or any(
        not isinstance(value, str) or value not in CATEGORIES[game] for value in categories
    ):
        abort(400, 'Categorias inválidas para o jogo selecionado.')
    categories = [value for value in CATEGORIES[game] if value in categories]
    if not isinstance(data.get('playPokemon', False), bool):
        abort(400, 'Opção Play Pokemon inválida.')
    play_pokemon = game == 'Pokémon' and data.get('playPokemon') is True
    play_pokemon_number = str(data.get('playPokemonNumber', '')).strip() if play_pokemon else ''
    if play_pokemon and not re.fullmatch(r'[0-9]{1,30}', play_pokemon_number):
        abort(400, 'Informe o número Play Pokemon com até 30 dígitos.')
    condition = st('condition',10)
    if condition not in CONDITIONS:
        abort(400,'Conservação inválida.')
    try:
        price = round(float(data.get('price',0)), 2)
        qty_raw = data.get('quantity',0)
        qty = int(qty_raw)
        if isinstance(qty_raw,float) and qty != qty_raw: raise ValueError()
    except (TypeError, ValueError, OverflowError):
        abort(400,'Preço ou quantidade inválidos.')
    if not 0 <= price <= 100_000_000 or not 0 <= qty <= 1_000_000:
        abort(400, 'Preço ou quantidade fora do limite.')
    language = st('language',60)
    if not language:
        abort(400, 'Informe o idioma real da carta (ex.: Português, Inglês ou Japonês).')
    image = st('image',800)
    if image and not (image.startswith('https://') or re.fullmatch(r'assets/[\w.\-/%]+',image)):
        abort(400, 'A imagem deve usar HTTPS ou uma imagem local válida.')
    obj = {k:st(k, 1200 if k=='description' else 140) for k in (
        'tcgdexId','tcgdexLanguage','scryfall','scryfallId','scryfallSet','scryfallNumber','scryfallLanguage','description')}
    return {
        'id':card_id, 'game':game,'name':name,'set':st('set',140),'rarity':rarity,'categories':categories,
        'playPokemon':play_pokemon,'playPokemonNumber':play_pokemon_number,
        'commissionClientId':client_id,
        'condition':condition,'language':language,'price':price,'quantity':qty,
        'published':data.get('published') is not False,'demo':False, 'image':image, **obj
    }


def audit(c, card_id, name, uid, action, before=None, after=None):
    c.execute('INSERT INTO audit (card_id,card_name,user_id,action,before_json,after_json,timestamp) VALUES (?,?,?,?,?,?,?)',(
        card_id,name,uid,action,json.dumps(before,ensure_ascii=False) if before else None,
        json.dumps(after,ensure_ascii=False) if after else None,now()))


def dirty(c):
    c.execute("UPDATE metadata SET value='1' WHERE key='dirty'")
    c.execute("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")


def validate_commission_client(c, card):
    client_id = card.get('commissionClientId')
    if client_id and not c.execute('SELECT id FROM clients WHERE id=?', (client_id,)).fetchone():
        abort(400, 'Selecione um cliente cadastrado para a comissão.')


def client_item(row):
    return {'id':row['id'], 'name':row['name'], 'phone':row['phone'],
            'cpf':row['cpf'], 'commissionPercent':row['commission_percent']}


def normalize_client(data):
    if not isinstance(data, dict):
        abort(400, 'Dados do cliente inválidos.')
    name = data.get('name', '')
    phone = data.get('phone', '')
    cpf = data.get('cpf', '')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
        abort(400, 'Informe o nome do cliente com até 120 caracteres.')
    if not isinstance(phone, str) or len(phone) > 30 or not re.fullmatch(r'[0-9+() .-]+', phone):
        abort(400, 'Informe um telefone válido.')
    phone = re.sub(r'[^0-9]', '', phone)
    if not 10 <= len(phone) <= 15:
        abort(400, 'Informe o telefone com DDD.')
    if not isinstance(cpf, str) or len(cpf) > 18 or not re.fullmatch(r'[0-9. -]+', cpf):
        abort(400, 'Informe o CPF com 11 dígitos.')
    cpf = re.sub(r'[^0-9]', '', cpf)
    if len(cpf) != 11:
        abort(400, 'Informe o CPF com 11 dígitos.')
    try:
        percent = Decimal(str(data.get('commissionPercent', '')))
        if not percent.is_finite() or not 0 <= percent <= 100 or percent != percent.quantize(Decimal('0.01')):
            raise ValueError()
    except (InvalidOperation, ValueError):
        abort(400, 'Informe uma comissão de 0 a 100%, com até duas casas decimais.')
    return name.strip(), phone, cpf, float(percent)


@app.get('/api/clients')
def list_clients():
    with db() as c:
        require_user(c)
        return jsonify(items=[client_item(row) for row in c.execute('SELECT * FROM clients ORDER BY name COLLATE NOCASE, id')])


@app.post('/api/clients')
def add_client():
    with db() as c:
        require_user(c)
        values = normalize_client(request.get_json(silent=True))
        cid = 'client-' + str(uuid4())
        stamp = now()
        try:
            c.execute('INSERT INTO clients VALUES (?,?,?,?,?,?,?)', (cid, *values, stamp, stamp))
        except sqlite3.IntegrityError:
            abort(400, 'Já existe um cliente com esse CPF.')
        item = client_item(c.execute('SELECT * FROM clients WHERE id=?', (cid,)).fetchone())
    return jsonify(item=item), 201


@app.put('/api/clients/<cid>')
def edit_client(cid):
    with db() as c:
        require_user(c)
        if not c.execute('SELECT id FROM clients WHERE id=?', (cid,)).fetchone():
            abort(404, 'Cliente não encontrado.')
        values = normalize_client(request.get_json(silent=True))
        try:
            c.execute('UPDATE clients SET name=?,phone=?,cpf=?,commission_percent=?,updated_at=? WHERE id=?', (*values, now(), cid))
        except sqlite3.IntegrityError:
            abort(400, 'Já existe um cliente com esse CPF.')
        item = client_item(c.execute('SELECT * FROM clients WHERE id=?', (cid,)).fetchone())
    return jsonify(item=item)


@app.post('/api/cards')
def add_card():
    data=request.get_json(silent=True) or {}
    with db() as c:
        u = require_user(c)
        cid='v-'+str(uuid4())
        card=normalize_card(data,cid)
        validate_commission_client(c, card)
        stamp=now()
        c.execute('INSERT INTO cards VALUES (?,?,?,?,?,?)',(cid,json.dumps(card,ensure_ascii=False),u['id'],u['id'],stamp,stamp))
        audit(c,cid,card['name'],u['id'],'cadastro',None,card)
        dirty(c)
    WAKE.set()
    return jsonify(item=card),201


@app.put('/api/cards/<cid>')
def edit_card(cid):
    data=request.get_json(silent=True) or {}
    with db() as c:
        u=require_user(c)
        row=c.execute('SELECT * FROM cards WHERE id=?',(cid,)).fetchone()
        if not row: abort(404,'Carta não encontrada.')
        require_card_editor(u, row)
        before=json.loads(row['data_json'])
        if isinstance(data, dict) and 'categories' not in data:
            data = {**data, 'categories': before.get('categories', [])}
        if isinstance(data, dict):
            data = {'playPokemon':before.get('playPokemon', False),
                    'commissionClientId':before.get('commissionClientId', ''),
                    'playPokemonNumber':before.get('playPokemonNumber', ''), **data}
        card=normalize_card(data,cid)
        validate_commission_client(c, card)
        c.execute('UPDATE cards SET data_json=?,editor_id=?,updated_at=? WHERE id=?',
                  (json.dumps(card,ensure_ascii=False),u['id'],now(),cid))
        audit(c,cid,card['name'],u['id'],'edição',before,card)
        dirty(c)
    WAKE.set()
    return jsonify(item=card)


@app.delete('/api/cards/<cid>')
def delete_card(cid):
    with db() as c:
        u=require_user(c)
        row=c.execute('SELECT * FROM cards WHERE id=?',(cid,)).fetchone()
        if not row: abort(404,'Carta não encontrada.')
        require_card_editor(u, row)
        before=json.loads(row['data_json'])
        audit(c,cid,before['name'],u['id'],'exclusão',before,None)
        c.execute('DELETE FROM cards WHERE id=?',(cid,))
        dirty(c)
    WAKE.set()
    return jsonify(ok=True)


@app.get('/api/history')
def history():
    with db() as c:
        require_user(c)
        rows=c.execute('''SELECT a.id,a.card_id,a.card_name,a.action,a.before_json,a.after_json,a.timestamp,
                          u.username AS username FROM audit a JOIN users u ON u.id=a.user_id
                          ORDER BY a.id DESC LIMIT 1000''').fetchall()
        return jsonify(items=[{**{k:r[k] for k in ('id','card_id','card_name','action','timestamp','username')},
                               'before':json.loads(r['before_json']) if r['before_json'] else None,
                               'after':json.loads(r['after_json']) if r['after_json'] else None} for r in rows])


@app.post('/api/cards/<cid>/sales')
def sell_card(cid):
    data = request.get_json(silent=True)
    if not isinstance(data, dict): abort(400, 'Dados de venda inválidos.')
    sale_id = data.get('saleId')
    if not isinstance(sale_id, str) or not re.fullmatch(r'[a-zA-Z0-9-]{16,80}', sale_id):
        abort(400, 'Identificador de venda inválido.')
    quantity = data.get('quantity')
    if type(quantity) is not int or not 1 <= quantity <= 1_000_000:
        abort(400, 'Informe uma quantidade inteira maior que zero.')
    try:
        price = Decimal(str(data.get('price')))
        if not price.is_finite() or not 0 <= price <= 100_000_000 or price != price.quantize(Decimal('0.01')):
            raise ValueError()
        cents = int(price * 100)
    except (InvalidOperation, ValueError, TypeError, OverflowError):
        abort(400, 'Informe um preço válido com até duas casas decimais.')
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        u = require_owner(c)
        previous = c.execute('SELECT * FROM sales WHERE id=?', (sale_id,)).fetchone()
        if previous:
            if (previous['card_id'], previous['user_id'], previous['quantity'], previous['unit_cents']) != (cid, u['id'], quantity, cents):
                abort(400, 'Identificador já utilizado em outra venda.')
            return jsonify(ok=True)
        row = c.execute('SELECT * FROM cards WHERE id=?', (cid,)).fetchone()
        if not row: abort(404, 'Carta não encontrada.')
        before = json.loads(row['data_json'])
        if quantity > before.get('quantity', 0): abort(400, 'Quantidade maior que o estoque disponível.')
        after = {**before, 'quantity': before['quantity'] - quantity}
        if after['quantity'] == 0:
            after['published'] = False
        stamp = now()
        c.execute('''INSERT INTO sales (id,card_id,card_json,user_id,quantity,unit_cents,timestamp,author_id)
                     VALUES (?,?,?,?,?,?,?,?)''',
                  (sale_id, cid, row['data_json'], u['id'], quantity, cents, stamp, row['author_id']))
        c.execute('UPDATE cards SET data_json=?,editor_id=?,updated_at=? WHERE id=?',
                  (json.dumps(after, ensure_ascii=False), u['id'], stamp, cid))
        audit(c, cid, before['name'], u['id'], 'venda', before, after)
        dirty(c)
    WAKE.set()
    return jsonify(ok=True), 201


@app.get('/api/sales')
def list_sales():
    with db() as c:
        require_user(c)
        rows = c.execute('''SELECT s.*,u.username FROM sales s JOIN users u ON u.id=s.user_id
                            WHERE s.status='active'
                            ORDER BY s.timestamp DESC,s.rowid DESC''').fetchall()
        return jsonify(items=[{'id':r['id'], 'card':json.loads(r['card_json']), 'quantity':r['quantity'],
                               'unitCents':r['unit_cents'], 'totalCents':r['quantity'] * r['unit_cents'],
                               'timestamp':r['timestamp'], 'username':r['username']} for r in rows],
                       totalCents=sum(r['quantity'] * r['unit_cents'] for r in rows))


@app.delete('/api/sales/<sid>')
def delete_sale(sid):
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        u = require_owner(c)
        row = c.execute('SELECT * FROM sales WHERE id=?', (sid,)).fetchone()
        if not row: abort(404, 'Venda não encontrada.')
        if row['status'] == 'deleted': return jsonify(ok=True)
        if row['status'] != 'active': abort(400, 'Esta venda já foi devolvida à vitrine.')
        card = json.loads(row['card_json'])
        snapshot = {**card, 'quantity':row['quantity'], 'price':row['unit_cents'] / 100,
                    'saleId':sid, 'saleTotalCents':row['quantity'] * row['unit_cents']}
        audit(c, row['card_id'], card['name'], u['id'], 'exclusão de venda', snapshot, None)
        c.execute("UPDATE sales SET status='deleted' WHERE id=?", (sid,))
    return jsonify(ok=True)


@app.post('/api/sales/<sid>/restore')
def restore_sale(sid):
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        u = require_owner(c)
        sale = c.execute('SELECT * FROM sales WHERE id=?', (sid,)).fetchone()
        if not sale: abort(404, 'Venda não encontrada.')
        if sale['status'] == 'restored': return jsonify(ok=True)
        if sale['status'] != 'active': abort(400, 'Esta venda já foi excluída.')
        row = c.execute('SELECT * FROM cards WHERE id=?', (sale['card_id'],)).fetchone()
        before = json.loads(row['data_json']) if row else None
        card = {**(before or json.loads(sale['card_json'])),
                'quantity':(before['quantity'] if before else 0) + sale['quantity'], 'published':True}
        if card['quantity'] > 1_000_000: abort(400, 'A devolução ultrapassa o limite de estoque.')
        stamp = now()
        if row:
            c.execute('UPDATE cards SET data_json=?,editor_id=?,updated_at=? WHERE id=?',
                      (json.dumps(card, ensure_ascii=False), u['id'], stamp, sale['card_id']))
        else:
            original = c.execute("SELECT user_id FROM audit WHERE card_id=? AND action='cadastro' ORDER BY id LIMIT 1",
                                 (sale['card_id'],)).fetchone()
            author = sale['author_id'] or (original['user_id'] if original else sale['user_id'])
            c.execute('INSERT INTO cards VALUES (?,?,?,?,?,?)',
                      (sale['card_id'], json.dumps(card, ensure_ascii=False), author, u['id'], stamp, stamp))
        c.execute("UPDATE sales SET status='restored' WHERE id=?", (sid,))
        audit(c, sale['card_id'], card['name'], u['id'], 'devolução à vitrine', before, card)
        dirty(c)
    WAKE.set()
    return jsonify(ok=True)


@app.get('/api/users')
def list_users():
    with db() as c:
        require_user(c)
        return jsonify(items=[dict(x) for x in c.execute('SELECT id,username,role,created_at FROM users ORDER BY id')])


@app.post('/api/users')
def add_user():
    data=request.get_json(silent=True) or {}
    username=str(data.get('username','')).strip()
    password=str(data.get('password',''))
    role=data.get('role','editor')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{3,32}',username): abort(400,'Usuário: 3 a 32 caracteres (letras, números, _ . -).')
    if len(password)<12: abort(400,'Use senha de no mínimo 12 caracteres.')
    if role not in ('editor','proprietario'): abort(400,'Perfil inválido.')
    with db() as c:
        require_owner(c)
        try:
            c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',
                      (username,generate_password_hash(password,method='scrypt'),role,now()))
        except sqlite3.IntegrityError:
            abort(400,'Nome de usuário já utilizado.')
    return jsonify(ok=True),201


@app.post('/api/password')
def change_password():
    payload=request.get_json(silent=True) or {}
    new=str(payload.get('newPassword',''))
    if len(new)<12: abort(400,'A nova senha precisa de no mínimo 12 caracteres.')
    with db() as c:
        u=require_user(c)
        old=c.execute('SELECT pw_hash FROM users WHERE id=?',(u['id'],)).fetchone()['pw_hash']
        if not check_password_hash(old,str(payload.get('oldPassword',''))):
            abort(403,'Senha atual incorreta.')
        c.execute('UPDATE users SET pw_hash=? WHERE id=?',(generate_password_hash(new,method='scrypt'),u['id']))
    return jsonify(ok=True)


@app.get('/api/status')
def status():
    with db() as c:
        require_user(c)
        meta=dict(c.execute('SELECT key,value FROM metadata').fetchall())
        return jsonify(dirty=meta.get('dirty')=='1',lastPublish=meta.get('last_publish',''),
                       lastError=meta.get('last_error',''),repo=REPO,hasToken=bool(get_token()))


def get_token():
    try:
        import keyring
        return keyring.get_password(KEYRING_SERVICE,KEYRING_NAME)
    except Exception:
        return None


def catalog_payload():
    with db() as c:
        rows=c.execute('SELECT data_json FROM cards ORDER BY created_at, id').fetchall()
        items=[json.loads(row['data_json']) for row in rows]
    return {'version':1,'updatedAt':now(),'items':[{key:card[key] for key in FIELDS if key in card}
            for card in items if card['published']]}


def published_js(payload):
    content=json.dumps(payload,ensure_ascii=False,indent=2)
    return '/* Catálogo TCG Marketplace gerado pelo Windows */\nwindow.TCG_CATALOG = '+content.replace('<','\\u003c')+';\n'


def github_request(method,url,token,payload=None):
    headers={'Authorization':f'Bearer {token}','Accept':'application/vnd.github+json',
             'X-GitHub-Api-Version':'2022-11-28','User-Agent':'TCGMarketplace-Windows'}
    content=None
    if payload is not None:
        content=json.dumps(payload).encode('utf-8')
        headers['Content-Type']='application/json'
    req=Request(url,data=content,headers=headers,method=method)
    with urlopen(req,timeout=20) as resp:
        return json.loads(resp.read().decode('utf-8'))


def publish_now():
    if not PUBLISH_LOCK.acquire(blocking=False):
        return False, 'Publicação já em andamento.'
    try:
        token=get_token()
        if not token:
            return False,'Configure o token do GitHub no Gerenciador de Credenciais do Windows.'
        url=f'https://api.github.com/repos/{REPO}/contents/{GITHUB_FILE}'
        current=github_request('GET',url+'?ref='+BRANCH,token)
        with db() as c:
            revision=c.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()['value']
        payload=catalog_payload()
        text=published_js(payload)
        data={'message':'Atualizar catálogo do TCG Marketplace (Windows)',
              'content':base64.b64encode(text.encode('utf-8')).decode('ascii'),
              'sha':current['sha'],'branch':BRANCH}
        github_request('PUT',url,token,data)
        with db() as c:
            c.execute("UPDATE metadata SET value='0' WHERE key='dirty' AND (SELECT value FROM metadata WHERE key='revision')=?",(revision,))
            c.execute("UPDATE metadata SET value=? WHERE key='last_publish'",(now(),))
            c.execute("UPDATE metadata SET value='' WHERE key='last_error'")
        return True,'Catálogo enviado ao GitHub. Aguarde a publicação do Pages.'
    except (HTTPError,URLError,TimeoutError,KeyError,ValueError) as exc:
        error=('HTTP '+str(exc.code) if isinstance(exc,HTTPError) else type(exc).__name__)
        with db() as c:
            c.execute("UPDATE metadata SET value=? WHERE key='last_error'",(error,))
        LOGGER.warning('Publicação falhou: %s',error)
        return False,'Falha no GitHub: '+error+' (verifique token, rede e permissões).'
    finally:
        PUBLISH_LOCK.release()


@app.post('/api/publish')
def publish():
    with db() as c:require_user(c)
    ok,message=publish_now()
    return jsonify(ok=ok,message=message),200 if ok else 503


def backup_db(*, manual=False):
    from contextlib import closing
    import tempfile

    backups = DATA / 'backups'
    backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y-%m-%d-%H%M%S-%f' if manual else '%Y-%m-%d')
    suffix = '-' + uuid4().hex[:8] if manual else ''
    dst = backups / ('marketplace-' + stamp + suffix + '.sqlite3')
    if dst.exists():
        return dst
    with tempfile.NamedTemporaryFile(prefix='marketplace-backup-', suffix='.tmp', dir=backups, delete=False) as temp:
        partial = Path(temp.name)
    try:
        with db() as source, closing(sqlite3.connect(partial)) as target:
            source.backup(target)
        os.replace(partial, dst)
    finally:
        partial.unlink(missing_ok=True)
    return dst


def worker():
    while True:
        WAKE.wait(timeout=60)
        WAKE.clear()
        time.sleep(2)
        WAKE.clear()
        try:
            backup_db()
            with db() as c:
                pending=c.execute("SELECT value FROM metadata WHERE key='dirty'").fetchone()['value']=='1'
            if pending and get_token():
                publish_now()
        except Exception:
            LOGGER.exception('Erro no serviço de sincronização')


def seed_from_catalog(user_id):
    source=(DATA/'catalogo-inicial.js').read_text(encoding='utf-8')
    value=source.split('window.TCG_CATALOG = ',1)[1].rsplit(';',1)[0]
    items=json.loads(value)['items']
    with db() as c:
        for obj in items:
            cid=obj['id']
            obj['published']=True
            stamp=now()
            c.execute('INSERT OR IGNORE INTO cards VALUES (?,?,?,?,?,?)',
                      (cid,json.dumps(obj,ensure_ascii=False),user_id,user_id,stamp,stamp))
            audit(c,cid,obj['name'],user_id,'importação inicial',None,obj)
    return len(items)


def initial_setup():
    initialize_db()
    with db() as c:
        if c.execute('SELECT COUNT(*) FROM users').fetchone()[0] != 0:
            print('Já existe um administrador. Não é permitido reinicializar usuários.');return
    print('CONFIGURAÇÃO INICIAL — TCG Marketplace')
    print('Primeiro usuário: admin')
    password=getpass.getpass('Crie/digite a senha do usuário admin (mín. 12 caracteres): ')
    again=getpass.getpass('Confirme a senha: ')
    if password != again or len(password)<12:
        print('Senhas diferentes ou muito curtas. Nenhuma conta criada.');return
    with db() as c:
        cur=c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',
                      ('admin',generate_password_hash(password,method='scrypt'),'proprietario',now()))
        uid=cur.lastrowid
    total=seed_from_catalog(uid)
    print(f'Usuário admin criado. {total} cartas importadas com autoria admin. Senha armazenada somente como hash.')


def reset_admin_password():
    initialize_db()
    with db() as c:
        owner = c.execute(
            "SELECT id FROM users WHERE username=? AND role='proprietario'", ('admin',)
        ).fetchone()
    if not owner:
        print('A conta admin ainda não foi criada. Execute INSTALAR_WINDOWS.bat.')
        return
    print('REDEFINIR SENHA LOCAL — admin')
    print('Este procedimento exige acesso ao computador administrativo.')
    print('Seu catálogo, usuários e histórico serão preservados.')
    password = getpass.getpass('Nova senha (mín. 12 caracteres): ')
    confirm = getpass.getpass('Repita a nova senha: ')
    if not password or password != confirm or len(password) < 12:
        print('Senhas diferentes ou muito curtas. Nenhuma alteração efetuada.')
        return
    with db() as c:
        c.execute('UPDATE users SET pw_hash=? WHERE id=?',
                  (generate_password_hash(password, method='scrypt'), owner['id']))
    print('Senha de admin redefinida. Agora abra INICIAR_PAINEL.bat.')


def validate_github_token(token):
    if not token:
        return False, 'Nenhum token está configurado.'
    try:
        user=github_request('GET','https://api.github.com/user',token)
        if not user.get('login'):
            return False,'GitHub não confirmou o usuário do token.'
        catalog_url=f'https://api.github.com/repos/{REPO}/contents/{GITHUB_FILE}?ref={BRANCH}'
        catalog=github_request('GET',catalog_url,token)
        if not catalog.get('sha'):
            return False,'O GitHub não confirmou acesso ao arquivo do catálogo.'
        return True,('Token autenticado para '+user['login']+
                     '. Acesso de leitura ao catálogo confirmado. '+
                     'A permissão Contents: Read and write será confirmada ao publicar.')
    except HTTPError as exc:
        if exc.code == 401:
            return False,('HTTP 401: o GitHub recusou o token. Confira se o código '+
                          'foi copiado integralmente, se não expirou nem foi revogado. '+
                          'Use um novo token, se necessário.')
        if exc.code == 403:
            return False,('HTTP 403: o token foi recusado por restrição ou permissão. '+
                          'Confira o proprietário e o acesso ao repositório.')
        if exc.code == 404:
            return False,('HTTP 404: repositório ou catálogo inacessível para esse token. '+
                          'Selecione seu-usuario/tcg-marketplace em Only select repositories.')
        return False,'GitHub respondeu com HTTP '+str(exc.code)+'.'
    except (URLError, TimeoutError):
        return False,'Não foi possível alcançar a API do GitHub. Confira a conexão de internet.'
    except (KeyError, ValueError):
        return False,'Resposta inesperada do GitHub. Nenhum token foi alterado.'


def read_github_token():
    try:
        import tkinter as tk
        from tkinter import simpledialog
        window=tk.Tk()
        window.withdraw()
        window.attributes('-topmost',True)
        try:
            token=simpledialog.askstring(
                'TCG Marketplace — Token GitHub',
                'Cole o token do GitHub (Ctrl+V).\\n'
                'O código ficará oculto. Clique em OK para verificar.',
                parent=window,show='*')
        finally:
            window.destroy()
        return (token or '').strip()
    except Exception:
        print('Não foi possível abrir a janela gráfica. Usando o terminal.')
        print('ATENÇÃO: neste campo de senha do Windows, Ctrl+V pode falhar.')
        print('Clique com o botão DIREITO ou use o menu da janela para colar.')
        return getpass.getpass('Cole o token GitHub (entrada oculta): ').strip()


def configure_github():
    print('TCG MARKETPLACE — CONFIGURAR TOKEN DO GITHUB')
    print('Repositório: seu-usuario/tcg-marketplace')
    print('Permissão necessária: Contents (Read and write).')
    print('Execute este arquivo normalmente, com o mesmo usuário do Windows que abre o painel.')
    token=read_github_token()
    if not token:
        print('Nenhum token informado. Credencial anterior mantida.');return
    if any(ord(ch)<32 for ch in token):
        print('A entrada contém caracteres de controle e não é um token válido.')
        print('No terminal do Windows, Ctrl+V pode inserir um caractere inválido em entradas ocultas.')
        print('Use a janela de colagem ou, se ela não abrir, clique com o botão direito para colar.')
        return
    print('Verificando o token no GitHub, sem mostrar o código...')
    ok,message=validate_github_token(token)
    print(message)
    if not ok:
        print('O token NÃO foi salvo; corrija-o e execute novamente CONFIGURAR_GITHUB.bat.')
        return
    import keyring
    keyring.set_password(KEYRING_SERVICE,KEYRING_NAME,token)
    print('Token salvo com segurança no Gerenciador de Credenciais do Windows.')
    print('Agora clique em Publicar agora no GitHub no painel.')


def check_github():
    print('TCG MARKETPLACE — TESTE DE AUTENTICAÇÃO GITHUB')
    token=get_token()
    if not token:
        print('Nenhum token encontrado para esta conta do Windows.')
        print('Execute CONFIGURAR_GITHUB.bat sem usar Executar como administrador.')
        return
    ok,message=validate_github_token(token)
    print(message)
    if not ok:
        print('Execute CONFIGURAR_GITHUB.bat para substituir a credencial com erro.')
    else:
        print('Se a publicação ainda falhar com HTTP 403, confira Contents: Read and write.')


def main():
    import sys
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv)>1 and sys.argv[1]=='setup':
        initial_setup();return
    if len(sys.argv)>1 and sys.argv[1]=='reset-admin':
        reset_admin_password();return
    if len(sys.argv)>1 and sys.argv[1]=='github':
        configure_github();return
    if len(sys.argv)>1 and sys.argv[1]=='github-check':
        check_github();return
    if len(sys.argv)>1 and sys.argv[1]=='backup':
        print('Backup salvo em', backup_db(manual=True));return
    if len(sys.argv)>1 and sys.argv[1]=='start':
        from waitress import serve
        threading.Thread(target=worker,daemon=True).start()
        LOGGER.info('Painel disponível SOMENTE em http://127.0.0.1:8765')
        serve(app,host='127.0.0.1',port=8765,threads=4)
        return
    print('Comandos: python app.py setup | reset-admin | github | start | backup')

if __name__=='__main__':main()
