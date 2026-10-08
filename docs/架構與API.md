# 系統架構與 API

## 部署單位

瀏覽器共用一套原生 JavaScript／CSS。FastAPI 同時提供靜態檔案與同源 JSON API。SQLite 放在應用主機的持久化本機磁碟；每次操作開啟獨立連線，以 `BEGIN IMMEDIATE` 先取得寫入鎖，再檢查存量、容量、重複識別碼及更新版本。沒有需要付款的第三方 SDK，也沒有客戶端持有資料庫金鑰。

預設使用 rollback journal（DELETE）、`synchronous=FULL`、foreign keys、10 秒 busy timeout、secure_delete。沒有自行開 WAL，避免不同 Python 發行版所捆綁 SQLite 的 WAL 修補版本不一致。請保持單台應用主機、單 worker；不能把同一 SQLite 檔案放上共享網路磁碟供多主機寫入。規模超出單店後，應先實測，再搬到具交易鎖定的服務型資料庫，不是單純開多個容器。

## 資料結構

`installation` 固定 demo/live 環境，阻擋混用資料庫；`settings` 存營業設定與版本；`products` 存菜單規格；`inventory` 是日期＋商品的可售存量；`orders` 存品項價格快照、數量、狀態、私人 token 的雜湊；`payments` 是現金／退款流水；`events` 記錄操作；`users/sessions` 存角色、密碼雜湊及登入；`rate_limits` 保存限流狀態，重啟不會清掉。

金額使用整數新台幣，送單欄位不接受價格。前端送商品 ID、版本、數量及規格選擇，後端重新算出每份價格、加價和總額。價格快照保存在訂單，後續改價不改舊訂單。

同一個商品拆成不同飯量、不同備註兩列時，扣庫存前仍會合計成同一商品的總數。整筆交易有任一項不足，全部回滾。製作前取消釋出可售存量；製作後取消保留耗用和原時段容量。

## 重複送單與操作衝突

客戶端先產生 UUID idempotency key，保存完整送單內容，再呼叫建立訂單。伺服器以 key 的 SHA-256 作唯一索引。相同 key＋相同內容回傳同一訂單與查詢 token；相同 key＋不同內容回傳 409。資料庫不明文保存私人 token；其值由持久化伺服器密鑰 HMAC 推導，能安全重播相同請求結果。密鑰遺失時既有 token 查詢仍可用資料庫雜湊比對，但無法保證舊 idempotency key 可重現原 token；必須連同密鑰一起備份與還原。

店家操作帶訂單 `version`；商品、庫存、設定亦有版本或預期值檢查。拒絕以過期畫面覆蓋別人的更新。

## API 概要

| 方法 | 路徑 | 驗證／用途 |
|---|---|---|
| GET | `/api/health` | 最小健康檢查。 |
| GET | `/api/store`、`/api/menu?day=YYYY-MM-DD`、`/api/slots?day=YYYY-MM-DD` | 公開店家、可售菜單與時段。 |
| POST | `/api/orders` | 驗證、限流、庫存／時段交易、建立或重播同一訂單。 |
| POST | `/api/order/track`、`/api/order/cancel`、`/api/order/qr` | 私人 token 查單、取消、產生 QR。Token 不放查詢字串。 |
| GET | `/api/board` | 僅公開當日已接／製作／備妥取餐號碼。 |
| POST | `/api/auth/login`、`/api/auth/logout`、`/api/auth/password` | 登入、登出、改密碼。 |
| GET | `/api/auth/me` | 有效帳號、角色、CSRF token。 |
| GET | `/api/staff/orders`、`/api/staff/pending-dates` | 依取餐日分頁查單、跨日期待接單提醒。 |
| POST | `/api/staff/orders/{public_id}/action` | 狀態機、版本檢查及角色權限。 |
| GET/POST | `/api/staff/products` | 讀取／管理菜單。 |
| POST | `/api/staff/stock`、`/api/staff/settings`、`/api/staff/pause` | 庫存、營業設定、暫停接單。 |
| GET | `/api/staff/reports`、`/api/staff/export`、`/api/staff/audit` | 管理者報表、CSV、稽核。 |
| GET/POST | `/api/staff/users` | 管理者建立櫃台／廚房。 |
| POST | `/api/staff/users/{id}` | 停用或重設密碼，撤銷登入。 |
| GET | `/api/staff/receipt/{public_id}`、`/api/staff/ordering-qr` | 取餐單列印與入口 QR。 |
| GET | `/api/staff/schema` | 管理者取得完整 OpenAPI 定義。 |

所有非 GET 的 API 需 JSON、`X-Requested-With: Gugu`。受保護寫入另需有效 HttpOnly 登入 cookie 與 `X-CSRF-Token`。同源檢查、明確 Host 白名單、CSP、no-store、no-referrer 為縱深防禦，不替代角色與物件層級授權。

登入限流 15 次／IP／10 分鐘、8 次／帳號／10 分鐘；送單 40 次／IP／10 分鐘。正式模式同一電話最多 3 筆未完成訂單。這不是電話驗證，也不能阻止所有假電話或分散式攻擊。店家正式上線仍需網路層防護、人工接單與異常訂單規則；不要把免會員系統宣稱成防詐或零風險。

來源 IP 只取 ASGI 解析後的 client，不自行相信 X-Forwarded-For。正式 Compose 只信任固定反向代理 IP；修改網段時須同步修改受信任代理設定。不能設定 `--forwarded-allow-ips '*'` 後又把應用 port 直接公開。

## 版本與觀測

這版 schema version 為 1，初始化會以 `CREATE IF NOT EXISTS` 建表。未提供跨未來版本的自動資料遷移。升級前先備份，在副本驗證 schema、取餐、帳款與還原；不要直接覆蓋正式資料。

例外使用伺服器記錄與通用 503 回應；不在瀏覽器揭露連線資訊或 SQL。沒有外接監控平台。應由主機維運者配置磁碟容量、健康檢查失敗、備份錯誤及程序重啟的告警。訂單 token 放 URL fragment，不會被正常 HTTP access log 記錄，但勿自行記錄請求 body 或完整瀏覽器網址。
