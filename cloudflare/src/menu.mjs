// Transcribed from the menu supplied by the shop's representative in this conversation.
const mains = [
  [
    "vegetarian",
    "蛋奶五辛素",
    105,
    null,
    "無肉，蔬菜加量；蛋奶五辛素，非全素。",
  ],
  ["chicken", "水煮雞胸肉", 115, 55, "水煮雞胸肉，搭配當日蔬菜。"],
  ["pork", "乾炒豬里肌", 115, 55, "乾炒豬里肌，搭配當日蔬菜。"],
  ["tilapia", "水煮鯛魚片", 135, 65, "水煮鯛魚片，搭配當日蔬菜。"],
  ["basil", "泰式打拋豬", 135, 65, "可調整辣度。"],
  [
    "ginger-pork",
    "醬燒豬五花",
    135,
    65,
    "豬五花；與牛五花使用菜單上的共用照片。",
  ],
  [
    "ginger-beef",
    "醬燒牛五花",
    135,
    65,
    "牛五花；與豬五花使用菜單上的共用照片。",
  ],
  ["mackerel", "挪威檸香鯖魚", 145, 75, "檸香鯖魚，搭配當日蔬菜。"],
  ["steak", "板腱牛排", 175, 95, "板腱牛排，搭配當日蔬菜。"],
  ["salmon", "招牌義式鮭魚", 175, 95, "義式鮭魚，搭配當日蔬菜。"],
  ["thigh", "黃金乾煎雞腿排", 150, 75, "每日限量。"],
  ["shrimp", "鮮蝦雞胸肉餅", 155, 85, "每日限量；含蝦及雞肉。"],
];
export const products = mains
  .map(([id, name, price, single, description], i) => ({
    id,
    name,
    price,
    single_price: single,
    description,
    kind: "meal",
    category: "餐盒",
    photo: `/images/${id.startsWith("ginger") ? "ginger" : id}.webp`,
    photo_note: id.startsWith("ginger")
      ? "菜單共用照片"
      : "照片取自店家菜單；配菜依當日供應",
    active: 1,
    version: 1,
    sort: i,
  }))
  .concat(
    [
      [
        "peeled-chili-soup",
        "剝皮辣椒雞湯",
        90,
        "soup",
        "湯品",
        "期間限定，夏日不供應。",
      ],
      [
        "pork-tripe-soup",
        "豬肚雞湯",
        90,
        "soup",
        "湯品",
        "期間限定，夏日不供應。",
      ],
      ["sesame-soup", "麻油雞湯", 90, "soup", "湯品", "期間限定，夏日不供應。"],
      ["sweet-potato", "地瓜片", 15, "addon", "單點", ""],
      ["rice", "胚芽五穀米", 15, "addon", "單點", ""],
      ["egg", "水煮蛋", 15, "addon", "單點", ""],
      ["veggies", "當日纖蔬", 25, "addon", "單點", ""],
      ["broccoli", "蒜香花椰菜", 35, "addon", "單點", ""],
    ].map(([id, name, price, kind, category, description], i) => ({
      id,
      name,
      price,
      single_price: null,
      kind,
      category,
      description,
      photo: "",
      photo_note: "尚未提供單品照片",
      active: kind === "soup" ? 0 : 1,
      version: 1,
      sort: i + 12,
    })),
  );
export const defaults = {
  name: "穀穀健康廚房",
  branch: "學府總店",
  address: "台中市南區學府路136號",
  phone: "04-22220572",
  announcement: "先點好，再出門。到店付款，憑取餐號碼取餐。",
  paused: true,
  open_until: 0,
  verified: false,
  prep_minutes: 20,
  slot_minutes: 15,
  slot_capacity: 20,
  advance_days: 3,
  accept_timeout: 10,
  privacy_days: 30,
  hours: {
    0: [
      ["11:00", "14:00"],
      ["17:00", "20:00"],
    ],
    1: [
      ["11:00", "14:00"],
      ["17:00", "20:00"],
    ],
    2: [
      ["11:00", "14:00"],
      ["17:00", "20:00"],
    ],
    3: [
      ["11:00", "14:00"],
      ["17:00", "20:00"],
    ],
    4: [
      ["11:00", "14:00"],
      ["17:00", "20:00"],
    ],
    5: [
      ["11:00", "14:00"],
      ["17:00", "20:00"],
    ],
    6: [
      ["11:00", "14:00"],
      ["17:00", "20:00"],
    ],
  },
  closed_dates: [],
};
