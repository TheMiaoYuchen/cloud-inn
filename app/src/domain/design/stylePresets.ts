import type { StylePreset } from "./designTypes";

function freezePreset(preset: StylePreset): Readonly<StylePreset> {
  Object.freeze(preset.gene.materials);
  Object.freeze(preset.gene);
  return Object.freeze(preset);
}

export const CONTEMPORARY_ORIENTAL = freezePreset({
  id: "contemporary-oriental",
  name: "当代东方静奢",
  gene: {
    palette: "warm ivory, ink, walnut, and muted jade",
    materials: ["walnut", "linen", "natural stone", "hand-finished plaster"],
    metal: "aged bronze",
    lighting: "2700K layered lighting with soft architectural washes",
    mood: "quiet, composed, and culturally grounded",
  },
});

export const QUIET_METROPOLITAN_LUXURY = freezePreset({
  id: "quiet-metropolitan-luxury",
  name: "都市暖木行政",
  gene: {
    palette: "champagne, charcoal, cognac leather, and warm oak",
    materials: ["oak", "leather", "silk wool", "travertine"],
    metal: "brushed champagne brass",
    lighting: "2700K layered lighting with discreet task lighting",
    mood: "refined, private, and confidently metropolitan",
  },
});

export const NATURAL_RESORT = freezePreset({
  id: "natural-resort",
  name: "海岛自然奢华",
  gene: {
    palette: "sand, pearl, driftwood, and deep botanical green",
    materials: ["rattan", "limestone", "linen", "light timber"],
    metal: "soft bronze",
    lighting: "warm daylight balance with low-glare evening layers",
    mood: "restful, tactile, and connected to nature",
  },
});

export const STYLE_PRESETS: ReadonlyArray<Readonly<StylePreset>> = Object.freeze([
  CONTEMPORARY_ORIENTAL,
  QUIET_METROPOLITAN_LUXURY,
  NATURAL_RESORT,
]);
