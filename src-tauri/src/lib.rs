mod history;

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{hash_map::RandomState, HashMap}, hash::BuildHasher, time::Duration};
use tauri::{ipc::Channel, State};
use tokio::sync::{oneshot, Mutex};

const HOST: &str = "https://gpt-gw.daegu.ac.kr";
const LIMIT: usize = 10 * 1024 * 1024;
const NETWORK: &str = "학교 서버에 연결할 수 없습니다.";
const FORMAT: &str = "학교 응답 형식을 확인할 수 없습니다.";
const STORAGE: &str = "운영체제의 자격 증명 저장소를 사용할 수 없습니다.";
const SIZE: &str = "요청 본문은 10 MiB 이하여야 합니다.";
type Result<T> = std::result::Result<T, &'static str>;

struct Gateway {
    client: Client,
    credentials: Mutex<Option<(u64, Models)>>,
    hash: RandomState,
    active: Mutex<HashMap<String, Option<oneshot::Sender<()>>>>,
}

fn entry() -> Result<keyring::Entry> {
    if !cfg!(any(target_os = "windows", target_os = "macos")) {
        return Err(STORAGE);
    }
    keyring::Entry::new("D-GPT.school.gateway", "student-key").map_err(|_| STORAGE)
}

fn saved_key() -> Result<String> {
    entry()?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => "등록된 API 키가 없습니다.",
        _ => STORAGE,
    })
}

fn network_error(error: reqwest::Error) -> &'static str {
    if error.is_timeout() { "학교 서버 응답 시간이 초과되었습니다." } else { NETWORK }
}

fn success(response: Response) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    Err(match response.status().as_u16() {
        401 | 403 => "학교에서 키 또는 접근 권한을 확인하지 못했습니다.",
        413 => SIZE,
        429 => "학교 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
        _ => "학교 서버가 요청을 처리하지 못했습니다.",
    })
}

async fn chat_response(mut response: Response) -> Result<Response> {
    if response.status() == reqwest::StatusCode::BAD_REQUEST {
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if chunk.len() <= 8192 - body.len() => body.extend_from_slice(&chunk),
                Ok(None) => {
                    if let Ok(error) = serde_json::from_slice::<Value>(&body) {
                        if error.pointer("/error/code").and_then(Value::as_str) == Some("context_length_exceeded") {
                            return Err("대화가 모델의 입력 한도에 도달했습니다. 질문을 줄이거나 새 대화를 시작해 주세요.");
                        }
                    }
                    break;
                }
                _ => break,
            }
        }
    }
    success(response)
}

#[derive(Clone, Deserialize, Serialize)]
struct Models {
    data: Vec<Value>,
}

async fn fetch_models(client: &Client, key: &str) -> Result<Models> {
    let request = client.get(format!("{HOST}/v1/models"))
        .bearer_auth(key).timeout(Duration::from_secs(15));
    let mut response = success(request.send().await.map_err(network_error)?)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 { return Err(FORMAT); }
        bytes.extend_from_slice(&chunk);
    }
    let models: Models = serde_json::from_slice(&bytes).map_err(|_| FORMAT)?;
    if models.data.iter().any(|model| model["id"].as_str().map_or(true, str::is_empty)) {
        return Err(FORMAT);
    }
    Ok(models)
}

#[tauri::command]
async fn connect_key(key: String, state: State<'_, Gateway>) -> Result<Models> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("개인 키를 확인해 주세요.");
    }
    #[cfg(windows)]
    if key.len() > 1280 {
        return Err("이 키는 Windows 자격 증명 저장소에 보관하기에 너무 깁니다.");
    }
    let mut cache = state.credentials.lock().await;
    let models = fetch_models(&state.client, key).await?;
    entry()?.set_password(key).map_err(|_| STORAGE)?;
    *cache = Some((state.hash.hash_one(key), models.clone()));
    cancel_active(&state).await;
    Ok(models)
}

#[tauri::command]
async fn list_models(state: State<'_, Gateway>) -> Result<Models> {
    let mut cache = state.credentials.lock().await;
    *cache = None;
    let key = saved_key()?;
    let models = fetch_models(&state.client, &key).await?;
    *cache = Some((state.hash.hash_one(key.as_str()), models.clone()));
    Ok(models)
}

#[tauri::command]
async fn forget_key(state: State<'_, Gateway>) -> Result<()> {
    let mut cache = state.credentials.lock().await;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            *cache = None;
            cancel_active(&state).await;
            Ok(())
        },
        Err(_) => Err(STORAGE),
    }
}

async fn cancel_active(state: &Gateway) {
    let mut active = state.active.lock().await;
    for sender in active.values_mut().filter_map(Option::take) {
        let _ = sender.send(());
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Image { mime: String, data: String }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message { role: String, content: String, image: Option<Image> }

fn is_claude(id: &str) -> Result<bool> {
    if id.strip_prefix("anthropic/").unwrap_or(id).starts_with("claude-") {
        return Ok(true);
    }
    let name = id.strip_prefix("openai/").unwrap_or(id);
    let series = name.split('-').next().unwrap_or("");
    if name.starts_with("gpt-") || series.strip_prefix('o').is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) {
        return Ok(false);
    }
    Err("지원하지 않는 모델입니다.")
}

fn image_block(image: Image, claude: bool) -> Result<Value> {
    if image.data.len() > LIMIT { return Err(SIZE); }
    let bytes = STANDARD.decode(&image.data).map_err(|_| "이미지 데이터를 확인해 주세요.")?;
    let valid = match image.mime.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(&b"WEBP"[..]),
        _ => false,
    };
    if !valid { return Err("지원하는 이미지 파일을 선택해 주세요."); }
    Ok(if claude {
        json!({"type":"image","source":{"type":"base64","media_type":image.mime,"data":image.data}})
    } else {
        json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}",image.mime,image.data)}})
    })
}

fn chat_body(model: &Value, messages: Vec<Message>, claude: bool) -> Result<Vec<u8>> {
    if messages.is_empty() { return Err("질문을 입력해 주세요."); }
    let image_allowed = model["input_modalities"].as_array().is_some_and(|a| a.iter().any(|v| v == "image"));
    let mut total = 0usize;
    let mut turns = Vec::new();
    for message in messages {
        if !matches!(message.role.as_str(), "user" | "assistant") { return Err("대화 역할을 확인해 주세요."); }
        total = total.saturating_add(message.content.len()).saturating_add(message.image.as_ref().map_or(0, |i| i.data.len()));
        if total > LIMIT { return Err(SIZE); }
        let content = if let Some(image) = message.image {
            if !image_allowed || message.role != "user" { return Err("이 모델에는 이미지를 보낼 수 없습니다."); }
            let mut blocks = vec![image_block(image, claude)?];
            if !message.content.is_empty() { blocks.push(json!({"type":"text","text":message.content})); }
            Value::Array(blocks)
        } else {
            Value::String(message.content)
        };
        turns.push(json!({"role":message.role,"content":content}));
    }
    let mut body = json!({"model":model["id"],"messages":turns,"stream":true});
    if claude { body["max_tokens"] = json!(4096); }
    else { body["stream_options"] = json!({"include_usage":true}); }
    let bytes = serde_json::to_vec(&body).map_err(|_| FORMAT)?;
    if bytes.len() > LIMIT { return Err(SIZE); }
    Ok(bytes)
}

#[derive(Serialize)]
#[serde(tag="type", rename_all="lowercase")]
enum Event {
    Text { text: String },
    Usage {
        #[serde(skip_serializing_if="Option::is_none")]
        input: Option<u64>,
        #[serde(skip_serializing_if="Option::is_none")]
        output: Option<u64>,
    },
}

fn dispatch(data: &str, claude: bool, channel: &Channel<Event>, finish: &mut Option<String>) -> Result<bool> {
    if !claude && data.trim() == "[DONE]" { return completion(finish.as_deref()); }
    let value: Value = serde_json::from_str(data).map_err(|_| FORMAT)?;
    if value.get("error").is_some() || value["type"] == "error" {
        return Err("학교에서 응답 생성을 중단했습니다.");
    }
    if claude && value["type"] == "message_stop" { return completion(finish.as_deref()); }
    let reason = if claude { value.pointer("/delta/stop_reason") } else { value.pointer("/choices/0/finish_reason") };
    if let Some(reason) = reason.and_then(Value::as_str) { *finish = Some(reason.to_owned()); }
    let text = if claude { value.pointer("/delta/text") } else { value.pointer("/choices/0/delta/content") };
    if let Some(text) = text.and_then(Value::as_str).filter(|s| !s.is_empty()) {
        channel.send(Event::Text { text: text.to_owned() }).map_err(|_| "대화 화면이 닫혔습니다.")?;
    }
    let usage = value.pointer("/message/usage").unwrap_or(&value["usage"]);
    let (input, output) = if claude { (&usage["input_tokens"], &usage["output_tokens"]) }
        else { (&usage["prompt_tokens"], &usage["completion_tokens"]) };
    if input.is_u64() || output.is_u64() {
        channel.send(Event::Usage { input:input.as_u64(), output:output.as_u64() })
            .map_err(|_| "대화 화면이 닫혔습니다.")?;
    }
    Ok(false)
}

fn completion(reason: Option<&str>) -> Result<bool> {
    match reason {
        None => Err("답변 완료 상태를 확인할 수 없습니다."),
        Some("length" | "max_tokens" | "model_context_window_exceeded") => Err("답변 길이 한도에 도달했습니다."),
        Some("content_filter" | "refusal") => Err("모델이 답변 생성을 중단했습니다."),
        Some(_) => Ok(true),
    }
}

async fn stream(mut response: Response, claude: bool, channel: &Channel<Event>) -> Result<()> {
    let mut finish = None;
    let mut line = Vec::new();
    let mut data = String::new();
    let mut after_cr = false;
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        for &byte in chunk.as_ref() {
            if byte == b'\n' && after_cr { after_cr = false; continue; }
            after_cr = byte == b'\r';
            if !after_cr && byte != b'\n' {
                line.push(byte);
                if line.len() + data.len() > 1024 * 1024 { return Err(FORMAT); }
                continue;
            }
            let field = std::str::from_utf8(&line).map_err(|_| FORMAT)?;
            if field.is_empty() && !data.is_empty() {
                if dispatch(data.trim_end_matches('\n'), claude, channel, &mut finish)? { return Ok(()); }
                data.clear();
            } else if let Some(part) = field.strip_prefix("data:") {
                data.push_str(part.strip_prefix(' ').unwrap_or(part));
                data.push('\n');
            }
            line.clear();
        }
    }
    Err("답변을 모두 받기 전에 연결이 끊어졌습니다.")
}

async fn chat(state: &Gateway, model_id: &str, messages: Vec<Message>, channel: &Channel<Event>) -> Result<()> {
    let claude = is_claude(model_id)?;
    let (key, model) = {
        let mut cache = state.credentials.lock().await;
        let key = saved_key()?;
        let fingerprint = state.hash.hash_one(key.as_str());
        if cache.as_ref().map(|(id, _)| *id) != Some(fingerprint) {
            *cache = Some((fingerprint, fetch_models(&state.client, &key).await?));
        }
        let model = cache.as_ref().and_then(|(_, models)| models.data.iter().find(|m| m["id"] == model_id))
            .ok_or("현재 키에서 사용할 수 없는 모델입니다.")?.clone();
        (key, model)
    };
    if matches!(model["model_type"].as_str(), Some("embedding" | "image_generation" | "video_generation" | "transcription" | "speech")) {
        return Err("이 모델은 대화를 지원하지 않습니다.");
    }
    let body = chat_body(&model, messages, claude)?;
    let path = if claude { "/v1/messages" } else { "/v1/chat/completions" };
    let mut request = state.client.post(format!("{HOST}{path}")).bearer_auth(key)
        .header("Content-Type", "application/json").header("Accept", "text/event-stream").body(body);
    if claude { request = request.header("anthropic-version", "2023-06-01"); }
    let response = chat_response(request.send().await.map_err(network_error)?).await?;
    stream(response, claude, channel).await
}

#[tauri::command]
async fn send_chat(model_id: String, messages: Vec<Message>, on_event: Channel<Event>, request_id: String, state: State<'_, Gateway>) -> Result<()> {
    if request_id.is_empty() || request_id.len() > 128 { return Err("요청 번호를 확인해 주세요."); }
    let (sender, receiver) = oneshot::channel();
    {
        let mut active = state.active.lock().await;
        if active.contains_key(&request_id) { return Err("이미 진행 중인 요청입니다."); }
        active.insert(request_id.clone(), Some(sender));
    }
    let result = tokio::select! {
        biased;
        _ = receiver => Err("답변 생성을 중지했습니다."),
        result = chat(&state, &model_id, messages, &on_event) => result,
    };
    state.active.lock().await.remove(&request_id);
    result
}

#[tauri::command]
async fn cancel_chat(request_id: String, state: State<'_, Gateway>) -> Result<()> {
    if let Some(sender) = state.active.lock().await.get_mut(&request_id).and_then(Option::take) {

        let _ = sender.send(());
    }
    Ok(())
}

#[tauri::command]
async fn open_school_site() -> Result<()> {
    const SITE: &str = "https://www.daegu.ac.kr/";
    #[cfg(target_os = "windows")]
    let opened = {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let url: Vec<u16> = SITE.encode_utf16().chain(Some(0)).collect();
        // The URL is fixed and its nul-terminated buffer outlives the ShellExecuteW call.
        unsafe { ShellExecuteW(null_mut(), null(), url.as_ptr(), null(), null(), SW_SHOWNORMAL) as isize > 32 }
    };
    #[cfg(target_os = "macos")]
    let opened = std::process::Command::new("/usr/bin/open").arg(SITE).status().is_ok_and(|s| s.success());
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let opened = false;
    if opened { Ok(()) } else { Err("기본 브라우저에서 학교 홈페이지를 열 수 없습니다.") }
}

pub fn run() {
    let client = Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10)).read_timeout(Duration::from_secs(90))
        .timeout(Duration::from_secs(600)).build().expect("HTTPS 초기화 실패");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(Gateway { client, credentials: Mutex::new(None), hash: RandomState::new(), active: Mutex::new(HashMap::new()) })
        .invoke_handler(tauri::generate_handler![connect_key, list_models, forget_key, send_chat, cancel_chat, open_school_site, history::list_threads, history::read_thread, history::write_thread, history::delete_thread])
        .run(tauri::generate_context!()).expect("앱 시작 실패");
}
