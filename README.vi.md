<h1 align="center">Paseo SLP</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <b>Supervisor – Lead – Peer</b> cho <a href="https://paseo.sh">Paseo</a>: một team coding agent
  tách theo <i>loại phán đoán</i>, không phải một chuỗi mệnh lệnh.
</p>

Bạn mở một session **SLP Supervisor** trong Paseo và giao mục tiêu. Supervisor quan sát một **Lead**
đang chạy hoặc tạo Lead mới cho công việc. Lead chia việc thành các outcome có giới hạn và giao mỗi
outcome cho một **Peer** mà nó chọn từ Peer pool của bạn. Seat nào cũng là agent Paseo bình thường.
Plugin nạp sẵn role contract, quy tắc delegation và policy locator cho từng seat lúc session bắt đầu,
tách riêng với prompt công việc. Bạn cứ tiếp tục nói chuyện với Supervisor trong cùng khung chat.
Bạn cũng có thể giao việc thẳng cho **SLP Lead**; Supervisor là seat tùy chọn để quan sát workflow.

![Paseo SLP: Human giữ mục tiêu và nghiệm thu cuối; Lead giao outcome có giới hạn cho Peer độc lập; Supervisor tùy chọn quan sát workflow và chuyển quyết định; plugin nạp hướng dẫn role và kiểm tra chuẩn bị khởi chạy](docs/images/slp-overview.vi.svg)

## Một task diễn ra thế nào

1. **Bạn đặt mục tiêu.** Tạo agent mới với profile **SLP Supervisor** và nói bạn muốn gì, ví dụ
   `Fix the checkout total rounding bug. Report back with verdict and the checks you ran.`
2. **Supervisor đứng ngoài phần thực thi.** Nó quan sát Lead đang chạy hoặc tạo Lead mới, giữ chất
   lượng của workflow (bias, lỗi lặp lại, mất đà, scope trôi, bằng chứng yếu) và chuyển quyết định
   của bạn. Nó không bao giờ implement hay nghiệm thu công việc.
3. **Lead nắm các quyết định của dự án.** Nó định khung công việc, chọn topology theo rủi ro (một
   Engineer cho fix nhỏ; Architect, Reviewer độc lập hoặc nhiều nhánh khi lifecycle quan trọng) và
   chọn provider, model cho từng Peer từ pool.
4. **Peer là đồng nghiệp, không phải lời gọi hàm.** Mỗi Peer sở hữu một outcome. Nó có thể phản biện
   premise, xin dependency hoặc dừng ở trạng thái blocked. Bất đồng được giải quyết bằng bằng chứng.
5. **Bạn quay lại và nhận báo cáo** ngay trong khung chat Supervisor đó. Các trade-off quan trọng,
   quyền đặc biệt và nghiệm thu cuối vẫn thuộc về bạn.

## Vì sao subagent chưa đủ

API subagent chỉ tạo tiến trình. Nó không quyết định ownership, phán đoán độc lập, phối hợp hay
nghiệm thu. Thêm agent có thể làm tăng sự tự tin mà không làm tăng độ đúng.

| Kiểu hỏng                 | Chuyện gì xảy ra                                                   | SLP làm gì                                                         |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Authority gradient        | Agent con đồng ý với đáp án agent cha đã đưa sẵn                   | Peer được phản biện premise; bằng chứng quyết định                 |
| Perfect-plan trap         | Coordinator giải trước mọi thứ; worker thành người đánh máy        | Lead giao outcome, không giao chỉ dẫn từng file                    |
| Attention dilution        | Coordinator tự implement và mất tầm nhìn toàn dự án                | Lead lo tích hợp; Supervisor không bao giờ tham gia thực thi       |
| Unsafe parallelism        | Hai agent ghi đè cùng những file đang thay đổi                     | Mỗi phạm vi đang thay đổi chỉ một người ghi; worktree riêng khi ghi song song |
| Biased or stale review    | Reviewer thừa hưởng góc nhìn của tác giả, hoặc đọc file đang đổi   | Review độc lập trên một candidate ổn định                          |
| False completion          | `idle`, "xong" hay test xanh bị coi là bằng chứng                  | Nghiệm thu cần đúng artifact được đúng người có thẩm quyền review  |
| Split control planes      | Worker tự tạo worker mà không ai theo dõi                          | Paseo là control plane duy nhất; Peer không bao giờ tạo agent      |

Lý do thiết kế nằm ở [docs/architecture.md](docs/architecture.md).

## Plugin làm gì, và không làm gì

| Plugin làm                                                                                   | Plugin từ chối                                                                     | Plugin không bao giờ                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Đăng ký tối đa 12 provider `slp-<family>-<role>` và hai profile **SLP Supervisor** / **SLP Lead** | Ghi đè provider hay profile không thuộc về nó (`COLLISION`)                    | Tạo agent khi cài đặt hoặc kích hoạt                             |
| Nạp hướng dẫn role cho từng seat lúc session bắt đầu, tách riêng với prompt công việc         | Đoán mò khi config bị đổi ngoài journal của nó (`RECOVERY_REQUIRED`)               | Chạy scheduler hay database agent riêng; Paseo vẫn là control plane |
| Giữ Peer pool để Lead chọn runtime cho từng Peer                                             | Binding Peer ngoài pool khi chạy `prepare`                                         | Ghi routing catalog của repository                               |
| Kiểm tra tham số khởi chạy offline (`prepare`), báo lỗi theo từng bước có tên                | Provider inventory chưa được xác minh hoặc không tương thích được đưa vào `prepare` | Chạy daemon giám sát; `monitor` là một lượt quét do bạn gọi       |
| Cung cấp Jev routing, communication supervision và work tracker beads (đều tùy chọn)         | Receipt routing của Jev không qua được kiểm tra offline (hash, model, catalog)     | Cài đặt hay khởi tạo beads                                       |

Lựa chọn role đã lưu giới hạn provider Supervisor/Lead; cả bốn provider Peer vẫn được chọn qua
pool. Provider của CLI chưa có sẵn bị vô hiệu hóa. Kiểm tra pool ở bảng trên thuộc về `prepare`.
Quy tắc role hướng dẫn cách agent làm việc; kiểm tra managed launch và desk áp dụng tại các
interface tương ứng. Quyền truy cập repository và shell vẫn do Paseo cùng provider quyết định.

## Các role

| Role           | Sở hữu                                                                                 | Không bao giờ                                           | Runtime lấy từ                          |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| **Human**      | Intent, trade-off quan trọng, quyền đặc biệt, thay đổi protocol, nghiệm thu cuối       | —                                                       | —                                       |
| **Supervisor** | Chất lượng của workflow và lập luận; chuyển quyết định của bạn                         | Implement, hay nghiệm thu dự án                         | Profile **SLP Supervisor**              |
| **Lead**       | Định khung, routing, dependency, tích hợp, verdict dự án                               | Giải trước phần khó rồi giao Peer việc đánh máy         | Profile **SLP Lead**                    |
| **Peer**       | Một outcome có giới hạn, trong vai Engineer, Architect, Reviewer hoặc Scout            | Tạo agent khác                                          | Một option trong Peer pool, theo task   |

Seat chạy trên **Codex, Pi, Devin hoặc Claude Code**, trộn tùy ý: hai Peer trong cùng một team có thể
dùng provider, model và mức effort khác nhau.

## Cài đặt

Bạn cần:

- Paseo `>=0.8.0`, với `pluginsEnabled: true` và `mcp.enabled` hiệu lực là `true`
- Máy chạy daemon dùng POSIX (Linux/macOS), với Node.js 22.x từ 22.18, hoặc Node.js 23.6+
  (native TypeScript stripping)
- CLI của từng provider family bạn dùng (Codex, Pi, Devin, Claude), đã đăng nhập trên máy daemon;
  Pi cần hỗ trợ truyền `--append-system-prompt` nhiều lần

Bật provider family đã cài mà bạn muốn dùng trong phần cấu hình agent của Paseo trước lần kích hoạt đầu.

```bash
paseo plugin install duongvm57/paseo-slp-plugin:plugin                # theo nhánh mặc định
paseo plugin install duongvm57/paseo-slp-plugin:plugin --ref <tag>    # hoặc ghim một release
```

Danh sách tag xem ở [Releases](https://github.com/duongvm57/paseo-slp-plugin/releases). Kiểm tra bằng
`paseo plugin ls`; plugin phải lên trạng thái `running`. Cài đặt chưa đổi cấu hình agent nào cho tới
khi bạn kích hoạt.

## Lần chạy đầu

1. **Kích hoạt.** Mở **SLP** ở thanh bên của Paseo (hoặc *Open SLP manager* trong command palette),
   chọn **Inspect**, xác nhận **Daemon home confirmed** và **Exclusive configuration window**,
   rồi chọn **Activate**. Trong lúc thao tác chạy, giữ các bên khác không sửa cấu hình daemon.
2. **Chọn model cho role.** Trong **SLP → Role profiles**, chọn provider và model cụ thể cho
   **Supervisor** và **Lead**, cùng mode, thinking, feature nếu provider hỗ trợ. Chọn **Save**,
   rồi chạy lại thao tác kích hoạt (**Re-verify binding** hoặc **Rebind**) để áp dụng lựa chọn.
   Chỉ Save chưa áp dụng thay đổi. Phải đặt model trước khi delegation; Devin dùng model `swe-2`.
   Thay đổi áp dụng cho lần khởi chạy sau, không đổi session đang chạy.
3. **Onboard một repository.** Cài skill onboarding, rồi nhờ agent bất kỳ trong repo đó
   *onboard / set up SLP*. Skill sẽ đề xuất `.paseo-slp/workspace-protocol.md` và Peer pool, và cho
   xem toàn bộ diff trước khi ghi.

   ```bash
   npx skills add duongvm57/paseo-slp-plugin --skill paseo-slp-onboarding
   ```

4. **Chuẩn bị Peer pool.** Nếu repo kế thừa pool chung, dùng **SLP → Peer pool** để thêm option
   phù hợp với provider, model và các setting có sẵn, bật option rồi **Save**.
   Nếu onboarding ghim `.paseo-slp/slp-routing.json`, cấu hình option của file đó trong lúc
   onboarding. Manager sửa pool chung; file ghim của repo được ưu tiên, và file rỗng hoặc
   không hợp lệ không chuyển sang dùng pool chung.
5. **Giao task.** Chọn **New agent** trong workspace của repo, chọn profile **SLP Supervisor**, đặt
   tiêu đề `Supervisor — <task>` và ghi mục tiêu. Sau đó cứ tiếp tục chat ở đó.

Vài dòng tùy chọn giúp mục tiêu chắc chắn hơn:

| Dòng               | Dùng khi                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| `Repository: …`    | Workspace của session có thể không phải repo đích, hoặc task trải trên nhiều repo  |
| `Report back …`    | Luôn nên có: nó đánh dấu đây là assignment có sản phẩm, không phải chat mở         |
| `Heartbeat: …`     | Việc dài, ví dụ `Heartbeat: sweep every 30m until handback`                         |

Chưa cài skill? Dán đoạn này vào agent bất kỳ: *"Help me set up Paseo SLP. Read
https://raw.githubusercontent.com/duongvm57/paseo-slp-plugin/main/docs/agent-guide.md first, then
walk me through it step by step."*

## Tính năng tùy chọn

Các tính năng này **mặc định tắt**. Bạn bật và cấu hình chúng trong SLP manager;
quota fallback thuộc về Peer pool được chọn, kể cả pool ghim riêng cho repo.

| Tính năng                                                                   | Thêm gì                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Communication language](docs/operations.md#getting-started)                | Hướng dẫn managed seat dùng một ngôn ngữ khi trao đổi với nhau; câu trả lời cho bạn theo ngôn ngữ của bạn |
| [Peer quota fallback](docs/operations.md#peer-quota-fallback)               | Một pool option được chỉ định sẵn để Lead thử lại một lần khi Peer hết quota                          |
| [Jev-assisted routing](docs/operations.md#jev-assisted-routing-optional)    | Receipt routing có hiệu chỉnh từ Jev (TypeSafe System One): shadow mode chỉ ghi lại, armed mode bắt buộc theo |
| [Communication supervision](docs/operations.md#communication-supervision-optional) | Đánh giá handback Peer thu thập được và cách Lead xử lý trong các Lead đã cấu hình; ghi lại phát hiện, có thể báo cho Supervisor |
| [Work tracker](docs/operations.md#work-tracker-optional)                    | Work graph beads (`bd`) để seat tra trạng thái task thay vì dựng lại từ lịch sử chat                  |

Routing và supervision qua Jev gửi dữ liệu đầu vào hoặc nội dung trao đổi thu thập được đến dịch vụ
Jev bạn chọn. Kiểm tra dịch vụ và chi phí trước khi bật các tính năng này.

## Cập nhật và gỡ bỏ

```bash
paseo plugin update paseo-slp               # cài từ git, theo nhánh mặc định
paseo plugin update paseo-slp --ref <tag>   # bản đã ghim: chọn ref mới một cách tường minh
paseo plugin reload paseo-slp               # cài từ thư mục: sau khi checkout thay đổi
```

Sau khi update hoặc reload, mở SLP manager và chạy **Rebind** khi nó hiển thị runtime mới.
Session đang chạy giữ nguyên tiến trình và hướng dẫn role; lần khởi chạy mới dùng binding mới.
Việc mở managed session vẫn cần plugin đang chạy.

Muốn gỡ, chọn **Deactivate** trên SLP manager trước. Bước này gỡ provider và profile, nhưng giữ file
runtime cho các session còn đang chạy. Sau đó chạy `paseo plugin remove paseo-slp`. Chi tiết ở
[docs/operations.md](docs/operations.md#upgrading).

## Phát triển

Từ source checkout, cài dependency bằng `npm ci`, rồi chạy các kiểm tra local:

```bash
env -i HOME="$HOME" PATH="$PATH" PASEO_HOME="$(mktemp -d)" npm test  # loại biến runtime SLP kế thừa
npm run typecheck
npm run check                     # xem identity của install unit
npm run check:plugin-payload       # xác minh payload đã sinh còn khớp nguồn
```

Sau khi sửa nguồn thuộc install unit (`package.json`, `install.sh`, `bin/`, `skills/`, `src/`,
`plugin/server/runtime/` hoặc `plugin/shared/runtime/`), chạy `npm run generate:plugin-payload`,
rồi kiểm tra lại payload. Các kiểm tra local xác minh hành vi source và độ khớp của payload.

Muốn dogfood live từ source checkout, nhờ một session đang mở *run the package's full E2E*. Xem
[docs/development.md](docs/development.md).

Các hình README Anh–Việt dùng chung nguồn `scripts/generate-readme-diagrams.mjs`.
Sau khi sửa nguồn, chạy `node scripts/generate-readme-diagrams.mjs`; dùng `--check` để xác minh SVG.

## Tài liệu

Tài liệu chi tiết viết bằng tiếng Anh.

| Đọc                                              | Khi bạn muốn                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)     | Mô hình role, những gì plugin thêm vào Paseo, cách nạp role và delegation      |
| [docs/operations.md](docs/operations.md)         | Kích hoạt, nâng cấp, profile, thiết lập repository, Peer pool, tính năng tùy chọn |
| [docs/cli.md](docs/cli.md)                       | Các lệnh `slp.mjs` offline: `prepare`, `routes`, `route-decide`, `monitor` và các lệnh khác |
| [docs/contract.md](docs/contract.md)             | Mỗi file sở hữu gì, trước khi bạn sửa nó                                        |
| [docs/development.md](docs/development.md)       | Test, trạng thái xác minh và bộ E2E                                             |
| [AGENTS.md](AGENTS.md)                           | Các quy tắc contributor và agent tuân theo trong repo này                       |

Spec và các bản điều tra nằm trong [docs/spec/](docs/spec/) và [docs/reports/](docs/reports/).

[Trải nghiệm giao thức](docs/protocol-experience.vi.md) ghi lại các bài học vận hành trước đây.

<!-- Đồng bộ yêu cầu cài đặt, các bước thiết lập và ví dụ với README.md. -->

## Giấy phép

MIT, xem [LICENSE](LICENSE).
