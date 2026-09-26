<h1 align="center">Paseo SLP</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">Bộ role Supervisor–Lead–Peer độc lập dành cho Paseo.</p>

Cài plugin, kích hoạt trên daemon của bạn, chọn **SLP Supervisor** trong
Paseo và giao mục tiêu. Role instruction tự nạp; Supervisor quan sát Lead
hiện có hoặc tạo Lead theo assignment, Lead giao Peer qua Paseo. Bạn có thể
nhắn tiếp trong session Supervisor đã có, không cần nhập lại prompt role.

Ngoài prompt bạn gõ, mỗi seat còn nhận role contract, quy tắc delegation,
spawn kit, policy locators kèm sha256 và managed runtime helpers — phần
này được inject lúc tạo session và không hiện trong tab agent. Chi tiết ở
[Kiến trúc plugin](docs/architecture.md).

## Vì sao subagent chưa đủ

API subagent giải quyết tạo tiến trình. Nó không giải quyết ownership,
phán đoán độc lập, phối hợp, hay nghiệm thu. Trong thực tế, code đa-agent
thường hỏng theo vài cách quen thuộc:

- **Authority gradient** — parent đưa sẵn câu trả lời thì nhận lại sự đồng
  thuận, không phải sự kiểm tra premise.
- **Perfect-plan trap** — coordinator chọn trước file và hướng làm sẽ biến
  worker thành tay đánh máy; dependency thật lộ ra muộn dưới dạng vá.
- **Attention dilution** — coordinator vừa điều phối vừa implement sẽ mất
  tầm nhìn toàn dự án về ownership, dependency và lifecycle.
- **Unsafe parallelism** (song song không an toàn) — hai agent cùng một
  checkout ghi đè cùng file đang thay đổi; workspace hay agent ID không
  phải filesystem isolation.
- **Biased or stale review** (review thiên lệch hoặc cũ) — reviewer thừa
  hưởng framing của tác giả, hoặc review file vẫn đang thay đổi, sẽ duyệt
  một candidate không còn tồn tại.
- **False completion** (hoàn thành giả) — `finished`, `idle`, "xong" và
  test xanh là tín hiệu, không phải bằng chứng rằng đúng artifact đã được
  đúng authority review.
- **Split control planes** (tách control plane) — worker tự spawn worker
  không ai biết khiến không hệ nào biết ai sở hữu task, workspace hay đợt
  sửa.

Thêm agent có thể tăng niềm tin và hoạt động mà không tăng correctness.

## Vì sao SLP

Paseo đã sẵn tạo agent, workspace, parentage và timeline — phần *tạo tiến
trình*. SLP trả lời phần còn lại bằng cách tách *các loại phán đoán* thay
vì xây một thứ bậc cứng `Supervisor > Lead > Peer`:

![Mô hình role Paseo SLP: Human giữ intent, ranh giới và nghiệm thu cuối; Supervisor quan sát workflow của Lead nhưng không tham gia execution; Lead điều phối project và giao outcome hữu hạn cho các Peer Engineer, Architect, Reviewer và Scout độc lập. Peer trả evidence, challenge, dependency request hoặc BLOCKED về Lead; hai instrument Jev advisory tùy chọn — routing advisory tap vào kênh delegation và supervision assessment tap vào kênh evidence-return — không bao giờ là ghế của team.](docs/images/slp-role-model.svg)

- **Human** giữ owner authority: intent, trade-off quan trọng, grant đặc
  biệt, thay đổi protocol và nghiệm thu cuối.
- **Supervisor** bảo vệ chất lượng của workflow và quá trình lập luận —
  bias, lỗi lặp, mất đà, scope trôi, bằng chứng yếu. Nó không implement
  và không nghiệm thu project.
- **Lead** sở hữu framing, routing, dependency, integration và verdict dự
  án. Nó không giải trước phần khó rồi đưa Peer một công việc đánh máy.
- **Peer** là đồng nghiệp độc lập sở hữu một outcome có giới hạn. Nó có
  thể challenge premise, xin dependency hoặc dừng ở blocked — bất đồng
  được dàn xếp bằng bằng chứng chứ không bị coi là chống đối.

Dùng pack này khi các ranh giới đó quan trọng; với task nhỏ một agent,
một agent thường đơn giản hơn. Bản deep dive — role model, design
rationale, và cách plugin chở toàn bộ trên primitive của Paseo nguyên
bản — nằm ở link kiến trúc phía trên.

## Yêu cầu

- Paseo `>=0.8.0 <0.10.0` với `pluginsEnabled: true` trong `config.json` của
  daemon.
- Node >=22 trên máy daemon (plugin tự resolve Node ổn định — không dùng
  binary Electron — lúc kích hoạt).
- Codex/Pi/Devin/Claude CLI tương ứng với các family provider bạn muốn dùng,
  cùng credentials của từng family trên máy daemon.
- Pi cần hỗ trợ `--append-system-prompt` lặp lại (bản Pi hiện được kiểm tra
  có hỗ trợ).
- `mcp.enabled` trong effective config của daemon phải là `true` để kích
  hoạt.

## Cài đặt

Package phân phối dưới dạng Paseo plugin. Cài lên daemon chạy công việc:

```bash
# Từ repo — plugin nằm trong thư mục plugin/ của repo:
paseo plugin install duongvm57/paseo-slp-plugin:plugin

# Pin vào một release cụ thể:
paseo plugin install duongvm57/paseo-slp-plugin:plugin --ref v0.2.0

# Từ checkout local (development):
paseo plugin install /absolute/path/to/paseo-slp/plugin
```

`duongvm57/paseo-slp-plugin` là dạng rút gọn của GitHub; tham số source nhận
mọi thứ `git clone` chấp nhận, kể cả URL HTTPS/SSH đầy đủ hoặc
`file:///absolute/path/to/paseo-slp` cho clone local. Hậu tố `:plugin` chọn
thư mục con. Không có `--ref` thì plugin bám default branch và `paseo plugin
update` kéo commit mới; muốn pin vào một version cụ thể thì truyền `--ref` với
một tag trong
[Releases](https://github.com/duongvm57/paseo-slp-plugin/releases) — tag và
commit thì pin, branch thì dịch chuyển. Daemon checkout
ref vào thư mục quản lý `$PASEO_HOME/plugins/paseo-slp/<id>/` rồi chạy bước
`build` trong manifest (`npm install` trong `plugin/`) trước khi nạp. Kiểm
tra bằng `paseo plugin ls` — plugin phải đạt trạng thái `running`.

Cài đặt chỉ đăng ký plugin; chưa thay đổi cấu hình agent. Kích hoạt là bước
riêng và tường minh (bên dưới). Plugin quản lý runtime installation và cấu
hình host.

## Kích hoạt

Mở **SLP** trên sidebar (hoặc "Open SLP manager" từ command palette) — hoặc
gọi RPC `activate`. Surface hỏi daemon home cần quản lý, xác nhận mapping
host/home, và yêu cầu cửa sổ chỉnh
sửa quản trị độc quyền: trong lúc một operation chạy, không writer nào khác
được sửa `config.json` — plugin tự kiểm tra điều kiện này và báo conflict
thay vì chạy đua.

Kích hoạt sẽ:

- Materialize payload nhúng vào
  `<paseo-home>/slp-runtime/<candidate-sha256>/` — bất biến theo release.
- Resolve Node ổn định cùng executable của bốn family provider (probe
  `--version` thật; family không resolve được thì fail closed).
- Ghi launch shim vào `slp-runtime/launchers/<launchset-sha256>/` — đường
  dẫn ổn định mà providers tham chiếu, để đổi runtime không làm hỏng session
  đang chạy.
- Patch `config.json` với mười hai provider
  `slp-{codex,pi,devin,claude}-{supervisor,lead,peer}`, hai saved profile
  **SLP Supervisor** và **SLP Lead**, đồng thời bật MCP injection.
- Ghi receipt vào `slp-runtime/state/receipt.json` — journal của mọi
  operation, dùng cho drift detection và recovery.

Nút **Inspect** trên surface là read-only — dùng nó để xem trạng thái
(`INACTIVE`/`ACTIVE`/`RECOVERY_REQUIRED`), binding hiện tại, availability
của từng family và conflicts trước khi đổi gì.

- Không tạo agent trong lúc cài hay kích hoạt. Ba role vẫn giữ nguyên.
- **Peer không cần saved profile** — Lead chọn runtime Peer từ pool —
  `.paseo-slp/slp-routing.json` khi repo pin riêng, ngược lại pool user-scope
  `slp-runtime/state/peer-pool.json` do plugin quản lý.
- Repo giữ tactics trong `.paseo-slp/workspace-protocol.md`; onboarding
  hướng dẫn cấu hình cả hai file.
- Nếu entry có sẵn đã chiếm một provider/profile ID của SLP, kích hoạt fail
  với `COLLISION` và giữ nguyên entry đó — `adoptIdentical` chỉ nhận entry
  khớp chính xác.
- Nếu raw config và live config lệch nhau, hoặc một entry thuộc sở hữu bị
  sửa ngoài journal, trạng thái chuyển `RECOVERY_REQUIRED`; chạy **Reconcile
  → inspect** để kiểm tra lại và resolve trước khi thử lại.

## Nâng cấp

Đường update tới daemon phụ thuộc kiểu cài plugin — `paseo plugin ls` hiển
thị kiểu source của từng plugin.

**Git source bám default branch** — cài bằng
`paseo plugin install duongvm57/paseo-slp-plugin:plugin` không kèm `--ref` —
cập nhật qua Paseo:

```bash
paseo plugin update paseo-slp          # review rồi áp dụng
paseo plugin update paseo-slp --check  # chỉ xem update, không cài
paseo plugin update paseo-slp --yes    # áp dụng không hỏi
```

Daemon fetch source, build checkout và reload plugin.

**Git source pin theo ref** — cài với `--ref v0.2.0` — đứng yên trên tag
hay commit đó; `update` thường không có gì mới để đưa vì pin không tự dịch
chuyển. Chọn ref mới tường minh:

```bash
paseo plugin update paseo-slp --ref v0.3.0
```

**Directory install** — `paseo plugin install /absolute/path/to/plugin` —
trỏ thẳng vào checkout đó thay vì một bản copy do daemon quản lý. Code mới
vào khi chính checkout thay đổi (pull, merge, hoặc sửa tay); build lại và
reload để chạy code mới:

```bash
paseo plugin reload paseo-slp
```

Kích hoạt lại sẽ rebind
candidate hiện hành và build lại launchers. Session đang chạy giữ provider
process cho tới khi xong; đường dẫn launch shim ổn định qua các candidate.
Rebind là idempotent: kích hoạt hai lần cùng một candidate là `no-op`.

## Gỡ kích hoạt và gỡ cài

**Deactivate** (màn hình SLP, hoặc RPC `deactivate`) tháo pack ra: gỡ mười
hai provider và hai profile, khôi phục cờ MCP injection về giá trị trước
kích hoạt, đồng thời giữ nguyên mọi thứ khác trong `config.json`. File
runtime, launchers và receipt được **giữ lại** trong `slp-runtime/` để các
session đang chạy không gián đoạn — deactivate không bao giờ xóa chúng. Nếu
giá trị `enabled` của MCP đổi, hoặc một entry được quản lý bị sửa ngoài
journal, deactivate sẽ bị chặn thay vì ghi đè ngầm.

Sau khi deactivate (hoặc với bản cài chưa từng kích hoạt), gỡ đăng ký
plugin:

```bash
paseo plugin remove paseo-slp
```

`remove` chỉ xóa cấu hình plugin — không đụng `slp-runtime/`, trạng thái
`.paseo-slp/` trong repo, hay managed checkout.

## Bắt đầu

Cài đặt làm một lần; mỗi task chỉ lặp bước 4–5.

1. Cài và kích hoạt plugin (ở trên).
2. Tuỳ chọn, một lần: trên màn SLP, card **Communication language** đặt
   ngôn ngữ cho mọi text giữa các seat — prompt, report, handback, brief
   và notebook. Reply trực tiếp tới bạn vẫn theo ngôn ngữ hội thoại hiện tại
   của bạn. Bật toggle, nhập ví dụ `English`, Apply — giá trị nằm trong
   state của plugin, được inject vào mỗi session mới, không cần
   re-activation. Để tắt thì mỗi model tự theo ngôn ngữ của prompt; không
   có gì được inject.
3. Khởi tạo và onboard từng repo công việc một lần (bên dưới).
4. Mỗi task: **New agent** trong workspace của repo → profile
   **SLP Supervisor** → title `Supervisor — <task>` → objective:

   ```text
   <task — ví dụ sửa bug A, thêm feature B, review change C>
   ```

   ví dụ task dài kèm yêu cầu heartbeat — safety net định kỳ đánh thức
   Supervisor kiểm tra khi team bị stall:

   ```text
   Migrate module billing sang API mới. Report về đây verdict kèm các
   check đã chạy.
   Heartbeat: sweep mỗi 30m tới khi có handback.
   ```

5. Gửi, rồi chat tiếp trong session đó — đó là toàn bộ giao diện.
   Supervisor hỏi ở đó khi cần bạn và report kết quả ở đó khi việc xong.

   Phía sau prompt, seat đã mang sẵn role contract, delegation rules và
   spawn kit (xem [Kiến trúc plugin](docs/architecture.md)): nó quan sát
   hoặc tạo Lead, Lead chọn Peer từ pool của repo. Bạn không cần gọi tên
   các seat con — chúng là agent Paseo thường, mở ra xem cũng được.

Vài dòng tuỳ chọn trong prompt là bảo hiểm rẻ, không phải yêu cầu:

- `Repository:` — seat tự resolve repo từ workspace của nó; ghi dòng này
  khi workspace của session có thể không phải target, hoặc task đụng
  nhiều repo.
- `Report về session này…` — handback không có chỗ nào khác để đi; dòng
  này đánh dấu prompt là bounded assignment có deliverable thay vì cuộc
  chat mở, để một seat idle đọc là "đang chờ Lead" chứ không phải "xong
  rồi".
- `Heartbeat:` — ví dụ `Heartbeat: sweep mỗi 30m tới khi có handback` —
  yêu cầu Supervisor arm wake task-local bounded trên session của nó theo
  monitoring reference. Ghi cadence và bound ngay từ đầu đỡ phải prompt
  bổ sung khi team đã chạy; bỏ qua với việc ngắn — protocol default là
  không heartbeat.

**SLP Lead** cũng dùng được nếu bạn muốn giao trực tiếp cho Lead — cùng
flow, bớt một tầng. Supervisor và Lead đã có procedure chọn profile con,
giữ parentage và dùng finish notifications.

## Skills

Skill onboarding dạy agent cách cài đặt bộ pack này cho một repo.

```bash
npx skills add duongvm57/paseo-slp-plugin --skill paseo-slp-onboarding
```

- `paseo-slp-onboarding` — khảo sát repo rồi đề xuất một protocol kết hợp
  assignment, thực thi và giao kết quả. Connector/MCP và tự động pull do harness
  của repo cung cấp. Feature, task từ tracker và thay đổi
  dữ liệu dùng chung protocol; Lead chọn flow theo task. Chỉ tách Lead khi cần
  về quyền hoặc tải công việc. Agent hỏi phần quyết định còn thiếu,
  trình diff đầy đủ và cấu hình pool trong quyền setup; quy trình custom hoàn toàn
  mới cần phỏng vấn sâu. Sau khi cài, skill tự trigger khi bạn yêu cầu onboard/setup SLP.

(`paseo-slp-e2e` không cần cài — nó chạy từ source checkout; xem
[E2E](#e2e).)

Agent chưa có skill? Dán prompt này vào agent bất kỳ:

```text
Help me understand and set up Paseo SLP. Read
https://raw.githubusercontent.com/duongvm57/paseo-slp-plugin/main/docs/agent-guide.md
first, then walk me through it step by step.
```

## Agent profiles

Để đặt model và reasoning riêng cho từng role:

1. Mở **Settings → host chạy công việc → Agents → Agent profiles**.
2. Sửa **SLP Supervisor** hoặc **SLP Lead**.
3. Chọn provider `slp-codex-{role}`, `slp-pi-{role}`, `slp-devin-{role}` hoặc
   `slp-claude-{role}` tương ứng, rồi chọn **Model**, **Thinking**, **Mode**
   nếu provider có và features rồi **Save**.
4. Khi tạo session trực tiếp, chọn profile đã lưu trong model picker. Với
   Peer, dùng onboarding để thiết lập pool trong repo; Lead tự chọn option
   phù hợp từ pool rồi truyền đúng provider/model/settings đó vào
   `create_agent`.

**Thinking** là reasoning effort; **Mode** là quyền/approval, hai thiết lập
khác nhau. Chọn giá trị do provider/model thực tế cung cấp. Agent dùng
`list_profiles`, `list_models`, `inspect_provider` để discover; trường profile
`thinkingOptionId` được truyền thành `settings.thinkingOptionId` khi tạo
agent.

Sửa profile ảnh hưởng lần chọn/launch sau, không cập nhật session đã chạy.
Với session hiện hữu, Paseo có `update_agent` để đổi model/thinking trong
provider đó nếu provider hỗ trợ. Profile vẫn giữ mặc định riêng cho các
session tương lai. Xem
[Agent profiles của Paseo](https://paseo.sh/docs/agent-profiles.md).

## Cấu hình repository

Khởi tạo repo công việc một lần. CLI nằm trong runtime đã materialize —
`runtimePath` của binding đang active (xem trên màn hình SLP/status) là
`<paseo-home>/slp-runtime/<candidate-sha256>`:

```bash
SLP_RT="$HOME/.paseo/slp-runtime/<candidate-sha256>"
node "$SLP_RT/bin/slp.mjs" init /absolute/job-repo --apply
```

Lệnh chỉ tạo các file còn thiếu và giữ nguyên từng file đã có:

- `.paseo-slp/workspace-protocol.md`: quy trình, mức rủi ro, proof gate,
  budget và quyền fallback.
- `.paseo-slp/notebook.md`: notebook mặc định của Supervisor; protocol ghi
  nhận owner và cách truy xuất thực tế (file này hoặc `timeline:<agentId>`).

Init không ghi catalog routing. Khi repo chưa có
`.paseo-slp/slp-routing.json`, runtime đọc pool user-scope do plugin sở hữu
`$PASEO_HOME/slp-runtime/state/peer-pool.json` (mặc định `~/.paseo`) — thẻ
Peer pool trong SLP Manager là writer duy nhất của nó, seed ghế từ danh sách
archetype và lấy model/mode từ catalog provider đang chạy. Mỗi ghế trong 12
ghế chuẩn đặt tên cho một loại công việc và mang bộ token `axis:value` do
package sở hữu (id dành riêng, read-only trên form — xem
`docs/spec/routing-criteria.md`); ghế custom tự do nội dung, còn
provider/`model` để trống tới khi chọn từ catalog đang chạy trên host.
Catalog trong repo là pin có chủ đích, chỉ được tạo bởi `init --routing-from`
(bên dưới).

### Onboarding

Skill onboarding được cài riêng để agent có thể auto-trigger. Từ repo muốn
dùng, cài project-local (tạo `.agents/skills/paseo-slp-onboarding` và có thể
commit cùng repo):

```bash
npx skills@latest add /absolute/path/to/paseo-slp \
  --skill paseo-slp-onboarding --copy --yes
```

Hoặc cài global cho mọi repo của user:

```bash
npx skills@latest add /absolute/path/to/paseo-slp \
  --skill paseo-slp-onboarding --global --copy --yes
```

Sau khi package được publish lên GitHub, thay đường dẫn local bằng
URL/repository đã publish, ví dụ `duongvm57/paseo-slp-plugin`. Dùng project
mode hoặc thêm `--global` như trên; truyền `--agent <name>` nếu muốn chỉ cài cho
một agent thay vì mọi agent được phát hiện. Với lệnh này, project skill nằm ở
`.agents/skills`, global skill nằm ở `~/.agents/skills`; Codex và Pi discover
trực tiếp hai scope đó, còn installer cũng link chúng vào thư mục skill riêng
của từng agent (ví dụ `.claude/skills`) nên Claude cũng nhận được theo cùng
cách. Kiểm tra bằng `npx skills@latest list` hoặc thêm
`--global` cho user scope. Mở session mới sau khi cài, rồi yêu cầu
onboard/setup SLP cho repo; description của skill sẽ trigger workflow. Xem
[skill nguồn](skills/paseo-slp-onboarding/SKILL.md).

Protocol và catalog là hai file tách riêng: protocol là hướng dẫn vận hành,
JSON là dữ liệu routing có thể kiểm tra tự động. Không nhúng JSON vào
Markdown. Lead đọc cả hai trước mỗi Peer delegation, chọn option theo task và
budget, rồi truyền constraint liên quan vào assignment. Mỗi worktree đọc cấu
hình của chính nó.

### Tạo catalog pin theo repository

Để một repository dùng catalog riêng thay cho pool chung, import một file
catalog một lần:

```bash
node "$SLP_RT/bin/slp.mjs" init /absolute/job-repo \
  --routing-from /absolute/path/to/catalog.json --apply
```

Import chỉ tạo catalog khi chưa có; không ghi đè, trộn ngầm hay tiếp tục liên
kết với file nguồn. Sau đó Human chỉnh bản trong repo — plugin không bao giờ
ghi catalog repository. Repo chưa có catalog
thì đọc pool user-scope `$PASEO_HOME/slp-runtime/state/peer-pool.json`;
catalog rỗng trong
repo vẫn authoritative (chặn delegation, và vẫn chặn kể cả khi pool chung
sau đó bị làm rỗng) cho tới khi bị xóa. Không bao giờ
đọc catalog của repo khác.

## Cách các role hoạt động

Protocol chọn topology và proof gate theo risk: task nhỏ có thể dùng một
Engineer; việc nhạy về architecture/lifecycle có Architect, independent
review gate hoặc nhiều lane. Role Peer nhận disposition qua assignment, độc lập
với option runtime. Lead giữ integration và technical acceptance; Supervisor
giữ quan sát và relay quyết định của Human.

Supervisor/Lead dùng event trước; heartbeat là safety net cho phần event
không cover được — seat bị stall sẽ không bao giờ finish, nên không có
finish notification nào tới. Về cơ chế, heartbeat là wake-up định kỳ mà
seat quan sát tự đặt trên session của nó (primitive `create_heartbeat` của
host: một cron + một prompt); mỗi lần fire, seat đó thức dậy làm một pass
kiểm tra bounded trên material delta của team rồi quay lại chờ — đồng hồ
báo thức cho observer, không phải worker hay status poller. Mọi heartbeat
task đều bounded: maxRuns và/hoặc expiry, receipt được ghi lại, xóa khi có
handback hoặc stop. Cadence và điều kiện dừng thuộc protocol/assignment —
với việc dài, yêu cầu ngay trong objective bằng dòng `Heartbeat:` ở trên.
Reference được cài kèm hướng dẫn tạo/xóa heartbeat của đúng session, ghi
causal notebook, recovery và 20 anti-pattern từ guide. Role chỉ dẫn đọc
reference theo tình huống; Peer nhận các constraint liên quan qua
assignment. Đây là policy cho agent sử dụng primitive Paseo — package không
có monitoring daemon hay semantic detector; `monitor` (bên dưới) là scan
tín hiệu delta-only do caller chủ động gọi.

## Peer runtime pool

**Nguồn runtime:** Supervisor/Lead dùng hai saved profile Human cấu hình
trong Paseo. Peer dùng pool `.paseo-slp/slp-routing.json` của repo, hoặc
pool user-scope do plugin sở hữu `$PASEO_HOME/slp-runtime/state/peer-pool.json`
khi repo chưa có — thẻ Peer pool trong Manager là writer duy nhất của nó. Mỗi
option có provider `pi`/`codex`/`devin`/`claude`, model, settings, `suitableFor`,
`avoidFor`, `notes` và trạng thái `enabled`/`availability`. Lead
chọn theo công việc, không gán cứng Engineer/Architect/Reviewer vào model.
Hai Peer có thể khác provider/model/effort mà không thêm saved profile.
Danh sách archetype trong thẻ cho thấy hình dạng: mỗi ghế đặt tên theo kiểu
tác vụ, provider/`model` để trống cho tới khi chọn từ discovery thực tế trên
host.

Lead đọc pool mới, ghi lý do chọn và kiểm tra option/hash bằng `prepare`
trước khi launch (khi Jev routing được arm, dấu vết lý do là phân phối ghi
trên receipt thay vì văn xuôi — xem
[Routing có Jev hỗ trợ](#routing-có-jev-hỗ-trợ-tùy-chọn)). Không có pool/option hợp lệ ở cả hai scope thì hoàn thiện
onboarding; không fallback sang `slp-peer`, settings của Lead hay catalog
repo khác.

### Fallback quota của Peer

Cấu hình trong pool (thẻ Peer pool của Manager, hoặc
`.paseo-slp/slp-routing.json` cho pool pin theo repo):

```json
"quotaFallback": { "enabled": true, "optionId": "luna-code" }
```

`optionId` chỉ định đúng một option trong pool — không danh sách, không thứ
tự. ID phải tồn tại trong `options`; dùng ID thực tế của repo. Mặc định tắt
hoặc thiếu cấu hình thì dừng nhánh hết quota. Khi provider báo hết quota,
Lead được retry đúng một lần lên option được chỉ định; `prepare` nhận thêm
`route.quotaFallbackFrom` là ID option bị quota. Không tự đổi model ngoài
pool bằng `update_agent`, không dùng provider default, và không coi model
khác cùng tài khoản là quota mới. Nếu option được chỉ định không khả dụng
hoặc quota lại hết thì báo BLOCKED; giữ ownership và bằng chứng trước khi
handoff.

### Routing có Jev hỗ trợ (tùy chọn)

Jev là một decision primitive có giới hạn — System One của TypeSafe, chạy qua
một trong hai provider kind: `openrouter` (Decisions API của OpenRouter với
model ghim `typesafe/jev-1.13`) hoặc `typesafe` (System One API chính chủ tại
`https://api.typesafe.ai/v1/systemone` với model ghim `jev-1.13.0`; `baseUrl`
có thể trỏ tới custom https endpoint/proxy mang origin+path prefix). Nó
**không phải** ACP provider và không bao giờ trở thành ghế agent; nó trả lời
một câu hỏi choice đã định kiểu trên `state` do caller cung cấp và trả về đáp
án đã hiệu chuẩn. Nó chỉ chạy qua helper tường minh `route-decide` — không
bao giờ trong vòng lặp nền, lịch định kỳ, hay bên trong `prepare`.

Cấu hình theo từng daemon, qua card **Jev** của SLP Manager
(`<daemonHome>/slp-runtime/state/jev.json` + `jev-<kind>.key` write-only,
0600 — `jev-openrouter.key` hoặc `jev-typesafe.key` theo kind đã chọn). Mọi
toggle mặc định tắt, đánh giá tại thời điểm prepare — đổi toggle
không đụng vào ghế đang chạy, và tắt không xóa key đã lưu. Hai chế độ:

- **Shadow** (`enabled` bật, `capabilities.routing` tắt): `route-decide`
  vẫn phát receipt nhưng lựa chọn của Lead vẫn là ràng buộc; `prepare`
  verify receipt và ghi cả hai lựa chọn (`routing.jev.jevChoice`, `.declined`)
  vào plan.
- **Armed** (`enabled` và `capabilities.routing` đều bật): receipt bắt buộc
  và ràng buộc — `route.optionId` phải khớp đáp án trên receipt.

Đánh giá shadow đi trước khi arm: chạy route-decide cho mỗi delegation,
prepare với lựa chọn của Lead kèm receipt, để các bản ghi cặp tích lũy;
Human đăng ký trước exit criteria — agreement rate và lớp lỗi bất đối xứng —
và chỉ arm capability khi các cặp đã ghi thỏa tiêu chí. Toggle giữ tắt cho
tới khi có dữ liệu đó.

Flow ở cả hai chế độ: Lead tự viết `brief` routing (không bao giờ là bytes
thô của `assignmentFile`) rồi chạy `route-decide <request.json>`; helper
tính tập ứng viên eligible một cách tất định — cùng các exclusion token mà
`prepare` enforce — cộng thêm sentinel `no-suitable-option`, rồi phát ra
`{optionId, catalogSha256, decision}`. `prepare` nhận `route.decision` và
verify receipt offline (hash nội tại, model ghim, khớp catalog hash, ứng
viên trong tập — cộng khớp đáp án khi armed); receipt được cung cấp luôn
được verify kể cả khi Jev tắt. Receipt ghi đầy đủ đáp án, phân phối xác
suất và confidence — confidence là bằng chứng, không bao giờ là ngưỡng
routing. Receipt chứng minh tính nhất quán, không phải authenticity. Khi
armed, dấu vết lý do là phân phối ghi trên receipt chứ không phải văn xuôi
của Lead; ở chế độ shadow, lý do văn xuôi của Lead vẫn áp dụng cùng receipt.

Mọi lỗi đều fail closed: thiếu config/key, OpenRouter hay TypeSafe sập,
timeout, tập eligible rỗng, đáp án ngoài tập ứng viên hay catalog hash cũ đều
từ chối thay vì đoán. Kết quả decline vẫn in receipt nhưng exit 1 — pool thuộc
quyền Human nên escalate thay vì thử lại. Degradation có kiểm soát: khi còn
bật, một outage chỉ chặn delegation phụ thuộc; Human tắt capability trong
Manager card và phán đoán của Lead được khôi phục.

### Giám sát giao tiếp (tùy chọn)

Supervision là capability opt-in thứ hai, cấu hình trong section
**Supervision** nằm trong tab **Jev** của SLP Manager
(`<daemonHome>/slp-runtime/state/supervision.json`, schema 2, 0600, sha256
CAS). Mặc định tắt — chỉ cấu hình Jev không bao giờ bật quan sát. Card có
một công tắc **Supervision** (chính là capability `supervision` của Jev;
bật lên sẽ hiện trước những gì được gửi đi và chi phí), rồi hai lựa chọn
đơn giản (giao diện hiện bằng tiếng Anh):

- **Which Leads** — *All SLP Leads* (defaults của daemon: mọi SLP Lead mà
  plugin khám phá, một `slp-<family>-lead` chính xác thấy qua lifecycle event
  hoặc được verify bằng refresh; Lead bị bỏ chọn thì bị loại ra) hoặc
  *Selected Leads* (mỗi Lead được chọn là một route tường minh; route tường
  minh luôn thắng defaults). Lead được chọn theo tên từ danh sách agent của
  app. Room của từng Lead vẫn tách biệt.
- **When an issue is found** — *Record only* (`shadow`: đánh giá và ghi lại)
  hoặc *Record and alert a Supervisor* (`notify`: gửi thêm prompt cho
  Supervisor chọn từ danh sách).
- **Advanced** — confidence threshold toàn daemon (0.5–1, mặc định 0.9) và
  thời gian chờ trước khi cảnh báo.

Nếu lúc lưu plugin không tra được agent (đã gặp khi chạy thật trên host
0.9.1), cấu hình vẫn được lưu và card báo rõ; Lead đó chỉ được quan sát khi
thấy turn kế tiếp của nó trong đúng workspace.

Mỗi handback của Peer được đánh giá ngay khi tới, qua bộ câu hỏi rubric 3
của Jev (nghĩa vụ tính theo từng turn: thông điệp chỉ chấp nhận/đóng việc chỉ
cần một lời xác nhận phù hợp, còn một câu "ACK"/"Đã nhận" trần không bao giờ
trả lời được thông điệp vẫn đang yêu cầu việc): brief của Lead có mang các nghĩa vụ nhiệm vụ này cần không; handback
có trả lời đúng điều được hỏi (hoàn tất/thiếu/thất bại/chưa verify, ownership,
nhu cầu khi bị chặn) không; và giao tiếp sau đó của Lead có xử lý nghĩa vụ mà
handback nêu ra không — kể cả qua một Peer khác hay escalate lên Supervisor,
hoặc `no_action_required` với kết quả chỉ mang tính thông tin. Case được đánh
giá lại khi có message đã xác nhận mới. Một disposition hay mishandling phải
được Jev gắn với đúng một message đã xác nhận do code đưa ra; im lặng,
acknowledgment hay thời gian trôi qua không bao giờ thành finding. Finding
độc lập theo từng trục và bất biến: message sau chỉ resolve một finding khi
Jev gắn nó là correction cụ thể. Pending delay là checkpoint — finding
brief/handback chỉ được gửi sau mốc này để Lead có cơ hội sửa trước.

Detector chỉ phán giao tiếp — không suy ra authority, không chứng nhận
artifact, không nghiệm thu, không sửa assignment; đầu vào thiếu hoặc không
verify được giữ trục đó ở `unknown`. Ở mode `notify`, một alert do code tạo
("Suspected communication issue — review required") kèm trích đoạn có giới hạn,
đánh dấu không tin cậy, được gửi tới Supervisor của route (hoặc recipient mặc
định), tối đa một lần cho mỗi finding và recipient. Trước mỗi lần gửi,
Supervisor được refresh (SLP Supervisor chính xác, chưa archive, đang active)
và route được kiểm lại; route đổi thì hủy, không bao giờ chuyển sang người
khác. Attempt được ghi trước khi gửi (lịch sử attempt bị hỏng hoặc không đọc
được sẽ chặn việc gửi tới khi được sửa, không bao giờ bị reset); lỗi hoặc
timeout được báo là
`notification delivery uncertain` và không bao giờ gửi lại. Supervisor đang
chạy thì không bị prompt — việc gửi đợi tới khi idle, nhưng prompt rơi đúng
lúc một turn bắt đầu sẽ ngắt turn đó (SDK không có tùy chọn xếp hàng). Chuông
ở workspace của Supervisor có **Open supervision settings** và **Turn off
alerts** (notify → shadow), dùng chung writer CAS phía server.

Dữ liệu ra ngoài và chi phí: shadow và notify gửi brief, handback, các message
đã xác nhận sau handback của Lead tới Peer này, tới các Peer trực tiếp khác và
tới Supervisor, cùng các send đã xác nhận của Peer tới Jev endpoint đã cấu
hình; send chưa xác nhận chỉ gửi id. Mỗi lượt đánh giá là một call trả phí
(tối đa sáu lượt mỗi case). Coverage provider (theo từng trục, dựa trên
timeline thật đã quan sát): Codex, Claude Code và Pi — brief, handback và
message của Lead (chưa chạy live ở vai Lead); Devin — chỉ brief và handback, vì
provider Devin không phát kết quả của lệnh gửi, nên phần xử lý của Lead Devin
không bao giờ được chấm. Phòng trộn family được chấm theo từng trục, một family
không chặn các family khác. Nâng lên coverage này sẽ tắt cấu hình supervision
hiện có cho tới khi bạn lưu lại trong Manager (Restore). Report route không đọc được bằng máy trên host
này (`report-route-unverifiable` được công bố, không phải gate). Case đang mở
và hàng đợi là process-local: restart không replay turn đã lỡ; chỉ các ring
metadata có giới hạn tồn tại (`state/supervision-cases.json` và
`state/supervision-deliveries.json`, ≤200 mục hoặc 30 ngày, không có body).
File schema 1 từ bản trước được đọc với mọi route ở trạng thái off cho tới khi
Human bật lại — nâng cấp không bao giờ mở rộng dữ liệu gửi đi hay tự bật
delivery. Validation E2E live và model evaluation chưa chạy; xem
[docs/spec/supervision-integration.md](docs/spec/supervision-integration.md).

### Work tracker (tùy chọn)

Work tracker cho các seat một đồ thị công việc bền tùy chọn — beads
(`bd`), một issue database theo từng repository — để chúng truy vấn trạng
thái task (issue, assignee, dependency, comment) thay vì dựng lại từ hội
thoại, và đọc lại sau resume hay compaction. Nó là evidence, không bao giờ
là control plane: chỉ Paseo sở hữu lifecycle, parentage, notification và
report route; một claim hay assignee không cấp write scope; trạng thái
tracker không bao giờ thay thế một review gate bắt buộc; status `closed`
là một claim đã ghi, không phải bằng chứng nghiệm thu.

Bật nó trên card **Work tracker** của SLP Manager — toggle ghi
`<daemonHome>/slp-runtime/state/work-tracker.json` (atomic, 0600; file vắng
mặt nghĩa là tắt) và có hiệu lực ở session entry kế tiếp, không cần
re-activation. Card cũng báo `bd` mà nó phát hiện trên PATH của daemon.
**Detect, không bao giờ install:** cài `bd` lên máy (`brew install beads`,
`npm i -g @beads/bd`, hoặc `install.sh` của upstream) và khởi tạo một
repository (`bd init`) là hành động của Human — không gì trong SLP tải,
cài, khởi tạo, nâng cấp hay cấu hình beads, và tracker thiếu hoặc hỏng hiện
ra như một gap đã ghi, không bao giờ là spawn blocker.

Khi bật, các managed session entry có thêm dòng `Work tracker:` nêu policy
reference `src/references/work-tracking.md` (ranh giới, bảng writer —
Supervisor sở hữu root issue, Lead sở hữu children và assignment, mỗi seat
sở hữu status trên issue mang tên nó — và procedure) cùng lệnh probe bên
dưới. Các seat họ hook nhận thêm env overlay
`BEADS_ACTOR=slp-<role>-<agent id>` kèm mặc định
`BD_AGENT_PROFILE=conservative` và `BD_DISABLE_METRICS=1` (env của caller
thắng); seat Devin đi đường khác, không qua env đó, và attribute write bằng
`--actor` theo reference. Settings tắt, vắng mặt hay corrupt không đổi gì
khác — file corrupt là một gap line được surface, và render lúc tắt thì
byte-identical với render trước feature.

Thiết kế đầy đủ, ranh giới và checklist verify trên `bd` thật:
[docs/spec/beads-work-tracker.md](docs/spec/beads-work-tracker.md).

## Handoff provider của Lead

Đổi Lead sang Pi khi Codex hết quota: đổi provider của **SLP Lead** thành
`slp-pi-lead`, chọn model/thinking tương ứng và Save cho các launch sau. Để
chuyển công việc đang chạy, nhắn Supervisor: "Codex hết quota, chuyển Lead
này sang Pi, giữ scope hiện tại và handoff công việc theo profile đã lưu."
Supervisor kiểm tra Lead cũ đã ngừng điều phối, thu state/evidence và tạo
Lead mới với cùng policy trên Pi. Nếu Lead cũ không trả lời được, Supervisor
lấy state từ timeline/artifact; không cần gọi lại model hết quota chỉ để xin
summary. Khi không có Supervisor, Human chuyển handoff sang session Lead mới
và xác nhận ownership.

Đây là handoff sang session mới: host không đổi provider tại chỗ và không tự
chuyển parentage của Peer. Procedure giữ Peer IDs/ownership, xử lý quyền truy
cập descendants và wake sources; Lead mới nhận việc sau khi kiểm tra trạng
thái bàn giao. Nếu muốn tự động chọn provider dự phòng, ghi trước fallback và
budget/authority trong protocol; chỉ lỗi quota không tự cấp quyền đổi
provider. Đổi model/thinking trong cùng provider có thể dùng `update_agent`,
tùy capability của provider.

## Quy ước tên agent

Tên agent dùng quy chuẩn `Supervisor — <task>`, `Lead — <task>` và
`Peer — <Disposition> — <task>`. Ví dụ `Peer — Engineer — checkout totals`
và `Peer — Reviewer — checkout totals` phân biệt hai nhiệm vụ dù cùng role
Peer. Truyền `taskLabel` và `disposition` vào `prepare`; nhiều reviewer thì
thêm phạm vi vào taskLabel, như `checkout totals / API`. Khi bỏ qua,
taskLabel lấy tên thư mục repo và disposition hiển thị `General`. Resume giữ
tên; session handoff mới thêm `Handoff`. Agent ID vẫn là định danh dùng cho
ownership và gửi báo cáo.

## CLI

### `prepare` / `prepare-handoff`

Đường offline tùy chọn: `prepare` nhận role, repository, workspaceId,
assignment. Supervisor/Lead thêm inventory `profiles`/`providers`; Peer thêm
`providers` và `route: {optionId, catalogSha256}` lấy từ `routes`. Có thể kèm
profiles khi chuẩn bị Peer, nhưng chúng không thay thế pool. Hai trường tùy
chọn nữa, áp dụng cho cả `prepare-handoff`:

- `inventoryFile`: đường dẫn tuyệt đối tới JSON object có
  `providers`/`profiles`; các mảng này chỉ điền trường request chưa inline —
  mảng inline tường minh (kể cả `[]`) luôn thắng. Tạo file bằng
  `inventory --paseo-home <absolute-home>` (bên dưới); dưới managed runtime
  providers của nó mang `provenance: "configured"` và bị từ chối làm bằng
  chứng launch — truyền output `list_providers` live từ cùng daemon inline
  vào `providers` thay thế.
- `assignmentFile`: đường dẫn tuyệt đối tới file assignment đầy đủ (phải tồn
  tại, là file thường và đọc được). Prompt giữ `assignment` làm brief ngắn và
  thêm dòng `Assignment file: <path> — read it first; it is authoritative
  for scope details.`; nội dung file không được inline.

Option quyết định nguyên bundle và map sang
`slp-pi-peer`/`slp-codex-peer`/`slp-devin-peer`/`slp-claude-peer`; model chứa `/` được giữ
nguyên. `binding` tường minh không kèm profiles chỉ hỗ trợ Supervisor/Lead
khi được Human cho phép. Peer luôn phải chọn option trong pool, kể cả handoff
và recovery.

Plan cũng surface mode dự kiến của spawn — `modeId` top-level phản chiếu
`create.settings.modeId`, kèm `warnings` khi binding thiếu — và hai payload
locator được mang bên trong `create.initialPrompt` (bản carrier ở prompt chỉ
bị bỏ khi target là canonical role wrapper đã live-verify — wrapper inject
lúc session entry) để seat được spawn thực
sự nhận được: `spawnKit`, danh sách signature approximate của Paseo MCP tools
theo role (verify với `mcp_list_tools` live), và `orientation`, các locator
policy-byte (`path`, `bytes`, `sha256`, hoặc `missing` cho file receipt đã
declare nhưng absent trên disk; tập locator derive từ install receipt nên
document chỉ có ở source không bao giờ được declare). Chỉ locators — việc
diễn giải vẫn thuộc seat.

`prepare-handoff <request.json>` thêm snapshot và handoff vào
create_agent arguments; xem
[ví dụ handoff](examples/provider-handoff.request.json). Hai lệnh chỉ chuẩn
bị arguments; Supervisor/Lead dùng Paseo để thực sự tạo agent.

Ba mode hỗ trợ viết request — đều không có side effect:

- `prepare --schema` in request contract (required keys theo role, các binding
  source, ví dụ minimal với placeholder) ngay từ source checkout — không cần
  request file, install receipt hay daemon. `prepare-handoff --schema` thêm
  các trường settlement evidence.
- `prepare <request.json> --check` chạy đúng các validation stage của planner
  và report từng stage fail theo tên — thiếu profile/provider/model, settings
  không tương thích, catalog hash stale — phân biệt "profile đầy đủ" với
  "provider đã live-verify". Exit 1 khi có stage fail; không tạo gì.
- `prepare <request.json> --emit create` in artifact audit:
  `{ modeId, modeIdSource, create }` — `create` là đúng member `create`
  (record create_agent arguments nguyên vẹn) cho caller truyền thẳng, còn hai
  trường mode ghi lại mode đã resolve và nguồn của nó để file emit tự mô tả
  phục vụ audit. Lưu ý host gap: Paseo hiện không có consumer đọc plan-file
  trực tiếp, nên paste/parse `create` vào `create_agent` vẫn là mitigation
  thủ công cần đối chiếu chéo — chưa loại bỏ rủi ro record bị sửa trước khi
  tới host. `--out <path>` ghi kết quả của lệnh ra file — là response, không
  bao giờ là request file.

Một request đầy đủ gồm: `taskLabel` (mặc định tên repo), role (và
`disposition` cho Peer), `repository` path và `workspaceId` thật,
`assignment` nêu scope, authority, agent ID nhận report và kỳ vọng
verification/handback, cùng một binding source. Brief dài dùng
`assignmentFile` — file riêng từng seat, được tham chiếu read-first chứ
không inline. Trước mọi create_agent, Lead ghi lại lý do topology đã chọn
(seat nào, pool option nào) khớp assignment — khi Jev routing armed, dấu vết
lý do là phân phối trên decision receipt chứ không phải văn xuôi.

### `route-decide`

`route-decide <request.json> [--schema] [--out <path>] [--paseo-home <absolute-home>]`
là đường duy nhất
gọi Jev — xem [Routing có Jev hỗ trợ](#routing-có-jev-hỗ-trợ-tùy-chọn) để biết
nó là gì và áp dụng khi nào. Request mang `repository`, `role` tùy chọn (mặc
định `peer`) và `brief` do Lead viết — một string không rỗng chứa text
task/assignment thô, là context duy nhất Jev thấy về task; mang theo mô tả
tác vụ, tín hiệu rủi ro/effort, ràng buộc và dependencies — brief cằn sẽ
trôi về mức ngẫu nhiên. Dạng có cấu trúc bị từ chối
(`jev-request-invalid`): field `signals` hay object/array cho phép caller
tự phân loại task bằng chính vocabulary quyết định của Jev — hãy đưa sự
kiện vào văn xuôi. Token `axis:value` chuẩn trích trong text được gắn cờ
là unverified mention trong `warnings` của output. Output là `{schemaVersion, optionId, catalogSha256, declined,
role, tokenConflicts, warnings, poolDrift, decision}`; `poolDrift` cùng một
dòng `warnings` báo divergence giữa catalog repo và pool user-scope live
(advisory — catalog vẫn bind, không reconcile). Đưa `optionId`/`catalogSha256`/`decision` vào `route.*` của
request `prepare`. Đáp án `no-suitable-option` vẫn in receipt nhưng exit 1.
Lệnh fail closed trước cả network khi config/key Jev của daemon thiếu hoặc
tắt, và gọi từ source checkout cần một daemon home có config đó
(`--paseo-home` hoặc `PASEO_HOME`). `--schema` in request contract mà không
cần request file hay daemon; `--out` ghi bytes của response, không bao giờ
là request file.

### `routes`

`routes <repository> [--paseo-home <absolute-home>] [--out <path>]` in
catalog routing hiệu lực của repository — đúng bản đọc mà `prepare`
validate:

```bash
node "$SLP_RT/bin/slp.mjs" routes /absolute/repository [--paseo-home /absolute/paseo-home]
```

Catalog trong repo `.paseo-slp/slp-routing.json` thắng khi có mặt; ngược
lại pool user-scope `<paseoHome>/slp-runtime/state/peer-pool.json` là
fallback đã declare — file repo malformed là lỗi authoring, không bao giờ
là trigger fallback. Output mang các field catalog cộng `path`, `scope`,
`sha256` và `tokenConflicts` — đưa `id` của một option và `catalogSha256`
vào `route.*` của request `prepare`. Khi catalog repo thắng trong lúc pool
user live vẫn tồn tại, `userPool` cùng `poolDrift` advisory báo bằng chứng
hai nguồn lệch nhau (không reconcile gì). `jevRouting` báo mode Jev
routing của daemon cho home đã resolve — `unconfigured`, `off`, `shadow`,
`armed`, hoặc `error` cho config đã cấu hình nhưng không đọc được — để
Lead thấy trước một receipt `route-decide` sẽ ràng buộc, chỉ ghi lại, hay
không khả dụng trước khi lên kế hoạch delegation. `--out` ghi bytes
response ra file, không bao giờ là request file.

### `inventory` / `agents`

Hai lệnh read-only hỗ trợ discovery, chạy được offline (không cần daemon hay
`paseo` trên PATH):

```bash
node "$SLP_RT/bin/slp.mjs" inventory [--paseo-home /absolute/paseo-home]
node "$SLP_RT/bin/slp.mjs" agents [--paseo-home /absolute/paseo-home]
```

`inventory` in `{providers, profiles, source}` đúng shape `prepare` nhận —
pipeline dự kiến là `inventory --paseo-home <absolute-home> > inventory.json`,
rồi `"inventoryFile": "/absolute/path/to/inventory.json"` trong request (xem
[`prepare`](#prepare--prepare-handoff) ở trên). Lệnh chỉ gọi `paseo provider
ls --json` khi `paseo.pid` của home được chỉ định là tiến trình đang sống;
không thì đọc `agents.providers` trong `config.json` của chính home đó —
không bao giờ lấy providers của daemon khác và không tạo thư mục. Dưới
managed runtime (`SLP_MANAGED_RUNTIME=1`) listing qua CLI không bao giờ được
gọi và mọi provider đều mang nhãn `provenance: "configured"` — config tĩnh,
bị từ chối làm bằng chứng launch. Dù theo đường nào, inventory chỉ chứng minh
độ đầy đủ của cấu hình, không phải sức khỏe provider; một entry được liệt kê
có thể đã stale và không phải dấu readiness. Providers live được chuẩn hóa thành `{id, enabled,
status}` (`enabled` có thể null với trạng thái không nhận diện được), còn
config cho `{id, enabled, extends}`; profiles luôn đọc từ
`daemon.agentProfiles`. Trên host nhiều daemon, listing live phản ánh daemon
mà `paseo` CLI kết nối tới. `agents` liệt kê `<home>/agents/*/<id>.json`
thành `{id, title, provider, cwd, workspaceId, status, lastActivityAt,
nativeHandle, attach}`; `attach` là gợi ý `cd <cwd> && devin -r <nativeHandle>` đã
shell-quote cho provider devin có handle. Vì `paseo inspect`/`ls` không trả
`persistence.nativeHandle`, lệnh này đọc persistence của daemon — chi tiết
host best-effort, không phải contract.

### `snapshot`

`snapshot <repo>` ghi nhận work snapshot gồm HEAD, đường dẫn
tracked/untracked không bị ignore, nội dung, symlink, permission mode và
deleted marker. Thư mục untracked là root của một repo Git lồng nhau được
snapshot đệ quy và ghi dưới `nested` (mỗi sub-repo có `{path, head, sha256,
files}` riêng và có thể mang `nested` của chính nó, tính vào sha256 tổng).
Thư mục được liệt kê mà không phải repo vẫn không được hỗ trợ.

Gitlink trong index (entry submodule, mode 160000) được snapshot dạng
`{path, kind:"gitlink", indexOid, headOid, state}` — pointer cộng trạng thái
quan sát được, không bao giờ đi vào nội dung submodule. `indexOid` là OID
stage-0 trong index: ngoại lệ staging-intent duy nhất, vì với gitlink chính
entry index là identity object (không có worktree bytes nào biểu diễn
pointer); file thường vẫn hash worktree bytes. Index conflict (stage 1–3)
ghi `indexOid:null` và `state:"conflicted"` thay vì chọn đại một stage.
`headOid` là HEAD riêng của submodule, resolve read-only; `state` ∈
`missing`, `uninitialized`, `clean`, `dirty`, `conflicted`. Mọi state khác
`clean` đưa path vào `incomplete` ở top-level — phạm vi submodule đó là nội
dung chưa chứng minh: `prepare-handoff` đưa danh sách này vào handoff packet
và báo seat mới không được claim full-candidate coverage cho phạm vi đó.

### `materialize`

`.paseo-slp/` là operating state của từng repo. Một repository có thể
commit `workspace-protocol.md` và `slp-routing.json` (repo này làm vậy)
hoặc giữ thư mục đó gitignored — `notebook.md` vẫn là state Supervisor
không track trong cả hai trường hợp. Worktree mới vẫn có thể thiếu
protocol: file bị gitignore không đi theo git, bản đã commit có thể mới
hơn checkout, và bản cũ có thể mang absolute source-root path trong
frontmatter. `materialize` clone các file hiện hành từ một checkout có
sẵn:

```bash
node "$SLP_RT/bin/slp.mjs" materialize /absolute/target-repo --from /absolute/source-repo \
  [--include <repo-relative-path>]... [--paseo-home <absolute-home>]
# mặc định dry-run; thêm --apply để ghi
```

Lệnh copy `.paseo-slp/workspace-protocol.md`, và `.paseo-slp/slp-routing.json`
(đã validate) chỉ khi source thật sự pin catalog — source chưa từng tạo
catalog thì materialize chỉ mang protocol, và target đọc pool user-scope y
hệt source. `.paseo-slp/references/` — dữ kiện vận hành mà protocol trỏ
tới — được copy đệ quy khi có (từ chối symlink và object không phải regular
file). `notebook.md` là state do Supervisor sở hữu và không bao giờ
được copy. `--include` lặp lại được để stage thêm file repository-relative
nguyên byte — spec/evidence chưa track mà seat cần đọc; path được validate
trước khi stage bất cứ thứ gì (từ chối absolute, drive-prefixed, backslash,
segment rỗng/`.`/`..`, NUL, path dưới `.paseo-slp`, symlink và object không
phải regular file), dedupe theo target path và preserve khi đã tồn tại.
`--paseo-home` bật report drift advisory catalog↔pool live trên kết quả
(`poolDrift`). Absolute path nằm dưới source root trong YAML frontmatter của
protocol được rebase sang target root (path anh em dài hơn kiểu
`<source>-old` không khớp boundary nên giữ nguyên). Như `init`, file đã tồn
tại ở target được preserve chứ không ghi đè; mỗi file báo
`preserved`/`applied`, kèm `sha256` cho file sẽ ghi. Entry protocol còn báo
`rebased`, và bản copy ghi ra mà không tìm thấy source-root path nào sẽ mang
field `warning` thay vì lặng lẽ giữ path cũ. Không có fallback về catalog
user-scope hay template nào — source checkout là tường minh.

### `monitor`

`monitor` là scan tín hiệu on-demand cho Supervisor/Lead quan sát — một lần
gọi là một lần scan, không phải daemon, và chỉ emit candidate chứ không ra
verdict:

```bash
node "$SLP_RT/bin/slp.mjs" monitor /absolute/request.json
```

Request khai `agents` (`id`, `cwd` tùy chọn — fallback về `cwd` trong state
file — và `scope` tùy chọn là danh sách prefix/glob), cùng các trường tùy
chọn `paseoHome` (mặc định `$PASEO_HOME`/`~/.paseo`), `devinSessionsDb`
(absolute path, opt-in), `thresholds` (`idleMinutes`, `churnScans`;
`toolWindow` mặc định 20, `toolShare` mặc định 0.8 và `cadenceEdits` mặc
định 3 cho các signal sessions-db), subset `signals` và đường dẫn checkpoint
`stateFile`. Evidence đến từ `<paseoHome>/agents/*/<id>.json` và `git
status`/`git log` trong từng `cwd`; `cwd` thiếu hoặc không phải repo được
ghi thành evidence gap thay vì crash. Có `devinSessionsDb` thì nó probe
sessions db của devin CLI (read-only; thường
`~/.local/share/devin/cli/sessions.db`) cho các agent devin-provider; db
thiếu hoặc không đọc được là gap entry, không phải lỗi. Các loại signal:
`attention` (chỉ khi
`requiresAttention` là true — `attentionReason` cũ chỉ là evidence),
`follow-up-round` (user bump mà không có commit xen giữa), `idle-dirty`,
`scope-drift`, `test-mirror`, `file-churn` (cùng một path dirty bị sửa
lại qua các scan, theo dõi bằng mtime), `tool-mix` và `correction-cadence`
(candidate từ sessions-db, yêu cầu `devinSessionsDb`). Có `stateFile` thì chỉ fingerprint
mới được emit và checkpoint — write duy nhất của lệnh — được ghi lại atomic
mỗi run; không có thì scan gắn cờ `stateless` và emit mọi thứ phát hiện
được. Output rendered của `paseo logs` không bao giờ được parse;
`get_agent_activity` chỉ trả tail đã curated, giới hạn `limit` (session dài
bị truncate vào overflow file) — structured timeline đầy đủ vẫn là host gap
đã ghi nhận.

### `notebook`

`notebook` định vị governance notebook của một repository khi run đang hoạt
động nằm ở checkout khác — record của Supervisor trong worktree nằm ở
`<checkout-của-nó>/.paseo-slp/notebook.md`, không nhìn thấy từ main checkout:

```bash
node "$SLP_RT/bin/slp.mjs" notebook /absolute/repository [--paseo-home /absolute/paseo-home]
```

Lệnh resolve git common dir của repository — thuộc tính liên kết một
worktree về repository của nó — rồi liệt kê các Supervisor agent (provider
chứa `supervisor`, hoặc state file có title `Supervisor`) mà `cwd` chia sẻ
common dir đó. Output chỉ là candidate: `{agentId, title, status, cwd,
lastActivityAt, notebook, notebookExists}` sắp theo activity mới nhất, kèm
`gaps` cho các cwd agent lỗi git probe. Read-only — không copy, merge hay
sửa nội dung notebook, và không chọn candidate nào là authoritative; vị trí
governance vẫn là per-checkout.

### `status` / `local-target`

RPC surface của plugin (status, local-target, …) không có đường invoke cho
agent — `paseo plugin` chỉ là lifecycle và MCP paseo không có tool invoke
(host gap H13). Hai probe này tính lại phần mà file local chứng minh được và
đánh dấu phần còn lại là gaps, không bao giờ đoán:

```bash
node "$SLP_RT/bin/slp.mjs" local-target [--paseo-home /absolute/paseo-home]
node "$SLP_RT/bin/slp.mjs" status       [--paseo-home /absolute/paseo-home]
```

`local-target` báo daemon home mà process này sẽ phục vụ (`--paseo-home` >
env binding của managed session > `PASEO_HOME` > `~/.paseo`). `status` đọc
`<daemonHome>/slp-runtime/state/` (receipt, role-routing,
communication-language) cùng `config.json` và báo: state trong receipt, tóm
tắt binding, các managed profile mà activation đã inject, journal operation
đã ghi, và các check local — khớp target, integrity của runtime đã bind
(`verifyInstall` + candidate hash ghi sẵn), hash bytes của launcher, và quét
drift theo presence cho các provider/profile `slp-*` đã inject. Thiếu
receipt → `INACTIVE`, hoặc `RECOVERY_REQUIRED` khi còn entry `slp-*` mồ côi
trong config; receipt/config hỏng → fail-closed thay vì đoán trạng thái
sạch. Tính lại conflict live và probe family availability là view chỉ daemon
tính được — nằm dưới `gaps`. Các RPC mutation
(activate/reconcile/deactivate/set-language/set-role-routing) vẫn là
Human-authority và không được expose. Hai probe này retire khi host có
`paseo plugin invoke` hoặc MCP `invoke_plugin_rpc`.

### `tracker`

`tracker <repository> [--paseo-home <absolute-home>]` là probe beads
read-only — lệnh mà dòng managed session-entry nêu tên khi work tracker
được bật (xem [Work tracker](#work-tracker-tùy-chọn)):

```bash
node "$SLP_RT/bin/slp.mjs" tracker /absolute/repository [--paseo-home /absolute/paseo-home]
```

Nó in `{tracker, repository, enabled, state, bd, workspace, gaps}`.
`state` là `ready` (`bd` hoạt động và repository là một beads workspace),
`uninitialized` (repository chưa có beads workspace) hoặc `unavailable`
(không có `bd` dùng được trên PATH); `bd` báo `{path, version}` khi tìm
thấy và `workspace` báo `{path, prefix, redirectedFrom}`. Gap là dữ liệu —
lệnh exit 0 kể cả khi state không phải `ready`, và không có
`--paseo-home` thì setting enable không được đọc (`enabled: null`).
Probe chạy `bd version` và `bd where --json` với `BD_DISABLE_METRICS=1`
bị ép, timeout 5 giây và buffer có giới hạn; nó không bao giờ cài, khởi
tạo hay sửa thứ gì — tracker thiếu hoặc hỏng là gap để báo, không phải
lỗi để vá.

## Kiểm thử

```bash
npm test
npm run check
```

Trong managed session, tách suite khỏi ambient runtime env —
`env -i HOME="$HOME" PATH="$PATH" PASEO_HOME="$(mktemp -d)" npm test`,
hoặc unset đủ bộ `SLP_*` (`SLP_DAEMON_HOME SLP_MANAGED_RUNTIME
SLP_RUNTIME_ROOT SLP_NODE_BIN`); unset thiếu sẽ leak runtime vào suite và
gây fail giả.

Kiểm tra local gồm transaction/recovery của manager, materializer, sinh
launch-shim, bảo toàn cấu hình, protocol và adapter stdio; chúng không
chứng minh role tuân thủ operating guide. Plugin đã được kiểm chứng live
trên daemon Paseo 0.8.0 thật: cài qua Git source, surface quản lý, các RPC
activate/deactivate/reconcile, patch provider/profile, từ chối collision và
drift, cùng phân loại recovery — xem `.local-checks/` cho evidence ledger.
Role là instruction hành vi, không phải filesystem/MCP sandbox. Transport
hỗ trợ Codex, Pi, Devin và Claude; routing, adapter và handoff có kiểm tra
local. Live provider switching, heartbeat, council và toàn bộ E2E manifest
chưa được nghiệm thu E2E. Capability và đường nạp policy được ghi trong
bảng trace bên dưới.

## E2E

Để chạy dogfood từ một session mở trên **source checkout** này, yêu cầu:
**"chạy E2E toàn bộ package"**. [Skill E2E](skills/paseo-slp-e2e/SKILL.md)
hướng dẫn session đi qua toàn bộ [scenario manifest](e2e/scenarios.mjs), dùng
các session con trên Paseo thật, thu evidence, review độc lập và cleanup, rồi
trả một báo cáo chung. Quyền, host và budget đã cấp được tái sử dụng; nhánh
thiếu điều kiện ghi BLOCKED. `npm run e2e` chỉ in entrypoint cho session
(exit 2, chưa chạy live); các subcommand hỗ trợ fixture/evidence/verdict được
mô tả trong [hướng dẫn E2E](e2e/README.md). Bộ hỗ trợ này chưa có live
acceptance; việc thêm entrypoint không đổi các trạng thái E2E chưa được kiểm
chứng ở trên.

Để chạy một scenario `basic-*`, cấu hình hai profile Supervisor/Lead
và pool Peer của fixture theo family tương ứng. Coordinator chuẩn bị
fixture/protocol, pool và baseline; Supervisor tạo Lead theo saved profile,
Lead tự chọn Peer option. Không có confirmer trước launch cho basic. U2 đối
chiếu profiles cho Supervisor/Lead và option/hash cho Peer. `mixed-peer` kiểm
tra pool có cả Codex/Pi, không cần thêm saved profile hay ép family của Lead
theo mỗi Peer. Các scenario ngoài scope giữ NOT_RUN.

CLI offline có `prepare <request.json>` để in ra đối số `create_agent` có role
envelope. Lệnh này không đăng ký profile và không tự tạo agent.

## Tài liệu

Cách hoạt động:

- [Kiến trúc plugin](docs/architecture.md) — role model, plugin bổ sung gì
  cho Paseo, kênh inject ẩn, vòng delegation
- [File map và contract](docs/contract.md)
- [Hướng dẫn cài đặt cho agent](docs/agent-guide.md)
- [Checklist nghiệm thu độc lập](docs/review-checklist.md)

Spec implement:

- [Plugin implementation spec](docs/spec/paseo-plugin-implementation.md)
- [Plugin feasibility audit](docs/spec/paseo-plugin-feasibility.md)
- [Settings-driven providers + hook injection](docs/spec/settings-driven-providers.md) —
  khám phá thiết kế
- [Routing có Jev hỗ trợ](docs/spec/jev-routing-investigation.md) và
  [tiêu chí routing](docs/spec/routing-criteria.md)
- [Giám sát giao tiếp](docs/spec/supervision-integration.md)
- [Beads work tracker](docs/spec/beads-work-tracker.md)

Báo cáo và điều tra:

- [Trace guide → policy, procedure và protocol](docs/reports/guide-coverage.md)

Cơ chế host tham chiếu:
[custom providers](https://paseo.sh/docs/custom-providers.md),
[agent profiles](https://paseo.sh/docs/agent-profiles.md),
[Codex app-server](https://learn.chatgpt.com/docs/app-server#threads).
