import type { RoomVariant } from '../../domain/design/designTypes';

export function VariantFilmstrip({ variants }: { variants: RoomVariant[] }) {
  return <section className="variant-filmstrip"><h2>同一酒店的客房系列</h2><ul aria-label="客房变体">{variants.map(variant => <li key={variant.id}><button aria-label={variant.name}><span className="variant-thumb">{variant.cells.length}㎡</span><strong>{variant.name}</strong><small>{variant.overrides.length ? `独立设计 ${variant.overrides.length} 项` : '继承母版'}</small></button></li>)}</ul></section>;
}
