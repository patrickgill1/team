import React from 'react';
import { badgeImageSrc, badgeSrcSet, badgeLabel } from '../../utils/badgeMeta';

interface Props {
  slug: string;
  /** Rendered pixel size (CSS px). Used to pick the right srcset. */
  size?: number;
  count?: number;
  context?: string;
  className?: string;
}

// Compact PNG-art badge chip. Replaces the star-SVG chip so each
// slug's dedicated artwork carries the visual identity. Text label
// stays outside the art so it remains accessible + searchable.
const BadgeIcon: React.FC<Props> = ({ slug, size = 24, count, context, className }) => {
  const label = badgeLabel(slug);
  const displayLabel = count && count > 1 ? `${label} × ${count}` : label;
  const src = badgeImageSrc(slug, size);
  const srcSet = badgeSrcSet(slug, size);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ring-1 ring-line-default/15 bg-line-default/[0.06] px-2 py-1 text-[11px] font-black tracking-wide text-ink-primary/85 ${className || ''}`}
      title={context || label}
    >
      <img
        src={src}
        srcSet={srcSet}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        style={{ width: size, height: size }}
        className="flex-shrink-0"
      />
      <span>{displayLabel}</span>
    </span>
  );
};

export default BadgeIcon;
