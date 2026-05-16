# 🚀 快速启动指南

## Windows 用户

### 方式 1: 双击启动（推荐）
```
双击 start-local.bat 文件即可
```

### 方式 2: 创建桌面快捷方式
1. 右键点击 `start-local.bat`
2. 选择"发送到" → "桌面快捷方式"
3. 双击桌面图标即可启动

### 方式 3: 右键菜单
1. 右键点击 `start-local.bat`
2. 选择"固定到任务栏"或"固定到开始屏幕"

## macOS 用户

### 方式 1: 终端启动
```bash
./start-local.sh
```

### 方式 2: 双击启动（需配置）
1. 打开"终端"
2. 运行以下命令:
```bash
chmod +x start-local.sh
```
3. 之后即可双击 `start-local.sh` 启动

## Linux 用户

```bash
chmod +x start-local.sh
./start-local.sh
```

## 访问地址

服务启动后,浏览器会自动打开:
- **本地地址**: http://localhost:3000
- **局域网访问**: http://你的IP:3000

## 停止服务

- **Windows**: 双击 `stop-local.bat` 或按 `Ctrl+C`
- **macOS/Linux**: 按 `Ctrl+C`

## 首次运行

首次运行会自动:
1. ✅ 检查 Node.js 环境
2. ✅ 安装项目依赖
3. ✅ 运行物流解析自检
4. ✅ 启动开发服务器
5. ✅ 打开浏览器

## 遇到问题?

查看详细说明: `文档/本地部署说明.md`

---
**提示**: 建议创建桌面快捷方式,方便日常使用
