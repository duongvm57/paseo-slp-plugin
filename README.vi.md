<h1 align="center">Paseo SLP</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <b>Supervisor – Lead – Peer</b> cho <a href="https://paseo.sh">Paseo</a>: một team coding agent
  tách theo <i>loại phán đoán</i>, không phải một chuỗi mệnh lệnh.
</p>

Giao một mục tiêu có giới hạn cho **SLP Lead**, hoặc làm việc qua **SLP Supervisor** tùy chọn.
Lead phối hợp các Peer độc lập, tích hợp công việc và trả verdict của dự án. Mỗi seat là một agent
Paseo bình thường, được nạp hướng dẫn role riêng với prompt công việc. Bạn giữ mục tiêu,
trade-off quan trọng và quyền nghiệm thu cuối.

Plugin còn cung cấp **desk của repository**: assignment bền vững, brief hiện hành, queue task
native, scope đã khai báo, nghĩa vụ review được chọn, bằng chứng candidate/check và chuyển tiếp owner.
Mở **Read SLP work** để xem công việc đã đăng ký mà không phải dựng lại từ lịch sử chat.

![Paseo SLP: mục tiêu và nghiệm thu của Human, Lead cùng Peer độc lập, Supervisor tùy chọn và desk bền vững cho công việc, review, proof và handoff](docs/images/slp-overview.svg)

https://github.com/user-attachments/assets/110692f7-88de-4bad-be16-626ff180d97b

## Công việc diễn ra thế nào

1. **Đặt mục tiêu.** Tạo **SLP Lead**, hoặc **SLP Supervisor** để quan sát hay tạo Lead. Ví dụ:
   `Fix the checkout total rounding bug. Report back with the candidate and the checks you ran.`
   Supervisor quan sát workflow và chuyển quyết định của bạn; nó đứng ngoài phần triển khai
   và nghiệm thu dự án.
2. **Làm rõ ownership.** Lead định khung nghiệm thu, dependency và rủi ro, đăng ký công việc
   vào desk và tách mục tiêu lớn thành task. Dependency, attempt, phán xét output và nghĩa vụ
   còn mở được giữ qua gián đoạn. Mỗi phạm vi đang thay đổi
   chỉ có một writer. Peer có thể phản biện premise, xin dependency hoặc báo blocked.
3. **Chọn review theo công việc.** Lead chọn mandate độc lập cho câu hỏi quan trọng và yêu cầu
   của Human/protocol. Không cố định cặp hay số reviewer. Thay đổi scope, brief hoặc candidate
   có thể khiến review trước đó hết hiệu lực.
4. **Trả bằng chứng.** Desk tách claim của handback khỏi quan sát candidate và check thực sự đã
   chạy. Lead xử lý finding và bất đồng, tích hợp công việc, rồi báo proof xác lập được gì
   và còn điều gì chưa chắc chắn.
5. **Tiếp tục mà không mất công việc.** Handoff có chuẩn bị dùng offer của owner và acknowledgment
   của Lead tiếp nhận dưới kiểm tra revision, giữ nguyên assignment và lịch sử. Handoff và
   resource account không xác lập nghiệm thu dự án; quyền đó vẫn thuộc về bạn.

## Vì sao subagent chưa đủ

API subagent chỉ tạo tiến trình. Nó không quyết định ownership, phán đoán độc lập, phối hợp hay
nghiệm thu. Thêm agent có thể làm tăng sự tự tin mà không làm tăng độ đúng.

| Kiểu hỏng                 | Chuyện gì xảy ra                                                   | SLP làm gì                                                         |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Authority gradient        | Agent con đồng ý với đáp án agent cha đã đưa sẵn                   | Peer được phản biện premise; bằng chứng quyết định                 |
| Perfect-plan trap         | Coordinator giải trước mọi thứ; worker thành người đánh máy        | Lead giao outcome, không giao chỉ dẫn từng file                    |
| Attention dilution        | Coordinator tự implement và mất tầm nhìn toàn dự án                | Lead lo tích hợp; Supervisor không bao giờ tham gia thực thi       |
| Unsafe parallelism        | Hai agent ghi đè cùng những file đang thay đổi                     | Mỗi phạm vi chỉ một người ghi; khai báo scope và theo tactic isolation của repo |
| Biased or stale review    | Reviewer thừa hưởng góc nhìn của tác giả, hoặc đọc file đang đổi   | Review độc lập trên một candidate ổn định                          |
| False completion          | `idle`, "xong" hay test xanh bị coi là bằng chứng                  | Nghiệm thu cần đúng artifact được đúng người có thẩm quyền review  |
| Split control planes      | Worker tự tạo worker mà không ai theo dõi                          | Paseo là control plane duy nhất; Peer không bao giờ tạo agent      |

Lý do thiết kế nằm ở [docs/architecture.md](docs/architecture.md).

## Plugin làm gì, và không làm gì

| Plugin làm                                                                                   | Plugin từ chối                                                                     | Plugin không bao giờ                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Đăng ký tối đa 15 provider `slp-<family>-<role>` và hai profile **SLP Supervisor** / **SLP Lead** | Ghi đè provider hay profile không thuộc về nó (`COLLISION`)                    | Tạo agent khi cài đặt hoặc kích hoạt                             |
| Nạp hướng dẫn role cho từng seat lúc session bắt đầu, tách riêng với prompt công việc         | Đoán mò khi config bị đổi ngoài journal của nó (`RECOVERY_REQUIRED`)               | Chạy scheduler hay database agent riêng; Paseo vẫn là control plane |
| Giữ Peer pool để Lead chọn runtime cho từng Peer                                             | Binding Peer ngoài pool khi chạy `prepare`                                         | Ghi routing catalog của repository                               |
| Kiểm tra tham số khởi chạy offline (`prepare`), báo lỗi theo từng bước có tên                | Provider inventory chưa được xác minh hoặc không tương thích được đưa vào `prepare` | Chạy daemon giám sát; `monitor` là một lượt quét do bạn gọi       |
| Ghi assignment, brief, quyết định, scope, review được chọn và bằng chứng candidate/check      | Revision pin cũ, scope khai báo chồng lấn và review bắt buộc không đủ điều kiện      | Suy ra nghiệm thu từ handback, trạng thái agent hay check xanh     |
| Giữ queue dependency native, thực hiện dispatch và tích hợp qua staging do Lead gọi | Prerequisite chưa được phán xét hoặc chưa có tại đích, retry effect chưa rõ kết quả và target drift | Tự động dispatch, retry, commit hay land khi không có người điều phối |
| Hỗ trợ handoff owner có chuẩn bị và panel chỉ đọc trong workspace                            | Acknowledgment không khớp offer còn dùng được và revision pin hiện hành             | Chuyển quyền qua tin nhắn chat hay resource account               |
| Cung cấp Jev routing và communication supervision tùy chọn                                   | Receipt routing Jev không qua được kiểm tra offline (hash, model, catalog)          | Bật dịch vụ ngoài khi bạn chưa cấu hình                            |

Lựa chọn role đã lưu giới hạn provider Supervisor/Lead; cả năm provider Peer vẫn được chọn qua
pool. Provider của CLI chưa có sẵn bị vô hiệu hóa. Kiểm tra pool áp dụng cho `prepare` và native task dispatch.
Quy tắc role hướng dẫn cách agent làm việc; kiểm tra managed launch và desk áp dụng tại các
interface tương ứng. Quyền truy cập repository và shell vẫn do Paseo cùng provider quyết định.

## Các role

| Role           | Sở hữu                                                                                 | Không bao giờ                                           | Runtime lấy từ                          |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| **Human**      | Intent, trade-off quan trọng, quyền đặc biệt, thay đổi protocol, nghiệm thu cuối       | —                                                       | —                                       |
| **Supervisor** | Chất lượng của workflow và lập luận; chuyển quyết định của bạn                         | Implement, hay nghiệm thu dự án                         | Profile **SLP Supervisor**              |
| **Lead**       | Định khung, routing, dependency, tích hợp, verdict dự án                               | Giải trước phần khó rồi giao Peer việc đánh máy         | Profile **SLP Lead**                    |
| **Peer**       | Một outcome có giới hạn, trong vai Engineer, Architect, Reviewer hoặc Scout            | Tạo agent khác                                          | Một option trong Peer pool, theo task   |

Seat chạy trên **Codex, Pi, Devin, Claude Code hoặc OpenCode**, trộn tùy ý: hai Peer trong cùng một team có thể
dùng provider, model và mức effort khác nhau. [OpenCode](docs/opencode.md) dùng ACP
stdio cho managed và standalone; transport native OpenCode và V1 chưa được hỗ trợ.

Peer Engineer là writer mặc định cho phần triển khai. Human assignment hoặc workspace protocol
có hiệu lực có thể cấp rõ một phạm vi Lead được viết cho việc rõ ràng, dễ đảo ngược. Quy tắc một
writer, proof của candidate và review độc lập khi bắt buộc vẫn áp dụng; task nhỏ không tự miễn bước.

## Cài đặt

Bạn cần:

- Paseo `>=0.10.3`, với `pluginsEnabled: true` và `mcp.enabled` hiệu lực là `true`
- Máy chạy daemon dùng POSIX (Linux/macOS), với Node.js 22.x từ 22.18, hoặc Node.js 23.6+
  (native TypeScript stripping)
- CLI của từng provider family bạn dùng (Codex, Pi, Devin, Claude, OpenCode), đã đăng nhập trên máy daemon;
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

## Hồ sơ công việc và review

Mở **Read SLP work** từ command palette của workspace để xem assignment đã đăng ký trong desk
của repository đó. Panel **SLP work** hiển thị brief hiện hành, lịch sử quyết định, owner và
dependency đã khai báo, nhận xét review, cùng bằng chứng candidate/check. Dùng **Reload** để
đọc trạng thái mới; dữ liệu thiếu hoặc cũ được hiển thị rõ. Panel không suy ra công việc từ chat
hay nghiệm thu task thay bạn.

Với mục tiêu lớn, tab **Tasks** hiển thị queue native, lý do readiness, attempt, phán xét
result hiện hành và nghĩa vụ delivery/resource chưa giải quyết. Lead gọi dispatch rõ ràng:
reserve trước, tạo worker chưa có work prompt, bind scope với membership đã đăng ký, rồi
gửi việc. Dependency cần phán xét output còn hợp lệ và bằng chứng output có tại đích.
Integration stage và kiểm tra candidate kết hợp trước khi áp dụng delta có giới hạn lên
target; conflict và effect chưa rõ kết quả được giữ để reconciliation.
Cleanup stage và backup cần từng bước được cấp quyền riêng, với số lần tiếp tục hữu hạn;
resource chưa giải quyết vẫn giữ reservation của target.
Xem [native task execution](docs/task-execution.md) để biết trình tự và giới hạn vận hành.

Chuyển tiếp assignment giữ nguyên ID công việc và lịch sử: Lead hiện tại đề nghị một membership
Lead cụ thể tiếp nhận, rồi Lead đó xác nhận trách nhiệm dưới kiểm tra revision. Panel tách owner
và review còn dùng được khỏi nhận xét lịch sử, đồng thời phân biệt claim của handback/settlement
với kết quả đo. Xem [assignment continuity](docs/work-continuity.md) để biết trình tự và giới hạn.

Lead sở hữu assignment có thể thêm revision của brief và quyết định quan trọng qua desk tool.
Thay đổi brief, scope hoặc review plan khiến review liên quan hết hiệu lực. Lead chọn mandate
review độc lập theo câu hỏi quan trọng và yêu cầu của Human/protocol, không cố định cặp hay
số reviewer. Scope mới phải khai báo cần review, không có trigger áp dụng, hoặc được miễn
theo grant. Quyết định không có trigger không miễn một gate bắt buộc.

Handback có thể kèm report có cấu trúc cho execution, review hoặc adjudication. Bộ render giữ
nguyên block bằng chứng gốc; recap khi handoff tách claim được cung cấp khỏi candidate vừa đo
và nêu rõ context còn thiếu. Xem [work coordination](docs/work-coordination.md) để biết hợp
đồng tool, report và chuyển tiếp công việc.

Tracker bên ngoài và automation riêng của dự án thuộc về workspace/harness. Plugin dùng desk
của nó, không thêm card tracker, RPC tracker hay hướng dẫn tracker vào session.

## Tính năng tùy chọn

Các tính năng này **mặc định tắt**. Bạn bật và cấu hình chúng trong SLP manager;
quota fallback thuộc về Peer pool được chọn, kể cả pool ghim riêng cho repo.

| Tính năng                                                                   | Thêm gì                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Communication language](docs/operations.md#getting-started)                | Hướng dẫn managed seat dùng một ngôn ngữ khi trao đổi với nhau; câu trả lời cho bạn theo ngôn ngữ của bạn |
| [Peer quota fallback](docs/operations.md#peer-quota-fallback)               | Một pool option được chỉ định sẵn để Lead thử lại một lần khi Peer hết quota                          |
| [Jev-assisted routing](docs/operations.md#jev-assisted-routing-optional)    | Receipt routing có hiệu chỉnh từ Jev (TypeSafe System One): shadow mode chỉ ghi lại, armed mode bắt buộc theo |
| [Communication supervision](docs/operations.md#communication-supervision-optional) | Đánh giá handback Peer thu thập được và cách Lead xử lý trong các Lead đã cấu hình; ghi lại phát hiện, có thể báo cho Supervisor |

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

### Migrate từ 0.6.0 trở xuống

Khi không có agent đang chạy, dùng lệnh update/reload ở trên, rồi mở **SLP → Inspect**
và chạy **Rebind**. Lựa chọn role đã lưu và Peer pool dùng chung được giữ lại.
Thông thường không cần cài lại hay migrate state bằng tay.

Chỉ xử lý các mục sau nếu bản cài của bạn có liên quan:

- **Node:** máy daemon nay cần Node `>=22.18.0 <23.0.0 || >=23.6.0`
  để nạp TypeScript trực tiếp. Nâng Node cũ trước khi rebind.
- **Protocol của repo:** cập nhật hướng dẫn tracker/Beads cũ trong
  `.paseo-slp/workspace-protocol.md` bằng onboarding skill mới và
  [template hiện tại](src/templates/workspace-protocol.md). Plugin không ghi đè file này.
  Yêu cầu review đã ghi rõ vẫn có hiệu lực đến khi bạn thay đổi.
- **Tracker integration:** đã bỏ tracker card, RPC và lệnh `slp.mjs tracker`.
  Cấu hình cũ và dữ liệu `.beads/` được giữ nguyên, plugin không còn dùng chúng;
  không cần xóa để upgrade.
- **Script tự viết:** nếu import module `src/*.mjs` đã bị bỏ, chuyển sang
  [CLI được tài liệu hóa](docs/cli.md). Với standalone install, `npm run install:slp`
  nay chỉ preview; `npm run install:slp:apply` mới apply.
- **Standalone → plugin:** theo [hướng dẫn migration](docs/reports/legacy-install.md#migrating-to-the-plugin)
  để gỡ binding standalone cũ trước khi activate; hai cách cài dùng chung ID.

Nếu Inspect báo conflict cấu hình hoặc `RECOVERY_REQUIRED`, dùng
**Reconcile → inspect**, xử lý entry được báo rồi thử Rebind lại.

## Phát triển

Từ source checkout, cài dependency bằng `npm ci`, rồi chạy các kiểm tra local:

```bash
npm test                          # tự chạy trong PASEO_HOME tạm, cách ly
npm run typecheck
npm run check                     # xem identity của install unit
npm run check:plugin-payload       # xác minh payload đã sinh còn khớp nguồn
```

Sau khi sửa nguồn thuộc install unit (`package.json`, `install.sh`, `bin/`, `skills/`, `src/`,
`plugin/server/runtime/` hoặc `plugin/shared/runtime/`), chạy `npm run generate:plugin-payload`,
rồi kiểm tra lại payload. Các kiểm tra local xác minh hành vi source và độ khớp của payload.

Muốn dogfood live từ source checkout, nhờ một session đang mở *run the package's full E2E*. Xem
[docs/development.md](docs/development.md).

Hai README dùng chung một SVG tổng quan từ `scripts/generate-readme-diagrams.mjs`.
Sau khi sửa nguồn, chạy `node scripts/generate-readme-diagrams.mjs`; dùng `--check` để xác minh SVG.

## Tài liệu

Tài liệu chi tiết viết bằng tiếng Anh.

| Đọc                                              | Khi bạn muốn                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)     | Mô hình role, những gì plugin thêm vào Paseo, cách nạp role và delegation      |
| [docs/operations.md](docs/operations.md)         | Kích hoạt, nâng cấp, profile, thiết lập repository, Peer pool, tính năng tùy chọn |
| [docs/cli.md](docs/cli.md)                       | Các lệnh `slp.mjs` offline: `prepare`, `routes`, `route-decide`, `monitor` và các lệnh khác |
| [docs/work-coordination.md](docs/work-coordination.md) | Brief, quyết định, mandate review, report và panel workspace chỉ đọc |
| [docs/work-continuity.md](docs/work-continuity.md) | Handoff owner có chuẩn bị, acknowledgment, quyền trong lịch sử và nghĩa vụ còn lại |
| [docs/task-execution.md](docs/task-execution.md) | Queue native, dispatch có điều phối, proof dependency, tích hợp và reconciliation |
| [docs/contract.md](docs/contract.md)             | Mỗi file sở hữu gì, trước khi bạn sửa nó                                        |
| [docs/development.md](docs/development.md)       | Test, trạng thái xác minh và bộ E2E                                             |
| [docs/decisions/](docs/decisions/)               | Quyết định bền vững, mỗi quyết định một file: quyết gì, ai quyết, vì sao        |
| [AGENTS.md](AGENTS.md)                           | Các quy tắc contributor và agent tuân theo trong repo này                       |

Hợp đồng kỹ thuật của từng tính năng nằm trong [docs/spec/](docs/spec/).

<!-- Đồng bộ yêu cầu cài đặt, các bước thiết lập và ví dụ với README.md. -->

## Giấy phép

MIT, xem [LICENSE](LICENSE).
