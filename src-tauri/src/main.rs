#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

// Runs inside the lookup window on orbispatches.com / prosperopatches.com only.
// It waits for the page to render (the sites are JavaScript-driven), reads the game
// name and the patch versions from the DOM, and hands the result back through the
// URL fragment (#psa=...), which Rust reads. No remote IPC permissions are needed.
const INIT_JS: &str = r#"
(function () {
  if (window.top !== window) return;
  if (!/(^|\.)(orbispatches|prosperopatches)\.com$/.test(location.hostname)) return;
  var done = false, t0 = Date.now();
  function put(o) { try { location.hash = 'psa=' + encodeURIComponent(JSON.stringify(o)); } catch (e) {} }
  function scan() {
    if (done) return;
    var h = document.querySelector('h3.h3-title, .h3-title');
    var vs = [].map.call(document.querySelectorAll('[data-version]'), function (e) { return e.getAttribute('data-version'); });
    if (h && h.textContent.trim()) {
      done = true;
      put({ status: 'ok', name: h.textContent.trim(), versions: vs });
      return;
    }
    var txt = ((document.body && document.body.innerText) || '').slice(0, 4000);
    var chall = /just a moment|verify you are human|checking your browser|cf-turnstile/i.test(document.title + ' ' + txt) ||
      !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    var el = Date.now() - t0;
    if (chall && el > 3000) put({ status: 'challenge' });
    if (el > 25000 && !chall) {
      done = true;
      put({ status: 'notfound', debug: (document.title + '\n' + txt).slice(0, 1500) });
      return;
    }
    setTimeout(scan, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
"#;

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct LookupResult {
    status: String,
    name: Option<String>,
    versions: Vec<String>,
    debug: Option<String>,
}

fn read_report(win: &tauri::WebviewWindow, tid: &str) -> Option<LookupResult> {
    let url = win.url().ok()?;
    // ignore the previous title's page while the new one is still loading
    if !url.path().to_uppercase().ends_with(tid) {
        return None;
    }
    let enc = url.fragment()?.strip_prefix("psa=")?;
    let json = percent_encoding::percent_decode_str(enc).decode_utf8().ok()?;
    serde_json::from_str::<LookupResult>(&json).ok()
}

#[tauri::command]
async fn lookup_title(app: AppHandle, tid: String) -> Result<LookupResult, String> {
    let tid = tid.to_uppercase();
    let valid = tid.is_ascii()
        && tid.len() == 9
        && (tid.starts_with("CUSA") || tid.starts_with("PPSA"))
        && tid[4..].chars().all(|c| c.is_ascii_digit());
    if !valid {
        return Err("invalid title id".into());
    }
    let host = if tid.starts_with("CUSA") { "orbispatches.com" } else { "prosperopatches.com" };
    let target = format!("https://{}/{}", host, tid);
    let parsed = tauri::Url::parse(&target).map_err(|e| e.to_string())?;

    let win = match app.get_webview_window("lookup") {
        Some(w) => {
            w.eval(&format!("window.location.href = '{}';", target))
                .map_err(|e| e.to_string())?;
            w
        }
        None => WebviewWindowBuilder::new(&app, "lookup", WebviewUrl::External(parsed))
            .title("بررسی آنلاین — اگر تأیید انسانی خواست، یک‌بار انجامش دهید")
            .inner_size(900.0, 700.0)
            .visible(false)
            .initialization_script(INIT_JS)
            .build()
            .map_err(|e| e.to_string())?,
    };

    let start = Instant::now();
    let mut limit = Duration::from_secs(45);
    let mut shown = false;
    loop {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if let Some(rep) = read_report(&win, &tid) {
            if rep.status == "challenge" {
                if !shown {
                    // The site wants a human check: show the window so the user can pass it once.
                    // The browser profile keeps the result, so later lookups usually go through.
                    let _ = win.show();
                    let _ = win.set_focus();
                    shown = true;
                    limit = start.elapsed() + Duration::from_secs(240);
                }
            } else {
                if shown {
                    let _ = win.hide();
                }
                return Ok(rep);
            }
        }
        if start.elapsed() > limit {
            if shown {
                let _ = win.hide();
            }
            return Ok(LookupResult { status: "timeout".into(), ..Default::default() });
        }
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://orbispatches.com/") || url.starts_with("https://prosperopatches.com/")) {
        return Err("blocked".into());
    }
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_csv(app: AppHandle, filename: String, contents: String) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let safe: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect();
    let path = dir.join(if safe.is_empty() { "export.csv".to_string() } else { safe });
    std::fs::write(&path, contents.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveFile {
    path: String,
    relative_path: String,
    name: String,
    size: u64,
    mtime_ms: u64,
    cid: Option<String>,
    file_type: Option<String>,
}

fn supported_archive(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "pkg" | "zip" | "rar" | "7z" | "iso" | "bin" | "exfat"))
        .unwrap_or(false)
}

fn inspect_pkg(path: &Path) -> (Option<String>, Option<String>) {
    if !path.extension().and_then(|v| v.to_str()).map(|v| v.eq_ignore_ascii_case("pkg")).unwrap_or(false) {
        return (None, None);
    }
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let mut bytes = [0u8; 0x80];
    if file.read_exact(&mut bytes).is_err() || u32::from_be_bytes(bytes[0..4].try_into().unwrap()) != 0x7F434E54 {
        return (None, None);
    }

    let cid: String = bytes[0x40..0x64]
        .iter()
        .copied()
        .filter(|b| *b != 0)
        .map(char::from)
        .collect();
    let cid = if cid.is_empty() { None } else { Some(cid) };
    let kind = u32::from_be_bytes(bytes[0x74..0x78].try_into().unwrap());
    let file_type = match kind {
        0x1A => Some("Base Game".to_string()),
        0x1B | 0x1C => Some("DLC/Add-on".to_string()),
        0x1D => Some("Update".to_string()),
        _ => None,
    };
    (cid, file_type)
}

fn collect_archive_files(root: &Path, dir: &Path, output: &mut Vec<ArchiveFile>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("خواندن پوشه ممکن نشد: {} ({e})", dir.display()))?;
    for entry in entries {
        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Do not follow symlinks: this avoids loops and keeps scanning within the selected folder.
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case("PS Archive Shortcuts") {
                continue;
            }
            let _ = collect_archive_files(root, &path, output);
            continue;
        }
        if !ft.is_file() || !supported_archive(&path) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let relative = path.strip_prefix(root).unwrap_or(&path);
        let (cid, file_type) = inspect_pkg(&path);
        let mtime_ms = metadata.modified().unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64;
        output.push(ArchiveFile {
            path: path.to_string_lossy().into_owned(),
            relative_path: relative.to_string_lossy().replace('\\', "/"),
            name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            size: metadata.len(),
            mtime_ms,
            cid,
            file_type,
        });
    }
    Ok(())
}

#[tauri::command]
async fn list_archive_files(root: String) -> Result<Vec<ArchiveFile>, String> {
    let root = PathBuf::from(root).canonicalize().map_err(|e| format!("مسیر پوشه معتبر نیست: {e}"))?;
    if !root.is_dir() {
        return Err("مسیر انتخاب‌شده پوشه نیست".into());
    }
    let mut files = Vec::new();
    collect_archive_files(&root, &root, &mut files)?;
    files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    Ok(files)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutInput {
    source_path: String,
    relative_path: String,
    game_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutReport {
    created: usize,
    skipped: usize,
    errors: Vec<String>,
    output_dir: String,
}

fn safe_component(value: &str, max_chars: usize) -> String {
    let mut result: String = value.chars().map(|c| {
        if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c }
    }).take(max_chars).collect();
    result = result.trim().trim_end_matches('.').to_string();
    if result.is_empty() { result = "بازی ناشناس".to_string(); }
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    let stem = result.split('.').next().unwrap_or("").to_ascii_uppercase();
    if reserved.contains(&stem.as_str()) { result.insert(0, '_'); }
    result
}

fn short_path_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:08X}", (hash & 0xFFFF_FFFF) as u32)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutEntry {
    target_path: String,
    shortcut_path: String,
    relative_path: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PowerShellShortcutError {
    relative_path: String,
    message: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PowerShellShortcutResult {
    created: usize,
    errors: Vec<PowerShellShortcutError>,
}

#[cfg(target_os = "windows")]
fn write_windows_shortcuts(output_dir: &Path, entries: &[ShortcutEntry]) -> Result<(usize, Vec<String>), String> {
    if entries.is_empty() { return Ok((0, Vec::new())); }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let manifest = output_dir.join(format!(".psa-shortcuts-{}-{stamp}.json", std::process::id()));
    let payload = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    fs::write(&manifest, payload).map_err(|e| format!("ساخت فهرست شورتکات‌ها ناموفق بود: {e}"))?;

    // One PowerShell process creates all .lnk files in a batch, rather than launching
    // a new process for every archive item. Paths are read from a UTF-8 JSON manifest
    // so Persian and other Unicode folder/file names remain intact.
    let script = r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$json = Get-Content -LiteralPath $env:PSA_MANIFEST_PATH -Raw -Encoding UTF8
$items = @($json | ConvertFrom-Json)
$shell = New-Object -ComObject WScript.Shell
$created = 0
$errors = @()
foreach ($item in $items) {
  try {
    $link = $shell.CreateShortcut([string]$item.shortcutPath)
    $link.TargetPath = [string]$item.targetPath
    $link.WorkingDirectory = Split-Path -LiteralPath ([string]$item.targetPath) -Parent
    $link.Description = 'PS Archive Manager shortcut'
    $link.Save()
    $created++
  } catch {
    $errors += [pscustomobject]@{ relativePath = [string]$item.relativePath; message = $_.Exception.Message }
  }
}
[pscustomobject]@{ created = $created; errors = @($errors) } | ConvertTo-Json -Depth 4 -Compress
"#;
    let result = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("PSA_MANIFEST_PATH", &manifest)
        .output();
    let _ = fs::remove_file(&manifest);
    let output = result.map_err(|e| format!("اجرای PowerShell ممکن نشد: {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() { "ساخت شورتکات‌های ویندوز ناموفق بود".into() } else { detail });
    }
    let parsed: PowerShellShortcutResult = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("خواندن نتیجه ساخت شورتکات‌ها ناموفق بود: {e}; {}", String::from_utf8_lossy(&output.stdout)))?;
    let errors = parsed.errors.into_iter()
        .map(|e| format!("{}: {}", e.relative_path, e.message))
        .collect();
    Ok((parsed.created, errors))
}

#[cfg(not(target_os = "windows"))]
fn write_windows_shortcuts(_output_dir: &Path, _entries: &[ShortcutEntry]) -> Result<(usize, Vec<String>), String> {
    Err("ساخت شورتکات .lnk فقط در نسخه ویندوز پشتیبانی می‌شود".into())
}

#[tauri::command]
async fn create_game_shortcuts(root: String, items: Vec<ShortcutInput>) -> Result<ShortcutReport, String> {
    let root = PathBuf::from(root).canonicalize().map_err(|e| format!("مسیر آرشیو معتبر نیست: {e}"))?;
    if !root.is_dir() { return Err("مسیر آرشیو پوشه نیست".into()); }
    let output_dir = root.join("PS Archive Shortcuts");
    let mut report = ShortcutReport { created: 0, skipped: 0, errors: Vec::new(), output_dir: output_dir.to_string_lossy().into_owned() };
    if items.is_empty() { return Ok(report); }

    let mut used_paths: HashSet<PathBuf> = HashSet::new();
    let mut pending = Vec::new();
    for item in items {
        let game_name = item.game_name.trim();
        if game_name.is_empty() { report.skipped += 1; continue; }
        let source = match PathBuf::from(&item.source_path).canonicalize() {
            Ok(p) => p,
            Err(_) => { report.errors.push(format!("فایل پیدا نشد: {}", item.relative_path)); continue; }
        };
        if !source.starts_with(&root) || !source.is_file() || !supported_archive(&source) {
            report.errors.push(format!("مسیر فایل معتبر نیست: {}", item.relative_path));
            continue;
        }
        let game_dir = output_dir.join(safe_component(game_name, 100));
        if let Err(e) = fs::create_dir_all(&game_dir) {
            report.errors.push(format!("ساخت پوشه بازی ناموفق بود: {game_name} ({e})"));
            continue;
        }
        let original_name = source.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let base_name = safe_component(&original_name, 170);
        let base_link = game_dir.join(format!("{base_name}.lnk"));
        let mut link_path = base_link.clone();
        if !used_paths.insert(link_path.clone()) {
            let suffix = short_path_hash(&item.relative_path);
            link_path = game_dir.join(format!("{base_name} [{suffix}].lnk"));
            if !used_paths.insert(link_path.clone()) {
                report.skipped += 1;
                continue;
            }
        }
        // Existing shortcuts are left untouched; repeat scans do not recreate them.
        if link_path.exists() {
            report.skipped += 1;
            continue;
        }
        pending.push(ShortcutEntry {
            target_path: source.to_string_lossy().into_owned(),
            shortcut_path: link_path.to_string_lossy().into_owned(),
            relative_path: item.relative_path,
        });
    }
    match write_windows_shortcuts(&output_dir, &pending) {
        Ok((created, errors)) => {
            report.created = created;
            report.errors.extend(errors);
        }
        Err(e) => report.errors.push(e),
    }
    report.errors.truncate(10);
    Ok(report)
}


#[tauri::command]
fn open_shortcuts_folder(root: String) -> Result<(), String> {
    let root = PathBuf::from(root).canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() { return Err("مسیر آرشیو پوشه نیست".into()); }
    let folder = root.join("PS Archive Shortcuts");
    if !folder.is_dir() { return Err("هنوز پوشه شورتکات‌ها ساخته نشده است".into()); }
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe").arg(&folder).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&folder).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&folder).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![lookup_title, open_url, save_csv, list_archive_files, create_game_shortcuts, open_shortcuts_folder])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running application");
}
