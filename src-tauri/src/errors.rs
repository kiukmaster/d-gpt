use reqwest::Response;
use serde::Serialize;
use serde_json::Value;

pub(crate) type ApiResult<T> = Result<T, CommandError>;

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum CommandError {
    Local(&'static str),
    School {
        kind: &'static str,
        status: u16,
        code: Option<String>,
        #[serde(rename = "contextLimit", skip_serializing_if = "Option::is_none")]
        context_limit: Option<bool>,
        reason: &'static str,
        action: &'static str,
    },
}

impl From<&'static str> for CommandError {
    fn from(message: &'static str) -> Self { Self::Local(message) }
}

impl CommandError {
    pub(crate) fn school(status: u16, body: &Value, claude: bool) -> Self {
        let code = body.pointer("/error/code").filter(|value| value.is_string())
            .or_else(|| if claude || body["type"] == "error" { body.pointer("/error/type") } else { None })
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 80 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'));
        let message = body.pointer("/error/message").and_then(Value::as_str);
        let context_limit = code == Some("context_length_exceeded") ||
            (claude && status == 400 && code == Some("invalid_request_error") &&
                message.is_some_and(|text| text.to_ascii_lowercase().starts_with("prompt is too long")));
        let guidance = match (code, message, status) {
            (_, Some("request body too large"), _) | (_, _, 413) =>
                ("질문과 첨부 파일의 전체 크기가 너무 큽니다.", "질문을 줄이거나 더 작은 이미지를 첨부해 주세요."),
            _ if context_limit =>
                ("대화가 모델의 입력 길이 한도에 도달했습니다.", "질문을 줄이거나 새 대화를 시작해 주세요."),
            (Some("insufficient_credit"), _, _) | (_, Some("insufficient credit balance for this request"), 402) =>
                ("학교 크레딧 잔액이 이번 요청에 필요한 금액보다 적습니다.", "학교에서 크레딧 잔액을 확인하고 충전한 뒤 다시 시도해 주세요."),
            (Some("spend_cap_exceeded"), _, _) =>
                ("개인 키 또는 계정의 하루 지출 한도에 도달했습니다.", "진행 중인 답변이 끝난 뒤 다시 시도해 주세요. 계속되면 한국 시간 기준 다음 날 이용해 주세요."),
            (Some("model_not_allowed"), _, _) =>
                ("현재 키로 선택한 모델을 사용할 수 없습니다.", "모델 목록을 새로 확인하고 사용할 수 있는 모델을 선택해 주세요."),
            (Some("duplicate_request"), _, _) | (_, _, 409) =>
                ("학교 서버가 같은 요청을 이미 접수했습니다.", "같은 질문을 다시 보내지 말고 기존 대화를 확인해 주세요."),
            (Some("authentication_error"), _, _) | (_, _, 401) =>
                ("학교 서버가 개인 API 키를 확인하지 못했습니다.", "학교에서 발급한 개인 키를 확인하고 설정에서 다시 연결해 주세요."),
            (Some("permission_denied" | "permission_error"), _, _) | (_, _, 403) =>
                ("현재 키에 이 요청을 처리할 권한이 없습니다.", "학교 담당자에게 계정과 개인 키의 이용 권한을 확인해 주세요."),
            (Some("not_found" | "not_found_error"), _, _) | (_, _, 404) =>
                ("요청한 모델이나 서비스를 찾을 수 없습니다.", "모델 목록에서 사용할 수 있는 대화 모델을 다시 선택해 주세요."),
            (Some("rate_limited" | "rate_limit_error"), _, _) | (_, _, 429) =>
                ("짧은 시간에 요청이 몰려 사용 한도에 도달했습니다.", "진행 중인 답변이 끝날 때까지 기다린 뒤 한 번만 다시 보내 주세요."),
            (_, _, 402) =>
                ("학교 서버가 크레딧 또는 지출 한도 때문에 요청을 거절했습니다.", "학교에서 크레딧 잔액과 오늘의 지출 한도를 확인해 주세요."),
            (Some("invalid_request" | "invalid_request_error"), _, _) | (_, _, 400) =>
                ("학교 서버가 질문이나 첨부 내용을 처리할 수 없습니다.", "질문을 줄이거나 첨부 파일을 빼고 다시 보내 주세요."),
            (Some("upstream_error"), _, _) | (_, _, 502) =>
                ("모델 제공사에서 답변을 처리하지 못했습니다.", "잠시 기다린 뒤 다시 보내 주세요."),
            (Some("service_unavailable" | "overloaded_error"), _, _) | (_, _, 503 | 529) =>
                ("학교 또는 모델 제공사의 서비스를 잠시 사용할 수 없습니다.", "잠시 기다린 뒤 다시 시도해 주세요."),
            (Some("internal_error" | "api_error"), _, _) | (_, _, 500) =>
                ("학교 서버에서 요청을 처리하는 중 오류가 발생했습니다.", "잠시 후 다시 시도해 주세요. 반복되면 학교 담당자에게 오류 정보를 알려 주세요."),
            _ => ("학교 서버가 요청을 끝까지 처리하지 못했습니다.", "잠시 후 다시 시도해 주세요. 반복되면 학교 담당자에게 오류 정보를 알려 주세요."),
        };
        Self::School { kind: "school_api", status, code: code.map(str::to_owned),
            context_limit: context_limit.then_some(true), reason: guidance.0, action: guidance.1 }
    }
}

pub(crate) async fn school_response(mut response: Response, claude: bool) -> ApiResult<Response> {
    if response.status().is_success() { return Ok(response); }
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    let body = loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= 8192 - bytes.len() => bytes.extend_from_slice(&chunk),
            Ok(None) => break serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            _ => break Value::Null,
        }
    };
    Err(CommandError::school(status, &body, claude))
}
