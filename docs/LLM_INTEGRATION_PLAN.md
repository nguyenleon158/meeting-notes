# MeetNote AI — LLM Integration Plan

## 1. Mục tiêu

Cho phép người dùng chọn dịch vụ AI dùng để xử lý transcript thành meeting note mà không làm thay đổi luồng ghi âm và transcription hiện tại.

Phạm vi phiên bản đầu:

- Codex qua tài khoản ChatGPT/Codex CLI hiện có.
- DeepSeek API.
- Google Gemini API.
- Một contract đầu ra chung cho summary, key points, decisions, action items và open questions.
- Chọn provider mặc định trong Settings và có thể chọn lại khi Generate/Regenerate summary.
- Dùng cùng provider cho tính năng gợi ý meeting title.

Không nằm trong phạm vi phiên bản đầu:

- Thay Soniox bằng dịch vụ speech-to-text khác.
- Gửi audio trực tiếp cho LLM để thay transcript pipeline.
- Tự động failover sang provider khác mà chưa có sự đồng ý của người dùng.
- Marketplace/plugin system cho provider tùy ý.

## 2. Review kiến trúc hiện tại

### Điểm đang làm tốt

- API key Soniox được giữ ở server và macOS Keychain, không gửi xuống browser.
- Transcript được validate trước khi tạo prompt.
- Prompt coi transcript là dữ liệu không đáng tin cậy và đã có chỉ dẫn chống prompt injection.
- Summary và title đã có JSON Schema riêng.
- UI, storage và server giao tiếp qua endpoint local rõ ràng.

### Vấn đề cần xử lý trước khi thêm provider

- `server.js` đang gắn cứng Codex vào status check, queue, summary, title và error message.
- `js/summary.js` giả định mọi lỗi đều đến từ Codex.
- Settings chỉ hiển thị Codex login, chưa có khái niệm provider/model mặc định.
- JSON Schema hiện chỉ được Codex CLI enforce; provider API mới cần validation chung ở server.
- Summary đã lưu nội dung nhưng chưa lưu đầy đủ provider, model, prompt version, usage và thời điểm tạo.
- Transcript dài chưa có chiến lược chia đoạn; giới hạn hiện tại chủ yếu là giới hạn kích thước HTTP, không phải token budget của model.
- Queue hiện chỉ có một queue tên Codex; kiến trúc này không mở rộng tốt cho nhiều provider.
- Hàm Keychain có thông báo lỗi gắn cứng tên Soniox và chưa có thao tác xóa/test secret theo provider.

## 3. UX đề xuất

### Settings → Integrations

Tách thành hai nhóm rõ ràng:

1. **Speech & Translation**
   - Soniox status và API key như hiện tại.

2. **Meeting Notes AI**
   - Select `Default provider`: Codex, DeepSeek hoặc Gemini.
   - Select `Model`: danh sách model được app hỗ trợ cho provider đang chọn.
   - Trạng thái: `Ready`, `Setup required`, `Unavailable` hoặc `Invalid credentials`.
   - Codex: nút/check hướng dẫn đăng nhập bằng `codex login`; không có ô API key.
   - DeepSeek/Gemini: ô API key, nút `Save`, `Test connection`, `Remove key`.
   - Copy giải thích transcript sẽ được gửi đến provider được chọn; audio không được gửi.

### Meeting Detail → Summary

- Bên cạnh nút `Generate Summary`, thêm select nhỏ:
  - `Use default — Gemini`
  - `Codex`
  - `DeepSeek`
  - `Gemini`
- Khi đã có summary, hiển thị metadata ngắn: `Generated with Gemini · <model> · <time>`.
- `Regenerate` phải dùng lựa chọn hiện tại và không tự động chuyển provider khi lỗi.
- AI title dùng provider mặc định; phase sau có thể cho phép chọn riêng nếu thật sự cần.

## 4. Kiến trúc mục tiêu

### 4.1 Provider contract ở server

Tạo thư mục `server/llm/`:

```text
server/llm/
├── index.js              # registry và public service
├── contracts.js          # normalize request/result, validation
├── prompts.js            # prompt summary/title, promptVersion
├── transcript-budget.js  # token budget và chunking
└── providers/
    ├── codex.js
    ├── deepseek.js
    └── gemini.js
```

Mỗi adapter phải triển khai:

```js
{
  id,
  getStatus(),
  listModels(),
  generateSummary({ meeting, model }),
  suggestTitle({ meeting, model })
}
```

`server.js` chỉ gọi service chung:

```js
llm.generateSummary({ providerId, modelId, meeting })
llm.suggestTitle({ providerId, modelId, meeting })
```

Không để route biết chi tiết request/response của DeepSeek, Gemini hay Codex.

### 4.2 Contract đầu ra chung

Giữ `schemas/meeting-summary.schema.json` và `schemas/meeting-title.schema.json` làm nguồn sự thật duy nhất.

Mọi adapter phải trả về cùng cấu trúc:

```json
{
  "summary": "...",
  "keyPoints": [],
  "decisions": [],
  "actionItems": [
    { "text": "...", "assignee": "", "dueDate": "" }
  ],
  "openQuestions": []
}
```

Server phải validate kết quả sau khi provider trả về, kể cả khi provider hỗ trợ JSON/structured output. Nếu JSON sai schema:

1. Thử repair/retry đúng một lần bằng prompt ngắn, không gửi thêm dữ liệu ngoài transcript đã có.
2. Nếu vẫn sai, trả lỗi chuẩn `LLM_INVALID_OUTPUT`.
3. Không lưu partial result vào meeting.

### 4.3 Adapter cụ thể

**Codex**

- Giữ `codex exec --ephemeral --sandbox read-only --output-schema` như hiện tại.
- Không truyền API key qua browser.
- Cho phép model mặc định của Codex; chỉ thêm chọn model khi app có allowlist đã kiểm thử.
- Giữ queue tuần tự để tránh nhiều tiến trình Codex chạy đồng thời.

**DeepSeek**

- Gọi endpoint cố định phía server; không cho client truyền base URL.
- Dùng Chat Completions và JSON output.
- Luôn nhắc model trả JSON trong prompt, sau đó validate bằng schema nội bộ.
- Model ID lấy từ registry/allowlist server, không tin model tùy ý từ client.

**Gemini**

- Gọi Gemini API từ server bằng API key trong Keychain.
- Dùng structured output/response schema khi model hỗ trợ.
- Dùng system instruction chung và normalize response về contract của app.
- Model ID lấy từ registry/allowlist server.

## 5. Settings, secrets và API nội bộ

### Settings không nhạy cảm

Lưu trong `storage/settings.json`:

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

Các giá trị này được đưa vào backup. API key không bao giờ nằm trong settings hoặc backup.

### Secrets

Lưu bằng macOS Keychain với account riêng:

- `soniox-api-key`
- `deepseek-api-key`
- `gemini-api-key`

Hỗ trợ environment variable cho development:

- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`

Thêm helper Keychain dùng chung với message trung lập và thao tác read/write/delete. Không trả secret về browser.

### Endpoint đề xuất

```text
GET    /api/llm/providers
PUT    /api/llm/providers/:providerId/key
DELETE /api/llm/providers/:providerId/key
POST   /api/llm/providers/:providerId/test
POST   /api/summary
POST   /api/title-suggestion
```

`GET /api/llm/providers` chỉ trả metadata an toàn:

```json
{
  "defaultProvider": "gemini",
  "providers": [
    {
      "id": "gemini",
      "name": "Google Gemini",
      "configured": true,
      "available": true,
      "models": []
    }
  ]
}
```

Request generate:

```json
{
  "provider": "gemini",
  "model": "<supported-model-id>",
  "meeting": { "...": "validated meeting payload" }
}
```

Server luôn resolve provider/model qua registry và allowlist. Không cho client truyền endpoint, command hoặc tùy chọn CLI.

## 6. Xử lý transcript dài

Không gửi toàn bộ transcript một cách mù quáng. Thêm pipeline provider-neutral:

1. Normalize transcript, bỏ segment rỗng và giới hạn độ dài từng segment.
2. Tính budget theo provider/model.
3. Transcript vừa budget: tạo summary một lượt.
4. Transcript vượt budget: chia theo mốc thời gian, giữ nguyên speaker và thứ tự.
5. Tạo partial facts cho từng chunk.
6. Tổng hợp partial facts thành output cuối theo schema.
7. Chỉ lưu output cuối sau khi validate thành công.

Chunk prompt phải yêu cầu giữ facts, decisions, action items và open questions; không tạo văn phong dài ở bước trung gian để giảm token và mất thông tin.

## 7. Metadata và storage

Thêm vào meeting:

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

Không ghi reasoning/thinking nội bộ của provider. Chỉ lưu output meeting note và usage metadata cần thiết.

Khi regenerate:

- Ghi đè `summary` và `summaryDetails` sau khi request mới thành công.
- Cập nhật `summaryGeneration`.
- Không tự động ghi đè action items đã được người dùng chỉnh sửa. UI phải hỏi hoặc chỉ import action items mới khi danh sách hiện tại trống, giữ hành vi an toàn đang có.

## 8. Error contract và reliability

Chuẩn hóa lỗi server:

```json
{
  "error": {
    "code": "LLM_AUTH_REQUIRED",
    "message": "Gemini API key is not configured.",
    "provider": "gemini",
    "retryable": false
  }
}
```

Các code tối thiểu:

- `LLM_PROVIDER_NOT_FOUND`
- `LLM_MODEL_NOT_SUPPORTED`
- `LLM_AUTH_REQUIRED`
- `LLM_AUTH_INVALID`
- `LLM_RATE_LIMITED`
- `LLM_TIMEOUT`
- `LLM_CONTEXT_TOO_LARGE`
- `LLM_INVALID_OUTPUT`
- `LLM_PROVIDER_UNAVAILABLE`

Áp dụng timeout và `AbortController` cho API provider. Chỉ retry lỗi mạng, 429 và 5xx với backoff ngắn; không retry 401/403 hoặc validation error vô hạn.

## 9. Security và privacy checklist

- Secret chỉ tồn tại ở environment/Keychain và server process.
- Không log API key, Authorization header hoặc raw provider response có dữ liệu nhạy cảm.
- Endpoint provider là constant trong code để tránh SSRF.
- Validate provider ID, model ID, meeting payload và provider output.
- Giữ instruction chống prompt injection hiện tại cho cả summary và title.
- Hiển thị rõ transcript được gửi cho provider đã chọn; audio vẫn local và không được gửi cho LLM note pipeline.
- Backup chứa provider/model metadata nhưng không chứa secret.
- Nút xóa key phải xóa đúng Keychain account và cập nhật status ngay.

## 10. Kế hoạch triển khai theo phase

### Phase 1 — Refactor không đổi hành vi

- Tách prompt, validation và Codex adapter khỏi `server.js`.
- Tạo registry/service và giữ Codex là provider duy nhất.
- Đổi `js/summary.js` sang lỗi trung lập, không nhắc Codex.
- Thêm metadata `summaryGeneration`.
- Viết contract tests cho Codex adapter và route summary/title.

**Definition of done:** UI và chức năng hiện tại không đổi; Codex chạy qua provider contract mới.

### Phase 2 — Provider settings và secret management

- Thêm settings `llmProvider`, `llmModels` và migration mặc định sang Codex.
- Tạo API list/status/test/save/delete provider.
- Refactor Keychain helper dùng chung.
- Làm UI Meeting Notes AI trong Settings.
- Không cho chọn provider chưa Ready làm default.

**Definition of done:** người dùng xem, cấu hình, test và chọn provider mặc định; secret không xuất hiện trong browser/API/backup.

### Phase 3 — DeepSeek và Gemini adapters

- Implement DeepSeek adapter.
- Implement Gemini adapter.
- Dùng structured output phù hợp từng provider và validation chung.
- Normalize usage/error/timeout.
- Thêm mock tests cho success, invalid JSON, auth error, rate limit và timeout.

**Definition of done:** cùng một transcript tạo output đúng schema bằng cả ba provider.

### Phase 4 — Meeting-level selector và provenance

- Thêm provider selector cạnh Generate/Regenerate.
- Hiển thị provider/model/time của summary hiện tại.
- AI title dùng default provider.
- Giữ summary cũ nếu request mới thất bại.

**Definition of done:** người dùng chọn provider cho từng lần generate và luôn biết note được tạo bởi provider/model nào.

### Phase 5 — Transcript dài, hardening và release

- Thêm budget/chunk/synthesis pipeline.
- Thêm retry/backoff và queue giới hạn concurrency theo provider.
- E2E test Settings → configure → test → select → generate → regenerate.
- Kiểm tra migration backup cũ, app restart và packaged macOS build.
- Cập nhật privacy copy, README và release notes.

**Definition of done:** transcript dài hoạt động ổn định; lỗi provider không làm mất summary/action items hiện có; bản `.app` và DMG đã được test.

## 11. Test matrix bắt buộc

| Nhóm | Ca kiểm thử |
|---|---|
| Provider contract | Codex, DeepSeek, Gemini trả cùng schema |
| Credentials | thiếu key, key sai, key bị xóa, Codex chưa login |
| Output | JSON hợp lệ, JSON sai, thiếu field, field dư, output bị cắt |
| Network | timeout, mất mạng, 429, 5xx |
| Transcript | rỗng, ngắn, đa ngôn ngữ, rất dài, có prompt injection |
| Storage | metadata provider/model được lưu, secret không vào backup |
| UX | provider chưa Ready không thể làm default; regenerate thất bại giữ summary cũ |
| Migration | settings/backup v1 cũ mặc định về Codex mà không mất dữ liệu |

## 12. Thứ tự ưu tiên đề xuất

Không triển khai ba provider trực tiếp trong `server.js`. Làm Phase 1 và Phase 2 trước, sau đó thêm Gemini và DeepSeek như hai adapter độc lập. Thứ tự này tạo nền ổn định, giảm regression và giúp thêm OpenAI API, Anthropic hoặc local model sau này mà không phải sửa lại UI và route.

## 13. Tài liệu kỹ thuật tham chiếu

- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive/
- DeepSeek Chat Completions: https://api-docs.deepseek.com/api/create-chat-completion/
- Gemini generateContent: https://ai.google.dev/api/generate-content
