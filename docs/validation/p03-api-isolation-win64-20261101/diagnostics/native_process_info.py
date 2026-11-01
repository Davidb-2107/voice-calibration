import ctypes as c
from ctypes import wintypes as w

def information(pid):
    k=c.WinDLL('kernel32',use_last_error=True);a=c.WinDLL('advapi32',use_last_error=True)
    k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
    k.CloseHandle.argtypes=[w.HANDLE];k.CloseHandle.restype=w.BOOL
    k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,c.POINTER(w.DWORD)]
    k.QueryFullProcessImageNameW.restype=w.BOOL
    k.LocalFree.argtypes=[c.c_void_p];k.LocalFree.restype=c.c_void_p
    a.OpenProcessToken.argtypes=[w.HANDLE,w.DWORD,c.POINTER(w.HANDLE)];a.OpenProcessToken.restype=w.BOOL
    a.GetTokenInformation.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD,c.POINTER(w.DWORD)];a.GetTokenInformation.restype=w.BOOL
    a.ConvertSidToStringSidW.argtypes=[c.c_void_p,c.POINTER(w.LPWSTR)];a.ConvertSidToStringSidW.restype=w.BOOL
    process=k.OpenProcess(0x1000,False,pid);token=w.HANDLE()
    if not process:raise c.WinError(c.get_last_error())
    try:
        text=c.create_unicode_buffer(32768);size=w.DWORD(len(text))
        if not k.QueryFullProcessImageNameW(process,0,text,c.byref(size)):raise c.WinError(c.get_last_error())
        if not a.OpenProcessToken(process,8,c.byref(token)):raise c.WinError(c.get_last_error())
        def data(kind):
            count=w.DWORD();a.GetTokenInformation(token,kind,None,0,c.byref(count))
            buffer=c.create_string_buffer(count.value)
            if not a.GetTokenInformation(token,kind,buffer,count,c.byref(count)):raise c.WinError(c.get_last_error())
            return buffer
        def sid(kind):
            buffer=data(kind);pointer=c.cast(buffer,c.POINTER(c.c_void_p))[0];value=w.LPWSTR()
            if not a.ConvertSidToStringSidW(pointer,c.byref(value)):raise c.WinError(c.get_last_error())
            try:return value.value
            finally:k.LocalFree(c.cast(value,c.c_void_p))
        def number(kind):return c.cast(data(kind),c.POINTER(w.DWORD))[0]
        return {'pid':pid,'image':text.value,'is_appcontainer':bool(number(29)),
            'appcontainer_sid':sid(31),'integrity_sid':sid(25),'capability_count':number(30),
            'token_type':number(8),'token_id_bytes':data(10).raw[:8].hex()}
    finally:
        if token:k.CloseHandle(token)
        k.CloseHandle(process)

def terminate_owned(pid,expected_image,expected_sid):
    from pathlib import Path
    current=information(pid)
    assert Path(current['image']).resolve()==Path(expected_image).resolve()
    assert current['is_appcontainer'] and current['appcontainer_sid']==expected_sid
    k=c.WinDLL('kernel32',use_last_error=True)
    k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
    k.TerminateProcess.argtypes=[w.HANDLE,w.UINT];k.TerminateProcess.restype=w.BOOL
    k.CloseHandle.argtypes=[w.HANDLE]
    handle=k.OpenProcess(1,False,pid)
    if not handle:raise c.WinError(c.get_last_error())
    try:
        if not k.TerminateProcess(handle,1):raise c.WinError(c.get_last_error())
    finally:k.CloseHandle(handle)
    return current
