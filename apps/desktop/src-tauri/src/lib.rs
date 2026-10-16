mod ai;
mod device_auth;
mod exec;
mod ftp;
mod hostealo;
mod hosts;
mod importer;
mod known_hosts_admin;
mod local_fs;
mod monitor;
#[cfg(desktop)]
mod pty;
mod rdp;
mod rdp_clipboard;
mod rdp_drive;
mod secrets;
mod ssh;
mod ssh_keys;
mod sync;
mod tls;

use std::sync::{Arc, Mutex};

/// Commands available on every platform, plus the platform-specific ones passed in.
macro_rules! handler {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            monitor::monitor_local,
            hosts::hosts_list,
            hosts::hosts_save,
            hosts::hosts_delete,
            hosts::hosts_set_os,
            hosts::hosts_reveal_secret,
            hosts::snippets_save,
            hosts::snippets_delete,
            hostealo::hostealo_account,
            hostealo::hostealo_connect,
            hostealo::hostealo_disconnect,
            hostealo::hostealo_sync,
            hostealo::hostealo_status,
            hostealo::hostealo_power,
            hostealo::hostealo_reset_password,
            importer::import_detect,
            importer::import_read,
            importer::import_apply,
            hosts::folders_create,
            hosts::folders_rename,
            hosts::folders_delete,
            known_hosts_admin::known_hosts_list,
            known_hosts_admin::known_hosts_remove,
            known_hosts_admin::known_hosts_forget,
            ssh_keys::ssh_keys_list,
            ssh_keys::ssh_keys_generate,
            ssh_keys::ssh_keys_delete,
            ssh_keys::ssh_keys_default_comment,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_exec,
            exec::local_exec,
            local_fs::local_home,
            local_fs::local_list,
            local_fs::local_mkdir,
            local_fs::local_rename,
            local_fs::local_delete,
            sync::sync_listen,
            sync::sync_browse,
            sync::sync_connect,
            sync::sync_confirm,
            sync::sync_cancel,
            sync::sync_export,
            sync::sync_import,
            ssh::ssh_resize,
            ssh::ssh_close,
            ssh::ssh_close_all,
            ssh::ssh_prompt_reply,
            ssh::remote::remote_open,
            ssh::remote::remote_exec,
            ssh::remote::remote_close,
            ssh::sftp::sftp_open,
            ssh::sftp::sftp_close,
            ssh::sftp::sftp_realpath,
            ssh::sftp::sftp_list,
            ssh::sftp::sftp_mkdir,
            ssh::sftp::sftp_rename,
            ssh::sftp::sftp_delete,
            ssh::sftp::sftp_download,
            ssh::sftp::sftp_upload,
            ssh::sftp::sftp_cancel_transfer,
            ftp::ftp_open,
            ftp::ftp_close,
            ftp::ftp_realpath,
            ftp::ftp_list,
            ftp::ftp_mkdir,
            ftp::ftp_rename,
            ftp::ftp_delete,
            ftp::ftp_download,
            ftp::ftp_upload,
            ftp::ftp_cancel_transfer,
            rdp::rdp_connect,
            rdp::rdp_input,
            rdp::rdp_resize,
            rdp::rdp_clipboard_sync,
            rdp::rdp_clipboard_save,
            rdp::rdp_clipboard_cancel,
            rdp::rdp_close,
            ai::ai_settings_get,
            ai::ai_settings_save,
            ai::ai_models,
            ai::ai_chat,
            ai::ai_cancel,
            $($extra),*
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Mutex::new(monitor::LocalMonitor::new()))
        .manage(hosts::HostStore::default())
        .manage(ssh::SshState::default())
        .manage(ssh::sftp::SftpState::default())
        .manage(ssh::remote::RemoteState::default())
        .manage(ftp::FtpState::default())
        .manage(rdp::RdpState::default())
        .manage(ai::AiState::default())
        .manage(importer::ImportState::default())
        .manage(sync::SyncState::default())
        .manage(Arc::new(ssh::PromptRegistry::default()));

    // A local shell is desktop-only.
    #[cfg(desktop)]
    let builder = builder
        .manage(pty::PtyState::default())
        .invoke_handler(handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
        ]);

    #[cfg(mobile)]
    let builder = builder.invoke_handler(handler![]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running Hostealo Terminal");
}
