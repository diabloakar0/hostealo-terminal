use ironrdp::cliprdr::pdu::{ClipboardFileAttributes, FileContentsFlags, PackedFileList};

use super::*;

fn link(
    initial: Snapshot,
) -> (
    ClipboardLink,
    Backend,
    mpsc::UnboundedReceiver<ClipboardEvent>,
    Arc<MemoryClipboard>,
) {
    let memory = Arc::new(MemoryClipboard::default());
    memory.set(initial);
    let (link, events) = ClipboardLink::new(memory.clone());
    let mut backend = link.backend();
    backend.on_process_negotiated_capabilities(backend.client_capabilities());
    (link, backend, events, memory)
}

fn text(text: &str) -> Snapshot {
    Snapshot {
        text: Some(text.into()),
        ..Snapshot::default()
    }
}

fn image() -> Image {
    Image {
        width: 2,
        height: 1,
        rgba: vec![255, 0, 0, 255, 0, 0, 255, 255],
    }
}

fn announced(events: &mut mpsc::UnboundedReceiver<ClipboardEvent>) -> Vec<ClipboardFormat> {
    match events.try_recv() {
        Ok(ClipboardEvent::Announce(formats)) => formats,
        other => panic!("announce expected, got {other:?}"),
    }
}

fn data(events: &mut mpsc::UnboundedReceiver<ClipboardEvent>) -> OwnedFormatDataResponse {
    match events.try_recv() {
        Ok(ClipboardEvent::Data(data)) => data,
        other => panic!("data expected, got {other:?}"),
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ht-clip-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn line_endings_are_converted_both_ways() {
    assert_eq!(to_remote_text("a\nb\r\nc"), "a\r\nb\r\nc");
    if !cfg!(windows) {
        assert_eq!(from_remote_text("a\r\nb\0"), "a\nb");
    }
}

#[test]
fn remote_text_is_fetched_and_lands_in_the_local_clipboard() {
    let (_link, mut backend, mut events, memory) = link(Snapshot::default());
    backend.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]);
    assert!(
        matches!(events.try_recv(), Ok(ClipboardEvent::Fetch(id)) if id == ClipboardFormatId::CF_UNICODETEXT)
    );

    backend.on_format_data_response(OwnedFormatDataResponse::new_unicode_string("hola\r\nmundo"));
    let expected = if cfg!(windows) {
        "hola\r\nmundo"
    } else {
        "hola\nmundo"
    };
    assert_eq!(memory.text().as_deref(), Some(expected));
}

#[test]
fn local_text_is_announced_and_served_on_request() {
    let (_link, mut backend, mut events, _memory) = link(text("uno\ndos"));
    backend.on_request_format_list();
    assert_eq!(
        announced(&mut events)[0].id,
        ClipboardFormatId::CF_UNICODETEXT
    );

    backend.on_format_data_request(FormatDataRequest {
        format: ClipboardFormatId::CF_UNICODETEXT,
    });
    let text = data(&mut events).to_unicode_string().unwrap();
    assert_eq!(text.trim_end_matches('\0'), "uno\r\ndos");

    // Formats that were not announced get an error.
    backend.on_format_data_request(FormatDataRequest {
        format: ClipboardFormatId::CF_DIB,
    });
    assert!(data(&mut events).is_error());
}

#[test]
fn images_travel_as_dibs_both_ways_without_echo() {
    let (link, mut backend, mut events, memory) = link(Snapshot {
        image: Some(image()),
        ..Snapshot::default()
    });
    backend.on_request_format_list();
    assert_eq!(
        announced(&mut events),
        [ClipboardFormat::new(ClipboardFormatId::CF_DIB)]
    );
    backend.on_format_data_request(FormatDataRequest {
        format: ClipboardFormatId::CF_DIB,
    });
    assert_eq!(dib::decode(data(&mut events).data()), Some(image()));

    // The remote copies a picture (it offers both DIB flavours).
    let picture = Image {
        width: 1,
        height: 2,
        rgba: vec![1, 2, 3, 255, 4, 5, 6, 255],
    };
    backend.on_remote_copy(&[
        ClipboardFormat::new(ClipboardFormatId::CF_DIBV5),
        ClipboardFormat::new(ClipboardFormatId::CF_DIB),
    ]);
    assert!(
        matches!(events.try_recv(), Ok(ClipboardEvent::Fetch(id)) if id == ClipboardFormatId::CF_DIB)
    );
    backend.on_format_data_response(OwnedFormatDataResponse::new_data(dib::encode(&picture)));
    assert_eq!(memory.image(), Some(picture));

    // Focusing the session again must not hand the picture back as a local copy.
    link.resync();
    assert!(events.try_recv().is_err(), "remote image was echoed back");
}

#[test]
fn watcher_announces_local_changes_but_never_echoes_remote_text() {
    let (link, mut backend, mut events, memory) = link(text("first"));
    backend.on_request_format_list();
    let _ = announced(&mut events);
    link.watch();

    memory.set_text("copied locally");
    std::thread::sleep(POLL_INTERVAL * 3);
    assert_eq!(announced(&mut events).len(), 1);

    // Text that arrives from the remote must not bounce back as a new local copy.
    backend.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]);
    let _ = events.try_recv();
    backend.on_format_data_response(OwnedFormatDataResponse::new_unicode_string("from remote"));
    std::thread::sleep(POLL_INTERVAL * 3);
    link.resync();
    assert!(events.try_recv().is_err(), "remote text was echoed back");
}

#[test]
fn local_files_are_offered_and_served() {
    let dir = temp_dir("local");
    std::fs::write(dir.join("report.pdf"), b"%PDF-1.7").unwrap();
    let (_link, mut backend, mut events, _memory) = link(Snapshot {
        text: Some("report.pdf".into()),
        image: None,
        files: vec![dir.join("report.pdf")],
    });
    backend.on_request_format_list();
    let formats = announced(&mut events);
    assert!(is_file_list(&formats[0]));
    assert_eq!(formats[1].id, ClipboardFormatId::CF_UNICODETEXT);

    backend.on_format_data_request(FormatDataRequest {
        format: formats[0].id,
    });
    let list = data(&mut events).to_file_list().unwrap();
    assert_eq!(list.files.len(), 1);
    assert_eq!(list.files[0].name, "report.pdf");
    assert_eq!(list.files[0].file_size, Some(8));

    backend.on_file_contents_request(FileContentsRequest {
        stream_id: 3,
        index: 0,
        flags: FileContentsFlags::DATA,
        position: 1,
        requested_size: 3,
        data_id: None,
    });
    let Ok(ClipboardEvent::FileContents(response)) = events.try_recv() else {
        panic!("file contents expected")
    };
    assert_eq!((response.stream_id(), response.data()), (3, &b"PDF"[..]));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn files_are_not_offered_to_servers_without_file_support() {
    let (_link, mut backend, mut events, _memory) = link(Snapshot {
        files: vec![PathBuf::from("/tmp")],
        ..Snapshot::default()
    });
    backend
        .on_process_negotiated_capabilities(ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES);
    backend.on_request_format_list();
    assert!(announced(&mut events).is_empty());
}

#[test]
fn remote_files_are_listed_saved_on_request_and_kept_on_resync() {
    let (link, mut backend, mut events, memory) = link(text("local"));
    backend.on_request_format_list();
    let _ = announced(&mut events);

    // The remote copies a folder with a file.
    let remote_format = ClipboardFormat::new(ClipboardFormatId::new(0xC07A))
        .with_name(ClipboardFormatName::new("FileGroupDescriptorW"));
    backend.on_remote_copy(&[
        ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
        remote_format.clone(),
    ]);
    assert!(matches!(events.try_recv(), Ok(ClipboardEvent::Fetch(id)) if id == remote_format.id));
    let list = PackedFileList {
        files: vec![
            FileDescriptor {
                attributes: Some(ClipboardFileAttributes::DIRECTORY),
                last_write_time: None,
                file_size: Some(0),
                name: "logs".into(),
            },
            FileDescriptor {
                attributes: Some(ClipboardFileAttributes::ARCHIVE),
                last_write_time: None,
                file_size: Some(5),
                name: "logs\\app.log".into(),
            },
        ],
    };
    backend.on_format_data_response(OwnedFormatDataResponse::new_file_list(&list).unwrap());
    assert!(matches!(
        events.try_recv(),
        Ok(ClipboardEvent::Notice(Notice::RemoteFiles { names, count: 2, bytes: 5 })) if names == ["logs"]
    ));
    // The local clipboard keeps its content, and focusing the session does not replace the
    // remote's files with it.
    assert_eq!(memory.text().as_deref(), Some("local"));
    link.resync();
    assert!(events.try_recv().is_err());

    let target = temp_dir("remote");
    link.save_remote_files(target.clone());
    assert!(matches!(
        events.try_recv(),
        Ok(ClipboardEvent::Notice(Notice::Progress {
            done: 0,
            total: 5
        }))
    ));
    let Ok(ClipboardEvent::RequestFileContents(request)) = events.try_recv() else {
        panic!("request expected")
    };
    assert_eq!(
        (request.index, request.position, request.requested_size),
        (1, 0, 5)
    );

    // An answer to some other request is ignored.
    backend.on_file_contents_response(FileContentsResponse::new_data_response(
        request.stream_id + 7,
        &b"nope!"[..],
    ));
    assert!(events.try_recv().is_err());
    backend.on_file_contents_response(FileContentsResponse::new_data_response(
        request.stream_id,
        &b"hello"[..],
    ));
    assert!(matches!(
        events.try_recv(),
        Ok(ClipboardEvent::Notice(Notice::Saved { paths })) if paths == [target.join("logs")]
    ));
    assert_eq!(
        std::fs::read(target.join("logs/app.log")).unwrap(),
        b"hello"
    );

    // Copying something else on the remote withdraws the files.
    backend.on_remote_copy(&[]);
    assert!(matches!(
        events.try_recv(),
        Ok(ClipboardEvent::Notice(Notice::RemoteFiles { count: 0, .. }))
    ));
    link.save_remote_files(target.clone());
    assert!(matches!(
        events.try_recv(),
        Ok(ClipboardEvent::Notice(Notice::Failed { .. }))
    ));
    std::fs::remove_dir_all(target).unwrap();
}

#[test]
fn cancelling_a_download_removes_the_partial_file() {
    let (link, mut backend, mut events, _memory) = link(Snapshot::default());
    let format = file_list_format();
    backend.on_remote_copy(std::slice::from_ref(&format));
    let _ = events.try_recv();
    let list = PackedFileList {
        files: vec![FileDescriptor {
            attributes: None,
            last_write_time: None,
            file_size: Some(10_000_000),
            name: "big.iso".into(),
        }],
    };
    backend.on_format_data_response(OwnedFormatDataResponse::new_file_list(&list).unwrap());
    let _ = events.try_recv();

    let target = temp_dir("cancel");
    link.save_remote_files(target.clone());
    let _ = events.try_recv();
    let Ok(ClipboardEvent::RequestFileContents(request)) = events.try_recv() else {
        panic!("request expected")
    };
    backend.on_file_contents_response(FileContentsResponse::new_data_response(
        request.stream_id,
        vec![0u8; 1000],
    ));
    let _ = events.try_recv();
    assert!(target.join("big.iso").exists());

    link.cancel_download();
    assert!(matches!(
        events.try_recv(),
        Ok(ClipboardEvent::Notice(Notice::Cancelled))
    ));
    assert!(!target.join("big.iso").exists());
    std::fs::remove_dir_all(target).unwrap();
}
