# H5 Game Platform

可复用的 **H5 联机游戏平台**。以统一消息协议、房间生命周期与插件接口为底座，
让新游戏只需实现规则与表现层即可接入；`扩散大师`（diffusion-master）是第一个验证游戏。

> **当前状态：阶段 2 —— 通用房间系统与游戏生命周期。**
> 房间创建 / 加入 / 准备 / 开始 / 暂停 / 继续 / 结束已完整可用，
> 实时状态由 Durable Object 权威协调，D1 记录生命周期事件。
> **扩散大师的具体游戏规则、动画与结算尚未实现。**

---

## 技术栈

| 领域 | 选型 |
| --- | --- |
| 包管理 / Monorepo | pnpm workspace |
| 前端 | React 19 + TypeScript + Vite 7 |
| 游戏渲染 | Phaser 3（仅占位舞台） |
| 后端 | Cloudflare Workers |
| 实时房间 | Cloudflare Durable Objects + WebSocket（Hibernation API） |
| 数据库 | Cloudflare D1（仅生命周期记录） |
| 数据访问 | Drizzle ORM + Drizzle Kit |
| 消息校验 | Zod |
| 单元 / 集成测试 | Vitest + `@cloudflare/vitest-plugin` |
| 浏览器端测试 | Playwright |

## 目录结构

```
h5-game-platform/
├── apps/
│   ├── web/                    # H5 前端（React + Vite + Phaser）
│   └── worker/                 # Cloudflare Workers 后端
│       ├── src/durable-objects/game-room.ts   # 房间 Durable Object
│       ├── src/db/             # Drizzle schema 与 D1 仓库
│       └── test/               # Durable Object 集成测试（workerd 运行时）
├── packages/
│   ├── game-protocol/          # 消息类型、封套、Zod Schema、校验
│   ├── game-core/              # 生命周期状态机、房间领域逻辑、房间码、身份令牌
│   ├── game-client/            # 房间 WebSocket 客户端（重连 / 状态同步）
│   ├── game-sdk/               # 游戏插件接口
│   ├── game-ui/                # 通用房间 UI 组件
│   └── game-animations/        # 通用动画（占位，未实现）
├── games/
│   ├── game-template/          # 新游戏模板
│   └── diffusion-master/       # 第一个实际游戏（仅登记元信息）
├── database/migrations/        # D1 迁移（drizzle-kit 生成）
├── tests/                      # 单元测试
├── e2e/                        # Playwright 双浏览器测试
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js
└── playwright.config.ts
```

## 环境要求

- **Node.js** `>= 22.12.0`（开发使用 22.22.2 验证）
- **pnpm** `>= 10`（仓库锁定 `pnpm@10.34.6`，通过 `corepack` 自动获取）

```bash
corepack enable
```

## 安装依赖

```bash
pnpm install
```

### 安装提示（可忽略）

pnpm 10 默认不执行依赖的 postinstall 脚本，安装结束时会提示
`Ignored build scripts: esbuild@..., workerd@...`。
该提示**可以安全忽略**：esbuild 与 workerd 的平台二进制由 optionalDependencies 提供，
本仓库的类型检查、构建、测试与 `wrangler dev` 均已在未执行该脚本的情况下验证通过。

## 本地启动

前端与 Worker 需要**分别在两个终端**启动。

```bash
# 终端 1：Worker（http://127.0.0.1:8787）
pnpm dev:worker

# 终端 2：前端（http://127.0.0.1:5173）
pnpm dev:web
```

也可一条命令并行启动：`pnpm dev`。

前端开发服务器把 `/api` 代理到 `http://127.0.0.1:8787`，**并开启了 WebSocket 转发**
（房间连接走同源路径 `/api/rooms/:code/ws`）。

## D1 本地初始化

```bash
pnpm db:generate       # 由 Drizzle schema 生成迁移到 database/migrations/
pnpm db:migrate:local  # 应用到本地 D1（.wrangler/state）
```

> `wrangler.toml` 中的 `database_id` 是**占位值**，本地开发不校验；
> 部署前需执行 `wrangler d1 create h5-game-platform` 并替换为真实 id。
> 本阶段**不部署、不配置生产密钥**。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，返回 `{status, service, environment, protocolVersion, timestamp}` |
| `POST` | `/api/rooms` | 创建房间。请求体 `{gameId, nickname, maxPlayers?}`；返回 `201 {roomCode, playerId, token, room}` |
| `GET` | `/api/rooms/:code` | 读取房间权威快照 `{room}`；房间不存在返回 `404` |
| `GET` | `/api/rooms/:code/ws` | WebSocket 升级（需 `Upgrade: websocket`），进入房间消息通道 |

```bash
# 创建房间
curl -s -X POST http://127.0.0.1:8787/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"gameId":"diffusion-master","nickname":"房主"}'

# 读取快照
curl -s http://127.0.0.1:8787/api/rooms/<ROOM_CODE>
```

> 房间码由服务端生成（6 位，去除易混淆字符），仅用于**查找房间**，不是身份凭证。

## 消息协议

所有消息使用统一封套，入站消息必须通过 Zod 校验：

```ts
{ protocolVersion: 1, messageId: string, type: MessageType,
  roomId?: string, sessionId?: string, payload: ... }
```

| 方向 | 类型 | 负载 |
| --- | --- | --- |
| C→S | `CREATE_ROOM` | `{gameId, nickname, maxPlayers?}` |
| C→S | `JOIN_ROOM` | `{roomCode, nickname, playerId?, token?}`（带 `playerId+token` 表示重连） |
| C→S | `LEAVE_ROOM` / `PLAYER_READY` / `PLAYER_UNREADY` | `{}` |
| C→S | `GAME_START` / `GAME_PAUSE` / `GAME_RESUME` / `GAME_END` | `{}` |
| S→C | `SESSION_GRANTED` | `{roomCode, playerId, token, room}` |
| S→C | `ROOM_STATE` | `{room}`（服务端权威快照） |
| S→C | `PLAYER_JOINED` / `PLAYER_LEFT` / `PLAYER_RECONNECTED` | 玩家信息 / `reason` |
| S→C | `SYSTEM_ERROR` | `{code, message, details?}` |

**生命周期**：`WAITING → READY → PLAYING ⇄ PAUSED → FINISHED`。
合法转换表与拒绝规则在 `packages/game-core/src/lifecycle.ts`，
客户端按钮可用性直接由该表推导，服务端仍会独立校验。

**身份模型**：`playerId`（稳定身份，服务端签发）· `connectionId`（单次连接）·
`roomId` / `roomCode`（房间标识）· `sessionId`（单局标识）。
重连令牌为房间级密钥签发的 HMAC-SHA256，服务端不信任客户端提交的 `playerId`。

**服务端强制校验**（客户端无法绕过）：

| 校验 | 行为 |
| --- | --- |
| 创建房间参数 | 入口按协议 Zod Schema 校验（`maxPlayers` 为 2–8 的整数、`gameId` ≤ 64、`nickname` 1–24），非法输入返回 `400` |
| 封套 `roomId` / `sessionId` | 存在时必须与当前房间 / 当前对局严格一致，不匹配返回 `ROOM_NOT_FOUND` / `SESSION_MISMATCH`；缺省按协议允许省略 |
| `JOIN_ROOM` 房间码 | 必须与目标房间实例一致（房间码仅用于定位房间，不是身份凭证） |
| 连接绑定 | 每个操作都校验发起连接的 `connectionId` 是否为该玩家当前绑定；被替换的旧连接返回 `UNAUTHORIZED` 且不改动房间状态 |

**房间清理策略**：只要还有在线玩家就**永不**因空闲销毁；仅剩离线玩家时保留座位
至重连宽限期（5 分钟）；房间已无玩家时立即销毁。

**D1 记录归属**：D1 中的房间 / 玩家 / 对局记录都带**房间实例标识**（`rooms.instance_id`、
`room_players.room_instance_id`、`game_sessions.room_instance_id`）。
房间码可复用，但同码的不同生命周期是**不同实例**：实例结束时释放房间码槽位（`rooms.ended_at`），
其迟到写入只命中自己那一行，不会覆盖或删除新实例的数据。
「同一时刻一个房间码最多一个活动实例」由 `rooms` 主键与「已结束才可接管」的条件更新共同保证。

## 构建 / 类型检查 / 测试

```bash
pnpm typecheck        # 全量 TypeScript 类型检查
pnpm lint             # ESLint
pnpm build            # 前端 vite build + Worker wrangler deploy --dry-run

pnpm test             # 单元测试（Vitest，tests/）
pnpm test:integration # Durable Object 集成测试（workerd 运行时，apps/worker/test）
pnpm test:e2e         # 双浏览器端到端测试（Playwright）
pnpm test:all         # 依次执行以上三层
```

### 端到端测试前置

```bash
pnpm exec playwright install chromium
```

Playwright 会自动拉起 Worker（8787）与 Vite（5173）；若两者已在运行则复用。

## 端口约定

| 服务 | 端口 |
| --- | --- |
| 前端开发服务器 | `5173` |
| Worker 本地开发 | `8787` |
| 前端构建产物预览 | `4173` |
