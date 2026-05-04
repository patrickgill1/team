import React from 'react';

interface HeaderProps {
  title?: string;
  subtitle?: string;
  showUserMenu?: boolean;
}

const Header: React.FC<HeaderProps> = ({ 
  title = 'Dashboard', 
  subtitle,
}) => {
  return (
    <header className="bg-gray-900/40 backdrop-blur-sm border-b border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="py-4 lg:py-5">
          <h1 className="text-xl sm:text-2xl font-bold text-white">{title}</h1>
          {subtitle && (
            <p className="mt-0.5 text-sm text-gray-400">{subtitle}</p>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;