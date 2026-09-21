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
