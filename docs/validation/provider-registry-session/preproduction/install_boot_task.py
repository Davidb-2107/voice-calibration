"""Register the local watchdog from an elevated shell of the deployment user."""
import csv
import json
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from recover_owner import checked

TASK_NAME = 'Codex-Voice-Calibration-Watchdog'
DOCKER_TASK_NAME = 'Codex-Voice-Calibration-Docker-Logon'
NS = 'http://schemas.microsoft.com/windows/2004/02/mit/task'

def require_docker_autostart(settings_path):
    if not settings_path.is_file():
        raise RuntimeError('Docker Desktop startup configuration is unavailable; verify it before installing boot supervision')
    settings = json.loads(settings_path.read_text())
    flags = [settings[name] for name in ('AutoStart', 'autoStart') if name in settings]
    if not flags or not all(value is True for value in flags):
        raise RuntimeError('Docker Desktop AutoStart must be enabled before installing boot supervision')

def task_xml(root, runtime, sid):
    ET.register_namespace('', NS)
    def child(parent, name, text=None, **attrs):
        result = ET.SubElement(parent, '{' + NS + '}' + name, attrs)
        result.text = text
        return result
    task = ET.Element('{' + NS + '}Task', {'version': '1.2'})
    registration = child(task, 'RegistrationInfo')
    child(registration, 'Description', 'Local simulated voice calibration watchdog; no paid provider calls')
    triggers = child(task, 'Triggers')
    boot = child(triggers, 'BootTrigger')
    child(boot, 'Enabled', 'true'); child(boot, 'Delay', 'PT30S')
    logon = child(triggers, 'LogonTrigger')
    child(logon, 'Enabled', 'true'); child(logon, 'UserId', sid); child(logon, 'Delay', 'PT30S')
    principal = child(child(task, 'Principals'), 'Principal', id='Author')
    child(principal, 'UserId', sid); child(principal, 'LogonType', 'S4U'); child(principal, 'RunLevel', 'LeastPrivilege')
    settings = child(task, 'Settings')
    for name, value in [('MultipleInstancesPolicy', 'IgnoreNew'), ('DisallowStartIfOnBatteries', 'false'),
        ('StopIfGoingOnBatteries', 'false'), ('StartWhenAvailable', 'true'), ('RunOnlyIfNetworkAvailable', 'false'),
        ('AllowHardTerminate', 'true'), ('Enabled', 'true'), ('Hidden', 'true'), ('ExecutionTimeLimit', 'PT0S')]:
        child(settings, name, value)
    retry = child(settings, 'RestartOnFailure')
    child(retry, 'Interval', 'PT1M'); child(retry, 'Count', '999')
    action = child(child(task, 'Actions', Context='Author'), 'Exec')
    child(action, 'Command', runtime['python'])
    child(action, 'Arguments', '"' + str(root / 'boot_watchdog.py') + '"')
    child(action, 'WorkingDirectory', str(root))
    return ET.tostring(task, encoding='utf-16', xml_declaration=True)

def parse_task(data):
    encoding = 'utf-16' if data.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8'
    # schtasks may declare UTF-16 while emitting UTF-8 on redirected stdout.
    return ET.fromstring(data.decode(encoding))

def same_user(actual, expected):
    if actual == expected:
        return True
    # Windows exports a SID as the current account name in some task fields.
    account, sid = next(csv.reader([subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'], text=True).strip()]))
    return expected == sid and isinstance(actual, str) and actual.casefold() == account.casefold()

def require_task_contract(actual, expected):
    prefix = '{' + NS + '}'
    selectors = ('.//' + prefix + 'Command', './/' + prefix + 'Arguments',
        './/' + prefix + 'Principal/' + prefix + 'UserId', './/' + prefix + 'LogonType',
        prefix + 'Settings/' + prefix + 'ExecutionTimeLimit',
        './/' + prefix + 'RestartOnFailure/' + prefix + 'Count',
        './/' + prefix + 'RestartOnFailure/' + prefix + 'Interval')
    defaults = {'.//' + prefix + 'RunLevel': 'LeastPrivilege',
        prefix + 'Settings/' + prefix + 'Enabled': 'true',
        prefix + 'Settings/' + prefix + 'MultipleInstancesPolicy': 'IgnoreNew'}
    for selector in (*selectors, *defaults):
        node = actual.find(selector)
        value = node.text if node is not None else defaults.get(selector)
        target = expected.find(selector).text
        matches = same_user(value, target) if selector.endswith(prefix + 'UserId') else value == target
        if not matches:
            raise RuntimeError('Existing startup task is incompatible; refusing overwrite')
    triggers = actual.find(prefix + 'Triggers')
    desired = expected.find(prefix + 'Triggers')
    if triggers is None or [node.tag for node in triggers] != [node.tag for node in desired]:
        raise RuntimeError('Existing startup task triggers are incompatible; refusing overwrite')
    for trigger, template in zip(triggers, desired):
        enabled = trigger.find(prefix + 'Enabled')
        user = trigger.find(prefix + 'UserId')
        target = template.find(prefix + 'UserId')
        if (enabled is not None and enabled.text != 'true') or (target is not None and (user is None or not same_user(user.text, target.text))):
            raise RuntimeError('Existing startup task trigger is disabled or foreign; refusing overwrite')

def docker_task_xml(root, runtime, sid):
    # Docker Desktop needs the interactive user's session; S4U supervision only waits for it.
    task = parse_task(task_xml(root, {'python': runtime['docker']}, sid))
    prefix = '{' + NS + '}'
    triggers = task.find(prefix + 'Triggers')
    triggers.remove(triggers.find(prefix + 'BootTrigger'))
    task.find('.//' + prefix + 'LogonType').text = 'InteractiveToken'
    task.find('.//' + prefix + 'LogonTrigger/' + prefix + 'Delay').text = 'PT10S'
    task.find('.//' + prefix + 'Description').text = 'Start Docker Desktop at user logon for local simulated preproduction'
    task.find('.//' + prefix + 'Arguments').text = 'desktop start'
    task.find('.//' + prefix + 'WorkingDirectory').text = str(Path(runtime['docker']).parent)
    task.find('.//' + prefix + 'ExecutionTimeLimit').text = 'PT5M'
    task.find('.//' + prefix + 'RestartOnFailure/' + prefix + 'Count').text = '3'
    return ET.tostring(task, encoding='utf-16', xml_declaration=True)

def install_docker_task(root, runtime, sid):
    expected = parse_task(docker_task_xml(root, runtime, sid))
    existing = subprocess.run(['schtasks', '/Query', '/TN', DOCKER_TASK_NAME, '/XML', 'ONE'], capture_output=True)
    if existing.returncode == 0:
        actual = parse_task(existing.stdout)
        require_task_contract(actual, expected)
        return
    xml = root / 'docker-logon-task.xml'
    xml.write_bytes(docker_task_xml(root, runtime, sid))
    result = subprocess.run(['schtasks', '/Create', '/TN', DOCKER_TASK_NAME, '/XML', str(xml)], capture_output=True)
    if result.returncode:
        raise RuntimeError('Docker logon task registration refused')

def install(root):
    root = checked(root)
    config = json.loads((root / 'config.json').read_text())
    if config['host'] != '127.0.0.1' or config['provider'] != 'simulated':
        raise RuntimeError('Startup task is limited to local simulated preproduction')
    require_docker_autostart(Path.home() / 'AppData/Roaming/Docker/settings-store.json')
    for name in ('watchdog.py', 'control.py', 'recover_owner.py', 'boot_watchdog.py'):
        if not checked(root / name).is_file():
            raise RuntimeError('Deploy the supervisor files before installing the task')
    sid = next(csv.reader([subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'], text=True).strip()]))[1]
    runtime = {}
    for name in ('python', 'node', 'docker'):
        path = sys.executable if name == 'python' else shutil.which(name)
        if not path:
            raise RuntimeError('Required runtime missing: ' + name)
        runtime[name] = str(Path(path).resolve())
    runtime['dockerConfig'] = str(Path.home() / '.docker')
    install_docker_task(root, runtime, sid)
    existing = subprocess.run(['schtasks', '/Query', '/TN', TASK_NAME, '/XML', 'ONE'], capture_output=True)
    if existing.returncode == 0:
        task = parse_task(existing.stdout)
        require_task_contract(task, parse_task(task_xml(root, runtime, sid)))
        declaration = root / 'boot-runtime.json'
        if not declaration.is_file() or json.loads(declaration.read_text()) != runtime:
            raise RuntimeError('Existing startup runtime declaration is missing or changed; redeploy explicitly')
        return {'status': 'already_registered', 'task': TASK_NAME}
    (root / 'boot-runtime.json').write_text(json.dumps(runtime, indent=2))
    xml = root / 'watchdog-task.xml'
    xml.write_bytes(task_xml(root, runtime, sid))
    result = subprocess.run(['schtasks', '/Create', '/TN', TASK_NAME, '/XML', str(xml)], capture_output=True)
    if result.returncode:
        raise RuntimeError('Task registration refused; use an elevated shell of the same deployment user')
    return {'status': 'registered', 'task': TASK_NAME, 'passwordStored': False}

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: install_boot_task.py DEPLOYMENT_ROOT')
    print(json.dumps(install(Path(sys.argv[1]))))
