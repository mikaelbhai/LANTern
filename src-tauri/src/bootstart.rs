//! LANTern before anybody signs in.
//!
//! Wake-on-LAN powers the machine on, and then it sits at the Windows sign-in
//! screen: "start at login" only fires after the PIN, so nothing of LANTern runs
//! and the library that was just woken for stays dark. The window cannot run
//! there - WebView2 needs a signed-in session - but the file server can, because
//! it is a plain process (`lantern-host`).
//!
//! So this registers that process as a Scheduled Task at start-up, under the
//! SYSTEM account, which needs no password and no session. It announces the same
//! device id as the app with `mode=host`, so other devices list the library
//! without trying to open a link nobody is there to answer. When somebody does
//! sign in and the app starts, the app asks it to hand over (see
//! `hosting::handover`) and takes the port.
//!
//! Registering a task is an administrative act, so it goes through one UAC
//! prompt, the way changing a network's category does. Nothing here signs
//! anybody in or stores a credential.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mdns_sd::ServiceDaemon;

/// What the task and its firewall rule are called, in Task Scheduler and in the
/// firewall list. Named for what it does, so somebody who finds it there knows
/// whether to delete it.
pub const TASK_NAME: &str = "LANTern background host";

/// Quotes text for a PowerShell single-quoted string.
///
/// Everything in the script is a literal, so nothing is evaluated: the only
/// character that can end the string is the quote itself, which is doubled. A
/// control character has no business in a path or a name and is refused rather
/// than passed along to a shell.
pub(crate) fn ps_quote(text: &str) -> Result<String, String> {
    if text.chars().any(|c| c.is_control()) {
        return Err("that contains a character that cannot be passed on safely".into());
    }
    Ok(format!("'{}'", text.replace('\'', "''")))
}

/// What goes on the host's command line. A name or path with a `"` in it would
/// end the quoting early, and no real path or machine name has one.
fn arg_text(text: &str) -> Result<String, String> {
    if text.contains('"') {
        return Err("that contains a quotation mark".into());
    }
    Ok(format!("\"{text}\""))
}

/// The script that creates the task and opens the firewall for it.
///
/// Pure, so it can be checked without a Windows machine or a UAC prompt.
pub fn register_script(
    exe: &Path,
    data_dir: &Path,
    port: u16,
    device_name: &str,
    who: &str,
) -> Result<String, String> {
    let exe_text = exe.to_str().ok_or("the host program's path is not text")?;
    let dir_text = data_dir.to_str().ok_or("the data folder's path is not text")?;
    let mut arguments = format!(
        "--data-dir {} --port {port} --name {} --announce",
        arg_text(dir_text)?,
        arg_text(&device_name.replace('"', ""))?,
    );
    let who = who.replace('"', "");
    if !who.trim().is_empty() {
        arguments.push_str(&format!(" --who {}", arg_text(who.trim())?));
    }

    Ok(format!(
        "$ErrorActionPreference='Stop'; \
         $exe = {exe}; \
         $action = New-ScheduledTaskAction -Execute $exe -Argument {arguments}; \
         $trigger = New-ScheduledTaskTrigger -AtStartup; \
         $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; \
         $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \
           -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) \
           -ExecutionTimeLimit ([TimeSpan]::Zero); \
         Register-ScheduledTask -TaskName {task} -Action $action -Trigger $trigger -Principal $principal \
           -Settings $settings -Force | Out-Null; \
         Get-NetFirewallRule -DisplayName {task} -ErrorAction SilentlyContinue | Remove-NetFirewallRule; \
         New-NetFirewallRule -DisplayName {task} -Direction Inbound -Program $exe -Action Allow \
           -Profile Private,Domain | Out-Null; \
         exit 0",
        exe = ps_quote(exe_text)?,
        arguments = ps_quote(&arguments)?,
        task = ps_quote(TASK_NAME)?,
    ))
}

/// The script that undoes it: stops a running host, removes the task and the rule.
pub fn unregister_script() -> Result<String, String> {
    Ok(format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         Stop-ScheduledTask -TaskName {task}; \
         Unregister-ScheduledTask -TaskName {task} -Confirm:$false; \
         Get-NetFirewallRule -DisplayName {task} | Remove-NetFirewallRule; \
         exit 0",
        task = ps_quote(TASK_NAME)?,
    ))
}

/// Whether the task exists. Anybody may ask, so this needs no prompt.
#[cfg(windows)]
pub fn registered() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("schtasks")
        .args(["/Query", "/TN", TASK_NAME])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn registered() -> bool {
    false
}

/// Registers or removes the task, through one elevation prompt.
#[cfg(windows)]
pub fn set(
    enabled: bool,
    exe: &Path,
    data_dir: &Path,
    port: u16,
    device_name: &str,
    who: &str,
) -> Result<(), String> {
    let script = if enabled {
        register_script(exe, data_dir, port, device_name, who)?
    } else {
        unregister_script()?
    };
    crate::wol::run_elevated(&script)?;
    if registered() != enabled {
        return Err("Windows did not keep the change".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set(
    _enabled: bool,
    _exe: &Path,
    _data_dir: &Path,
    _port: u16,
    _device_name: &str,
    _who: &str,
) -> Result<(), String> {
    Err("Only Windows can start a program before anybody signs in from here.".into())
}

/// Asks a running `lantern-host` on this machine to exit, so the app can take
/// its port.
///
/// `taskkill` cannot do it: the host runs as SYSTEM, and an ordinary user is
/// refused. Returns whether anything answered. Plain HTTP over a raw socket -
/// nothing here is worth an HTTP client, and it is only ever loopback.
pub fn ask_host_to_leave(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(800)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /host/handover HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply);
    reply.starts_with("HTTP/1.0 200") || reply.starts_with("HTTP/1.1 200")
}

/// This device's announcement while no app is running. Dropping it withdraws
/// the service, so peers stop listing the library the moment the host leaves
/// instead of when their cache runs out.
pub struct Announcement {
    daemon: ServiceDaemon,
    instance: String,
    stop: Arc<AtomicBool>,
}

impl Drop for Announcement {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        crate::discovery::withdraw(&self.daemon, &self.instance);
        let _ = self.daemon.shutdown();
    }
}

/// Announces this device as hosting-only and keeps the announcement right as
/// the network changes.
///
/// At boot the network is often not up yet, and a laptop moves between them;
/// both look like a different set of addresses, so it is checked every few
/// seconds and re-announced when it differs.
pub fn announce(data_dir: &Path, instance: &str, who: &str, port: u16) -> anyhow::Result<Announcement> {
    let device_id = crate::identity::load_or_create(data_dir);
    let daemon = ServiceDaemon::new()?;
    let addresses = current_addresses();
    crate::discovery::register_host(&daemon, &device_id, instance, who, &addresses, port)?;

    let stop = Arc::new(AtomicBool::new(false));
    {
        let (daemon, stop) = (daemon.clone(), stop.clone());
        let (instance, who) = (instance.to_string(), who.to_string());
        std::thread::spawn(move || {
            let mut announced = addresses;
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(10));
                let now = current_addresses();
                if now != announced && !now.is_empty() {
                    crate::discovery::withdraw(&daemon, &instance);
                    if let Err(e) =
                        crate::discovery::register_host(&daemon, &device_id, &instance, &who, &now, port)
                    {
                        eprintln!("could not re-announce after a network change: {e}");
                    }
                    announced = now;
                }
            }
        });
    }
    Ok(Announcement { daemon, instance: instance.to_string(), stop })
}

fn current_addresses() -> Vec<String> {
    let mut ips: Vec<String> = crate::net::interfaces().into_iter().map(|i| i.ip).collect();
    ips.sort();
    ips
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script() -> String {
        register_script(
            Path::new(r"C:\Program Files\LANTern\lantern-host.exe"),
            Path::new(r"C:\Users\Mikael\AppData\Roaming\com.lantern.app"),
            7981,
            "MIKAEL",
            "Mikael",
        )
        .unwrap()
    }

    #[test]
    fn the_task_starts_at_boot_as_system_and_is_never_timed_out() {
        let s = script();
        assert!(s.contains("New-ScheduledTaskTrigger -AtStartup"));
        assert!(s.contains("-UserId 'SYSTEM' -LogonType ServiceAccount"));
        // The default limit is 72 hours, after which Windows would kill a
        // host that was doing exactly its job.
        assert!(s.contains("-ExecutionTimeLimit ([TimeSpan]::Zero)"));
        assert!(s.contains("-RestartCount"));
    }

    #[test]
    fn the_host_is_told_where_the_data_is_and_to_announce() {
        let s = script();
        assert!(s.contains(r#"--data-dir "C:\Users\Mikael\AppData\Roaming\com.lantern.app""#));
        assert!(s.contains("--port 7981"));
        assert!(s.contains("--announce"));
        assert!(s.contains(r#"--who "Mikael""#));
    }

    #[test]
    fn the_firewall_is_opened_for_that_program_on_home_and_work_networks_only() {
        let s = script();
        assert!(s.contains("New-NetFirewallRule"));
        assert!(s.contains("-Direction Inbound"));
        assert!(s.contains("-Profile Private,Domain"));
        assert!(!s.contains("Public"));
    }

    #[test]
    fn a_quote_in_a_path_cannot_end_the_string_early() {
        let s = register_script(
            Path::new(r"C:\Users\O'Brien\lantern-host.exe"),
            Path::new(r"C:\Users\O'Brien\data"),
            7981,
            "Pat's PC",
            "",
        )
        .unwrap();
        assert!(s.contains(r"$exe = 'C:\Users\O''Brien\lantern-host.exe'"));
        assert!(s.contains("O''Brien\\data"));
        assert!(s.contains("Pat''s PC"));
    }

    #[test]
    fn a_name_cannot_smuggle_in_a_second_command() {
        let s = register_script(
            Path::new(r"C:\lantern-host.exe"),
            Path::new(r"C:\data"),
            7981,
            r#"x" --port 1 "#,
            "",
        )
        .unwrap();
        // The quote is dropped, so the text stays one argument.
        assert!(s.contains(r#"--name "x --port 1 ""#));
        assert!(register_script(Path::new("a\nb"), Path::new("c"), 7981, "n", "").is_err());
    }

    #[test]
    fn removing_it_takes_the_rule_and_the_task() {
        let s = unregister_script().unwrap();
        assert!(s.contains("Unregister-ScheduledTask"));
        assert!(s.contains("Remove-NetFirewallRule"));
        assert!(s.contains("Stop-ScheduledTask"));
    }

    #[test]
    fn nothing_listening_means_nobody_to_ask() {
        // A port nothing holds: the app starting with no host running must not
        // wait on a reply that is never coming.
        assert!(!ask_host_to_leave(1));
    }
}
