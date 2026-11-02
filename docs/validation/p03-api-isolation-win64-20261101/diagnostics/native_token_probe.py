"""Attempt access while impersonating the primary token opened from the real API handle."""
import ctypes as c
from ctypes import wintypes as w

def probe(pid, paths):
    paths=[(label,path,desired,0x02000000 if path.is_dir() else 0) for label,path,desired in paths]
    kernel=c.WinDLL('kernel32',use_last_error=True)
    security=c.WinDLL('advapi32',use_last_error=True)
    kernel.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];kernel.OpenProcess.restype=w.HANDLE
    kernel.CloseHandle.argtypes=[w.HANDLE];kernel.CloseHandle.restype=w.BOOL
    kernel.GetProcessId.argtypes=[w.HANDLE];kernel.GetProcessId.restype=w.DWORD
    kernel.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,c.c_void_p,w.DWORD,w.DWORD,w.HANDLE]
    kernel.CreateFileW.restype=w.HANDLE
    security.OpenProcessToken.argtypes=[w.HANDLE,w.DWORD,c.POINTER(w.HANDLE)];security.OpenProcessToken.restype=w.BOOL
    security.ImpersonateLoggedOnUser.argtypes=[w.HANDLE];security.ImpersonateLoggedOnUser.restype=w.BOOL
    security.RevertToSelf.argtypes=[];security.RevertToSelf.restype=w.BOOL
    security.GetTokenInformation.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD,c.POINTER(w.DWORD)]
    security.GetTokenInformation.restype=w.BOOL
    process=kernel.OpenProcess(0x1000,False,pid)
    if not process: raise c.WinError(c.get_last_error())
    token=w.HANDLE()
    try:
        assert kernel.GetProcessId(process)==pid
        if not security.OpenProcessToken(process,0x0008|0x0002,c.byref(token)):
            raise c.WinError(c.get_last_error())
        app=w.DWORD();size=w.DWORD()
        if not security.GetTokenInformation(token,29,c.byref(app),c.sizeof(app),c.byref(size)):
            raise c.WinError(c.get_last_error())
        assert app.value==1,'Actual API process is not AppContainer'
        if not security.ImpersonateLoggedOnUser(token): raise c.WinError(c.get_last_error())
        results=[]
        try:
            for label,path,desired,flags in paths:
                c.set_last_error(0)
                handle=kernel.CreateFileW(str(path),desired,7,None,3,flags,None)
                error=c.get_last_error()
                allowed=handle not in (None,c.c_void_p(-1).value)
                if allowed: kernel.CloseHandle(handle)
                results.append({'label':label,'path':str(path),'desired_access':hex(desired),
                    'allowed':allowed,'expected_allowed':label.endswith('positive'),'winerror':0 if allowed else error})
        finally:
            if not security.RevertToSelf(): raise c.WinError(c.get_last_error())
        return {'source':'OpenProcess(pid)->OpenProcessToken(primary)->ImpersonateLoggedOnUser(primary)',
            'pid':pid,'actual_api_is_appcontainer':True,'reconstructed_token':False,'operations':results,
            'result':'PASS' if all(item['allowed']==item['expected_allowed'] and
                (item['allowed'] or item['winerror']==5) for item in results) else 'FAIL'}
    finally:
        if token:kernel.CloseHandle(token)
        kernel.CloseHandle(process)
