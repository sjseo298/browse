//! Chrome-family browsers on this computer, which profiles have the browse extension, and opening pages in them
//! (cli/src/setup/browsers.ts).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::setup::home;

pub const STORE_ID: &str = "mfnicocicmmlkpjnaffgihfjhdgjkdjg";
pub const EXTENSION_RELEASE_URL: &str = "https://github.com/sjseo298/browse/releases/latest";

pub fn store_id() -> String {
    std::env::var("OPENCODE_BROWSER_STORE_ID")
        .ok()
        .filter(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
        .unwrap_or_else(|| STORE_ID.into())
}

/// Fork extension download page (GitHub Releases with unpacked `browse-extension-<version>.zip`).
pub fn extension_url() -> String {
    std::env::var("OPENCODE_BROWSER_EXTENSION_URL")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| s.starts_with("https://"))
        .unwrap_or_else(|| EXTENSION_RELEASE_URL.to_owned())
}

pub struct Browser {
    pub name: &'static str,
    user_data: PathBuf,
    /// macOS: the app bundle name. Elsewhere: executable names on PATH, or full paths on Windows.
    launch: Vec<String>,
}

pub struct Match {
    pub browser: usize,
    pub profile: String,
    pub profile_name: String,
    pub extension_id: String,
    pub enabled: bool,
}

pub fn browsers() -> Vec<Browser> {
    let home = home();
    if cfg!(target_os = "macos") {
        let support = home.join("Library/Application Support");
        return [
            ("Google Chrome", "Google Chrome", "Google/Chrome"),
            ("Google Chrome Beta", "Google Chrome Beta", "Google/Chrome Beta"),
            ("Google Chrome Canary", "Google Chrome Canary", "Google/Chrome Canary"),
            ("Chromium", "Chromium", "Chromium"),
            ("Microsoft Edge", "Microsoft Edge", "Microsoft Edge"),
            ("Brave", "Brave Browser", "BraveSoftware/Brave-Browser"),
            ("Opera", "Opera", "com.operasoftware.Opera"),
            ("Vivaldi", "Vivaldi", "Vivaldi"),
            ("Helium", "Helium", "net.imput.helium"),
            ("Arc", "Arc", "Arc/User Data"),
            ("Dia", "Dia", "Dia/User Data"),
            ("Comet", "Comet", "Comet"),
        ]
        .into_iter()
        .map(|(name, app, dir)| Browser { name, user_data: support.join(dir), launch: vec![app.into()] })
        .collect();
    }
    if cfg!(windows) {
        let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let local = env("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData/Local"));
        let roaming = env("APPDATA").unwrap_or_else(|| home.join("AppData/Roaming"));
        let programs: Vec<PathBuf> = [env("ProgramFiles"), env("ProgramFiles(x86)"), Some(local.clone())].into_iter().flatten().collect();
        let installs = |exe: &str| programs.iter().map(|dir| dir.join(exe).to_string_lossy().into_owned()).collect();
        return vec![
            Browser { name: "Google Chrome", user_data: local.join("Google/Chrome/User Data"), launch: installs("Google\\Chrome\\Application\\chrome.exe") },
            Browser { name: "Microsoft Edge", user_data: local.join("Microsoft/Edge/User Data"), launch: installs("Microsoft\\Edge\\Application\\msedge.exe") },
            Browser { name: "Brave", user_data: local.join("BraveSoftware/Brave-Browser/User Data"), launch: installs("BraveSoftware\\Brave-Browser\\Application\\brave.exe") },
            Browser { name: "Opera", user_data: roaming.join("Opera Software/Opera Stable"), launch: installs("Programs\\Opera\\opera.exe") },
            Browser { name: "Vivaldi", user_data: local.join("Vivaldi/User Data"), launch: installs("Vivaldi\\Application\\vivaldi.exe") },
            Browser { name: "Helium", user_data: local.join("imput/Helium/User Data"), launch: installs("imput\\Helium\\Application\\chrome.exe") },
        ];
    }
    let config = crate::setup::config_home();
    let chrome = std::env::var_os("CHROME_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| config.clone());
    [
        ("Google Chrome", &chrome, "google-chrome", &["google-chrome", "google-chrome-stable"][..]),
        ("Google Chrome Beta", &chrome, "google-chrome-beta", &["google-chrome-beta"]),
        ("Google Chrome Unstable", &chrome, "google-chrome-unstable", &["google-chrome-unstable"]),
        ("Chromium", &chrome, "chromium", &["chromium", "chromium-browser"]),
        ("Microsoft Edge", &config, "microsoft-edge", &["microsoft-edge", "microsoft-edge-stable"]),
        ("Brave", &config, "BraveSoftware/Brave-Browser", &["brave-browser", "brave"]),
        ("Opera", &config, "opera", &["opera"]),
        ("Vivaldi", &config, "vivaldi", &["vivaldi", "vivaldi-stable"]),
        ("Helium", &config, "net.imput.helium", &["helium", "helium-browser"]),
    ]
    .into_iter()
    .map(|(name, root, dir, exes)| Browser { name, user_data: root.join(dir), launch: exes.iter().map(|e| (*e).into()).collect() })
    .collect()
}

fn read_json(file: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// Every profile, in every browser here, that has the fork's unpacked extension or store extension.
pub fn detect(browsers: &[Browser]) -> Vec<Match> {
    let unpacked = browse_relay::protocol::UNPACKED_EXTENSION_ID.to_owned();
    let store = store_id();
    let ids: Vec<&str> = if unpacked == store { vec![unpacked.as_str()] } else { vec![unpacked.as_str(), store.as_str()] };
    let mut found = Vec::new();
    for (index, browser) in browsers.iter().enumerate() {
        let Some(state) = read_json(&browser.user_data.join("Local State")) else { continue };
        let profiles: Vec<(String, String)> = match state.pointer("/profile/info_cache").and_then(Value::as_object) {
            Some(cache) if !cache.is_empty() => cache
                .iter()
                .map(|(dir, info)| (dir.clone(), info.get("name").and_then(Value::as_str).unwrap_or(dir).to_owned()))
                .collect(),
            _ => vec![("Default".into(), "Default".into())],
        };
        for (dir, name) in profiles {
            let prefs_list: Vec<Value> = ["Secure Preferences", "Preferences"]
                .iter()
                .filter_map(|file| read_json(&browser.user_data.join(&dir).join(file)))
                .collect();
            let detected = ids.iter().find_map(|id| {
                prefs_list
                    .iter()
                    .find_map(|prefs| prefs.pointer(&format!("/extensions/settings/{id}")).cloned())
                    .map(|setting| ((*id).to_owned(), setting))
            });
            let Some((extension_id, setting)) = detected else { continue };
            let enabled = match setting.get("disable_reasons") {
                Some(Value::Array(reasons)) => reasons.is_empty(),
                Some(Value::Number(n)) => n.as_u64() == Some(0),
                _ => true,
            };
            found.push(Match { browser: index, profile: dir, profile_name: name, extension_id, enabled });
        }
    }
    found
}

/// The browsers here with a profile that has the extension enabled, for the relay to tell whether a hello saying
/// "Chrome" came from Helium (which says it is Chrome).
pub fn with_extension() -> Vec<String> {
    let all = browsers();
    let mut names: Vec<String> = detect(&all).into_iter().filter(|m| m.enabled).map(|m| all[m.browser].name.to_string()).collect();
    names.dedup();
    names
}

pub fn on_path(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ""] } else { &[""] };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|dir| exts.iter().map(move |ext| dir.join(format!("{name}{ext}"))))
        .find(|file| file.is_file())
}

fn spawn(program: impl AsRef<std::ffi::OsStr>, args: &[&str]) -> bool {
    Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().is_ok()
}

impl Browser {
    pub fn is_installed(&self) -> bool {
        if self.user_data.is_dir() {
            return true;
        }
        if cfg!(target_os = "macos") {
            let app = &self.launch[0];
            return [PathBuf::from("/Applications"), home().join("Applications")]
                .into_iter()
                .any(|dir| dir.join(format!("{app}.app")).exists());
        }
        if cfg!(windows) {
            return self.launch.iter().any(|p| Path::new(p).is_file());
        }
        self.launch.iter().any(|name| on_path(name).is_some())
    }
}

/// Opens `url` in the first installed Chromium-family browser (Google Chrome first; never Safari/default browser).
pub fn open_chromium(browsers: &[Browser], url: &str) -> Option<&'static str> {
    browsers.iter().filter(|b| b.is_installed()).find(|b| open_in(b, url, None)).map(|b| b.name)
}

/// Opens `url` in a specific browser (and profile); chrome-extension:// URLs only open this way.
pub fn open_in(browser: &Browser, url: &str, profile: Option<&str>) -> bool {
    let flag = profile.map(|p| format!("--profile-directory={p}"));
    let mut args: Vec<&str> = flag.iter().map(String::as_str).collect();
    args.push(url);
    if cfg!(target_os = "macos") {
        let app = &browser.launch[0];
        let bundle = [PathBuf::from("/Applications"), home().join("Applications")]
            .into_iter()
            .map(|dir| dir.join(format!("{app}.app/Contents/MacOS/{app}")))
            .find(|exe| exe.is_file());
        return match bundle {
            Some(exe) => spawn(exe, &args),
            None => url.starts_with("http") && Command::new("open").args(["-a", app, url]).status().is_ok_and(|s| s.success()),
        };
    }
    let exe = if cfg!(windows) {
        browser.launch.iter().map(PathBuf::from).find(|p| p.is_file())
    } else {
        browser.launch.iter().find_map(|name| on_path(name))
    };
    match exe {
        Some(exe) => spawn(exe, &args),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn extension_url_points_to_fork_releases_not_cws() {
        let url = extension_url();
        assert!(url.starts_with("https://github.com/sjseo298/browse/releases"));
        assert!(!url.contains("chromewebstore"));
    }

    #[test]
    fn detect_finds_unpacked_extension_id() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("browse-detect-test-{nonce}"));
        let profile = root.join("Default");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(root.join("Local State"), r#"{"profile":{"info_cache":{"Default":{"name":"Personal"}}}}"#).unwrap();
        std::fs::write(
            profile.join("Preferences"),
            format!(r#"{{"extensions":{{"settings":{{"{}":{{"disable_reasons":[]}}}}}}}}"#, browse_relay::protocol::UNPACKED_EXTENSION_ID),
        )
        .unwrap();

        let browser = Browser { name: "Google Chrome", user_data: root.clone(), launch: vec!["Google Chrome".into()] };
        let matches = detect(&[browser]);
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].extension_id, browse_relay::protocol::UNPACKED_EXTENSION_ID);
        assert_eq!(matches[0].profile, "Default");
        assert_eq!(matches[0].profile_name, "Personal");
        assert!(matches[0].enabled);
    }
}
