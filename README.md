# Polymarket Monitor

本地/静态两用的只读监控页，用公开钱包地址读取 Polymarket Data API。

## 启动

```bash
cd /Users/bytedance/Documents/Codex/2026-06-30/uh/outputs/polymarket-monitor
python3 server.py
```

打开：

```text
http://127.0.0.1:8787
```

可选：启动前设置默认钱包地址。

```bash
POLYMARKET_WALLET=0xYourWalletAddress python3 server.py
```

## 现在包含

- 账户持仓价值
- 未实现/已实现盈亏
- 持仓明细
- 最近活动/交易
- 未来 24 小时临近结算候选雷达

## 部署到 GitHub Pages

这个页面已经支持静态部署。放到 GitHub Pages 后，浏览器会直接读取 Polymarket 的公开 Data API；本地运行时则优先使用 `server.py` 代理。

推荐仓库结构：

```text
/
  index.html
  styles.css
  app.js
  README.md
```

GitHub Pages 设置：

```text
Settings -> Pages -> Deploy from a branch -> main -> / (root)
```

## 安全边界

第一版不保存私钥，不派生 API key，不自动下单。现金余额如果需要精确读取，需要再接授权账户接口或链上余额源。
