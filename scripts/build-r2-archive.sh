#!/bin/bash
# R2 CDN 归档构建脚本
# 用 Docker 构建 linux-x64 和 linux-arm64 的 OpenClaw 预装归档
# 用法:
#   ./scripts/build-r2-archive.sh linux-x64       # 构建 Linux x64
#   ./scripts/build-r2-archive.sh linux-arm64     # 构建 Linux ARM64（需要 QEMU/buildx）
#   ./scripts/build-r2-archive.sh all             # 构建所有 Linux 平台
#
# 前置条件:
#   - Docker Desktop 已启动
#   - ARM64 构建需要: docker run --privileged --rm tonistiigi/binfmt --install all
#   - wrangler 已登录（用于上传到 R2）

set -e

VERSION="${1:-linux-x64}"
OPENCLAW_VERSION="2026.3.13-zh.1"
OPENCLAW_PKG="@qingchencloud/openclaw-zh"
R2_BUCKET="clawpanel-releases"
R2_PATH="openclaw-zh/${OPENCLAW_VERSION}"
OUTPUT_DIR="$(pwd)/r2-archives"

mkdir -p "$OUTPUT_DIR"

build_archive() {
  local PLATFORM="$1"     # linux-x64 or linux-arm64
  local DOCKER_PLATFORM="$2"  # linux/amd64 or linux/arm64

  echo "================================================"
  echo "构建 ${PLATFORM} 归档..."
  echo "OpenClaw: ${OPENCLAW_PKG}@${OPENCLAW_VERSION}"
  echo "Docker 平台: ${DOCKER_PLATFORM}"
  echo "================================================"

  local CONTAINER_NAME="r2-build-${PLATFORM}"
  local ARCHIVE_NAME="${PLATFORM}.tgz"

  # 清理旧容器
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

  # 在 Docker 中安装 OpenClaw 并打包
  docker run \
    --platform "$DOCKER_PLATFORM" \
    --name "$CONTAINER_NAME" \
    node:22-slim \
    bash -c "
      echo '>>> 安装 OpenClaw ${OPENCLAW_VERSION}...'
      npm install -g ${OPENCLAW_PKG}@${OPENCLAW_VERSION} --force --registry https://registry.npmmirror.com 2>&1 | tail -5
      echo '>>> 验证安装...'
      openclaw --version || echo '(版本检测跳过)'
      echo '>>> 打包 node_modules...'
      cd /usr/local/lib/node_modules
      tar -czf /tmp/archive.tgz @qingchencloud/
      ls -lh /tmp/archive.tgz
      echo '>>> 完成'
    "

  # 从容器中复制归档
  docker cp "${CONTAINER_NAME}:/tmp/archive.tgz" "${OUTPUT_DIR}/${ARCHIVE_NAME}"
  docker rm -f "$CONTAINER_NAME"

  # 计算 SHA256
  local SHA256=$(sha256sum "${OUTPUT_DIR}/${ARCHIVE_NAME}" | cut -d' ' -f1)
  local SIZE=$(stat -c%s "${OUTPUT_DIR}/${ARCHIVE_NAME}" 2>/dev/null || stat -f%z "${OUTPUT_DIR}/${ARCHIVE_NAME}")
  local SIZE_MB=$(echo "scale=1; $SIZE / 1048576" | bc)

  echo ""
  echo "✅ ${PLATFORM} 归档构建完成:"
  echo "   文件: ${OUTPUT_DIR}/${ARCHIVE_NAME}"
  echo "   大小: ${SIZE_MB} MB (${SIZE} bytes)"
  echo "   SHA256: ${SHA256}"
  echo ""

  # 保存元数据
  echo "${SHA256}" > "${OUTPUT_DIR}/${PLATFORM}.sha256"
  echo "${SIZE}" > "${OUTPUT_DIR}/${PLATFORM}.size"
}

upload_to_r2() {
  local PLATFORM="$1"
  local ARCHIVE_NAME="${PLATFORM}.tgz"

  if [ ! -f "${OUTPUT_DIR}/${ARCHIVE_NAME}" ]; then
    echo "❌ ${ARCHIVE_NAME} 不存在，跳过上传"
    return 1
  fi

  echo ">>> 上传 ${ARCHIVE_NAME} 到 R2..."
  npx wrangler r2 object put "${R2_BUCKET}/${R2_PATH}/${ARCHIVE_NAME}" \
    --file "${OUTPUT_DIR}/${ARCHIVE_NAME}" \
    --remote \
    --content-type "application/gzip"
  echo "✅ 上传完成: ${R2_PATH}/${ARCHIVE_NAME}"
}

update_latest_json() {
  echo ">>> 生成 latest.json..."

  local JSON='{"chinese":{"version":"'${OPENCLAW_VERSION}'","assets":{'
  local FIRST=true

  for PLATFORM in win-x64 linux-x64 linux-arm64 darwin-arm64; do
    if [ -f "${OUTPUT_DIR}/${PLATFORM}.sha256" ] && [ -f "${OUTPUT_DIR}/${PLATFORM}.size" ]; then
      local SHA256=$(cat "${OUTPUT_DIR}/${PLATFORM}.sha256")
      local SIZE=$(cat "${OUTPUT_DIR}/${PLATFORM}.size")
      if [ "$FIRST" = true ]; then FIRST=false; else JSON+=','; fi
      JSON+='"'${PLATFORM}'":{"url":"https://dl.qrj.ai/'${R2_PATH}'/'${PLATFORM}'.tgz","size":'${SIZE}',"sha256":"'${SHA256}'"}'
    fi
  done

  JSON+='}},"updatedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'

  echo "$JSON" > "${OUTPUT_DIR}/latest.json"
  echo ">>> latest.json 已生成"
  cat "${OUTPUT_DIR}/latest.json" | python3 -m json.tool 2>/dev/null || cat "${OUTPUT_DIR}/latest.json"

  echo ">>> 上传 latest.json 到 R2..."
  npx wrangler r2 object put "${R2_BUCKET}/openclaw-zh/latest.json" \
    --file "${OUTPUT_DIR}/latest.json" \
    --remote \
    --content-type "application/json"
  echo "✅ latest.json 已更新"
}

# === 主流程 ===

case "$VERSION" in
  linux-x64)
    build_archive "linux-x64" "linux/amd64"
    ;;
  linux-arm64)
    # ARM64 需要 QEMU 支持
    echo "确保 QEMU 已安装: docker run --privileged --rm tonistiigi/binfmt --install all"
    build_archive "linux-arm64" "linux/arm64"
    ;;
  all)
    build_archive "linux-x64" "linux/amd64"
    build_archive "linux-arm64" "linux/arm64"
    ;;
  upload)
    # 仅上传已构建的归档
    for P in win-x64 linux-x64 linux-arm64; do
      upload_to_r2 "$P" || true
    done
    update_latest_json
    ;;
  *)
    echo "用法: $0 {linux-x64|linux-arm64|all|upload}"
    echo ""
    echo "示例:"
    echo "  $0 linux-x64        # 构建 Linux x64 归档"
    echo "  $0 linux-arm64      # 构建 Linux ARM64 归档"
    echo "  $0 all              # 构建所有 Linux 平台"
    echo "  $0 upload           # 上传所有已构建的归档到 R2"
    exit 1
    ;;
esac

echo ""
echo "=== 构建产物 ==="
ls -lh "${OUTPUT_DIR}/"*.tgz 2>/dev/null || echo "(无 .tgz 文件)"
