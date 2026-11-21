mod history;
mod errors;
use errors::{school_response, ApiResult, CommandError};

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
    let service = if cfg!(feature = "green-edition") {
        "D-GPT.Green.school.gateway"
    } else {
        "D-GPT.school.gateway"
    };
    keyring::Entry::new(service, "student-key").map_err(|_| STORAGE)
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

#[derive(Clone, Deserialize, Serialize)]
struct Models {
    data: Vec<Value>,
}

async fn fetch_models(client: &Client, key: &str) -> ApiResult<Models> {
    let request = client.get(format!("{HOST}/v1/models"))
        .bearer_auth(key).timeout(Duration::from_secs(15));
    let mut response = school_response(request.send().await.map_err(network_error)?, false).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 { return Err(FORMAT.into()); }
        bytes.extend_from_slice(&chunk);
    }
    let mut models: Models = serde_json::from_slice(&bytes).map_err(|_| FORMAT)?;
    if models.data.iter().any(|model| model["id"].as_str().map_or(true, str::is_empty)) {
        return Err(FORMAT.into());
    }
    models.data.retain(|model| model["id"].as_str().is_some_and(supported_model));
    Ok(models)
}

#[tauri::command]
async fn connect_key(key: String, state: State<'_, Gateway>) -> ApiResult<Models> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("개인 키를 확인해 주세요.".into());
    }
    #[cfg(windows)]
    if key.len() > 1280 {
        return Err("이 키는 Windows 자격 증명 저장소에 보관하기에 너무 깁니다.".into());
    }
    let mut cache = state.credentials.lock().await;
    let models = fetch_models(&state.client, key).await?;
    entry()?.set_password(key).map_err(|_| STORAGE)?;
    *cache = Some((state.hash.hash_one(key), models.clone()));
    cancel_active(&state).await;
    Ok(models)
}

#[tauri::command]
async fn list_models(state: State<'_, Gateway>) -> ApiResult<Models> {
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

fn supported_model(id: &str) -> bool {
    include_str!("../../shared/chat-models.txt").lines().any(|allowed| allowed == id)
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
    let image_allowed = model["input_modalities"].as_array()
        .filter(|values| !values.is_empty() && values.iter().all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty())))
        .map_or(claude, |values| values.iter().any(|v| v == "image"));
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
}

#[derive(Serialize)]
struct ChatResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interruption: Option<&'static str>,
}

#[derive(Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_read: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_write: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uncached_input: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ordinary_input: Option<u64>,
}

impl Usage {
    fn update_claude(&mut self, usage: &Value, delta: bool) {
        self.ordinary_input = usage["input_tokens"].as_u64().or(self.ordinary_input);
        self.cache_read = usage["cache_read_input_tokens"].as_u64().or(self.cache_read);
        self.cache_write = usage["cache_creation_input_tokens"].as_u64().or(self.cache_write);
        self.uncached_input = self.ordinary_input.zip(self.cache_write)
            .and_then(|(ordinary, write)| ordinary.checked_add(write));
        self.input = self.uncached_input.zip(self.cache_read)
            .and_then(|(uncached, read)| uncached.checked_add(read));
        // message_start contains a provisional output count.
        if delta { self.output = usage["output_tokens"].as_u64().or(self.output); }
    }

    fn update_openai(&mut self, usage: &Value) {
        self.input = usage["prompt_tokens"].as_u64().or(self.input);
        self.output = usage["completion_tokens"].as_u64().or(self.output);
        self.total = usage["total_tokens"].as_u64().or(self.total);
        let details = &usage["prompt_tokens_details"];
        self.cache_read = details["cached_tokens"].as_u64().or(self.cache_read);
        self.cache_write = details["cache_write_tokens"].as_u64().or(self.cache_write);
        self.uncached_input = self.input.zip(self.cache_read)
            .and_then(|(input, read)| input.checked_sub(read));
    }
}

fn dispatch(data: &str, status: u16, claude: bool, channel: &Channel<Event>, finish: &mut Option<String>, usage: &mut Usage) -> ApiResult<bool> {
    if !claude && data.trim() == "[DONE]" { return Ok(true); }
    let value: Value = serde_json::from_str(data).map_err(|_| FORMAT)?;
    if value.get("error").is_some() || value["type"] == "error" {
        return Err(CommandError::school(status, &value, claude));
    }
    if claude && value["type"] == "message_stop" { return Ok(true); }
    let reason = if claude { value.pointer("/delta/stop_reason") } else { value.pointer("/choices/0/finish_reason") };
    if let Some(reason) = reason.and_then(Value::as_str) { *finish = Some(reason.to_owned()); }
    let text = if claude { value.pointer("/delta/text") } else { value.pointer("/choices/0/delta/content") };
    if let Some(text) = text.and_then(Value::as_str).filter(|s| !s.is_empty()) {
        channel.send(Event::Text { text: text.to_owned() }).map_err(|_| "대화 화면이 닫혔습니다.")?;
    }
    if claude {
        if let Some(start) = value.pointer("/message/usage") { usage.update_claude(start, false); }
        if value["type"] == "message_delta" && value["usage"].is_object() {
            usage.update_claude(&value["usage"], true);
        }
    } else if value["usage"].is_object() && (finish.is_some() || value["choices"].as_array().is_some_and(Vec::is_empty)) {
        usage.update_openai(&value["usage"]);
    }
    Ok(false)
}

async fn stream(mut response: Response, claude: bool, channel: &Channel<Event>) -> ApiResult<ChatResult> {
    let mut finish = None;
    let mut usage = Usage::default();
    let mut line = Vec::new();
    let mut data = String::new();
    let mut after_cr = false;
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        for &byte in chunk.as_ref() {
            if byte == b'\n' && after_cr { after_cr = false; continue; }
            after_cr = byte == b'\r';
            if !after_cr && byte != b'\n' {
                line.push(byte);
                if line.len() + data.len() > 1024 * 1024 { return Err(FORMAT.into()); }
                continue;
            }
            let field = std::str::from_utf8(&line).map_err(|_| FORMAT)?;
            if field.is_empty() && !data.is_empty() {
                if dispatch(data.trim_end_matches('\n'), response.status().as_u16(), claude, channel, &mut finish, &mut usage)? {
                    usage.total = usage.total.or_else(|| usage.input?.checked_add(usage.output?));
                    let interruption = match finish.as_deref().ok_or("답변 완료 상태를 확인할 수 없습니다.")? {
                        "length" | "max_tokens" | "model_context_window_exceeded" => Some("답변 길이 한도에 도달했습니다."),
                        "content_filter" | "refusal" => Some("모델이 답변 생성을 중단했습니다."),
                        _ => None,
                    };
                    return Ok(ChatResult { usage: (usage != Usage::default()).then_some(usage), interruption });
                }
                data.clear();
            } else if let Some(part) = field.strip_prefix("data:") {
                data.push_str(part.strip_prefix(' ').unwrap_or(part));
                data.push('\n');
            }
            line.clear();
        }
    }
    Err("답변을 모두 받기 전에 연결이 끊어졌습니다.".into())
}

async fn chat(state: &Gateway, model_id: &str, messages: Vec<Message>, channel: &Channel<Event>) -> ApiResult<ChatResult> {
    if !supported_model(model_id) { return Err("지원하지 않는 모델입니다.".into()); }
    let claude = model_id.starts_with("claude-");
    let (key, model) = {
        let mut cache = state.credentials.lock().await;
        let key = saved_key()?;
        let fingerprint = state.hash.hash_one(key.as_str());
        if cache.as_ref().map(|(id, _)| *id) != Some(fingerprint) {
            *cache = Some((fingerprint, fetch_models(&state.client, &key).await?));
        }
        let model = match cache.as_ref().and_then(|(_, models)| models.data.iter().find(|m| m["id"] == model_id)) {
            Some(model) => model.clone(),
            None if claude => json!({ "id": model_id }),
            None => return Err("현재 키에서 사용할 수 없는 모델입니다.".into()),
        };
        (key, model)
    };
    if matches!(model["model_type"].as_str(), Some("embedding" | "image_generation" | "video_generation" | "transcription" | "speech")) {
        return Err("이 모델은 대화를 지원하지 않습니다.".into());
    }
    let body = chat_body(&model, messages, claude)?;
    let path = if claude { "/v1/messages" } else { "/v1/chat/completions" };
    let request = state.client.post(format!("{HOST}{path}"))
        .header("Content-Type", "application/json").header("Accept", "text/event-stream").body(body);
    let request = if claude {
        request.header("x-api-key", key).header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(key)
    };
    let response = school_response(request.send().await.map_err(network_error)?, claude).await?;
    stream(response, claude, channel).await
}

#[tauri::command]
async fn send_chat(model_id: String, messages: Vec<Message>, on_event: Channel<Event>, request_id: String, state: State<'_, Gateway>) -> ApiResult<ChatResult> {
    if request_id.is_empty() || request_id.len() > 128 { return Err("요청 번호를 확인해 주세요.".into()); }
    let (sender, receiver) = oneshot::channel();
    {
        let mut active = state.active.lock().await;
        if active.contains_key(&request_id) { return Err("이미 진행 중인 요청입니다.".into()); }
        active.insert(request_id.clone(), Some(sender));
    }
    let result = tokio::select! {
        biased;
        _ = receiver => Err("답변 생성을 중지했습니다.".into()),
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
