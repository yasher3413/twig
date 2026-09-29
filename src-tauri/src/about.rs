//! What a bug report may include about this Mac, if the reporter allows it:
//! the macOS version and the chip. Nothing that identifies the person.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct SystemInfo {
    macos: String,
    chip: String,
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[tauri::command]
pub fn system_info() -> SystemInfo {
    SystemInfo {
        macos: run("sw_vers", &["-productVersion"]).unwrap_or_else(|| "unknown".into()),
        // "Apple M3 Pro" where available, the architecture otherwise.
        chip: run("sysctl", &["-n", "machdep.cpu.brand_string"]).unwrap_or_else(|| std::env::consts::ARCH.into()),
    }
}
