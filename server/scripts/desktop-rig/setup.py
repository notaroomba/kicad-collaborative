import json, os, shutil, subprocess, sys, time, hmac, hashlib, base64, io, zipfile, urllib.request
RIG='/tmp/claude-0/rig'; SRC='/home/claude/kicad-collaborative/demos/pic_programmer'; BASE='http://127.0.0.1:8099'; NAME='pic_programmer'
def psql(q): return subprocess.check_output(['psql','postgres://postgres:test@127.0.0.1:5432/collabtest','-Atc',q]).decode().strip().split('\n')[0]
def user(gh,login): return int(psql(f"INSERT INTO users (github_id, login, name) VALUES ({gh}, '{login}', '{login}') ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id"))
b64=lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
def jwt(sub,login):
    now=int(time.time()); h=b64(json.dumps({'alg':'HS256','typ':'JWT'}).encode()); b=b64(json.dumps({'sub':sub,'login':login,'iat':now,'exp':now+86400}).encode())
    return f"{h}.{b}."+b64(hmac.new(b'testsecret',f"{h}.{b}".encode(),hashlib.sha256).digest())
def req(method,path,token,body=None,ctype='application/json'):
    r=urllib.request.Request(BASE+path,data=body,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':ctype})
    return json.loads(urllib.request.urlopen(r).read() or b'{}')
psql("DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (-9301,-9302))")
alice=jwt(user(-9301,'rig-alice'),'rig-alice'); bob=jwt(user(-9302,'rig-bob'),'rig-bob')
buf=io.BytesIO()
with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:
    for root,_,files in os.walk(SRC):
        for f in files:
            p=os.path.join(root,f); z.write(p,os.path.relpath(p,SRC))
bd='----rig'; body=(f'--{bd}\r\nContent-Disposition: form-data; name="name"\r\n\r\n{NAME}\r\n--{bd}\r\nContent-Disposition: form-data; name="archive"; filename="project.zip"\r\nContent-Type: application/zip\r\n\r\n').encode()+buf.getvalue()+f'\r\n--{bd}--\r\n'.encode()
proj=req('POST','/api/projects',alice,body,f'multipart/form-data; boundary={bd}')
link=req('POST',f"/api/projects/{proj['projectId']}/links",alice,json.dumps({'role':'editor'}).encode())
req('POST',f"/api/join/{link['token']}",bob,b'')
for who in 'ab':
    d=f'{RIG}/{who}/{NAME}'; shutil.rmtree(f'{RIG}/{who}',ignore_errors=True); shutil.copytree(SRC,d)
    os.makedirs(f'{d}/{NAME}.collab',exist_ok=True)
    json.dump({'server':BASE,'projectId':proj['projectId']},open(f'{d}/{NAME}.collab/link.json','w'))
    cfg=f'{RIG}/cfg{who.upper()}'
    if who=='b': shutil.rmtree(cfg,ignore_errors=True); shutil.copytree(f'{RIG}/cfgA',cfg)
    p=f'{cfg}/10.99/kicad_common.json'; c=json.load(open(p)); c.setdefault('api',{})['enable_server']=True; json.dump(c,open(p,'w'),indent=2)
json.dump({'alice':alice,'bob':bob,'project':proj},open(f'{RIG}/rig.json','w'),indent=1)
print(proj['projectId'],[ (d['docType'],d['docId']) for d in proj['docs']])
