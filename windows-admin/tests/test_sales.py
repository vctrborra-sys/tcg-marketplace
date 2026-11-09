import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
work = tempfile.TemporaryDirectory()
os.environ['MARKETPLACE_DATA'] = work.name
os.environ['MARKETPLACE_DB'] = str(Path(work.name) / 'sales.sqlite3')
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('sales_app', ROOT / 'app.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Sales(unittest.TestCase):
    def setUp(self):
        with mod.db() as c:
            for table in ('sales', 'audit', 'cards', 'clients', 'users'):
                c.execute('DELETE FROM ' + table)
            uid = c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',
                            ('Admin', 'unused', 'proprietario', mod.now())).lastrowid
        self.uid = uid
        self.client = mod.app.test_client()
        with self.client.session_transaction() as s:
            s['user_id'] = uid
            s['csrf'] = 'test-csrf'
        self.headers = {'X-CSRF-Token': 'test-csrf'}
        card = {'game':'Magic', 'name':'Sol Ring', 'rarity':'Rara', 'condition':'NM',
                'language':'Português', 'price':12.35, 'quantity':3, 'set':'Commander'}
        response = self.client.post('/api/cards', json=card, headers=self.headers)
        self.assertEqual(response.status_code, 201)
        self.cid = response.json['item']['id']

    def sale(self, quantity=1, price=12.35, sale_id=None):
        return self.client.post('/api/cards/' + self.cid + '/sales',
                                json={'quantity':quantity, 'price':price, 'saleId':sale_id or str(uuid4())},
                                headers=self.headers)

    def create_client(self, **overrides):
        data={'name':'Cliente de teste','phone':'(11) 99999-0000','cpf':'000.000.000-00','commissionPercent':'12.50'}
        return self.client.post('/api/clients',json={**data,**overrides},headers=self.headers)

    def test_clients_create_edit_duplicate_and_do_not_dirty_catalog(self):
        with mod.db() as c:
            revision=c.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()[0]
        response=self.create_client()
        self.assertEqual(response.status_code,201)
        item=response.json['item']
        self.assertEqual(item['phone'],'11999990000')
        self.assertEqual(item['cpf'],'00000000000')
        self.assertEqual(item['commissionPercent'],12.5)
        self.assertEqual(self.create_client().status_code,400)
        updated=self.client.put('/api/clients/'+item['id'],json={**item,'name':'Cliente atualizado','commissionPercent':20},headers=self.headers)
        self.assertEqual(updated.status_code,200)
        self.assertEqual(self.client.get('/api/clients').json['items'][0]['name'],'Cliente atualizado')
        mod.initialize_db()
        self.assertEqual(self.client.get('/api/clients').json['items'][0]['commissionPercent'],20)
        with mod.db() as c:
            self.assertEqual(c.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()[0],revision)

    def test_client_validation_authentication_and_csrf(self):
        for values in [{'name':''},{'name':'x'*121},{'phone':'123'},{'phone':'abc11999990000'},
                       {'cpf':'123'},{'cpf':'abc00000000000'},{'commissionPercent':-1},
                       {'commissionPercent':101},{'commissionPercent':'NaN'},{'commissionPercent':'Infinity'},
                       {'commissionPercent':True},{'commissionPercent':1.001}]:
            self.assertEqual(self.create_client(**values).status_code,400)
        self.assertEqual(self.client.post('/api/clients',json={}).status_code,403)
        anonymous=mod.app.test_client()
        self.assertEqual(anonymous.get('/api/clients').status_code,401)
        with anonymous.session_transaction() as s:
            s['csrf']='test-csrf'
        self.assertEqual(anonymous.post('/api/clients',json={},headers=self.headers).status_code,401)
        self.assertEqual(anonymous.put('/api/clients/missing',json={},headers=self.headers).status_code,401)
        self.assertEqual(self.client.put('/api/clients/missing',json={},headers=self.headers).status_code,404)

    def test_commission_link_copy_old_client_edit_sale_restore_and_public_privacy(self):
        client=self.create_client().json['item']
        original=self.client.get('/api/cards').json['items'][0]
        linked=self.client.put('/api/cards/'+self.cid,json={**original,'commissionClientId':client['id']},headers=self.headers)
        self.assertEqual(linked.status_code,200)
        self.assertEqual(linked.json['item']['commissionClientId'],client['id'])
        older={key:value for key,value in linked.json['item'].items() if key!='commissionClientId'}
        edited=self.client.put('/api/cards/'+self.cid,json=older,headers=self.headers)
        self.assertEqual(edited.json['item']['commissionClientId'],client['id'])
        copied=self.client.post('/api/cards',json={**linked.json['item'],'quantity':1},headers=self.headers)
        self.assertEqual(copied.json['item']['commissionClientId'],client['id'])
        published=mod.published_js(mod.catalog_payload())
        for secret in ['commissionClientId','commissionPercent',client['id'],client['name'],client['phone'],client['cpf']]:
            self.assertNotIn(secret,published)
        self.assertEqual(self.sale().status_code,201)
        sale=self.client.get('/api/sales').json['items'][0]
        self.assertEqual(sale['card']['commissionClientId'],client['id'])
        self.client.delete('/api/cards/'+self.cid,headers=self.headers)
        restored=self.client.post('/api/sales/'+sale['id']+'/restore',headers=self.headers)
        self.assertEqual(restored.status_code,200)
        card=next(item for item in self.client.get('/api/cards').json['items'] if item['id']==self.cid)
        self.assertEqual(card['commissionClientId'],client['id'])
        unlinked=self.client.put('/api/cards/'+self.cid,json={**card,'commissionClientId':''},headers=self.headers)
        self.assertEqual(unlinked.json['item']['commissionClientId'],'')

    def test_commission_rejects_unknown_client_and_respects_card_permissions(self):
        card=self.client.get('/api/cards').json['items'][0]
        for value in ['missing',True,[],None]:
            response=self.client.put('/api/cards/'+self.cid,json={**card,'commissionClientId':value},headers=self.headers)
            self.assertEqual(response.status_code,400)
            self.assertEqual(self.client.post('/api/cards',json={**card,'commissionClientId':value},headers=self.headers).status_code,400)
        client=self.create_client().json['item']
        with mod.db() as c:
            uid=c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',('Editor comissão','unused','editor',mod.now())).lastrowid
        with self.client.session_transaction() as s:
            s['user_id']=uid
        self.assertEqual(self.client.put('/api/cards/'+self.cid,json={**card,'commissionClientId':client['id']},headers=self.headers).status_code,403)
        self.assertEqual(self.client.post('/api/cards',json={**card,'commissionClientId':client['id']},headers=self.headers).status_code,201)

    def test_play_pokemon_persists_edits_publishes_and_can_be_disabled(self):
        card={'game':'Pokémon','name':'Play test','rarity':'Comum','condition':'NM','language':'Português',
              'price':10,'quantity':2,'playPokemon':True,'playPokemonNumber':'00123'}
        created=self.client.post('/api/cards',json=card,headers=self.headers)
        self.assertEqual(created.status_code,201)
        cid=created.json['item']['id']
        invalid=self.client.put('/api/cards/'+cid,json={**card,'playPokemonNumber':'abc'},headers=self.headers)
        self.assertEqual(invalid.status_code,400)
        old_client={k:v for k,v in card.items() if k not in ('playPokemon','playPokemonNumber')}
        edited=self.client.put('/api/cards/'+cid,json={**old_client,'quantity':3},headers=self.headers)
        self.assertTrue(edited.json['item']['playPokemon'])
        self.assertEqual(edited.json['item']['playPokemonNumber'],'00123')
        published=next(row for row in mod.catalog_payload()['items'] if row['id']==cid)
        self.assertEqual(published['playPokemonNumber'],'00123')
        history=self.client.get('/api/history').json['items']
        self.assertEqual(next(row for row in history if row['card_id']==cid and row['action']=='edição')['after']['playPokemonNumber'],'00123')
        disabled=self.client.put('/api/cards/'+cid,json={**card,'playPokemon':False},headers=self.headers)
        self.assertFalse(disabled.json['item']['playPokemon'])
        self.assertEqual(disabled.json['item']['playPokemonNumber'],'')

    def test_sale_decrements_stock_and_survives_card_deletion(self):
        self.assertEqual(self.sale(2).status_code, 201)
        cards = self.client.get('/api/cards').json['items']
        self.assertEqual(cards[0]['quantity'], 1)
        self.client.delete('/api/cards/' + self.cid, headers=self.headers)
        sales = self.client.get('/api/sales').json
        self.assertEqual(sales['totalCents'], 2470)
        self.assertEqual(sales['items'][0]['card']['set'], 'Commander')
        self.assertEqual(sales['items'][0]['username'], 'Admin')

    def test_invalid_sale_rolls_back_everything(self):
        for qty, price in [(4,12), (0,12), (-1,12), (1.5,12), (True,12), (1,-1), (1,'NaN'), (1,'Infinity'), (1,1.001)]:
            self.assertEqual(self.sale(qty, price).status_code, 400)
        self.assertEqual(self.client.get('/api/cards').json['items'][0]['quantity'], 3)
        self.assertEqual(self.client.get('/api/sales').json['totalCents'], 0)
        self.assertEqual(len(self.client.get('/api/history').json['items']), 1)

    def test_retry_is_idempotent_and_stock_cannot_go_negative(self):
        key = str(uuid4())
        self.assertEqual(self.sale(3, 0.1, key).status_code, 201)
        self.assertEqual(self.sale(3, 0.1, key).status_code, 200)
        self.assertEqual(self.sale(2, 0.1, key).status_code, 400)
        self.assertEqual(self.sale().status_code, 400)
        data = self.client.get('/api/sales').json
        self.assertEqual(len(data['items']), 1)
        self.assertEqual(data['totalCents'], 30)

    def test_authentication_and_csrf_are_required(self):
        self.assertEqual(self.client.post('/api/cards/' + self.cid + '/sales', json={}).status_code, 403)
        other = mod.app.test_client()
        self.assertEqual(other.get('/api/sales').status_code, 401)
        with other.session_transaction() as s:
            s['csrf'] = 'test-csrf'
        response = other.post('/api/cards/' + self.cid + '/sales', headers=self.headers,
                              json={'quantity':1, 'price':1, 'saleId':str(uuid4())})
        self.assertEqual(response.status_code, 401)

    def test_schema_initialization_preserves_existing_data(self):
        mod.initialize_db()
        self.assertEqual(self.client.get('/api/cards').json['items'][0]['id'], self.cid)
        self.assertEqual(self.sale().status_code, 201)
        mod.initialize_db()
        self.assertEqual(self.client.get('/api/sales').json['totalCents'], 1235)
        self.assertNotIn('sales', mod.catalog_payload())

    def test_editors_only_manage_their_own_cards_and_cannot_sell(self):
        with mod.db() as c:
            editor = c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',
                               ('Editor', 'unused', 'editor', mod.now())).lastrowid
            other_editor = c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',
                                     ('Outro', 'unused', 'editor', mod.now())).lastrowid
        original = self.client.get('/api/cards').json['items'][0]
        with self.client.session_transaction() as s: s['user_id'] = other_editor
        other = self.client.post('/api/cards', json=original, headers=self.headers).json['item']
        with self.client.session_transaction() as s: s['user_id'] = editor
        own = self.client.post('/api/cards', json=original, headers=self.headers).json['item']
        items = self.client.get('/api/cards').json['items']
        self.assertEqual({c['id']:c['canEdit'] for c in items},
                         {self.cid:False, other['id']:False, own['id']:True})
        for foreign in (original, other):
            path = '/api/cards/' + foreign['id']
            self.assertEqual(self.client.put(path, json={**foreign, 'author_id':editor, 'price':1}, headers=self.headers).status_code, 403)
            self.assertEqual(self.client.delete(path, headers=self.headers).status_code, 403)
        self.assertEqual(self.client.put('/api/cards/' + own['id'], json={**own, 'price':10}, headers=self.headers).status_code, 200)
        self.assertEqual(self.sale().status_code, 403)
        self.assertEqual(self.client.post('/api/cards/' + own['id'] + '/sales', json={
            'saleId':str(uuid4()), 'quantity':1, 'price':10}, headers=self.headers).status_code, 403)
        self.assertEqual(self.client.delete('/api/cards/' + own['id'], headers=self.headers).status_code, 200)
        with self.client.session_transaction() as s: s['user_id'] = self.uid
        self.assertEqual(self.client.put('/api/cards/' + other['id'], json=other, headers=self.headers).status_code, 200)
        self.assertEqual(self.client.delete('/api/cards/' + other['id'], headers=self.headers).status_code, 200)

    def test_restore_updates_stock_publication_and_revenue_only_once(self):
        key = str(uuid4())
        self.assertEqual(self.sale(3, 15, key).status_code, 201)
        card = self.client.get('/api/cards').json['items'][0]
        self.assertEqual(card['quantity'], 0)
        self.assertFalse(card['published'])
        path = '/api/sales/' + key + '/restore'
        self.assertEqual(self.client.post(path, headers=self.headers).status_code, 200)
        self.assertEqual(self.client.post(path, headers=self.headers).status_code, 200)
        self.assertEqual(self.sale(3, 15, key).status_code, 200)
        card = self.client.get('/api/cards').json['items'][0]
        self.assertEqual(card['quantity'], 3)
        self.assertEqual(card['price'], 12.35)
        self.assertTrue(card['published'])
        self.assertEqual(self.client.get('/api/sales').json, {'items':[], 'totalCents':0})
        self.assertEqual(self.client.delete('/api/sales/' + key, headers=self.headers).status_code, 400)

    def test_delete_sale_keeps_stock_and_audit_and_does_not_allow_restore(self):
        key = str(uuid4())
        self.sale(2, 10, key)
        path = '/api/sales/' + key
        self.assertEqual(self.client.delete(path, headers=self.headers).status_code, 200)
        self.assertEqual(self.client.delete(path, headers=self.headers).status_code, 200)
        self.assertEqual(self.client.post(path + '/restore', headers=self.headers).status_code, 400)
        self.assertEqual(self.client.get('/api/cards').json['items'][0]['quantity'], 1)
        self.assertEqual(self.client.get('/api/sales').json['totalCents'], 0)
        actions = [row['action'] for row in self.client.get('/api/history').json['items']]
        self.assertEqual(actions.count('exclusão de venda'), 1)

    def test_restore_deleted_card_preserves_original_author_and_metadata(self):
        with mod.db() as c:
            editor = c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',
                               ('Editor', 'unused', 'editor', mod.now())).lastrowid
            c.execute('UPDATE cards SET author_id=? WHERE id=?', (editor, self.cid))
        key = str(uuid4())
        self.sale(2, 18, key)
        self.client.delete('/api/cards/' + self.cid, headers=self.headers)
        self.assertEqual(self.client.post('/api/sales/' + key + '/restore', headers=self.headers).status_code, 200)
        card = self.client.get('/api/cards').json['items'][0]
        self.assertEqual(card['quantity'], 2)
        self.assertEqual(card['author'], 'Editor')
        self.assertEqual(card['set'], 'Commander')
        self.assertEqual(card['price'], 12.35)
        self.assertTrue(card['published'])

    def test_sales_actions_require_owner_and_csrf(self):
        key = str(uuid4()); self.sale(1, 10, key)
        with mod.db() as c:
            editor = c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',
                               ('Editor', 'unused', 'editor', mod.now())).lastrowid
        with self.client.session_transaction() as s: s['user_id'] = editor
        path = '/api/sales/' + key
        self.assertEqual(self.client.post(path + '/restore', headers=self.headers).status_code, 403)
        self.assertEqual(self.client.delete(path, headers=self.headers).status_code, 403)
        with self.client.session_transaction() as s: s['user_id'] = self.uid
        self.assertEqual(self.client.post(path + '/restore').status_code, 403)
        self.assertEqual(self.client.delete(path).status_code, 403)
        self.assertEqual(self.client.get('/api/sales').json['totalCents'], 1000)

    def test_legacy_sales_migration_preserves_records(self):
        key = str(uuid4()); self.sale(1, 10, key)
        with mod.db() as c:
            c.execute('ALTER TABLE sales DROP COLUMN author_id')
            c.execute('ALTER TABLE sales DROP COLUMN status')
        mod.initialize_db()
        self.assertEqual(self.client.get('/api/sales').json['totalCents'], 1000)
        self.client.delete('/api/cards/' + self.cid, headers=self.headers)
        self.assertEqual(self.client.post('/api/sales/' + key + '/restore', headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get('/api/cards').json['items'][0]['author'], 'Admin')


def tearDownModule():
    work.cleanup()


if __name__ == '__main__':
    unittest.main()
