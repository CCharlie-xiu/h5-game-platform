# H5 Game Platform

可复用的 **H5 联机游戏平台**。以统一的消息协议、游戏生命周期与插件接口为底座，
让新游戏只需实现规则与表现层即可接入；`扩散大师`（diffusion-master）是第一个验证游戏。

> **当前状态：阶段 1 —— 工程初始化。**
> 本阶段只完成工程骨架与运行验证。**游戏规则、动画、房间系统、玩家同步均尚未实现**，
> 页面上的「扩散大师」入口为占位状态。

---

## 技术栈

| 领域 | 选型 |
| --- | --- |
| 包管理 / Monorepo | pnpm workspace |
| 前端 | React + TypeScript + Vite |
| 游戏渲染 | Phaser 3 |
| 后端 | Cloudflare Workers |
| 实时房间 | Cloudflare Durable Objects（已绑定，逻辑未实现） |
| 数据库 | Cloudflare D1 |
| 数据访问 | Drizzle ORM + Drizzle Kit |
| 单元测试 | Vitest |
| 浏览器端测试 | Playwright（后续阶段接入） |

## 目录结构

```
h5-game-platform/
├── apps/
│   ├── web/                  # H5 前端（React + Vite + Phaser）
│   └── worker/               # Cloudflare Workers 后端（含 Durable Objects / D1）
├── packages/
│   ├── game-protocol/        # 统一消息协议（已定义协议版本与消息信封）
│   ├── game-core/            # 游戏生命周期（已定义阶段枚举）
│   ├── game-sdk/             # 游戏插件接口（已定义 manifest / plugin 契约）
│   ├── game-ui/              # 通用游戏 UI（占位，未实现组件）
│   └── game-animations/      # 通用动画（占位，未实现动画）
├── games/
│   ├── game-template/        # 新游戏模板（最小骨架：manifest / config / rules）
│   └── diffusion-master/     # 第一个实际游戏（仅登记元信息，未实现）
├── database/
│   └── migrations/           # D1 迁移文件（由 drizzle-kit 生成）
├── tests/
│   ├── protocol/
│   ├── lifecycle/
│   └── multiplayer/          # 空目录，待后续阶段填充
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── eslint.config.js
```

## 环境要求

- **Node.js** `>= 22.12.0`（开发使用 22.22.2 验证）
- **pnpm** `>= 10`（仓库锁定 `pnpm@10.34.6`，通过 `corepack` 自动获取）

启用 pnpm：

```bash
corepack enable
```

## 安装依赖

```bash
pnpm install
```

### 安装提示（可忽略）

pnpm 10 默认不执行依赖的 postinstall 脚本，安装结束时会提示：

```
Ignored build scripts: esbuild@..., workerd@...
```

该提示**可以安全忽略**：esbuild 与 workerd 的平台二进制由 optionalDependencies 提供。
本仓库的类型检查、构建、测试与 `wrangler dev` 均已在「未执行该脚本」的情况下验证通过。
如需执行，可运行 `pnpm approve-builds`。

## 本地启动

前端与 Worker 需要**分别在两个终端**启动。

```bash
# 终端 1：Worker（默认 http://127.0.0.1:8787）
pnpm dev:worker

# 终端 2：前端（默认 http://127.0.0.1:5173）
pnpm dev:web
```

也可以一条命令并行启动两者：

```bash
pnpm dev
```

前端开发服务器会把 `/api` 代理到 `http://127.0.0.1:8787`，
因此前端可以直接请求同源路径 `/api/health`。

验证 Worker：

```bash
curl http://127.0.0.1:8787/api/health
```

预期返回：

```json
{
  "status": "ok",
  "service": "h5-game-platform-worker",
  "environment": "development",
  "protocolVersion": 1,
  "timestamp": "2026-10-09T00:00:00.000Z"
}
```

## D1 本地初始化

本地开发使用 `.wrangler/state` 下的 SQLite，无需云端资源。

```bash
# 1) 由 Drizzle schema 生成迁移 SQL 到 database/migrations/
pnpm db:generate

# 2) 将迁移应用到本地 D1
pnpm db:migrate:local
```

> `wrangler.toml` 中的 `database_id` 是**占位值**。本地开发不校验该值；
> 部署到线上前需执行 `wrangler d1 create h5-game-platform` 并替换为真实 id。
> 本阶段**不部署、不配置生产密钥**。

## 构建 / 类型检查 / 测试

```bash
pnpm typecheck   # 全量 TypeScript 类型检查
pnpm lint        # ESLint
pnpm test        # Vitest（单次运行）
pnpm test:watch  # Vitest（监听模式）
pnpm build       # 前端 vite build + Worker wrangler deploy --dry-run
```

## 端口约定

| 服务 | 端口 |
| --- | --- |
| 前端开发服务器 | `5173` |
| Worker 本地开发 | `8787` |
| 前端构建产物预览 | `4173` |
