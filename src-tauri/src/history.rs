use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tempfile::NamedTempFile;

const FILE_TAG: &[u8; 4] = b"DGC1";
const INVALID: &str = "대화 파일 형식을 확인할 수 없습니다.";
const READ: &str = "대화 파일을 읽을 수 없습니다.";
const WRITE: &str = "대화를 저장할 수 없습니다. 디스크 공간과 권한을 확인해 주세요.";
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Serialize, Deserialize)]
pub(crate) struct Image {
    mime: String,
    data: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Turn {
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image: Option<Image>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interrupted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<super::Usage>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Summary {
    id: String,
    title: String,
    updated: u64,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Thread {
    #[serde(flatten)]
    summary: Summary,
    turns: Vec<Turn>,
}

fn folder(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_local_data_dir().map_err(|_| READ)?.join("conversations"))
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(index, ch)| {
        if matches!(index, 8 | 13 | 18 | 23) { ch == b'-' } else { ch.is_ascii_hexdigit() }
    })
}

fn file_for(app: &AppHandle, id: &str) -> Result<PathBuf> {
    if !valid_id(id) { return Err(INVALID); }
    Ok(folder(app)?.join(format!("{id}.dgc")))
}

fn header(reader: &mut impl Read, id: &str) -> Result<(Summary, u8)> {
    let mut fixed = [0u8; 15];
    reader.read_exact(&mut fixed).map_err(|_| INVALID)?;
    if &fixed[..4] != FILE_TAG || fixed[4] > 1 { return Err(INVALID); }
    let updated = u64::from_le_bytes(fixed[5..13].try_into().map_err(|_| INVALID)?);
    let title_len = u16::from_le_bytes([fixed[13], fixed[14]]);
    let mut title = vec![0; usize::from(title_len)];
    reader.read_exact(&mut title).map_err(|_| INVALID)?;
    let title = String::from_utf8(title).map_err(|_| INVALID)?;
    Ok((Summary { id: id.to_owned(), title, updated }, fixed[4]))
}

fn inventory(dir: &Path) -> Result<Vec<Summary>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(READ),
    };
    let mut items = Vec::new();
    for entry in entries {
        let path = entry.map_err(|_| READ)?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("dgc") { continue; }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).filter(|s| valid_id(s)) else { continue; };
        let file = File::open(&path).map_err(|_| READ)?;
        let summary = match header(&mut BufReader::new(file), id) {
            Ok((summary, _)) => summary,
            Err(_) => Summary { id: id.to_owned(), title: "읽을 수 없는 대화".into(), updated: 0 },
        };
        items.push(summary);
    }
    items.sort_unstable_by(|a, b| b.updated.cmp(&a.updated).then(a.id.cmp(&b.id)));
    Ok(items)
}

#[tauri::command]
pub(crate) async fn list_threads(app: AppHandle) -> Result<Vec<Summary>> {
    let dir = folder(&app)?;
    tauri::async_runtime::spawn_blocking(move || inventory(&dir)).await.map_err(|_| READ)?
}

#[tauri::command]
pub(crate) async fn read_thread(app: AppHandle, id: String) -> Result<Thread> {
    let path = file_for(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut reader = BufReader::new(File::open(path).map_err(|_| READ)?);
        let (summary, method) = header(&mut reader, &id)?;
        let turns = if method == 1 {
            serde_json::from_reader(DeflateDecoder::new(reader))
        } else {
            serde_json::from_reader(reader)
        }.map_err(|_| INVALID)?;
        Ok(Thread { summary, turns })
    }).await.map_err(|_| READ)?
}

#[tauri::command]
pub(crate) async fn write_thread(app: AppHandle, thread: Thread) -> Result<()> {
    let path = file_for(&app, &thread.summary.id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = path.parent().ok_or(WRITE)?;
        fs::create_dir_all(dir).map_err(|_| WRITE)?;
        let title = thread.summary.title.as_bytes();
        let title_len = u16::try_from(title.len()).map_err(|_| INVALID)?;
        let raw = serde_json::to_vec(&thread.turns).map_err(|_| INVALID)?;
        let mut compact = None;
        if raw.len() >= 512 {
            let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
            encoder.write_all(&raw).map_err(|_| WRITE)?;
            let compressed = encoder.finish().map_err(|_| WRITE)?;
            if compressed.len() < raw.len() { compact = Some(compressed); }
        }
        let mut temp = NamedTempFile::new_in(dir).map_err(|_| WRITE)?;
        temp.write_all(FILE_TAG).map_err(|_| WRITE)?;
        temp.write_all(&[u8::from(compact.is_some())]).map_err(|_| WRITE)?;
        temp.write_all(&thread.summary.updated.to_le_bytes()).map_err(|_| WRITE)?;
        temp.write_all(&title_len.to_le_bytes()).map_err(|_| WRITE)?;
        temp.write_all(title).map_err(|_| WRITE)?;
        temp.write_all(compact.as_deref().unwrap_or(&raw)).map_err(|_| WRITE)?;
        temp.as_file().sync_all().map_err(|_| WRITE)?;
        temp.persist(path).map_err(|_| WRITE)?;
        Ok(())
    }).await.map_err(|_| WRITE)?
}

#[tauri::command]
pub(crate) async fn delete_thread(app: AppHandle, id: String) -> Result<()> {
    let path = file_for(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("선택한 대화 파일을 삭제할 수 없습니다."),
        }
    }).await.map_err(|_| WRITE)?
}
