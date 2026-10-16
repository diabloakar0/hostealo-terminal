// One interface over SFTP and FTP/FTPS, so the file browser does not care which it talks to.
import {
  ftpCancelTransfer,
  ftpClose,
  ftpDelete,
  ftpDownload,
  ftpList,
  ftpMkdir,
  ftpOpen,
  ftpRealpath,
  ftpRename,
  ftpUpload,
  sftpCancelTransfer,
  sftpClose,
  sftpDelete,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpOpen,
  sftpRealpath,
  sftpRename,
  sftpUpload,
  type SftpEntry,
  type SshEvent,
  type TransferProgress,
} from "./ipc";

type OnProgress = (progress: TransferProgress) => void;

export interface FileApi {
  open: (hostId: string, onEvent: (event: SshEvent) => void) => Promise<number>;
  close: (id: number) => Promise<void>;
  realpath: (id: number, path: string) => Promise<string>;
  list: (id: number, path: string) => Promise<SftpEntry[]>;
  mkdir: (id: number, path: string) => Promise<void>;
  rename: (id: number, from: string, to: string) => Promise<void>;
  remove: (id: number, entry: SftpEntry) => Promise<void>;
  download: (id: number, transferId: number, entry: SftpEntry, localDir: string, onProgress: OnProgress) => Promise<void>;
  upload: (id: number, transferId: number, locals: string[], remoteDir: string, onProgress: OnProgress) => Promise<void>;
  cancelTransfer: (transferId: number) => Promise<void>;
}

export const sftpApi: FileApi = {
  open: sftpOpen,
  close: sftpClose,
  realpath: sftpRealpath,
  list: sftpList,
  mkdir: sftpMkdir,
  rename: sftpRename,
  remove: (id, entry) => sftpDelete(id, entry.path),
  download: (id, transferId, entry, localDir, onProgress) => sftpDownload(id, transferId, entry.path, localDir, onProgress),
  upload: sftpUpload,
  cancelTransfer: sftpCancelTransfer,
};

export const ftpApi: FileApi = {
  open: ftpOpen,
  close: ftpClose,
  realpath: ftpRealpath,
  list: ftpList,
  mkdir: ftpMkdir,
  rename: ftpRename,
  remove: (id, entry) => ftpDelete(id, entry.path, entry.isDir && !entry.isSymlink),
  download: ftpDownload,
  upload: ftpUpload,
  cancelTransfer: ftpCancelTransfer,
};
