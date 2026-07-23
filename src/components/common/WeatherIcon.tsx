import React from 'react';
import { Sun, Cloud, CloudRain, CloudSnow, Zap, Wind, CloudFog } from 'lucide-react';
import type { WeatherIconName } from '../../utils/weather';

/**
 * Renders a monoline weather icon from a stable family name
 * (`WeatherIconName`). Replaces the emoji-glyph rendering of
 * WeatherSummary.icon that used to appear in list cards / hero /
 * detail chrome — those emoji violated the "no emojis in UI code"
 * rule. Keep this the ONLY place we branch icon families for weather
 * so a future swap of icon library is a one-file change.
 */
interface Props {
  iconName: WeatherIconName;
  className?: string;
  strokeWidth?: number;
}

const MAP = {
  sun: Sun,
  cloud: Cloud,
  'cloud-rain': CloudRain,
  'cloud-snow': CloudSnow,
  zap: Zap,
  wind: Wind,
  'cloud-fog': CloudFog,
} as const;

const WeatherIcon: React.FC<Props> = ({
  iconName,
  className = 'w-3.5 h-3.5',
  strokeWidth = 1.75,
}) => {
  const Icon = MAP[iconName];
  return <Icon aria-hidden className={className} strokeWidth={strokeWidth} />;
};

export default WeatherIcon;
