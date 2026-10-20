# Handoff cho Claude — Multi-LLM Meeting Notes

## Yêu cầu

Implement tính năng chọn LLM dùng để xử lý transcript thành meeting note trong MeetNote AI.

Provider cần hỗ trợ ở bản đầu:

1. Codex qua Codex CLI/login hiện tại.
2. DeepSeek API.
3. Google Gemini API.

Soniox vẫn là dịch vụ speech-to-text và live translation. Không thay đổi transcription pipeline và không gửi audio cho các LLM nói trên; chỉ gửi meeting metadata và transcript.

Đọc plan đầy đủ trước khi code:

- `docs/LLM_INTEGRATION_PLAN.md`

## Trạng thái code hiện tại

- Backend là Node.js thuần trong `server.js`, không dùng framework.
- Frontend là vanilla JavaScript trong `js/`.
- Codex summary/title hiện đang gắn cứng trong `server.js`.
- Prompt summary/title và Codex CLI execution nằm chung trong `server.js`.
- Client gọi summary qua `js/summary.js`.
- Settings UI và integration status nằm trong `js/app.js`.
- Settings/meeting persistence nằm trong `js/storage.js`.
- Secret Soniox đang lưu trong macOS Keychain service `meetnote-local`.
- Output schema hiện có:
  - `schemas/meeting-summary.schema.json`
  - `schemas/meeting-title.schema.json`
- Có thay đổi gần đây để tự chuyển recording bị treo thành `interrupted`; phải giữ nguyên hành vi này.

## Kết quả mong muốn trên UI

### Settings → Integrations

Giữ nhóm Soniox hiện tại và thêm nhóm **Meeting Notes AI**:

- Dropdown `Default provider`: Codex, DeepSeek, Gemini.
- Dropdown `Model` theo provider.
- Status từng provider: Ready, Setup required, Invalid credentials hoặc Unavailable.
- Codex hiển thị trạng thái login hiện tại.
- DeepSeek/Gemini có ô API key.
- Có thao tác Save key, Test connection và Remove key.
- Không cho provider chưa Ready trở thành default.
- Hiển thị rõ: transcript sẽ được gửi đến provider được chọn; audio không được gửi.

### Meeting Detail → Summary

- Thêm provider selector cạnh `Generate Summary`/`Regenerate`.
- Có lựa chọn `Use default — <provider>` và từng provider cụ thể.
- Generate request dùng provider/model đã chọn.
- Hiển thị metadata sau khi tạo: provider, model và thời gian.
- Nếu regenerate thất bại, giữ nguyên summary/action items cũ.
- AI title dùng default provider.

## Kiến trúc bắt buộc

Không thêm một chuỗi `if/else` provider vào `server.js`.

Tách provider layer, đề xuất:

```text
server/llm/
├── index.js
├── contracts.js
├── prompts.js
├── transcript-budget.js
└── providers/
    ├── codex.js
    ├── deepseek.js
    └── gemini.js
```

Mỗi adapter triển khai contract tương đương:

```js
{
  id,
  getStatus(),
  listModels(),
  generateSummary({ meeting, model }),
  suggestTitle({ meeting, model })
}
```

`server.js` chỉ parse/validate HTTP request rồi gọi LLM service chung.

Codex adapter phải giữ các giới hạn an toàn hiện tại:

- `codex exec`
- `--ephemeral`
- `--sandbox read-only`
- `--skip-git-repo-check`
- `--ignore-user-config`
- `--ignore-rules`
- `--output-schema`

## Unified output contract

Mọi provider phải trả đúng schema hiện tại:

```json
{
  "summary": "string",
  "keyPoints": ["string"],
  "decisions": ["string"],
  "actionItems": [
    {
      "text": "string",
      "assignee": "string",
      "dueDate": "string"
    }
  ],
  "openQuestions": ["string"]
}
```

Requirements:

- Server validate output của tất cả provider bằng cùng contract.
- Không tin JSON chỉ vì provider bật JSON mode/structured output.
- Nếu output sai schema, cho phép repair/retry đúng một lần.
- Nếu vẫn sai, trả lỗi `LLM_INVALID_OUTPUT`.
- Không lưu partial/invalid result.
- Không lưu reasoning/thinking content.

## Provider implementation

### Codex

- Di chuyển logic hiện tại sang adapter, không viết lại hành vi từ đầu.
- Giữ queue tuần tự cho Codex process.
- Codex có thể dùng model mặc định; chỉ cho chọn model nếu có allowlist rõ ràng.

### DeepSeek

- API call chỉ chạy ở backend.
- Dùng fixed official base URL trong code; client không được truyền endpoint.
- Dùng Chat Completions JSON output.
- Prompt phải yêu cầu JSON rõ ràng, sau đó validate lại ở server.
- Provider/model phải được resolve từ registry allowlist.

### Gemini

- API call chỉ chạy ở backend.
- Dùng Gemini generateContent và structured output/response schema khi model hỗ trợ.
- Normalize response về unified output contract.
- Provider/model phải được resolve từ registry allowlist.

Không hardcode model hiện tại vào nhiều file. Khai báo model support/default trong một registry duy nhất để dễ cập nhật.

## Settings và secrets

Settings không nhạy cảm:

```json
{
  "llmProvider": "codex",
  "llmModels": {
    "codex": "default",
    "deepseek": "<supported-model-id>",
    "gemini": "<supported-model-id>"
  }
}
```

Secret phải dùng macOS Keychain service `meetnote-local`:

- `deepseek-api-key`
- `gemini-api-key`

Environment fallback cho development:

- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`

Refactor Keychain helper hiện tại để:

- Read/write/delete secret theo account.
- Error message không gắn cứng Soniox.
- Không bao giờ trả key về browser.
- Không ghi key vào log, settings, meeting, artifact hoặc backup.

## API nội bộ cần có

```text
GET    /api/llm/providers
PUT    /api/llm/providers/:providerId/key
DELETE /api/llm/providers/:providerId/key
POST   /api/llm/providers/:providerId/test
POST   /api/summary
POST   /api/title-suggestion
```

Summary/title request có thể truyền provider/model nhưng server phải kiểm tra registry allowlist. Không cho client truyền URL, command hoặc CLI flags.

Chuẩn hóa error response tối thiểu:

- `LLM_PROVIDER_NOT_FOUND`
- `LLM_MODEL_NOT_SUPPORTED`
- `LLM_AUTH_REQUIRED`
- `LLM_AUTH_INVALID`
- `LLM_RATE_LIMITED`
- `LLM_TIMEOUT`
- `LLM_CONTEXT_TOO_LARGE`
- `LLM_INVALID_OUTPUT`
- `LLM_PROVIDER_UNAVAILABLE`

## Transcript dài

Phải có provider-neutral transcript budget:

1. Normalize transcript.
2. Nếu vừa context budget, generate một lượt.
3. Nếu quá budget, chunk theo thứ tự thời gian và speaker.
4. Tạo partial facts cho từng chunk.
5. Synthesize partial facts thành output cuối.
6. Validate output cuối rồi mới lưu.

Không cắt transcript âm thầm mà không báo lỗi hoặc chunk.

## Metadata cần lưu

Sau khi generate thành công, lưu:

```json
{
  "summaryGeneration": {
    "provider": "gemini",
    "model": "<model-id>",
    "promptVersion": "meeting-summary-v2",
    "generatedAt": "ISO-8601",
    "inputTokens": 0,
    "outputTokens": 0,
    "estimatedCostUsd": null
  }
}
```

Usage field nào provider không trả thì dùng `null`, không đoán số liệu.

Update sanitization, import/export và summary artifact để giữ metadata này. Backup vẫn tuyệt đối không chứa secret.

## Quy tắc action items khi regenerate

- Không ghi đè action items người dùng đã chỉnh sửa.
- Có thể giữ hành vi hiện tại: chỉ import AI action items khi danh sách đang rỗng.
- Summary hiện tại chỉ được thay sau khi request mới thành công hoàn toàn.

## Thứ tự thực hiện

### Milestone 1 — Refactor Codex

- Tạo provider contract/registry.
- Di chuyển prompts và Codex logic khỏi `server.js`.
- Route summary/title dùng service mới.
- Client error copy trở thành provider-neutral.
- Không thay đổi UX trong milestone này.

### Milestone 2 — Settings và credentials

- Thêm settings migration mặc định về Codex.
- Thêm provider status/list/test/key APIs.
- Refactor Keychain helper.
- Thêm Meeting Notes AI UI.

### Milestone 3 — Gemini và DeepSeek

- Implement adapters.
- Structured output + common validation.
- Normalize usage và errors.

### Milestone 4 — Meeting selector và metadata

- Provider selector trên Summary tab.
- Provider/model/time provenance.
- AI title qua default provider.

### Milestone 5 — Transcript dài và hardening

- Chunk/synthesis.
- Timeout, AbortController, bounded retry/backoff.
- Concurrency limit theo provider.
- Full regression và packaged app test.

## Acceptance criteria

- Cùng một meeting có thể generate bằng Codex, DeepSeek hoặc Gemini.
- Output của cả ba provider luôn được normalize/validate theo cùng schema.
- User chọn được default provider và override theo từng lần generate.
- Provider chưa cấu hình không thể chạy và trả lỗi dễ hiểu.
- API key không xuất hiện trong response, browser storage, settings, meeting, artifacts, logs hoặc backup.
- Regenerate lỗi không làm mất summary/action items hiện có.
- AI title hoạt động qua default provider.
- Transcript dài không bị cắt âm thầm.
- App restart vẫn giữ default provider/model và provider status đúng.
- Backup v1 cũ import được, mặc định LLM provider là Codex.
- Soniox recording/transcription và trạng thái `interrupted` không bị regression.
- `node --check` pass cho toàn bộ JavaScript đã sửa.
- Có test cho adapter contract, route, credentials error, invalid output, timeout và migration.
- Dashboard, recording, settings, meeting detail được smoke-test trên UI local.
- Build `.app`/DMG cuối cùng chạy đúng với storage ở Application Support.

## Các file dự kiến thay đổi

- `server.js`
- `js/app.js`
- `js/summary.js`
- `js/storage.js`
- `schemas/meeting-summary.schema.json` nếu validator cần điều chỉnh tương thích
- `README.md`
- Các file mới trong `server/llm/`
- Test files mới

Không sửa dữ liệu meeting hiện có bằng migration phá hủy. Không xóa audio/transcript/summary cũ.

## Tài liệu chính thức

- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive/
- DeepSeek Chat Completions: https://api-docs.deepseek.com/api/create-chat-completion/
- Gemini generateContent: https://ai.google.dev/api/generate-content
