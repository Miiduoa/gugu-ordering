# 部署到自己的 Cloudflare 帳號

## 固定部署入口

[在自己的 Cloudflare 帳號建立穀穀點餐系統](https://deploy.workers.cloudflare.com/?url=https://github.com/Miiduoa/gugu-ordering/tree/cloudflare-production/cloudflare)

這是來源程式的部署入口，不是已經營運的點餐網址，也不是 `claim-preview` 領取連結。它沒有臨時帳號的 60 分鐘領取期限。仍需在 Cloudflare 頁面登入並完成部署確認；自動化不能代替尚未完成的帳號授權。

## 畫面上怎麼選

1. 登入要持有穀穀網站的 Cloudflare 帳號，依畫面連接 GitHub。只授權穀穀專案所需的存取，不選其他專案。
2. 若要求建立來源 Repository，使用獨立名稱 `gugu-ordering-live`，不要覆蓋既有的 `gugu-ordering` 或任何 NUNI Repository。Cloudflare 會將本目錄當成新 Repository 的根目錄。
3. Worker 使用 `gugu-ordering`；D1 綁定使用 `DB`，建立全新的 `gugu-ordering-db`，不要選用其他專案的資料庫。
4. Build command 為 `npm run build`；Deploy command 為 `npm run deploy`。這兩個 script 已存在 package.json。不要加入 `--temporary`。
5. 維持 Workers Free 和 D1 Free，只使用靜態資產。若出現付費方案、信用卡或升級要求，停止確認；本程式不需要 R2 或付費網域。
6. 檢查設定後按 Deploy。等待 Cloudflare 回報成功，再使用這次新產生的 `workers.dev` 網址。

## 第一次啟用

開啟新網址的 `/staff/`，使用私下交付的啟用碼，建立自己選定的帳號和至少 12 字元的密碼。啟用碼不是 Cloudflare API 金鑰。請勿將它寫入 GitHub、日誌或公開截圖。

顧客頁不需要測試入口密碼。第一次建立的資料庫預設接單關閉、庫存為零。店家要核對真實菜單、營業日、取餐時段與實際可售份數，測過下單與收款交付後，再開啟當日接單。不要以任意假設的庫存開放真實營業。

## 舊的 Claim expired 畫面

舊 `claim-preview` 是臨時帳號的領取網址。Cloudflare 規定未在期限內領取的帳號及資源會被刪除；逾期後不能用改網址或重新整理救回。GitHub 中保存的原始碼及靜態餐點照片不受該領取期限影響，但不能因此聲稱臨時資料庫中的資料也已備份。

本專案原本會建立臨時帳號的 GitHub workflow 已改成唯讀檢查；不再因更新 workflow 自動建立限時帳號。GitHub Actions 顯示綠色只代表原始碼檢查通過，不代表網站已在你的 Cloudflare 帳號上線。

## 部署後的確認

- `/api/health` 應回傳健康 JSON，不是安全驗證頁或 403。
- `/api/menu`、餐點圖片、手機點餐頁和 `/staff/` 正常顯示。
- 以店家控管的驗收資料走完登入、下單、接單、製作、收款、交付及重新載入查詢。
- 匯出備份並在全新隔離資料庫測試還原，確認收款與庫存一致，不能覆蓋正在營業的資料庫。
- 公開網址驗收通過前不宣稱正式營業完成。

免費方案仍有容量和用量限制，也不保證永久零故障；停止營業和備援電話流程仍須保留。不修改、刪除、暫停或重啟其他專案。

官方文件：
- https://developers.cloudflare.com/workers/platform/deploy-buttons/
- https://developers.cloudflare.com/workers/platform/claim-deployments/
