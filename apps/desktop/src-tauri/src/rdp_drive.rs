//! A local folder shared with the remote desktop as a drive (RDP drive redirection, MS-RDPEFS).
//!
//! Windows shows it as "Hostealo on <computer>" in This PC, so files can be copied both ways
//! with Explorer. The server sends file system requests (open, read, write, list, rename,
//! delete...) and this backend serves them from the shared folder.
//!
//! Security: the remote side only ever sees the shared folder. Every path is resolved inside it,
//! `..` components are refused, and paths that leave the folder through symlinks are refused.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use ironrdp::core::impl_as_any;
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::backend::RdpdrBackend;
use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp::rdpdr::pdu::efs::{
    Boolean, ClientDriveQueryDirectoryResponse, ClientDriveQueryInformationResponse,
    ClientDriveQueryVolumeInformationResponse, ClientDriveSetInformationResponse,
    CreateDisposition, CreateOptions, DeviceCloseRequest, DeviceCloseResponse,
    DeviceControlRequest, DeviceControlResponse, DeviceCreateRequest, DeviceCreateResponse,
    DeviceIoResponse, DeviceReadRequest, DeviceReadResponse, DeviceWriteRequest,
    DeviceWriteResponse, FileAttributeTagInformation, FileAttributes, FileBasicInformation,
    FileBothDirectoryInformation, FileDirectoryInformation, FileFsAttributeInformation,
    FileFsDeviceInformation, FileFsFullSizeInformation, FileFsSizeInformation,
    FileFsVolumeInformation, FileFullDirectoryInformation, FileInformationClass,
    FileInformationClassLevel, FileNamesInformation, FileStandardInformation, FileSystemAttributes,
    FileSystemInformationClass, FileSystemInformationClassLevel, Information, NtStatus,
    ServerDeviceAnnounceResponse, ServerDriveIoRequest, ServerDriveQueryDirectoryRequest,
    ServerDriveQueryInformationRequest, ServerDriveQueryVolumeInformationRequest,
    ServerDriveSetInformationRequest,
};
use ironrdp::rdpdr::pdu::esc::{ScardCall, ScardIoCtlCode};
use ironrdp::svc::SvcMessage;

/// Device id of the shared drive (any value; one drive per session).
pub const DRIVE_ID: u32 = 1;
/// Drive name shown in Windows ("Hostealo on MacBook").
pub const DRIVE_NAME: &str = "Hostealo";

const STATUS_OBJECT_NAME_NOT_FOUND: u32 = 0xC000_0034;
const STATUS_FILE_IS_A_DIRECTORY: u32 = 0xC000_00BA;
const FILE_CREATED: u8 = 0x02;
const FILE_DEVICE_DISK: u32 = 0x07;
/// Seconds between 1601-01-01 (Windows FILETIME epoch) and 1970-01-01.
const FILETIME_UNIX_OFFSET: u64 = 11_644_473_600;

fn status(code: u32) -> NtStatus {
    NtStatus::from(code)
}

/// Windows FILETIME: 100 ns intervals since 1601.
fn filetime(time: std::io::Result<SystemTime>) -> i64 {
    let Ok(since_unix) = time.unwrap_or(UNIX_EPOCH).duration_since(UNIX_EPOCH) else {
        return 0;
    };
    let ticks = (since_unix.as_secs() + FILETIME_UNIX_OFFSET) * 10_000_000
        + u64::from(since_unix.subsec_nanos() / 100);
    i64::try_from(ticks).unwrap_or(i64::MAX)
}

fn attributes(metadata: &fs::Metadata, name: &str) -> FileAttributes {
    let mut attributes = if metadata.is_dir() {
        FileAttributes::FILE_ATTRIBUTE_DIRECTORY
    } else {
        FileAttributes::FILE_ATTRIBUTE_ARCHIVE
    };
    if metadata.permissions().readonly() {
        attributes |= FileAttributes::FILE_ATTRIBUTE_READONLY;
    }
    if name.starts_with('.') && name != "." && name != ".." {
        attributes |= FileAttributes::FILE_ATTRIBUTE_HIDDEN;
    }
    attributes
}

/// `*` and `?` wildcard match, case-insensitive like Windows.
fn wildcard_match(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a.to_lowercase().eq(b.to_lowercase()) && go(&p[1..], &n[1..]),
            _ => false,
        }
    }
    let (p, n): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    go(&p, &n)
}

struct DirEntry {
    name: String,
    metadata: fs::Metadata,
}

struct OpenEntry {
    path: PathBuf,
    file: Option<File>,
    delete_on_close: bool,
    /// Remaining results of a directory query in progress.
    listing: Option<std::vec::IntoIter<DirEntry>>,
}

/// Serves drive requests from one local folder.
pub struct DriveBackend {
    root: PathBuf,
    open: HashMap<u32, OpenEntry>,
    next_file_id: u32,
}

impl core::fmt::Debug for DriveBackend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DriveBackend")
            .field("root", &self.root)
            .finish()
    }
}

impl_as_any!(DriveBackend);

impl DriveBackend {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            open: HashMap::new(),
            next_file_id: 1,
        }
    }

    /// `\dir\file.txt` from the server → a path inside the shared folder, or `None` if it would
    /// leave it.
    fn resolve(&self, remote: &str) -> Option<PathBuf> {
        let mut path = self.root.clone();
        for part in remote.split(['\\', '/']).filter(|p| !p.is_empty()) {
            match Path::new(part).components().next() {
                Some(Component::Normal(_)) if !part.contains(':') => path.push(part),
                _ => return None,
            }
        }
        // Symlinks inside the folder must not lead out of it.
        let root = self.root.canonicalize().ok()?;
        let existing = path.ancestors().find(|p| p.exists())?;
        existing
            .canonicalize()
            .ok()?
            .starts_with(&root)
            .then_some(path)
    }

    fn create(&mut self, req: DeviceCreateRequest) -> DeviceCreateResponse {
        let io = req.device_io_request.clone();
        let reply =
            |status_code: NtStatus, file_id: u32, information: Information| DeviceCreateResponse {
                device_io_reply: DeviceIoResponse::new(io.clone(), status_code),
                file_id,
                information,
            };
        let Some(path) = self.resolve(&req.path) else {
            return reply(NtStatus::ACCESS_DENIED, 0, Information::empty());
        };

        let wants_dir = req
            .create_options
            .contains(CreateOptions::FILE_DIRECTORY_FILE);
        let wants_file = req
            .create_options
            .contains(CreateOptions::FILE_NON_DIRECTORY_FILE);
        let disposition = req.create_disposition;
        let exists = path.exists();
        let is_dir = path.is_dir();

        if exists && is_dir && wants_file {
            return reply(status(STATUS_FILE_IS_A_DIRECTORY), 0, Information::empty());
        }
        if exists && !is_dir && wants_dir {
            return reply(NtStatus::NOT_A_DIRECTORY, 0, Information::empty());
        }
        let must_exist = disposition == CreateDisposition::FILE_OPEN
            || disposition == CreateDisposition::FILE_OVERWRITE;
        if !exists && must_exist {
            return reply(
                status(STATUS_OBJECT_NAME_NOT_FOUND),
                0,
                Information::empty(),
            );
        }
        if exists && disposition == CreateDisposition::FILE_CREATE {
            return reply(NtStatus::OBJECT_NAME_COLLISION, 0, Information::empty());
        }

        let result: std::io::Result<(Option<File>, Information)> = (|| {
            if (exists && is_dir) || (!exists && wants_dir) {
                if !exists {
                    fs::create_dir(&path)?;
                    return Ok((None, Information::from_bits_retain(FILE_CREATED)));
                }
                return Ok((None, Information::FILE_OPENED));
            }
            let truncate = exists
                && (disposition == CreateDisposition::FILE_SUPERSEDE
                    || disposition == CreateDisposition::FILE_OVERWRITE
                    || disposition == CreateDisposition::FILE_OVERWRITE_IF);
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(!exists)
                .truncate(truncate)
                .open(&path)
                // Read-only files can still be opened for reading.
                .or_else(|_| File::open(&path))?;
            let information = match (exists, truncate) {
                (false, _) => Information::from_bits_retain(FILE_CREATED),
                (true, true) => Information::FILE_OVERWRITTEN,
                (true, false) => Information::FILE_OPENED,
            };
            Ok((Some(file), information))
        })();

        match result {
            Ok((file, information)) => {
                let file_id = self.next_file_id;
                self.next_file_id = self.next_file_id.wrapping_add(1).max(1);
                let delete_on_close = req
                    .create_options
                    .contains(CreateOptions::FILE_DELETE_ON_CLOSE);
                self.open.insert(
                    file_id,
                    OpenEntry {
                        path,
                        file,
                        delete_on_close,
                        listing: None,
                    },
                );
                reply(NtStatus::SUCCESS, file_id, information)
            }
            Err(_) => reply(NtStatus::ACCESS_DENIED, 0, Information::empty()),
        }
    }

    fn close(&mut self, req: DeviceCloseRequest) -> DeviceCloseResponse {
        let io = req.device_io_request;
        if let Some(entry) = self.open.remove(&io.file_id)
            && entry.delete_on_close
        {
            drop(entry.file);
            let _ = if entry.path.is_dir() {
                fs::remove_dir(&entry.path)
            } else {
                fs::remove_file(&entry.path)
            };
        }
        DeviceCloseResponse {
            device_io_response: DeviceIoResponse::new(io, NtStatus::SUCCESS),
        }
    }

    fn read(&mut self, req: DeviceReadRequest) -> DeviceReadResponse {
        let io = req.device_io_request.clone();
        let result = (|| {
            let file = self.open.get_mut(&io.file_id)?.file.as_mut()?;
            file.seek(SeekFrom::Start(req.offset)).ok()?;
            let mut data = Vec::new();
            file.take(u64::from(req.length))
                .read_to_end(&mut data)
                .ok()?;
            Some(data)
        })();
        match result {
            Some(read_data) => DeviceReadResponse {
                device_io_reply: DeviceIoResponse::new(io, NtStatus::SUCCESS),
                read_data,
            },
            None => DeviceReadResponse {
                device_io_reply: DeviceIoResponse::new(io, NtStatus::UNSUCCESSFUL),
                read_data: Vec::new(),
            },
        }
    }

    fn write(&mut self, req: DeviceWriteRequest) -> DeviceWriteResponse {
        let io = req.device_io_request.clone();
        let result = (|| {
            let file = self.open.get_mut(&io.file_id)?.file.as_mut()?;
            file.seek(SeekFrom::Start(req.offset)).ok()?;
            file.write_all(&req.write_data).ok()?;
            Some(req.write_data.len())
        })();
        match result {
            Some(length) => DeviceWriteResponse {
                device_io_reply: DeviceIoResponse::new(io, NtStatus::SUCCESS),
                length: u32::try_from(length).unwrap_or(u32::MAX),
            },
            None => DeviceWriteResponse {
                device_io_reply: DeviceIoResponse::new(io, NtStatus::ACCESS_DENIED),
                length: 0,
            },
        }
    }

    fn query_information(
        &mut self,
        req: ServerDriveQueryInformationRequest,
    ) -> ClientDriveQueryInformationResponse {
        let io = req.device_io_request.clone();
        let respond = |io_status, buffer| ClientDriveQueryInformationResponse {
            device_io_response: DeviceIoResponse::new(io.clone(), io_status),
            buffer,
        };
        let Some(entry) = self.open.get(&io.file_id) else {
            return respond(NtStatus::UNSUCCESSFUL, None);
        };
        let Ok(metadata) = fs::metadata(&entry.path) else {
            return respond(status(STATUS_OBJECT_NAME_NOT_FOUND), None);
        };
        let name = entry
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let attrs = attributes(&metadata, &name);
        let size = i64::try_from(metadata.len()).unwrap_or(i64::MAX);
        let buffer = match req.file_info_class_lvl {
            level if level == FileInformationClassLevel::FILE_BASIC_INFORMATION => {
                FileInformationClass::Basic(FileBasicInformation {
                    creation_time: filetime(metadata.created()),
                    last_access_time: filetime(metadata.accessed()),
                    last_write_time: filetime(metadata.modified()),
                    change_time: filetime(metadata.modified()),
                    file_attributes: attrs,
                })
            }
            level if level == FileInformationClassLevel::FILE_STANDARD_INFORMATION => {
                FileInformationClass::Standard(FileStandardInformation {
                    allocation_size: size,
                    end_of_file: size,
                    number_of_links: 1,
                    delete_pending: if entry.delete_on_close {
                        Boolean::True
                    } else {
                        Boolean::False
                    },
                    directory: if metadata.is_dir() {
                        Boolean::True
                    } else {
                        Boolean::False
                    },
                })
            }
            level if level == FileInformationClassLevel::FILE_ATTRIBUTE_TAG_INFORMATION => {
                FileInformationClass::AttributeTag(FileAttributeTagInformation {
                    file_attributes: attrs,
                    reparse_tag: 0,
                })
            }
            _ => return respond(NtStatus::NOT_SUPPORTED, None),
        };
        respond(NtStatus::SUCCESS, Some(buffer))
    }

    fn query_directory(
        &mut self,
        req: ServerDriveQueryDirectoryRequest,
    ) -> ClientDriveQueryDirectoryResponse {
        let io = req.device_io_request.clone();
        let respond = |io_status, buffer| ClientDriveQueryDirectoryResponse {
            device_io_reply: DeviceIoResponse::new(io.clone(), io_status),
            buffer,
        };
        if req.initial_query != 0 {
            // The path is `\dir\pattern`; the directory is the open handle's.
            let pattern = req
                .path
                .rsplit(['\\', '/'])
                .next()
                .filter(|p| !p.is_empty())
                .unwrap_or("*")
                .to_string();
            let Some(entry) = self.open.get_mut(&io.file_id) else {
                return respond(NtStatus::UNSUCCESSFUL, None);
            };
            let Ok(read_dir) = fs::read_dir(&entry.path) else {
                return respond(NtStatus::NO_MORE_FILES, None);
            };
            let mut listing = Vec::new();
            for special in [".", ".."] {
                if wildcard_match(&pattern, special)
                    && let Ok(metadata) = fs::metadata(&entry.path)
                {
                    listing.push(DirEntry {
                        name: special.to_string(),
                        metadata,
                    });
                }
            }
            for item in read_dir.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                if wildcard_match(&pattern, &name)
                    && let Ok(metadata) = item.metadata()
                {
                    listing.push(DirEntry { name, metadata });
                }
            }
            entry.listing = Some(listing.into_iter());
        }
        let Some(next) = self
            .open
            .get_mut(&io.file_id)
            .and_then(|e| e.listing.as_mut())
            .and_then(Iterator::next)
        else {
            return respond(NtStatus::NO_MORE_FILES, None);
        };

        let m = &next.metadata;
        let (created, accessed, written) = (
            filetime(m.created()),
            filetime(m.accessed()),
            filetime(m.modified()),
        );
        let size = if m.is_dir() {
            0
        } else {
            i64::try_from(m.len()).unwrap_or(i64::MAX)
        };
        let attrs = attributes(m, &next.name);
        let level = req.file_info_class_lvl;
        let buffer = if level == FileInformationClassLevel::FILE_BOTH_DIRECTORY_INFORMATION {
            FileInformationClass::BothDirectory(FileBothDirectoryInformation::new(
                created, accessed, written, written, size, attrs, next.name,
            ))
        } else if level == FileInformationClassLevel::FILE_FULL_DIRECTORY_INFORMATION {
            FileInformationClass::FullDirectory(FileFullDirectoryInformation::new(
                created, accessed, written, written, size, attrs, next.name,
            ))
        } else if level == FileInformationClassLevel::FILE_DIRECTORY_INFORMATION {
            FileInformationClass::Directory(FileDirectoryInformation::new(
                created, accessed, written, written, size, attrs, next.name,
            ))
        } else if level == FileInformationClassLevel::FILE_NAMES_INFORMATION {
            FileInformationClass::Names(FileNamesInformation::new(next.name))
        } else {
            return respond(NtStatus::NOT_SUPPORTED, None);
        };
        respond(NtStatus::SUCCESS, Some(buffer))
    }

    fn query_volume(
        &self,
        req: ServerDriveQueryVolumeInformationRequest,
    ) -> ClientDriveQueryVolumeInformationResponse {
        let io = req.device_io_request.clone();
        // Free space of the disk holding the shared folder.
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let disk = disks
            .iter()
            .filter(|d| self.root.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len());
        let (total, free) = disk.map_or((1 << 40, 1 << 39), |d| {
            (d.total_space(), d.available_space())
        });
        const BYTES_PER_SECTOR: u32 = 512;
        const SECTORS_PER_UNIT: u32 = 8;
        let unit = u64::from(BYTES_PER_SECTOR * SECTORS_PER_UNIT);
        let (total_units, free_units) = (
            i64::try_from(total / unit).unwrap_or(i64::MAX),
            i64::try_from(free / unit).unwrap_or(i64::MAX),
        );

        let level = req.fs_info_class_lvl;
        let buffer = if level == FileSystemInformationClassLevel::FILE_FS_VOLUME_INFORMATION {
            FileSystemInformationClass::FileFsVolumeInformation(FileFsVolumeInformation {
                volume_creation_time: 0,
                volume_serial_number: 0x4854_0001,
                supports_objects: Boolean::False,
                volume_label: DRIVE_NAME.to_string(),
            })
        } else if level == FileSystemInformationClassLevel::FILE_FS_SIZE_INFORMATION {
            FileSystemInformationClass::FileFsSizeInformation(FileFsSizeInformation {
                total_alloc_units: total_units,
                available_alloc_units: free_units,
                sectors_per_alloc_unit: SECTORS_PER_UNIT,
                bytes_per_sector: BYTES_PER_SECTOR,
            })
        } else if level == FileSystemInformationClassLevel::FILE_FS_FULL_SIZE_INFORMATION {
            FileSystemInformationClass::FileFsFullSizeInformation(FileFsFullSizeInformation {
                total_alloc_units: total_units,
                caller_available_alloc_units: free_units,
                actual_available_alloc_units: free_units,
                sectors_per_alloc_unit: SECTORS_PER_UNIT,
                bytes_per_sector: BYTES_PER_SECTOR,
            })
        } else if level == FileSystemInformationClassLevel::FILE_FS_ATTRIBUTE_INFORMATION {
            FileSystemInformationClass::FileFsAttributeInformation(FileFsAttributeInformation {
                file_system_attributes: FileSystemAttributes::FILE_CASE_SENSITIVE_SEARCH
                    | FileSystemAttributes::FILE_CASE_PRESERVED_NAMES
                    | FileSystemAttributes::FILE_UNICODE_ON_DISK,
                max_component_name_len: 255,
                file_system_name: "FAT32".to_string(),
            })
        } else if level == FileSystemInformationClassLevel::FILE_FS_DEVICE_INFORMATION {
            FileSystemInformationClass::FileFsDeviceInformation(FileFsDeviceInformation {
                device_type: FILE_DEVICE_DISK,
                characteristics: ironrdp::rdpdr::pdu::efs::Characteristics::empty(),
            })
        } else {
            return ClientDriveQueryVolumeInformationResponse::new(
                io,
                NtStatus::NOT_SUPPORTED,
                None,
            );
        };
        ClientDriveQueryVolumeInformationResponse::new(io, NtStatus::SUCCESS, Some(buffer))
    }

    fn set_information(&mut self, req: &ServerDriveSetInformationRequest) -> NtStatus {
        let file_id = req.device_io_request.file_id;
        let Some(path) = self.open.get(&file_id).map(|e| e.path.clone()) else {
            return NtStatus::UNSUCCESSFUL;
        };
        match &req.set_buffer {
            FileInformationClass::EndOfFile(info) => {
                let Some(file) = self.open.get_mut(&file_id).and_then(|e| e.file.as_mut()) else {
                    return NtStatus::ACCESS_DENIED;
                };
                let length = u64::try_from(info.end_of_file).unwrap_or(0);
                if file.set_len(length).is_ok() {
                    NtStatus::SUCCESS
                } else {
                    NtStatus::ACCESS_DENIED
                }
            }
            FileInformationClass::Disposition(info) => {
                if path.is_dir() && fs::read_dir(&path).is_ok_and(|mut d| d.next().is_some()) {
                    return NtStatus::DIRECTORY_NOT_EMPTY;
                }
                if let Some(entry) = self.open.get_mut(&file_id) {
                    entry.delete_on_close = info.delete_pending != 0;
                }
                NtStatus::SUCCESS
            }
            FileInformationClass::Rename(info) => {
                let Some(target) = self.resolve(&info.file_name) else {
                    return NtStatus::ACCESS_DENIED;
                };
                if target.exists() && !matches!(info.replace_if_exists, Boolean::True) {
                    return NtStatus::OBJECT_NAME_COLLISION;
                }
                match fs::rename(&path, &target) {
                    Ok(()) => {
                        if let Some(entry) = self.open.get_mut(&file_id) {
                            entry.path = target;
                        }
                        NtStatus::SUCCESS
                    }
                    Err(_) => NtStatus::ACCESS_DENIED,
                }
            }
            // Timestamps and preallocation: accepted, nothing to do.
            FileInformationClass::Basic(_) | FileInformationClass::Allocation(_) => {
                NtStatus::SUCCESS
            }
            _ => NtStatus::NOT_SUPPORTED,
        }
    }

    fn respond(&mut self, req: ServerDriveIoRequest) -> PduResult<Option<RdpdrPdu>> {
        Ok(Some(match req {
            ServerDriveIoRequest::ServerCreateDriveRequest(req) => self.create(req).into(),
            ServerDriveIoRequest::DeviceCloseRequest(req) => self.close(req).into(),
            ServerDriveIoRequest::DeviceReadRequest(req) => self.read(req).into(),
            ServerDriveIoRequest::DeviceWriteRequest(req) => self.write(req).into(),
            ServerDriveIoRequest::ServerDriveQueryInformationRequest(req) => {
                self.query_information(req).into()
            }
            ServerDriveIoRequest::ServerDriveQueryDirectoryRequest(req) => {
                self.query_directory(req).into()
            }
            ServerDriveIoRequest::ServerDriveQueryVolumeInformationRequest(req) => {
                self.query_volume(req).into()
            }
            ServerDriveIoRequest::ServerDriveSetInformationRequest(req) => {
                let status = self.set_information(&req);
                ClientDriveSetInformationResponse::new(&req, status)
                    .map_err(|e| ironrdp::pdu::encode_err!(e))?
                    .into()
            }
            ServerDriveIoRequest::DeviceControlRequest(req) => {
                DeviceControlResponse::new(req, NtStatus::SUCCESS, None).into()
            }
            // Change notifications stay pending (no reply), as FreeRDP does; locks are not needed.
            ServerDriveIoRequest::ServerDriveNotifyChangeDirectoryRequest(_)
            | ServerDriveIoRequest::ServerDriveLockControlRequest(_) => {
                return Ok(None);
            }
        }))
    }
}

impl RdpdrBackend for DriveBackend {
    fn handle_server_device_announce_response(
        &mut self,
        _pdu: ServerDeviceAnnounceResponse,
    ) -> PduResult<()> {
        Ok(())
    }

    fn handle_scard_call(
        &mut self,
        _req: DeviceControlRequest<ScardIoCtlCode>,
        _call: ScardCall,
    ) -> PduResult<()> {
        Ok(())
    }

    fn handle_drive_io_request(&mut self, req: ServerDriveIoRequest) -> PduResult<Vec<SvcMessage>> {
        Ok(self
            .respond(req)?
            .map(|pdu| vec![SvcMessage::from(pdu)])
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::rdpdr::pdu::efs::{
        DesiredAccess, DeviceIoRequest, FileDispositionInformation, FileRenameInformation,
        MajorFunction, MinorFunction, SharedAccess,
    };

    fn io(file_id: u32) -> DeviceIoRequest {
        DeviceIoRequest {
            device_id: DRIVE_ID,
            file_id,
            completion_id: 1,
            major_function: MajorFunction::Create,
            minor_function: MinorFunction::from(0),
        }
    }

    fn create(
        drive: &mut DriveBackend,
        path: &str,
        disposition: CreateDisposition,
        options: CreateOptions,
    ) -> DeviceCreateResponse {
        drive.create(DeviceCreateRequest {
            device_io_request: io(0),
            desired_access: DesiredAccess::empty(),
            allocation_size: 0,
            file_attributes: FileAttributes::empty(),
            shared_access: SharedAccess::empty(),
            create_disposition: disposition,
            create_options: options,
            path: path.into(),
        })
    }

    fn temp_drive(name: &str) -> (DriveBackend, PathBuf) {
        let root = std::env::temp_dir().join(format!("ht-drive-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        (DriveBackend::new(root.clone()), root)
    }

    #[test]
    fn paths_cannot_leave_the_shared_folder() {
        let (drive, root) = temp_drive("escape");
        assert_eq!(
            drive.resolve("\\docs\\a.txt"),
            Some(root.join("docs").join("a.txt"))
        );
        assert_eq!(drive.resolve(""), Some(root.clone()));
        assert_eq!(drive.resolve("\\..\\etc\\passwd"), None);
        assert_eq!(drive.resolve("\\docs\\..\\..\\x"), None);
        assert_eq!(drive.resolve("C:\\Windows"), None);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/", root.join("out")).unwrap();
            assert_eq!(drive.resolve("\\out\\etc\\passwd"), None, "symlink escape");
        }
    }

    #[test]
    fn files_are_created_written_read_listed_renamed_and_deleted() {
        let (mut drive, root) = temp_drive("io");

        // Create a folder and a file inside it, write, read back.
        let dir = create(
            &mut drive,
            "\\carpeta",
            CreateDisposition::FILE_CREATE,
            CreateOptions::FILE_DIRECTORY_FILE,
        );
        assert_eq!(dir.device_io_reply.io_status, NtStatus::SUCCESS);
        assert!(root.join("carpeta").is_dir());
        let file = create(
            &mut drive,
            "\\carpeta\\hola.txt",
            CreateDisposition::FILE_OVERWRITE_IF,
            CreateOptions::FILE_NON_DIRECTORY_FILE,
        );
        assert_eq!(file.device_io_reply.io_status, NtStatus::SUCCESS);
        let written = drive.write(DeviceWriteRequest {
            device_io_request: io(file.file_id),
            offset: 0,
            write_data: b"hola mundo".to_vec(),
        });
        assert_eq!(written.length, 10);
        let read = drive.read(DeviceReadRequest {
            device_io_request: io(file.file_id),
            length: 4,
            offset: 5,
        });
        assert_eq!(read.read_data, b"mund");

        // Size through query information.
        let info = drive.query_information(ServerDriveQueryInformationRequest {
            device_io_request: io(file.file_id),
            file_info_class_lvl: FileInformationClassLevel::FILE_STANDARD_INFORMATION,
        });
        assert!(
            matches!(info.buffer, Some(FileInformationClass::Standard(ref s)) if s.end_of_file == 10)
        );
        drive.close(DeviceCloseRequest {
            device_io_request: io(file.file_id),
        });

        // Directory listing with a pattern: ".", ".." and the file, then no more files.
        let mut names = Vec::new();
        let mut initial = 1;
        loop {
            let response = drive.query_directory(ServerDriveQueryDirectoryRequest {
                device_io_request: io(dir.file_id),
                file_info_class_lvl: FileInformationClassLevel::FILE_BOTH_DIRECTORY_INFORMATION,
                initial_query: initial,
                path: "\\carpeta\\*".into(),
            });
            initial = 0;
            match response.buffer {
                Some(FileInformationClass::BothDirectory(entry)) => names.push(entry.file_name),
                _ => {
                    assert_eq!(response.device_io_reply.io_status, NtStatus::NO_MORE_FILES);
                    break;
                }
            }
        }
        assert_eq!(names, [".", "..", "hola.txt"]);

        // Opening something that is not there, and creating something that is.
        let missing = create(
            &mut drive,
            "\\nada.txt",
            CreateDisposition::FILE_OPEN,
            CreateOptions::empty(),
        );
        assert_eq!(
            missing.device_io_reply.io_status,
            status(STATUS_OBJECT_NAME_NOT_FOUND)
        );
        let again = create(
            &mut drive,
            "\\carpeta",
            CreateDisposition::FILE_CREATE,
            CreateOptions::FILE_DIRECTORY_FILE,
        );
        assert_eq!(
            again.device_io_reply.io_status,
            NtStatus::OBJECT_NAME_COLLISION
        );

        // Rename, then delete through the disposition flag.
        let file = create(
            &mut drive,
            "\\carpeta\\hola.txt",
            CreateDisposition::FILE_OPEN,
            CreateOptions::empty(),
        );
        let rename = ServerDriveSetInformationRequest {
            device_io_request: io(file.file_id),
            set_buffer: FileInformationClass::Rename(FileRenameInformation {
                replace_if_exists: Boolean::False,
                file_name: "\\adios.txt".into(),
            }),
        };
        assert_eq!(drive.set_information(&rename), NtStatus::SUCCESS);
        assert!(root.join("adios.txt").exists() && !root.join("carpeta").join("hola.txt").exists());
        let delete = ServerDriveSetInformationRequest {
            device_io_request: io(file.file_id),
            set_buffer: FileInformationClass::Disposition(FileDispositionInformation {
                delete_pending: 1,
            }),
        };
        assert_eq!(drive.set_information(&delete), NtStatus::SUCCESS);
        drive.close(DeviceCloseRequest {
            device_io_request: io(file.file_id),
        });
        assert!(!root.join("adios.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn wildcards_match_like_windows() {
        assert!(wildcard_match("*", "anything.txt"));
        assert!(wildcard_match("*.TXT", "notes.txt"));
        assert!(wildcard_match("f?le", "file"));
        assert!(!wildcard_match("*.txt", "notes.md"));
    }
}
