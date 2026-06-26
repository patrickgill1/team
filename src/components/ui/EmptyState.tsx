// @ts-nocheck
import React from 'react';
import Button from './Button';

/**
 * EmptyState — the "no data yet" surface. Every page in the app has
 * one or two of these (no players, no events, no chat threads, no
 * search matches, no media uploaded). They've been hand-drawn each
 * time with slightly different paddings, weights, and copy structure.
 * This primitive locks the vocabulary.
 *
 * Structure:
 *   icon       — optional decorative SVG / emoji span (16-32px)
 *   title      — required, the headline
 *   subtitle   — optional, a sentence of explanation
 *   action     — optional, a primary CTA (use <Button>)
 *   secondary  — optional secondary action (use <Button variant="ghost">)
 *
 * Tone defaults to subtle (a calm 'nothing here yet' card). Use
 * variant='error' for failure states, variant='inline' when it
 * needs to sit unobtrusively inside another card.
 */

export type EmptyStateVariant = 'subtle' | 'error' | 'inline';

interface Props {
  variant?: EmptyStateVariant;
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  secondary?: React.ReactNode;
  className?: string;
}

const WRAPPER_CLASS: Record<EmptyStateVariant, string> = {
  subtle: 'bg-charcoal-900 ring-1 ring-white/10 rounded-2xl p-8 sm:p-10 text-center',
  error:  'bg-charcoal-900 ring-1 ring-amber-500/30 rounded-2xl p-6 text-center',
  inline: 'p-6 text-center',
};

const EmptyState: React.FC<Props> = ({
  variant = 'subtle',
  icon,
  title,
  subtitle,
  action,
  secondary,
  className,
}) => (
  <div className={`${WRAPPER_CLASS[variant]} ${className || ''}`}>
    {icon && (
      <div className="flex items-center justify-center mb-3 text-bone/45">
        {icon}
      </div>
    )}
    <p className="text-bone/85 font-bold mb-1">{title}</p>
    {subtitle && (
      <p className="text-bone/55 text-sm leading-snug max-w-sm mx-auto">{subtitle}</p>
    )}
    {(action || secondary) && (
      <div className="mt-5 flex items-center justify-center gap-2 flex-wrap">
        {action}
        {secondary}
      </div>
    )}
  </div>
);

export default EmptyState;
