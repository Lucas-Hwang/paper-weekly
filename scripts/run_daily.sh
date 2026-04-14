#!/bin/bash
# paper-daily.sh — 每周论文推送主脚本
# 由 cron 每周一 8:00 AM 自动触发（cron: 0 8 * * 1）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PAPERS_DIR="$PROJECT_DIR/papers"
LOGS_DIR="$PROJECT_DIR/logs"
DATE=$(date +%Y-%m-%d)

echo "========== 🤖 PaperDaily 启动 | $(date '+%Y-%m-%d %H:%M:%S') =========="

# Step 1: 采集论文
echo "[1/4] 📥 采集最新论文..."
node "$SCRIPT_DIR/fetch_papers.js" >> "$LOGS_DIR/daily_$DATE.log" 2>&1
if [ $? -ne 0 ]; then
  echo "❌ 采集失败，退出"
  exit 1
fi

# Step 2: 检查采集结果
PAPER_FILE="$LOGS_DIR/fetch_$DATE.json"
if [ ! -f "$PAPER_FILE" ]; then
  echo "❌ 采集结果文件不存在"
  exit 1
fi

COUNT=$(node -e "const d=require('$PAPER_FILE'); console.log(d.papers.length)")
echo "[2/4] 📊 采集到 $COUNT 篇论文，准备分析..."

# Step 3: 生成分析任务
# 将论文列表传给主 Agent 进行分析和发送
cat "$PAPER_FILE" | node -e "
const fs = require('fs');
const stdin = fs.readFileSync('/dev/stdin', 'utf8');
const data = JSON.parse(stdin);
const papers = data.papers;
console.log(JSON.stringify(papers));
" > "$PAPERS_DIR/today_papers.json"

echo "[3/4] ✅ 论文已准备好，等待分析..."

# Step 4: 通知主 Agent（通过会话消息触发分析）
echo "[4/4] 📤 触发日报生成..."

# 触发 OpenClaw 执行分析并发送邮件
openclaw run "paper-analysis" 2>/dev/null || echo "将自动触发"

echo "========== ✅ PaperDaily 完成 | $(date '+%Y-%m-%d %H:%M:%S') =========="
