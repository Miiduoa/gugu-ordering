"use strict";
const $ = (s, r = document) => r.querySelector(s),
  esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  money = (x) => `NT$ ${Number(x || 0).toLocaleString("zh-TW")}`;
const labels = {
    pending: "等待接單",
    accepted: "店家已接單",
    preparing: "製作中",
    ready: "可以取餐",
    completed: "已取餐",
    cancelled: "已取消",
    rejected: "店家未接單",
    no_show: "未取餐",
  },
  riceLabels = {
    normal: "正常飯",
    half: "半飯",
    veggies: "飯換菜",
    "sweet-potato": "飯換地瓜",
  },
  spicyLabels = { mild: "小辣", medium: "中辣", hot: "大辣" };
const state = {
  store: null,
  products: [],
  cart: [],
  category: "全部",
  search: "",
  user: null,
  csrf: "",
  adminTab: "orders",
  adminProducts: [],
  orders: [],
  day: "",
  heartbeat: 0,
  attempt: null,
};
let interval = null,
  toastTimer;
function toast(s) {
  $("#toast").textContent = s;
  $("#toast").style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").style.display = "none"), 4500);
}
function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
async function derive(password, salt) {
  let key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  let b = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: 600000,
      salt: new TextEncoder().encode(salt),
    },
    key,
    256,
  );
  return Array.from(new Uint8Array(b), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
async function api(path, body, method = "POST", headers = {}) {
  let ctrl = new AbortController(),
    timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    let r = await fetch(path, {
      method: body === undefined ? "GET" : method,
      credentials: "same-origin",
      signal: ctrl.signal,
      headers: {
        ...(body !== undefined
          ? {
              "Content-Type": "application/json",
              "X-Requested-With": "Gugu",
              "X-CSRF-Token": state.csrf,
            }
          : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data = await r.json().catch(() => ({ detail: "服務暫時無法回應" }));
    if (!r.ok) {
      let e = new Error(data.detail || "操作失敗");
      e.status = r.status;
      throw e;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error(
        "連線較慢，尚未確認是否送出。請在原畫面重試，不要重新建立新單。",
      );
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function shell(content, admin = false) {
  $("#app").innerHTML =
    `<div class="shell"><header class="top"><a class="brand" href="/">穀穀<small>健康廚房・學府總店</small></a><nav class="nav" aria-label="主要導覽"><a href="/">點餐</a><a href="/history/">我的訂單</a><a href="/staff/">${admin ? "店家工作台" : "店家登入"}</a></nav></header><main id="main">${content}</main><footer class="footer"><strong>穀穀健康廚房・學府總店</strong><p>台中市南區學府路136號　<a href="tel:0422220572">04-22220572</a></p><p>11:00–14:00／17:00–20:00；實際公休日與線上接單依店家設定。</p><p>外帶自取・到店現金付款。過敏原、團體餐與配送需求請於營業時間致電。</p><a href="/privacy/">隱私與取餐須知</a></footer></div>`;
}
function modal(title, body) {
  let d = $("#modal");
  d.innerHTML = `<div class="modal-content"><div class="modal-head"><h2>${esc(title)}</h2><button class="close" data-close aria-label="關閉">×</button></div>${body}</div>`;
  if (!d.open) d.showModal();
  $("[data-close]", d).onclick = () => d.close();
  d.onclick = (e) => {
    if (e.target === d) d.close();
  };
  return d;
}
function formError(form, e) {
  let el = $(".error", form);
  if (el) el.textContent = e.message;
  else toast(e.message);
}
async function submit(form, fn) {
  let button = $("button[type=submit]", form);
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (e) {
    formError(form, e);
  } finally {
    if (button) button.disabled = false;
  }
}
const details = (x) =>
  `${x.variant === "single" ? "單點主菜" : x.kind === "meal" ? "餐盒" : ""}${x.kind === "meal" && x.variant !== "single" ? "・" + riceLabels[x.rice] : ""}${x.spicy ? "・" + spicyLabels[x.spicy] : ""}`;
function photo(p, cls = "photo") {
  return `<div class="${cls}">${p.photo ? `<img src="${esc(p.photo)}" alt="${esc(p.name)}的店家菜單照片" loading="lazy" decoding="async">` : '<div class="photo-empty"><span class="empty-bowl"></span>店家尚未提供照片</div>'}</div>`;
}
async function customer() {
  state.store = await api("/api/store");
  if (!state.day) state.day = state.store.today;
  state.products = (await api("/api/menu?day=" + state.day)).products;
  let s = state.store;
  let open = s.accepting;
  shell(
    `<section class="intro"><div><div class="eyebrow">外帶自取 · 到店付款</div><h1>今天，也好好吃飯。</h1><p class="muted">${esc(s.announcement)}</p></div><span class="status ${open ? "" : "off"}">${open ? "現在開放點餐" : "店家尚未開放線上接單"}</span></section>${!open ? '<div class="notice">菜單可以先看。店家工作台上線並開放接單後，才能送出訂單。</div>' : ""}<div class="toolbar"><div class="chips" id="categories">${["全部", "餐盒", "湯品", "單點"].map((c) => `<button data-cat="${c}" aria-pressed="${c === state.category}">${c}</button>`).join("")}</div><input id="search" type="search" aria-label="搜尋餐點" placeholder="搜尋餐點" value="${esc(state.search)}"></div><div class="menu" id="menu"></div><div class="notice">餐盒可選飯換菜或地瓜。自備餐盒每盒折 NT$2（單點除外）；需要附湯請在結帳時勾選。配菜與附湯依當日供應。</div>`,
  );
  drawMenu();
  $("#categories").onclick = (e) => {
    let b = e.target.closest("[data-cat]");
    if (b) {
      state.category = b.dataset.cat;
      $("#categories")
        .querySelectorAll("button")
        .forEach((x) => x.setAttribute("aria-pressed", x === b));
      drawMenu();
    }
  };
  $("#search").oninput = (e) => {
    state.search = e.target.value;
    drawMenu();
  };
  drawCart();
}
function drawMenu() {
  let p = state.products.filter(
    (p) =>
      (state.category === "全部" || p.category === state.category) &&
      p.name.includes(state.search),
  );
  $("#menu").innerHTML =
    p
      .map(
        (p) =>
          `<article class="card">${photo(p)}<div class="card-body"><h3>${esc(p.name)}</h3><p class="description">${esc(p.description)}</p><div class="card-bottom"><span class="price">${money(p.price)}</span><button class="${p.remaining > 0 ? "primary" : ""}" data-add="${esc(p.id)}">${p.remaining > 0 ? "選擇餐點" : "查看餐點"}</button></div><div class="stock">${p.single_price !== null ? "單點 " + money(p.single_price) + " · " : ""}${p.remaining > 0 ? "剩餘 " + p.remaining + " 份" : "今日尚無可售份數"}</div></div></article>`,
      )
      .join("") || '<p class="empty">目前沒有符合的餐點。</p>';
  $("#menu").onclick = (e) => {
    let b = e.target.closest("[data-add]");
    if (b) choose(b.dataset.add);
  };
}
function choose(id) {
  if (state.attempt) {
    recoverAttempt();
    return;
  }
  let p = state.products.find((x) => x.id === id),
    d = modal(
      p.name,
      `${photo(p, "modal-photo")}<p class="field-note">${esc(p.photo_note)}</p><p>${esc(p.description)}</p><form id="product-form"><label>餐點規格</label><div class="choice"><label><input type="radio" name="variant" value="meal" checked>${p.kind === "meal" ? "餐盒" : "單份"} ${money(p.price)}</label>${p.single_price !== null ? `<label><input type="radio" name="variant" value="single">單點主菜 ${money(p.single_price)}</label>` : ""}</div>${
        p.kind === "meal"
          ? `<div id="rice-options"><label for="rice">飯量／替換</label><select name="rice" id="rice">${Object.entries(
              riceLabels,
            )
              .map(([k, v]) => `<option value="${k}">${v}</option>`)
              .join("")}</select></div>`
          : ""
      }${p.id === "basil" ? '<label for="spicy">辣度</label><select name="spicy" id="spicy"><option value="mild">小辣</option><option value="medium">中辣</option><option value="hot">大辣</option></select>' : ""}<label for="qty">份數</label><input type="number" name="qty" id="qty" value="1" min="1" max="${Math.max(1, Math.min(20, p.remaining))}" required><p class="field-note">單點主菜不包含照片中的飯與配菜。</p><div class="error" role="alert"></div><div class="actions"><button type="submit" class="primary" ${p.remaining < 1 ? "disabled" : ""}>加入餐點</button></div></form>`,
    );
  let f = $("#product-form");
  f.onchange = () => {
    if ($("#rice-options"))
      $("#rice-options").hidden = new FormData(f).get("variant") === "single";
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    let v = Object.fromEntries(new FormData(f));
    state.cart.push({
      ...p,
      variant: v.variant,
      rice: v.rice || "normal",
      spicy: v.spicy || "",
      qty: Number(v.qty),
      unitPrice: v.variant === "single" ? p.single_price : p.price,
    });
    d.close();
    drawCart();
    toast("已加入餐點");
  };
}
function cartTotal() {
  return state.cart.reduce((n, p) => n + p.unitPrice * p.qty, 0);
}
function drawCart() {
  document.querySelector(".cart-bar")?.remove();
  if (!state.cart.length) return;
  let b = document.createElement("div");
  b.className = "cart-bar";
  b.innerHTML = `<div class="cart-inner"><div><strong>${state.cart.reduce((n, p) => n + p.qty, 0)} 份餐點</strong><br><small>${money(cartTotal())}</small></div><button class="primary" id="checkout">查看餐點・選取餐時間 →</button></div>`;
  document.body.appendChild(b);
  $("#checkout").onclick = checkout;
}
async function checkout() {
  if (state.attempt) {
    recoverAttempt();
    return;
  }
  let today = state.store.today,
    dates = Array.from({ length: state.store.advance_days + 1 }, (_, i) => {
      let d = new Date(today + "T12:00:00+08:00");
      d.setDate(d.getDate() + i);
      return new Date(d.getTime() + 28800000).toISOString().slice(0, 10);
    });
  let meals = state.cart.reduce(
    (n, p) => n + (p.kind === "meal" && p.variant === "meal" ? p.qty : 0),
    0,
  );
  let d = modal(
    "確認餐點與取餐時間",
    `<div>${state.cart.map((p, i) => `<div class="cart-line"><div><strong>${esc(p.name)} × ${p.qty}</strong><small>${esc(details(p))}</small><span>${money(p.unitPrice * p.qty)}</span></div><button data-remove="${i}" aria-label="移除${esc(p.name)}">移除</button></div>`).join("")}</div><form id="checkout-form"><div class="row"><div><label for="pickup-day">取餐日期</label><select id="pickup-day" name="day">${dates.map((x) => `<option value="${x}">${x === today ? "今天" : x}</option>`).join("")}</select></div><div><label for="pickup-slot">取餐時間</label><select id="pickup-slot" name="slot" required><option value="">正在查詢…</option></select></div></div><div class="row"><div><label for="buyer-name">取餐稱呼</label><input id="buyer-name" name="name" maxlength="30" autocomplete="given-name" required></div><div><label for="buyer-phone">聯絡手機</label><input id="buyer-phone" name="phone" type="tel" pattern="09[0-9]{8}" inputmode="tel" maxlength="10" placeholder="09xxxxxxxx" autocomplete="tel-national" required></div></div><label for="own-boxes">自備餐盒數量（餐盒每盒折 NT$2）</label><input id="own-boxes" type="number" name="own_boxes" value="0" min="0" max="${meals}" required><label class="check"><input type="checkbox" name="soup">需要附湯（依現場供應，不是付費雞湯）</label><label for="order-note">餐點備註</label><textarea id="order-note" name="note" maxlength="300" rows="2" placeholder="特殊需求請先致電確認"></textarea><div class="total" id="cart-total">合計 ${money(cartTotal())}</div><p class="privacy">僅將稱呼、手機與備註用於此筆訂單及取餐聯絡。不提供線上付款，送出後仍須等待店家接單。</p><label class="check"><input type="checkbox" name="consent" required>同意上述資料使用方式與取餐須知</label><div class="error" role="alert"></div><div class="actions"><button class="primary" type="submit" ${!state.store.accepting ? "disabled" : ""}>送出訂單・到店付款</button></div></form>`,
  );
  d.querySelectorAll("[data-remove]").forEach(
    (b) =>
      (b.onclick = () => {
        state.cart.splice(Number(b.dataset.remove), 1);
        drawCart();
        if (!state.cart.length) d.close();
        else checkout();
      }),
  );
  let f = $("#checkout-form");
  async function loadSlots() {
    let s = await api("/api/slots?day=" + $("#pickup-day").value);
    $("#pickup-slot").innerHTML =
      s.slots
        .filter((x) => x.remaining >= state.cart.reduce((n, p) => n + p.qty, 0))
        .map((x) => `<option value="${x.time}">${x.time}</option>`)
        .join("") || '<option value="">暫無可用時段</option>';
  }
  try {
    await loadSlots();
  } catch (e) {
    formError(f, e);
  }
  $("#pickup-day").onchange = () => loadSlots().catch((e) => formError(f, e));
  $("#own-boxes").oninput = () =>
    ($("#cart-total").textContent =
      "合計 " + money(cartTotal() - Number($("#own-boxes").value || 0) * 2));
  f.onsubmit = (e) => {
    e.preventDefault();
    submit(f, async () => {
      let v = Object.fromEntries(new FormData(f));
      state.attempt = {
        client_key: randomHex(),
        day: v.day,
        slot: v.slot,
        name: v.name,
        phone: v.phone,
        note: v.note,
        own_boxes: Number(v.own_boxes),
        soup: !!v.soup,
        consent: !!v.consent,
        items: state.cart.map((p) => ({
          id: p.id,
          qty: p.qty,
          variant: p.variant,
          version: p.version,
          rice: p.rice,
          spicy: p.spicy,
        })),
      };
      storeAttempt();
      try {
        await sendAttempt();
      } catch (e) {
        if (e.status && e.status < 500) {
          clearAttempt();
        } else {
          f.querySelectorAll("input,select,textarea").forEach(
            (x) => (x.disabled = true),
          );
          $("button[type=submit]", f).textContent = "重試確認同一筆訂單";
          f.onsubmit = (e) => {
            e.preventDefault();
            submit(f, sendAttempt);
          };
        }
        throw e;
      }
    });
  };
}
function storeAttempt() {
  try {
    sessionStorage.setItem("gugu-attempt", JSON.stringify(state.attempt));
  } catch {}
}
function clearAttempt() {
  state.attempt = null;
  try {
    sessionStorage.removeItem("gugu-attempt");
  } catch {}
}
async function sendAttempt() {
  if (!state.attempt) throw new Error("請重新選餐");
  let o;
  try {
    o = await api("/api/orders", state.attempt);
  } catch (e) {
    if (e.status && e.status < 500) {
      clearAttempt();
      $("#modal").close();
      toast(e.message);
      await customer();
    }
    throw e;
  }
  let token = state.attempt.client_key;
  try {
    let saved = JSON.parse(localStorage.getItem("gugu-orders") || "[]");
    if (!Array.isArray(saved)) saved = [];
    saved.unshift({ id: o.id, token, day: o.day, number: o.number });
    localStorage.setItem("gugu-orders", JSON.stringify(saved.slice(0, 10)));
  } catch {}
  clearAttempt();
  state.cart = [];
  $("#modal").close();
  location.href = "/order/" + o.id + "#" + token;
}
function recoverAttempt() {
  let d = modal(
    "確認上一筆送單結果",
    `<p>上一筆訂單尚未收到確定回應。先查詢同一筆訂單，不會額外建立重複訂單。</p><p>取餐：${esc(state.attempt.day)} ${esc(state.attempt.slot)}</p><form id="recover-form"><div class="error" role="alert"></div><button type="submit" class="primary">重試確認同一筆訂單</button></form><p class="field-note">有疑問請於營業時間致電店家，避免重新點一份。</p>`,
  );
  let f = $("#recover-form");
  f.onsubmit = (e) => {
    e.preventDefault();
    submit(f, sendAttempt);
  };
}

async function orderPage() {
  let id = location.pathname.split("/")[2],
    token = location.hash.slice(1);
  if (!token) {
    try {
      let s = JSON.parse(localStorage.getItem("gugu-orders") || "[]").find(
        (x) => x.id === id,
      );
      token = s?.token || "";
    } catch {}
  }
  let o = await api("/api/orders/" + id, undefined, "GET", {
    "X-Order-Token": token,
  });
  let steps = ["pending", "accepted", "preparing", "ready", "completed"],
    index = steps.indexOf(o.status);
  shell(
    `<div class="panel narrow"><div class="eyebrow">你的取餐號碼</div><div class="order-number">${esc(o.number)}</div><h2>${esc(labels[o.status])}</h2><p>${esc(o.day)} ${esc(o.slot)} 自取</p><div class="stepper">${steps.map((s, i) => `<span class="${i <= index ? "done" : ""}">${labels[s]}</span>`).join("")}</div>${o.items.map((p) => `<div class="list-row"><span>${esc(p.name)} × ${p.qty}<small>${esc(details(p))}</small></span><span>${money(p.price * p.qty)}</span></div>`).join("")}<div class="list-row"><span>自備餐盒折扣（${o.own_boxes} 盒）</span><span>−${money(o.discount)}</span></div><div class="total">${money(o.total)}</div><p>${o.payment === "paid" ? "已確認收款" : o.payment === "refunded" ? "已登記退款" : "到店現金付款"}</p>${o.note ? `<p>備註：${esc(o.note)}</p>` : ""}<p class="notice">${o.status === "pending" ? "已送出，正在等待店家確認。尚未接單前請勿出發。" : o.status === "ready" ? "餐點已完成，請帶著取餐號碼到店取餐。" : "此頁每 10 秒更新一次。取餐時間以店家確認為準。"}</p><div class="actions">${o.status === "pending" ? '<button class="danger" id="cancel-order">取消訂單</button>' : ""}<a class="btn" href="tel:0422220572">聯絡店家</a></div><p class="field-note">這是私人訂單連結，請勿公開分享。</p></div>`,
  );
  if ($("#cancel-order"))
    $("#cancel-order").onclick = async () => {
      if (confirm("確定取消這筆尚未接單的訂單？"))
        try {
          await api("/api/orders/" + id + "/cancel", {}, "POST", {
            "X-Order-Token": token,
          });
          await orderPage();
        } catch (e) {
          toast(e.message);
        }
    };
}
function history() {
  let list;
  try {
    list = JSON.parse(localStorage.getItem("gugu-orders") || "[]");
  } catch {
    list = [];
  }
  shell(
    `<h1 style="margin-top:30px">我的訂單</h1><p class="muted">只顯示此瀏覽器保留的最近訂單。</p><div class="panel">${list.map((o) => `<div class="list-row"><div><strong>#${esc(o.number)}</strong><small>${esc(o.day)}</small></div><a class="btn" href="/order/${esc(o.id)}#${esc(o.token)}">查看進度</a></div>`).join("") || "<p>目前沒有儲存的訂單。</p>"}</div>${list.length ? '<button id="clear-history" class="quiet">清除此裝置的紀錄</button>' : ""}`,
  );
  if ($("#clear-history"))
    $("#clear-history").onclick = () => {
      if (confirm("只清除此裝置的查詢連結，不會取消店家的訂單。繼續？")) {
        localStorage.removeItem("gugu-orders");
        history();
      }
    };
}
async function staff() {
  state.store = await api("/api/store");
  try {
    let me = await api("/api/me");
    state.user = me.user;
    state.csrf = me.csrf;
    if (!state.day) state.day = state.store.today;
    await admin();
  } catch (e) {
    if (e.status === 401) login(state.store.needs_setup);
    else throw e;
  }
}
function login(setup = false) {
  shell(
    `<div class="panel narrow"><div class="eyebrow">${setup ? "第一次使用" : "店家工作台"}</div><h1>${setup ? "建立店長帳號" : "店家登入"}</h1><p class="muted">${setup ? "此步驟只需完成一次。使用私下保存的啟用碼建立帳號。" : "登入後可接單、管理菜單與查看營業紀錄。"}</p><form id="login-form">${setup ? '<label for="setup-key">一次性啟用碼</label><input id="setup-key" name="setup_key" type="password" required autocomplete="off"><label for="display-name">稱呼</label><input id="display-name" name="name" value="店長" maxlength="30" required>' : ""}<label for="username">登入帳號</label><input id="username" name="username" autocomplete="username" autocapitalize="none" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}" required><label for="password">密碼</label><input id="password" name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" ${setup ? 'minlength="12"' : ""} required>${setup ? '<p class="field-note">請使用至少 12 個字元，勿與其他網站共用密碼。</p>' : ""}<div class="error" role="alert"></div><div class="actions"><button class="primary" type="submit">${setup ? "建立管理者帳號" : "登入"}</button></div></form></div>`,
  );
  let f = $("#login-form");
  f.onsubmit = (e) => {
    e.preventDefault();
    submit(f, async () => {
      let v = Object.fromEntries(new FormData(f));
      v.username = v.username.toLowerCase();
      $("button[type=submit]", f).textContent = "正在安全驗證…";
      if (setup) {
        let salt = randomHex(),
          p = await derive(v.password, salt);
        await api("/api/setup", {
          setup_key: v.setup_key,
          name: v.name,
          username: v.username,
          salt,
          proof: p,
        });
        toast("帳號建立完成，請登入");
        login(false);
      } else {
        let salt = await api(
            "/api/auth/salt?username=" + encodeURIComponent(v.username),
          ),
          me = await api("/api/login", {
            username: v.username,
            proof: await derive(v.password, salt.salt),
          });
        state.user = me.user;
        state.csrf = me.csrf;
        state.day = state.store.today;
        await admin();
      }
    }).finally(() => {
      if ($("button[type=submit]", f))
        $("button[type=submit]", f).textContent = setup
          ? "建立管理者帳號"
          : "登入";
    });
  };
}
async function heartbeat() {
  if (
    document.hidden ||
    !state.user ||
    state.user.role === "kitchen" ||
    Date.now() - state.heartbeat < 25000
  )
    return;
  await api("/api/admin/heartbeat", {});
  state.heartbeat = Date.now();
}
async function admin() {
  let u = state.user;
  await heartbeat();
  shell(
    `<div class="title-row" style="margin-top:26px"><div><div class="eyebrow">${esc(u.name)}・${{ owner: "店長", cashier: "櫃台", kitchen: "廚房" }[u.role]}</div><h1>店家工作台</h1></div><button class="quiet" id="logout">登出</button></div><p class="notice">接單時請保持工作台在前景。離線超過 90 秒會停止新接單，已成立訂單不會消失。</p><nav class="admin-tabs" id="admin-tabs">${[
      ["orders", "接單"],
      ...(u.role !== "kitchen"
        ? [
            ["products", "菜單與庫存"],
            ["report", "營業紀錄"],
          ]
        : []),
      ...(u.role === "owner"
        ? [
            ["settings", "營業設定"],
            ["users", "店員帳號"],
          ]
        : []),
      ["account", "我的帳號"],
    ]
      .map(
        ([id, name]) =>
          `<button data-tab="${id}" class="${state.adminTab === id ? "primary" : ""}">${name}</button>`,
      )
      .join("")}</nav><div id="admin-content"></div>`,
    true,
  );
  $("#logout").onclick = async () => {
    await api("/api/logout", {});
    state.user = null;
    state.csrf = "";
    login(false);
  };
  $("#admin-tabs").onclick = (e) => {
    let t = e.target.closest("[data-tab]");
    if (t) {
      state.adminTab = t.dataset.tab;
      admin().catch((e) => toast(e.message));
    }
  };
  await drawAdmin();
}
async function drawAdmin() {
  let area = $("#admin-content");
  if (!area) return;
  let tab = state.adminTab;
  if (tab === "orders") return adminOrders();
  if (tab === "products") return adminProducts();
  if (tab === "account") return account();
  if (tab === "settings") return settingsForm();
  if (tab === "users") return usersForm();
  if (tab === "report") {
    let r = await api("/api/admin/report?day=" + state.day);
    area.innerHTML = `<h2>${esc(state.day)} 營業紀錄</h2><div class="panel"><h3>現金收付</h3>${r.payments.map((x) => `<div class="list-row"><span>${x.kind === "cash" ? "收款" : "退款"}</span><strong>${money(x.amount)}</strong></div>`).join("") || "<p>尚無紀錄。</p>"}<div class="total">淨收現 ${money(r.payments.reduce((a, b) => a + b.amount, 0))}</div><p class="field-note">這是店員確認的現金紀錄，不是銀行對帳或利潤。</p></div><div class="panel"><h3>訂單狀態</h3>${r.orders.map((x) => `<div class="list-row"><span>${labels[x.status]} ${x.count} 筆</span><strong>${money(x.total)}</strong></div>`).join("")}</div><button id="download-csv">匯出 CSV</button>`;
    $("#download-csv").onclick = () =>
      download(
        "gugu-report-" + state.day + ".csv",
        "\ufeff日期,項目,金額\n" +
          r.payments
            .map(
              (x) =>
                `${state.day},${x.kind === "cash" ? "收款" : "退款"},${x.amount}`,
            )
            .join("\n"),
        "text/csv",
      );
  }
}
async function adminOrders() {
  let page = await api("/api/admin/orders?day=" + state.day);
  state.orders = page.orders;
  let s = await api("/api/store"),
    o = state.orders.filter(
      (o) =>
        !["completed", "cancelled", "rejected", "no_show"].includes(o.status),
    );
  $("#admin-content").innerHTML =
    `<div class="toolbar"><input type="date" id="admin-day" aria-label="查看取餐日" value="${state.day}" style="max-width:200px"><span class="status ${s.accepting ? "" : "off"}">${s.accepting ? "線上接單中" : "新接單已關閉"}</span>${state.user.role !== "kitchen" ? `<button id="toggle-open" class="${s.accepting ? "quiet" : "primary"}">${s.paused || s.open_until < s.server_time ? "開始今天接單" : "暫停接單"}</button><button id="sound">啟用提示音</button>` : ""}</div><div class="stats"><div>等待接單<strong>${o.filter((x) => x.status === "pending").length}</strong></div><div>製作中<strong>${o.filter((x) => ["accepted", "preparing"].includes(x.status)).length}</strong></div><div>等待取餐<strong>${o.filter((x) => x.status === "ready").length}</strong></div></div>${page.truncated ? '<div class="notice">只顯示前 1,000 筆（待處理優先），完整歷史請下載備份。</div>' : ""}<div id="order-list">${o.map(orderCard).join("") || '<div class="empty">目前沒有待處理訂單。</div>'}</div><details><summary>已結束訂單</summary>${state.orders
      .filter((x) => !o.includes(x))
      .map(orderCard)
      .join("")}</details>`;
  $("#admin-day").onchange = (e) => {
    state.day = e.target.value;
    adminOrders().catch((e) => toast(e.message));
  };
  $("#admin-content")
    .querySelectorAll("[data-action]")
    .forEach(
      (b) => (b.onclick = () => orderAction(b.dataset.id, b.dataset.action)),
    );
  if ($("#toggle-open"))
    $("#toggle-open").onclick = async () => {
      let open = s.paused || s.open_until < s.server_time;
      if (
        open &&
        !confirm(
          "已核對今天的菜單價格、可售份數、營業時間，且櫃台有人接單。確定開放？",
        )
      )
        return;
      try {
        await api("/api/admin/open", { open, confirmed: true });
        await adminOrders();
      } catch (e) {
        toast(e.message);
      }
    };
  if ($("#sound"))
    $("#sound").onclick = () => {
      window.guguAudio = new (window.AudioContext ||
        window.webkitAudioContext)();
      toast("已啟用前景提示音。請勿鎖定或關閉工作台。");
      beep();
    };
}
function orderCard(o) {
  let actions = [];
  if (o.status === "pending" && state.user.role !== "kitchen")
    actions = [
      ["accept", "接單"],
      ["reject", "無法供餐"],
    ];
  if (o.status === "accepted") actions = [["prepare", "開始製作"]];
  if (o.status === "preparing") actions = [["ready", "完成出餐"]];
  if (o.status === "ready" && state.user.role !== "kitchen")
    actions =
      o.payment === "paid"
        ? [["complete", "確認交付"]]
        : o.payment === "unpaid"
          ? [["paid", "確認收到現金"]]
          : [];
  if (activeStatusesFront(o.status) && state.user.role !== "kitchen")
    actions.push(["cancel", "取消"]);
  if (o.payment === "paid" && state.user.role === "owner")
    actions.push(["refund", "退款紀錄"]);
  return `<article class="order-card"><div class="title-row"><div><span class="order-number">#${esc(o.number)}</span> <span class="badge">${labels[o.status]}</span><p>${esc(o.day)} ${esc(o.slot)} 取餐${o.name ? " · " + esc(o.name) : ""}</p>${o.phone ? `<a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>` : ""}</div><strong>${money(o.total)}</strong></div><div class="items">${o.items.map((p) => `<p><strong>${esc(p.name)} × ${p.qty}</strong><br><small>${esc(details(p))}</small></p>`).join("")}</div>${o.own_boxes ? `<p class="note">自備餐盒 ${o.own_boxes} 個，折 ${money(o.discount)}；收款前請核對。</p>` : ""}${o.soup ? '<p class="note">顧客希望附湯，請確認現場供應。</p>' : ""}${o.note ? `<p class="note">${esc(o.note)}</p>` : ""}<div class="actions">${actions.map(([a, n], i) => `<button data-id="${o.id}" data-action="${a}" class="${i === 0 ? "primary" : "quiet"}">${n}</button>`).join("")}<button data-id="${o.id}" data-action="print" class="quiet">列印憑單</button></div></article>`;
}
const activeStatusesFront = (s) =>
  ["pending", "accepted", "preparing", "ready"].includes(s);
async function orderAction(id, action) {
  let o = state.orders.find((x) => x.id === id);
  if (action === "print") {
    let win = window.open("", "_blank");
    if (!win) return toast("請允許列印視窗");
    win.document.write(
      `<html lang="zh-Hant"><head><title>取餐憑單 ${esc(o.number)}</title></head><body style="font:15px sans-serif;max-width:280px"><h2>穀穀健康廚房</h2><h1>#${esc(o.number)}</h1><p>${esc(o.day)} ${esc(o.slot)}</p>${o.items.map((p) => `<p>${esc(p.name)} × ${p.qty}<br>${esc(details(p))}</p>`).join("")}<hr><p>應付 ${money(o.total)}・${o.payment === "paid" ? "已收款" : "未收款"}</p><p>${esc(o.note)}</p><small>取餐憑單，非統一發票</small></body></html>`,
    );
    win.document.close();
    win.print();
    return;
  }
  let texts = {
    paid: `確定實際收到 ${money(o.total)}，並核對 ${o.own_boxes} 個自備餐盒？`,
    refund: `確定已實際退還 ${money(o.total)}？系統只記錄，不會轉帳。`,
    cancel: "確定取消此筆訂單？製作中的餐點不會回補庫存。",
    reject: "確定無法接下這筆訂單？",
  };
  if (texts[action] && !confirm(texts[action])) return;
  try {
    await api("/api/admin/orders/" + id + "/action", {
      action,
      version: o.version,
      confirmed: true,
    });
    await adminOrders();
  } catch (e) {
    toast(e.message);
    await adminOrders();
  }
}
async function adminProducts() {
  state.adminProducts = (
    await api("/api/admin/products?day=" + state.day)
  ).products;
  $("#admin-content").innerHTML =
    `<div class="toolbar"><input type="date" id="stock-day" aria-label="庫存日期" value="${state.day}" style="max-width:210px"><span class="muted">餐盒與單點主菜共用份數</span>${state.user.role === "owner" ? '<button id="new-product" class="primary">新增餐點</button>' : ""}</div><div class="panel">${state.adminProducts.map((p) => `<div class="product-manage">${p.photo ? `<img src="${esc(p.photo)}" alt="${esc(p.name)}">` : '<span class="empty-bowl"></span>'}<div class="info"><strong>${esc(p.name)}</strong><small>${money(p.price)} ${p.single_price !== null ? "／單點 " + money(p.single_price) : ""}</small><small>${p.active ? "已上架" : "已下架"}・${p.remaining} 份</small></div>${state.user.role === "owner" ? `<button data-edit="${p.id}">編輯</button>` : ""}</div>`).join("")}</div>`;
  if ($("#new-product")) $("#new-product").onclick = newProduct;
  $("#stock-day").onchange = (e) => {
    state.day = e.target.value;
    adminProducts().catch((e) => toast(e.message));
  };
  $("#admin-content")
    .querySelectorAll("[data-edit]")
    .forEach((b) => (b.onclick = () => editProduct(b.dataset.edit)));
}
function newProduct() {
  let d = modal(
      "新增餐點",
      `<form id="new-product-form"><label>餐點名稱<input name="name" required maxlength="60"></label><label>種類<select name="kind"><option value="meal">餐盒</option><option value="addon">單點</option><option value="soup">湯品</option></select></label><label>價格<input name="price" type="number" min="0" max="10000" required></label><label>單點主菜價格（不提供可留白）<input name="single_price" type="number" min="0" max="10000"></label><label>說明<textarea name="description" maxlength="300"></textarea></label><p class="field-note">新增後先下架，請在編輯畫面上傳實拍照、設定份數，再勾選上架。</p><div class="error" role="alert"></div><button type="submit" class="primary">建立餐點</button></form>`,
    ),
    f = $("#new-product-form");
  f.onsubmit = (e) => {
    e.preventDefault();
    submit(f, async () => {
      let v = Object.fromEntries(new FormData(f));
      await api("/api/admin/products", {
        ...v,
        price: Number(v.price),
        single_price:
          v.kind === "meal" && v.single_price !== ""
            ? Number(v.single_price)
            : null,
      });
      d.close();
      await adminProducts();
      toast("已建立，請設定照片與份數");
    });
  };
}
function editProduct(id) {
  let p = state.adminProducts.find((p) => p.id === id),
    d = modal(
      "餐點與可售份數",
      `<form id="edit-product"><label>餐點名稱<input name="name" value="${esc(p.name)}" maxlength="60" required></label><div class="row"><label>餐盒／單份價格<input type="number" name="price" value="${p.price}" min="0" max="10000" required></label>${p.single_price !== null ? `<label>單點主菜價格<input type="number" name="single_price" value="${p.single_price}" min="0" max="10000" required></label>` : ""}</div><label>${state.day} 剩餘可售份數<input type="number" name="remaining" value="${p.remaining}" min="0" max="10000" required></label><p class="field-note">請填扣除既有訂單後的剩餘可售份數，不是「再增加幾份」。若有人剛下單，儲存會要求重新確認。</p><label>餐點說明<textarea name="description" maxlength="300">${esc(p.description)}</textarea></label><label class="check"><input type="checkbox" name="active" ${p.active ? "checked" : ""}>上架供顧客查看</label><div class="error" role="alert"></div><div class="actions"><button type="submit" class="primary">儲存餐點</button></div></form><hr><label for="photo-upload">更換餐點照片</label><input type="file" id="photo-upload" accept="image/jpeg,image/png,image/webp"><p class="field-note">請使用自有餐點照片。會先去除中繼資料、縮小並轉為 WebP，再上傳至資料庫。</p><button class="quiet" id="remove-photo">移除照片</button>`,
    );
  let f = $("#edit-product");
  f.onsubmit = (e) => {
    e.preventDefault();
    submit(f, async () => {
      let v = Object.fromEntries(new FormData(f));
      await api("/api/admin/products/" + id, {
        ...v,
        price: Number(v.price),
        single_price: p.single_price !== null ? Number(v.single_price) : null,
        remaining: Number(v.remaining),
        expected_remaining: p.remaining,
        day: state.day,
        active: !!v.active,
        version: p.version,
      });
      d.close();
      await adminProducts();
      toast("已儲存");
    });
  };
  $("#photo-upload").onchange = async (e) => {
    let file = e.target.files[0];
    if (!file) return;
    try {
      if (file.size > 15000000) throw new Error("原始照片請小於 15 MB");
      let image = await createImageBitmap(file),
        canvas = document.createElement("canvas"),
        scale = Math.min(1, 640 / Math.max(image.width, image.height));
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas
        .getContext("2d")
        .drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();
      let data = "";
      for (let quality = 0.82; quality >= 0.28; quality -= 0.1) {
        data = canvas.toDataURL("image/webp", quality).split(",")[1];
        if (atob(data).length <= 98304) break;
      }
      if (atob(data).length > 98304)
        throw new Error("圖片仍太大，請裁切後再試");
      await api("/api/admin/products/" + id + "/photo", {
        data,
        version: p.version,
      });
      d.close();
      await adminProducts();
      toast("照片已儲存");
    } catch (e) {
      toast("照片上傳失敗：" + e.message);
    }
  };
  $("#remove-photo").onclick = async () => {
    if (confirm("確定移除此餐點照片？"))
      try {
        await api("/api/admin/products/" + id + "/photo", {
          version: p.version,
        });
        d.close();
        await adminProducts();
      } catch (e) {
        toast(e.message);
      }
  };
}
function account() {
  let u = state.user;
  $("#admin-content").innerHTML =
    `<div class="panel narrow"><h2>修改帳號與密碼</h2><form id="account-form"><label>登入帳號<input name="username" value="${esc(u.username)}" required autocapitalize="none"></label><label>顯示名稱<input name="name" value="${esc(u.name)}" required maxlength="30"></label><label>目前密碼<input name="current_password" type="password" autocomplete="current-password" required></label><label>新密碼（不變更可留白）<input name="new_password" type="password" minlength="12" autocomplete="new-password"></label><p class="field-note">儲存後會登出此帳號的所有裝置，需以新資料重新登入。</p><div class="error" role="alert"></div><div class="actions"><button class="primary" type="submit">儲存並重新登入</button></div></form></div>`;
  let f = $("#account-form");
  f.onsubmit = (e) => {
    e.preventDefault();
    submit(f, async () => {
      let v = Object.fromEntries(new FormData(f)),
        body = {
          username: v.username,
          name: v.name,
          current_proof: await derive(v.current_password, u.salt),
        };
      if (v.new_password) {
        body.new_salt = randomHex();
        body.new_proof = await derive(v.new_password, body.new_salt);
      }
      await api("/api/account", body);
      state.user = null;
      state.csrf = "";
      toast("帳號資料已更新，請重新登入");
      login(false);
    });
  };
}
async function settingsForm() {
  let s = await api("/api/admin/settings");
  let h = s.hours[1]?.length
    ? s.hours[1]
    : [
        ["11:00", "14:00"],
        ["17:00", "20:00"],
      ];
  $("#admin-content").innerHTML =
    `<div class="panel"><h2>營業設定</h2><form id="settings-form"><label>店家公告<textarea name="announcement" maxlength="300">${esc(s.announcement)}</textarea></label><div class="row"><label>備餐時間（分鐘）<input type="number" name="prep_minutes" value="${s.prep_minutes}" min="5" max="120" required></label><label>每個時段（分鐘）<input type="number" name="slot_minutes" value="${s.slot_minutes}" min="5" max="60" required></label><label>每時段最多份數<input type="number" name="slot_capacity" value="${s.slot_capacity}" min="1" max="100" required></label></div><div class="row"><label>可提前預約天數<input type="number" name="advance_days" value="${s.advance_days}" min="0" max="7" required></label><label>未接單逾時（分鐘）<input type="number" name="accept_timeout" value="${s.accept_timeout}" min="2" max="30" required></label><label>個資保留天數<input type="number" name="privacy_days" value="${s.privacy_days}" min="7" max="90" required></label></div><label>營業日</label><div class="day-checks">${["日", "一", "二", "三", "四", "五", "六"].map((d, i) => `<label class="check"><input type="checkbox" name="weekday${i}" ${s.hours[i]?.length ? "checked" : ""}>週${d}</label>`).join("")}</div><div class="row"><label>午間開始<input type="time" name="lunch_start" value="${h[0]?.[0] || "11:00"}" required></label><label>午間結束<input type="time" name="lunch_end" value="${h[0]?.[1] || "14:00"}" required></label></div><div class="row"><label>晚間開始<input type="time" name="dinner_start" value="${h[1]?.[0] || "17:00"}" required></label><label>晚間結束<input type="time" name="dinner_end" value="${h[1]?.[1] || "20:00"}" required></label></div><label>特別公休日（YYYY-MM-DD，以逗號分隔）<textarea name="closed_dates">${s.closed_dates.join(", ")}</textarea></label><p class="field-note">營業時段會套用到所有勾選的營業日。更改設定後會先暫停新接單，請確認後回接單頁重新開啟。</p><div class="error" role="alert"></div><div class="actions"><button class="primary" type="submit">儲存營業設定</button></div></form></div><div class="panel"><h2>完整資料備份</h2><p>包含帳號雜湊、菜單、圖片、訂單、庫存與收款紀錄，不包含登入狀態。請存放在受保護的位置，不要公開分享。</p><button id="backup">驗證密碼並下載備份</button><p class="field-note">另可在 Cloudflare D1 使用時間點還原。實際可還原日期以帳號方案與控制台為準。</p></div>`;
  let f = $("#settings-form");
  f.onsubmit = (e) => {
    e.preventDefault();
    submit(f, async () => {
      let v = Object.fromEntries(new FormData(f)),
        b = {
          version: s.version,
          announcement: v.announcement,
          closed_dates: v.closed_dates
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          hours: {},
        };
      for (let k of [
        "prep_minutes",
        "slot_minutes",
        "slot_capacity",
        "advance_days",
        "accept_timeout",
        "privacy_days",
      ])
        b[k] = Number(v[k]);
      for (let i = 0; i < 7; i++)
        b.hours[i] = v["weekday" + i]
          ? [
              [v.lunch_start, v.lunch_end],
              [v.dinner_start, v.dinner_end],
            ]
          : [];
      await api("/api/admin/settings", b);
      toast("已儲存，接單已暫停");
      await settingsForm();
    });
  };
  $("#backup").onclick = () => {
    let d = modal(
        "驗證密碼後下載",
        `<form id="backup-form"><label>目前密碼<input name="password" type="password" autocomplete="current-password" required></label><div class="error" role="alert"></div><div class="actions"><button type="submit" class="primary">下載完整備份</button></div></form>`,
      ),
      f = $("#backup-form");
    f.onsubmit = (e) => {
      e.preventDefault();
      submit(f, async () => {
        let p = new FormData(f).get("password"),
          data = await api("/api/admin/backup", {
            current_proof: await derive(p, state.user.salt),
          });
        download(
          "gugu-backup-" + state.store.today + ".json",
          JSON.stringify(data),
          "application/json",
        );
        d.close();
      });
    };
  };
}
async function usersForm() {
  let users = (await api("/api/admin/users")).users;
  $("#admin-content").innerHTML =
    `<div class="panel"><div class="title-row"><h2>店員帳號</h2><button class="primary" id="add-user">新增店員</button></div>${users.map((u) => `<div class="list-row"><div><strong>${esc(u.name)} · ${esc(u.username)}</strong><small>${{ owner: "店長", cashier: "櫃台", kitchen: "廚房" }[u.role]}／${u.active ? "使用中" : "已停用"}</small></div>${u.role !== "owner" ? `<div class="actions"><button data-toggle="${u.id}">${u.active ? "停用" : "啟用"}</button><button data-reset="${u.id}">重設密碼</button></div>` : ""}</div>`).join("")}</div>`;
  $("#admin-content")
    .querySelectorAll("[data-toggle]")
    .forEach(
      (b) =>
        (b.onclick = async () => {
          let u = users.find((x) => x.id === b.dataset.toggle);
          if (
            confirm(
              `確定${u.active ? "停用" : "啟用"} ${u.name}？原本的登入將失效。`,
            )
          )
            try {
              await api("/api/admin/users/" + u.id, {
                active: !u.active,
                version: u.version,
              });
              usersForm();
            } catch (e) {
              toast(e.message);
            }
        }),
    );
  $("#admin-content")
    .querySelectorAll("[data-reset]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          editUser(users.find((x) => x.id === b.dataset.reset))),
    );
  $("#add-user").onclick = () => editUser();
}
function editUser(u) {
  let d = modal(
      u ? "重設店員密碼" : "新增店員",
      `<form id="user-form">${u ? `<p>${esc(u.name)}・${esc(u.username)}</p>` : '<label>帳號<input name="username" required autocapitalize="none"></label><label>稱呼<input name="name" required maxlength="30"></label><label>權限<select name="role"><option value="cashier">櫃台：接單與收款</option><option value="kitchen">廚房：只更新製作進度</option></select></label>'}<label>新密碼<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><div class="error" role="alert"></div><div class="actions"><button type="submit" class="primary">儲存帳號</button></div></form>`,
    ),
    f = $("#user-form");
  f.onsubmit = (e) => {
    e.preventDefault();
    submit(f, async () => {
      let v = Object.fromEntries(new FormData(f)),
        salt = randomHex(),
        p = await derive(v.password, salt);
      await api(
        "/api/admin/users" + (u ? "/" + u.id : ""),
        u
          ? { version: u.version, salt, proof: p }
          : {
              username: v.username,
              name: v.name,
              role: v.role,
              salt,
              proof: p,
            },
      );
      d.close();
      await usersForm();
    });
  };
}
function download(name, content, type) {
  let url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function beep() {
  if (!window.guguAudio) return;
  let c = window.guguAudio;
  c.resume();
  let o = c.createOscillator(),
    g = c.createGain();
  o.connect(g);
  g.connect(c.destination);
  g.gain.value = 0.12;
  o.frequency.value = 740;
  o.start();
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.5);
  o.stop(c.currentTime + 0.5);
}
async function displayPage() {
  let o = (await api("/api/display")).orders;
  shell(
    `<div class="intro"><h1>餐點取餐看板</h1><p class="muted">綠色號碼已完成，請至櫃台取餐。</p></div><div class="display-grid">${o.map((o) => `<div class="${o.status === "ready" ? "ready" : ""}"><span class="order-number">${esc(o.number)}</span><p>${labels[o.status]}</p></div>`).join("") || '<p class="empty">目前沒有等候取餐的餐點。</p>'}</div>`,
  );
}
async function start() {
  try {
    let a = JSON.parse(sessionStorage.getItem("gugu-attempt") || "null");
    if (a && typeof a.client_key === "string") state.attempt = a;
  } catch {}
  let p = location.pathname;
  try {
    if (p.startsWith("/staff")) await staff();
    else if (p.startsWith("/order/")) await orderPage();
    else if (p.startsWith("/history")) history();
    else if (p.startsWith("/display")) await displayPage();
    else if (p.startsWith("/privacy"))
      shell(
        '<div class="panel"><h1>隱私與取餐須知</h1><p>本系統由穀穀健康廚房學府總店用於外帶自取服務。稱呼、手機與備註僅供接單、餐點製作、取餐聯繫與爭議處理，不作廣告名單使用。</p><p>已結束訂單的稱呼、手機與備註依店家設定的保留期限移除（預設 30 天），交易金額保留供對帳。由店家自行下載的備份另行管理。資料可能儲存於境外 Cloudflare 基礎設施。</p><p>店員登入使用必要的 Cookie；此瀏覽器可保留最近的私人訂單查詢連結，可在「我的訂單」刪除。沒有廣告追蹤器。</p><p>欲查詢、更正或刪除個人資料，請於營業時間聯絡 04-22220572。取消已接單餐點、過敏原及特殊需求也請直接聯絡店家確認。</p><p>本系統不收信用卡或線上付款。下單成功不代表店家已接單，請以訂單進度為準。餐點照片取自店家菜單，實際配菜依現場供應。</p></div>',
      );
    else {
      await customer();
      if (state.attempt) recoverAttempt();
    }
  } catch (e) {
    shell(
      `<div class="panel"><h1>目前無法載入</h1><p class="error">${esc(e.message)}</p><button id="reload">重新載入</button><a class="btn" href="tel:0422220572">營業時間聯絡店家</a></div>`,
    );
    $("#reload").onclick = () => location.reload();
  }
}
start();
interval = setInterval(async () => {
  if (document.hidden || $("#modal").open) return;
  try {
    let p = location.pathname;
    if (p.startsWith("/staff") && state.user) {
      await heartbeat();
      if (state.adminTab === "orders") {
        let old = state.orders
          .filter((x) => x.status === "pending")
          .map((x) => x.id);
        await adminOrders();
        if (
          state.orders.some(
            (x) => x.status === "pending" && !old.includes(x.id),
          )
        )
          beep();
      }
    } else if (p.startsWith("/order/")) await orderPage();
    else if (p.startsWith("/display")) await displayPage();
  } catch (e) {
    if (e.status === 401 && state.user) {
      state.user = null;
      login(false);
    } else toast("更新暫時中斷：" + e.message);
  }
}, 10000);
