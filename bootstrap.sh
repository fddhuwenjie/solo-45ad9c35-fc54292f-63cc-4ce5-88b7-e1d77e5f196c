#!/usr/bin/env bash
# 在系统没有 pip 的受限环境里引导安装 Flask 到项目内 .pylibs
set -e
cd "$(dirname "$0")"

TMP_BASE="$(mktemp -d)"
trap 'rm -rf "$TMP_BASE"' EXIT

echo "[bootstrap] 下载 get-pip.py …"
curl -sS https://bootstrap.pypa.io/get-pip.py -o "$TMP_BASE/get-pip.py"
PYTHONUSERBASE="$TMP_BASE/pyuser" python3 "$TMP_BASE/get-pip.py" --user
PYTHONUSERBASE="$TMP_BASE/pyuser" python3 -m pip install --target ./.pylibs -r requirements.txt
echo "[bootstrap] 完成，依赖位于 ./.pylibs"
