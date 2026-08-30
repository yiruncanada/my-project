# 资产管家（极简版）

一个**极简的个人资产管理系统**：只需拖入银行 / 资产截图，系统自动 OCR 识别金额并记录，自动汇总总资产并绘制走势图。

核心理念：**谁（用户）的哪个账户，在什么时间，记录了多少钱**。极简版仅保留单用户，去掉所有非必要字段。

## ✨ 功能特性

- ✅ **账户管理**：一键新增 / 删除账户，只需输入名称（如"招商银行""支付宝"）
- ✅ **截图识别**：拖拽 / 粘贴 / 点击三种方式上传截图，OCR 自动识别金额
- ✅ **金额确认**：弹出轻量确认框，自动推荐识别结果，可点击候选值或手动修改
- ✅ **总资产汇总**：卡片实时展示所有账户最新余额总和及更新时间
- ✅ **趋势图**：堆叠柱状图，按天、按账户分色展示资产变化
- ✅ **多币种**：账户支持人民币/美元/加元等，总资产与图表自动换算为人民币
- ✅ **手动输入**：无需截图，直接手动录入金额
- ✅ **一键隐数**：眼睛图标一键模糊所有金额，保护隐私
- ✅ **零成本零依赖**：OCR 完全本地运行，无需注册账号、无需联网、无需 API Key

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python + Flask |
| 数据库 | SQLite（零配置，自动创建） |
| OCR | RapidOCR（基于 ONNX Runtime，本地免费） |
| 前端 | 原生 HTML + CSS + JS（无框架、无构建工具） |

## 📦 安装

需要 Python 3.9+（本项目在 3.13 下验证通过）。

```bash
# 1. 创建虚拟环境
python -m venv .venv

# 2. 激活虚拟环境（Windows）
.venv\Scripts\activate

# 3. 安装依赖
pip install -r requirements.txt
```

> 依赖：`flask`、`rapidocr_onnxruntime`、`opencv-python`、`numpy`、`pillow`

## 🚀 运行

```bash
python app.py
```

浏览器打开 **http://127.0.0.1:5000** 即可使用。

> 首次 OCR 识别会加载模型（约 2~3 秒），之后识别会很快。

## 🐳 Docker 部署

适用于 iStoreOS / OpenWrt / NAS / 服务器等环境。

### 方式一：docker compose（推荐）

```bash
docker compose up -d --build
```

### 方式二：手动 build + run

```bash
docker build -t mtracker .
docker run -d --name mtracker -p 5000:5000 -v mtracker-data:/data --restart unless-stopped mtracker
```

部署后浏览器打开 **http://<设备IP>:5000**。

### iStoreOS / 路由器注意事项

- **架构匹配**：x86_64 软路由直接构建；ARM64（R2S/R4S/R5S/N1 等）在设备上构建，或用 buildx 交叉构建：
  ```bash
  docker buildx build --platform linux/arm64 -t mtracker .
  ```
- **内存**：OCR 推理约需 300~500MB，建议设备 ≥ 1GB RAM。
- **数据持久化**：数据库在挂载卷 `/data` 中，删容器不丢数据。

## 📖 使用流程

```
[新增账户] ➔ [选中账户] ➔ [拖入截图] ➔ [OCR识别金额] ➔ [确认保存]
```

1. 点击 **"＋ 新增账户"**，输入账户名称
2. 在下拉框**选中账户**
3. **拖拽 / 粘贴 / 点击**上传资产截图
4. 弹窗自动推荐识别金额，可点击候选值或手动修改
5. 点击**"确认保存"**，总资产与走势图即时更新

## 📁 项目结构

```
Mtracker/
├── app.py                # Flask 后端（API + SQLite + OCR）
├── requirements.txt      # Python 依赖
├── .gitignore            # 忽略虚拟环境 / 数据库 / 缓存
├── templates/
│   └── index.html        # 单页前端
├── static/
│   ├── style.css         # 样式
│   └── app.js            # 前端逻辑 + Canvas 趋势图
└── 项目计划.txt          # 原始项目计划
```

## 🔌 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/accounts` | 账户列表（含最新余额、更新时间） |
| POST | `/api/accounts` | 新增账户 `{name}` |
| DELETE | `/api/accounts/<id>` | 删除账户（级联删除记录） |
| POST | `/api/logs` | 记录资产 `{account_id, amount}` |
| GET | `/api/trend` | 总资产走势时间线 |
| POST | `/api/ocr` | 上传截图，返回识别金额候选 |

## 🗄 数据模型

```sql
accounts  (id, name, currency, created_at)
asset_logs(id, account_id, amount, recorded_at)
```

## 📝 后续可扩展方向

- 多用户支持（当前为单用户极简版）
- 账户类型 / 分类标签
- 云端 OCR 切换（百度 OCR API 等，精度更高）
- 数据导出（CSV / Excel）

## 📄 许可

个人学习 / 自用项目。
