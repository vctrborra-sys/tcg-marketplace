import hashlib, importlib.util, json, os, pathlib, shutil, sys, tempfile, types, unittest
from unittest.mock import patch
from contextlib import closing

ROOT=pathlib.Path(__file__).resolve().parents[1]

class FlaskStub:
    def __init__(self,*args,**kwargs):
        self.config={}
        self.secret_key=None
    def route(self,*a,**k): return lambda f:f
    get=post=put=delete=route
    def before_request(self,f): return f
    def after_request(self,f): return f
    def errorhandler(self,*a,**k):return lambda f:f

flask=types.ModuleType('flask')
flask.Flask=FlaskStub
flask.abort=lambda code,msg='': (_ for _ in ()).throw(ValueError(str(code)+':'+msg))
flask.jsonify=lambda **kw:kw
flask.redirect=lambda *x:x
flask.render_template=lambda *x,**kw:kw
flask.request=types.SimpleNamespace(get_json=lambda **kw:{},remote_addr='127.0.0.1')
flask.session={}
werkzeug=types.ModuleType('werkzeug')
security=types.ModuleType('werkzeug.security')
security.generate_password_hash=lambda pw,method='scrypt': 'mock:'+hashlib.sha256(pw.encode()).hexdigest()
security.check_password_hash=lambda h,pw: h==security.generate_password_hash(pw)
sys.modules['flask']=flask
sys.modules['werkzeug']=werkzeug
sys.modules['werkzeug.security']=security
work=tempfile.TemporaryDirectory()
os.environ['MARKETPLACE_DATA']=work.name
os.environ['MARKETPLACE_DB']=str(pathlib.Path(work.name)/'test.sqlite3')
shutil.copyfile(ROOT/'dados/catalogo-inicial.js', pathlib.Path(work.name)/'catalogo-inicial.js')
sys.path.insert(0,str(ROOT))
spec=importlib.util.spec_from_file_location('marketplace_app',ROOT/'app.py')
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class Logic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with mod.db() as conn:
            user=conn.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',('admin','hash','proprietario',mod.now())).lastrowid
        cls.uid=user
        mod.seed_from_catalog(user)
        flask.session['user_id']=user

    def test_import_preserves_cards_and_author(self):
        with mod.db() as c:
            rows=c.execute('SELECT author_id,data_json FROM cards').fetchall()
        self.assertEqual(len(rows),24)
        self.assertTrue(all(r['author_id']==self.uid for r in rows))
        self.assertTrue(all(json.loads(r['data_json'])['published'] for r in rows))

    def test_default_and_rarity_validation(self):
        sample={'game':'Pokémon','name':'Pikachu','rarity':'Ultra Raras','condition':'NM','language':'Português','price':10,'quantity':2}
        x=mod.normalize_card(sample,'p1')
        self.assertEqual(x['rarity'],'Ultra Rara')
        self.assertTrue(x['published'])
        self.assertEqual(x['description'],'')
        self.assertEqual(x['language'],'Português')
        self.assertRaises(ValueError,mod.normalize_card,{**sample,'language':''},'x')
        self.assertRaises(ValueError,mod.normalize_card,{**sample,'rarity':'SLD'},'x')
        self.assertRaises(ValueError,mod.normalize_card,{**sample,'price':-1},'x')
        self.assertRaises(ValueError,mod.normalize_card,{**sample,'image':'http://evil.local'},'x')

    def test_categories_are_optional_and_validated_per_game(self):
        sample={'game':'Pokémon','name':'Pikachu','rarity':'Comum','condition':'NM','language':'Português','price':10,'quantity':2}
        self.assertEqual(mod.normalize_card(sample,'p1')['categories'], [])
        for game,categories in [('Pokémon',['Foil','Reverse Foil','Full Art']),('Magic',['Foil','Foil Especial','Promo'])]:
            data={**sample,'game':game,'categories':categories+['Foil']}
            result=mod.normalize_card(data,'p1')
            self.assertEqual(result['categories'],categories)
            self.assertEqual(result['rarity'],'Comum')
        for invalid in ['Foil',None,['Promo'],['Foil Especial'],[{}]]:
            self.assertRaises(ValueError,mod.normalize_card,{**sample,'categories':invalid},'p1')
        for invalid in [['Reverse Foil'],['Full Art']]:
            self.assertRaises(ValueError,mod.normalize_card,{**sample,'game':'Magic','categories':invalid},'m1')

    def test_play_pokemon_requires_number_and_only_applies_to_pokemon(self):
        sample={'game':'Pokémon','name':'Pikachu','rarity':'Comum','condition':'NM','language':'Português','price':10,'quantity':2}
        self.assertFalse(mod.normalize_card(sample,'p1')['playPokemon'])
        for invalid in ['', '12A', '-1', '<img>', '1'*31, None, True]:
            self.assertRaises(ValueError,mod.normalize_card,{**sample,'playPokemon':True,'playPokemonNumber':invalid},'p1')
        self.assertRaises(ValueError,mod.normalize_card,{**sample,'playPokemon':'true','playPokemonNumber':'123'},'p1')
        valid=mod.normalize_card({**sample,'playPokemon':True,'playPokemonNumber':' 00123 '},'p1')
        self.assertEqual(valid['playPokemonNumber'],'00123')
        for override in [{'playPokemon':False}, {'game':'Magic'}]:
            normalized=mod.normalize_card({**valid,**override},'p1')
            self.assertFalse(normalized['playPokemon'])
            self.assertEqual(normalized['playPokemonNumber'],'')

    def test_categories_round_trip_through_edit_history_and_publish(self):
        flask.session['user_id']=self.uid
        card={'game':'Magic','name':'Category test','rarity':'Rara','condition':'NM','language':'Inglês','price':10,'quantity':1,'categories':['Foil','Promo']}
        with patch.object(flask.request,'get_json',return_value=card):
            result,code=mod.add_card()
        cid=result['item']['id']
        try:
            self.assertEqual(code,201)
            self.assertEqual(result['item']['categories'],['Foil','Promo'])
            old_client={k:v for k,v in card.items() if k!='categories'}
            with patch.object(flask.request,'get_json',return_value={**old_client,'quantity':3}):
                edited=mod.edit_card(cid)['item']
            self.assertEqual(edited['categories'],['Foil','Promo'])
            with patch.object(flask.request,'get_json',return_value={**card,'categories':['Foil Especial']}):
                edited=mod.edit_card(cid)['item']
            self.assertEqual(edited['categories'],['Foil Especial'])
            published=mod.published_js(mod.catalog_payload())
            document=json.loads(published.split('window.TCG_CATALOG = ',1)[1].rsplit(';',1)[0])
            self.assertEqual(next(c for c in document['items'] if c['id']==cid)['categories'],['Foil Especial'])
            with mod.db() as c:
                row=c.execute('SELECT author_id FROM cards WHERE id=?',(cid,)).fetchone()
                last=c.execute('SELECT before_json,after_json FROM audit WHERE card_id=? ORDER BY id DESC',(cid,)).fetchone()
            self.assertEqual(row['author_id'],self.uid)
            self.assertEqual(json.loads(last['before_json'])['categories'],['Foil','Promo'])
            self.assertEqual(json.loads(last['after_json'])['categories'],['Foil Especial'])
        finally:
            mod.delete_card(cid)

    def test_create_audit_and_edit_any_user(self):
        with mod.db() as c:
            editor=c.execute('INSERT INTO users (username,pw_hash,role,created_at) VALUES (?,?,?,?)',('EditorUm','hash','editor',mod.now())).lastrowid
        card={'game':'Magic','name':'Sol Ring','rarity':'SLD','condition':'SP','language':'Inglês','price':37,'quantity':1}
        flask.request.get_json=lambda **kwargs:card
        flask.session['user_id']=editor
        result,code=mod.add_card()
        self.assertEqual(code,201)
        cid=result['item']['id']
        card={**card,'quantity':9,'language':'Japonês'}
        flask.session['user_id']=self.uid
        x=mod.edit_card(cid)
        self.assertEqual(x['item']['quantity'],9)
        self.assertEqual(x['item']['language'],'Japonês')
        with mod.db() as c:
            entry=c.execute('SELECT author_id,editor_id FROM cards WHERE id=?',(cid,)).fetchone()
            log=c.execute('SELECT COUNT(*) FROM audit WHERE card_id=?',(cid,)).fetchone()[0]
        self.assertEqual(entry['author_id'],editor)
        self.assertEqual(entry['editor_id'],self.uid)
        self.assertEqual(log,2)
        flask.session['user_id']=editor
        mod.delete_card(cid)
        with mod.db() as c:
            log=c.execute('SELECT action FROM audit WHERE card_id=? ORDER BY id',(cid,)).fetchall()
        self.assertEqual([r['action'] for r in log],['cadastro','edição','exclusão'])

    def test_catalog_serialization_and_github_payload(self):
        payload=mod.catalog_payload()
        self.assertEqual(len(payload['items']),24)
        js=mod.published_js(payload)
        self.assertTrue(js.startswith('/* Catálogo'))
        document=json.loads(js.split('window.TCG_CATALOG = ',1)[1].rsplit(';',1)[0])
        self.assertEqual(len(document['items']),24)
        self.assertTrue(all(c['published'] for c in document['items']))

    def test_revision_not_lost_during_network_sync(self):
        with mod.db() as c:mod.dirty(c)
        class DummyCredential: pass
        calls=[]
        old_token=mod.get_token
        old_request=mod.github_request
        mod.get_token=lambda:'FAKE_TOKEN_ONLY_IN_TEST'
        def fake_http(method,url,token,payload=None):
            self.assertEqual(token,'FAKE_TOKEN_ONLY_IN_TEST')
            calls.append(method)
            if method=='GET':return {'sha':'fake_sha'}
            if method=='PUT':
                with mod.db() as c:mod.dirty(c)
                return {'ok':True}
            return {}
        mod.github_request=fake_http
        try:
            ok,msg=mod.publish_now()
            self.assertTrue(ok)
            with mod.db() as c:
                dirty=c.execute("SELECT value FROM metadata WHERE key='dirty'").fetchone()['value']
            self.assertEqual(dirty,'1')
            self.assertEqual(calls,['GET','PUT'])
        finally:
            mod.get_token=old_token;mod.github_request=old_request

    def test_manual_backups_preserve_each_snapshot(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(mod, 'DATA', pathlib.Path(folder)):
            with mod.db() as c:
                users_before = c.execute('SELECT COUNT(*) FROM users').fetchone()[0]
            daily = mod.backup_db()
            first = mod.backup_db(manual=True)
            with mod.db() as c:
                c.execute("INSERT INTO metadata VALUES ('backup_test','new value')")
            try:
                second = mod.backup_db(manual=True)
                self.assertEqual(len({daily, first, second}), 3)
                self.assertEqual(mod.backup_db(), daily)
                with closing(mod.sqlite3.connect(first)) as old:
                    self.assertIsNone(old.execute("SELECT value FROM metadata WHERE key='backup_test'").fetchone())
                    self.assertEqual(old.execute('SELECT COUNT(*) FROM users').fetchone()[0], users_before)
                with closing(mod.sqlite3.connect(second)) as latest:
                    self.assertEqual(latest.execute("SELECT value FROM metadata WHERE key='backup_test'").fetchone()[0], 'new value')
                    self.assertEqual(latest.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                self.assertEqual(len(list(pathlib.Path(folder).rglob('*.sqlite3'))), 3)
                self.assertEqual(list(pathlib.Path(folder).rglob('*.tmp')), [])
            finally:
                with mod.db() as c:c.execute("DELETE FROM metadata WHERE key='backup_test'")

    def test_failed_backup_does_not_leave_incomplete_snapshot(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(mod, 'DATA', pathlib.Path(folder)):
            with patch.object(mod, 'db', side_effect=RuntimeError('test failure')):
                self.assertRaises(RuntimeError, mod.backup_db, manual=True)
            self.assertEqual(list((pathlib.Path(folder)/'backups').iterdir()), [])


def tearDownModule():
    work.cleanup()

if __name__=='__main__': unittest.main()
