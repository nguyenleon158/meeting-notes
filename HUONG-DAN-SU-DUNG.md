# MeetNote AI — Hướng dẫn cài đặt và sử dụng

Tài liệu này áp dụng cho **MeetNote AI v1.1.1 trên Windows 10/11 x64 và macOS 13 trở lên dùng Apple Silicon**.

## 1. MeetNote AI làm được gì?

MeetNote AI hỗ trợ:

- Ghi âm microphone và âm thanh từ cuộc họp trực tuyến.
- Chuyển giọng nói thành văn bản theo thời gian thực.
- Tải file ghi âm có sẵn để tạo transcript.
- Dịch trực tiếp nội dung cuộc họp khi dùng Soniox.
- Tạo tóm tắt, quyết định và action items bằng Codex, DeepSeek hoặc Gemini.
- Sửa transcript, ghi chú, tìm kiếm và xuất từng cuộc họp ra Markdown.
- Sao lưu và khôi phục dữ liệu bằng file JSON.

> MeetNote chạy trên máy của bạn, nhưng tính năng nhận dạng giọng nói và AI sẽ gửi audio hoặc transcript tới nhà cung cấp đã chọn.

## 2. Cài và mở MeetNote trên Windows

### Yêu cầu

- Windows 10 hoặc Windows 11 bản 64-bit.
- Kết nối Internet cho speech-to-text và AI.
- Microsoft Edge hoặc Google Chrome phiên bản mới.
- Quyền sử dụng microphone nếu muốn ghi âm trực tiếp.

### Cách mở

1. Tải file `MeetNote-1.1.1-windows-x64.exe` về máy.
2. Nên để file trong một thư mục cố định, ví dụ `Documents\MeetNote`.
3. Nhấp đúp vào file EXE.
4. Lần đầu chạy, MeetNote giải nén runtime cục bộ rồi tự mở trình duyệt tại:

   ```text
   http://127.0.0.1:8765
   ```

5. Nếu trình duyệt không tự mở, hãy nhập địa chỉ trên vào Edge hoặc Chrome.

MeetNote là bản portable, không cần cài Node.js và không cần chạy bộ cài riêng.

### Nếu Windows SmartScreen cảnh báo

Bản v1.1.1 hiện chưa có chữ ký code-signing nên Windows có thể hiện cảnh báo. Chỉ tiếp tục nếu file được nhận từ nguồn tin cậy:

1. Chọn **More info**.
2. Kiểm tra đúng tên file.
3. Chọn **Run anyway**.

SHA-256 của bản phát hành hiện tại:

```text
3f0deee06faf9dd2e71dfabf32d637ff55633fd332af3fb74d3729242f4da62d
```

Kiểm tra bằng PowerShell:

```powershell
Get-FileHash .\MeetNote-1.1.1-windows-x64.exe -Algorithm SHA256
```

## 3. Cài MeetNote bằng DMG trên macOS

### Yêu cầu

- macOS 13 Ventura trở lên.
- Máy Mac Apple Silicon: M1, M2, M3, M4 hoặc mới hơn.
- Safari, Google Chrome hoặc Microsoft Edge phiên bản mới.
- Kết nối Internet và quyền microphone nếu muốn ghi âm trực tiếp.

### Cách cài

1. Tải file `MeetNote-1.1.1-arm64.dmg` về máy.
2. Nhấp đúp vào file DMG để mở.
3. Kéo **MeetNote.app** vào thư mục **Applications** trong cửa sổ cài đặt.
4. Eject ổ đĩa **MeetNote** sau khi sao chép xong.
5. Mở **Applications**, tìm MeetNote rồi nhấp đúp để chạy.
6. MeetNote tự khởi động local server và mở trình duyệt tại:

   ```text
   http://127.0.0.1:8765
   ```

Bản macOS đã kèm Node.js runtime, không cần cài Node.js riêng.

SHA-256 của DMG hiện tại:

```text
2f9b6ba021e63bc8af47e479527a512aba0f49eb4ae6d11c30994b74f117bf77
```

Kiểm tra bằng Terminal:

```bash
shasum -a 256 ~/Downloads/MeetNote-1.1.1-arm64.dmg
```

### Nếu macOS chặn app vì chưa xác minh nhà phát triển

Bản v1.1.1 hiện được ký ad-hoc, chưa notarize bằng Apple Developer ID. Chỉ mở app nếu DMG đến từ nguồn tin cậy và checksum khớp:

1. Thử mở MeetNote một lần để macOS ghi nhận cảnh báo.
2. Mở **System Settings → Privacy & Security**.
3. Cuộn xuống phần Security và chọn **Open Anyway** cạnh MeetNote.
4. Xác nhận **Open** và nhập mật khẩu/Touch ID nếu được hỏi.

Cũng có thể Control-click vào **MeetNote.app** trong Applications, chọn **Open**, rồi xác nhận **Open** nếu tùy chọn này xuất hiện. Không cần tắt Gatekeeper toàn hệ thống.

### Cấp quyền trên macOS

- Khi trình duyệt hỏi microphone, chọn **Allow**.
- Nếu đã từ chối, vào **System Settings → Privacy & Security → Microphone** và bật quyền cho trình duyệt đang dùng.
- Khi bật **System Audio**, chọn đúng tab/cửa sổ chia sẻ và bật chia sẻ âm thanh nếu trình duyệt cung cấp tùy chọn.
- Nếu đổi quyền mà app chưa nhận, đóng trình duyệt rồi mở lại MeetNote.

## 4. Thiết lập speech-to-text

Mở **Settings → Speech & Translation**.

1. Chọn **Default Provider**.
2. Chọn model nếu nhà cung cấp có nhiều model.
3. Nhập API key.
4. Chọn **Save Key**.
5. Chọn **Test Connection** và kiểm tra trạng thái chuyển thành **Ready**.
6. Chọn **Save Settings** ở cuối trang.

API key được bảo vệ bằng Windows DPAPI trên Windows hoặc macOS Keychain trên Mac. Key không nằm trong file backup và không được trả lại cho trình duyệt.

### Chọn nhà cung cấp nào?

| Provider | Ghi âm trực tiếp | Upload audio | Dịch trực tiếp | Lưu ý |
| --- | --- | --- | --- | --- |
| Soniox | Có | Có | Có | Khuyến nghị nếu cần transcript đa ngôn ngữ và dịch live. |
| Deepgram | Có | Có | Không | Live cần API key có quyền tạo temporary token; upload vẫn có thể hoạt động nếu thiếu quyền này. |
| OpenAI Whisper | Không | Có | Không | File tối đa 25 MB. Live recording sẽ fallback sang Soniox. |
| Google Speech-to-Text | Không | Có | Không | File inline khoảng 10 MB; hỗ trợ tốt WebM/Opus, MP3, OGG, WAV và FLAC. Live recording sẽ fallback sang Soniox. |

Nếu chọn Whisper hoặc Google nhưng vẫn muốn ghi trực tiếp, cần cấu hình thêm Soniox vì app dùng Soniox cho luồng live fallback.

## 5. Kết nối Codex để tạo summary

MeetNote không nhúng Codex CLI riêng. Bạn cần cài Codex CLI một lần rồi đăng nhập bằng tài khoản ChatGPT. Nếu Mac đã cài ứng dụng ChatGPT trong `/Applications`, MeetNote cũng có thể dùng Codex đi kèm ứng dụng đó.

### Bước 1 — Cài Codex CLI trên Windows

Mở **PowerShell** và chạy lệnh cài chính thức:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Sau khi cài xong, đóng PowerShell và mở lại một cửa sổ PowerShell mới.

### Bước 1 — Cài Codex CLI trên macOS

Mở **Terminal** và chạy lệnh cài chính thức:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Sau khi cài xong, đóng Terminal và mở lại. Nếu đã cài ChatGPT trong `/Applications`, có thể thử kết nối trong MeetNote trước; chỉ cài CLI riêng khi app chưa nhận Codex.

### Bước 2 — Đăng nhập ChatGPT

Chạy:

```text
codex login
```

Hoặc chạy `codex` và chọn **Sign in with ChatGPT** trong lần mở đầu tiên. Trình duyệt sẽ mở để bạn xác nhận tài khoản.

Kiểm tra trạng thái:

```text
codex login status
```

### Bước 3 — Kết nối trong MeetNote

1. Nếu MeetNote đang chạy từ trước khi cài Codex, hãy thoát hoàn toàn rồi mở lại để app nhận PATH mới:
   - Windows: vào **Task Manager**, chọn tiến trình MeetNote và **End task**, sau đó mở lại EXE.
   - macOS: chọn menu **MeetNote → Thoát MeetNote** hoặc nhấn `Command-Q`, sau đó mở lại từ Applications.
2. Mở **Settings → Meeting Notes AI**.
3. Chọn **Codex (ChatGPT)**.
4. Chọn **Connect / Check Codex**.
5. Khi badge hiện **Ready**, chọn **Save Settings**.

Codex dùng phiên đăng nhập ChatGPT đã lưu trên máy. Bạn không cần nhập OpenAI Platform API key vào MeetNote khi dùng provider này.

### Không muốn cài Codex CLI?

Có thể chọn **DeepSeek** hoặc **Google Gemini** trong **Meeting Notes AI**, nhập API key tương ứng, chọn **Save Key**, rồi **Test Connection**.

## 6. Ghi một cuộc họp mới

### Quick Record

Chọn **Quick Record** để tạo tên cuộc họp theo ngày giờ hiện tại và bắt đầu ghi nhanh.

### Meeting Setup

Chọn **Meeting Setup** khi muốn cấu hình trước:

1. Nhập **Meeting Title**.
2. Nhập người tham gia, cách nhau bằng dấu phẩy.
3. Chọn **Spoken Language**; chọn Auto nếu cuộc họp có nhiều ngôn ngữ.
4. Chọn **Translate To** nếu dùng Soniox và muốn dịch trực tiếp.
5. Bật **System Audio** nếu muốn thu âm thanh từ Zoom, Google Meet hoặc tab trình duyệt khác.
6. Chọn **Start Recording**.

Khi trình duyệt hỏi quyền:

- Cho phép microphone.
- Nếu bật System Audio, chọn đúng tab/cửa sổ và nhớ bật **Share audio**.
- Nên đeo tai nghe để giảm tiếng vọng.

Khi kết thúc, chọn **Stop Recording** và chờ app lưu audio/transcript.

## 7. Upload file ghi âm có sẵn

1. Từ Dashboard, chọn **Upload Recording**.
2. Chọn file audio/video.
3. MeetNote lưu file cục bộ và xử lý transcript ở background.
4. Có thể tiếp tục dùng app trong lúc chờ.

Định dạng được nhận: `AAC`, `AIFF`, `AMR`, `ASF`, `FLAC`, `MP3`, `OGG`, `WAV`, `WebM`, `M4A`, `MP4`.

Giới hạn thực tế còn phụ thuộc provider. Nếu file quá lớn với Whisper hoặc Google, hãy dùng Soniox/Deepgram hoặc nén/chia nhỏ file.

## 8. Xem và hoàn thiện biên bản

Mở cuộc họp trong **All Meetings**. Các tab chính gồm:

- **Transcript**: xem, sửa trực tiếp từng đoạn và copy toàn bộ nội dung.
- **Summary**: chọn ngôn ngữ/provider rồi chọn **Generate Summary**.
- **Translation**: xem bản dịch nếu cuộc họp có bật dịch.
- **Actions**: xem action items AI trích xuất, thêm thủ công, đánh dấu hoàn thành hoặc xóa.
- **Notes**: nhập ghi chú riêng và chọn **Save Notes**.

Nút **Export** ở góc trên xuất cuộc họp hiện tại thành file Markdown. Nút AI cạnh tên cuộc họp có thể đề xuất lại tiêu đề khi đã có transcript.

## 9. Backup, dữ liệu và quyền riêng tư

### Chọn và xóa nhiều cuộc họp

Vào **All Meetings**, đánh dấu từng cuộc họp hoặc dùng **Select all**, sau đó chọn **Delete selected**. Cuộc họp đang ghi hoặc đang xử lý sẽ không thể được chọn cho đến khi tác vụ hoàn tất. Xác nhận xóa sẽ xóa metadata, recording, transcript và summary của các mục đã chọn.

### Log và bug report

Vào **Settings → Support & Diagnostics**:

- **View Recent Logs**: xem các sự kiện và lỗi gần đây được lưu cục bộ; log tự xoay vòng để không tăng dung lượng vô hạn.
- **Report a Bug**: mở trang báo lỗi riêng, nhập mô tả rồi chọn **Create & Download Report**. Sau khi file JSON được tải về, hãy gửi file đó cho **Nguyen Leon qua kênh hỗ trợ đã được cung cấp**; app không tự động gửi report qua Internet.

Bug report chỉ chứa mô tả do người dùng nhập, phiên bản app, thông tin hệ điều hành, thống kê tổng quát và log gần đây. Report không chứa recording, transcript, bản dịch, notes, summary, action items, tiêu đề cuộc họp hoặc API key. Một bản report cũng được lưu trong thư mục `bug-reports` bên trong thư mục dữ liệu MeetNote. **Việc tải file không đồng nghĩa report đã được gửi**; người dùng cần đính kèm file JSON khi liên hệ Nguyen Leon.

### Backup trong app

Vào **Settings → Data Management**:

- **Export Backup**: xuất metadata, transcript, summary, notes, action items và settings không chứa secret.
- **Import Backup**: khôi phục từ file JSON đã xuất.
- **Clear All Data**: xóa dữ liệu trong app; cần kiểm tra kỹ trước khi xác nhận.

File JSON backup **không chứa audio** và **không chứa API key**.

### Thư mục trên Windows

| Nội dung | Vị trí |
| --- | --- |
| Dữ liệu cuộc họp và audio | `%APPDATA%\MeetNote` |
| Runtime được giải nén | `%LOCALAPPDATA%\MeetNote\Runtime` |
| Log hỗ trợ kỹ thuật | `%LOCALAPPDATA%\MeetNote\Logs\server.log` |

Muốn backup đầy đủ cả audio, hãy thoát MeetNote rồi sao chép toàn bộ thư mục `%APPDATA%\MeetNote` sang nơi an toàn.

### Thư mục trên macOS

| Nội dung | Vị trí |
| --- | --- |
| Dữ liệu cuộc họp và audio | `~/Library/Application Support/MeetNote` |
| Log hỗ trợ kỹ thuật | `~/Library/Logs/MeetNote/server.log` |
| Ứng dụng | `/Applications/MeetNote.app` |

Muốn backup đầy đủ cả audio trên Mac, hãy thoát MeetNote rồi sao chép toàn bộ thư mục `~/Library/Application Support/MeetNote` sang nơi an toàn. Trong Finder, chọn **Go → Go to Folder…** để dán đường dẫn có ký tự `~`.

### Dữ liệu nào đi ra Internet?

- Audio được gửi tới provider speech-to-text đã chọn để tạo transcript.
- Transcript được gửi tới Codex, DeepSeek hoặc Gemini khi bạn yêu cầu tạo summary/title.
- Dữ liệu cuộc họp, audio và transcript vẫn được lưu cục bộ trong thư mục MeetNote trên máy.

Không nên dùng dữ liệu nhạy cảm nếu chính sách công ty không cho phép gửi nội dung tới các dịch vụ AI bên ngoài.

## 10. Thoát và mở lại app

- Đóng tab trình duyệt không nhất thiết dừng local server.
- Windows: chạy file EXE thêm lần nữa để mở giao diện; dùng **Task Manager → End task** để dừng hoàn toàn.
- macOS: bấm biểu tượng MeetNote trên Dock hoặc chọn **MeetNote → Mở MeetNote** để mở lại giao diện; chọn **MeetNote → Thoát MeetNote** hoặc nhấn `Command-Q` để dừng hoàn toàn.
- Khi thoát đúng cách, local server con cũng được dừng.

## 11. Xử lý lỗi thường gặp

### Không thấy nút Connect Codex

Đảm bảo đang dùng đúng bản EXE/DMG có SHA-256 ghi ở mục 2 hoặc 3. Vào **Settings → Meeting Notes AI** và chọn **Codex (ChatGPT)**; nút **Connect / Check Codex** sẽ hiện bên dưới.

### `Codex CLI was not found`

1. Mở PowerShell hoặc Terminal mới và chạy `codex --version`.
2. Nếu lệnh không tồn tại, cài lại Codex CLI.
3. Nếu lệnh chạy được nhưng MeetNote vẫn không thấy, thoát hẳn MeetNote rồi mở lại.

### Codex chưa đăng nhập

Chạy:

```powershell
codex login
codex login status
```

Sau đó quay lại Settings và chọn **Connect / Check Codex**.

### Microphone hoặc System Audio không hoạt động

- Windows: kiểm tra **Windows Settings → Privacy & security → Microphone**.
- macOS: kiểm tra **System Settings → Privacy & Security → Microphone**.
- Cho phép microphone cho trình duyệt đang dùng.
- Dùng Edge/Chrome bản mới.
- Với System Audio, chọn tab/cửa sổ đúng và bật **Share audio**.
- Một số ứng dụng/cửa sổ không cho trình duyệt capture audio; thử chia sẻ tab trình duyệt thay vì toàn màn hình.

### API key báo lỗi

- Kiểm tra key chưa hết hạn và đúng provider.
- Chọn **Save Key** trước, sau đó **Test Connection**.
- Với Deepgram live, key cần quyền tạo temporary token.
- Kiểm tra mạng, firewall hoặc VPN có chặn dịch vụ hay không.

### App không mở

1. Thử mở `http://127.0.0.1:8765` trong trình duyệt.
2. Windows: kiểm tra Task Manager, dừng tiến trình MeetNote rồi mở lại EXE.
3. macOS: thoát MeetNote bằng `Command-Q` rồi mở lại từ Applications.
4. Xem log tại `%LOCALAPPDATA%\MeetNote\Logs\server.log` trên Windows hoặc `~/Library/Logs/MeetNote/server.log` trên Mac.
5. Không gửi log công khai nếu trong đó có nội dung cuộc họp hoặc thông tin nhạy cảm.

## 12. Cập nhật phiên bản mới

1. Backup dữ liệu trước khi cập nhật.
2. Tải EXE/DMG mới từ nguồn phát hành tin cậy.
3. Thoát hoàn toàn bản đang chạy.
4. Windows: mở EXE mới; dữ liệu trong `%APPDATA%\MeetNote` được giữ lại.
5. macOS: mở DMG mới và kéo MeetNote.app vào Applications, chọn **Replace** khi được hỏi; dữ liệu trong `~/Library/Application Support/MeetNote` được giữ lại.

Tài liệu Codex CLI chính thức: <https://learn.chatgpt.com/docs/codex/cli>
