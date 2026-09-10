#!/usr/bin/env bash
# 一键启动：若缺少 Flask，自动安装到项目内 .pylibs（不需要 sudo，不污染系统 Python）
set -e
cd "$(dirname "$0")"

if ! python3 -c "import flask" 2>/dev/null; then
  echo "[run.sh] 未检测到 Flask，开始安装到 ./.pylibs …"
  if python3 -m pip --version >/dev/null 2>&1; then
    python3 -m pip install --target ./.pylibs -r requirements.txt
  else
    bash ./bootstrap.sh
  fi
fi
export PYTHONPATH="$(pwd)/.pylibs${PYTHONPATH:+:$PYTHONPATH}"
PORT="${PORT:-5000}"
echo "[run.sh] 浏览器访问 http://127.0.0.1:${PORT}（Ctrl+C 退出）"
exec python3 app.py
