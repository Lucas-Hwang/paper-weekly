# PaperWeekly 项目设置备忘录

## 当前进度
- [x] Windows 适配完成（nodemailer 已安装）
- [x] 百度翻译 API 已集成
- [x] 邮件内容已去掉原文链接，改为中文标题 + 中文摘要
- [x] GitHub Actions 云端定时推送已配置（每周一早上 8:00，北京时间）
- [x] 代码已推送到 GitHub 仓库：`https://github.com/Lucas-Hwang/paper-weekly`
- [ ] 等待配置 GitHub Secrets（SMTP_PASS、BAIDU_APPID、BAIDU_KEY）
- [ ] 等待手动触发首次测试

## 还没做的事（按顺序）

### 1. 配置 GitHub Secrets
打开链接：
```
https://github.com/Lucas-Hwang/paper-weekly/settings/secrets/actions
```

点击右上角 **New repository secret**，逐个创建 3 个 Secret：

| Name | Secret |
|------|--------|
| `SMTP_PASS` | `XY5ayRZ9bU4DZdhb` |
| `BAIDU_APPID` | `20260415002594524` |
| `BAIDU_KEY` | `hJ9RRj6FzlstlU3vOVe2` |

### 2. 手动触发首次测试
配置完 Secrets 后，打开：
```
https://github.com/Lucas-Hwang/paper-weekly/actions
```

1. 点击 **PaperWeekly**
2. 点击右侧 **Run workflow** → **Run workflow**
3. 等待 1-2 分钟，看是否变成绿色勾勾 ✅
4. 检查 163 邮箱 `huangjiansong0630@163.com` 是否收到两封邮件

如果显示红叉 ❌，点击进入运行记录，把报错信息复制下来，发给 Claude 继续排查。

## 配置文件说明

### 关键词调整
以后想改推送关键词，直接编辑 `agent-config.json` 里的 `accounts[].topics[].keywords`，然后 push 到 GitHub 即可。

当前配置：
- **AI 前沿日报**：LLM / Agent / RL 三个主题
- **医工交叉日报**：aDBS / tourette syndrome / freezing of gait 三个主题

### 推送时间
文件：`.github/workflows/weekly-papers.yml`
```yaml
cron: '0 0 * * 1'  # UTC 周一 0:00 = 北京时间周一早上 8:00
```

## 常用命令
```bash
# 本地手动测试全部账号
node paper-daily-agent.js all

# 本地测试单个账号
node paper-daily-agent.js ai
node paper-daily-agent.js yanyu
```

## 文件变更记录
- `paper-daily-agent.js`：主脚本，新增百度翻译、环境变量读取、去链接 HTML
- `agent-config.json`：SMTP + 百度翻译 + 两账号主题配置
- `.github/workflows/weekly-papers.yml`：GitHub Actions 定时工作流
- `scripts/run_daily.bat`：Windows 本地批处理（备用）
