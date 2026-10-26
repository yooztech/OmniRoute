# 下游补丁队列与 GHCR 镜像

此目录把官方源码基线、下游补丁和镜像构建入口分开管理。官方仓库是
`https://github.com/cheaper-inference/OmniRoute.git`，fork 是
`https://github.com/yooztech/OmniRoute`。

当前 `config.json` 固定 `v3.8.52` / `ad6f33f66bda34eba98645d3bfdabbde294bc843`，
下游 revision 为 `1`，镜像名为 `ghcr.io/yooztech/omniroute`。
`patches/series` 初始为空，**目前没有任何行为补丁，也没有实现 Codex 卡顿、超时或并发修复**。
这些文件不修改现有生产源码，不部署、不重启线上服务。

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
也允许在 main 手动触发。PR 验证 job 仅有 `contents: read` 权限；它与 main 发布 job
共用 `downstream/validate/action.yml`：配置 Node.js 26 和 Buildx，运行下游工具测试、
prepare 固定候选源码，在候选源码执行 `npm ci` 和 `npm run test:coverage`，保留
statements、lines、functions、branches 四项各 60% 的覆盖率门禁，再通过 `image.mjs`
构建并本地加载 amd64 镜像，执行容器实际的 Docker HEALTHCHECK。复合 action 输出
`metadata-file`（镜像 JSON 元数据的绝对路径）；发布 job 验证通过后才登录 GHCR，
读取该文件直接推送同一冒烟镜像的三个本地标签，不重新构建镜像。
CI 默认发布 amd64；脚本支持的手动多架构发布是另一条显式操作路径，
不能据此声称 CI 已验证 arm64。工作流不自动部署生产环境。

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
