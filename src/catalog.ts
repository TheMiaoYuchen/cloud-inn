export type ChoiceCard = {
  id: string;
  name: string;
  description: string;
  accent?: string;
};

export type FurnitureCard = ChoiceCard & { icon: string };

export const roomTypes: ChoiceCard[] = [
  { id: "single", name: "单间", description: "一张床与完整起居动线，适合独旅或双人入住。", accent: "留白" },
  { id: "suite", name: "套房", description: "睡眠区与会客区相连，适合更丰富的停留体验。", accent: "层次" },
];

export const bedTypes: ChoiceCard[] = [
  { id: "queen", name: "大床", description: "一张舒展的大床，适合安静休憩。", accent: "大床" },
  { id: "twin", name: "双床", description: "两张独立床位，保留同行住客的界限感。", accent: "双床" },
];

export type ZoneGroup = {
  name: string;
  choices: ChoiceCard[];
};

export const zoneGroups: ZoneGroup[] = [
  { name: "公共区域", choices: [
    { id: "lobby", name: "接待大厅", description: "抵达、等候与初次相遇的空间", accent: "迎客" },
    { id: "dining", name: "餐饮区", description: "早餐、用餐与停留的氛围", accent: "餐叙" },
  ] },
  { name: "设施", choices: [
    { id: "meeting-room", name: "会议室", description: "讨论、演示与团队聚会", accent: "会谈" },
    { id: "gift-shop", name: "礼品店", description: "地方物件与旅途纪念", accent: "礼遇" },
    { id: "pool", name: "泳池", description: "水面、躺椅与松弛时刻", accent: "水光" },
    { id: "fitness", name: "健身中心", description: "训练、恢复与充沛能量", accent: "动能" },
    { id: "spa", name: "水疗中心", description: "静养、理疗与感官放松", accent: "静养" },
  ] },
];

export const zoneChoices = zoneGroups.flatMap((group) => group.choices);

export const furnitureCards: FurnitureCard[] = [
  { id: "lounge-chair", name: "休闲椅", description: "留出独处的一角", icon: "◒" },
  { id: "side-table", name: "边几", description: "放下一杯茶", icon: "▱" },
  { id: "reading-lamp", name: "阅读灯", description: "一束局部光", icon: "◐" },
  { id: "floor-rug", name: "地毯", description: "柔化脚下触感", icon: "◌" },
  { id: "work-desk", name: "书桌", description: "临窗工作或书写", icon: "▤" },
  { id: "mini-bar", name: "迷你吧", description: "饮品与小食", icon: "▥" },
  { id: "lounge-sofa", name: "双人沙发", description: "会客与松弛", icon: "▰" },
  { id: "coffee-table", name: "茶几", description: "连接会客区", icon: "▭" },
  { id: "wardrobe", name: "衣柜", description: "收纳旅途衣物", icon: "▯" },
  { id: "console", name: "玄关柜", description: "进门的停靠处", icon: "▨" },
  { id: "floor-lamp", name: "落地灯", description: "补足夜晚氛围", icon: "│" },
  { id: "indoor-plant", name: "室内绿植", description: "带来生长感", icon: "♧" },
];
