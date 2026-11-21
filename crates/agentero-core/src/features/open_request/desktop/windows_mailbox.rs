//! Protect the mailbox before it contains a request, reply, or endpoint lease.
use crate::error::AppError;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

pub struct MailboxDirectory(PathBuf);

impl MailboxDirectory {
    pub fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for MailboxDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn private_dir(parent: Option<&Path>, prefix: &str) -> Result<MailboxDirectory, AppError> {
    let parent = parent
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let path = parent
        .canonicalize()?
        .join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()));
    let name: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Protected DACL: no inherited access from an unusually permissive parent.
    // Owner Rights and LocalSystem inherit full control on files and directories.
    let mut descriptor = std::ptr::null_mut();
    let acl = windows_sys::core::w!("D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)");
    // SAFETY: the SDDL and output pointer are valid. Windows allocates the
    // descriptor on success; it remains alive until CreateDirectoryW returns.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            acl,
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let created = CreateDirectoryW(name.as_ptr(), &attributes);
        let error = (created == 0).then(io::Error::last_os_error);
        LocalFree(descriptor);
        if let Some(err) = error {
            return Err(err.into());
        }
    }
    Ok(MailboxDirectory(path))
}
