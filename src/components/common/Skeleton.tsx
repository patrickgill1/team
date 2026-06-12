import React from 'react';

// Tiny skeleton primitive — animated shimmer placeholder for loading
// states. Renders into the same card chrome the real content uses so
// nothing jumps when the data arrives. Uses the .skeleton-shimmer
// class defined in src/index.css.

interface BoxProps {
  className?: string;
  /** Round it off entirely. Good for avatars / icons. */
  rounded?: 'sm' | 'md' | 'lg' | 'full';
}

export const SkeletonBox: React.FC<BoxProps> = ({ className = '', rounded = 'md' }) => {
  const r =
    rounded === 'full' ? 'rounded-full' :
    rounded === 'lg' ? 'rounded-xl' :
    rounded === 'sm' ? 'rounded' : 'rounded-md';
  return <div className={`skeleton-shimmer ${r} ${className}`} />;
};

interface RowProps {
  lines?: number;
  withAvatar?: boolean;
}

export const SkeletonRow: React.FC<RowProps> = ({ lines = 2, withAvatar = true }) => (
  <div className="flex items-start gap-3">
    {withAvatar && <SkeletonBox className="w-10 h-10 shrink-0" rounded="full" />}
    <div className="flex-1 space-y-2 pt-1">
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBox
          key={i}
          className={`h-3 ${i === 0 ? 'w-2/5' : i === lines - 1 ? 'w-3/5' : 'w-4/5'}`}
        />
      ))}
    </div>
  </div>
);

interface CardProps {
  title?: boolean;
  rows?: number;
  className?: string;
}

export const SkeletonCard: React.FC<CardProps> = ({ title = true, rows = 3, className = '' }) => (
  <div className={`bg-white rounded-2xl ring-1 ring-gray-200 p-5 space-y-4 ${className}`}>
    {title && <SkeletonBox className="h-4 w-1/3" />}
    {Array.from({ length: rows }).map((_, i) => (
      <SkeletonRow key={i} />
    ))}
  </div>
);

export default SkeletonCard;
