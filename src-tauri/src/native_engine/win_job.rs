// Windows kill-proofing (R2.1, review F6): the ONLY crash-proof child
// containment on Windows is a Job Object with KILL_ON_JOB_CLOSE. Children
// survive parent death otherwise (tauri#10377).
//
// Composition used by the supervisor: spawn with CREATE_SUSPENDED |
// CREATE_NO_WINDOW via std/tokio Command → AssignProcessToJobObject(process
// handle) → resume the child's FIRST THREAD (std does not expose it —
// Toolhelp snapshot finds the TID). Assign failure ⇒ the caller kills the
// still-suspended child and aborts the start with a classified Spawn error;
// an unprotected child is NEVER resumed.
#![allow(unsafe_code)]

// windows-sys 0.52 handles are `isize`.
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
    PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, OpenThread, QueryFullProcessImageNameW, ResumeThread, TerminateProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

pub const CREATE_SUSPENDED: u32 = 0x0000_0004;
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Create the kill-on-close job. 0 = creation failed.
pub fn create_kill_on_close_job() -> Option<isize> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job == 0 {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return None;
        }
        Some(job)
    }
}

/// Assign the (still suspended) child process to the job. False = abort the
/// start; the caller must terminate the child, never resume it.
pub fn assign_process(job_handle: isize, process_handle: isize) -> bool {
    unsafe { AssignProcessToJobObject(job_handle, process_handle) != 0 }
}

/// Resume the child's first thread (std::process only exposes the pid).
/// False = could not resume → caller aborts (a permanently suspended child
/// would hang the handshake into StartTimeout otherwise).
pub fn resume_first_thread(pid: u32) -> bool {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == 0 {
            return false;
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut found: HANDLE = 0;
        if Thread32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32OwnerProcessID == pid {
                    found = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if found != 0 {
                        break;
                    }
                }
                if Thread32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        if found == 0 {
            return false;
        }
        let resume_ok = ResumeThread(found) != u32::MAX;
        CloseHandle(found);
        resume_ok
    }
}

/// Backstop kill: terminate EVERYTHING in the job now (graceful path not
/// available to a GUI parent — research §1: no /shutdown endpoint, no
/// deliverable console event).
pub fn terminate_job(job_handle: isize) {
    unsafe {
        TerminateJobObject(job_handle, 1);
    }
}

pub fn close_handle(handle: isize) {
    unsafe {
        CloseHandle(handle);
    }
}

/// Escalation sweep (phase 2 Risk 1, third line): enumerate processes and
/// kill stray llama-server children running from OUR engine dir. Never
/// matches other installs (path-scoped) and never a restarting app's new
/// child (a sweep runs at app START, before any new child of THIS process
/// exists — see mod.rs).
pub fn sweep_strays(engine_dir: &std::path::Path) {
    for pid in enumerate_strays(engine_dir) {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if h != 0 {
                TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
    }
}

/// Count-only variant (R6.6 orphan enumeration): pids of stray llama-server
/// children running from OUR engine dir, alive right now. Never kills.
pub fn enumerate_strays(engine_dir: &std::path::Path) -> Vec<u32> {
    let dir = engine_dir.to_string_lossy().to_lowercase();
    let mut strays = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == 0 {
            return strays;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(0);
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                if name.eq_ignore_ascii_case("llama-server.exe") {
                    if let Some(path) = process_image_path(entry.th32ProcessID) {
                        if path.to_string_lossy().to_lowercase().starts_with(&dir) {
                            strays.push(entry.th32ProcessID);
                        }
                    }
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    strays
}

fn process_image_path(pid: u32) -> Option<std::path::PathBuf> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h == 0 {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        Some(std::path::PathBuf::from(String::from_utf16_lossy(
            &buf[..len as usize],
        )))
    }
}
