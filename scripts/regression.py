#!/usr/bin/env python3
"""Regressão ponta a ponta do Orquestra: sobe uma instância isolada (HOME temporário, sem LANG) e valida
UTF-8 via send_input -> read_output, pasta inicial, histórico/favoritos, pasta inválida e prompt multilinha.
Uso: scripts/regression.py [caminho-do-binario]   (porta ORQ_TEST_PORT, padrão 7791)"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.error
BIN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'target', 'release', 'orquestra')
PORT = os.environ.get('ORQ_TEST_PORT', '7791'); BASE = f'http://127.0.0.1:{PORT}'
T = tempfile.mkdtemp(prefix='orqtest-'); fails = []
def check(name, ok, info=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{info}]' if info and not ok else '')); 
    if not ok: fails.append(name)
def req(path, body=None, method=None):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=10) as x: t = x.read().decode(); return x.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
os.makedirs(f'{T}/cfg/orquestra'); os.makedirs(f'{T}/ws'); os.makedirs(f'{T}/proj áção')
json.dump({"default_provider": "shell", "memory": False, "workspace_dir": f'{T}/ws', "auto_trust_workspace": False,
           "providers": [{"id": "shell", "name": "Shell", "command": "", "clear": "clear", "orchestrator_command": "bash"}]}, open(f'{T}/cfg/orquestra/providers.json', 'w'))
env = {k: v for k, v in os.environ.items() if k not in ('LANG', 'LC_ALL', 'LC_CTYPE')}
env.update(HOME=T, XDG_CONFIG_HOME=f'{T}/cfg', XDG_DATA_HOME=f'{T}/data', ORQUESTRA_PORT=PORT, BROWSER='true', ORQUESTRA_SHELL='/bin/bash')
p = subprocess.Popen([BIN], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: req('/api/version'); break
        except Exception: time.sleep(.1)
    s, orch = req('/api/terms', {"kind": "orchestrator", "provider": "shell"}); check('cria orquestrador', s == 200)
    s, sh = req('/api/terms', {"kind": "shell", "provider": "shell", "cwd": f'{T}/proj áção'}); check('abre chat em pasta com acentos', s == 200 and sh['cwd'].endswith('proj áção'), sh)
    s, bad = req('/api/terms', {"kind": "shell", "provider": "shell", "cwd": '/nao/existe'}); check('rejeita pasta inexistente', s != 200)
    s, d = req('/api/dirs'); check('histórico registra a pasta', any(r['path'].endswith('proj áção') for r in d['recent']), d)
    path = d['recent'][0]['path']
    s, d = req('/api/dirs', {"path": path, "favorite": True}); check('favoritar pasta', path in d['favorites'])
    s, d = req('/api/dirs', {"path": path, "favorite": False, "forget": True}); check('remover do histórico', not d['favorites'] and not d['recent'])
    def mcp(tool, args):
        s, r = req(f'/mcp/{orch["id"]}', {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
        return r['result']['content'][0]['text']
    def screen():
        return mcp('read_output', {"id": sh['id']})
    s, a = req('/api/terms', {"kind": "shell", "provider": "shell", "theme": "  login   áção "}); check('tema na criação (normalizado)', a['theme'] == 'login áção', a)
    s, _ = req(f'/api/terms/{sh["id"]}', {"theme": "login áção"}, 'PATCH'); s, lst = req('/api/terms')
    check('PATCH define tema', {t['id']: t['theme'] for t in lst}[sh['id']] == 'login áção')
    mcp('set_theme', {"id": a['id'], "theme": "outro"}); s, lst = req('/api/terms')
    check('MCP set_theme', {t['id']: t['theme'] for t in lst}[a['id']] == 'outro')
    s, _ = req(f'/api/terms/{sh["id"]}', {"name": "renomeado"}, 'PATCH'); s, lst = req('/api/terms')
    check('rename sem tema não apaga o tema', {t['id']: t['theme'] for t in lst}[sh['id']] == 'login áção')
    time.sleep(1)
    mcp('send_input', {"id": sh['id'], "text": "printf 'U8:%s|\\n' áçãõüÁÇ你🙂"}); time.sleep(1.2)
    out = screen(); check('UTF-8 ida e volta (send_input)', 'U8:áçãõüÁÇ你🙂|' in out, out[-300:])
    mcp('send_input', {"id": sh['id'], "text": "locale charmap; pwd"}); time.sleep(1)
    out = screen(); check('locale do filho é UTF-8 mesmo sem LANG', 'UTF-8' in out, out[-200:]); check('cwd do shell é a pasta escolhida', 'proj áção' in out, out[-200:])
    mcp('send_input', {"id": sh['id'], "text": "echo L1ção\necho L2ção"}); time.sleep(1.2)
    out = screen(); check('texto multilinha com acentos', 'L1ção' in out and 'L2ção' in out, out[-300:])
    s, r = req(f'/api/terms/{sh["id"]}/input', {"text": "echo V-chat-ção", "enter": True}); time.sleep(1)
    s, sc = req(f'/api/terms/{sh["id"]}/screen'); check('visão de chat: input + screen com acentos', s == 200 and 'V-chat-ção' in sc['text'], sc)
    s, lst = req('/api/terms'); check('chats continuam vivos', all(t['state'] != 'exited' for t in lst), lst)
finally:
    p.terminate(); p.wait(5); shutil.rmtree(T, ignore_errors=True)
print('\n' + ('OK: tudo passou' if not fails else f'FALHAS: {fails}')); sys.exit(1 if fails else 0)
