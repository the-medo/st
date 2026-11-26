//! A non-activating Windows status popup. Linux uses its local status file.
#[cfg(windows)]
pub fn run(stage: std::sync::Arc<std::sync::atomic::AtomicU8>) {
    use std::{ptr::null_mut, sync::atomic::Ordering, time::Duration};
    use windows_sys::Win32::System::SystemServices::SS_CENTER;
    use windows_sys::Win32::{System::LibraryLoader::GetModuleHandleW, UI::WindowsAndMessaging::*};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        let class = wide("STATIC");
        let title = wide("S.T. — Listening…");
        let window = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP | WS_BORDER | SS_CENTER as u32,
            40,
            40,
            320,
            60,
            null_mut(),
            null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        if window.is_null() {
            return;
        }
        loop {
            let state = stage.load(Ordering::Relaxed);
            if state == 255 {
                DestroyWindow(window);
                break;
            }
            let text = wide(match state {
                1 => "S.T. — Listening…",
                2 => "S.T. — Transcribing…",
                3 => "S.T. — Sending…",
                4 => "S.T. — Offline / retrying",
                _ => "S.T.",
            });
            SetWindowTextW(window, text.as_ptr());
            ShowWindow(
                window,
                if (1..=4).contains(&state) {
                    SW_SHOWNOACTIVATE
                } else {
                    SW_HIDE
                },
            );
            let mut msg = std::mem::zeroed();
            while PeekMessageW(&mut msg, null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::thread::sleep(Duration::from_millis(75));
        }
    }
}
#[cfg(not(windows))]
pub fn run(_stage: std::sync::Arc<std::sync::atomic::AtomicU8>) {}
