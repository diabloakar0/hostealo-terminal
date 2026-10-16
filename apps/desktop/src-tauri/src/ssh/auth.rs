//! User authentication: password (with keyboard-interactive fallback), private key, SSH agent,
//! and a keyboard-interactive second factor when the server asks for one.

use std::sync::Arc;

use super::SecretSaver;
use super::prompts::{PromptField, PromptKind, PromptReply, Prompter};
use super::{ClientHandler, SshEvent};
use crate::hosts::{AuthMethod, Host};
use crate::secrets::{self, SecretKind};
use anyhow::{Context, Result, anyhow, bail};
use russh::MethodKind;
use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{self, PrivateKeyWithHashAlg};

const MAX_ATTEMPTS: usize = 3;

pub struct AuthContext<'a> {
    pub host: &'a Host,
    pub prompter: &'a Prompter,
    /// Stores a secret the user asked to remember.
    pub save_secret: &'a SecretSaver,
}

/// Error returned when the user dismisses a prompt; the session closes quietly.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cancelled")
    }
}

impl std::error::Error for Cancelled {}

pub async fn authenticate(handle: &mut Handle<ClientHandler>, ctx: &AuthContext<'_>) -> Result<()> {
    let user = ctx.host.username.as_str();
    let mut result = match &ctx.host.auth {
        AuthMethod::Password => password(handle, ctx).await?,
        AuthMethod::Key { key_path } => private_key(handle, ctx, key_path).await?,
        AuthMethod::Agent => agent(handle, user).await?,
    };

    // A server can accept the first method and still require a second one (typically an OTP).
    for _ in 0..MAX_ATTEMPTS {
        match result {
            AuthResult::Success => return Ok(()),
            AuthResult::Failure {
                partial_success: true,
                ref remaining_methods,
            } if remaining_methods.contains(&MethodKind::KeyboardInteractive) => {
                result = keyboard_interactive(handle, ctx, None).await?;
            }
            AuthResult::Failure {
                remaining_methods, ..
            } => {
                let methods: Vec<&str> = remaining_methods.iter().map(<&str>::from).collect();
                bail!(
                    "authentication failed (server accepts: {})",
                    methods.join(", ")
                );
            }
        }
    }
    bail!("authentication failed")
}

async fn password(handle: &mut Handle<ClientHandler>, ctx: &AuthContext<'_>) -> Result<AuthResult> {
    let host = ctx.host;
    let mut saved = if host.has_password {
        saved_secret(ctx, SecretKind::Password)
    } else {
        None
    };

    for attempt in 0..MAX_ATTEMPTS {
        let (password, remember) = match saved.take() {
            Some(password) => (password, false),
            None => ask_secret(ctx, PromptKind::Password, "Password:", attempt > 0).await?,
        };

        let mut result = handle
            .authenticate_password(&host.username, &password)
            .await?;
        if let AuthResult::Failure {
            ref remaining_methods,
            partial_success: false,
        } = result
        {
            // PAM-based servers often only offer keyboard-interactive; feed it the same password.
            if remaining_methods.contains(&MethodKind::KeyboardInteractive) {
                result = keyboard_interactive(handle, ctx, Some(&password)).await?;
            } else if !remaining_methods.contains(&MethodKind::Password) {
                return Ok(result);
            }
        }

        let accepted = matches!(
            result,
            AuthResult::Success
                | AuthResult::Failure {
                    partial_success: true,
                    ..
                }
        );
        if accepted {
            if remember {
                remember_secret(ctx, SecretKind::Password, &password);
            }
            return Ok(result);
        }
    }
    bail!("permission denied (wrong password)")
}

async fn private_key(
    handle: &mut Handle<ClientHandler>,
    ctx: &AuthContext<'_>,
    key_path: &str,
) -> Result<AuthResult> {
    let host = ctx.host;
    let path = expand_home(key_path);
    let mut passphrase = if host.has_passphrase {
        saved_secret(ctx, SecretKind::Passphrase)
    } else {
        None
    };
    let mut remember = false;
    let mut attempts = 0;

    let key = loop {
        match keys::load_secret_key(&path, passphrase.as_deref()) {
            Ok(key) => break key,
            Err(keys::Error::IO(e)) => {
                return Err(e).with_context(|| format!("could not read key {}", path.display()));
            }
            // Encrypted key and no passphrase yet, or the passphrase we tried was wrong.
            Err(e) if matches!(e, keys::Error::KeyIsEncrypted) || passphrase.is_some() => {
                if attempts == MAX_ATTEMPTS {
                    bail!("wrong passphrase for key {}", path.display());
                }
                let (value, keep) = ask_secret(
                    ctx,
                    PromptKind::Passphrase,
                    "Key passphrase:",
                    passphrase.is_some(),
                )
                .await?;
                passphrase = Some(value);
                remember = keep;
                attempts += 1;
            }
            Err(e) => {
                return Err(e).with_context(|| format!("could not load key {}", path.display()));
            }
        }
    };

    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let result = handle
        .authenticate_publickey(
            &host.username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await?;
    if remember
        && !matches!(
            result,
            AuthResult::Failure {
                partial_success: false,
                ..
            }
        )
        && let Some(passphrase) = &passphrase
    {
        remember_secret(ctx, SecretKind::Passphrase, passphrase);
    }
    Ok(result)
}

async fn agent(handle: &mut Handle<ClientHandler>, user: &str) -> Result<AuthResult> {
    #[cfg(unix)]
    {
        let client = keys::agent::client::AgentClient::connect_env()
            .await
            .context("no SSH agent found (SSH_AUTH_SOCK is not set)")?;
        agent_with(handle, user, client).await
    }
    #[cfg(windows)]
    {
        if let Ok(client) =
            keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
                .await
        {
            return agent_with(handle, user, client).await;
        }
        let client = keys::agent::client::AgentClient::connect_pageant()
            .await
            .context("no SSH agent found (OpenSSH agent or Pageant)")?;
        agent_with(handle, user, client).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (handle, user);
        bail!("SSH agent is not supported on this platform")
    }
}

async fn agent_with<R>(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    mut client: keys::agent::client::AgentClient<R>,
) -> Result<AuthResult>
where
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let identities = client.request_identities().await?;
    if identities.is_empty() {
        bail!("the SSH agent has no keys loaded");
    }
    let mut last = None;
    for identity in identities {
        let keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        let result = handle
            .authenticate_publickey_with(user, key, hash, &mut client)
            .await?;
        if !matches!(
            result,
            AuthResult::Failure {
                partial_success: false,
                ..
            }
        ) {
            return Ok(result);
        }
        last = Some(result);
    }
    last.ok_or_else(|| anyhow!("no usable key in the SSH agent"))
}

async fn keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    ctx: &AuthContext<'_>,
    password: Option<&str>,
) -> Result<AuthResult> {
    let mut password = password;
    let mut response = handle
        .authenticate_keyboard_interactive_start(&ctx.host.username, None::<String>)
        .await?;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(AuthResult::Success),
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods,
                partial_success,
            } => {
                return Ok(AuthResult::Failure {
                    remaining_methods,
                    partial_success,
                });
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if let Some(pw) = password.take()
                    && prompts.len() == 1
                    && !prompts[0].echo
                    && prompts[0].prompt.to_lowercase().contains("password")
                {
                    vec![pw.to_string()]
                } else {
                    let fields: Vec<PromptField> = prompts
                        .into_iter()
                        .map(|p| PromptField {
                            prompt: p.prompt,
                            echo: p.echo,
                        })
                        .collect();
                    let reply = ctx
                        .prompter
                        .ask(|request_id| SshEvent::Prompt {
                            request_id,
                            kind: PromptKind::KeyboardInteractive,
                            name,
                            instructions,
                            prompts: fields,
                            can_remember: false,
                            retry: false,
                        })
                        .await;
                    match reply {
                        PromptReply::Answers { answers, .. } => answers,
                        _ => return Err(Cancelled.into()),
                    }
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
}

/// Asks for a single secret. Returns the value and whether the user wants it remembered.
async fn ask_secret(
    ctx: &AuthContext<'_>,
    kind: PromptKind,
    label: &str,
    retry: bool,
) -> Result<(String, bool)> {
    let reply = ctx
        .prompter
        .ask(|request_id| SshEvent::Prompt {
            request_id,
            kind,
            name: String::new(),
            instructions: String::new(),
            prompts: vec![PromptField {
                prompt: label.to_string(),
                echo: false,
            }],
            can_remember: true,
            retry,
        })
        .await;
    match reply {
        PromptReply::Answers {
            mut answers,
            remember,
        } if !answers.is_empty() => Ok((answers.swap_remove(0), remember)),
        _ => Err(Cancelled.into()),
    }
}

/// The saved secret, if the keychain gives it. When it refuses (access denied, keychain locked),
/// the user is asked instead of the login failing.
fn saved_secret(ctx: &AuthContext<'_>, kind: SecretKind) -> Option<String> {
    match secrets::get(&ctx.host.id, kind) {
        Ok(value) => value,
        Err(error) => {
            ctx.prompter.notify(SshEvent::Banner {
                message: format!("{error}. Asking instead."),
            });
            None
        }
    }
}

/// Best effort: a keychain failure must not abort a login that already succeeded.
fn remember_secret(ctx: &AuthContext<'_>, kind: SecretKind, value: &str) {
    if let Err(error) = (ctx.save_secret)(kind, value) {
        ctx.prompter.notify(SshEvent::Banner {
            message: format!("Could not save the secret: {error}"),
        });
    }
}

fn expand_home(path: &str) -> std::path::PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    match (
        path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")),
        home,
    ) {
        (Some(rest), Some(home)) => std::path::Path::new(&home).join(rest),
        _ => path.into(),
    }
}
