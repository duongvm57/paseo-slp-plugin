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
nên bạn không phải dán prompt role, và cứ tiếp tục nói chuyện với Supervisor trong cùng khung chat.

![Mô hình role Paseo SLP: Human giữ intent và nghiệm thu cuối; Supervisor quan sát workflow của Lead nhưng không tham gia execution; Lead giao outcome có giới hạn cho các Peer độc lập, Peer trả về evidence, challenge, dependency request hoặc blocked](docs/images/slp-role-model.svg)

## Một task diễn ra thế nào

![Một task từ đầu đến cuối: bạn giao mục tiêu cho Supervisor; Supervisor quan sát hoặc tạo Lead và đứng ngoài phần thực thi; Lead định khung công việc và giao mỗi Peer một outcome có giới hạn; Peer trả về evidence, challenge hoặc blocked; Lead tích hợp qua review gate; Supervisor kiểm tra handback và báo cáo cho bạn](docs/images/slp-task-flow.svg)

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
| Đăng ký 12 provider `slp-<family>-<role>` và hai profile **SLP Supervisor** / **SLP Lead**   | Ghi đè provider hay profile không thuộc về nó (`COLLISION`)                        | Tạo agent khi cài đặt hoặc kích hoạt                             |
| Nạp role bundle cho từng seat lúc session bắt đầu, không hiện trong tab agent                | Đoán mò khi config bị đổi ngoài journal của nó (`RECOVERY_REQUIRED`)               | Chạy scheduler hay database agent riêng; Paseo vẫn là control plane |
| Giữ Peer pool để Lead chọn runtime cho từng Peer                                             | Khởi chạy Peer không đi qua một pool option                                        | Ghi routing catalog của repository                               |
| Kiểm tra tham số khởi chạy offline (`prepare`), báo lỗi theo từng bước có tên                | Provider record đã bị sửa sau khi `list_providers` trả về                          | Chạy daemon giám sát; `monitor` là một lượt quét do bạn gọi       |
| Cung cấp Jev routing, communication supervision và work tracker beads (đều tùy chọn)         | Receipt routing của Jev không qua được kiểm tra offline (hash, model, catalog)     | Cài đặt hay khởi tạo beads                                       |

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

- Paseo `>=0.8.0 <0.10.0`, với `pluginsEnabled: true` và `mcp.enabled` hiệu lực là `true`
- Node.js 22 trở lên trên máy chạy daemon
- CLI của từng provider family bạn dùng (Codex, Pi, Devin, Claude), đã đăng nhập trên máy daemon;
  Pi cần hỗ trợ truyền `--append-system-prompt` nhiều lần

```bash
paseo plugin install duongvm57/paseo-slp-plugin:plugin                # theo nhánh mặc định
paseo plugin install duongvm57/paseo-slp-plugin:plugin --ref <tag>    # hoặc ghim một release
```

Danh sách tag xem ở [Releases](https://github.com/duongvm57/paseo-slp-plugin/releases). Kiểm tra bằng
`paseo plugin ls`; plugin phải lên trạng thái `running`. Cài đặt chưa đổi cấu hình agent nào cho tới
khi bạn kích hoạt.

## Lần chạy đầu

1. **Kích hoạt.** Mở **SLP** ở thanh bên của Paseo (hoặc *Open SLP manager* trong command palette),
   kiểm tra daemon home nó hiển thị rồi chọn **Activate**. Nút **Inspect** chỉ đọc, dùng khi muốn xem
   trước.
2. **Chọn model.** Trong **Settings → host của bạn → Agents → Agent profiles**, sửa **SLP Supervisor**
   và **SLP Lead**: provider, model, thinking, mode.
3. **Onboard một repository.** Cài skill onboarding, rồi nhờ agent bất kỳ trong repo đó
   *onboard / set up SLP*. Skill sẽ đề xuất `.paseo-slp/workspace-protocol.md` và Peer pool, và cho
   xem toàn bộ diff trước khi ghi.

   ```bash
   npx skills add duongvm57/paseo-slp-plugin --skill paseo-slp-onboarding
   ```

4. **Giao task.** Chọn **New agent** trong workspace của repo, chọn profile **SLP Supervisor**, đặt
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

Mọi thứ dưới đây **mặc định tắt** và được cấu hình trên SLP manager.

| Tính năng                                                                   | Thêm gì                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Communication language](docs/operations.md#getting-started)                | Một ngôn ngữ chung cho mọi thứ các seat viết cho nhau; câu trả lời cho bạn vẫn theo ngôn ngữ của bạn   |
| [Peer quota fallback](docs/operations.md#peer-quota-fallback)               | Một pool option được chỉ định sẵn để Lead thử lại một lần khi Peer hết quota                          |
| [Jev-assisted routing](docs/operations.md#jev-assisted-routing-optional)    | Receipt routing có hiệu chỉnh từ Jev (TypeSafe System One): shadow mode chỉ ghi lại, armed mode bắt buộc theo |
| [Communication supervision](docs/operations.md#communication-supervision-optional) | Đánh giá từng handback của Peer và cách Lead xử lý nó; ghi lại phát hiện, có thể báo cho Supervisor |
| [Work tracker](docs/operations.md#work-tracker-optional)                    | Work graph beads (`bd`) để seat tra trạng thái task thay vì dựng lại từ lịch sử chat                  |

## Cập nhật và gỡ bỏ

```bash
paseo plugin update paseo-slp               # cài từ git, theo nhánh mặc định
paseo plugin update paseo-slp --ref <tag>   # bản đã ghim: chọn ref mới một cách tường minh
paseo plugin reload paseo-slp               # cài từ thư mục: sau khi checkout thay đổi
```

Muốn gỡ, chọn **Deactivate** trên SLP manager trước. Bước này gỡ provider và profile, nhưng giữ file
runtime cho các session còn đang chạy. Sau đó chạy `paseo plugin remove paseo-slp`. Chi tiết ở
[docs/operations.md](docs/operations.md#upgrading).

## Phát triển

```bash
PASEO_HOME="$(mktemp -d)" npm test   # tách khỏi daemon thật đang chạy, giống CI
npm run typecheck
npm run check:plugin-payload         # sinh lại bằng npm run generate:plugin-payload sau khi sửa src/, bin/, skills/
```

Muốn dogfood live từ source checkout, nhờ một session đang mở *run the package's full E2E*. Xem
[docs/development.md](docs/development.md).

## Tài liệu

Tài liệu chi tiết viết bằng tiếng Anh.

| Đọc                                              | Khi bạn muốn                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)     | Mô hình role, những gì plugin thêm vào Paseo, kênh ẩn, vòng delegation          |
| [docs/operations.md](docs/operations.md)         | Kích hoạt, nâng cấp, profile, thiết lập repository, Peer pool, tính năng tùy chọn |
| [docs/cli.md](docs/cli.md)                       | Các lệnh `slp.mjs` offline: `prepare`, `routes`, `route-decide`, `monitor` và các lệnh khác |
| [docs/contract.md](docs/contract.md)             | Mỗi file sở hữu gì, trước khi bạn sửa nó                                        |
| [docs/development.md](docs/development.md)       | Test, trạng thái xác minh và bộ E2E                                             |
| [AGENTS.md](AGENTS.md)                           | Các quy tắc contributor và agent tuân theo trong repo này                       |

Spec và các bản điều tra nằm trong [docs/spec/](docs/spec/) và [docs/reports/](docs/reports/).

## Giấy phép

MIT, xem [LICENSE](LICENSE).
