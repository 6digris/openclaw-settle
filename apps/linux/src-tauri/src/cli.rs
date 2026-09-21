use serde::de::DeserializeOwned;
use std::env;
use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

struct BundledRuntime {
    #[cfg(target_os = "linux")]
    source: PathBuf,
    directory: PathBuf,
    #[cfg(target_os = "linux")]
    version: String,
    prepared: Mutex<Option<PathBuf>>,
}

static BUNDLED_RUNTIME: OnceLock<BundledRuntime> = OnceLock::new();

#[cfg(target_os = "linux")]
pub(crate) fn configure_bundled_runtime(source: PathBuf, directory: PathBuf, version: String) {
    let _ = BUNDLED_RUNTIME.set(BundledRuntime {
        source,
        directory,
        version,
        prepared: Mutex::new(None),
    });
}

#[cfg(test)]
pub(crate) fn configure_bundled_fixture(executable: PathBuf, directory: PathBuf) {
    #[cfg(target_os = "linux")]
    {
        use sha2::{Digest, Sha256};
        let hash: String = Sha256::digest(std::fs::read(&executable).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        std::fs::write(
            executable.with_file_name("manifest.json"),
            serde_json::json!({"version":"0.1.0","sha256":hash}).to_string(),
        )
        .unwrap();
        configure_bundled_runtime(executable, directory, "0.1.0".into());
    }
    #[cfg(not(target_os = "linux"))]
    let _ = BUNDLED_RUNTIME.set(BundledRuntime {
        directory,
        prepared: Mutex::new(Some(executable)),
    });
}

impl BundledRuntime {
    fn executable(&self) -> Result<PathBuf, CliError> {
        let prepared = self.prepared.lock().map_err(|_| {
            CliError::Environment("Runtime preparation lock is unavailable.".into())
        })?;
        if let Some(executable) = prepared.as_ref() {
            return Ok(executable.clone());
        }
        #[cfg(target_os = "linux")]
        {
            let mut prepared = prepared;
            let executable =
                crate::bundled_runtime::prepare(&self.source, &self.directory, &self.version)
                    .map_err(CliError::Environment)?;
            *prepared = Some(executable.clone());
            Ok(executable)
        }
        #[cfg(not(target_os = "linux"))]
        Err(CliError::Missing)
    }
}

#[derive(Clone, Debug)]
pub struct OpenClawCli {
    executable: PathBuf,
    openclaw_home: PathBuf,
    available: Arc<AtomicBool>,
    runtime_directory: Option<PathBuf>,
}

#[derive(Debug)]
pub enum CliError {
    Missing,
    Environment(String),
    Spawn(String),
    CommandFailed(String),
    InvalidJson(String),
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => write!(formatter, "OpenClaw CLI not found"),
            Self::Environment(message)
            | Self::Spawn(message)
            | Self::CommandFailed(message)
            | Self::InvalidJson(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CliError {}

impl OpenClawCli {
    pub(crate) fn bundled_available() -> bool {
        BUNDLED_RUNTIME.get().is_some()
    }

    pub fn discover() -> Result<Self, CliError> {
        let cli = Self::locate()?;
        match cli.verify() {
            Ok(()) => Ok(cli),
            Err(_) if cli.executable == PathBuf::from("openclaw") => Err(CliError::Missing),
            Err(error) => Err(error),
        }
    }

    /// Resolve the executable for an owner that supplies cancellable process supervision.
    pub(crate) fn locate() -> Result<Self, CliError> {
        let home = openclaw_home()?;
        if let Some(override_path) = env::var_os("OPENCLAW_DESKTOP_CLI") {
            return Ok(Self::new(PathBuf::from(override_path), home));
        }

        let managed = home.join("bin/openclaw");
        if managed.is_file() {
            return Ok(Self::new(managed, home));
        }

        // Never replace an operator-managed CLI. The included runtime is the
        // offline fallback on machines without an existing installation.
        if let Some(runtime) = BUNDLED_RUNTIME.get() {
            if !path_cli_exists() {
                let mut cli = Self::new(runtime.executable()?, home);
                cli.runtime_directory = Some(runtime.directory.clone());
                return Ok(cli);
            }
        }
        Ok(Self::new(PathBuf::from("openclaw"), home))
    }

    fn new(executable: PathBuf, openclaw_home: PathBuf) -> Self {
        Self {
            executable,
            openclaw_home,
            available: Arc::new(AtomicBool::new(true)),
            runtime_directory: None,
        }
    }

    pub(crate) fn bundled_service_launcher(&self) -> Option<PathBuf> {
        self.runtime_directory
            .as_ref()
            .map(|directory| directory.join("openclaw-runtime"))
    }

    pub(crate) fn activate_bundled(&self) -> Result<(), CliError> {
        #[cfg(target_os = "linux")]
        if let Some(directory) = &self.runtime_directory {
            crate::bundled_runtime::activate(&self.executable, directory)
                .map_err(CliError::Environment)?;
        }
        Ok(())
    }

    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }

    pub(crate) fn verify(&self) -> Result<(), CliError> {
        let output = self.output(["--version"])?;
        if output.status.success() {
            self.activate_bundled()?;
            return Ok(());
        }
        Err(CliError::Spawn(format!(
            "OpenClaw CLI exited with {}",
            output.status
        )))
    }

    pub fn command<I, S>(&self, args: I) -> Result<Command, CliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = Command::new(&self.executable);
        command.args(args);
        command.env("PATH", self.command_path()?);
        if let Some(directory) = &self.runtime_directory {
            command.env("OPENCLAW_DESKTOP_RUNTIME_DIR", directory);
            // AppImage libraries must not override the selected Node ABI.
            command.env_remove("LD_LIBRARY_PATH");
        }
        command.stdin(Stdio::null());
        Ok(command)
    }

    pub fn output<I, S>(&self, args: I) -> Result<Output, CliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = self.command(args)?;
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = command.spawn().map_err(|error| {
            self.available.store(false, Ordering::Release);
            CliError::Spawn(format!("Failed to run OpenClaw CLI: {error}"))
        })?;
        child.wait_with_output().map_err(|error| {
            CliError::Spawn(format!("Failed to read OpenClaw CLI output: {error}"))
        })
    }

    pub fn json<T, I, S>(&self, args: I) -> Result<T, CliError>
    where
        T: DeserializeOwned,
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let output = self.output(args)?;
        // Failed commands own their stderr; parsing first would mislabel real
        // failures as missing CLI dashboard support.
        if !output.status.success() {
            let message = output_tail(&output.stderr)
                .or_else(|| output_tail(&output.stdout))
                .unwrap_or_else(|| format!("OpenClaw CLI exited with {}", output.status));
            return Err(CliError::CommandFailed(message));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            CliError::InvalidJson(format!("OpenClaw CLI returned invalid JSON: {error}"))
        })
    }

    fn command_path(&self) -> Result<OsString, CliError> {
        let mut paths = vec![
            self.openclaw_home.join("bin"),
            self.openclaw_home.join("tools/node/bin"),
        ];
        if let Some(current) = env::var_os("PATH") {
            paths.extend(env::split_paths(&current));
        }
        env::join_paths(paths)
            .map_err(|error| CliError::Environment(format!("Could not construct PATH: {error}")))
    }
}

fn path_cli_exists() -> bool {
    env::var_os("PATH").is_some_and(|value| {
        env::split_paths(&value).any(|directory| directory.join("openclaw").is_file())
    })
}

pub(crate) fn output_tail(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let mut lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    // Repeated progress lines carry no additional failure context.
    lines.dedup();
    let start = lines.len().saturating_sub(12);
    let tail = &lines[start..];
    (!tail.is_empty()).then(|| tail.join("\n"))
}

pub fn openclaw_home() -> Result<PathBuf, CliError> {
    #[cfg(target_os = "windows")]
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()));
    #[cfg(not(target_os = "windows"))]
    let home = env::var_os("HOME").filter(|value| !value.is_empty());
    let home = home.ok_or_else(|| CliError::Environment("HOME is not set".to_string()))?;
    Ok(PathBuf::from(home).join(".openclaw"))
}

#[cfg(test)]
mod tests {
    use super::{output_tail, OpenClawCli};
    use std::path::PathBuf;

    #[test]
    fn output_tail_keeps_the_last_twelve_nonempty_lines() {
        let output = (1..=15)
            .map(|line| format!("message {line}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let expected = (4..=15)
            .map(|line| format!("message {line}"))
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(output_tail(output.as_bytes()), Some(expected));
        assert_eq!(output_tail(b"\n  \n"), None);
        assert_eq!(
            output_tail(b"waiting\n\nwaiting\nfailed\nwaiting"),
            Some("waiting\nfailed\nwaiting".into())
        );
    }

    #[test]
    fn bundled_command_uses_private_runtime_without_changing_config_identity() {
        let mut cli = OpenClawCli::new(
            PathBuf::from("/app/runtime"),
            PathBuf::from("/home/test/.openclaw"),
        );
        cli.runtime_directory = Some(PathBuf::from("/home/test/.local/share/app/runtime"));
        let command = cli.command(["gateway", "status", "--json"]).unwrap();
        let environment: std::collections::HashMap<_, _> = command.get_envs().collect();
        assert_eq!(
            environment.get(std::ffi::OsStr::new("OPENCLAW_DESKTOP_RUNTIME_DIR")),
            Some(&Some(std::ffi::OsStr::new(
                "/home/test/.local/share/app/runtime"
            )))
        );
        assert_eq!(
            environment.get(std::ffi::OsStr::new("LD_LIBRARY_PATH")),
            Some(&None)
        );
        assert!(!environment.contains_key(std::ffi::OsStr::new("OPENCLAW_STATE_DIR")));
        assert!(!environment.contains_key(std::ffi::OsStr::new("OPENCLAW_CONFIG_PATH")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn failed_candidate_probe_keeps_the_previous_launcher_restartable() {
        use sha2::{Digest, Sha256};
        use std::fs;
        let root =
            std::env::temp_dir().join(format!("openclaw-cli-activation-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("resource");
        let base = root.join("runtime");
        let candidate = |body: &str| {
            fs::write(&source, body).unwrap();
            let hash: String = Sha256::digest(body.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            fs::write(
                root.join("manifest.json"),
                serde_json::json!({"version":"0.1.0","sha256":hash}).to_string(),
            )
            .unwrap();
            let executable = crate::bundled_runtime::prepare(&source, &base, "0.1.0").unwrap();
            let mut cli = OpenClawCli::new(executable, root.clone());
            cli.runtime_directory = Some(base.clone());
            cli
        };
        let good = candidate("#!/bin/sh\nprintf working\n");
        let stable = good.bundled_service_launcher().unwrap();
        assert!(!stable.exists());
        good.verify().unwrap();
        let previous = fs::read_link(&stable).unwrap();
        let failed = candidate("#!/bin/sh\nprintf 'fixture extraction failure\\n' >&2\nexit 1\n");
        assert_eq!(
            fs::read_link(&stable).unwrap(),
            previous,
            "staging changed the active launcher"
        );
        assert!(failed.verify().is_err());
        assert_eq!(fs::read_link(&stable).unwrap(), previous);
        assert_eq!(
            std::process::Command::new(&stable).output().unwrap().stdout,
            b"working"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_executable_invalidates_the_cached_cli() {
        let cli = OpenClawCli::new(
            PathBuf::from("openclaw-test-executable-that-does-not-exist"),
            PathBuf::new(),
        );

        assert!(cli.is_available());
        assert!(cli.output(["--version"]).is_err());
        assert!(!cli.is_available());
    }
}
