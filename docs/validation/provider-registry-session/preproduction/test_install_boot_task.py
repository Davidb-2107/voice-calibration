from pathlib import Path
from install_boot_task import NS, parse_task, task_xml, docker_task_xml, install_docker_task
import json
import pytest
from install_boot_task import require_docker_autostart
from install_boot_task import require_task_contract
from install_boot_task import same_user

@pytest.mark.parametrize('settings',[{'AutoStart':False},{'autoStart':False},{},{'AutoStart':True,'autoStart':False}])
def test_disabled_unknown_or_conflicting_docker_autostart_blocks(tmp_path,settings):
    path=tmp_path/'settings-store.json';path.write_text(json.dumps(settings))
    with pytest.raises(RuntimeError,match='AutoStart must be enabled'):
        require_docker_autostart(path)

@pytest.mark.parametrize('settings',[{'AutoStart':True},{'autoStart':True}])
def test_explicit_docker_autostart_is_accepted(tmp_path,settings):
    path=tmp_path/'settings-store.json';path.write_text(json.dumps(settings))
    require_docker_autostart(path)

def test_boot_task_is_password_free_and_never_dispatches_work():
    root=Path('C:/deployment')
    task=parse_task(task_xml(root,{'python':'C:/runtime/python.exe'},'S-1-5-21-123'))
    prefix='{'+NS+'}'
    assert task.find('.//'+prefix+'BootTrigger') is not None
    assert task.find('.//'+prefix+'LogonTrigger') is not None
    assert task.find('.//'+prefix+'LogonType').text=='S4U'
    assert task.find('.//'+prefix+'RunLevel').text=='LeastPrivilege'
    assert task.find('.//'+prefix+'MultipleInstancesPolicy').text=='IgnoreNew'
    assert task.find('.//'+prefix+'Arguments').text=='"'+str(root/'boot_watchdog.py')+'"'

def test_schtasks_redirected_encoding_is_supported():
    data=task_xml(Path('C:/deployment'),{'python':'C:/python.exe'},'S-1-5-21-123')
    redirected=data.decode('utf-16').encode('utf-8')
    assert parse_task(redirected).tag=='{'+NS+'}Task'

def test_docker_task_only_starts_dependency_in_interactive_session():
    runtime={'docker':'C:/Docker Desktop/resources/bin/docker.exe'}
    task=parse_task(docker_task_xml(Path('C:/deployment'),runtime,'S-1-5-21-123'))
    prefix='{'+NS+'}'
    assert task.find('.//'+prefix+'BootTrigger') is None
    assert task.find('.//'+prefix+'LogonTrigger') is not None
    assert task.find('.//'+prefix+'LogonType').text=='InteractiveToken'
    assert task.find('.//'+prefix+'RunLevel').text=='LeastPrivilege'
    assert task.find('.//'+prefix+'Command').text==runtime['docker']
    assert task.find('.//'+prefix+'Arguments').text=='desktop start'
    assert task.find('.//'+prefix+'ExecutionTimeLimit').text=='PT5M'

def test_foreign_docker_task_is_never_overwritten(tmp_path,monkeypatch):
    import types
    import install_boot_task as installer
    runtime={'docker':'C:/Docker/docker.exe'}
    calls=[]
    def run(args,**kwargs):
        calls.append(args)
        return types.SimpleNamespace(returncode=0,stdout=docker_task_xml(tmp_path,runtime,'foreign-sid'))
    monkeypatch.setattr(installer.subprocess,'run',run)
    monkeypatch.setattr(installer.subprocess,'check_output',lambda *args,**kwargs:'"local-account","current-sid"')
    with pytest.raises(RuntimeError,match='refusing overwrite'):
        install_docker_task(tmp_path,runtime,'S-1-5-21-123')
    assert len(calls)==1

@pytest.mark.parametrize('factory',[task_xml,docker_task_xml])
@pytest.mark.parametrize('field,value',[('RunLevel','HighestAvailable'),('Enabled','false'),
    ('LogonType','Password'),('MultipleInstancesPolicy','Parallel')])
def test_existing_task_policy_changes_are_refused(factory,field,value):
    runtime={'python':'C:/python.exe','docker':'C:/docker.exe'}
    expected=parse_task(factory(Path('C:/deployment'),runtime,'sid'))
    actual=parse_task(factory(Path('C:/deployment'),runtime,'sid'))
    actual.find('.//{'+NS+'}'+field).text=value
    with pytest.raises(RuntimeError,match='refusing overwrite'):
        require_task_contract(actual,expected)

@pytest.mark.parametrize('remove_trigger',[False,True])
def test_existing_watchdog_inactive_triggers_are_refused(remove_trigger):
    runtime={'python':'C:/python.exe'}
    expected=parse_task(task_xml(Path('C:/deployment'),runtime,'sid'))
    actual=parse_task(task_xml(Path('C:/deployment'),runtime,'sid'))
    triggers=actual.find('{'+NS+'}Triggers')
    if remove_trigger:triggers.remove(triggers[0])
    else:triggers[0].find('{'+NS+'}Enabled').text='false'
    with pytest.raises(RuntimeError,match='refusing overwrite'):
        require_task_contract(actual,expected)

def test_windows_omitted_safe_defaults_are_accepted():
    runtime={'python':'C:/python.exe'}
    expected=parse_task(task_xml(Path('C:/deployment'),runtime,'sid'))
    actual=parse_task(task_xml(Path('C:/deployment'),runtime,'sid'))
    principal=actual.find('.//{'+NS+'}Principal')
    principal.remove(principal.find('{'+NS+'}RunLevel'))
    settings=actual.find('{'+NS+'}Settings')
    settings.remove(settings.find('{'+NS+'}Enabled'))
    settings.remove(settings.find('{'+NS+'}MultipleInstancesPolicy'))
    require_task_contract(actual,expected)

@pytest.mark.parametrize('factory',[task_xml,docker_task_xml])
@pytest.mark.parametrize('missing',[False,True])
def test_existing_task_retry_policy_is_required(factory,missing):
    runtime={'python':'C:/python.exe','docker':'C:/docker.exe'}
    expected=parse_task(factory(Path('C:/deployment'),runtime,'sid'))
    actual=parse_task(factory(Path('C:/deployment'),runtime,'sid'))
    settings=actual.find('{'+NS+'}Settings')
    retry=settings.find('{'+NS+'}RestartOnFailure')
    if missing:settings.remove(retry)
    else:retry.find('{'+NS+'}Count').text='0'
    with pytest.raises(RuntimeError,match='refusing overwrite'):
        require_task_contract(actual,expected)

def test_windows_account_alias_must_match_current_sid(monkeypatch):
    import install_boot_task as installer
    monkeypatch.setattr(installer.subprocess,'check_output',lambda *args,**kwargs:'"LENOVO\\dbele","current-sid"')
    assert same_user('lenovo\\dbele','current-sid')
    assert not same_user('LENOVO\\other','current-sid')
    assert not same_user('LENOVO\\dbele','foreign-sid')
