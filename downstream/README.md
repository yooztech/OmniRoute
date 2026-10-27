# 下游补丁队列与 GHCR 镜像

此目录把官方源码基线、下游补丁和镜像构建入口分开管理。官方仓库是
`https://github.com/cheaper-inference/OmniRoute.git`，fork 是
`https://github.com/yooztech/OmniRoute`。

当前 `config.json` 固定 `v3.8.52` / `ad6f33f66bda34eba98645d3bfdabbde294bc843`，
下游 revision 为 `1`，镜像名为 `ghcr.io/yooztech/omniroute`。
`patches/series` 初始为空，**目前没有任何行为补丁，也没有实现 Codex 卡顿、超时或并发修复**。
这些文件不修改现有生产源码，不部署、不重启线上服务。

`scripts/check/check-workflows.mjs` 的 scheduled guard 仅为精确文件名
`downstream-update.yml` 增加工具层兼容：该工作流只允许 `yooztech/OmniRoute`
仓库的 `schedule` 或 `workflow_dispatch` 事件，手动运行也不能绕过 owner 限制。
其他官方工作流仍要求原有官方仓库 guard；每日更新和工作流审计 gate 均保留，
不调整 baseline。这不是应用行为补丁，不进入 `patches/series`。

## 生成可构建的源码

要求安装 Node.js 和 Git；脚本仅使用 Node.js 标准库，不需要 `npm install`。
输出目录的父目录必须已经存在，输出目录本身必须不存在（空目录和符号链接也拒绝）：

```sh
node downstream/prepare.mjs --output /tmp/omniroute-source
```

脚本从配置的官方仓库抓取完整的 40 位 SHA，校验抓取结果并 detached checkout，
然后按 `patches/series` 的顺序使用 `git am` 应用邮件格式补丁。
应用时使用输出仓库内的本地 Git 身份，不要求维护者配置全局身份或签名。
成功后输出目录的 Git 工作区必须干净；stdout 是 JSON 元数据，Git 诊断写入 stderr。
元数据 `upstreamCommit` 是官方基线，`candidateCommit` 是应用全部补丁后的 Git HEAD；
空队列时两者相同。应用补丁关闭提交签名，并固定 committer 日期为补丁 author 日期，
避免仅因构建时间变化产生不同的候选 commit，便于记录同一基线和补丁队列的实际源码来源。
抓取或补丁应用失败时返回非零并删除本次创建的输出，不会留下可误用的半成品。
已有输出始终不删除、不覆盖；重新运行请使用新的输出目录。

可以显式覆盖候选 commit（只接受完整 40 位 SHA，不接受 branch/tag/短 SHA）：

```sh
node downstream/prepare.mjs --output /tmp/omniroute-candidate --commit FULL_40_HEX_SHA
```

该参数不修改配置，也不证明候选 SHA 对应配置里的 tag；正式升级应同步更新配置的 tag 和 SHA。
`--config /absolute/path/config.json` 用于隔离测试或自定义配置，补丁从该配置同级的
`patches/series` 读取；默认配置始终相对脚本位置定位，不依赖当前工作目录。
相对补丁路径禁止 `..`、绝对路径、重复条目和指向补丁目录外的符号链接。
空行和以 `#` 开头的整行注释会忽略，其余每行是一个补丁文件名。

## 导出和维护补丁

在单独工作目录中，以配置里的官方 commit 为起点提交真实改动，再导出邮件补丁。
不要把下游工具、工作流或配置本身导入应用源码补丁：

```sh
git clone https://github.com/cheaper-inference/OmniRoute.git /tmp/omniroute-patch-work
git -C /tmp/omniroute-patch-work checkout --detach ad6f33f66bda34eba98645d3bfdabbde294bc843
# 在此工作目录修改源码、添加相关自动化测试并提交。
git -C /tmp/omniroute-patch-work format-patch --output-directory /path/to/fork/downstream/patches ad6f33f66bda34eba98645d3bfdabbde294bc843..HEAD
```

将需要应用的补丁文件名逐行加入 fork 的 `downstream/patches/series`，按依赖顺序排列。
仅把文件放进目录不会自动应用。提交补丁时记录原因及对应的官方 issue/PR；官方吸收后，
从 series 和目录同时移除已不需要的补丁，不保留兼容空补丁。
出现冲突应在补丁工作目录解决并重新导出，再用一个新的输出目录重新 prepare；不要忽略失败。

## 构建和发布镜像

本地构建需要 Docker Buildx。以下命令只构建，不推送：

```sh
node downstream/image.mjs --output /tmp/omniroute-image-source
```

`image.mjs` 使用 prepare 生成的干净官方源码作为 Docker build context，
使用该源码的根 `Dockerfile`，而不是直接构建 fork 工作区。
默认构建标准 `runner-base`，不扩展 browser/Bun 变体。
构建参数保持 `OMNIROUTE_USE_TURBOPACK=0`、`OMNIROUTE_BUILD_MEMORY_MB=12288`；
请为构建分配足够的内存。正式发布前应审核候选官方 Dockerfile 的 target 和构建参数契约。
默认平台为 `linux/amd64`，使用 `--load` 加载到本地 Docker；多架构构建必须显式 `--push`。

手动推送示例：

```sh
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username yooztech --password-stdin
node downstream/image.mjs --output /tmp/omniroute-publish-source --push --platform linux/amd64,linux/arm64
```

本地 GHCR token 应具有目标 package 的写权限；不要提交 token。
GitHub Actions 仅在镜像发布 job 授予 `contents: read` 与 `packages: write`，
完整验证成功后使用仓库提供的 `GITHUB_TOKEN` 登录 `ghcr.io`，不依赖 Docker Hub 账号或凭据。
首次发布后还应检查 GHCR package 的可见性和仓库访问权限，不能假定镜像自动公开。
官方 Dockerfile 的基础镜像仍可能来自公共镜像仓库；GHCR 登录不保证消除其拉取限流。

镜像版本标签为 `3.8.52-custom.1` 和
`sha-ad6f33f66bda-custom.1`（随配置中的版本、commit、revision 更新），不发布 `latest`。
同时发布 `3.8.52-custom.1-<工具仓库HEAD前12位>` 来源标签；OCI revision label 记录工具仓库完整 HEAD，
额外 label 记录官方 SHA、tag 和补丁序列。应从已提交的工具和补丁构建，避免未提交内容缺少来源记录。
同一配置的版本标签可以被再次构建覆盖，因此部署时应锁定发布所得 digest，
并保留构建来源元数据。修改补丁或发布工具后应提升 revision，避免把不同内容当成同一版本。
多架构推送的目标为 `linux/amd64,linux/arm64`；不要把本地单平台构建当作多架构发布验证。

`.github/workflows/downstream-image.yml` 在 main 上的 downstream 文件或本工作流变更时运行，
也允许在 main 或受信任的维护分支 `downstream/patch-build` 手动触发；只有
`yooztech/OmniRoute` 的 main push 或这两个分支的手动发布 job 可获得 `packages: write`。
其他分支、其他仓库和所有 PR 均不能进入发布 job。PR 验证 job 仅有 `contents: read` 权限；
它与发布 job 共用 `downstream/validate/action.yml`：配置 Node.js 26 和 Buildx，运行下游工具测试、
prepare 固定候选源码，在候选源码执行 `npm ci` 和 `npm run test:coverage`，保留
statements、lines、functions、branches 四项各 60% 的覆盖率门禁，再通过 `image.mjs`
构建并本地加载 amd64 镜像，执行容器实际的 Docker HEALTHCHECK。复合 action 输出
`metadata-file`（镜像 JSON 元数据的绝对路径）；发布 job 验证通过后才登录 GHCR，
读取该文件直接推送同一冒烟镜像的三个本地标签，不重新构建镜像。
CI 默认发布 amd64；脚本支持的手动多架构发布是另一条显式操作路径，
不能据此声称 CI 已验证 arm64。工作流不自动部署生产环境。

## 本地一条命令完成补丁验证、构建和发布

入口是 `downstream/release.mjs`，不是下面仅触发 Actions 的 `publish.mjs`。
它直接在当前机器执行全流程，不需要先合并 PR 或注册 GitHub 工作流。

前置条件：Node.js 26、npm、Git、可访问的 Docker daemon 与 Docker Buildx，
以及足够的构建内存（镜像构建仍使用 12288 MB 的 Node 堆配置）。浏览器、外部服务等
额外测试前提仅由具体 patch 的验证命令决定，不再默认安装 Chromium 或运行上游全量测试。
发布账号的 GitHub token 必须有目标 GHCR package 的写权限；不需要 Docker Hub 账号。

在 Bash 中安全读取 token，然后执行完整发布：

```sh
read -rsp 'GHCR token: ' GHCR_TOKEN; printf '\n'
export GHCR_TOKEN
export GHCR_USERNAME=yooztech
node downstream/release.mjs --output "/tmp/omniroute-release-$(date +%Y%m%d-%H%M%S)" --push
```

`--output` 必须是尚不存在的绝对路径，其父目录必须存在；已有目录不会覆盖。
`GHCR_USERNAME` 可省略，默认取配置中镜像仓库的 owner。token 只通过 stdin 交给
`docker login ghcr.io --password-stdin`，不放入命令参数、元数据或待测试源码的环境。
使用后可执行 `unset GHCR_TOKEN` 清除当前 shell 中的变量。

顺序固定，任一步失败都非零退出，不继续发布：

1. 运行下游工具测试，读取固定官方 SHA 与 `patches/series`。
2. 在 `<output>/source` 检出该 SHA，按顺序 `git am` 应用补丁；只 prepare 一次。
3. 校验配置旁 `patches/tests.json`，要求每个实际 patch 均声明回归测试和相关模块测试。
   缺少映射、空测试集合、重复名称、无效命令或已不在 series 中的过期映射均阻止发布。
4. 有 patch 时，在同一候选源码内执行一次 `npm ci`，然后依次执行清单中的测试命令；
   **没有 patch 时不安装候选测试依赖，也不运行候选应用测试**。
5. 从同一候选目录构建一次 `linux/amd64` 镜像并加载到本地 Docker。
6. 启动该镜像 ID 对应的容器，验证健康状态和最小 HTTP 服务冒烟；失败即停止。
7. 仅在验证成功后登录 GHCR，推送同一镜像的三个标签；不会重新构建，不发布 `latest`。

这是**官方基线 + 补丁范围验证**，不是全项目测试通过的声明。每个补丁必须同时提供
回归测试和相关模块测试；共享组件、鉴权或迁移变更应显式扩大相关测试集合。
本地发布不默认运行 `test:coverage`、`test:all` 或整个 integration 套件，也不生成全项目
覆盖率结论。PR/CI 现有全量测试与四项各 60% 的覆盖率门禁保持不变，不由此流程替代。

### 补丁验证清单

`patches/tests.json` 与对应 `config.json` 相邻的 `patches/series` 配套；当前空队列配置为：

```json
{ "version": 1, "patches": {} }
```

加入补丁时，用 series 中的精确文件名作为键，为其提供 `regression` 和 `related` 两个
非空列表。每项为 `{ "name": "唯一测试名称", "argv": ["程序", "参数"], "env": {} }`；
`env` 可省略。`argv` 直接启动程序，不执行 shell 字符串或展开通配符，工作目录为候选源码。
Node 单测应带上项目既有的 tsx、polyfill 与 `tests/_setup/isolateDataDir.ts` 初始化参数。
例如可分别选择补丁新增回归测试文件和受影响模块的现有测试文件，而不是再调用整套 unit。

基础测试环境不继承 `INITIAL_PASSWORD`、`DATA_DIR`、`NODE_V8_COVERAGE` 或发布 token：
避免意外开启鉴权、让单测进程共享数据库或继承外层覆盖率采集。integration 等测试需要
初始密码或其他前提时，由该条测试的 `env` 显式指定；不要放入真实凭据。测试配置属于
受信任的维护代码，不能用 `echo` 等空操作冒充验证，测试本身应验证真实行为。
任一命令失败即停止构建与发布；元数据记录实际执行范围和结果，不把未运行项记为通过。

只测试并构建、不上传时省略 `--push`，不需要 token：

```sh
node downstream/release.mjs --output /tmp/omniroute-validate
```

可用 `--config /absolute/path/config.json` 指定另一份固定版本和补丁队列。
工作目录保留用于核查源码、测试结果和 `<output>/image.json`；其中记录官方与候选 SHA、
patch 列表、实际测试命令及结果、镜像 ID 与冒烟状态。脚本只删除自己启动的冒烟容器，
不部署、不重启线上服务。只有所有标签都推送成功才声明完整发布成功；
多标签推送不是原子事务，部分失败时不假装回滚已经上传的标签。
此入口只验证和发布 amd64；不能将它当作 arm64 或多架构验证。

### 在 Paseo 中运行

仓库根目录的 `paseo.json` 只提供一个 `release` 入口。在工作区 Scripts 面板点一次：

**下游工具测试 → 检出官方版本并应用补丁 → 补丁回归与相关测试
→ 构建镜像 → 容器健康与 HTTP 冒烟 → 登录 GHCR → 推送发布。**

无需分别启动测试、构建或发布任务。默认通过 `gh auth token --hostname github.com`
复用已登录 GitHub CLI 的凭据，并通过 `gh api user` 获取登录用户名，不再提示手填 token。
显式提供的 `GHCR_TOKEN` / `GHCR_USERNAME` 仍优先使用。凭据不写入配置或日志。
GitHub 登录不等于有 GHCR 写权限；OAuth 登录缺少 scope 时，可执行
`gh auth refresh --hostname github.com --scopes write:packages` 后重试。目标 package 的访问权限
及组织 SSO 限制仍需满足。任一步失败即停止，不会跳过失败的测试继续发布。

每次运行自动生成带时间和进程 ID 的独立临时输出路径，避免复用已存在的候选目录。
启动时会显示工作目录和相邻的 `.log` 文件路径，构建与发布的 stdout/stderr 都写入该日志。
发布失败时显示原始非零退出码，并在交互终端等待按 Enter 后才关闭，方便检查错误；
成功不额外等待。非交互调用不等待输入，仍以原始失败码退出，不会将失败伪装为成功。
若通过环境提供凭据，变量必须对 Paseo 启动的脚本进程可见；在另一个终端中执行
`export` 不会改变已运行 daemon 的环境。使用 gh 凭据时用户名默认取该 GitHub 登录账号。
这是按需运行的普通脚本，没有自动启动、worktree setup、端口或常驻服务。
新建 worktree 应选择已经提交此配置的分支作为基线。

配置格式参见 [Paseo 工作区脚本文档](https://paseo.sh/docs/worktrees.md)。

镜像构建使用 Docker 官方 Buildx 插件调用 BuildKit；不是另一套 Docker daemon。
官方 Dockerfile 使用 `RUN --mount=type=cache`，因此需要支持这些语法的 BuildKit。
普通 `docker build` 在启用兼容 BuildKit 时也能构建；本脚本明确采用 `docker buildx build`。

## 通过 GitHub Actions 远程构建并上传

本地只需 Node.js、GitHub CLI `gh`，以及有权在 `yooztech/OmniRoute` 手动运行 Actions
的 GitHub 登录态（首次先运行 `gh auth login --hostname github.com`）。不需要本地 Docker，
也不需要本地 GHCR token；构建和上传使用 Actions runner 与发布 job 的 `GITHUB_TOKEN`。

**前置条件：先将 PR #1 合并到 main。** 当前 PR 尚未合并时，main 没有此工作流，
GitHub 不会注册它为可手动触发的工作流。脚本会先检查 main 上的工作流文件及启用状态，
缺失时明确提示先合并 PR #1 并非零退出，不会假装已经构建或发布。`--ref` 也不能绕过
GitHub 的默认分支注册要求；访问被拒绝同样会保留真实错误，请检查 gh 登录和仓库权限。
fork 中若 Actions/工作流被禁用，还需先在 GitHub Actions 设置中启用。

满足前置条件后，一条命令执行上文现有 CI 验证、构建、上传并等待结果：

```sh
node downstream/publish.mjs
```

默认发布 main。工作流已在 main 注册后，也可显式试跑受信任的同仓库维护分支
（该分支必须已推送且包含本版工作流）：

```sh
node downstream/publish.mjs --ref downstream/patch-build
```

仓库固定为 `yooztech/OmniRoute`，不接受任意仓库或分支；维护分支只有手动 dispatch
可发布，其 push 不会自动发布。该命令不会修改本地分支、提交、合并 PR、部署或重启服务。
它用独立 UUID `request_id` 触发工作流，并按 run-name、事件类型与分支精确匹配本次运行，
不会误跟随另一次发布。注册最多查找 25 次，间隔 5 秒（每次 gh API 调用另有 30 秒上限）；
未找到就非零退出并显示 request_id，便于先检查 Actions，避免盲目重复发布。
找到后运行 `gh run watch --exit-status`；排队或构建期间持续等待，失败、取消、下载失败
或无有效产物均非零退出，不输出成功声明。成功后显示本次 Actions URL 及实际成功推送的
GHCR 镜像标签：这些地址来自该次运行上传的 `downstream-publication/image.json` artifact，
不是根据本地配置推测。artifact 保留 30 天，标签仍遵循上文版本规则，**不发布 latest**。

这是一键发布工具，不是 Codex 修复：当前 `patches/series` 为空，构建内容仍是固定的
官方基线，没有额外的 Codex 超时、卡顿或并发补丁。完整候选 coverage 与实际容器
HEALTHCHECK 验证均保留；一键命令不会降低覆盖率门槛或绕过失败的 CI。

注意两组检查互不替代：fork 工作区的工作流/工具测试通过，不代表固定官方 SHA 的
候选测试通过。`prepare.mjs` 不会把 fork 工作区里的测试清理或调度检查器改动复制进
候选源码；只有 `patches/series` 内的应用补丁会进入构建上下文。官方基线自身若有
依赖漏洞、翻译状态漂移或测试失败，需要分别审核解决，不能靠放宽覆盖率门禁、
刷新无依据的翻译哈希或把失败标为成功来发布。没有完整覆盖率结果就不算验证通过。

## 升级流程

升级通过 PR 审核配置和补丁，不自动部署：

1. 在官方仓库确认候选 tag 实际指向的完整 commit；更新 `config.json` 的 `upstreamTag`、
   `upstreamCommit`，并根据发布内容调整 revision。
2. 检查官方已合并的修复，删除不再需要的补丁；对其余补丁重新基于候选 commit 导出。
3. 在不存在的新输出目录运行 prepare，审查冲突、最终 diff 和官方 Dockerfile 的构建契约。
4. 运行队列测试及项目要求的质量门禁，审核 PR 后再发布 GHCR 镜像。
5. 以 digest 记录通过验证的镜像；生产切换由维护者另外执行，本架构不连接或修改线上部署。

`node downstream/update-upstream.mjs` 可通过 GitHub API 查找最新稳定 release 并更新本地配置；
支持 `--config PATH`。仅在官方版本变化时重置 revision；此命令不部署，也不自动解决补丁冲突。
`.github/workflows/downstream-update.yml` 每天 06:23 UTC 或手动检查最新稳定 release，
读取更新脚本 JSON 输出的 `changed`；只有变更时才先调用同一完整验证复合 action，
通过工具测试、候选依赖安装、四项 60% 覆盖率门禁、本地 amd64 构建和实际容器 HEALTHCHECK 后，
再创建只修改配置的 PR。无变更时跳过验证与创建 PR，不推送镜像。
机器人 PR 的独立工作流可能需要维护者批准；使用 `GITHUB_TOKEN` 创建的 PR 通常不会触发其他工作流。
因此升级 job 在创建 PR 前主动完整验证，不依赖机器人 PR 事件是否触发。
合并到 main 后，发布 job 仍会重新执行完整验证，再推送该次验证过的同一镜像。
仓库设置需允许 GitHub Actions 创建 Pull Request，升级工作流还需 `contents: write` 和
`pull-requests: write`。若仓库限制 `GITHUB_TOKEN` 创建 PR，应由维护者调整仓库权限后再使用自动升级。
镜像发布工作流和升级工作流分离；PR 中的候选更新不是自动生产部署。

本地队列测试使用临时 Git 仓库，不访问官方仓库，也不验证实际镜像：

```sh
node --test downstream/prepare.test.mjs
```

测试覆盖真实补丁改变输出行为、按序应用、失败清理、路径逃逸拒绝、固定 SHA 和拒绝覆盖。
它不能代替真实候选源码构建、项目测试或多架构运行验证。
