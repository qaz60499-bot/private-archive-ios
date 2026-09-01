#![windows_subsystem = "windows"]

use std::env;
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn ps_quote(value: &str) -> String {
    value.replace(''', "''")
}

fn install_dir() -> PathBuf {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    base.join("Programs").join("PrivateArchive")
}

fn main() {
    let install_dir = install_dir();
    let dir = ps_quote(&install_dir.to_string_lossy());
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $desktop=[Environment]::GetFolderPath('Desktop'); \
         $start=[Environment]::GetFolderPath('StartMenu'); \
         Remove-Item -LiteralPath (Join-Path $desktop 'Private Archive.lnk') -Force; \
         Remove-Item -LiteralPath (Join-Path $start 'Programs\\Private Archive.lnk') -Force; \
         Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command',\"Start-Sleep -Milliseconds 800; Remove-Item -LiteralPath ''{dir}'' -Recurse -Force\""
    );

    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let _ = command.spawn();
}
