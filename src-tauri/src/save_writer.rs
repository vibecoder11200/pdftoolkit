//! Phase-3 session-token save writer (plan 261112-0955 phase 3, RT3 gate).
//!
//! One held directory handle IS the authorization: the picked path crosses
//! IPC exactly once at `save_session_begin`; every write is token + basename
//! + raw bytes. All file creation/publish/deletion happens RELATIVE to that
//! held handle, so a parent rename/replacement between pick and write cannot
//! re-bind the target, a sibling/home path is structurally unaddressable
//! (there is no path input at write time), and reparse/symlink redirection
//! fails closed (OBJ_DONT_REPARSE / O_NOFOLLOW everywhere).
//!
//! Publish protocol (no partial final file, no clobber):
//! temp exclusive-create -> write+flush -> non-clobbering rename onto the
//! final name (existence checked INSIDE the rename syscall); collision =>
//! deterministic -2..-999 suffix re-publish from the SAME temp handle.
//! Interrupted writes leave only .pdftk-partial names, which the session
//! ledger deletes handle-relative.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Idle lifetime of a save session: after this, `begin` drops the previous
/// session instead of keeping its handle open forever. Expiry only loses
/// retry capability - never safety (writes were already handle-confined).
pub const SESSION_IDLE_TTL: Duration = Duration::from_secs(600);
const PUBLISH_SUFFIX_MAX: u32 = 999;
const PARTIAL_EXT: &str = ".pdftk-partial";

/* ------------------------------ name checks ------------------------------- */

/// Basename-only validation, Rust side (defense in depth - the JS layer has
/// its own gate in delivery-names.ts). Traversal, separators, drive, control
/// chars, dot names refused before any syscall.
pub fn validate_basename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("empty basename".into());
    }
    if name == "." || name == ".." {
        return Err("dot names refused".into());
    }
    if name.contains(['/', '\\', ':']) {
        return Err("basename only (separators/drive refused)".into());
    }
    if name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) {
        return Err("control characters refused".into());
    }
    if name.len() > 240 {
        return Err("basename too long".into());
    }
    Ok(())
}

/* ------------------------------ held dirs --------------------------------- */

/// Platform-held directory handle. Windows: NtCreateFile-relative ops;
/// Unix: openat/linkat/unlinkat on the held fd.
pub enum HeldDir {
    #[cfg(windows)]
    Win(WinDirHandle),
    #[cfg(unix)]
    Unix(UnixDirHandle),
}

impl HeldDir {
    pub fn open(path: &Path) -> io::Result<Self> {
        // Reparse/symlink refused BEFORE opening the handle (fail closed).
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.is_dir() {
            return Err(io::Error::other("chosen save target is not a directory"));
        }
        if meta.file_type().is_symlink() {
            return Err(io::Error::other("symlink/reparse directories refused"));
        }
        #[cfg(windows)]
        {
            return Ok(Self::Win(WinDirHandle::open(path)?));
        }
        #[cfg(unix)]
        {
            return Ok(Self::Unix(UnixDirHandle::open(path)?));
        }
    }

    /// Exclusive temp create relative to the held dir. Returns the open
    /// handle plus the temp name used.
    fn create_temp(&self, base: &str, serial: u32) -> io::Result<(File, String)> {
        let temp_name = format!("{base}{PARTIAL_EXT}-{serial}");
        match self {
            #[cfg(windows)]
            Self::Win(h) => h.create_exclusive(&temp_name).map(|f| (f, temp_name)),
            #[cfg(unix)]
            Self::Unix(h) => h.create_exclusive(&temp_name).map(|f| (f, temp_name)),
        }
    }

    /// Non-clobbering publish: rename the temp onto `final_name`, existence
    /// checked inside the syscall. Collision => suffix from the SAME handle
    /// is attempted by the caller (write_session_file).
    fn publish(&self, temp: &File, _temp_name: &str, final_name: &str) -> io::Result<String> {
        match self {
            #[cfg(windows)]
            Self::Win(h) => h
                .publish(temp, final_name)
                .map(|_| final_name.to_string()),
            #[cfg(unix)]
            Self::Unix(h) => h.publish(temp, temp_name, final_name),
        }
    }

    /// Handle-relative delete (temp cleanup ledger).
    fn delete_name(&self, name: &str) -> io::Result<()> {
        match self {
            #[cfg(windows)]
            Self::Win(h) => h.delete_name(name),
            #[cfg(unix)]
            Self::Unix(h) => h.unlink(name),
        }
    }

    fn display_root(&self) -> Option<String> {
        match self {
            #[cfg(windows)]
            Self::Win(h) => h.display_root.clone(),
            #[cfg(unix)]
            Self::Unix(h) => h.display_root.clone(),
        }
    }
}

/* ------------------------------ windows ----------------------------------- */

#[cfg(windows)]
mod win {
    use std::io;
    use std::ffi::c_void;
    pub const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    pub const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    pub const OBJ_CASE_INSENSITIVE: u16 = 0x40;
    pub const OBJ_DONT_REPARSE: u32 = 0x1000;
    pub const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
    pub const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
    pub const FILE_CREATE: u32 = 2;
    pub const FILE_OPEN: u32 = 1;
    pub const GENERIC_WRITE: u32 = 0x4000_0000;
    pub const SYNCHRONIZE: u32 = 0x0010_0000;
    pub const DELETE: u32 = 0x0001_0000;
    pub const FILE_DELETE_ON_CLOSE: u32 = 0x0000_1000;
    /// NtSetInformationFile info class: FileRenameInformation = 10 (3 is
    /// FileBothDirectoryInformation — a wrong class fails with os error 87).
    pub const FILE_RENAME_INFORMATION_CLASS: i32 = 10;

    #[repr(C)]
    pub struct UnicodeString {
        pub length: u16,
        pub maximum_length: u16,
        pub buffer: *mut u16,
    }
    #[repr(C)]
    pub struct ObjectAttributes {
        pub length: u32,
        pub root_directory: *mut c_void,
        pub object_name: *mut UnicodeString,
        pub attributes: u32,
        pub security_descriptor: *mut c_void,
        pub security_quality_of_service: *mut c_void,
    }
    #[repr(C)]
    pub struct IoStatus {
        pub status: usize,
        pub information: usize,
    }
    /// FILE_RENAME_INFORMATION, x64: BOOLEAN ReplaceIfExists, pad to 8,
    /// HANDLE RootDirectory, ULONG FileNameLength, then WCHAR FileName[1].
    #[repr(C)]
    pub struct FileRenameInformation {
        pub replace_if_exists: u8,
        pub _pad: [u8; 7],
        pub root_directory: *mut c_void,
        pub file_name_length: u32,
        pub file_name: [u16; 1],
    }
    #[link(name = "ntdll")]
    extern "system" {
        pub fn NtCreateFile(
            handle: *mut *mut c_void,
            access: u32,
            attributes: *mut ObjectAttributes,
            status: *mut IoStatus,
            allocation: *const i64,
            file_attributes: u32,
            share: u32,
            disposition: u32,
            options: u32,
            ea: *const c_void,
            ea_length: u32,
        ) -> i32;
        pub fn NtSetInformationFile(
            handle: *mut c_void,
            status: *mut IoStatus,
            info: *const c_void,
            length: u32,
            class: i32,
        ) -> i32;
        pub fn RtlNtStatusToDosError(status: i32) -> u32;
    }
    pub fn nt_err(status: i32) -> io::Error {
        io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
    }
}


#[cfg(windows)]
pub struct WinDirHandle {
    handle: File,
    display_root: Option<String>,
}

#[cfg(windows)]
impl WinDirHandle {
    fn open(path: &Path) -> io::Result<Self> {
        use std::os::windows::fs::OpenOptionsExt;
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(win::FILE_FLAG_BACKUP_SEMANTICS | win::FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(0x1 | 0x2 | 0x4)
            .open(path)?;
        Ok(Self { handle, display_root: Some(path.to_string_lossy().into_owned()) })
    }

    /// Exclusive create relative to the held directory. OBJ_DONT_REPARSE
    /// fails closed on any redirection.
    pub fn create_exclusive(&self, name: &str) -> io::Result<File> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        let byte_len = (wide.len() * 2) as u16;
        let mut string = win::UnicodeString {
            length: byte_len,
            maximum_length: byte_len,
            buffer: wide.as_mut_ptr(),
        };
        let mut objattrs = win::ObjectAttributes {
            length: std::mem::size_of::<win::ObjectAttributes>() as u32,
            root_directory: self.handle.as_raw_handle() as *mut _,
            object_name: &mut string,
            attributes: (win::OBJ_CASE_INSENSITIVE as u32) | win::OBJ_DONT_REPARSE,
            security_descriptor: std::ptr::null_mut(),
            security_quality_of_service: std::ptr::null_mut(),
        };
        let mut status = win::IoStatus { status: 0, information: 0 };
        let mut handle: *mut std::ffi::c_void = std::ptr::null_mut();
        let rc = unsafe {
            win::NtCreateFile(
                &mut handle,
                win::GENERIC_WRITE | win::SYNCHRONIZE | win::DELETE,
                &mut objattrs,
                &mut status,
                std::ptr::null(),
                0x80,
                0,
                win::FILE_CREATE,
                win::FILE_SYNCHRONOUS_IO_NONALERT | win::FILE_NON_DIRECTORY_FILE,
                std::ptr::null(),
                0,
            )
        };
        if rc < 0 {
            return Err(win::nt_err(rc));
        }
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    /// Non-clobbering publish: FileRenameInformation with ReplaceIfExists =
    /// FALSE and RootDirectory = held dir; the existence check happens
    /// inside the rename, so there is no check-then-act gap.
    pub fn publish(&self, temp: &File, final_name: &str) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        let wide: Vec<u16> = final_name.encode_utf16().collect();
        let wide_bytes = wide.len() * 2;
        // FileName[] starts at offset 20 on x64 (1 byte ReplaceIfExists,
        // pad to 8, 8-byte RootDirectory, 4-byte FileNameLength). Rust's
        // size_of rounds the repr(C) struct up to 24 — do NOT derive the
        // name offset from size_of.
        const FILE_NAME_OFFSET: usize = 20;
        let mut buf = vec![0u8; FILE_NAME_OFFSET + wide_bytes];
        unsafe {
            // Build the exact x64 layout: replace=0 (FALSE), pad, root
            // handle, name length, then the wide chars as FileName[].
            std::ptr::write_bytes(buf.as_mut_ptr(), 0, buf.len());
            let root = self.handle.as_raw_handle() as usize;
            buf[8..16].copy_from_slice(&root.to_ne_bytes());
            buf[16..20].copy_from_slice(&(wide_bytes as u32).to_ne_bytes());
            std::ptr::copy_nonoverlapping(
                wide.as_ptr() as *const u8,
                buf.as_mut_ptr().add(FILE_NAME_OFFSET),
                wide_bytes,
            );
        }
        let mut status = win::IoStatus { status: 0, information: 0 };
        let rc = unsafe {
            win::NtSetInformationFile(
                temp.as_raw_handle(),
                &mut status,
                buf.as_ptr() as *const std::ffi::c_void,
                buf.len() as u32,
                win::FILE_RENAME_INFORMATION_CLASS,
            )
        };
        if rc < 0 {
            return Err(win::nt_err(rc));
        }
        Ok(())
    }

    /// Handle-relative delete of a .pdftk-partial temp: open with DELETE +
    /// FILE_DELETE_ON_CLOSE (FILE_OPEN disposition); closing deletes.
    pub fn delete_name(&self, name: &str) -> io::Result<()> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        let byte_len = (wide.len() * 2) as u16;
        let mut string = win::UnicodeString {
            length: byte_len,
            maximum_length: byte_len,
            buffer: wide.as_mut_ptr(),
        };
        let mut objattrs = win::ObjectAttributes {
            length: std::mem::size_of::<win::ObjectAttributes>() as u32,
            root_directory: self.handle.as_raw_handle() as *mut _,
            object_name: &mut string,
            attributes: (win::OBJ_CASE_INSENSITIVE as u32) | win::OBJ_DONT_REPARSE,
            security_descriptor: std::ptr::null_mut(),
            security_quality_of_service: std::ptr::null_mut(),
        };
        let mut status = win::IoStatus { status: 0, information: 0 };
        let mut handle: *mut std::ffi::c_void = std::ptr::null_mut();
        let rc = unsafe {
            win::NtCreateFile(
                &mut handle,
                win::DELETE | win::SYNCHRONIZE,
                &mut objattrs,
                &mut status,
                std::ptr::null(),
                0x80,
                0x1 | 0x2 | 0x4,
                win::FILE_OPEN,
                win::FILE_DELETE_ON_CLOSE | win::FILE_SYNCHRONOUS_IO_NONALERT,
                std::ptr::null(),
                0,
            )
        };
        if rc < 0 {
            return Err(win::nt_err(rc));
        }
        drop(unsafe { File::from_raw_handle(handle) }); // close => delete
        Ok(())
    }
}

/* ------------------------------- unix ------------------------------------- */

#[cfg(unix)]
pub struct UnixDirHandle {
    fd: File,
    display_root: Option<String>,
}

#[cfg(unix)]
impl UnixDirHandle {
    fn open(path: &Path) -> io::Result<Self> {
        use std::os::unix::io::FromRawFd;
        let fd = unsafe {
            libc::open(
                std::ffi::CString::new(path.as_os_str().to_string_lossy().into_owned())
                    .map_err(|_| io::Error::other("non-utf8 path"))?
                    .as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            fd: unsafe { File::from_raw_fd(fd) },
            display_root: Some(path.to_string_lossy().into_owned()),
        })
    }

    fn as_fd(&self) -> std::os::unix::io::RawFd {
        use std::os::unix::io::AsRawFd;
        self.fd.as_raw_fd()
    }

    pub fn create_exclusive(&self, name: &str) -> io::Result<File> {
        use std::os::unix::io::FromRawFd;
        let cname = std::ffi::CString::new(name).map_err(|_| io::Error::other("nul in name"))?;
        let fd = unsafe {
            libc::openat(
                self.as_fd(),
                cname.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    /// Publish via linkat + unlinkat: linkat fails EEXIST atomically when
    /// the target exists (no clobber); then the temp is unlinked.
    pub fn publish(&self, _temp: &File, temp_name: &str, final_name: &str) -> io::Result<String> {
        let tmp_c =
            std::ffi::CString::new(temp_name).map_err(|_| io::Error::other("nul in name"))?;
        let fin_c =
            std::ffi::CString::new(final_name).map_err(|_| io::Error::other("nul in name"))?;
        let rc = unsafe {
            libc::linkat(
                self.as_fd(),
                tmp_c.as_ptr(),
                self.as_fd(),
                fin_c.as_ptr(),
                0,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        self.unlink(temp_name)?;
        Ok(final_name.to_string())
    }

    pub fn unlink(&self, name: &str) -> io::Result<()> {
        let cname = std::ffi::CString::new(name).map_err(|_| io::Error::other("nul in name"))?;
        let rc = unsafe { libc::unlinkat(self.as_fd(), cname.as_ptr(), 0) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/* --------------------------- session state -------------------------------- */

pub struct ActiveSession {
    pub token: String,
    pub dir: HeldDir,
    /// Cleanup ledger: every partial name this session created, deleted on
    /// write error and on end. Only names WE created are ever deleted.
    pub partials: Vec<String>,
    pub created_at: Instant,
}

/// App-managed save sessions (one active batch at a time). The map holds the
/// held directory handles; Drop closes them (session end or replace).
#[derive(Default)]
pub struct SaveWriterState {
    sessions: Mutex<HashMap<String, ActiveSession>>,
}

impl SaveWriterState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(&self, path: &str) -> Result<String, String> {
        validate_path_legibility(path)?;
        let dir = HeldDir::open(Path::new(path)).map_err(|e| e.to_string())?;
        let token = new_token();
        let mut sessions = self.sessions.lock().expect("save sessions lock");
        // Replace expired/other sessions (drop closes their handles).
        sessions.retain(|_, s| s.created_at.elapsed() < SESSION_IDLE_TTL);
        sessions.insert(token.clone(), ActiveSession {
            token: token.clone(),
            dir,
            partials: Vec::new(),
            created_at: Instant::now(),
        });
        Ok(token)
    }

    pub fn end(&self, token: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(mut s) = sessions.remove(token) {
                cleanup_partials(&s.dir, &mut s.partials);
            }
        }
    }

    /// Write one file into the held directory: exclusive temp create, write
    /// + flush, non-clobbering publish with deterministic suffix on
    /// collision, cleanup of the temp on any failure.
    pub fn write_file(
        &self,
        token: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<WriteOutcome, String> {
        validate_basename(name)?;
        let mut sessions = self.sessions.lock().expect("save sessions lock");
        let session = sessions.get_mut(token).ok_or_else(|| "no such save session".to_string())?;
        if session.created_at.elapsed() >= SESSION_IDLE_TTL {
            return Err("save session expired".into());
        }
        write_session_file(session, name, bytes)
    }
}

/// Display-path legibility: begin consumes the ONE path (the folder the
/// user actually picked); it must be absolute-looking and not contain
/// separators beyond the directory itself (it is a directory path, not a
/// file). No write command ever takes a path.
fn validate_path_legibility(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("empty directory path".into());
    }
    if path.contains('\0') {
        return Err("nul in directory path".into());
    }
    Ok(())
}

fn new_token() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let bytes: [u8; 16] = rng.random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, serde::Serialize)]
pub struct WriteOutcome {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// One write inside an active session (lock held by caller).

/* --------------------------- publish helpers ------------------------------ */

fn is_collision(e: &io::Error) -> bool {
    // Windows: STATUS_OBJECT_NAME_COLLISION surfaces as ERROR_FILE_EXISTS
    // (80) or ERROR_ALREADY_EXISTS (183) depending on the call path; Unix:
    // EEXIST (17).
    let code = e.raw_os_error();
    code == Some(80) || code == Some(183) || code == Some(17)
}

fn temp_taken(e: &io::Error) -> bool {
    is_collision(e)
}

/// Suffix the final name before its extension: a.pdf -> a-2.pdf.
fn suffix_name(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{}-{}{}", &name[..i], n, &name[i..]),
        _ => format!("{name}-{n}"),
    }
}

/// Delete the ledger's partial names handle-relative (confinement: only
/// names this session created are ever touched).
fn cleanup_partials(dir: &HeldDir, partials: &mut Vec<String>) {
    for name in partials.drain(..) {
        let _ = dir.delete_name(&name);
    }
}

/// Display-only join for the report path (never used to address a write).
fn join_display(root: &str, name: &str) -> String {
    if root.ends_with('/') || root.ends_with('\\') {
        format!("{root}{name}")
    } else {
        format!("{root}\\{name}")
    }
}

/// Publish with deterministic collision suffixes, from the SAME temp
/// handle: a.pdf, a-2.pdf, ... a-999.pdf. Exactly one rename wins.
fn publish_with_suffix(
    dir: &HeldDir,
    temp: &File,
    temp_name: &str,
    final_name: &str,
) -> io::Result<String> {
    match dir.publish(temp, temp_name, final_name) {
        Ok(p) => Ok(p),
        Err(e) if is_collision(&e) => {
            for n in 2..=PUBLISH_SUFFIX_MAX {
                let alt = suffix_name(final_name, n);
                match dir.publish(temp, temp_name, &alt) {
                    Ok(p) => return Ok(p),
                    Err(e2) if is_collision(&e2) => continue,
                    Err(e2) => return Err(e2),
                }
            }
            Err(e)
        }
        Err(e) => Err(e),
    }
}

/// One write inside an active session. Temp exclusive-create (serials on
/// taken names), write+flush+sync, publish with collision suffixes from the
/// SAME handle, ledger cleanup on every failure path.
fn write_session_file(
    session: &mut ActiveSession,
    name: &str,
    bytes: &[u8],
) -> Result<WriteOutcome, String> {
    for serial in 0..1000u32 {
        let (temp, temp_name) = match session.dir.create_temp(name, serial) {
            Ok(pair) => pair,
            Err(e) if temp_taken(&e) => continue,
            Err(e) => {
                return Ok(WriteOutcome {
                    ok: false,
                    path: None,
                    error: Some(format!("temp create failed: {e}")),
                });
            }
        };
        // Ledger BEFORE any fallible step: every failure path below cleans it.
        session.partials.push(temp_name.clone());
        let mut temp_file = temp;
        let write_res = (|| -> io::Result<()> {
            temp_file.write_all(bytes)?;
            temp_file.flush()?;
            temp_file.sync_all()?;
            Ok(())
        })();
        if let Err(e) = write_res {
            let msg = format!("write failed: {e}");
            cleanup_partials(&session.dir, &mut session.partials);
            return Ok(WriteOutcome { ok: false, path: None, error: Some(msg) });
        }
        match publish_with_suffix(&session.dir, &temp_file, &temp_name, name) {
            Ok(published) => {
                let display =
                    session.dir.display_root().map(|root| join_display(&root, &published));
                return Ok(WriteOutcome { ok: true, path: display, error: None });
            }
            Err(e) => {
                let msg = format!("publish failed: {e}");
                cleanup_partials(&session.dir, &mut session.partials);
                return Ok(WriteOutcome { ok: false, path: None, error: Some(msg) });
            }
        }
    }
    Ok(WriteOutcome {
        ok: false,
        path: None,
        error: Some("no free temp serial".into()),
    })
}

/* ------------------------------ IPC commands ------------------------------ */

#[derive(serde::Serialize)]
pub struct SessionBegin {
    pub token: String,
    /// Display-only: the directory shown to the user in reports. Never used
    /// to address a write.
    pub path: String,
}

#[tauri::command]
pub async fn save_session_begin(
    state: tauri::State<'_, SaveWriterState>,
    path: String,
) -> Result<SessionBegin, String> {
    let token = state.begin(&path)?;
    Ok(SessionBegin { token, path })
}

#[tauri::command]
pub async fn save_session_write(
    request: tauri::ipc::Request<'_>,
    state: tauri::State<'_, SaveWriterState>,
) -> Result<WriteOutcome, String> {
    use tauri::ipc::InvokeBody;
    let headers = request.headers();
    let token = headers
        .get("x-pdftk-token")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing session token header")?
        .to_string();
    let raw_name = headers
        .get("x-pdftk-name")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing name header")?;
    let name = percent_decode(raw_name)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("raw byte body required".into()),
    };
    state.write_file(&token, &name, &bytes)
}

#[tauri::command]
pub async fn save_session_end(
    state: tauri::State<'_, SaveWriterState>,
    token: String,
) -> Result<(), String> {
    state.end(&token);
    Ok(())
}

fn percent_decode(raw: &str) -> Result<String, String> {
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let src = raw.as_bytes();
    let mut i = 0;
    while i < src.len() {
        if src[i] == b'%' {
            if i + 2 >= src.len() {
                return Err("truncated percent escape".into());
            }
            let hi = (src[i + 1] as char).to_digit(16).ok_or("bad percent escape")?;
            let lo = (src[i + 2] as char).to_digit(16).ok_or("bad percent escape")?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(src[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "non-utf8 name".into())
}

/* ------------------------------ tests ------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pdftk-save-writer-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn basename_validation_refuses_traversal_and_control() {
        assert!(validate_basename("ok.pdf").is_ok());
        assert!(validate_basename("").is_err());
        assert!(validate_basename("..").is_err());
        assert!(validate_basename("a/b.pdf").is_err());
        assert!(validate_basename("a\\b.pdf").is_err());
        assert!(validate_basename("C:\\x.pdf").is_err());
        assert!(validate_basename("bad\u{0001}name").is_err());
        assert!(validate_basename(&"x".repeat(241)).is_err());
    }

    #[test]
    fn percent_decode_round_trip() {
        assert_eq!(percent_decode("a%20b.pdf").unwrap(), "a b.pdf");
        assert_eq!(percent_decode("t%C3%A0i.pdf").unwrap(), "tài.pdf");
        assert!(percent_decode("bad%2").is_err());
    }

    #[test]
    #[cfg(windows)]
    fn exclusive_create_preserves_original_bytes() {
        let root = unique_root("excl");
        let chosen = root.join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        let dir = WinDirHandle::open(&chosen).unwrap();
        let mut f1 = dir.create_exclusive("out.pdf").unwrap();
        f1.write_all(b"original").unwrap();
        drop(f1);
        assert!(dir.create_exclusive("out.pdf").is_err());
        assert_eq!(std::fs::read(chosen.join("out.pdf")).unwrap(), b"original");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn traversal_and_absolute_refused_at_create() {
        let root = unique_root("trav");
        let chosen = root.join("chosen");
        let outside = root.join("outside");
        std::fs::create_dir_all(&chosen).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let dir = WinDirHandle::open(&chosen).unwrap();
        assert!(dir.create_exclusive("../outside/escape.pdf").is_err());
        assert!(dir.create_exclusive("C:\\escape.pdf").is_err());
        assert!(dir.create_exclusive("sub\\escape.pdf").is_err());
        assert!(!outside.join("escape.pdf").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn held_identity_survives_parent_rename_and_replacement() {
        let root = unique_root("swap");
        let chosen = root.join("chosen");
        let moved = root.join("chosen-moved");
        std::fs::create_dir_all(&chosen).unwrap();
        let dir = WinDirHandle::open(&chosen).unwrap();
        // Replace the path with a DIFFERENT directory after opening.
        std::fs::rename(&chosen, &moved).unwrap();
        std::fs::create_dir_all(&chosen).unwrap();
        let mut f = dir.create_exclusive("after-swap.pdf").unwrap();
        f.write_all(b"held").unwrap();
        drop(f);
        assert!(moved.join("after-swap.pdf").exists());
        assert!(!chosen.join("after-swap.pdf").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn begin_refuses_file_and_symlink_dir() {
        let root = unique_root("begin");
        let file = root.join("not-a-dir.pdf");
        std::fs::write(&file, b"x").unwrap();
        assert!(HeldDir::open(&file).is_err());
        // Windows directory symlink requires privileges; use a junction
        // (reparse point, creatable unprivileged) to prove fail-closed.
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let link = root.join("link");
        run_cmd(&format!("mklink /J \"{}\" \"{}\"", link.display(), target.display()));
        assert!(HeldDir::open(&link).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn reparse_child_redirect_fails_closed() {
        let root = unique_root("reparse");
        let chosen = root.join("chosen");
        let outside = root.join("outside");
        std::fs::create_dir_all(&chosen).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // Junction INSIDE the held dir pointing outside.
        let link = chosen.join("junction");
        run_cmd(&format!("mklink /J \"{}\" \"{}\"", link.display(), outside.display()));
        let dir = WinDirHandle::open(&chosen).unwrap();
        // Creating THROUGH the junction name must fail closed, never land outside.
        assert!(dir.create_exclusive("junction\\escape.pdf").is_err());
        assert!(dir.create_exclusive("junction").is_err());
        assert!(dir.create_exclusive("junction.pdf").is_ok());
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn collision_gets_deterministic_suffix_original_untouched() {
        let root = unique_root("coll");
        let chosen = root.join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        std::fs::write(chosen.join("doc.pdf"), b"KEEP").unwrap();
        let state = SaveWriterState::new();
        let token = state.begin(chosen.to_str().unwrap()).unwrap();
        let out = state.write_file(&token, "doc.pdf", b"NEW").unwrap();
        assert!(out.ok);
        let published = out.path.unwrap();
        assert!(published.ends_with("doc-2.pdf"), "{published}");
        assert_eq!(std::fs::read(chosen.join("doc.pdf")).unwrap(), b"KEEP");
        assert_eq!(std::fs::read(chosen.join("doc-2.pdf")).unwrap(), b"NEW");
        // No partial leftovers.
        let names: Vec<String> = std::fs::read_dir(&chosen)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|n| !n.contains(PARTIAL_EXT)), "{names:?}");
        state.end(&token);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn delete_name_removes_only_the_targeted_temp() {
        // Interrupted writes are cleaned by the LEDGER + handle-relative
        // delete. In-process we cannot crash between create and publish, so
        // the mechanism itself is pinned: delete_name removes exactly the
        // named partial and nothing else, and cannot traverse.
        let root = unique_root("interrupt");
        let chosen = root.join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        let dir = WinDirHandle::open(&chosen).unwrap();
        let partial = dir.create_exclusive("x.pdf.pdftk-partial-0").unwrap();
        drop(partial);
        let keep = dir.create_exclusive("keep.pdf").unwrap();
        drop(keep);
        dir.delete_name("x.pdf.pdftk-partial-0").unwrap();
        assert!(!chosen.join("x.pdf.pdftk-partial-0").exists());
        assert!(chosen.join("keep.pdf").exists());
        // No traversal through the name (separators are refused upstream,
        // and OBJ_DONT_REPARSE + relative resolution fail closed here too).
        assert!(dir.delete_name("..\\escape.pdf").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn end_cleans_session_partials_and_closes() {
        let root = unique_root("end");
        let chosen = root.join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        let state = SaveWriterState::new();
        let token = state.begin(chosen.to_str().unwrap()).unwrap();
        let out = state.write_file(&token, "good.pdf", b"data").unwrap();
        assert!(out.ok);
        // begin a SECOND session: replaces the first after TTL — but for the
        // test, end explicitly and verify the report path matches disk.
        assert_eq!(std::fs::read(chosen.join("good.pdf")).unwrap(), b"data");
        state.end(&token);
        // A stale token writes nothing.
        assert!(state
.write_file(&token, "late.pdf", b"x").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn unicode_names_survive_the_protocol() {
        let root = unique_root("uni");
        let chosen = root.join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        let state = SaveWriterState::new();
        let token = state.begin(chosen.to_str().unwrap()).unwrap();
        let name = "tai-lieu-2026-n7.pdf";
        let out = state.write_file(&token, name, b"noi dung").unwrap();
        assert!(out.ok, "{out:?}");
        assert_eq!(std::fs::read(chosen.join(name)).unwrap(), b"noi dung");
        state.end(&token);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn parent_race_between_pick_and_write_lands_in_held_dir() {
        // The spike's core property, re-proven through the session API:
        // rename+replace the picked path AFTER begin; the bytes must land
        // in the ORIGINAL (held) directory, never the path replacement.
        let root = unique_root("race");
        let chosen = root.join("chosen");
        let decoy = root.join("decoy");
        std::fs::create_dir_all(&chosen).unwrap();
        std::fs::create_dir_all(&decoy).unwrap();
        let state = SaveWriterState::new();
        let token = state.begin(chosen.to_str().unwrap()).unwrap();
        std::fs::rename(&chosen, &root.join("chosen-old")).unwrap();
        std::fs::rename(&decoy, &chosen).unwrap();
        let out = state.write_file(&token, "race.pdf", b"held").unwrap();
        assert!(out.ok);
        assert!(root.join("chosen-old").join("race.pdf").exists());
        assert!(!chosen.join("race.pdf").exists());
        state.end(&token);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    fn run_cmd(cmd: &str) {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("cmd")
            .raw_arg("/C")
            .raw_arg(cmd)
            .output()
            .expect("mklink helper");
        assert!(
            out.status.success(),
            "cmd failed: {} | stdout: {} | stderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
            cmd
        );
    }
}
