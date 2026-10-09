# 穀穀健康廚房｜學府總店點餐系統

Cloudflare Workers + 獨立 D1 的外帶自取系統。真實菜單、餐點照片、店家帳密管理、庫存、接單、收款與備份程式位於 `cloudflare/`，現在已納入預設 `main` 分支。

**不要將 `preview/index.html`、下載的互動展示 HTML 或 Render 測試網址當成正式點餐入口。** 這些仍是舊版隔離展示，不會因 GitHub 更新自動變成真實接單網站。

## 正確的 Cloudflare 部署來源

- Repository：`Miiduoa/gugu-ordering`
- Production branch：`main`
- Root directory：repository 根目錄（`/` 或留空）
- Build command：`npm run build`
- Deploy command：`npx wrangler deploy`

根目錄 `wrangler.jsonc` 已指定 `cloudflare/src/worker.mjs` 和 `cloudflare/public`；API 交由 Worker，資料庫綁定為 `DB`。不能只上傳靜態 HTML。已有穀穀 D1 時保留其 UUID，不清空、不另綁其他專案資料庫。

已連接 GitHub 的 Worker 需部署最新 main；若是手動上傳 HTML 建立的 Worker，GitHub 推送本身不會更換該網站。請在該 Worker 連接這個 repository，使用上列設定。**原始碼測試通過不代表你的公開網址已更新。**

## 驗證

```sh
npm ci
npm run build
npm test
npm run check:live -- https://YOUR-WORKER.workers.dev
```

`npm test` 包含 5 項部署入口防錯及 35 項交易／權限／還原測試。CI 另編譯實際 Worker bundle；公開驗收需使用真正網站 URL，檢查 D1/live API 和前端檔案一致性。公開檢查不登入、不送單、不修改庫存。

[Cloudflare 操作與功能說明](cloudflare/README.md) · [部署故障排除](DEPLOY-CLOUDFLARE.md) · [舊 Render 測試版說明](docs/README-render-legacy.md)

首次使用仍須以私下交付的啟用碼建立店長帳號、設定營業時段與實際庫存，再開台接单。不能把庫存和接單安全保護當成測試模式移除。只選用 Free 方案，不啟用付費項目；額度限制和現場接單備援見功能說明。
