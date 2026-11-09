from __future__ import annotations
import json
import logging
import lzma
from pathlib import Path
import re
import sqlite3
import threading
import time
import unicodedata
from urllib.request import Request, urlopen

URL = 'https://mtgjson.com/api/v5/AtomicCards.json.xz'
INDEX_LOCK = threading.Lock()
STATE = {'working': False, 'last_attempt': 0, 'error': ''}
LOGGER = logging.getLogger('marketplace.translations')


def normalized(value):
    value = unicodedata.normalize('NFKD', str(value).casefold())
    return ''.join(c for c in value if not unicodedata.combining(c))


def atomic_pairs(stream):
    decoder = json.JSONDecoder()
    buffer = stream.read(65536)
    match = re.search(r'"data"\s*:\s*\{', buffer)
    while not match:
        more = stream.read(65536)
        if not more:
            raise ValueError('MTGJSON sem objeto data')
        buffer += more
        if len(buffer) > 1024 * 1024:
            raise ValueError('Cabecalho MTGJSON inesperadamente grande')
        match = re.search(r'"data"\s*:\s*\{', buffer)
    buffer = buffer[match.end():]
    while True:
        buffer = buffer.lstrip(' \t\r\n,')
        if not buffer:
            buffer = stream.read(65536)
            if not buffer:
                raise ValueError('JSON finalizado incorretamente')
            continue
        if buffer[0] == '}':
            return
        while True:
            try:
                english, used = decoder.raw_decode(buffer)
                if not isinstance(english, str):
                    raise ValueError('Nome do cartao invalido')
                buffer = buffer[used:].lstrip()
                break
            except json.JSONDecodeError:
                extra = stream.read(65536)
                if not extra:
                    raise ValueError('Falha ao ler nome do cartao')
                buffer += extra
        while not buffer:
            extra = stream.read(65536)
            if not extra: raise ValueError('Chave sem conteudo')
            buffer += extra
        if buffer[0] != ':':
            raise ValueError('Separador de dados ausente')
        buffer = buffer[1:].lstrip()
        while True:
            try:
                cards, used = decoder.raw_decode(buffer)
                if not isinstance(cards, list):
                    raise ValueError('Cartas em formato inesperado')
                buffer = buffer[used:]
                break
            except json.JSONDecodeError:
                extra = stream.read(65536)
                if not extra:
                    raise ValueError('Cartas interrompidas antes do fim')
                buffer += extra
                if len(buffer) > 16 * 1024 * 1024:
                    raise ValueError('Registro de carta grande demais')
        seen = set()
        for card in cards:
            if not isinstance(card, dict): continue
            for foreign in card.get('foreignData') or []:
                if not isinstance(foreign, dict): continue
                if foreign.get('language') not in ('Portuguese (Brazil)', 'Portuguese'):
                    continue
                pt = str(foreign.get('name') or '').strip()
                if pt and pt not in seen:
                    seen.add(pt)
                    yield english, pt


def build_index(folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    compressed = folder / 'mtgjson-pt-download.xz'
    partial = folder / 'nomes-magic-pt-temporario.sqlite3'
    dest = folder / 'nomes-magic-pt.sqlite3'
    count = 0
    try:
        request = Request(URL, headers={'User-Agent': 'TCGMarketplace-Windows/1.0 (MTGJSON name index)', 'Accept': 'application/octet-stream'})
        total = 0
        with urlopen(request, timeout=45) as response, compressed.open('wb') as output:
            while True:
                chunk = response.read(262144)
                if not chunk: break
                total += len(chunk)
                if total > 48 * 1024 * 1024:
                    raise ValueError('Download maior que o esperado')
                output.write(chunk)
        if total < 100:
            raise ValueError('Arquivo de traducao nao foi recebido')
        if partial.exists(): partial.unlink()
        with sqlite3.connect(partial) as conn:
            conn.execute('CREATE TABLE names (english TEXT NOT NULL, portuguese TEXT NOT NULL, lookup TEXT NOT NULL, PRIMARY KEY (english,portuguese))')
            with lzma.open(compressed,'rt',encoding='utf-8') as stream:
                batch=[]
                for en, pt in atomic_pairs(stream):
                    batch.append((en,pt,normalized(en+' '+pt)))
                    if len(batch) >= 750:
                        conn.executemany('INSERT OR IGNORE INTO names VALUES (?,?,?)',batch)
                        count+=len(batch)
                        batch.clear()
                if batch:
                    conn.executemany('INSERT OR IGNORE INTO names VALUES (?,?,?)',batch)
                    count+=len(batch)
            conn.commit()
        if count < 1000:
            raise ValueError('Numero inesperadamente pequeno de traducoes')
        partial.replace(dest)
        LOGGER.info('Indice PT-BR pronto, pares encontrados: %d',count)
    finally:
        compressed.unlink(missing_ok=True)
        partial.unlink(missing_ok=True)


def index_worker(folder):
    try:
        build_index(folder)
        with INDEX_LOCK:
            STATE['error']=''
    except Exception as exc:
        LOGGER.warning('Nao foi possivel preparar nomes em portugues: %s',exc)
        with INDEX_LOCK:
            STATE['error']=str(exc)[:180]
    finally:
        with INDEX_LOCK:
            STATE['working']=False


def suggest_names(folder, query, limit=18):
    folder = Path(folder)
    index = folder / 'nomes-magic-pt.sqlite3'
    query = str(query or '').strip()[:90]
    words = [word for word in normalized(query).split() if len(word) > 1]
    if not query or not words:
        return {'items':[], 'status':'idle'}
    if not index.exists():
        with INDEX_LOCK:
            now = time.monotonic()
            if not STATE['working'] and (not STATE['last_attempt'] or now-STATE['last_attempt']>180):
                STATE['working']=True
                STATE['last_attempt']=now
                threading.Thread(target=index_worker,args=(folder,),daemon=True,name='MarketplaceMTGJSONPT').start()
            state='preparando' if STATE['working'] else 'indisponivel'
        return {'items':[], 'status':state}
    try:
        with sqlite3.connect(f'file:{index.as_posix()}?mode=ro',uri=True,timeout=3) as conn:
            sql='SELECT english,portuguese FROM names WHERE '+ ' AND '.join('lookup LIKE ?' for _ in words) + ' LIMIT 300'
            candidates=conn.execute(sql,[f'%{w}%' for w in words]).fetchall()
        q=normalized(query)
        def score(pair):
            en,pt=pair
            pt_norm,en_norm=normalized(pt),normalized(en)
            if pt_norm==q: return (0,len(pt_norm))
            if pt_norm.startswith(q): return (1,len(pt_norm))
            if en_norm==q: return (2,len(en_norm))
            if en_norm.startswith(q): return (3,len(en_norm))
            if any(word.startswith(q) for word in pt_norm.split()): return (4,len(pt_norm))
            return (5,len(pt_norm))
        candidates.sort(key=score)
        return {'items':[{'game':'Magic','name':en,'localizedName':pt,'source':'MTGJSON'} for en,pt in candidates[:limit]], 'status':'pronto'}
    except sqlite3.DatabaseError as exc:
        LOGGER.warning('Falha de consulta do indice de traducoes: %s',exc)
        return {'items':[], 'status':'indisponivel'}