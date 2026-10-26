# Where this window's time and memory went

Measured on Windows 11, Go 1.27.0, WebView2 155, on 2026-10-24 to 10-26,
on the machine the numbers name. Nothing here is estimated: every figure
was read with the method printed beside it. The prose is Chinese, as it
was written while measuring.

Read this before optimizing anything in the window again. The short
version:

- The Routing page's per-second tally went from 8.7ms a tick to nothing
  when its inputs didn't change, and its stage's motion — magpies flying,
  dots pulsing, wires flowing — cost a renderer and the GPU 172% of a
  core together while requests were under way. With both gone the page
  reads 8–13% of one core's task time under real load, from 60–90%.
- A stock magpie on this machine costs 2.7% of a core and about 1.1GB
  across ten processes idle; in a portable sandbox with `preset: lean`,
  ~633MB with its window open and 87–96MB with the window closed (light
  mode lets the webview go 30–60s after it closes).
- Serving a request costs almost nothing: six concurrent real upstream
  calls were 0.8% of a core and 94MB, because the work is waiting on the
  vendor, not computing.
- `/api/state` was building every agent twice and re-reading the Windows
  uninstall registry each time; the dsh session listing re-read 1154
  folders and statted every file in them on every pass.

[LESSONS.md](../LESSONS.md) carries the two traps this work fell into: a
page timed in a background tab, and `git checkout -- .` on a dirty tree.

---

仓库：`E:\pigzq\magpie-lite`，HEAD `50f52b54`，Go 1.27.0。
所有数字都在本机 Windows 16 核实测，不是估算。改动前先复现这些数字，改动后对比同一数字。

---

## 0. 怎么测（照抄，别自创）

### 0.1 二进制体积
```bash
cd /e/pigzq/magpie-lite
CGO_ENABLED=0 go build -tags nogui -o /tmp/base.exe .
ls -l /tmp/base.exe          # 基线：68,570,112 字节 (65.4 MB)
```

### 0.2 启动耗时与 init 开销
```bash
cd /tmp
GODEBUG=inittrace=1 ./base.exe version 2>&1 | grep "init " | sort -k6 -rn | head -12
```
基线（clock 时间，取前 6 名）：
| 包 | clock |
| --- | --- |
| `internal/gui` | **304 ms** |
| `internal/gateway` | 11 ms |
| `internal/settings` | 4.6 ms |
| `internal/redact` | 4.5 ms |
| `net` | 4.3 ms |
| `internal/provider` | 3.9 ms |
| `internal/library` | 1.6 ms |

注意 `internal/gui` 的 304ms 里绝大部分是 `//go:embed assets`（6.3 MB）的 **decompress + 校验**，
不是真正的逻辑初始化。这个数就是"减法"要打的目标。

### 0.3 运行时 CPU（真实的那个）
pprof 的 `runtime.cgocall` 会把 Windows 消息循环的阻塞等待算成 CPU（基线显示 143%），**那是假象**。
用 PowerShell 量真实值：
```powershell
$p = Get-Process magpie-windows-amd64
$c1 = $p.CPU; Start-Sleep 15; $p.Refresh()
"one core: " + [math]::Round(($p.CPU-$c1)/15*100,1) + "%"
"working set: " + [math]::Round($p.WorkingSet64/1MB,1) + " MB"
```
基线（窗口开着、空闲、无请求）：
- **14.6% of one core**，0.9% 整机
- **226.8 MB working set / 214.1 MB private**
- 44 threads, 948 handles

用网关自带的 profiler 抓（只允许 loopback，见 `internal/gateway/heap.go` 的 `heapRefused`）：
```bash
curl -s --compressed "http://127.0.0.1:3425/v1/magpie/cpu?seconds=20" -o /tmp/cpu.pb.gz
go tool pprof -top -cum -nodecount=60 /tmp/cpu.pb.gz
```

---

## 1. 已定位的真正热点（按实测耗时排序）

### 热点 A（最严重）：`.dsh` 会话目录，每次全量重扫 ~430 ms，且被调两次

**证据**
```
internal/sessions/dsh.go:71  dshFiles()
  filepath.Glob(~/.dsh/sessions/*/*)   -> 1157 个子目录
  每个目录 os.ReadDir() + 每个匹配文件 os.Stat()
  结果：1154 个文件
包内实测：单次 426.5 / 428.6 / 443.5 ms（三次，无缓存，每次都一样慢）
```

**包内实测（比外部脚本更可信，已用 `go test` 跑过）**：
```bash
# 探针（临时文件，测完已删，可照此重建）：
# internal/sessions/zz_perf_probe_test.go
#   在测试体内 os.Setenv("DSH_HOME", `C:\Users\q2303\.dsh`)
#   —— 注意 testenv.Isolate() 会清掉 DSH_HOME，必须在测试体内设，不能靠命令行传
go test ./internal/sessions/ -run TestProbeDshFilesCost -v -count=1
```
输出（本机 1154 个 dsh 会话文件）：
```
dshFiles #1: 426.5ms (1154 files)
dshFiles #2: 428.6ms (1154 files)   <- 无缓存，每次都一样慢
dshFiles #3: 443.5ms (1154 files)
callSources: 423.8ms
allFiles:    457.3ms
CallSources: 427.3ms
```
即：**`callSources()` 和 `allFiles()` 的耗时几乎 100% 是 `dshFiles()`**，
两者各调一次，同一次 Usage 页加载合计约 **880 ms**（外部脚本量到 1.6s 是因为
`filepath.Glob` 之外还有 GC/页缓存冷启动差异，包内数字更可信）。

**为什么是 ×2**：`internal/sessions/calls.go:323 callSources()` 和
`internal/sessions/sessions.go:497 allFiles()` **各自都调 `dshFiles()`**，且都没有缓存。

**调用链**
- `usage.queryPage` → `readRequestState` → `sessions.CallSources` → `callSources` → `dshCallFiles` → `dshFiles`
  （pprof 实测 1.82s / 20s 采样，占 `CallSources` 的 77%）
- `gui.traceRoutes` → `sessions.Titles` → `allFiles` → `dshFiles`
  （pprof 实测 1.77s / 20s 采样）
- 两者都挂在 HTTP 路由上：`GET /api/usage/requests`（`internal/gui/usage.go:105`）
  和 `POST /api/gateway/session-titles`（`internal/gui/trace.go:246`）

**根因**：`dshFiles()` 里唯一的缓存是 `dshHeads`（只缓存文件 header），
**目录列表本身每调用一次就 Glob + ReadDir + Stat 全量重来**。
1157 个目录 × 2 次系统调用 = 单次 ~800ms，Windows 上 `GetFileAttributesEx` 是主要开销
（pprof: `syscall.GetFileAttributesEx` 累计 2.87s/20s）。

**修复方向（三选一，按优先级）**
1. **给目录列表加 TTL 缓存**（推荐）：`dshFiles()` 的结果按 `mtime` 或 2-5 秒 TTL 缓存，
   像 `internal/agent/wsl.go:898` 的 `wslListAge = time.Minute` 那样现成的模式。
   dsh 会话目录不是高频变化的。
2. **`callSources` 和 `allFiles` 共享一次扫描**：让 `callSources()` 复用 `allFiles()` 的结果，
   而不是各调一遍 `dshFiles()`。这是 ×2 的直接原因。
3. **去掉多余的 `os.Stat`**：`dsh.go:93` 的 `stat(&c)` 只为拿 mod time 做"最新文件"选择，
   `os.ReadDir` 返回的 `DirEntry.Info()` 在 Windows 上通常已带属性，可省一次 syscall。

### 热点 B：`/api/state` 每次全量重建 + 全量 agent 探测

**证据**
```
internal/gui/api.go:2348 state()
  -> agent.Detected()  -> 遍历 All()，每个 Agent.Detected() 做 os.Stat/Bin 查找
     pprof: 1.33s / 20s（4.62%）
  -> 每个 agent 的 a.Values() / a.Drift() / a.Wired() / a.StaleCopies() / a.Source()
     pprof: Drift 1.24s / 20s（4.31%），Detected 1s / 20s
```
`/api/state` 被前端调用了 **15 次**（`grep -c 'api("state")'`），
且 `internal/gui/api.go:865` 每次请求还触发 `provider.FetchNewSoon(8*time.Second)`。

**根因**：`agent.Detected()` **完全没有缓存**（`grep detectCache` 无结果），
每次都重新 stat 114 个 agent 的文件/目录/二进制，其中还包括 **WSL 探测**
（`wslList` 会 fork `wsl.exe -l -q`，pprof 0.54s/20s）。

**修复方向**
1. `agent.Detected()` 加 TTL 缓存（agent 安装状态变化是分钟级的）。
2. `/api/state` 已有 `?last=1` 的 `lastKnown()` 快路径（api.go:868），
   但前端 15 处调用大多没带；至少给定时轮询的那几处（drift 15s、lanes 2s）用快路径。
3. WSL 探测：`internal/agent/wsl.go:898` 已有 `wslListAge = time.Minute`，
   但 `wslRunningLocked()` 的 `wslRunningAge` 更短，确认它别在 `/api/state` 路径上被穿透。

### 热点 C：前端定时器打满，其中 `lanes` 每 2 秒一次

**证据**（`internal/gui/assets/app.js`）
| 定时器 | 周期 | 行 |
| --- | --- | --- |
| `refreshLanes` | **2 s** | 13924 |
| `drift` 轮询 | 15 s | 24955 |
| `panelAge` | 30 s | 17913 |
| `quota-ago` 重写 | 30 s | 18005 |
| Privacy 卡片 | 15 s | 22147 |
| `renderUpdateBadge` | 15 min | 25002 |
| `renderPluginDot` | 15 min | 25022 |

`refreshLanes`（2s）虽然自己判了 `document.hidden || view !== "providers"`，
但 `api("lanes")` 打到 Go 侧会走到 provider/account 的全量读取。

**修复方向**：把 `refreshLanes` 从 2s 提到 5s（或 10s），或者改成
"Providers 页可见时才订阅 + SSE 推送"。先做周期调整，改动小、风险低。

### 热点 D：页面每次请求重新读 embed + SHA-256

**证据**
```
internal/gui/api.go:756  revalidated(): 每个请求 fs.ReadFile(staticFS(), name) + sha256
internal/gui/api.go:794  versionedPage(): 对 index.html 里每个资源再 fs.ReadFile + sha256
```
实测 32 个 js/css/html 文件全量 hash = **7.6 ms**（单文件最大 i18n.js 1.86ms）。
单次页面加载（18 个资源）约 4-5 ms CPU。

**不算大热点**，但完全可以省：ETag 是文件内容的函数，
**在 init 或首次请求时算一次缓存起来即可**，不必每次请求重算。
顺带 `versionedPage()` 的结果也是常量，可缓存。

### 热点 E：二进制里的死重（减法的主战场）

`go tool nm -size` 按字节统计：
| 块 | 体积 | 说明 |
| --- | --- | --- |
| `crypto/internal` | **32.61 MB** | Go 标准库全部密码学原语，无裁剪可能（net/http TLS 需要） |
| `runtime.pclntab` | 10.1 MB | 符号表，`-s -w` 已去 |
| `runtime.rodata` | 7.1 MB | |
| `go:string.*` | 7.1 MB | |
| `go:func.*` | 3.4 MB | |
| `moejs`（JS 引擎） | **1.80 MB** | 只被 `plugins/middleware`（JS gateway plugins）用 |
| `sqlite`（modernc） | **1.92 MB** | 被 usage/sessions 用 |
| 各 `plugins/*` | 各 < 0.01 MB | 插件本体极小 |

**结论**：关插件省不了二进制（插件本体可忽略），
**能省的只有 embed 的 6.3 MB 资产和 moejs 1.8 MB**。
所以"减法"真正省的是 **启动 304ms + 运行时内存**，不是文件大小。

---

## 2. 插件开关现状

`~/.config/magpie/plugins.yml` 当前：
```yaml
preset: all
settled: 1
```
即**全部 15 个插件都开着**（`settled: 1` 的定义见 `internal/pluginrt/config.go:55`，
"新安装一律 All"）。

| 插件 | Essential | 说明 |
| --- | --- | --- |
| `budget` | ✅ | Key limits |
| `gateway` | ✅ | Gateway page |
| `middleware` | ✅ | **JS gateway plugins —— 唯一需要 moejs 的** |
| `redact` | ✅ | Privacy masking |
| `rotation` | ✅ | Routing strategies |
| `routing` | ✅ | Routing page |
| `search` | ✅ | Web search |
| `tools` | ✅ | Plugin tools |
| `usage` | ✅ | Usage page |
| `groups` | ❌ | Routing groups |
| `library` | ❌ | Library |
| `otel` | ❌ | **Observability —— 没配 collector 时纯浪费** |
| `sessions` | ❌ | Sessions page |
| `warmups` | ❌ | Warm-up and check-in |

**注意**：`Essential: true` 不等于"必须开"。`InUse` 才是实际判断
（`internal/pluginrt/pluginrt.go` 的 Reconcile）：`middleware` 的 InUse 是
"plugins.json 里有 middleware 开着"，`search` 是"配了搜索 API 或选了 searcher"。
**所以关掉它们不会破坏功能，只要对应的 InUse 计数为 0。**

---

## 3. 已经排除的"假热点"（别浪费时间）

- ❌ `runtime.cgocall` 27.35s/20s —— Windows 消息循环阻塞，不是 CPU
- ❌ 各 `plugins/*` 的 init —— 全部 < 1ms
- ❌ `sqlite` —— 只有 0.15s/20s 的 `_sqlite3VdbeExec`
- ❌ 二进制体积靠关插件 —— 插件本体 < 0.01 MB 每个

---

## 附录：dshbench.go

```go
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

var name = regexp.MustCompile(`^session(?:\.v(\d+))?\.jsonl(\.zstd)?$`)

func walk(root string) (dirs, files, stats int) {
	d, _ := filepath.Glob(filepath.Join(root, "sessions", "*", "*"))
	for _, dir := range d {
		dirs++
		es, err := os.ReadDir(dir)
		if err != nil { continue }
		for _, e := range es {
			m := name.FindStringSubmatch(e.Name())
			if m == nil { continue }
			stats++
			if _, err := os.Stat(filepath.Join(dir, e.Name())); err != nil { continue }
			files++
			_ = strconv.Atoi
		}
	}
	return
}

func main() {
	root := os.Getenv("HOME") + "/.dsh"
	walk(root)
	var total time.Duration
	for i := 0; i < 5; i++ {
		t := time.Now()
		d, f, s := walk(root)
		el := time.Since(t)
		total += el
		if i == 0 { fmt.Printf("dirs=%d files=%d stats=%d\n", d, f, s) }
		fmt.Printf("  walk %d: %v\n", i+1, el.Round(100*time.Microsecond))
	}
	fmt.Printf("avg %.1f ms per walk\n", float64(total.Microseconds())/5/1000)
}
```

---

## 4. 补充发现（比关插件大得多的杠杆）

### 热点 F（**最大**）：WSL 探测每 3 秒 fork 两次 `wsl.exe`

**证据（包内实测）**
```
internal/agent/wsl.go:898-908
  wslListAge        = 1 * time.Minute   // wsl -l -q      的缓存
  wslRunningAge     = 3 * time.Second   // wsl -l --running -q 的缓存  <-- 这里
  wslRunningFailedAge = 30 * time.Second

wsl.exe -l -q            实测 229 ms
wsl.exe -l --running -q  实测 174 ms
合计每次过期 = ~403 ms 的两个子进程 fork
```

包内 `go test` 实测：
```
wslDistros() #1: 378ms (0 distros)      <- 冷
wslDistros() #2: 0s                     <- 3 秒内命中缓存
wslDistros() #3: 0s
wslDistros() #4: 0s
--- 等 3 秒让 wslRunningAge 过期 ---
wslDistros() after expiry: 192ms        <- 又 fork 一次
wslAgents(): 24ms
```

**这条链怎么被高频触发**
```
任意 UI 请求 -> agent.Detected() -> agent.All() -> builtins() -> wslAgents() -> wslDistros()
                                                                              -> wslRunningLocked()
                                                                                 -> wslList("-l","--running","-q")
```
`wslRunningLocked()` 的缓存只有 **3 秒**，所以只要前端有任何轮询（`/api/state` 15 处调用、
`drift` 15s、`lanes` 2s），几乎每次都会撞上过期，各付 174-403ms 的子进程开销。
**这解释了空闲时 14.6% 单核占用**（pprof 里 `agent.wslList` 0.54s / `wslRunningLocked` 0.54s）。

**为什么不是"删功能"而是"调参"**：WSL agent 探测本身是有效功能（本机确实装了
Ubuntu-26.04）。但"某个 distro 是否在运行"这件事的变化频率是**分钟级**，不是 3 秒级。
`wslRunningAge` 从 3s 提到 30-60s，语义不变，开销降一个数量级。

**修复方向**
1. `wslRunningAge` 3s → 30s（保守）或 60s。`wslRunningFailedAge` 保持 30s。
   改前确认 `wslRunningAge` 的注释有没有说明为什么必须是 3s（目前看没有硬理由）。
2. `wslLooks()` 在 `settings.Load().NoWSLAgents` 为真时直接返回 false（已实现），
   所以不想用 WSL 的用户可以直接关掉这条路径——这属于"做减法"的用户侧开关。
3. 可选：`agent.Detected()` 结果加 TTL 缓存（agent 安装状态是分钟级变化）。

### 热点 G：`agent.Clients()` / `builtins()` 冷启动 410-433ms

```
builtins()          冷 433ms (64 agents)    热 ~9ms
agent.Clients()     冷 410ms (67)           热 ~10ms
agent.All()         冷 8ms                  热 ~9ms
agentplug.List()    1.5ms
```
慢的不是 64 个构造函数（逐个量过，只有 `zed` 12ms、`wslAgents` 592ms），
而是 **`wslAgents()` 里的 wsl.exe fork**。所以热点 G 是热点 F 的表象，修 F 即可。

`internal/gui` 的 init 293-433ms 也来自这里：`internal/gui/usage.go:40` 的
`func init()` 里调用 `agent.Clients()`（用于 `usageapi.Clients`）。

**这条要特别注意**：`internal/gui` 被 `nogui` 构建**也链接**（`daemon_cli.go`、`web_cli.go`
要 `gui.Handler`、`gui.StartWeb`）。所以纯 CLI 命令（`magpie version`、`magpie ls`）
每次启动都要付这 293-433ms。这是"减法"最该打的地方：
把 `gui` 的 init 依赖（`agent.Clients()`）改成**惰性**，或让 CLI 路径不触发它。

### 热点 H：`embed` 不是问题（已排除）

实测：
```
assets.ReadFile("assets/app.js") 1.34MB: 3.6 ms
walk 218 files: 0 ms
```
`//go:embed` 是惰性的，6.3MB 资产不产生启动开销。**不要**在这上面做"减法"。

### 热点 F 的关键约束（别乱调这个参数）

`wslRunningAge = 3s` **不是随手写的**，`internal/agent/wsl.go:901-903` 的注释给了理由：

> one the user stops (wsl --shutdown or --terminate, to repair WSL) is seen
> stopped within it, before anything opens its files, which would start it again

即：用户执行 `wsl --shutdown` 之后，magpie 必须在 3 秒内知道"它停了"，
否则一旦去读该 distro 里的文件，就会把用户刚关掉的 WSL 重新拉起来。
所以**不能简单把 3s 改成 60s**，那会让 `wsl --shutdown` 之后 57 秒内的读取把 WSL 唤醒。

真正的高频穿透点在这里（`internal/sessions/wsl.go:178-180`）：
```go
for n := range up {
    up[n] = wslUp(n)     // 每个 distro 调一次；wslUp -> wslRunningLocked -> 可能 fork wsl.exe
}
```
`wslFiles()` 被 `allFiles()` / `callSources()` 调用，而这两个又挂在 `/api/usage/requests`
与 `/api/gateway/session-titles` 上。所以一次 Usage 页加载会走到这里多次。

**因此正确的修法不是调 TTL，而是"别在每次读取时问运行状态"**，三选一：
1. `wslUp()` 增加**单次调用内的去重**：`wslFiles()` 里循环 20 个 distro 时，
   一次 `wsl.exe -l --running -q` 拿到全集即可，而不是每个 distro 问一次
   （当前 `wslRunningLocked` 有 3 秒缓存，所以同一轮里通常只 fork 一次，
   但 TTL 边界上会整轮重付 174ms）。
2. **把"是否运行"的刷新放到后台 goroutine**（比如 15s 一次），读取路径只读快照、
   从不触发 fork。这既保住了 3s 语义（后台仍在 15s 内发现 shutdown），
   又把 fork 从请求路径上摘掉。
3. 用户侧开关：Settings 的 `NoWSLAgents`（`wslLooks()` 已支持）——
   不用 WSL 的人直接关掉整条路径。这是"做减法"最干净的一刀。

**推荐 2 + 3**：后台刷新是根治（请求路径零 fork），用户开关是减法。

### 热点 F/G 的归因定论（决定性实验）

在 `internal/agent` 包里连调 `builtins()`，并在第 4 次前手动清空 wsl 的两个缓存：

```
builtins #1 (everything cold):      365.3 ms
builtins #2 (wsl cached):             6.5 ms
builtins #3 (wsl cached):             7.5 ms
builtins #4 (wsl expired):          371.7 ms   <- 手动清 wsl.at / wsl.runAt 后
```

**结论：`builtins()` 的 ~370ms 里 99% 是 wsl 探测，其余 64 个 agent 构造函数合计只有 ~7ms。**
所以热点 G 完全是热点 F 的表象，**只需修 F**，不要去改 64 个构造函数。

这同时解释了 `internal/gui` 的 init 293-628ms：`internal/gui/usage.go:40` 的 `func init()`
只是给 `usageapi.Clients` 赋一个闭包（成本 0），但 gui 的**包级变量初始化顺序**里有地方
触发了 `agent` 的路径；真正付钱的是 wsl fork。

**对 `nogui` 构建的影响（重要）**
```
go list -tags nogui -deps . | grep internal/gui   -> 命中
```
即 `magpie version`、`magpie ls` 这类纯 CLI 命令**也链接了 internal/gui**，
因此每次启动都付这 370ms。`internal/cli/daemon_cli.go` 与 `web_cli.go` 需要
`gui.Handler` / `gui.StartWeb` / `gui.NewWebKey` / `gui.NetworkLinks`。

减法方向（按收益排序）：
1. 修 wsl 探测（热点 F）—— 一次修好，所有构建和运行路径都受益。
2. 把 `gui` 的页面/API 部分与"纯 CLI 要用的少数符号"拆开（`gui.NewWebKey`、
   `NetworkLinks`、`StartWeb` 与 6.3MB embed + 45k 行 API 无强耦合）。
   这是真正的"做减法"，但改动面大，应先评估再动。
3. 用户侧：Settings → 关掉 "Detect agents in WSL"（`settings.NoWSLAgents`），
   直接摘掉整条 wsl 路径。

### 热点 A 的修复边界（我自己核实过的结论）

一开始我以为"同一页面加载会扫两遍"，实际**不是**：

```
callSources() 内部：... dshCallFiles() -> dshFiles()     只调一次
allFiles()    内部：... dshFiles                        只调一次
```
它们服务于**两个不同的 HTTP 路由**：
- `callSources` → `GET /api/usage/requests`（`internal/gui/usage.go:105`）
- `allFiles` → `POST /api/gateway/session-titles`（`internal/gui/trace.go:246`）

所以不存在"同一次请求内扫两遍"，而是**两条路由各扫一次，都没有缓存**。
修复只需**一个 TTL 缓存**，它同时让两条路由受益：
第二条路由在 TTL 内命中，从 ~430ms 掉到 ~0。

不要在 `callSources`/`allFiles` 之间做"共享单次扫描"——那是伪优化。

---

## 5. 热点 A 的验证结果（我在隔离 worktree 里做完了）

### 关键教训：不要另造 TTL 缓存

我先试了"给目录列表加 2 秒 TTL"，然后试"1 秒内完全不 stat"，都**破坏正确性**：
```
TestDsh                                    after a new reply: 没看到新回复
TestDiscoveryDetectsNewCoworkSessions      new nested session hidden: 1
TestDshCallsReadOnlyWhatWasAppended        a frame appended: not read
TestDshCallsEndSeedAcrossReads             its end-seed read on from []: [100], want none
TestCallsNewestFirst                       order changed
```
原因：纯时间窗口无法区分"文件没变"和"刚新增"。

**项目里已经有正确的机制**：`internal/sessions/discovery.go` 的 `readDirectory()`，
按目录的 **mtime + size** 判断是否重新列目录。这既省开销又不漏新文件。

### 最终方案（3 处改动，全在 `internal/sessions/dsh.go`）

| # | 改动 | 收益 |
| --- | --- | --- |
| 1 | `os.ReadDir(d)` → `readDirectory(d)` | 1157 个目录按 mtime+size 失效，不再每次全量列 |
| 2 | 每文件 `stat(&c)` → `e.Info()` | 省掉 1154 次额外的 `os.Stat` 系统调用 |
| 3 | 修持锁 I/O bug | 原 `dshMu.Lock(); defer Unlock()` 包住整个循环，而循环里 `dshReadHead()` 打开文件；改成只在读写 map 的瞬间持锁 |

第 3 条是**既有 bug**，违反 `docs/code-standards.md` 的
"Nothing that can block runs under a lock its reader needs"。

### 实测（本机 1154 个 dsh 会话文件）

| 指标 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| `dshFiles()` 冷 | 426-443 ms | 827 ms¹ | — |
| `dshFiles()` 热 | 426-443 ms（无缓存） | **188-220 ms** | **省 ~55%** |
| `callSources()` 热 | 423 ms | **176 ms** | 省 ~58% |
| `allFiles()` 热 | 457 ms | **201 ms** | 省 ~56% |

¹ 冷启动数字变大是因为第一次要把整个目录树的 mtime+size 都读进来；之后每次都很便宜。
对用户而言重要的是**稳态**（页面加载、轮询），不是进程第一次调用。

### 为什么没做到"个位数 ms"

剩下 ~200ms 是 1157 个目录各自的 `os.Stat`（`readDirectory` 要拿 mtime+size 才能判断
是否失效）。在 Windows 上这是 `GetFileAttributesEx`，每次约 0.17ms。
要再往下压只能"完全不 stat"，但那会漏新文件（上面已证明）。

**更好的方向**（留给后续）：dsh 的目录结构是 `sessions/<project>/<session-id>/`，
一个 project 目录下有很多 session 目录。如果 dsh 的 project 目录 mtime 能代表其下
所有 session 目录的成员变化，就可以只 stat 115 个 project 目录而不是 1157 个 session 目录，
再省一个数量级。**这需要先验证 dsh 是否在新增 session 时更新 project 目录的 mtime**，
没有验证前不要做。

---

## 6. 最终落地结果（工作区实际改动）

### 改动清单

| 文件 | 改动 |
| --- | --- |
| `internal/pluginrt/config.go` | 加 `PresetLean`；Compose 的 preset 层支持 lean；`Load`/`SetPreset` 接受 lean |
| `internal/cli/plugins_cli.go` | `magpie plugin preset lean` 与 help 文案 |
| `docs/subsystems/plugin-runtime.md` | 同步 lean 的语义与它不等于 essentials |
| `internal/pluginrt/config_test.go` | `TestComposeLean`：在用的开、不在用的关、读失败算在用、用户设置优先、Settle 不覆盖用户的 lean |
| `internal/sessions/dsh.go` | `readDirectory` 替代 `os.ReadDir`；`e.Info()` 替代每文件 `os.Stat`；修持锁 I/O |
| `internal/sessions/discovery.go` | 加 `readDirectoryHook`（测试用，生产路径无开销） |
| `internal/sessions/dsh_listing_test.go` | 新测试：稳定目录不重列、新目录立刻可见 |

### A/B 实测（同一时段交替，8 次取平均）

| | `dshFiles()` 每次 |
| --- | --- |
| 基线（HEAD，无缓存） | **674 / 711 / 824 ms** |
| 优化后 | **194 / 202 / 317 ms** |

**省 55-65%**。`callSources()` 与 `allFiles()` 同比例下降（它们的时间几乎全在 `dshFiles()`）。

> 注：Windows 文件系统缓存的波动很大（同一版本能在 190-330ms 间跳）。
> 只测一次很容易得出错误结论，**必须 A/B 交替**。

### lean 预设的实测行为

全新机器（无 group/key/middleware/search/mask 配置）`preset: lean`：
```
14 个插件 off，只剩 usage 为 active
```
加一个 gateway key 之后：
```
gateway: enabled=true, source="in use", chosen=false, inUse=1
```
即**在用的自动回来，用户无需手动开**。这就是 lean 与 essentials 的实质差别。

### 二进制体积：无变化

`lean.exe` 与 `baseline.exe` 都是 **68,570,112 字节**。
印证：关插件省不了二进制（每个插件本体 < 0.01 MB）。
**减法省的是运行时开销，不是文件大小。**

### 还没做但收益最大的两件事

1. **WSL 探测（热点 F）** —— 空闲 14.6% 单核的真正来源，每 3 秒 fork 两个
   `wsl.exe`（403ms）。修法见第 4 节：把"是否运行"放到后台 goroutine，
   读取路径只读快照。这是**单点收益最大**的一项，且未被本次改动触及。
2. **`nogui` 仍链接 `internal/gui`** —— `magpie version` 这类纯 CLI 命令
   每次启动都付 wsl 探测的钱。要根治得把 `gui` 的页面部分与
   `NewWebKey`/`NetworkLinks`/`StartWeb` 这几个纯 CLI 要用的符号拆开。

---

## 7. 2026-10-25 续：真热点是 path/registry，不是 embed

上一节把 WSL 探测列为最大热点。这一轮在本机（Windows 16，生产实例
0.1.1408，运行 6h52m）用真实 profile 重新定位，结论要修正：

### 7.1 生产实例的实测基线

```
Go 侧稳定 CPU     0.42% 单核（30s 采样，窗口开着空闲）
working set       88 MB 沙盒 / 236 MB 生产
goroutines        64
heap live         62 MB（heap profile 的 LiveHeap）
wsl.exe fork      30s 内 4 次，子进程 CPU 合计 0%（它是在等，不是在算）
```

即：**稳定态不烧 CPU**。上一节 14.6% 的读数，一部分来自 pprof 把
Windows 消息循环的阻塞算成 CPU（`runtime.cgocall` 占 97.6%），
另一部分来自启动瞬间。真正贵的是**每次 /api/state 的 200ms 级开销**。

### 7.2 实测热点（`/api/state`，旧二进制）

```
gui.state                    12.06s / 20s
  agent.Detected              6.99s  57.9%
  agent.Clients               2.36s  19.6%
  agent.(*Agent).Drift        1.01s   8.4%
  gui.agentFields             0.79s   6.5%
```

`agent.Detected` 里 59% 是 **`reasonixIn.func10` → `reasonixStudioDirs()`**：

```go
// internal/agent/reasonix_detect_windows.go（改前）
func reasonixStudioDirs() []string {
    for _, hive := range []registry.Key{CURRENT_USER, LOCAL_MACHINE} {
        for _, root := range []string{Uninstall, WOW6432Node\...\Uninstall} {
            k, _ := registry.OpenKey(hive, root, registry.READ)
            names, _ := k.ReadSubKeyNames(-1)   // 整个 Uninstall 树
            ...
```

**每次 /api/state 都全量枚举两个 hive 的 Uninstall 注册表**，
开销 3.65s / 20s（`GetStringValue` 1.78s、`OpenKey` 0.84s、
`ReadSubKeyNames` 0.69s）。而"装了什么程序"是分钟级变化。

### 7.3 三处修复

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `internal/agent/wsl.go` | `wsl.exe` 的 fork 移出 `wsl` 互斥锁，改用独立的 `wslFork`；拿不到就返回上一次的答案（绝不等子进程） |
| 2 | `internal/agent/reasonix_detect_windows.go` | Uninstall 枚举结果按 60s 缓存（`reasonixDirsFor`，测试下为 0，与 `almaReadFor` 同一模式） |
| 3 | `internal/agent/agents.go`、`agent.go`、`internal/gui/api.go` | 加 `ClientsOf` / `DetectedOf`，`state()` 只构建一次 `All()` |

第 1 条同时修了一个**违反 `docs/code-standards.md:19`** 的 bug：
`wslDistros()` 原先把整个函数包在 `wsl.Lock()` 里，循环里调
`wslProbe()`（30s 超时）和 `wslList()`（10s 超时）。代码自己的注释
（#2341）写着"each ask that times out holds wsl's lock, and so the GUI,
for 10s"——他们当初只是加了 30s 失败缓存打补丁，没修根因。

`TestWSLProbeNotUnderLock` 在旧代码上红、新代码上绿。

### 7.4 A/B（同一台机、交替两轮、每轮 30 次请求）

```
old: n=60 p50=134ms p90=228ms max=12447ms
new: n=60 p50= 67ms p90=153ms max= 3418ms
```

`/api/state` p50 **134 → 67ms（快 2.0×）**，p90 228 → 153ms。

### 7.5 注意事项

- `-race` 在本机跑不了：`cc1.exe: sorry, unimplemented: 64-bit mode not compiled in`。
  **第 1 条改动动了锁的顺序，必须在有 64 位 gcc 的机器上补跑 `-race`。**
- `TestCopilotFolderFromAnIDEPluginIsNotTheCLI`、`TestQoderSettingsFromAnIDEPluginIsNotTheCLI`、
  `TestIsMagpieKeptWhileCatalogStays`、`TestPrimeAgent` 四个红**在干净 HEAD 上一样红**（已用
  `git stash` 验证），不是这批改动引入的。
- 本机 PATH 有 99 个条目（10 个重复）。`magpie version` 冷启动 ~1.2s，其中
  `internal/gui` 的 init 占 ~280ms（`proc` 的 PATH 查找）。这条还没动。

### 7.6 `internal/agent` 全套的 9 个红（全部在干净 HEAD 上同样红）

用 `git stash push -u -- internal/agent/ docs/` 回到 HEAD 逐个复跑，结果与本改动无关。
其中 5 个早先已确认，新增 4 个也在 HEAD 上单独跑就红：

| 测试 | HEAD 上的失败 |
| --- | --- |
| `TestAsideOfflineDisconnectRestoresWithoutDaemon` | `native fixture must report missing CLI` |
| `TestWSLClaudeFollowerOnTheMainModelIsNoDrift` | `stopped: not what was last seen`（`-count=5` 反复红；单独跑一次**通过**，全套里红） |
| `TestClaudeDesktopCarriesTheLanguage` | `AppData\Local\Claude-3p\config.json: cannot find the file` |
| `TestCodexSyncMendsGoneCatalog` | `config.toml still names …\magpie-models.json` |
| `TestCodexSignInInKeychain` | `the item's ChatGPT sign-in wasn't seen` |
| `TestCopilotFolderFromAnIDEPluginIsNotTheCLI` | `the copilot command on PATH no longer finds the Copilot CLI` |
| `TestQoderSettingsFromAnIDEPluginIsNotTheCLI` | `qodercli/qoderclicn on PATH no longer finds Qoder` |
| `TestIsMagpieKeptWhileCatalogStays` | `378 allocations for two answers already given` |
| `TestPrimeAgent` | 行内容不符 |

`internal/sessions` 的全套另有 1 个红，同样在 HEAD 上重现：
`TestCursorEditorCopiedOncePerChange` —— `copies left in the temp folder: [magpie-cursor-fresh]`
（LESSONS 里已点名过这个测试）。

**这些不是本改动引入，但也还没人修。**

### 7.7 `internal/gui` 全套的 3 个红（同样在干净 HEAD 上重现）

`gui` 全套 1302s，3 个红，均已用 `git stash` 在 HEAD 上单独复跑确认：

| 测试 | 失败 |
| --- | --- |
| `TestLodyImportHandoff` | `%AppData% is not defined` |
| `TestProxyCheckSaysAProxyPassedBy` | `passed by: … Error:HTTP 502 Proxied:false, the proxy asked 0 times` |
| `TestUpdateThatWontStart` | `relaunched 0 times`（`.new` 不是有效 Win32 程序） |

### 7.8 测试运行记录（本机，一次只跑一个）

| 包 | 耗时 | 结果 |
| --- | --- | --- |
| `internal/agent` | 2536s | 9 FAIL，全在 HEAD 上重现 |
| `internal/sessions` | 298s | 1 FAIL（`TestCursorEditorCopiedOncePerChange`），HEAD 上重现 |
| `internal/gui` | 1302s | 3 FAIL，全在 HEAD 上重现 |
| `internal/agent`（WSL/Reasonix 专项） | 159s | ok |
| `internal/cli`（Clients/UserAgent/IsAgent/Pi） | 145s | ok |
| `internal/agent`（WSL 锁） | 12s | ok |
| `internal/proc` | 6s | ok |

**没有跑的**：`-race`（本机 cc1.exe 不支持 64 位），以及 `internal/provider`、`internal/gateway`、`internal/usage` 的全套
（本改动没触及那些包，但按 LESSONS 的规矩，真正合并前要跑 `go test ./... -timeout 45m`）。

## 8. 2026-10-25 夜：Routing 页每秒重算的账目（前端）

### 8.1 归因

Routing 页停着不倒（1754 条今天的请求），`client.js` 每 1000ms 的定时器要跑
`sync()`、`render()`、`listed()`、`renderActs()`。用 CDP 的
`Performance.getMetrics` 分部计时：

| 段 | 每次 tick | 占一核 |
| --- | --- | --- |
| `sync()` | 0.01ms | 0.00% |
| `render()` | 0.31ms | 0.03% |
| `listed()` | 0.40ms | 0.04% |
| `renderActs()` | 10.12ms | 1.01% |

清光所有 interval 后整页降到 0.10%/0.20%（script/task），也就是**这个定时器
占了 96%**。再拆 `renderActs()` 内部：聚合 8.67ms、建 DOM+patch 1.19ms。
聚合每秒把 1754 条请求的 `order` 和 `tries` 重走一遍（约 5000 个字面量对象），
只为算出 **7 行**；而倒计时才是每秒必须重画的东西。

### 8.2 改法

`renderActs()` 里的聚合抽成 `tallyOf(rs)` 并缓存：只有这批 route 对象、看的是
哪一天、或手动解除 rest 的计数变了才重算。`poll()` 只在路由真的变化时才用新对象
替换它（`routes.set(r.id, whole(r))`），所以「同样的对象数组」就等于「同样的集合」。
倒计时仍在每秒的 DOM 循环里用 `now()` 现算，缓存里只存聚合结果。

### 8.3 A/B（同一台机、同一份 1754 条数据、同一个页面状态，25s）

| 版本 | script | task | layout | style |
| --- | --- | --- | --- | --- |
| 改前（HEAD 的 client.js） | 1.32% | 3.17% | 34ms | 37ms |
| 改后 | 0.38% | 2.10% | 32ms | 37ms |

script 降到 29%（−71%），task 降到 66%。两次都是 7 行 tally。

### 8.4 没做的

- `render()` 的 0.31ms 和建 DOM 的 1.19ms 留着：倒计时每秒都得重画，再压
  就要把行拆成「变了才重建」，复杂度不值这点。
- GUI 测试（Playwright 两引擎）：本机没有 Playwright，正在临时目录里装 1.62.1
  和 chromium/webkit，跑完补记录。

### 8.5 GUI 测试（本机，Playwright 1.62.1 装在 E:\pigzq\magpie-sandbox\pw）

| 跑法 | 结果 |
| --- | --- |
| `routing-*.test.cjs` + `panel-routing*.test.cjs`，两引擎全语言，2 并发 | 803 ✔ / 6 ✖ |
| 6 个 ✖ | 全在 webkit：`routing-bodies` 5 个 + `routing-day-window` 1 个 |
| 单独跑 `routing-bodies`（webkit），改动前后各一次 | 前后同样红：`.rt-day` 按钮 "element is not visible" 超时，HEAD 的 client.js 上也是 1–2 个 ✔ 其余 ✖ —— 不是本改动引入的 |
| 单独跑 `routing-day-window`（webkit） | 14 ✔ 0 ✖，全绿；整套里的 ✖ 是并发负载下的 flake 形态 |
| `routing-steady.test.cjs`（改动后，两引擎） | ✔✔；新增的 tally 断言在人为把缓存做成永不失效时变红（实测 ✖ `the tally must follow the requests that came in`），缓存正常时 ✔ |
| `i18n-keys.test.cjs` | 3 ✔（本次没加新字符串） |
| `go test ./internal/gui -run 'TestCoreScriptBudget|TestAssets'` | ok 19.9s（routing 是插件脚本，不在 core 预算内） |

**没有跑的**：整套 GUI（1000+ 个文件）。改动只碰 `renderActs` 的取数路径，
跑了全部 routing 相关页面测试 + i18n + 预算守卫。`routing-bodies` 在 webkit
上单独跑前后都红，是既有问题（未在本轮提 issue）。

## 9. 2026-10-26：真数据 + 前台标签页重测（纠正 §8.3）

§8.3 的数字是在**后台标签页**测的，rAF 被降到 1fps，`/api/gateway/trace`
长轮询也被节流，绝对值偏低；而且当时一天的数据是造出来的。这轮换成：

- 真数据：沙盒 `data/routing/2026-10-25.jsonl.gz` 里的 **1754 条真实请求**（4.6MB 解码）
- 真供应商：讯飞 `maas-api-cn-huabei-1-xf-yun/spark-x2.6`，经沙盒网关
  `POST /v1/chat/completions` 实调成功（返回 50 tokens）
- 页面用 `Page.bringToFront` 置前台，`document.hidden === false` 才计

### 9.1 结果（各 20 秒，交替跑）

| 版本 | script | task | layout | style |
| --- | --- | --- | --- | --- |
| 改前 | 3.07% | 6.60% | 2ms/s | 2ms/s |
| 改后 | 1.02% | 4.15% | 2ms/s | 2ms/s |
| 改前（第二次） | 2.72% | 5.00% | 2ms/s | 1ms/s |
| 改后（第二次） | 0.63% | 3.05% | 2ms/s | 2ms/s |

**script 平均降到 2.90% → 0.83%（−71%）**，和 §8.3 的 −71% 吻合；
task 平均 5.80% → 3.60%。layout/style 本来就不是瓶颈（1–2ms/s）。

### 9.2 逐页（改后版，每页 12 秒）

| 页面 | script | task |
| --- | --- | --- |
| agents | 0.03% | 0.25% |
| sessions | 0.03% | 1.52% |
| library | 0.03% | 0.11% |
| providers | 0.03% | 0.20% |
| **routing** | **1.71%** | **15.89%**\* |
| gateway | 0.03% | 0.98% |
| usage | 0.11% | 0.43% |
| plugins | 0.07% | 2.86% |

\* 这一格是后台标签页测的，节流让绝对值失真，只可用于页间横向比较；
前台重测为 script 0.83% / task 3.60%。

### 9.3 剩下的大头在哪

改后版做 CPU profile（25 秒，40876 采样）：**96.9% idle**，`renderActs` 已降到
0.0%，剩下的都是 0.1% 以下的零散帧工作。Routing 页确实不再是问题。

### 9.4 一个踩过的坑

后台标签页测出来的 `task=15.89%`、`layoutCount=1507000/20s` 是**假热点**：
Throttled 的 rAF + `getAnimations()` 里 36 条 CSSTransition 反复重启造成的
measurement artifact。把动画 `pause()` 掉数字几乎不变（14.57% → 14.42%），
说明那 150 万次 layout 不是动画引起的，而是节流本身的形态。**以后前端性能
一律先确认 `document.hidden === false`。**

### 9.5 Routing 页的动效（实测清单）

改后版、前台、live view（有请求在飞）：

| | 数量 | 说明 |
| --- | --- | --- |
| 运行中的动画 | 22 | 前台非节流 |
| 其中 `infinite` | 15 | 见下表 |

| 动画 | 数量 | 目标 | 状态 |
| --- | --- | --- | --- |
| `rtflap` | 4 | `.rt-flier` 的 `wing.near` / `wing.far` | **只在有请求在飞时**，`away()` 后 450ms 移除 |
| `rtlive` | 6 | `.rt-livedot.on`、`li.now .dot`、`li.wait`、`.rt-req.wait .to i` | 循环脉冲，常量 |
| `rtflow` | 4 | `.rt-wires path.live` | 虚线流动，只连 busy 的 agent |
| `ctx-pulse` | 1 | `.ctx-state.live i` | 常量 |

静态的一天（1754 条，没有请求在飞）：**只剩 1 个 infinite**（`rt-livedot`，
表示"live"的绿点）。没有滞留的 magpie，没有残留的 packet。

### 9.6 动画到底花多少

`getAnimations().pause()` 前后各 15 秒（前台）：

| | script | task | style | layout |
| --- | --- | --- | --- | --- |
| 有动画 | 1.13% | 9.48% | 16ms/s | 12ms/s |
| 暂停动画 | 0.74% | 5.90% | 9ms/s | 7ms/s |

**动画约占 live view 的 1/3**（task −3.6 个点）。但它们不是白烧的：`rtflap`
就是"鸟在飞"这个核心视觉，`rtflow` 是 busy 连线的流动。真正的问题只有
`rtlive` 6 个脉冲在没有任何活动时也一直跑。

### 9.7 可以做的（按性价比）

1. **`rtlive` 只在真有活动时跑**：`li.now .dot`、`li.wait`、`.rt-req.wait .to i`
   在 live 视图停着、没有请求在飞时不该脉冲。用 `.rt-stage.busy` 之类的
   父类门控，静态时归零 —— 静态一天能到 0 个 infinite。
2. **`rtflow` 已是按需**（只在 `path.live`，连着 busy 的 agent），不动。
3. **`rtflap` 已是按需**，不动。
4. **`ctx-pulse`** 是上下文卡片的状态点，同理可以门控。

`prefers-reduced-motion` 已覆盖 7 处（163 行那条一次性关掉所有循环动画），
这块没问题。

### 9.8 动画占资源吗：分两种状态

**静态的一天（1754 条、没有请求在飞，只剩 `rtlive` 一个循环）**，前台 20 秒：

| | script | task | style | layout |
| --- | --- | --- | --- | --- |
| 有动画 | 0.77% | 3.02% | 1ms/s | 2ms/s |
| 暂停动画 | 0.69% | 2.75% | 1ms/s | 2ms/s |

差 **0.27 个点、不到 9%**。静态时的动画基本白给，不值得为它动结构。

**live view（有请求在飞，22 个动画 / 15 个循环）**，前台 15 秒：

| | script | task | style | layout |
| --- | --- | --- | --- | --- |
| 有动画 | 1.13% | 9.48% | 16ms/s | 12ms/s |
| 暂停动画 | 0.74% | 5.90% | 9ms/s | 7ms/s |

差 3.6 个点。但那 3.6 点里绝大部分是 `rtflap`（鸟在扇翅膀）和 `rtflow`
（busy 连线在流动），这两个就是"请求正在飞"这个核心视觉本身。砍掉等于砍
功能，不是砍浪费。

**结论：动画不是瓶颈。** 修好 `tallyOf` 之后，静态页面 task 3.0%、live 9.5%，
其中动画占 live 的三分之一但都是有意为之。真要再降，该动的是别的东西。

## 10. 真 webview 实测（推翻 §9 的一半结论）

§9 是拿 `magpie web` 在 ego（Chromium）里测的。**`magpie web` 没有 webview**，
那个数字不代表用户桌面上的 magpie。这轮直接连真 WebView2：

```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" ./magpie-dev.exe
# CDP: http://127.0.0.1:9222/json/list → http://wails.localhost/?view=routing
```

### 10.1 单页指标（CDP Performance.getMetrics，窗口 512×512）

| 状态 | script | task | style | layout |
| --- | --- | --- | --- | --- |
| 空载（无请求） | 0.02–0.05% | 0.05–0.60% | 0ms/s | 0ms/s |
| 有真实请求在飞 | 3.3–4.5% | **60–88%** | 93–111ms/s | 31–41ms/s |
| 负载停了、页面还开着 | 0.2% | **75%** | 70–82ms/s | 26ms/s |

**task 75% 而 script 0.2%**：JS 几乎不干活，是浏览器原生渲染在烧。

### 10.2 进程真值（Windows CPU 计数器，15 秒）

| 目标 | CPU |
| --- | --- |
| 沙盒 magpie-dev（有负载） | **172% 单核**（GPU 进程 61% + renderer 110%） |
| 生产 magpie 整棵树（空载） | 2.71% |
| 生产 webview 树（空载） | 17.19%（GPU 5.2% + renderer 1.7% + 10.2%） |

### 10.3 排除掉的

| 嫌疑 | 做法 | 结果 |
| --- | --- | --- |
| CSS 动画 | 注入 `animation:none` 关掉全部 | task 91%→82%，**不是主因** |
| SVG `drop-shadow` 滤镜 | `filter:none` | task 91%→89%，不是 |
| rAF 飞行循环 | 覆盖 `requestAnimationFrame` | task 91%→85%，不是 |
| 每秒定时器 | 清掉全部 interval/timeout | task 76%→71%，layout 归零，**不是** |
| 滞留的 30 只 magpie | `.rt-flier` 全部 remove | 65 个动画→5 个，task 76%→65%，**占 10 点** |

### 10.4 结论

1. **有一个真 bug**：`play()` 结束后 `.rt-flier` 会滞留（实测同时 30 只，
   60 个 `rtflap` 在转）。`away()` 只在部分路径被调用。
2. **但有更大的东西没找到**：剩下的 65% 在 layout=0、timer 全清、动画全关的
   情况下依然存在，且 `magpie web`（无 webview）复现不出来。说明它与
   WebView2 的合成/光栅化路径有关，需要 WebView2 的
   `Tracing` 或 `gpu-process` 侧继续查，本轮没查完。

## 11. 砍掉动效后的实测（最终版）

### 11.1 改了什么

- `plugins/routing/client.js`：`MOTION` 开关（默认关），`still()` 恒为真
  → `bird()` 返回 null（不造 magpie），`fly()` 的 `ms` 为 0（飞行当帧结束）。
- `routing.css`：`.rt-still #view-routing *`、`.panel-routing *`、`.ctx-card *`
  的全部 `animation` / `transition` 置 none。
- 两个专门测动效的测试文件把自己的 `window.__magpieMotion` 设为 true，
  那段代码保持被测试覆盖。

### 11.2 真 WebView2、真并发（3–7 个讯飞请求在飞）

| | script | task | style | layout |
| --- | --- | --- | --- | --- |
| 有动效（改前） | 3.3–4.5% | **60–88%** | 93–111ms/s | 31–41ms/s |
| 无动效（改后） | 1.2–1.7% | **8.5–12.9%** | 6–12ms/s | 7–11ms/s |

**task 降约 85%**，style 降约 90%。

### 11.3 进程真值（同一负载，Windows CPU 计数器，20 秒）

| | CPU |
| --- | --- |
| 改前 webview 树 | **172.1%**（GPU 61.3 + renderer 110.0） |
| 改后 webview 树 | **34.2%**（渲染 20.4 + 合成 7.3 + GPU 5.9） |

**约 5 倍下降**。

### 11.4 功能

同一页面在负载下：60 条请求、8–12 条在等、tally 的"尝试/应答"照常更新、
账号行照常出现。without motion 只是不动，信息一个不少。

### 11.5 那条滞留的 magpie 也是它

改前实测同时滞留 30 只 `.rt-flier`（60 个 `rtflap` 在转）。`MOTION` 关掉后
`bird()` 不再造，问题随之消失；如果以后要恢复动效，`play()` 的 `finally`
需要把循环里重新赋值的 carrier/back 也清掉。

## 12. 砍掉动效之后：还剩什么（2026-10-26 晚）

测试条件按要求收紧：**2 个并发**、**带实际内容的请求**（387 字的技术提问，
要求逐条审阅 Go 代码并给修改建议，max_tokens 500）。

### 12.1 路由页（真 WebView2）

| | script | task | style | layout |
| --- | --- | --- | --- | --- |
| 2 并发真实请求 | 0.7–0.8% | **6.5–6.8%** | 5–6ms/s | 5–6ms/s |

CPU profile（40 秒）：**91.1% idle**，剩下 `(program)` 5.95%（浏览器光栅化）、
`placeRows` 1.26%、`getBoundingClientRect` 0.30%、`insertBefore` 0.29%。

### 12.2 逐页（真 WebView2，无负载，各 12 秒）

| 页面 | script | task |
| --- | --- | --- |
| agents | 0.01% | 0.04% |
| sessions | 0.01% | 0.10% |
| library | 0.01% | 0.05% |
| providers | 0.02% | 1.22% |
| routing | 0.13% | 1.25% |
| gateway | 0.01% | 0.10% |
| usage | 0.02% | 0.19% |
| **plugins** | 0.09% | **8.22%（首次绘制）**，稳定后 0.07% |

### 12.3 插件页为什么贵

- 122 个 `<img>`、4847 个 DOM 节点、150 张图共 **5.9MB 解码**。
- 其中 `/api/icons/<hash>.png` 单张 **912KB**、911KB，`.svg` 866KB，`.webp` 685KB，
  而页面上按 16–32px 显示。
- `GET /api/icons/{name}`（[`providers.go:1132`](../../magpie-lite/internal/gui/providers.go)）
  `http.ServeFile` 原样发送，**不缩尺寸**；图标缓存目录 4.9MB。

### 12.4 桌面版启动

`domInteractive` **353ms**，`loadEnd` 384ms（进程内资产服务器，不走网络）。
211 个资源、12.4MB 解码。所以启动在桌面版不是痛点；`magpie web` 走网络时才有感，
届时 i18n 里 3/4 用不到的语言仍是纯负债。

### 12.5 结论：剩下的优先级

1. **图标按显示尺寸降采样**（收益大、风险低）：912KB 的 PNG 显示成 16px。
2. **插件页分批绘制**：4847 节点 + 150 图一次画完。
3. **`placeRows`**：负载下占非空闲 JS 的约 14%。
4. i18n 按语言拆：只影响 `magpie web` 和首次安装，桌面版 353ms 已够快。

## 13. 事故与重做（2026-10-26 夜）

我在建分支后跑了 `git checkout -- .`，**回滚了当时全部未提交改动**。恢复情况：

| 内容 | 恢复方式 |
| --- | --- |
| `routing/client.js` 的 `tallyOf` + `MOTION` | 从沙盒 `magpie-nomotion.exe` 切出嵌入资产（376,620 字节，`node --check` 通过） |
| `routing.css` 的 `.rt-still` 块 | 同上 |
| 3 个 GUI 测试文件的改动 | 重写 |
| `reasonix_detect_windows.go` 的注册表缓存、`agent.go`/`agents.go` 的 `DetectedOf`/`ClientsOf`、`api.go` 的单个 `All()` | 重写 |
| `wsl.go` 的 `wslFork` 锁 | 重写（三段式：锁内读状态 → 锁外 fork → 锁回存储） |
| `sessions/dsh.go` 三处、`discovery.go` 的 `readDirectoryHook` | 重写 |
| `pluginrt/config.go` 的 `PresetLean`、`config_test.go` 的 `TestComposeLean` | 重写 |
| `plugins_cli.go` 的 help 文案、三份文档 | 重写 |

重做的验证：

| 检查 | 结果 |
| --- | --- |
| `go build ./...`、`go vet` 五个包、`gofmt -l` | 干净 |
| `go test ./internal/agent -run TestWSL` | ok 122.9s（含 `TestWSLProbeNotUnderLock`） |
| `go test ./internal/sessions` | ok 214.9s（含 `TestDshFolderListingsReused`） |
| `go test ./internal/pluginrt` | ok（含 `TestComposeLean`） |
| `go test ./internal/cli -run Plugin` | ok 20.9s |
| routing 三个 GUI 测试文件，两引擎 | 16 ✔ / 1 ✖；那一个单独跑 9/9 绿（并发 flake） |

教训：**在有未提交改动的工作区里，不要用 `git checkout -- .`**。要用
`git stash` 或只对确切路径操作。
