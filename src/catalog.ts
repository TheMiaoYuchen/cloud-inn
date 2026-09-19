export type RoomTemplate = {
  id: string;
  name: string;
  description: string;
  accent: string;
};

export type FurnitureCard = {
  id: string;
  name: string;
  description: string;
  icon: string;
};

export const roomTemplates: RoomTemplate[] = [
  { id: "garden-queen", name: "花园大床房", description: "暖光、窗边休憩区、适合自然材质。", accent: "苔绿" },
  { id: "city-twin", name: "城市双床房", description: "简洁利落，留出两人入住的舒展动线。", accent: "砖红" },
  { id: "quiet-suite", name: "静谧套房", description: "卧室与会客角相连，适合层次丰富的陈设。", accent: "夜蓝" },
];

export const furnitureCards: FurnitureCard[] = [
  { id: "oak-bed", name: "橡木床架", description: "低矮、温润", icon: "▰" },
  { id: "linen-chair", name: "亚麻单椅", description: "窗边阅读", icon: "◒" },
  { id: "round-rug", name: "圆形地毯", description: "柔化地面", icon: "◌" },
  { id: "paper-lamp", name: "纸灯", description: "漫射暖光", icon: "◐" },
  { id: "art-shelf", name: "画册置物架", description: "一点故事感", icon: "▤" },
  { id: "stone-table", name: "石面边几", description: "安静的质感", icon: "▱" },
];
