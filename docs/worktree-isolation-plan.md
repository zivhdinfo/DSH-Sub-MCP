# Plan: Worktree isolation cho `deepseek_code`

> Trạng thái: **đã triển khai** (Phase 1 + 2, 2026-09-21); Phase 3 (`auto` policy) chưa làm. Khác với plan: `apply` không dùng `--3way` (git đòi index khớp working tree — trái với use case parent đang dở tay) mà apply thẳng, từ chối khi không sạch và chỉ sang `commit` + `git merge`; diff/clean-check so với **tree snapshot** lúc bắt đầu (`worktree.start`, qua index tạm) để tách thay đổi của agent khỏi phần mang sang bằng `includeUncommitted`. Đã test end-to-end với harness thật (mục 8).
>
> Mục tiêu: parent agent (Claude Code / Codex) tự quyết định cho sub-agent code trên một nhánh riêng trên đĩa (git worktree) thay vì trên cây làm việc chính — giống cơ chế `isolation: worktree` của Claude Code.

## 1. Kết luận khả thi

**Khả thi, và có 2 lợi thế cấu trúc so với cách Claude/Codex đang làm:**

1. `workspace` đã là tham số của tool → server tạo worktree và đặt cwd của session vào đó. Codex CLI hiện **không** có cách này cho sub-agent của nó (`spawn_agent` không nhận `cwd`, issue [#18969](https://github.com/openai/codex/issues/18969) còn mở, [#23095](https://github.com/openai/codex/issues/23095) đóng trùng), nên qua MCP này Codex có được isolation mà bản thân nó chưa có.
2. DSH sandbox mặc định `workspace-write` **chỉ cho ghi dưới cwd của session** (fs-sandbox + pwsh ACL restricted token). Đặt cwd = worktree là có isolation cứng: sub-agent không thể ghi vào checkout chính dù cố tình. Claude Code phải tự viết 4 lớp check (edit path, cwd, git redirect, command shape) để đạt điều tương tự.

**Cái giá phải trả (đã kiểm chứng thực nghiệm, mục 3):** vì `.git` thật nằm ở repo chính (ngoài cwd), sub-agent trong worktree **không commit/stash/checkout được**; `status/diff/log` vẫn chạy. Chấp nhận: sub-agent chỉ sửa file + chạy test, **parent là người commit/merge** — đúng vai trò hiện nay (PERSONA đã cấm push).

## 2. Đối chiếu với Claude Code và Codex

| | Claude Code (subagent `isolation: worktree`) | Codex CLI | Đề xuất cho DSH-Sub-MCP |
|---|---|---|---|
| Ai quyết định | Parent (Agent tool `isolation`) hoặc frontmatter agent | Không có; user tự `git worktree add` + `codex --cd` | Parent qua tham số `isolation: "worktree"`; guidance trong SKILL.md / AGENTS.md nói khi nào chọn |
| Vị trí | `<repo>/.claude/worktrees/<name>` | — | `<repo>/.dsh/worktrees/<slug>-<id>` (DSH đã dùng `.dsh/skills` trong workspace → cùng convention) |
| Nhánh | `worktree-<name>` | — | `dsh/<slug>-<id>` |
| Base | default branch của remote (`fresh`), tuỳ chọn `head` | — | **`HEAD` của parent** (mặc định) — sub-agent phải thấy đúng code parent đang làm; `base?` cho phép ref khác |
| Gitignore | User tự thêm `.claude/worktrees/` vào `.gitignore` | — | Server tự ghi `.dsh/` vào `.git/info/exclude` (local, không đụng `.gitignore` của user; ripgrep/Claude cũng tôn trọng file này) |
| File gitignored (`.env`) | `.worktreeinclude` | — | **Đọc cùng file `.worktreeinclude`** để tương thích với repo đã cấu hình cho Claude |
| `node_modules` | Không xử lý (user tự install) | — | Junction tuỳ chọn (mục 3.3) |
| Isolation | 4 check ở tool layer | Không | Sandbox `workspace-write` của DSH (cứng) + guard `workdir` ở `ctx.tools.guard` |
| Khi xong không đổi gì | Tự xoá worktree | — | Tự xoá worktree + nhánh |
| Khi có thay đổi | Giữ lại, sweep theo `cleanupPeriodDays` | — | Giữ lại; parent xử lý bằng `deepseek_worktree` (diff/commit/apply/remove); sweep khi boot cho worktree sạch và cũ |
| Lock khi chạy | `git worktree lock` | — | Giống |
| Sub-agent commit? | Có thể | — | **Không** (sandbox chặn ghi `.git`) — parent commit |

## 3. Kết quả thực nghiệm (git 2.55, Windows 11)

Lab: `scratchpad/wtlab` (đã dọn).

1. **Worktree lồng trong repo** (`<repo>/.dsh/worktrees/test`): repo chính thấy `?? .dsh/`; sau khi thêm `.dsh/` vào `.git/info/exclude` → sạch. `.git` của worktree là file `gitdir: <repo>/.git/worktrees/test`.
2. **Cấm ghi vào `.git` chính** (mô phỏng sandbox bằng ACL deny `WD,AD,WEA,WA,DC,DE`, đọc vẫn cho): trong worktree `git status`, `git diff --stat`, `git log` chạy bình thường; `git add/commit/stash/checkout -- file` fail với `Unable to create .../index.lock: Permission denied`. → Sub-agent không commit được, evidence phía server (unconfined) vẫn lấy được.
3. **Junction `node_modules` trong worktree + `git worktree remove --force`**: git **không** xoá xuyên junction (node_modules gốc nguyên vẹn) nhưng **bỏ lại junction + thư mục worktree** (exit 0, registration đã gỡ). Node `fs.rmSync(junction, {recursive:true})` xoá đúng link, không chạm target. → Thứ tự dọn dẹp bắt buộc: **xoá junction trước, rồi `git worktree remove --force`, rồi `git branch -D`**.

Chưa kiểm chứng (spike bắt buộc trước khi code, mục 7): hành vi thật của ACL sandbox DSH (README nói enforcement "partial" vì token giữ Everyone — có thể git trong worktree vẫn ghi được; cả 2 trường hợp đều chấp nhận được, chỉ khác câu hướng dẫn cho agent).

## 4. Thiết kế

### 4.1 API cho parent

`deepseek_code` thêm:

```
isolation?: "inplace" | "worktree"     // mặc định "inplace" — giữ nguyên hành vi hiện tại
branch?:   string                      // tên nhánh; mặc định dsh/<slug(task)>-<4 hex>
base?:     string                      // ref để tạo nhánh; mặc định HEAD
linkDirs?: string[]                    // junction từ repo chính vào worktree; mặc định ["node_modules"] nếu tồn tại & gitignored; [] để tắt
includeUncommitted?: boolean           // mang diff chưa commit của parent sang worktree (phase 2)
```

Quy tắc: `isolation: "worktree"` bỏ qua dirty-check (worktree mới luôn sạch) — đây là lối ra cho tình huống parent đang dở tay mà vẫn muốn delegate. Repo không phải git → từ chối rõ ràng, không fallback im lặng.

Tool mới `deepseek_worktree({ sessionId, action, message? })`:

| action | Làm gì |
|---|---|
| `status` | path, branch, base, `git status --porcelain` của worktree, có đang chạy không |
| `diff` | `git diff` (kèm untracked qua `add -N` tạm) — để parent review không cần rời cwd |
| `commit` | Server (unconfined) `add -A && commit -m` lên nhánh worktree → parent chỉ việc `git merge dsh/...` |
| `apply` | `git diff --binary` của worktree → `git apply --3way` vào workspace chính (cho parent muốn lấy thay đổi vào cây đang dở, chưa commit) |
| `remove` | Từ chối nếu session đang chạy; xoá junction → `worktree remove --force` → `branch -D` (chỉ khi nhánh chưa merge và có flag `deleteBranch`, mặc định true nếu không có commit) → xoá workspace record trong sidebar |

Merge thì parent tự làm bằng git (nó có tool git); không bọc thêm.

### 4.2 Server (`src/`)

**`workspace.mjs`** (+~150 dòng):
- `createWorktree({ repo, branch, base, slug })` → `{ path, branch, baseSha }`; ghi `.dsh/` vào `.git/info/exclude` nếu chưa có; `git worktree lock --reason "dsh-sub <sessionId>"`.
- `linkDirs(repo, wt, names)` — chỉ junction thư mục **gitignored** và chưa tồn tại trong worktree; ghi danh sách vào record để dọn đúng.
- `copyWorktreeInclude(repo, wt)` — parse `.worktreeinclude` (cú pháp gitignore), copy file **vừa khớp pattern vừa gitignored** (`git check-ignore`).
- `worktreeChanges(wt, baseSha)` — status + `rev-list baseSha..HEAD`; `isClean`.
- `removeWorktree(record)` — thứ tự ở mục 3.3; `unlock` trước `remove`.
- `commitWorktree`, `diffWorktree`, `applyWorktree`.
- Tất cả qua `run('git', ...)` sẵn có, `shell:false`.

**`mcp-plugin.mjs`** (+~150 dòng):
- `startRun`: nếu `isolation === 'worktree'` → sau khi resolve model/effort và `validateWorkspace(repo)`: tạo worktree, `ws = wt.path`, bỏ dirty-check. Header thêm `worktree: <path> | branch: <name> | base: <sha7>`.
- Thay chuỗi đường dẫn repo chính trong `task` bằng đường dẫn worktree (parent gửi absolute path trỏ vào repo chính) — và ghi 1 dòng vào prompt: "Workspace này là git worktree của `<repo>`; không đọc/ghi `<repo>`; bạn không thể commit — parent sẽ commit".
- History record: giữ `workspace` = **repo chính** (để `deepseek_sessions({workspace})` lọc theo cwd của parent vẫn thấy) + thêm `worktree: { path, branch, base, links: [] }`.
- Kết thúc run: evidence từ `gitStatus(wt.path)`; nếu sạch và không có commit → auto-remove, ghi `worktree: removed (no changes)`. Nếu có thay đổi → block "Next steps" với lệnh cụ thể (review / commit+merge / apply / remove).
- `deepseek_continue`: dùng `entry.worktree?.path ?? entry.workspace`; worktree không còn → lỗi rõ.
- Registry sidebar: `attachSession` đòi `cwd === workspace.path` (kiểm tra `dsh-workspace/lib/index.js:122`), nên mỗi worktree là một workspace riêng, title `<repo> ⎇ <branch>`; `registry.delete(id)` khi remove worktree.
- Route `/dsh-sub/worktree` (POST remove/status) cho UI; `runRows` thêm `worktree`.
- Boot: sweep worktree của session đã xong, **sạch**, cũ hơn 7 ngày (không bao giờ xoá worktree có thay đổi).

**`delegate.mjs`** (+~30 dòng):
- `buildPrompt` nhận `worktreeOf` để thêm dòng cảnh báo trên.
- `ctx.tools.guard`: với run có worktree, deny `bash/pwsh` khi `args.workdir` resolve ra ngoài worktree (mềm, bổ sung cho sandbox cứng).
- Title sidebar: `[Code ⎇] - <repo>: …`.

### 4.3 Guidance cho parent (`skills/`)

Thêm mục **"Khi nào dùng `isolation: "worktree"`"** vào `SKILL.md` và `AGENTS.snippet.md`:
- Dùng worktree khi: cây git của bạn đang bẩn (thay vì `allowDirty`); chạy ≥2 `deepseek_code` song song trên cùng repo; thay đổi lớn/rủi ro cần review trước khi chạm cây chính; user yêu cầu "làm trên nhánh riêng".
- Dùng inplace khi: sửa nhỏ, user muốn thấy ngay trong editor, repo không phải git, task cần `node_modules`/build artifact không link được.
- Sau khi xong: đọc `Files changed`, `git -C <wt> diff` hoặc `deepseek_worktree diff`; lấy bằng `commit` + `git merge` hoặc `apply`; bỏ bằng `remove`. **Không** để worktree tồn đọng.
- Nhắc: sub-agent không commit được trong worktree; đừng giao "commit" cho nó.

### 4.4 UI (`client.js`, +~40 dòng)
- Tag `⎇ branch` trên row; detail hiện worktree path; nút **Remove worktree** (disabled khi running); i18n en/zh.

## 5. Rủi ro & cách xử lý

| Rủi ro | Xử lý |
|---|---|
| `node_modules` qua junction: sandbox chặn ghi xuyên junction (target ngoài cwd) → test runner ghi cache (`node_modules/.cache`) fail | Ghi rõ trong prompt cho agent ("cache của test runner có thể bị chặn, dùng `--no-cache`/`CI=1`"); `linkDirs: []` để tắt; native module không ảnh hưởng vì chỉ đọc |
| Thay đổi chưa commit của parent không có trong worktree (base = HEAD) | Phase 2 `includeUncommitted` (`git diff --binary HEAD` + untracked → `git apply` vào worktree); mặc định tắt, guidance nói rõ |
| Windows path dài (thêm `.dsh/worktrees/<slug>-xxxx`) | slug ≤ 24 ký tự; ghi chú `git config core.longpaths true` trong README |
| `git worktree remove` fail vì tiến trình shell của sub-agent còn giữ cwd | `remove` chỉ chạy khi session không running; retry 3 lần cách 500 ms; nếu vẫn fail báo lệnh cho user |
| Submodule không được checkout trong worktree | Phase 2: `git submodule update --init` nếu có `.gitmodules`; phase 1 ghi vào prompt/README |
| Sidebar: mỗi worktree một workspace, có thể rác | Xoá workspace record khi remove worktree; sessions vẫn mở được từ bảng delegations (cần verify ở spike) |
| ACL sandbox "partial" → git trong worktree có thể vẫn ghi được `.git` | Không phá thiết kế; chỉ đổi câu hướng dẫn. Spike xác nhận |
| Parent gửi `task` chứa đường dẫn repo chính | Server thay chuỗi + prompt cảnh báo + sandbox chặn ghi → 3 lớp |
| Hai run cùng lúc cùng slug | Hậu tố 4 hex ngẫu nhiên; git tự lock khi `worktree add` |

## 6. Lộ trình

**Phase 0 — Spike (½ ngày):** chạy `deepseek_code` thật với cwd là một worktree tạo tay: (a) sandbox có chặn ghi ra repo chính không; (b) git trong worktree làm được gì; (c) session hiện ở sidebar thế nào khi workspace = worktree path; (d) `agents.resume` với cwd worktree.

**Phase 1 — MVP (1–1.5 ngày):** `isolation`, `branch`, `base`; tạo/lock/exclude; prompt + thay path; evidence; auto-remove khi sạch; block Next steps; `deepseek_continue`; `deepseek_worktree` với `status/diff/remove`; guidance SKILL.md + AGENTS.snippet; README.

**Phase 2 — Tiện ích (1 ngày):** `commit`, `apply`; `.worktreeinclude`; junction `linkDirs`; `includeUncommitted`; UI tag + nút Remove; sweep khi boot.

**Phase 3 — Chính sách (½ ngày, tuỳ chọn):** setting trong Settings → Sub-agent: *Default isolation: inplace / worktree / auto* (`auto` = worktree khi cây bẩn hoặc đang có run code khác trên cùng repo); parent vẫn override được bằng tham số.

Tổng ~450 dòng, chủ yếu trong 4 file; không thêm dependency.

## 7. Điểm cần chốt trước khi code

1. Vị trí worktree: `<repo>/.dsh/worktrees/` (đề xuất — cùng convention `.dsh/skills` của DSH, sandbox và registry đơn giản) hay thư mục anh em ngoài repo?
2. Base mặc định `HEAD` (đề xuất) hay default branch như Claude?
3. Junction `node_modules` mặc định **bật** khi tồn tại & gitignored (đề xuất) hay mặc định tắt?
4. Auto-commit khi run xong có thay đổi: **không** (đề xuất — parent gọi `commit`/`apply` chủ động) hay có?
5. Phase 3 (`auto` policy) có làm không?

## 8. Kết quả test end-to-end (harness thật, deepseek-flash, 2026-09-21)

Repo lab `wt-e2e` (cây bẩn, có `.env` gitignored + `.worktreeinclude`, `node_modules` gitignored):

| Kịch bản | Kết quả |
|---|---|
| `deepseek_code` `isolation: "worktree"` trên cây bẩn, không `allowDirty` | Chạy; worktree `.dsh/worktrees/<slug>`, `.env` được copy, `node_modules` junction, `.dsh/` vào `info/exclude`; agent sửa file, chạy test pass, `git status/log` chạy được, không commit; WIP của parent nguyên vẹn |
| Sandbox ACL DSH với git trong worktree | Đọc (`status/diff/log`) OK — khớp mô phỏng ở mục 3 |
| `deepseek_worktree status / diff` | Đúng, diff chỉ chứa thay đổi của agent |
| `apply` lên cây chính đang có WIP khác dòng | Thành công (working-tree apply, không `--3way`); test pass, WIP giữ nguyên |
| `remove` | Xoá worktree + nhánh (không có commit), gọi lại bị từ chối |
| 2 delegation song song (`background: true`) | 2 worktree, 2 lock; cái không đổi gì **tự xoá** kèm nhánh; cái có thay đổi giữ lại, lock nhả sau khi xong |
| `deepseek_continue` trên session worktree | Turn 2 chạy trong cùng worktree |
| `commit` → `git merge` | Commit trên nhánh OK; merge conflict trong test là do kịch bản (2 nhánh sửa cùng chỗ), không phải lỗi tool |
| `remove` khi nhánh có commit chưa merge | Worktree xoá, nhánh **giữ lại** + hướng dẫn `git branch -D` |
| `deepseek_continue` sau khi worktree đã xoá | Từ chối với thông báo rõ |
| Sidebar workspace `<repo> ⎇ <branch>` | Tạo khi chạy, xoá khi remove; record cũ được dọn lúc boot |

Chưa làm: Phase 3 (`auto` policy trong Settings), submodule trong worktree, sweep worktree cũ theo tuổi.
