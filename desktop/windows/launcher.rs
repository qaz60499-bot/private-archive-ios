#![windows_subsystem = "windows"]

use std::env;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

fn default_url() -> String {
    option_env!("PRIVATE_ARCHIVE_DEFAULT_URL")
        .unwrap_or("https://photo.joye.cc.cd/?app=personal-desktop")
        .to_string()
}

fn local_root() -> Option<&'static str> {
    option_env!("PRIVATE_ARCHIVE_LOCAL_ROOT")
}

fn is_allowed_url(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:")
}

fn local_port(url: &str) -> Option<u16> {
    let rest = url
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| url.strip_prefix("http://localhost:"))?;
    rest.split('/').next()?.parse().ok()
}

fn write_log(message: &str) {
    let path = env::temp_dir().join("PrivateArchive-local.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", message);
    }
}

fn http_ready(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let socket = match addr.to_socket_addrs().ok().and_then(|mut addrs| addrs.next()) {
        Some(value) => value,
        None => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&socket, Duration::from_millis(700)) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(900)));
    if stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0_u8; 32];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => buf[..n].starts_with(b"HTTP/"),
        _ => false,
    }
}

fn start_local_worker(root: &str, port: u16) {
    let log_path = env::temp_dir().join("PrivateArchive-wrangler.log");
    let stdout = File::create(&log_path).ok();
    let stderr = stdout.as_ref().and_then(|file| file.try_clone().ok());

    let mut command = Command::new("cmd.exe");
    command
        .args([
            "/D",
            "/S",
            "/C",
            &format!("npx wrangler dev --local --port {port}"),
        ])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(stdout.map(Stdio::from).unwrap_or(Stdio::null()))
        .stderr(stderr.map(Stdio::from).unwrap_or(Stdio::null()));

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);

    match command.spawn() {
        Ok(child) => write_log(&format!(
            "Started local Wrangler pid={} root={} port={} log={}",
            child.id(),
            root,
            port,
            log_path.display()
        )),
        Err(error) => write_log(&format!("Failed to start local Wrangler: {error}")),
    }
}

fn wait_for_local(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if http_ready(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

fn candidate_edge_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(value) = env::var("EDGE_PATH") {
        paths.push(PathBuf::from(value));
    }
    for key in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Ok(base) = env::var(key) {
            paths.push(
                Path::new(&base)
                    .join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
            );
        }
    }
    paths
}

fn launch_edge_app(url: &str) -> bool {
    for edge in candidate_edge_paths() {
        if !edge.is_file() {
            continue;
        }
        let mut command = Command::new(edge);
        command.args([
            &format!("--app={url}"),
            "--start-maximized",
            "--no-first-run",
            "--no-default-browser-check",
        ]);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        if command.spawn().is_ok() {
            return true;
        }
    }
    false
}

fn open_default_browser(url: &str) {
    let mut command = Command::new("cmd.exe");
    command.args(["/D", "/S", "/C", &format!("start \"\" \"{url}\"")]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let _ = command.spawn();
}

fn main() {
    let mut url = default_url();
    let args: Vec<String> = env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--url" && index + 1 < args.len() {
            url = args[index + 1].clone();
            index += 2;
            continue;
        }
        index += 1;
    }

    if !is_allowed_url(&url) {
        url = default_url();
    }

    if let (Some(root), Some(port)) = (local_root(), local_port(&url)) {
        if !http_ready(port) {
            write_log(&format!("Local endpoint not ready; starting Wrangler on {port}"));
            start_local_worker(root, port);
            let ready = wait_for_local(port, Duration::from_secs(35));
            write_log(&format!("Local endpoint ready={ready}"));
        }
    }

    if !launch_edge_app(&url) {
        open_default_browser(&url);
    }
}
