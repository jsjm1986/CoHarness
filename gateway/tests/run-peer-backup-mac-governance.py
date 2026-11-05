"""Capture an independent Mac Unix-socket PostgreSQL organization, tear it down, then verify on an isolated Linux receiver."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import tempfile
import uuid

parser=argparse.ArgumentParser()
for arg in ('pg-bin','mac-restic','linux-restic-archive','receiver','ssh-key','receiver-parent','receipt'):
    parser.add_argument('--'+arg,required=True)
args=parser.parse_args()
base=Path(__file__).resolve().parents[2]
ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','-i',args.ssh_key]
scp=['scp','-q','-o','BatchMode=yes','-i',args.ssh_key]
def run(argv,**kwargs):
    result=subprocess.run(argv,check=False,capture_output=True,text=True,errors='replace',timeout=kwargs.pop('timeout',150),**kwargs)
    if result.returncode: raise RuntimeError((result.stderr or result.stdout)[-1400:])
    return result.stdout.strip()
q=shlex.quote
with tempfile.TemporaryDirectory(prefix='hgw-peer-test-',dir='/private/tmp') as scratch:
    root=Path(scratch); repo=root.name; remote=args.receiver_parent.rstrip('/')+'/'+repo
    def save(name,value):
        p=root/name;p.write_text(json.dumps(value) if isinstance(value,(dict,list)) else value);p.chmod(0o600);return p
    def send(files):run(scp+[str(f) for f in files]+[args.receiver+':'+remote+'/'])
    process=None;db=False;tunnel=False
    data=root/'pgdata';pg=Path(args.pg_bin);ctl=str(root/'tc');sock=root/'socket'
    sock.mkdir(mode=0o700);key=secrets.token_hex(32);append=secrets.token_hex(32);recover=secrets.token_hex(32)
    ids={k:str(uuid.uuid4()) for k in ('organizationId','sourceNodeId','targetNodeId','policyId')}
    pair={'version':1,'synthetic':'hgw-peer-pair-fixture','kind':'governance','binding':{**ids,'scopeId':ids['organizationId'],'revision':1},
        'file':'fixture-governance.bin','appendFingerprint':hashlib.sha256(append.encode()).hexdigest(),'recoveryFingerprint':hashlib.sha256(recover.encode()).hexdigest()}
    try:
        run(ssh+[args.receiver,'umask 077; mkdir -p '+q(args.receiver_parent)+' && mkdir '+q(remote)+' && printf %s '+q(repo)+' > '+q(remote+'/fixture-owner')])
        for source,name in [('gateway/tests/fixtures/peer-backup-os-pair.ts','pair.js'),('gateway/src/peer-backup-store-worker.ts','peer-backup-store-worker.js')]:
            run([str(base/'node_modules/.bin/esbuild'),str(base/source),'--platform=node','--bundle','--format=esm','--target=node24','--outfile='+str(root/name)])
        archive=Path(args.linux_restic_archive)
        send([root/'pair.js',root/'peer-backup-store-worker.js',save('receive.json',pair),save('package.json',{'type':'module'}),archive])
        run(ssh+[args.receiver,'cd '+q(remote)+' && umask 077 && bzip2 -dc -- '+q(archive.name)+' > restic && chmod 700 restic'])
        process=subprocess.Popen(ssh+[args.receiver,'cd '+q(remote)+' && /usr/bin/node pair.js receive receive.json'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,errors='replace')
        import select
        if not select.select([process.stdout],[],[],60)[0]:raise RuntimeError('receiver did not publish a listener')
        ready=json.loads(process.stdout.readline())
        with socket.socket() as s:
            s.bind(('127.0.0.1',0)); local=s.getsockname()[1]
        run(ssh+['-M','-S',ctl,'-fNT','-o','ExitOnForwardFailure=yes','-L',f"127.0.0.1:{local}:127.0.0.1:{ready['port']}",args.receiver]);tunnel=True
        run([str(pg/'initdb'),'-D',str(data),'--no-locale','--encoding=UTF8','--auth-local=trust','--auth-host=reject','--wal-segsize=1'])
        with (data/'postgresql.conf').open('a') as f:
            f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\nshared_buffers='12MB'\nmax_connections=16\nmin_wal_size='2MB'\nmax_wal_size='16MB'\n")
        run([str(pg/'pg_ctl'),'-D',str(data),'-l',str(root/'postgres.log'),'-w','start']);db=True
        run([str(pg/'createdb'),'-h',str(sock),'-p','5432','hgw_peer_governance_test'])
        config=save('capture.json',{**ids,'restic':args.mac_restic,'origin':'http://127.0.0.1:'+str(local)})
        save('repository.key',key);save('append.token',append)
        captured=json.loads(run([str(base/'node_modules/.bin/tsx'),'--tsconfig',str(base/'gateway/tsconfig.run.json'),
            str(base/'gateway/tests/fixtures/peer-backup-mac-governance.ts'),str(config)],cwd=base,timeout=180).splitlines()[-1])
        run([str(pg/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop']);db=False
        import shutil
        shutil.rmtree(data)
        (root/'repository.key').unlink(); (root/'name-index.key').unlink(); (root/'gateway-master.key').unlink()
        process.communicate('stop\n',timeout=25)
        if process.returncode:raise RuntimeError('receiver failed to close durably')
        process=None;run(ssh+['-S',ctl,'-O','exit',args.receiver]);tunnel=False
        verify={**pair,'seed':secrets.token_hex(32),'restic':remote+'/restic','pointId':captured['pointId'],'forbidden':json.loads((root/'oracle.json').read_text())}
        send([save('verify.json',verify),save('recovery.key',key)])
        checked=json.loads(run(ssh+[args.receiver,'cd '+q(remote)+' && chmod 600 recovery.key && /usr/bin/node pair.js verify verify.json']).splitlines()[-1])
        if not checked['keysExcluded'] or not checked['organizationRowsVerified'] or not checked['wrongKeyRejected'] or not checked['remainingGaps']:
            raise RuntimeError('incomplete governance validation')
        receipt={'syntheticMacUnixSocketDatabase':True,'sourceDatabaseAndKeysRemoved':True,'transportClosedBeforeRecovery':True,'capture':captured,'recovery':checked}
        Path(args.receipt).write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
    finally:
        if db:run([str(pg/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'])
        if process and process.poll() is None:
            try:process.communicate('stop\n',timeout=15)
            except subprocess.TimeoutExpired:process.terminate();process.wait()
        if tunnel:subprocess.run(ssh+['-S',ctl,'-O','exit',args.receiver],capture_output=True,timeout=15)
        subprocess.run(ssh+[args.receiver,'cd '+q(remote)+' && test "$(cat fixture-owner)" = '+q(repo)+' && cd / && rm -rf -- '+q(remote)],capture_output=True,timeout=15)
