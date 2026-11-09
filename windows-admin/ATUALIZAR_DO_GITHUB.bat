@echo off & setlocal & cd /d "%~dp0" & ".venv\Scripts\python.exe" -x "%~f0" & pause & exit /b
from pathlib import Path
import os
import shutil
import tempfile
from datetime import datetime
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
BASE_URL = 'https://raw.githubusercontent.com/vctrborra-sys/tcg-marketplace/main/windows-admin/'
FILES = (
    'app.py', 'nomes_pt.py', 'static/painel.js',
    'static/painel.css', 'templates/admin.html',
    'VERIFICAR_TOKEN_GITHUB.bat',
)


def main():
    print('\nTCG MARKETPLACE - ATUALIZACAO DIRETO DO GITHUB')
    if not (ROOT / 'app.py').is_file() or not (ROOT / 'dados').is_dir():
        print('ERRO: copie este arquivo para a pasta do TCG Marketplace que contem app.py e dados.')
        print('Exemplo: C:\\TCG-Marketplace\\ATUALIZAR_DO_GITHUB.bat')
        return
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = ROOT / 'dados' / 'backups' / ('programa-antes-'+stamp)
    with tempfile.TemporaryDirectory(prefix='marketplace-atualizacao-',dir=ROOT) as temp:
        downloaded=[]
        for rel in FILES:
            url=BASE_URL+rel
            req=Request(url,headers={'User-Agent':'TCGMarketplace-Windows-Updater/1.0'})
            print('Baixando',rel,'...')
            with urlopen(req,timeout=35) as response:
                content=response.read(2*1024*1024+1)
            if not content or len(content)>2*1024*1024:
                raise ValueError('Arquivo invalido ou grande demais: '+rel)
            target=Path(temp)/rel
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(content)
            downloaded.append((rel,target))
        backup.mkdir(parents=True,exist_ok=False)
        for rel,_ in downloaded:
            old=ROOT/rel
            if old.is_file():
                out=backup/rel
                out.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(old,out)
        try:
            for rel,new in downloaded:
                dst=ROOT/rel
                dst.parent.mkdir(parents=True,exist_ok=True)
                os.replace(new,dst)
        except Exception:
            for rel,_ in downloaded:
                old=backup/rel
                if old.is_file():
                    shutil.copy2(old,ROOT/rel)
            raise
    print('\nATUALIZADO COM SUCESSO!')
    print('Backups das versoes anteriores:',backup)
    print('Abra agora INICIAR_PAINEL.bat.')
    print('Os dados, usuarios, historico e token nao foram alterados.')


if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        print('\nERRO AO ATUALIZAR:',exc)
        print('Os dados nao foram alterados. Verifique Internet e execute novamente.')