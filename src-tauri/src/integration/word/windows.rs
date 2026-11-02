//! Hidden top-level window for the official Windows Zotero Word template.
//! The macro calls FindWindow("ZoteroMessageWindow") and sends WM_COPYDATA.
//! A message-only HWND is invisible to that lookup.

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::AppHandle;
use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostMessageW,
    PostQuitMessage, RegisterClassW, TranslateMessage, MSG, WM_CLOSE, WM_COPYDATA, WM_DESTROY,
    WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

const CLASS_ALREADY_EXISTS: u32 = 1410;
static HWND_SLOT: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
static THREAD: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

pub fn start(app: &AppHandle) -> Result<(), String> {
    if !HWND_SLOT.load(Ordering::SeqCst).is_null() {
        return Ok(());
    }
    let slot = APP.get_or_init(|| Mutex::new(None));
    *slot.lock().map_err(|e| e.to_string())? = Some(app.clone());
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::Builder::new()
        .name("word-integration".into())
        .spawn(move || run_listener(tx))
        .map_err(|e| e.to_string())?;
    let hwnd = rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "word.driverFailed".to_string())?;
    if hwnd == 0 {
        let _ = handle.join();
        return Err("word.driverFailed".into());
    }
    HWND_SLOT.store(hwnd as *mut c_void, Ordering::SeqCst);
    *THREAD.lock().map_err(|e| e.to_string())? = Some(handle);
    Ok(())
}

pub fn stop() {
    let hwnd = HWND_SLOT.swap(ptr::null_mut(), Ordering::SeqCst);
    if !hwnd.is_null() {
        unsafe {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
    }
    if let Some(handle) = THREAD.lock().ok().and_then(|mut slot| slot.take()) {
        let _ = handle.join();
    }
}

fn run_listener(ready: mpsc::Sender<isize>) {
    let class_name = wide("ZoteroMessageWindow");
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let class = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: ptr::null_mut(),
        hCursor: ptr::null_mut(),
        hbrBackground: ptr::null_mut(),
        lpszMenuName: ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    let atom = unsafe { RegisterClassW(&class) };
    if atom == 0 && unsafe { GetLastError() } != CLASS_ALREADY_EXISTS {
        let _ = ready.send(0);
        return;
    }
    // FindWindow does not see HWND_MESSAGE. Leave this top-level window hidden.
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            0,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null(),
        )
    };
    if ready.send(hwnd as isize).is_err() || hwnd.is_null() {
        return;
    }
    let mut message = MSG::default();
    loop {
        let code = unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) };
        if code <= 0 {
            break;
        }
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_COPYDATA => {
            if let Some(command) = command_from_copydata(lparam) {
                if let Some(app) = current_app() {
                    match super::accept(app.clone(), command) {
                        Ok(()) => {}
                        Err(error) => super::note_rejection(&app, error),
                    }
                }
            }
            1
        }
        WM_CLOSE => {
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn current_app() -> Option<AppHandle> {
    APP.get()?.lock().ok().and_then(|slot| slot.clone())
}

fn command_from_copydata(lparam: LPARAM) -> Option<String> {
    if lparam == 0 {
        return None;
    }
    #[repr(C)]
    struct CopyData {
        dw_data: usize,
        cb_data: u32,
        lp_data: *const u8,
    }
    let data = unsafe { &*(lparam as *const CopyData) };
    if data.lp_data.is_null() || data.cb_data == 0 || data.cb_data > 16 * 1024 {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data.lp_data, data.cb_data as usize) };
    let text = match data.dw_data {
        1 => String::from_utf8_lossy(bytes).into_owned(),
        2 => {
            if bytes.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            String::from_utf16_lossy(&units)
        }
        _ => return None,
    };
    parse_command(&text).ok()
}

pub(super) fn parse_command(message: &str) -> Result<String, &'static str> {
    let line = message.split('\0').next().unwrap_or(message);
    let tokens = tokenize(line);
    let agent = flag(&tokens, "-ZoteroIntegrationAgent")?;
    let command = flag(&tokens, "-ZoteroIntegrationCommand")?;
    let document = flag(&tokens, "-ZoteroIntegrationDocument")?;
    let version = flag(&tokens, "-ZoteroIntegrationTemplateVersion")?;
    if agent != "WinWord" || version != "1" {
        return Err("rejected");
    }
    if document.is_empty() || document.len() > 4096 || document.contains(['\n', '\r']) {
        return Err("rejected");
    }
    if !matches!(
        command,
        "addEditCitation" | "addEditBibliography" | "refresh" | "setDocPrefs"
    ) {
        return Err("rejected");
    }
    Ok(command.to_string())
}

fn flag<'a>(tokens: &'a [String], name: &str) -> Result<&'a str, &'static str> {
    tokens
        .iter()
        .position(|token| token == name)
        .and_then(|index| tokens.get(index + 1))
        .map(String::as_str)
        .ok_or("rejected")
}

fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() {
            continue;
        }
        if ch == '"' {
            let mut value = String::new();
            while let Some(next) = chars.next() {
                if next == '"' {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        value.push('"');
                    } else {
                        break;
                    }
                } else {
                    value.push(next);
                }
            }
            tokens.push(value);
        } else {
            let mut value = String::from(ch);
            while let Some(next) = chars.peek().copied() {
                if next.is_whitespace() {
                    break;
                }
                chars.next();
                value.push(next);
            }
            tokens.push(value);
        }
    }
    tokens
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::parse_command;

    #[test]
    fn parses_official_windows_template_message() {
        let message = "zotero.exe -silent -ZoteroIntegrationAgent WinWord -ZoteroIntegrationCommand addEditCitation -ZoteroIntegrationDocument \"C:\\Papers\\My Paper.docx\" -ZoteroIntegrationTemplateVersion 1\0C:\\";
        assert_eq!(parse_command(message).as_deref(), Ok("addEditCitation"));
    }

    #[test]
    fn rejects_unknown_agent_and_unquoted_injection() {
        let message = "zotero.exe -ZoteroIntegrationAgent MacWord -ZoteroIntegrationCommand addEditCitation -ZoteroIntegrationDocument \"C:\\a.docx\" -ZoteroIntegrationTemplateVersion 1";
        assert!(parse_command(message).is_err());
        let quoted = "zotero.exe -ZoteroIntegrationAgent WinWord -ZoteroIntegrationCommand addEditCitation -ZoteroIntegrationDocument \"a.docx\nbad\" -ZoteroIntegrationTemplateVersion 1";
        assert!(parse_command(quoted).is_err());
    }
}
