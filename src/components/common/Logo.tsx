import React from 'react';

interface LogoProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'icon' | 'full' | 'horizontal';
  className?: string;
  showText?: boolean;
  color?: 'primary' | 'white' | 'dark';
}

const Logo: React.FC<LogoProps> = ({ 
  size = 'md', 
  variant = 'full',
  className = '',
  showText = true,
  color = 'primary'
}) => {
  // Size configurations - Made all sizes bigger
  const sizeConfig = {
    xs: { icon: 'h-12 w-12', text: 'text-sm', spacing: 'space-x-1' },
    sm: { icon: 'h-16 w-16', text: 'text-base', spacing: 'space-x-2' },
    md: { icon: 'h-20 w-20', text: 'text-lg', spacing: 'space-x-2' },
    lg: { icon: 'h-24 w-24', text: 'text-xl', spacing: 'space-x-3' },
    xl: { icon: 'h-32 w-32', text: 'text-2xl', spacing: 'space-x-3' }
  };

  // Color configurations for text
  const colorConfig = {
    primary: { text: 'text-white' },
    white: { text: 'text-white' },
    dark: { text: 'text-white' }
  };

  const config = sizeConfig[size];
  const colors = colorConfig[color];

  // PNG Logo Component
  const LogoIcon = () => {
    // Choose the right logo based on color theme
    const logoSrc = color === 'white' ? '/images/logo-white.png' : '/images/logo.png';
    
    return (
      <div className={`${config.icon} flex items-center justify-center mx-auto`}>
        <img 
          src={logoSrc}
          alt="Team Logo"
          className={`${config.icon} object-contain hover:scale-105 transition-transform duration-200`}
          onError={(e) => {
            // Fallback if white version doesn't exist
            if (logoSrc.includes('logo-white.png')) {
              (e.target as HTMLImageElement).src = '/images/logo.png';
            }
          }}
        />
      </div>
    );
  };

  // No text component needed - logo only

  // Render based on variant - all variants now show only the logo, centered
  if (variant === 'icon') {
    return (
      <div className={`flex justify-center ${className}`}>
        <LogoIcon />
      </div>
    );
  }

  if (variant === 'horizontal') {
    return (
      <div className={`flex justify-center ${className}`}>
        <LogoIcon />
      </div>
    );
  }

  // Default: full variant - also just the logo, centered
  return (
    <div className={`flex justify-center ${className}`}>
      <LogoIcon />
    </div>
  );
};

export default Logo;