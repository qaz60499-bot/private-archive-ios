#![windows_subsystem = "windows"]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const APP_BYTES: &[u8] = include_bytes!("../../release/PrivateArchive.exe");
const UNINSTALL_BYTES: &[u8] = include_bytes!("../../release/PrivateArchive-Uninstall.exe");

fn ps_quote(value: &str) -> String {
    value.replace(''', "''")
}

fn install_dir() -> PathBuf {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    base.join("Programs").join("PrivateArchive")
}

fn create_shortcuts(app: &Path, install_dir: &Path) {
    let app = ps_quote(&app.to_string_lossy());
    let work = ps_quote(&install_dir.to_string_lossy());
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $target='{app}'; $work='{work}'; \
         $ws=New-Object -ComObject WScript.Shell; \
         $desktop=[Environment]::GetFolderPath('Desktop'); \
         $start=[Environment]::GetFolderPath('StartMenu'); \
         $desktopLink=Join-Path $desktop 'Private Archive.lnk'; \
         $s=$ws.CreateShortcut($desktopLink); $s.TargetPath=$target; $s.WorkingDirectory=$work; $s.Description='Private Archive'; $s.Save(); \
         $startLink=Join-Path $start 'Programs\\Private Archive.lnk'; \
         $s2=$ws.CreateShortcut($startLink); $s2.TargetPath=$target; $s2.WorkingDirectory=$work; $s2.Description='Private Archive'; $s2.Save();"
    );

    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let _ = command.status();
}

fn main() {
    let install_dir = install_dir();
    if fs::create_dir_all(&install_dir).is_err() {
        return;
    }

    let app_path = install_dir.join("PrivateArchive.exe");
    let uninstall_path = install_dir.join("PrivateArchive-Uninstall.exe");
    if fs::write(&app_path, APP_BYTES).is_err() {
        return;
    }
    if fs::write(&uninstall_path, UNINSTALL_BYTES).is_err() {
        return;
    }
    let _ = fs::write(install_dir.join("VERSION.txt"), "Private Archive Desktop 0.1.0\r\n");

    create_shortcuts(&app_path, &install_dir);
    let _ = Command::new(&app_path).spawn();
}
