# 穀穀正式站部署入口修正

正式 Cloudflare 應用現在也保存在 main，從 repository 根目錄或 cloudflare 子目錄部署都可載入真正 API。原 Python/Render 測試程式原樣保留；不要把 preview/index.html 當成網站發布。

## 既有 Worker 的建置設定

Repository: Miiduoa/gugu-ordering
Production branch: main
Root directory: /（repository 根目錄；留空也可）
Build command: npm run build
Deploy command: npx wrangler deploy

根目錄 wrangler.jsonc 指向 cloudflare/src/worker.mjs 與 cloudflare/public，綁定名稱 DB、資料庫名稱 gugu-ordering-db。僅使用穀穀資料庫；已有穀穀資料庫时保留它的 UUID，不重新建立或清空。Workers Free 與 D1 Free，不開啟付費服務。

如果 Worker 是手動上傳 HTML 建立、沒有連接此 GitHub repository，推送 GitHub 不會自動更新該網站。須先在該 Worker 連接 repository 並使用上列設定。已連接 repository 者只需部署最新 main，不需再註冊帳號或重領臨時網站。

## 驗收

npm run build
npm test
npm run check:live -- https://實際網址.workers.dev

check:live 只讀取公開頁面與 API：檢查 D1、live 模式，以及前端程式 SHA-256 與 repo 版本相同。不登入、不送單、不修改庫存；未取得實際網址或被平台驗證擋住，不算公開驗收通過。

首次啟用與開台規則見 cloudflare/README.md。接單開關、每日庫存和廚房值班檢查不因這次入口修復而繞過。舊 Render 網址與下載的 HTML 仍是隔離展示，不應當作正式點餐網址。
