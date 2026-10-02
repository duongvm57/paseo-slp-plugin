# Container harness — kiểm thử cài đặt + serve disposable

Harness Docker kiểm chứng cơ chế cài đặt paseo + plugin `paseo-slp` từ chính
checkout này, hoàn toàn trong container: không cài trên host, không đụng home
thật, không đăng ký daemon host, không auth thật.

## Yêu cầu

- Docker daemon chạy được (`docker info` OK). Không cần tài khoản/registry ngoài
  việc pull base image và npm install lúc build/run.
- Mạng outbound cho `npm install` (build image + bước build plugin trong
  container).

## 1. Acceptance một lệnh (install mode)

```bash
./tests/container/run          # hoặc: make -C tests/container test-container
```

Làm gì:

1. Build image `paseo-slp-container-harness:node24-paseo0.9.2` từ
   `node:24-bookworm` pin theo digest
   (`sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4`),
   cài sẵn `@getpaseo/cli@0.9.2` — version nằm trong range
   `plugin/paseo-plugin.json` (`requirements.paseo: >=0.8.0 <0.10.0`).
2. Mount checkout read-only tại `/src`; fake `HOME` + `PASEO_HOME` dưới
   `/acceptance`.
3. `slp.mjs install --paseo-home --apply` (integrated install thật), `verify`,
   `identity`, `instructions` cho cả 3 role, `uninstall` dry-run.
4. `lib/checks.mjs` — 68 invariant: 12 provider `slp-*` (transport map
   codex/pi/`devin→acp`/claude), peer `paseoTools.disabledTools`, 2 saved
   profile, mcp flags bật, fixture config/file human-owned giữ nguyên,
   `installed.json` + `paseo-binding.json` receipts đúng.
5. `lib/plugin-load.mjs` — import `index.server.ts` thật, gọi `contribute()`
   với server stub: toàn bộ RPC surface + before/on hooks + cleanup; sau đó
   `materializer` publish embedded payload vào `$PASEO_HOME/slp-runtime/`,
   `verifyPublished`, và chạy CLI `identity`/`instructions` của runtime đã
   publish.

Thành công in `CONTAINER_ACCEPTANCE_OK` (exit 0); thất bại in
`CONTAINER_ACCEPTANCE_FAIL: <lý do>` (exit 1). Container `--rm` tự hủy; không
có state nào sót lại trên host ngoài image.

## 2. Serve mode (daemon + web UI disposable)

```bash
./tests/container/serve        # hoặc: make -C tests/container serve
./tests/container/serve 18080  # chọn host port khác (mặc định 16767)
```

Làm gì:

1. Chạy `paseo daemon run` foreground trong container với deployment env:
   `PASEO_LISTEN=0.0.0.0:6767`, `PASEO_RELAY_ENABLED=false`,
   `PASEO_WEB_UI_ENABLED=true`; fake `PASEO_HOME` tại `/serve/home/.paseo`,
   `pluginsEnabled=true` set qua `paseo daemon config set` (default là false).
   Không password → daemon `authRequired:false` (local trust mode, không phải
   auth bypass).
2. Chạy đúng `build` commands trong `paseo-plugin.json` trên bản copy writable
   `/serve/plugin-src` (directory source không được daemon chạy build — chỉ
   git/npm managed source mới có), rồi `paseo plugin install` qua daemon RPC.
3. Poll `paseo plugin ls` tới khi plugin `paseo-slp` `status=running`;
   verify `GET /api/health`, `GET /` trả HTML web UI, `paseo status` probe OK.
4. In `CONTAINER_SERVE_READY` và giữ daemon chạy.

Publish host **chỉ loopback**: `127.0.0.1:<host-port>:6767`. URL quan sát thực
tế khi chạy:

- Web UI: `http://127.0.0.1:16767/` (mặc định; đổi bằng tham số port)
- Health: `http://127.0.0.1:16767/api/health`

Dừng và dọn (xóa container `paseo-slp-container-serve`):

```bash
./tests/container/stop         # hoặc: make -C tests/container serve-stop
```

Log daemon + plugin trong container: `docker logs -f paseo-slp-container-serve`
(hoặc `make serve-logs`).

Bảo đảm không-chạm-host: `--cap-drop ALL`, `--no-new-privileges`, không mount
docker socket, không mount home thật, không credential env; `serve`/`stop` chỉ
đụng container có label `slp.mech-docker=serve` do chính harness tạo.

## Layout

```
tests/container/
  Dockerfile            base pin digest + paseo CLI pin ARG PASEO_CLI_VERSION
  entrypoint.sh         dispatcher: accept (default) | serve
  accept.sh             suite acceptance trong container → CONTAINER_ACCEPTANCE_OK
  serve.sh              daemon+web UI disposable trong container → CONTAINER_SERVE_READY
  fixtures/config.json  fake config.json seed (provider legacy + profile + private key)
  lib/checks.mjs        68 invariant assertions sau integrated install
  lib/plugin-load.mjs   contribute() surface + materialize/verify/run published runtime
  run                   host: build + run accept (checkout mount ro, --rm)
  serve                 host: build + run serve, publish 127.0.0.1:<port>:6767
  stop                  host: dừng/xóa serve container (ownership-labeled only)
  Makefile              test-container / serve / serve-logs / serve-stop / clean
```

## Giới hạn

- Đây là acceptance **container-local**, không phải E2E/live: không tạo agent
  thật, không provider session thật, không auth, không relay uplink
  (`PASEO_RELAY_ENABLED=false`).
- Bước `npm install` (image build, plugin build, SDK shim) cần mạng; offline
  sẽ fail sớm với lỗi npm.
- Pin `@getpaseo/cli@0.9.2` thỏa manifest hiện tại; nếu repo nâng
  `requirements.paseo` sang 0.10.x thì đổi `PASEO_CLI_VERSION` trong Dockerfile
  (giữ cùng range manifest).
